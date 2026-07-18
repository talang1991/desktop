// Deno 静态文件服务器 + API —— 同时用于本地运行与 Deno Deploy 部署
// 本地: deno task start   |   云端: 推送到 Git 后在 Deno Deploy 选本文件为入口
import { handleApi } from "./api.ts";
import { initDb } from "./db.ts";

// 启动时建表（users / links / sessions），缺表则自动创建
await initDb();

const ROOT = "."; // 站点根目录（与 index.html 同级）

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

  // 阻止路径穿越 + 限定在 ROOT 内
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
        // no-store：禁止浏览器/CDN 缓存，避免旧版 app.js 导致“点击没反应”
        "cache-control": "no-store",
        "pragma": "no-cache",
      },
    });
  } catch {
    return new Response("404 Not Found", { status: 404 });
  }
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) {
    return await handleApi(req);
  }
  return await serveStatic(req);
}

Deno.serve(handler);

console.log("🚀 Web 应用导航面板已启动");
