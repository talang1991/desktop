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
1. 把仓库推到 GitHub（含 `index.html` `styles.css` `app.js` `server.ts` `api.ts` `db.ts` `deno.json`；**不要提交 `.env`**，它已被 `.gitignore` 排除）。
2. 控制台 **+ New App** → 选仓库 → Framework Preset `No Preset` → Runtime `Dynamic` → **Dynamic Entrypoint 填 `server.ts`** → Install/Build 留空。
3. 在 App 的 **Environment Variables** 里添加 `DATABASE_URL`（你的 PostgreSQL 连接串）。
4. 创建即上线，控制台给出生产 URL。

### CLI 直传（无需 GitHub）
```bash
deno deploy create --org <组织名> --app web-app-launcher \
  --source local --runtime-mode dynamic --entrypoint server.ts --region global
deno deploy --org <组织名> --app web-app-launcher --prod
# 部署时仍需在控制台 Environment Variables 配置 DATABASE_URL
```

## 安全提示
- `.env` 含数据库凭据，已写入 `.gitignore`，**严禁提交到仓库**。
- 已在 `server.ts` 用 `Deno.realPath` 做目录穿越防护；API 路由仅服务 `/api/*`，静态文件不可访问 `db.ts`/`api.ts` 之外的敏感路径。
- 生产环境务必使用强密码，并定期轮换 `DATABASE_URL` 凭据。
