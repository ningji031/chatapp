# ChatApp — PC · Android · iOS 三合一聊天软件

## 项目结构

```
chatapp/
├── server/          后端（Node.js + Express + Socket.io + sql.js）
│   ├── index.js     主服务入口
│   ├── package.json
│   └── chat.db      数据库（首次运行自动生成）
└── client/
    └── index.html   前端（单文件 SPA，响应式设计）
```

---

## 功能特性

| 功能 | 说明 |
|------|------|
| 注册/登录 | JWT 认证，密码 bcrypt 加密 |
| 频道聊天 | 大厅、技术交流、闲聊水区（可扩展） |
| 私聊 | 一对一实时私信 |
| 实时通信 | WebSocket（Socket.io），断线自动重连 |
| 在线状态 | 实时显示在线用户列表 |
| 输入提示 | "xxx 正在输入…" |
| 未读计数 | 侧边栏红点提示 |
| 表情包 | 内置 80+ Emoji 快速发送 |
| 历史消息 | 进入频道/私聊自动加载最近消息 |
| 全平台适配 | PC 宽屏三栏布局，手机竖屏侧滑菜单 |

---

## 快速启动（本地运行）

### 1. 安装依赖

```bash
cd chatapp/server
npm install
```

### 2. 启动服务器

```bash
node index.js
```

服务默认运行在 **http://localhost:3001**

### 3. 访问

- **PC 浏览器**：打开 http://localhost:3001
- **手机浏览器（同局域网）**：
  1. 查看电脑 IP（`ipconfig` / `ifconfig`）
  2. 手机访问 `http://你的IP:3001`
  3. Android/iOS Safari/Chrome 均可直接使用

---

## 三端打包方案

### PC 桌面端（Electron）

```bash
npm install -g electron electron-builder
# 新建 electron 项目，webviewURL 指向 http://localhost:3001
```

### Android APK（Capacitor / WebView）

```bash
npm install @capacitor/core @capacitor/android
npx cap init ChatApp com.chatapp.app
npx cap add android
npx cap open android   # 用 Android Studio 打包 APK
```

### iOS App（Capacitor / WKWebView）

```bash
npx cap add ios
npx cap open ios       # 用 Xcode 签名打包（需 macOS + Apple 开发者账号）
```

> **最简方案**：把网页地址分享给手机用户，在 Android 上用"添加到主屏幕"或 iOS Safari 的"添加到主屏幕"，即可像 App 一样使用（PWA）。

---

## 生产部署（联网让所有人能访问）

### 方案一：云服务器

```bash
# 上传 chatapp 目录到服务器
# 安装 Node.js 18+
npm install
node index.js
# 配置 Nginx 反向代理到 3001 端口
```

### 方案二：Railway / Render（免费托管）

1. 推送到 GitHub
2. 在 Railway/Render 新建 Node.js 服务
3. 启动命令：`node server/index.js`
4. 环境变量：`PORT=3001`

### 方案三：ngrok（临时公网测试）

```bash
npm install -g ngrok
ngrok http 3001
# 会生成一个公网地址，手机和远程用户都可以访问
```

---

## 自定义配置

| 文件 | 配置项 |
|------|--------|
| `server/index.js` | `PORT`（端口）、`JWT_SECRET`（密钥） |
| `client/index.html` | `SERVER_URL`（后端地址，生产部署时修改） |
