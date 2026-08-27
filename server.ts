// Deno 静态文件服务器 + API + WebSocket 信令 —— 同时用于本地运行与 Deno Deploy 部署
// 统一使用 node:http 单服务器：HTTP 静态资源、/api/* 路由、/ws 信令 同端口同源。
// 本地: deno task start   |   云端: 推送到 Git 后在 Deno Deploy 选本文件为入口
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import process from "node:process";

// 捕获 node 事件回调（如 ws 消息处理）中未捕获的异常，避免整个进程退出
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
import { handleApi } from "./api.ts";
import { initStore } from "./store.ts";
import { attachSignaling, getWsPublicUrl } from "./signaling.ts";
import { initChatStore } from "./chatstore.ts";
import { renderMarketplaceHtml } from "./marketplace_ssr.ts";

// 初始化 PostgreSQL 持久层：连接连接池并自动建表（幂等）。
// 若数据库暂不可用，服务器仍会启动并提供静态页面与聊天；认证/链接接口会返回 503，连接恢复后自动重试。
// 注意：初始化「非阻塞」——即使数据库此刻连不上（池化代理抖动/超时），服务器也照常启动并提供静态资源，
// 数据库恢复后 withClient 会在请求时自动重试重连。避免在 initStore 的长重试里卡住整个启动。
initStore().catch((e) => console.error("[store] 初始化失败（后台会随请求自动重试）：", (e as Error).message));
// 初始化聊天历史服务端存储（Deno KV，保留 3 个月）。不可用时降级，本地缓存仍工作。
initChatStore().catch((e) => console.error("[chatstore] 初始化失败：", (e as Error).message));

const ROOT = ".";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/typescript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function contentType(path: string): string {
  const i = path.lastIndexOf(".");
  const ext = i >= 0 ? path.slice(i).toLowerCase() : "";
  return MIME[ext] ?? "application/octet-stream";
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isFile;
  } catch {
    return false;
  }
}

async function serveStatic(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const safe = pathname.replace(/\.{2,}/g, "").replace(/^\/+/, "");
  const filePath = `${ROOT}/${safe}`;
  try {
    const stat = await Deno.stat(filePath);
    const target = stat.isDirectory ? `${filePath}/index.html` : filePath;
    const abs = await Deno.realPath(target);
    const rootAbs = await Deno.realPath(ROOT);
    if (!abs.startsWith(rootAbs)) {
      return new Response("403 Forbidden", { status: 403 });
    }

    // 传输压缩协商：构建脚本已为文本资源预生成 .br / .gz，
    // 客户端支持时直接发送对应文件（无需运行时压缩），否则回退到原文件。
    const acceptEnc = req.headers.get("accept-encoding") || "";
    let servedPath = abs;
    let contentEncoding: string | null = null;
    if (/br/i.test(acceptEnc) && (await fileExists(abs + ".br"))) {
      servedPath = abs + ".br";
      contentEncoding = "br";
    } else if (/gzip/i.test(acceptEnc) && (await fileExists(abs + ".gz"))) {
      servedPath = abs + ".gz";
      contentEncoding = "gzip";
    }
    const data = await Deno.readFile(servedPath);

    // 缓存策略：
    // ① 入口 HTML（含 ?meeting= 会议邀请链接）始终 no-cache，确保每次导航都能拿到引用最新资源版本的页面壳；
    // ② 带版本号（?v=）的静态资源（app.js?v=107 / styles.css?v=73 等）内容随版本号变化而稳定，
    //    可长期缓存（immutable），浏览器不再重复请求，版本号变更即换全新 URL 强制刷新；
    // ③ Service Worker 脚本（sw.js）必须 no-cache，否则其 1 小时缓存会延迟 SW 更新、导致新缓存逻辑不生效；
    // ④ 其余无版本资源保守缓存 1 小时。
    const headers: Record<string, string> = {
      "content-type": contentType(target),
      "vary": "Accept-Encoding",
    };
    if (contentEncoding) headers["content-encoding"] = contentEncoding;
    if (target.endsWith(".html") || pathname.endsWith("/sw.js")) {
      headers["cache-control"] = "no-cache";
      headers["pragma"] = "no-cache";
    } else {
      // 仅当 ?v= 是「内容哈希」（≥8 位十六进制，由构建脚本为 dist 产物生成）时
      // 才允许长期 immutable 缓存：内容变了哈希必变 → URL 必变 → 浏览器强制拉新。
      // 手写构建号（如 app.js?v=170）一旦被 immutable 缓存，改了源码也永不刷新，
      // 故这类资源一律 no-cache，保证本地开发 / 调试时改动即时生效、自愈。
      const vParam = url.searchParams.get("v");
      const isContentHash = vParam != null && /^[0-9a-f]{8,}$/i.test(vParam);
      if (isContentHash) {
        headers["cache-control"] = "public, max-age=31536000, immutable";
      } else {
        headers["cache-control"] = "no-cache";
        headers["pragma"] = "no-cache";
      }
    }
    return new Response(data, { headers });
  } catch {
    return new Response("404 Not Found", { status: 404 });
  }
}

