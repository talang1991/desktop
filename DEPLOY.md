# 部署说明 · Web 应用导航面板

一个本地运行的「Web 应用导航面板」(个人版网址收藏夹 / 应用启动台),纯前端 + Deno 静态服务,数据存浏览器 `localStorage`。

> ⚠️ **Deno Deploy Classic 已于 2026-07-20 关停**,本文档只针对**新版 Deno Deploy 平台**(`console.deno.com`)。代码无需任何修改即可上线,因为 `server.ts` 已使用 `Deno.serve()`。

## 项目文件

| 文件 | 作用 |
|---|---|
| `index.html` | 页面结构(浏览器端) |
| `styles.css` | 浅/深主题样式(浏览器端) |
| `app.js` | 全部交互逻辑(浏览器端,**绝不作为服务端入口**) |
| `server.ts` | Deno 静态服务器(`Deno.serve`),本地运行与云端都靠它 |
| `deno.json` | Deno 任务与配置 |

## 本地运行

```bash
deno task start   # 启动,访问 http://localhost:8000
deno task dev     # 带 --watch 热重载
```

## 部署到新版 Deno Deploy

### 准备工作(一次性的)

1. 访问 **[console.deno.com](https://console.deno.com)** 登录,先创建一个 **Organization**(组织)。
2. 新版平台使用**独立的账号体系 + 交互式浏览器 OAuth 登录**,部署时本地会弹出浏览器完成授权,暂不支持旧 Classic 的 `DENO_DEPLOY_TOKEN` 无头令牌。

### 方式 A:控制台 + GitHub(推荐,最省心)

1. 把本仓库推到 GitHub(只需 5 个文件:`index.html`、`styles.css`、`app.js`、`server.ts`、`deno.json`)。
2. 在控制台 **+ New App** → 选择仓库 → 构建配置:
   - **Framework Preset**:`No Preset`
   - **Runtime**:`Dynamic`
   - **Dynamic Entrypoint**:`server.ts`  ← 关键,别选 `app.js`
   - **Install Command / Build Command**:留空
3. 点击 **Create App**,自动构建并上线,控制台直接给出预览 / 生产 URL。

### 方式 B:CLI 直传(无需 GitHub)

```bash
# 首次会弹浏览器登录 console.deno.com
deno deploy create \
  --org <你的组织名> \
  --app web-app-launcher \
  --source local \
  --runtime-mode dynamic \
  --entrypoint server.ts \
  --region global

# 部署当前目录到生产
deno deploy --org <你的组织名> --app web-app-launcher --prod
```

> 注:`deno deploy` 子命令参数以上述为准,实际执行时如遇参数差异,以 `deno deploy --help` 输出为准。

## 常见坑

- **`ReferenceError: document is not defined`** → 部署入口点选错了。Deno Deploy 把你指定的入口当作**服务端进程**启动,而 `app.js` 是浏览器脚本(用到 `document`)。入口必须选 `server.ts`。
- **入口必须用 `Deno.serve()`** → 旧 `std/http` 的 `serve()` 在新平台会超时。本仓库已用 `Deno.serve(handler)`,无需改动。
- **不要把 `.workbuddy/` 传上去** → 里面是本地记忆数据,已写入 `.gitignore`。
