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

// 初始化本地存储：读取本地 data.json（快），并“尽力”从 PostgreSQL 导入已有数据（最多 5s）。
// 即使 PostgreSQL 连不上，本地存储照常工作，应用 100% 可用。
await initStore();

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
};

function contentType(path: string): string {
  const i = path.lastIndexOf(".");
  const ext = i >= 0 ? path.slice(i).toLowerCase() : "";
  return MIME[ext] ?? "application/octet-stream";
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
    const data = await Deno.readFile(abs);
    return new Response(data, {
      headers: {
        "content-type": contentType(target),
        "cache-control": "no-store",
        "pragma": "no-cache",
      },
    });
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

const server = createServer(async (req, res) => {
  try {
    const webReq = await toWebRequest(req);
    const url = new URL(webReq.url);
    const webRes = url.pathname.startsWith("/api/") ? await handleApi(webReq) : await serveStatic(webReq);
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