// ---- Node http <-> Web Request/Response 适配 ----
async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host || "localhost";
  const url = `http://${host}${req.url || "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, v);
  }
  const method = req.method || "GET";
  let body: Uint8Array | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length) body = new Uint8Array(Buffer.concat(chunks));
  }
  return new Request(url, { method, headers, body });
}

async function writeWeb(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  const buf = new Uint8Array(await response.arrayBuffer());
  res.end(buf);
}

// 同源 favicon 代理：前端所有网站图标统一经此路径走 Service Worker「缓存优先」策略。
// 由服务端 fetch 目标站 /favicon.ico（规避跨域 CORS 与污染问题），仅 2xx 且为图片时返回字节并设置缓存头；
// 失败（网络错误 / 404 / 非图片）返回 4xx/5xx，SW 层据此不写缓存，下次仍会重新探测。
// 应用广场页面：对「广场」tab 做首屏服务端渲染（SSR）。数据库可用时直接注入已上架卡片，
// 数据库不可用时回退为原始模板（前端自行 loadPlaza 兜底）。
async function serveMarketplace(req: Request): Promise<Response> {
  try {
    const html = await renderMarketplaceHtml(req);
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "pragma": "no-cache",
      },
    });
  } catch (e) {
    console.error("[marketplace SSR] 渲染失败：", (e as Error).message);
    return new Response("500 Server Error", { status: 500 });
  }
}

async function serveFaviconProxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = url.searchParams.get("url");
  if (!target) return new Response("Bad Request", { status: 400 });
  let favUrl: string;
  try {
    // 允许传入完整 URL 或纯 origin；仅当路径为空或仅为「/」时才补 /favicon.ico
    // （注意：bare origin 的 pathname 是「/」，不能直接用 u.href，否则会取到主页 HTML 而非图标）
    const u = new URL(target);
    if (!/^https?:$/i.test(u.protocol)) return new Response("Bad Request", { status: 400 });
    const isRoot = !u.pathname || u.pathname === "/";
    favUrl = isRoot ? u.origin + "/favicon.ico" : u.href;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(favUrl, { signal: ac.signal, redirect: "follow" });
    if (!r.ok) return new Response("Not Found", { status: 404 });
    const ct = r.headers.get("content-type") || "";
    if (!/^image\//i.test(ct)) return new Response("Not Found", { status: 404 });
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 256 * 1024) return new Response("Payload Too Large", { status: 413 });
    return new Response(buf, {
      status: 200,
      headers: {
        "content-type": ct || "image/x-icon",
        "cache-control": "public, max-age=86400",
        "access-control-allow-origin": "*",
      },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

// 站点地图：列出对外可索引的页面，便于搜索引擎收录。
// 基础地址从请求 host 推导（本地与云端部署通用），无需硬编码域名。
// 新增对外页面时，只需往 SITEMAP_PATHS 追加 pathname 即可。
const SITEMAP_PATHS = ["/", "/marketplace.html"];
async function serveSitemap(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const host = url.host || "localhost";
  const origin = `${url.protocol}//${host}`;
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const items = SITEMAP_PATHS.map(
    (p) =>
      `  <url>\n    <loc>${esc(origin + p)}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>${p === "/" ? "1.0" : "0.8"}</priority>\n  </url>`,
  ).join("\n");
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>\n`;
  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

const server = createServer(async (req, res) => {
  try {
    const webReq = await toWebRequest(req);
    const url = new URL(webReq.url);
    let webRes: Response;
    if (url.pathname === "/favicon-proxy") webRes = await serveFaviconProxy(webReq);
    else if (url.pathname.startsWith("/api/")) webRes = await handleApi(webReq);
    else if (url.pathname === "/sitemap.xml") webRes = await serveSitemap(webReq);
    else if (url.pathname === "/marketplace.html") webRes = await serveMarketplace(webReq);
    else webRes = await serveStatic(webReq);
    await writeWeb(res, webRes);
  } catch (e) {
    console.error("request error:", (e as Error).message);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("500 Server Error");
  }
});

// 把 WebSocket 信令服务附着到同一个服务器（同端口同源）
attachSignaling(server);

const PORT = Number(Deno.env.get("PORT") || "8000");
// 监听双栈 "::"（IPv4+IPv6 共存），避免 localhost 解析到 ::1 时连不上/进程崩溃
server.listen(PORT, "::", () => {
  console.error(`🚀 Web 应用导航面板已启动：http://localhost:${PORT}/`);
});
