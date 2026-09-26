/**
 * ============================================================================
 * server.js — 联机五子棋后端（Node.js + Express + Socket.io）
 * 部署目标：Render Web Service（免费版）
 * ============================================================================
 *
 * 【环境变量一览】（在 Render Dashboard → Environment 中配置）
 *   PORT        : Render 自动注入，无需手动配置。本地默认 3000
 *   CORS_ORIGIN : 允许的前端域名，多个用逗号分隔。
 *                 例如 "https://gomoku.pages.dev,http://localhost:8787"
 *                 不配置时默认 "*"（仅限开发用，生产务必收紧）
 *   MAX_ROOMS   : 最大房间数（保护免费实例内存），默认 200
 *
 * 【协议】客户端 → 服务端：
 *   joinRoom      { roomId?, name? }   roomId 为空则自动创建新房间
 *   placeStone    { x, y }             落子请求（0~14 坐标）
 *   requestRestart {}                  请求再来一局（对局结束后）
 *   leaveRoom     {}                   主动退出房间
 *
 * 【协议】服务端 → 客户端：
 *   gameState     { ...房间状态快照 }   任何状态变化后按玩家分别推送
 *   roomError     { code, message }    房间不存在 / 已满 / 房间数达上限
 *   opponentLeft  { message }          对手断线通知
 *
 * 设计原则：服务端权威 —— 客户端只上报意图，
 * 所有合法性校验、回合控制、胜负判定都在这里完成。
 * ============================================================================
 */
"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

/* ============================================================================
 * 1. 常量与环境变量
 * ========================================================================== */

const PORT = process.env.PORT || 3000; // ★ Render 注入 process.env.PORT
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*"; // ★ 生产环境务必配置 Pages 域名
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || "200", 10); // ★ 可选保护项

const BOARD_SIZE = 15; // 15x15 标准棋盘
const WIN_COUNT = 5; // 五子连珠
const ROOM_CODE_LENGTH = 6;
// 房间号字符集：去掉易混淆的 0/O/1/I，避免玩家念错、抄错
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* ============================================================================
 * 2. Express + Socket.io 初始化
 * ========================================================================== */

const app = express();

// 健康检查：Render 探测此路由判断实例存活，必须返回 200
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// 生产环境下保留静态托管 public/：
// - Render 上主要用于本地/预览环境的前后端同源联调（前端 SOCKET_URL 留空即可）
// - 正式流量走 Cloudflare Pages，不经过这里，互不影响
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);

// CORS 只需配在 Socket.io 实例上（Express 的 cors() 中间件对 WebSocket
// 升级请求无效，这是最容易踩的坑）
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
});

/* ============================================================================
 * 3. 房间数据结构
 * ========================================================================== */

/**
 * Room = {
 *   id:            string        6 位房间号
 *   board:         number[225]   一维棋盘，索引 = y*15+x；0空 1黑 2白
 *   players:       { black: socketId|null, white: socketId|null }
 *   names:         { black: string, white: string }
 *   turn:          number        当前回合 1=黑 2=白（黑先）
 *   status:        "waiting" | "playing" | "finished"
 *   winner:        number|null   1=黑胜 2=白胜 0=平局 null=未结束
 *   winLine:       [{x,y}...]|null 获胜五连的坐标（前端高亮用）
 *   restartVotes:  string[]      已同意重开的 socketId 列表
 *   moveCount:     number        已落子数（平局判定用）
 * }
 */

/** roomId → Room 的主索引 */
const rooms = new Map();
/** socketId → roomId 的反向索引，disconnect 时 O(1) 定位房间 */
const socketRoom = new Map();

/** 生成不重复的 6 位房间号 */
function generateRoomId() {
  let id;
  do {
    id = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      id += ROOM_CODE_CHARS[(Math.random() * ROOM_CODE_CHARS.length) | 0];
    }
  } while (rooms.has(id)); // 极小概率撞号，重试即可
  return id;
}

