// Service Worker：对带版本号的静态资源（app.js?v=107 / styles.css?v=73 等）做 cache-first，
// 对页面导航（HTML 壳）做 network-first 并兜底离线缓存；/api/* 与 WebSocket 一律直通网络，绝不缓存。
// 注册地址固定为 /sw.js（不加 ?v=），由浏览器按字节差异自动检测更新。
const CACHE = "static-v1";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 预缓存页面壳，作为离线兜底；失败不阻塞安装
    await cache.addAll(["/"]).catch(() => {});
    // 顺带预缓存页面壳中引用的带版本号静态资源（app.js?v= / styles.css?v=），
    // 这样第二次加载起（页面已被 SW 控制）即可走 SW 缓存，离线也能打开应用
    try {
      const shell = await cache.match("/");
      if (shell) {
        const html = await shell.text();
        const urls = extractVersionedAssets(html);
        if (urls.length) await cache.addAll(urls).catch(() => {});
      }
    } catch (e) { /* 预缓存失败不影响安装 */ }
    await self.skipWaiting();
  })());
});

// 从 HTML 中提取 src/href 里带 ?v= 的资源地址（相对路径会按当前源解析）
function extractVersionedAssets(html) {
  const out = [];
  const re = /(?:src|href)=["']([^"']*\?v=[^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 删除旧版本的缓存命名空间
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    // 清理已不再被当前页面壳引用的旧 ?v= 资源，避免缓存无限增长
    await pruneStaleAssets(cache);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // 只处理 GET；POST 登录/API 等直通网络

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // 跨域资源不拦截
  if (url.pathname.startsWith("/api/")) return;        // API 直通网络，不缓存

  // 带版本号的静态资源：cache-first（命中即返回；未命中→网络取并写缓存，新版本号=新 URL 自动缓存）
  if (url.searchParams.has("v")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // 其余（页面导航 / 其他静态资源）：network-first，失败则回退缓存（离线壳）
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === "navigate") {
        const index = await caches.match("/");
        if (index) return index;
      }
      throw e;
    }
  })());
});

// 依据缓存的页面壳中实际引用的 ?v= 版本号，删除不再使用的旧资源
async function pruneStaleAssets(cache) {
  const keys = await cache.keys();
  if (!keys.length) return;
  const shell = await cache.match("/");
  const valid = new Set();
  if (shell) {
    const html = await shell.text();
    const re = /[?&]v=([^"'&]+)/g;
    let m;
    while ((m = re.exec(html))) valid.add(m[1]);
  }
  if (!valid.size) return; // 无壳可参考时不删，避免误清
  await Promise.all(keys.map(async (req) => {
    const u = new URL(req.url);
    if (u.searchParams.has("v") && !valid.has(u.searchParams.get("v"))) {
      await cache.delete(req);
    }
  }));
}
