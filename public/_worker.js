/**
 * ============================================================================
 * _worker.js — 联机五子棋后端（Cloudflare Pages 高级模式 + Durable Objects）
 * ============================================================================
 * 与前端同域部署（pages.dev），无跨域、无 workers.dev 被墙问题。
 * 路由：/health、/api/new-room、/ws 走后端；其余回退到静态资源。
 * ============================================================================
 */
"use strict";

const N = 15; // 15x15 标准棋盘
const WIN_COUNT = 5;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混淆的 0/O/1/I

/** 二维坐标 → 一维索引 */
const idx = (x, y) => y * N + x;
/** 坐标是否在棋盘内 */
const inBounds = (x, y) => x >= 0 && x < N && y >= 0 && y < N;

/* ============================================================================
 * 胜负判定：四方向延伸（与原服务端逻辑一致）
 * ========================================================================== */
function checkWin(board, x, y, color) {
  const directions = [
    [1, 0], [0, 1], [1, 1], [1, -1],
  ];
  for (const [dx, dy] of directions) {
    const line = [{ x, y }];
    for (let s = 1; s < WIN_COUNT; s++) {
      const nx = x + dx * s, ny = y + dy * s;
      if (!inBounds(nx, ny) || board[idx(nx, ny)] !== color) break;
      line.push({ x: nx, y: ny });
    }
    for (let s = 1; s < WIN_COUNT; s++) {
      const nx = x - dx * s, ny = y - dy * s;
      if (!inBounds(nx, ny) || board[idx(nx, ny)] !== color) break;
      line.unshift({ x: nx, y: ny });
    }
    if (line.length >= WIN_COUNT) return line;
  }
  return null;
}

/** 新房间初始状态 */
function freshRoom(id) {
  return {
    id,
    board: new Array(N * N).fill(0), // 0空 1黑 2白
    turn: 1, // 黑先
    status: "waiting", // waiting | playing | finished
    winner: null,
    winLine: null,
    names: { black: "黑方", white: "白方" },
    moveCount: 0,
    restartVotes: { black: false, white: false },
  };
}

/* ============================================================================
 * RoomDO — 每房间一个 Durable Object
 * ========================================================================== */