/** 创建新房间 */
function createRoom() {
  const id = generateRoomId();
  const room = {
    id,
    board: new Array(BOARD_SIZE * BOARD_SIZE).fill(0),
    players: { black: null, white: null },
    names: { black: "黑方", white: "白方" },
    turn: 1, // 黑先
    status: "waiting",
    winner: null,
    winLine: null,
    restartVotes: [],
    moveCount: 0,
  };
  rooms.set(id, room);
  return room;
}

/** 重置房间到新一局（颜色不变，黑先） */
function resetRoom(room) {
  room.board = new Array(BOARD_SIZE * BOARD_SIZE).fill(0);
  room.turn = 1;
  room.status = "playing";
  room.winner = null;
  room.winLine = null;
  room.restartVotes = [];
  room.moveCount = 0;
}

/* ============================================================================
 * 4. 胜负判定：四方向延伸算法
 * ========================================================================== */

/**
 * 检查 (x, y) 处落子 color 后是否获胜。
 * 原理：胜负只可能由"刚落的这颗子"决定，因此只需检查以它为中心的
 * 4 条轴线（横、竖、两条对角线）。对每条轴线：
 *   1) 从落点向正方向连续数同色子 → countF
 *   2) 向反方向连续数同色子       → countB
 *   3) total = countF + countB + 1（+1 是落子本身）
 * total >= 5 即胜。越界视为线段中断。
 *
 * @param {number[]} board 225 长度的一维棋盘
 * @param {number} x 落点列 0~14
 * @param {number} y 落点行 0~14
 * @param {number} color 1=黑 2=白
 * @returns {Array<{x:number,y:number}>|null} 获胜五连（可更长）的坐标数组；未胜返回 null
 */
function checkWin(board, x, y, color) {
  // 四个方向向量：横 →、竖 ↓、撇 ↘、捺 ↗
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];

  for (const [dx, dy] of directions) {
    // line 收集这条轴上连成一线的所有同色坐标，落点先放进去
    const line = [{ x, y }];

    // 向正方向延伸（dx, dy）
    for (let step = 1; step < WIN_COUNT; step++) {
      const nx = x + dx * step;
      const ny = y + dy * step;
      if (!inBounds(nx, ny) || board[idx(nx, ny)] !== color) break;
      line.push({ x: nx, y: ny });
    }
    // 向反方向延伸（-dx, -dy），unshift 保证 line 内坐标有序
    for (let step = 1; step < WIN_COUNT; step++) {
      const nx = x - dx * step;
      const ny = y - dy * step;
      if (!inBounds(nx, ny) || board[idx(nx, ny)] !== color) break;
      line.unshift({ x: nx, y: ny });
    }

    if (line.length >= WIN_COUNT) return line; // 返回整条连线，前端高亮用
  }
  return null;
}

/** 二维坐标 → 一维索引 */
const idx = (x, y) => y * BOARD_SIZE + x;
/** 坐标是否在棋盘内 */
const inBounds = (x, y) => x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;

/* ============================================================================
 * 5. 状态广播：向两名玩家分别推送（各自知道自己的颜色）
 * ========================================================================== */

/**
 * 构造某个视角的房间状态快照。
 * 双方收到的 board / status 完全一致，差别只在 ownColor 字段，
 * 前端据此渲染"你执黑/执白"、是否轮到你、棋盘是否可点击。
 */
function snapshotFor(room, ownColor) {
  return {
    roomId: room.id,
    ownColor, // "black" | "white"
    board: room.board,
    turn: room.turn,
    status: room.status,
    winner: room.winner,
    winLine: room.winLine,
    names: room.names,
    moveCount: room.moveCount,
    // restartVotes 只在 finished 状态下对前端有意义，附带数量即可
    restartVotes: room.restartVotes.length,
  };
}

/**
 * 向房间内所有在线玩家推送最新状态。
 * 每次状态变化（开局 / 落子 / 胜负 / 重开 / 断线）后都必须调用，
 * 保证两端状态与服务端严格一致。
 */
