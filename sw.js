// Service Worker：对带版本号的静态资源（app.js?v= / styles.css?v= 等）与 HTML 页面壳
// 统一采用「本端优先 / stale-while-revalidate」——先返回本地缓存、后台静默更新；
// 仅当网络返回 2xx 才写缓存（500 / 网络错误绝不缓存，保留旧值）。/api/* 与 WebSocket 一律直通网络。
// 注册地址固定为 /sw.js（不加 ?v=），由浏览器按字节差异自动检测更新。
const CACHE = "static-v1";
// SW 自身版本标记（仅用于前端探测“新 SW 是否已生效”，与页面部署版本无关）
const SW_SELF_VERSION = 2;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 预缓存页面壳，作为离线兜底；失败不阻塞安装
    await cache.addAll(["/"]).catch(() => {});
    // 记录安装时页面壳的版本号，供页面后续主动查询
    try {
      const shell = await cache.match("/");
      if (shell) {
        const v = extractAppVersion(await shell.text());
        if (v) await saveHtmlVersion(cache, v);
      }
    } catch (e) {}
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

// 从 HTML 中提取 app.js 的版本号（?v=），作为“部署版本标识”；找不到返回 null
function extractAppVersion(html) {
  const m = /app\.js\?(?:[^"'&]*&)?v=([^"'&]+)/i.exec(html || "");
  return m ? m[1] : null;
}

// 把最近一次成功拉取到的 HTML 版本号存入缓存元数据，供页面在“本端优先”返回旧缓存后主动查询，
// 避免因 SW 通知早于页面监听而漏掉版本更新。
async function saveHtmlVersion(cache, ver) {
  try { await cache.put("sw-meta", new Response(JSON.stringify({ htmlVersion: ver }))); } catch (e) {}
}
async function loadHtmlVersion(cache) {
  try {
    const m = await cache.match("sw-meta");
    if (m) { const j = await m.json(); return j.htmlVersion || null; }
  } catch (e) {}
  return null;
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
    // 通知已被控制的页面：新 SW 已生效，并附带当前已知的最新 HTML 版本（前端据此判定是否需提示更新）
    const htmlVer = await loadHtmlVersion(cache);
    const cls = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of cls) c.postMessage({ type: "SW_READY", version: SW_SELF_VERSION, htmlVersion: htmlVer });
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // 只处理 GET；POST 登录/API 等直通网络

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // 跨域资源不拦截
  if (url.pathname.startsWith("/api/")) return;        // API 直通网络，不缓存

  const pathname = url.pathname;
  const isHtmlShell = req.mode === "navigate" || pathname === "/" || pathname.endsWith("/index.html");
  // 本端优先（cache-first / stale-while-revalidate）：版本化静态资源 + HTML 页面壳
  const cacheFirst = url.searchParams.has("v") || isHtmlShell;

  if (cacheFirst) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      // 后台静默更新缓存；仅 2xx 才写缓存（500 / 网络错误保留旧值）。
      // HTML 页面壳后台更新时，若发现版本号（app.js?v=）变化，立即通知已打开的页面弹出
      // “版本更新”提示，避免用户停留在旧版本、必须等下一次导航才被发现。
      const network = fetch(req).then(async (res) => {
        if (res && res.ok) {
          cache.put(req, res.clone());
          if (isHtmlShell) {
            try {
              const freshHtml = await res.clone().text();
              const freshVer = extractAppVersion(freshHtml);
              if (freshVer) {
                await saveHtmlVersion(cache, freshVer); // 记录最新服务端版本，供页面主动查询
                let servedVer = null;
                if (cached) servedVer = extractAppVersion(await cached.clone().text());
                if (servedVer && servedVer !== freshVer) {
                  const cls = await self.clients.matchAll({ includeUncontrolled: true });
                  for (const c of cls) c.postMessage({ type: "SW_VERSION_UPDATE", version: freshVer });
                }
              }
            } catch (e) { /* 解析/通知失败不影响返回 */ }
          }
        }
        return res;
      }).catch(() => null);
      if (cached) {
        event.waitUntil(network); // 扩展事件生命周期，确保后台更新完成（不阻塞首屏响应）
        return cached;            // 本端优先：先返回本地缓存
      }
      const res = await network;
      if (res) return res;
      // 无缓存且网络失败：导航请求回退离线壳
      if (req.mode === "navigate") {
        const index = await cache.match("/");
        if (index) return index;
      }
      return new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
    })());
    return;
  }

  // 其余非版本化资源：network-first，成功（2xx）则顺手缓存（同样不缓存 500）
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
      throw e;
    }
  })());
});

// 页面查询“服务端最新 HTML 版本”：用于修复 SW 主动通知可能早于页面监听的竞态，
// 页面在监听就绪后主动问一次，SW 把缓存元数据里的最新版本回传。
self.addEventListener("message", (event) => {
  const data = (event && event.data) || {};
  if (data.type === "QUERY_HTML_VERSION") {
    caches.open(CACHE).then(async (cache) => {
      const v = await loadHtmlVersion(cache);
      if (event.source && v) event.source.postMessage({ type: "HTML_VERSION", version: v });
    });
  }
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
