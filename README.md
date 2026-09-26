# 联机五子棋（Gomoku Online）

网页版联机五子棋。前端纯静态托管于 **Cloudflare Pages**，后端 Node.js + Express + Socket.io 部署于 **Render**。

```
浏览器 ── Socket.io(跨域) ──> Render (server.js, 服务端权威)
  │
  └── 静态资源 <── Cloudflare Pages (public/)
```

## 本地开发

```bash
npm install
npm start
# 打开 http://localhost:3000（Express 会托管 public/，同源联调时
# 前端 config.js 里 SOCKET_URL 留空即可）
```

---

## 部署指南

### 第 1 步：推送到 GitHub

```bash
cd gomoku-online
git init
git add .
git commit -m "init: gomoku online"
git branch -M main
# 在 GitHub 上新建空仓库（例如 yourname/gomoku-online）后：
git remote add origin https://github.com/yourname/gomoku-online.git
git push -u origin main
```

> 后续每次 `git push`，Render 和 Cloudflare Pages 都会自动重新部署。

### 第 2 步：Render 创建 Web Service

**方式 A：Blueprint 一键部署（推荐，使用仓库中的 render.yaml）**

1. 登录 [dashboard.render.com](https://dashboard.render.com)
2. **New + → Blueprint**
3. 选择你的 GitHub 仓库 `gomoku-online`
4. Render 自动读取 `render.yaml`，确认后点击 **Apply**

**方式 B：手动创建**

1. **New + → Web Service**
2. 连接 GitHub 仓库 `gomoku-online`
3. 按下表填写：

| 配置项 | 值 |
|---|---|
| Name | `gomoku-server` |
| Runtime | `Node` |
| Branch | `main` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | `Free` |
| Health Check Path | `/health` |

4. **Environment** 标签页添加环境变量（见第 4 步）

### 第 3 步：获取 Render URL

- 部署完成后（状态变绿 **Live**），服务页顶部会显示地址，格式为：
  ```
  https://gomoku-server.onrender.com
  ```
- 验证部署成功：浏览器访问 `https://gomoku-server.onrender.com/health`，返回 `{"ok":true}` 即为正常。
- 这个地址就是后端的 **Socket.io 连接地址**，填入前端 `public/js/config.js`：
  ```js
  const SOCKET_URL = "https://gomoku-server.onrender.com";
  ```

> ⚠️ 免费版 15 分钟无流量会休眠，首次连接需等待 30~60 秒冷启动，属正常现象。

### 第 4 步：配置环境变量 CORS_ORIGIN

在 Render 服务页 → **Environment → Environment Variables**：

| Key | Value |
|---|---|
| `CORS_ORIGIN` | `https://你的项目名.pages.dev` |
| `MAX_ROOMS`（可选） | `200` |

**CORS_ORIGIN 怎么填：**

1. 先去 Cloudflare Pages 完成前端部署，得到 Pages 域名（形如 `https://gomoku.pages.dev`，或预览域名 `https://xxxx.gomoku.pages.dev`）
2. 把该域名完整填入 `CORS_ORIGIN`（带 `https://`，结尾不带 `/`）
3. 需要允许多个来源时用逗号分隔，例如本地联调也放开：
   ```
   https://gomoku.pages.dev,http://localhost:8787
   ```
4. 保存后 Render 会自动重启服务生效

> 不要填 `*` 上生产——Socket.io 跨域凭据场景下应精确匹配 Pages 域名。

### 第 5 步：验证联机

两个浏览器（或一个无痕窗口）打开 Pages 域名：

1. 玩家 A 创建房间，记下 6 位房间号
2. 玩家 B 输入房间号加入
3. 双方看到"对局开始，黑先行"即部署成功

---

## 项目结构

```
gomoku-online/
├── server.js        # 后端入口（部署到 Render）
├── package.json     # 后端依赖（Render 用）
├── render.yaml      # Render Blueprint 一键部署配置
└── public/          # 前端（部署到 Cloudflare Pages，输出目录填 public）
```