export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.room = null; // 惰性加载：被唤醒时从存储恢复
  }

  /** HTTP 入口：只接受 WebSocket 升级请求 */
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ error: "websocket upgrade required" }, { status: 426 });
    }
    const roomId = (url.searchParams.get("room") || "").toUpperCase();

    const pair = new WebSocketPair();
    // Hibernation：接受平台托管的 WebSocket，空闲时不占内存/CPU
    // 注意：使用 acceptWebSocket() 后绝不能再调用 accept()，否则抛异常（1101）
    this.state.acceptWebSocket(pair[1]);
    // 心跳自动应答：客户端发 "ping"，平台直接回 "pong"，不唤醒 DO
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
    // 每条连接的归属信息存入 attachment，实例休眠重启后依然可用
    pair[1].serializeAttachment({ roomId, color: null, name: "" });

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /* ---------------------- 状态加载 / 持久化 ---------------------- */
  async load(fallbackRoomId) {
    if (this.room) return;
    const saved = await this.state.storage.get("room");
    this.room = saved ? JSON.parse(saved) : freshRoom(fallbackRoomId || "------");
  }
  async save() {
    await this.state.storage.put("room", JSON.stringify(this.room));
  }

  /* ---------------------- 工具方法 ---------------------- */
  /** 统计当前在线的某颜色连接数 */
  colorCount(color) {
    let n = 0;
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.color === color) n++;
    }
    return n;
  }
  sendError(ws, code, message) {
    try { ws.send(JSON.stringify({ event: "roomError", data: { code, message } })); } catch {}
  }
  /** 构造某视角的房间快照（ownColor 是核心差异字段） */
  snapshot(ownColor) {
    const r = this.room;
    return {
      roomId: r.id,
      ownColor,
      board: r.board,
      turn: r.turn,
      status: r.status,
      winner: r.winner,
      winLine: r.winLine,
      names: r.names,
      moveCount: r.moveCount,
      restartVotes: (r.restartVotes.black ? 1 : 0) + (r.restartVotes.white ? 1 : 0),
    };
  }
  /** 向所有已入座连接广播最新状态 */
  broadcast() {
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a || !a.color) continue;
      try { ws.send(JSON.stringify({ event: "gameState", data: this.snapshot(a.color) })); } catch {}
    }
  }
  reset() {
    this.room.board = new Array(N * N).fill(0);
    this.room.turn = 1;
    this.room.status = "playing";
    this.room.winner = null;
    this.room.winLine = null;
    this.room.moveCount = 0;
    this.room.restartVotes = { black: false, white: false };
  }

  /* ---------------------- 消息处理 ---------------------- */
  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message === "ping") return; // 心跳已自动应答
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const a = ws.deserializeAttachment();
    if (!a) return;
    await this.load(a.roomId);

    switch (msg.event) {
      case "joinRoom": return this.joinRoom(ws, a, msg.data || {});
      case "placeStone": return this.placeStone(ws, a, msg.data || {});
      case "requestRestart": return this.requestRestart(ws, a);
      case "leaveRoom": return this.leave(ws, a, false);
    }
  }

  /** 加入房间：分配黑白，满 2 人自动开局 */
  joinRoom(ws, a, { name } = {}) {
    if (a.color) return; // 已入座，忽略重复加入
    let color = null;
    if (this.colorCount("black") === 0) color = "black";
    else if (this.colorCount("white") === 0) color = "white";
    if (!color) return this.sendError(ws, "ROOM_FULL", "该房间已满（2 人）");

    a.color = color;
    a.name = (typeof name === "string" && name.trim())
      ? name.trim().slice(0, 16) : (color === "black" ? "黑方" : "白方");
    ws.serializeAttachment(a);
    this.room.names[color] = a.name;

    // 满 2 人自动开局
    if (this.colorCount("black") > 0 && this.colorCount("white") > 0) this.reset();

    this.save();
    this.broadcast();
  }

  /** 落子：服务端权威校验（回合 / 坐标 / 空位） */
  placeStone(ws, a, { x, y } = {}) {
    if (!a.color) return;
    if (this.room.status !== "playing")
      return this.sendError(ws, "NOT_PLAYING", "对局未开始或已结束");

    const color = a.color === "black" ? 1 : 2;
    if (this.room.turn !== color)
      return this.sendError(ws, "NOT_YOUR_TURN", "还没轮到你落子");
    if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(x, y))
      return this.sendError(ws, "BAD_COORD", "坐标不合法");
    if (this.room.board[idx(x, y)] !== 0)
      return this.sendError(ws, "OCCUPIED", "该位置已有棋子");

    // —— 校验全部通过，落子 ——
    this.room.board[idx(x, y)] = color;
    this.room.moveCount++;

    const winLine = checkWin(this.room.board, x, y, color);
    if (winLine) {
      this.room.status = "finished";
      this.room.winner = color;
      this.room.winLine = winLine;
    } else if (this.room.moveCount >= N * N) {
      this.room.status = "finished"; // 平局：225 格下满
      this.room.winner = 0;
      this.room.winLine = null;
    } else {
      this.room.turn = color === 1 ? 2 : 1;
    }

    this.save();
    this.broadcast();
  }

  /** 再来一局：双方都同意才重开 */
  requestRestart(ws, a) {
    if (!a.color || this.room.status !== "finished") return;
    this.room.restartVotes[a.color] = true;

    const blackOnline = this.colorCount("black") > 0;
    const whiteOnline = this.colorCount("white") > 0;
    const bothVoted = this.room.restartVotes.black && this.room.restartVotes.white;
    const singleVoted = (blackOnline !== whiteOnline) &&
      this.room.restartVotes[blackOnline ? "black" : "white"];

    if (blackOnline && whiteOnline && bothVoted) this.reset();
    else if (singleVoted) this.reset(); // 对手断线时，单人同意直接重开等新对手

    this.save();
    this.broadcast();
  }

  /** 离线处理：断线/主动退出。对局中离场判负；房间空了清存储 */
  async leave(ws, a, isDisconnect) {
    const color = a.color;
    if (!color) return;
    a.color = null;
    a.name = "";
    ws.serializeAttachment(a);

    const opp = color === "black" ? "white" : "black";
    // 对局进行中且对手在线：离场判负
    if (this.room.status === "playing" && this.colorCount(opp) > 0) {
      this.room.status = "finished";
      this.room.winner = opp === "black" ? 1 : 2;
      this.room.winLine = null;
      for (const s of this.state.getWebSockets()) {
        const sa = s.deserializeAttachment();
        if (sa && sa.color === opp) {
          try {
            s.send(JSON.stringify({
              event: "opponentLeft",
              data: { message: isDisconnect ? "对手断线，你获胜了！" : "对手退出了房间，你获胜了！" },
            }));
          } catch {}
        }
      }
    }

    this.room.restartVotes = { black: false, white: false };

    // 房间空了 → 清空存储释放资源
    if (this.colorCount("black") === 0 && this.colorCount("white") === 0) {
      await this.state.storage.deleteAll();
      this.room = null;
      return;
    }
    this.save();
    this.broadcast();
  }

  async webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    if (a) await this.leave(ws, a, true);
  }
  async webSocketError(ws) {
    const a = ws.deserializeAttachment();
    if (a) await this.leave(ws, a, true);
  }
}

/* ============================================================================
 * Worker 入口：API + WebSocket 升级转发；其余路径回退到静态资源
 * ========================================================================== */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    // 创建房间号（客户端拿到号后再连 /ws?room=xxx）
    if (url.pathname === "/api/new-room") {
      let id = "";
      for (let i = 0; i < 6; i++) {
        id += ROOM_CODE_CHARS[(Math.random() * ROOM_CODE_CHARS.length) | 0];
      }
      return Response.json({ roomId: id });
    }

    // WebSocket 升级：按房间号路由到对应 RoomDO
    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z2-9]{6}$/.test(room)) {
        return Response.json({ error: "invalid room id" }, { status: 400 });
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(request); // 原样转发升级请求
    }

    // 其余请求（/、/index.html 等）→ 静态资源
    const res = await env.ASSETS.fetch(request);
    // HTML 禁缓存：避免浏览器拿到旧版页面连已废弃的地址
    if ((res.headers.get("content-type") || "").includes("text/html")) {
      const fresh = new Response(res.body, res);
      fresh.headers.set("Cache-Control", "no-cache");
      return fresh;
    }
    return res;
  },
};
