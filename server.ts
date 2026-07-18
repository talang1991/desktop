// Deno 静态文件服务器 —— 同时用于本地运行与 Deno Deploy 部署
// 本地: deno task start
// 云端: 推送到 Git 后在 Deno Deploy 选择本文件为入口

const PORT = Number(Deno.env.get("PORT") ?? 8000);
const ROOT = "."; // 站点根目录（与 index.html 同级）
// 注意：Deno Deploy 由平台接管端口，本地默认 8000，无需显式绑定。

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
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

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  // 阻止路径穿越：剥离 .. 与多余斜杠
  const safe = pathname.replace(/\.{2,}/g, "").replace(/^\/+/, "");
  const filePath = `${ROOT}/${safe}`;

  try {
    const stat = await Deno.stat(filePath);
    const target = stat.isDirectory ? `${filePath}/index.html` : filePath;
    // realPath 解析符号链接与 ..，确保最终路径仍在 ROOT 之内
    const abs = await Deno.realPath(target);
    const rootAbs = await Deno.realPath(ROOT);
    if (!abs.startsWith(rootAbs)) {
      return new Response("403 Forbidden", { status: 403 });
    }
    const data = await Deno.readFile(abs);
    return new Response(data, {
      headers: {
        "content-type": contentType(target),
        "cache-control": "no-cache",
      },
    });
  } catch {
    return new Response("404 Not Found", { status: 404 });
  }
}

Deno.serve(handler);

console.log(`🚀 Web 应用导航面板已启动: http://localhost:${PORT}`);
