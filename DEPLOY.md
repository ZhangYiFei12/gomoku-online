# 联机五子棋 · 从零到上线部署文档

> 架构：前端（纯静态）→ Cloudflare Pages｜后端（Node.js + Socket.io）→ Render Web Service
>
> 本文所有命令在项目根目录 `gomoku-online/` 下执行。

---

## 第〇阶段：部署前检查清单

确认以下文件已就位且内容正确：

| 文件 | 用途 | 部署到 |
|---|---|---|
| `server.js` | 后端入口（含 `/health` 健康检查） | Render |
| `package.json` | 后端依赖 + `start` 脚本 | Render |
| `render.yaml` | Render Blueprint（可选，一键部署用） | Render |
| `public/index.html` | 前端单页 | Cloudflare Pages |
| `.gitignore` | 排除 node_modules / .env / 日志 | 两者共用 |

**本地先跑通再上云**（强烈建议）：

```bash
cd gomoku-online
npm install
npm start
# 浏览器打开 http://localhost:3000
# 前端 SERVER_URL 为 "https://gomoku-server.onrender.com" 时本地会连云端；
# 若想纯本地联调，把 SERVER_URL 临时改成 ""（走同源 localhost:3000）
```

验证：开两个标签页加入同一房间号能对弈，即本地逻辑 OK。

---

## 第一阶段：推送到 GitHub

### 1.1 本地初始化 git 仓库

```bash
cd gomoku-online
git init
git branch -M main
```

### 1.2 确认 .gitignore

项目应包含如下 `.gitignore`（已生成，核对内容即可）：

```gitignore
node_modules/
.env
.env.*
!.env.example
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
logs/
.DS_Store
Thumbs.db
.idea/
.vscode/
```

**重点**：`node_modules/` 必须忽略（Render 会根据 `package.json` 自行 `npm install`）；`.env` 绝不入库。

### 1.3 创建 GitHub 仓库并推送