function broadcastState(room) {
  if (room.players.black) {
    io.to(room.players.black).emit("gameState", snapshotFor(room, "black"));
  }
  if (room.players.white) {
    io.to(room.players.white).emit("gameState", snapshotFor(room, "white"));
  }
}

/* ============================================================================
 * 6. Socket.io 事件处理
 * ========================================================================== */

io.on("connection", (socket) => {
  console.log(`[conn] ${socket.id} 已连接，当前连接数: ${io.of("/").sockets.size}`);

  /* ------------------------------------------------------------------
   * joinRoom：加入房间（roomId 为空则自动建房），满 2 人自动开局
   * ---------------------------------------------------------------- */
  socket.on("joinRoom", ({ roomId, name } = {}) => {
    // 已在房间里则忽略，防止重复点击
    if (socketRoom.has(socket.id)) return;

    let room;

    if (roomId) {
      room = rooms.get(String(roomId).toUpperCase());
      if (!room) {
        socket.emit("roomError", { code: "ROOM_NOT_FOUND", message: "房间不存在，请检查房间号" });
        return;
      }
    } else {
      // 自动建房：达到上限则拒绝，保护内存
      if (rooms.size >= MAX_ROOMS) {
        socket.emit("roomError", { code: "ROOMS_FULL", message: "服务器房间数已达上限，请稍后再试" });
        return;
      }
      room = createRoom();
    }

    // 分配颜色：空位优先，黑位（先手）先补
    let color;
    if (!room.players.black) color = "black";
    else if (!room.players.white) color = "white";
    else {
      socket.emit("roomError", { code: "ROOM_FULL", message: "该房间已满（2 人）" });
      return;
    }

    // 登记玩家，加入 Socket.io 房间通道（broadcast 用）
    room.players[color] = socket.id;
    room.names[color] = typeof name === "string" && name.trim() ? name.trim().slice(0, 16) : color === "black" ? "黑方" : "白方";
    socketRoom.set(socket.id, room.id);
    socket.join(room.id);

    console.log(`[join] ${socket.id} 加入房间 ${room.id} 执${color === "black" ? "黑" : "白"}`);

    // 满 2 人 → 自动开局
    if (room.players.black && room.players.white) {
      resetRoom(room);
    }

    broadcastState(room);
  });

  /* ------------------------------------------------------------------
   * placeStone：落子。服务端权威校验：回合 / 坐标 / 空位
   * ---------------------------------------------------------------- */
  socket.on("placeStone", ({ x, y } = {}) => {
    const roomId = socketRoom.get(socket.id);
    const room = roomId && rooms.get(roomId);
    if (!room) {
      socket.emit("roomError", { code: "ROOM_NOT_FOUND", message: "你尚未加入房间" });
      return;
    }
    if (room.status !== "playing") {
      socket.emit("roomError", { code: "NOT_PLAYING", message: "对局未开始或已结束" });
      return;
    }

    // 我是什么颜色
    const color = room.players.black === socket.id ? 1 : room.players.white === socket.id ? 2 : 0;
    if (!color) return; // 观战者/异常状态，直接忽略

    // 校验 1：轮次
    if (room.turn !== color) {
      socket.emit("roomError", { code: "NOT_YOUR_TURN", message: "还没轮到你落子" });
      return;
    }
    // 校验 2：坐标合法
    if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(x, y)) {
      socket.emit("roomError", { code: "BAD_COORD", message: "坐标不合法" });
      return;
    }
    // 校验 3：空位
    if (room.board[idx(x, y)] !== 0) {
      socket.emit("roomError", { code: "OCCUPIED", message: "该位置已有棋子" });
      return;
    }

    // —— 全部通过，落子 ——
    room.board[idx(x, y)] = color;
    room.moveCount++;

    const winLine = checkWin(room.board, x, y, color);
    if (winLine) {
      // 胜利
      room.status = "finished";
      room.winner = color;
      room.winLine = winLine;
    } else if (room.moveCount >= BOARD_SIZE * BOARD_SIZE) {
      // 平局：225 格下满
      room.status = "finished";
      room.winner = 0;
      room.winLine = null;
    } else {
      // 换边
      room.turn = color === 1 ? 2 : 1;
    }

    broadcastState(room);
  });

  /* ------------------------------------------------------------------
   * requestRestart：再来一局。双方都同意才重开
   * ---------------------------------------------------------------- */
  socket.on("requestRestart", () => {
    const roomId = socketRoom.get(socket.id);
    const room = roomId && rooms.get(roomId);
    if (!room) return;

    // 只在对局结束后允许请求重开（进行中请走 leaveRoom）
    if (room.status !== "finished") return;

    // 记票（去重，防止刷票）
    if (!room.restartVotes.includes(socket.id)) {
      room.restartVotes.push(socket.id);
    }

    // 双方都同意 → 开新局
    const onlinePlayers = [room.players.black, room.players.white].filter(Boolean);
    if (room.players.black && room.players.white && room.restartVotes.length >= 2) {
      resetRoom(room);
    } else if (onlinePlayers.length === 1) {
      // 对手已断线只剩自己：单人同意也直接重开，等新对手加入
      resetRoom(room);
    }

    broadcastState(room);
  });

  /* ------------------------------------------------------------------
   * leaveRoom：主动退出（返回大厅）
   * ---------------------------------------------------------------- */
  socket.on("leaveRoom", () => {
    handleLeave(socket, false);
  });

  /* ------------------------------------------------------------------
   * disconnect：断线处理。对局中断线判负；房间空了销毁
   * ---------------------------------------------------------------- */
  socket.on("disconnect", () => {
    console.log(`[disc] ${socket.id} 断开，当前连接数: ${io.of("/").sockets.size}`);
    handleLeave(socket, true);
  });
});

