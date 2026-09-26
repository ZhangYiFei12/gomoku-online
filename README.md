# 联机五子棋（Gomoku Online）

网页版联机五子棋，**全栈部署在 Cloudflare Pages**（前端静态资源 + 后端高级模式 Worker + Durable Objects）。

- 🌐 线上地址：https://gomoku-367.pages.dev
- 🔌 前后端同域，无 CORS 问题，无 workers.dev 被墙问题
- 🆓 免费套餐运行，无需绑卡，无冷启动休眠

## 架构

```
浏览器 ── WebSocket /ws?room=XXXX（同域）──> Cloudflare Pages
                                              ├── 静态资源（public/index.html）
                                              └── _worker.js（后端）
                                                    └── RoomDO（每房间一个 Durable Object）
                                                          └── 状态持久化（SQLite）+ Hibernation 免费保活

RoomDO 类宿主：独立 Worker "gomoku-server"（仅承载类，客户端不直连）
```

- **服务端权威**：落子合法性、回合、胜负判定全在服务端（`checkWin` 四方向延伸）
- **协议**：JSON `{event, data}`，事件 `joinRoom / placeStone / requestRestart / leaveRoom` → `gameState / roomError / opponentLeft`

## 项目结构

```
gomoku-online/
├── public/
│   ├── index.html        # 前端单页（Canvas 棋盘，暗色主题）
│   └── _worker.js        # 后端（Pages 高级模式：/health /api/new-room /ws + 静态回退）
├── server/
│   └── worker.js         # DO 宿主 Worker 源码（RoomDO 类定义，与 _worker.js 保持同步）
├── wrangler.jsonc        # Pages 配置（跨脚本绑定 RoomDO）
├── wrangler.worker.jsonc # DO 宿主 Worker 配置（含 SQLite 迁移）
└── DEPLOY.md             # 部署文档
```

## 本地开发

```bash
npx wrangler pages dev   # 本地模拟 Pages + DO（http://localhost:8787）
```

## 部署

```bash
# 1. DO 宿主 Worker（RoomDO 类变更时才需要重新部署）
npx wrangler deploy -c wrangler.worker.jsonc

# 2. Pages（前端 + 后端，日常发版只跑这条）
npx wrangler pages deploy
```

详见 [DEPLOY.md](DEPLOY.md)。

## 双人对弈流程

1. 玩家 A 留空房间号点「加入/创建」→ 自动生成 6 位房间号，执黑等待
2. 玩家 B 输入房间号加入 → 执白，自动开局，黑先
3. 五子连珠获胜（获胜五连红圈高亮）；棋盘下满平局
4. 对局中断线判负；结束后双方同意可再来一局
