# 联机五子棋 · 部署文档（Cloudflare 全家桶）

> 架构：前端静态资源 + 后端 `_worker.js`（高级模式）+ Durable Objects，全部跑在 **Cloudflare Pages 免费套餐**上。
> 前后端同域，无 CORS、无绑卡、无冷启动。
> 线上地址：https://gomoku-367.pages.dev

---

## 前置条件

1. Cloudflare 账号（免费版即可）
2. 本机安装 Node 18+，登录 wrangler：`npx wrangler login`（浏览器授权）

---

## 首次部署（三个命令）

```bash
# ① 部署 DO 宿主 Worker（RoomDO 类住在这里）
npx wrangler deploy -c wrangler.worker.jsonc

# ② 创建 Pages 项目（首次执行一次；项目名决定域名 gomoku-367.pages.dev）
npx wrangler pages project create gomoku --production-branch=main

# ③ 部署前端 + 后端到 Pages
npx wrangler pages deploy
```

> 说明：Pages 不能自定义 DO 类，所以 `RoomDO` 定义在独立 Worker `gomoku-server` 中，
> Pages 通过 `wrangler.jsonc` 里的 `script_name` 跨脚本绑定。玩家只访问 pages.dev。

## 日常发版

```bash
git add . && git commit -m "..." && git push        # 备份到 GitHub
npx wrangler pages deploy                            # 发布（前端或 _worker.js 改动）
# 仅当 RoomDO 类（public/_worker.js 与 server/worker.js 中的类）有结构变更时：
npx wrangler deploy -c wrangler.worker.jsonc
```

---

## 验证

| 检查项 | 命令/操作 | 预期 |
|---|---|---|
| 后端存活 | 访问 `https://gomoku-367.pages.dev/health` | `{"ok":true}` |
| 建房 API | 访问 `/api/new-room` | `{"roomId":"XXXXXX"}` |
| 双人对弈 | 两个标签页打开首页，A 留空房间号加入，B 输入同号加入 | 黑先自动开局 |
| 胜负判定 | 连下五子 | 双方同步终局 + 五连红圈 |
| 断线判负 | 对局中关闭一端 | 另一方收到"对手断线，你获胜了！" |

自动化冒烟测试脚本（本仓库开发时使用）：`npm i ws` 后运行双客户端模拟，覆盖
建房/分配黑白/自动开局/非法落子拦截/五连胜/再来一局/断线判负 全流程。

---

## 常见问题排查

### Q1：页面打不开 / 状态栏一直"正在连接服务器…"
- F12 → Network → WS，看 `/ws` 请求状态
- 若 `workers.dev` 域名打不开是正常的——大陆网络普遍屏蔽该域名，本项目客户端只走 `pages.dev`
- 确认部署成功：`npx wrangler pages deployment list` 最新一次状态为 Active

### Q2：WebSocket 返回 500（error 1101）
- Worker 内部异常。历史上踩过的坑：
  - **Hibernation API 下调用了 `accept()`**——使用 `acceptWebSocket()` 后绝不能再 `accept()`（已修复，勿改回）
  - DO 宿主 Worker 未部署/迁移未应用 → 重新执行 `npx wrangler deploy -c wrangler.worker.jsonc`
- 本地复现：`npx wrangler pages dev` 后访问 http://localhost:8787/ws?room=TEST01

### Q3：加入房间提示"房间不存在"
- 房间号输入错误（6 位，字母数字，无 0/O/1/I）
- 房间是内存+存储态，长期无人后会自动清理，重新创建即可

### Q4：改了前端没生效
- Cloudflare CDN 缓存：Ctrl+Shift+R 强刷
- 确认 `wrangler pages deploy` 输出成功且版本 ID 变化

### Q5：为什么不用 Render？
- Render/Koyeb/Fly 免费套餐均要求绑卡（Render API 实测返回 402）
- workers.dev 域名在大陆被屏蔽，因此 DO 宿主 Worker 也只作为类宿主，客户端绝不直连

---

## 环境变量

无。所有配置在 `wrangler.jsonc` / `wrangler.worker.jsonc` 中（DO 绑定与迁移），
前端 `SERVER_URL` 在 `public/index.html` 中（同域部署留空即可）。
