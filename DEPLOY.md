# 部署说明 · Web 应用导航面板（带登录 + PostgreSQL 持久化）

一个带**账号登录**与**云端数据同步**的 Web 应用导航面板。前端纯静态，后端用 Deno + PostgreSQL（数据存数据库，不再依赖浏览器 localStorage）。

> ⚠️ **Deno Deploy Classic 已于 2026-07-20 关停**,本文档针对**新版 Deno Deploy 平台**(`console.deno.com`)。代码无需改动即可上线。

## 项目文件

| 文件 | 作用 |
|---|---|
| `index.html` | 页面结构（登录视图 + 主应用，浏览器端） |
| `styles.css` | 浅/深主题样式（浏览器端） |
| `app.js` | 前端逻辑：登录态、链接增删改查（调用后端 API） |
| `server.ts` | Deno 入口：静态文件服务 + `/api/*` 路由分发 |
| `api.ts` | 认证与链接 CRUD 路由处理 |
| `db.ts` | PostgreSQL 连接池、自动建表、密码哈希（PBKDF2）、会话令牌 |
| `deno.json` | `start` / `dev` 任务（含 `--env-file=.env`） |
| `.env.example` | 环境变量示例（复制为 `.env` 使用） |

## 环境变量

应用通过 `DATABASE_URL` 读取 PostgreSQL 连接串（**务必从环境变量注入，切勿硬编码进代码**）：

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=verify-full
```

- db.ts 在连接串**缺少 database 名时会自动回退为 `postgres`**。
- TLS 用 `tls: { enabled: true }`，等价于 `sslmode=verify-full`（Deno 内置 CA 校验服务器证书）。
- 启动时会自动执行 `CREATE TABLE IF NOT EXISTS`，建好 `users` / `links` / `sessions` 三张表，无需手动迁移。

## 本地运行

```bash
cp .env.example .env      # 填入你的 DATABASE_URL
deno task start           # 启动，访问 http://localhost:8000
deno task dev             # 带 --watch 热重载
```

## API 一览

| 方法 | 路径 | 说明 | 需登录 |
|---|---|---|---|
| POST | `/api/register` | 注册（用户名 3-32 位，密码 ≥6 位），自动登录 | 否 |
| POST | `/api/login` | 登录，下发 HttpOnly Session Cookie | 否 |
| POST | `/api/logout` | 注销当前会话 | 是 |
| GET | `/api/me` | 返回当前登录用户（无则返回 `user:null`） | 是 |
| GET | `/api/links` | 列出当前用户的所有链接 | 是 |
| POST | `/api/links` | 新增链接 | 是 |
| PUT | `/api/links/:id` | 更新链接 | 是 |
| DELETE | `/api/links/:id` | 删除链接 | 是 |

> 所有链接数据按 `user_id` 隔离，用户之间互不可见。密码用 PBKDF2（SHA-256, 12 万次迭代）哈希存储，会话令牌存数据库 + HttpOnly Cookie。

## 部署到新版 Deno Deploy

### 准备工作（一次性）
1. 访问 **[console.deno.com](https://console.deno.com)** 登录并创建一个 **Organization**。
2. 新版平台用**交互式浏览器 OAuth 登录**(无 `DENO_DEPLOY_TOKEN` 无头令牌)，部署需在能开浏览器的本机执行。

### 控制台 + GitHub（推荐）

> 核心思路:让 Deno Deploy 把 `dist/` 当成**应用工作目录**来跑 `server.ts`。`server.ts` 用 `const ROOT = "."`(相对 cwd),只要运行时 cwd = `dist/`,就会自动服务压缩后的前端资源。

1. 把仓库推到 GitHub(含 `index.html` `styles.css` `app.js` `server.ts` `api.ts` `db.ts` `deno.json` `scripts/`;**不要提交 `.env`**,它已被 `.gitignore` 排除)。
2. 控制台 **+ New App** → 选仓库 → 打开 **Edit app configuration**,按下面配置:
   - **App Directory** = `dist` ← 关键:让运行时 cwd = `dist/`,`ROOT="."` 自然命中压缩后的 `app.js`
   - **Runtime Working Directory** = **留空**(默认 = App Directory = `dist`)。这是进程启动时的子目录,**相对 App Directory 拼一层**——如果填 `dist` 就会变成 `dist/dist/`,启动失败。**千万别填值**。
   - **Framework preset** = `No Preset`
   - **Runtime** = `Dynamic`
   - **Dynamic Entry Point** = `server.ts`
   - **Install command** 留空(无 npm 依赖,不要写 `npm install`)
   - **Build command** = `deno task build` ← 部署前压缩,生成 dist/ 与预生成 .gz/.br
   - **Pre-deploy command** 留空(无 DB migration 需求)
3. 在 App 的 **Environment Variables** 里添加 `DATABASE_URL`(你的 PostgreSQL 连接串)。
4. 创建即上线,控制台给出生产 URL。

> 💡 **为什么是 dist + Build command 双填**:Deno Deploy 默认会把仓库根当成 App Directory,直接跑会读到未压缩的源码。填 `dist` 把工作目录切到压缩产物目录,`deno task build` 负责在部署时按需重新生成该目录(只需 **Build command 一次**,之后 Deploy 时 Deno Deploy 会先跑 Build 重新生成 `dist/`,再以 `dist/` 为 App Directory 启动)。
>
> **等价写法**(已实测可用):把 **App Directory 留空**(默认=仓库根),**Runtime Working Directory 填 `dist/`**。两者最终运行时 cwd 都是 `dist/`,效果完全相同。区别:留空写法会把整个仓库(含未压缩源码)上传到平台;App Directory=`dist` 只上传压缩产物,更干净。任选其一即可。

### CLI 直传(无需 GitHub)
```bash
# ① 部署前先压缩 JS/CSS/HTML 并预生成 .gz/.br,产物输出到 dist/
deno task build
# ② 进入 dist/ 部署(dist/ 才是压缩后的部署目录,且已排除 .env / 证书等敏感文件)
cd dist && deno deploy --org <组织名> --app web-app-launcher --prod && cd ..
# 部署时仍需在控制台 Environment Variables 配置 DATABASE_URL
```

> 🗜️ **部署前压缩**：`deno task build` 会用 esbuild 压缩 `app.js`/`admin.js`/`marketplace.js`/`delight.js`/`sw.js`/`styles.css`、用 html-minifier-terser 压缩三个 HTML，按「压缩后内容」自动重算 `?v=` 版本号（内容变了才换 URL、才让浏览器重新拉取），并为所有文本资源预生成 `.gz`/`.br`。`server.ts` 已支持按 `Accept-Encoding` 协商发送预压缩文件，无需运行时压缩。本地开发与线上部署都走这套压缩产物，体积通常可降 50%+。

## 安全提示
- `.env` 含数据库凭据，已写入 `.gitignore`，**严禁提交到仓库**。
- 已在 `server.ts` 用 `Deno.realPath` 做目录穿越防护；API 路由仅服务 `/api/*`，静态文件不可访问 `db.ts`/`api.ts` 之外的敏感路径。
- 生产环境务必使用强密码，并定期轮换 `DATABASE_URL` 凭据。