/**
 * 统一处理玩家离开（主动退出 / 断线）。
 * @param {Socket} socket
 * @param {boolean} isDisconnect true=断线（对手判负），false=主动退出（不判负）
 */
function handleLeave(socket, isDisconnect) {
  const roomId = socketRoom.get(socket.id);
  if (!roomId) return;
  const room = rooms.get(roomId);
  socketRoom.delete(socket.id);
  if (!room) return;

  // 找到离开者的颜色
  const color = room.players.black === socket.id ? "black" : room.players.white === socket.id ? "white" : null;
  if (!color) return;

  const opponentColor = color === "black" ? "white" : "black";

  // 对局进行中且对手还在：断线判负（主动退出同样视为认输，体验一致）
  if (room.status === "playing" && room.players[opponentColor]) {
    room.status = "finished";
    room.winner = opponentColor === "black" ? 1 : 2;
    room.winLine = null;
    if (io.of("/").sockets.has(room.players[opponentColor])) {
      io.to(room.players[opponentColor]).emit("opponentLeft", {
        message: isDisconnect ? "对手断线，你获胜了！" : "对手退出了房间，你获胜了！",
      });
    }
  }

  // 移除离开者，但保留房间对象（剩余玩家可等待新对手 / 单人重开）
  room.players[color] = null;
  room.restartVotes = room.restartVotes.filter((id) => id !== socket.id);

  // 房间里一个在线玩家都不剩 → 销毁房间，释放内存
  const anyOnline =
    (room.players.black && io.of("/").sockets.has(room.players.black)) ||
    (room.players.white && io.of("/").sockets.has(room.players.white));
  if (!anyOnline) {
    rooms.delete(room.id);
    console.log(`[clean] 房间 ${room.id} 已空，销毁。剩余房间数: ${rooms.size}`);
    return;
  }

  broadcastState(room);
}

/* ============================================================================
 * 7. 启动服务：监听 Render 注入的 PORT，绑定 0.0.0.0
 * ========================================================================== */

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ 五子棋后端已启动: http://0.0.0.0:${PORT}`);
  console.log(`   CORS origin: ${CORS_ORIGIN}`);
  console.log(`   最大房间数:   ${MAX_ROOMS}`);
});