1. 登录 [github.com](https://github.com) → 右上角 **+** → **New repository**
2. Repository name 填 `gomoku-online`，选 **Public**（免费版 Render/Pages 拉私有库也可以，但 Public 最省事）→ **Create repository**
3. 回到本地执行：

```bash
git add .
git commit -m "init: gomoku online (server + client + deploy configs)"
git remote add origin https://github.com/<你的用户名>/gomoku-online.git
git push -u origin main
```

✅ 验收：刷新 GitHub 仓库页，能看到 `server.js`、`public/index.html` 等文件，且**没有** `node_modules` 目录。

---

## 第二阶段：部署后端到 Render

### 2.1 创建 Web Service

1. 登录 [dashboard.render.com](https://dashboard.render.com)（可直接用 GitHub 账号登录，并授权仓库访问）
2. 顶部 **New +** → **Web Service**

### 2.2 连接仓库

- 在 "Git Provider" 列表中选择你的 `gomoku-online` 仓库 → **Connect**
- 📸 *截图位置：仓库选择列表页*

> 若列表里没有该仓库：点击 GitHub 账号旁的 **Configure account**，勾选 gomoku-online 仓库权限后刷新。

### 2.3 填写配置

| 配置项 | 填写值 |
|---|---|
| **Name** | `gomoku-server`（决定 URL，见 2.6） |
| **Project** | 随意，如 `gomoku` |
| **Language / Runtime** | `Node` |
| **Branch** | `main` |
| **Region** | 选离你近的（如 Singapore） |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | **Free** |

📸 *截图位置：Web Service 创建表单页*

### 2.4 添加环境变量

在同一页面下方 **Environment Variables** 区：

| Key | Value（此阶段） |
|---|---|
| `CORS_ORIGIN` | `*`（临时；第四阶段改回 Pages 域名） |

> `PORT` 由 Render 自动注入，**不要**手动添加。

### 2.5 创建并等待部署

点击 **Create Web Service**（或使用 Blueprint 时点 **Apply**），进入部署页：

- 观察日志：`npm install` → `node server.js` → 出现
  `✅ 五子棋后端已启动: http://0.0.0.0:10000`
- 顶部状态从 **Deploying** 变为 **Live**（约 2~5 分钟）

### 2.6 记录 Render URL

- 服务页顶部显示地址，格式：`https://gomoku-server.onrender.com`
  （若名称被占用会是 `gomoku-server-xxxx.onrender.com`，以页面显示为准）
- 📝 把它记下来，第四阶段要填入前端 `SERVER_URL`

### 2.7 验证后端存活

浏览器访问：

```
https://gomoku-server.onrender.com/health
```

看到 `{"ok":true}` 即部署成功。也可命令行验证：

```bash
curl https://gomoku-server.onrender.com/health
```

---

## 第三阶段：部署前端到 Cloudflare Pages

### 3.1 进入 Pages 创建流程

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com)
2. 左侧菜单 **Workers & Pages** → **Create** → 切到 **Pages** 标签
3. 选择 **Connect to Git** → 授权并选择 GitHub

### 3.2 选择仓库

- 在仓库列表中选 `gomoku-online` → **Begin setup**
- 📸 *截图位置：GitHub 仓库授权/选择页*

### 3.3 构建配置（关键，照抄）

| 配置项 | 填写值 |
|---|---|
| **Project name** | `gomoku`（决定 Pages 域名） |
| **Production branch** | `main` |
| **Framework preset** | **None** |
| **Build command** | **留空** |
| **Build output directory** | `public` |

📸 *截图位置：Build settings 配置页*

> ⚠️ Build output directory 填 `public` 不是 `public/`，更不是根目录 `.`。填错是部署后 404 的头号原因。

### 3.4 部署

点击 **Save and Deploy**，等待构建完成（纯静态，约 30 秒），状态变 **Success**。

### 3.5 记录 Pages 域名

- 部署成功页显示：`https://gomoku.pages.dev`
  （实际以 `https://<Project name>.pages.dev` 为准）
- 📝 记下来，第四阶段要填入 Render 的 `CORS_ORIGIN`

---

## 第四阶段：打通前后端（互相回填地址）

前两阶段各自拿到了地址，现在交叉回填。**顺序：先改前端连后端，再收紧后端 CORS。**

### 4.1 改前端 SERVER_URL

编辑 `public/index.html`，找到：

```js
const SERVER_URL = "https://gomoku-server.onrender.com";
```

确认/替换为第二阶段 2.6 记录的 **真实 Render 地址**。

### 4.2 提交推送，Pages 自动重新部署

```bash
git add public/index.html
git commit -m "config: point SERVER_URL to render backend"
git push
```

推送后 Cloudflare Pages 自动触发重新部署（Pages 项目页可看进度，约 30 秒）。

### 4.3 收紧 CORS_ORIGIN

1. 回到 Render Dashboard → 进入 `gomoku-server` 服务
2. 左侧 **Environment** → 找到 `CORS_ORIGIN`，把 `*` 改为：

   ```
   https://gomoku.pages.dev
   ```

   （用 3.5 记录的真实 Pages 域名；本地联调地址也可追加：`https://gomoku.pages.dev,http://localhost:3000`）

3. 点击 **Save Changes**

### 4.4 等待 Render 自动重启

保存后 Render 自动重启服务（约 1 分钟），状态重新变 **Live**。CORS 立即生效。

---

## 第五阶段：验证上线

### 5.1 基础连通

1. 浏览器打开 Pages 域名 `https://gomoku.pages.dev`
2. 页面正常显示棋盘，状态栏经过短暂"正在连接服务器…"后显示
   **"已连接服务器，输入房间号加入对战"** —— 前后端已打通

### 5.2 对弈流程测试

开两个浏览器标签页（或一台手机 + 一台电脑）：

| 步骤 | 标签页 A | 标签页 B | 预期 |
|---|---|---|---|
| 1 | 输名字 → 留空房间号 → 加入 | — | 显示 6 位房间号，状态"等待对手" |
| 2 | — | 复制房间号输入 → 加入 | 双方状态变"对局开始"，A 执黑先手 |
| 3 | 点棋盘落子 | — | B 端同步显示黑子，轮到 B |
| 4 | — | B 在非自己回合快速点棋盘 | B 端提示"还没轮到你落子"，棋盘不变 |
| 5 | 连下五子 | — | 双方显示获胜方，五连红圈高亮 |
| 6 | 点「再来一局」 | 点「再来一局」 | 棋盘清空，黑先重新开局 |

### 5.3 断线处理测试

- 对局中直接关闭标签页 B → A 应收到"对手断线，你获胜了！"
- 刷新 B 页面重新加入同一房间号 → A 看到"对手退出/断线"提示后，B 以新身份入座空位

### 5.4 冷启动认知与应对

**现象**：Render 免费版 15 分钟无流量会休眠，之后首次连接需 **30~60 秒**（表现为状态栏一直"正在连接服务器…"，然后突然连上）。这是套餐限制，不是 bug。

**应对方案（任选）**：

1. **不处理**（推荐先用）：前端已有重连提示，玩家等一分钟即恢复
2. **保活**：注册 [UptimeRobot](https://uptimerobot.com) 免费版，添加 HTTP 监控指向 `https://gomoku-server.onrender.com/health`，每 5 分钟 ping 一次，实例不再休眠
3. **付费**：Render Starter（$7/月）常驻不休眠

---

## 常见问题排查（FAQ）

### Q1：前端一直"正在连接服务器…"，连不上后端

按顺序检查：

1. **SERVER_URL 对不对**：`public/index.html` 里的地址是否与 Render 页面显示完全一致（注意有没有 `-xxxx` 后缀、拼写）
2. **Render 是否在休眠**：直接访问 `https://<render地址>/health`，若转圈很久 → 正在冷启动，等 60 秒；若 404 → 服务名/地址错了
3. **CORS_ORIGIN 是否已回填**：若还是 `*` 以外的错误值（比如填了根域名没带 `https://`），浏览器控制台（F12 → Console）会有 `blocked by CORS policy` 红字
4. **后端是否崩了**：Render 服务页 → **Logs**，看有无报错堆栈

### Q2：浏览器控制台报 CORS 错误

```
Access to XMLHttpRequest ... has been blocked by CORS policy
```

- 核对 Render 环境变量 `CORS_ORIGIN` 与 Pages 域名**逐字符一致**：带 `https://`、不带结尾 `/`、不带路径
- 改完环境变量必须等 Render 重启完成（状态 Live）
- 用了自定义 Pages 域名？把自定义域名也加进 CORS_ORIGIN（逗号分隔）

### Q3：WebSocket 连接失败

- Render 免费版**支持** WebSocket，无需配置
- F12 → Console 看具体错误：若是 `WebSocket is closed before the connection is established`，多半还是冷启动没完成，等重连即可
- 公司网络/浏览器插件（广告拦截器）可能拦 WebSocket，换无痕窗口或手机热点验证

### Q4：Pages 部署后访问 404

- **Build output directory 忘了填 `public`**（最大概率）：Pages 项目 → Settings → Build & deployments → 修改为 `public` → 重新部署
- 检查 `public/index.html` 是否存在于仓库（大小写敏感，`Public` ≠ `public`）
- Pages 部署日志里能看到实际发布的文件列表，确认包含 `index.html`

### Q5：能连上但落子没反应

- F12 → Console 是否有 `roomError`（"还没轮到你落子"/"该位置已有棋子"）
- 对局是否已结束（状态栏显示胜负后要双方点「再来一局」）
- Render Logs 看后端是否打印了 `[conn]`/`[join]` 日志，确认请求到达了服务端

### Q6：改了代码没生效

- 前端：确认 `git push` 成功，Pages 项目页 Deployment 列表有新的构建记录；浏览器 **Ctrl+Shift+R** 强刷缓存
- 后端：确认 push 后 Render 自动部署（Render 服务页 Events 标签），必要时手动 **Manual Deploy → Deploy latest commit**

---

## 附录：环境变量终值速查

| 位置 | 变量 | 终值 | 谁来配 |
|---|---|---|---|
| Render | `PORT` | 自动注入，勿动 | Render |
| Render | `CORS_ORIGIN` | `https://<你的项目>.pages.dev` | 手动（第四阶段） |
| Render | `MAX_ROOMS` | `200`（可选） | 手动 |
| 前端 | `SERVER_URL` | `https://<你的服务>.onrender.com` | 改 index.html（第四阶段） |

## 附录：上线后的日常更新流程

```bash
# 改完代码，三条命令走天下（前后端同时自动部署）
git add .
git commit -m "feat: xxx"
git push
```
