// Service Worker：对带版本号的静态资源（app.js?v= / styles.css?v= 等）与 HTML 页面壳
// 统一采用「本端优先 / stale-while-revalidate」——先返回本地缓存、后台静默更新；
// 仅当网络返回 2xx 才写缓存（500 / 网络错误绝不缓存，保留旧值）。/api/* 与 WebSocket 一律直通网络。
// 注册地址固定为 /sw.js（不加 ?v=），由浏览器按字节差异自动检测更新。
const CACHE = "static-v1";
// SW 自身版本标记（仅用于前端探测“新 SW 是否已生效”，与页面部署版本无关）
const SW_SELF_VERSION = 5;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 预缓存页面壳（首页 + 应用广场 + 管理后台），作为离线兜底；失败不阻塞安装
    await cache.addAll(["/", "/marketplace.html", "/admin.html"]).catch(() => {});
    // 记录安装时首页页面壳的版本号，供页面后续主动查询
    try {
      const shell = await cache.match("/");
      if (shell) {
        const v = extractMainVersion(await shell.text(), "/");
        if (v) await saveHtmlVersion(cache, "/", v);
      }
    } catch (e) {}
    // 预缓存页面壳中引用的带版本号静态资源（app.js?v= / marketplace.js?v= / styles.css?v= 等），
    // 这样 SW 控制后即使从未访问过广场，也能走本地缓存（离线也可打开）
    try {
      const assets = new Set();
      for (const path of ["/", "/marketplace.html"]) {
        const shell = await cache.match(path);
        if (shell) extractVersionedAssets(await shell.text()).forEach((u) => assets.add(u));
      }
      if (assets.size) await cache.addAll([...assets]).catch(() => {});
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

// 各页面壳的主脚本（用作“部署版本标识”的版本号来源）：首页=app.js，广场=marketplace.js，后台=admin.js
function mainScriptFor(pathname) {
  if (pathname === "/marketplace.html") return "marketplace.js";
  if (pathname === "/admin.html") return "admin.js";
  return "app.js";
}
// 从 HTML 中提取“主脚本”的版本号（?v=）作为该页面的部署版本标识；找不到返回 null。
// 这样应用广场 / 管理后台页面也能被 SW 正确识别版本变化（不再只认 app.js）。
function extractMainVersion(html, pathname) {
  const name = mainScriptFor(pathname).replace(/\./g, "\\.");
  const m = new RegExp(name + "\\?(?:[^&\"'\\s>]*&)?v=([^&\"'\\s>]+)", "i").exec(html || "");
  if (m) return m[1];
  // 兜底：取页面中出现的第一个 ?v= 资源版本
  const any = /[?&]v=([^"'\s>&]+)/.exec(html || "");
  return any ? any[1] : null;
}

// sw-meta 存储“各页面壳最新版本”映射：{ "/": "156", "/marketplace.html": "10", "/admin.html": "5" }
// 这样广场 / 后台页面各自维护独立版本，互不干扰（不再只有一个全局 htmlVersion）。
async function saveHtmlVersion(cache, path, ver) {
  try {
    let map = {};
    const m = await cache.match("sw-meta");
    if (m) { try { map = (await m.json()) || {}; } catch (e) {} }
    if (ver) map[path] = ver; else delete map[path];
    await cache.put("sw-meta", new Response(JSON.stringify(map)));
  } catch (e) {}
}
async function loadHtmlVersion(cache, path) {
  try {
    const m = await cache.match("sw-meta");
    if (m) { const j = await m.json(); if (path) return (j && j[path]) || null; return j || {}; }
  } catch (e) {}
  return path ? null : {};
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
    // 通知已被控制的页面：新 SW 已生效，并附带各页面壳最新版本（前端据此判定是否需提示更新）
    const verMap = await loadHtmlVersion(cache);
    const cls = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of cls) c.postMessage({ type: "SW_READY", version: SW_SELF_VERSION, htmlVersion: (verMap && verMap["/"]) || null, versions: verMap || {} });
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
  // favicon 代理：前端所有网站图标经同源 /favicon-proxy 走缓存优先（独立缓存命名空间，避免与静态资源混用）
  const isFavicon = pathname === "/favicon-proxy";
  // 本端优先（cache-first / stale-while-revalidate）：版本化静态资源 + HTML 页面壳 + favicon 代理
  const cacheFirst = url.searchParams.has("v") || isHtmlShell || isFavicon;

  if (cacheFirst) {
    event.respondWith((async () => {
      const cache = await caches.open(isFavicon ? "favicons-v1" : CACHE);
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
              const freshVer = extractMainVersion(freshHtml, pathname);
              if (freshVer) {
                await saveHtmlVersion(cache, pathname, freshVer); // 记录该页面壳最新版本，供页面主动查询
                let servedVer = null;
                if (cached) servedVer = extractMainVersion(await cached.clone().text(), pathname);
                if (servedVer && servedVer !== freshVer) {
                  // 带上 url，让“对应页面”而非所有页面弹出更新提示
                  const cls = await self.clients.matchAll({ includeUncontrolled: true });
                  for (const c of cls) c.postMessage({ type: "SW_VERSION_UPDATE", url: pathname, version: freshVer });
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
  // 页面“立即刷新”：让等待中的新 SW 立刻生效
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  // 页面“立即刷新”：清掉当前页 HTML 壳缓存（含 "/"），保证下一次导航直连网络拿最新 HTML
  if (data.type === "CLEAR_HTML") {
    caches.open(CACHE).then((cache) => {
      const url = data.url || "/";
      cache.delete(url, { ignoreSearch: false }).catch(() => {});
      cache.delete("/", { ignoreSearch: false }).catch(() => {});
    }).catch(() => {});
    return;
  }
  if (data.type === "QUERY_HTML_VERSION") {
    // 直接问服务端拿“发起查询的页面自身”的最新 HTML 版本（network-first，绕过本端缓存），
    // 彻底消除“本端优先返回旧缓存、后台 revalidation 尚未完成”导致的竞态；广场 / 后台页面各自查各自。
    // 仅在服务端不可用 / 无版本时回退到缓存元数据（sw-meta）中该页面的版本。
    const url = data.url ? data.url : "/";
    const full = url.startsWith("http") ? url : (self.location.origin + url);
    const reply = (v) => { if (event.source && v) event.source.postMessage({ type: "HTML_VERSION", version: v }); };
    fetch(full, { cache: "no-store" })
      .then((r) => (r && r.ok ? r.text() : Promise.reject()))
      .then((html) => { const v = extractMainVersion(html, new URL(full).pathname); if (v) reply(v); else throw new Error("no-ver"); })
      .catch(() => caches.open(CACHE).then(async (c) => reply(await loadHtmlVersion(c, new URL(full).pathname))));
  }
});

// 依据缓存的页面壳中实际引用的 ?v= 版本号，删除不再使用的旧资源
async function pruneStaleAssets(cache) {
  const keys = await cache.keys();
  if (!keys.length) return;
  // 同时参考首页、应用广场、管理后台三个页面壳，避免误删任一页面引用的 ?v= 资源
  //（如 marketplace.js?v= 或 admin.js?v=；admin.html 若不在此列表，其 admin.js 会被误删）
  const shells = ["/", "/marketplace.html", "/admin.html"];
  const valid = new Set();
  for (const s of shells) {
    const shell = await cache.match(s);
    if (shell) {
      const html = await shell.text();
      const re = /[?&]v=([^"'&]+)/g;
      let m;
      while ((m = re.exec(html))) valid.add(m[1]);
    }
  }
  if (!valid.size) return; // 无壳可参考时不删，避免误清
  await Promise.all(keys.map(async (req) => {
    const u = new URL(req.url);
    if (u.searchParams.has("v") && !valid.has(u.searchParams.get("v"))) {
      await cache.delete(req);
    }
  }));
}

// ---------- 系统通知：点击处理 ----------
// 页面（隐藏态）通过 registration.showNotification 弹出来电 / 新消息提醒；
// 用户点击通知主体或通知上的「接听 / 拒绝」按钮时，在这里聚焦回应用，并把来电动作回传页面。
self.addEventListener("notificationclick", (event) => {
  const data = (event.notification && event.notification.data) || {};
  event.notification.close();
  const action = event.action || ""; // ""（点击主体）| "accept" | "reject"
  event.waitUntil((async () => {
    const cls = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // 优先聚焦已存在的窗口；否则打开应用首页
    let client = null;
    for (const c of cls) { if (c.focused) { client = c; break; } }
    if (!client && cls.length) client = cls[0];
    if (client) {
      await client.focus();
      if (action === "accept" || action === "reject") {
        // 来电「接听 / 拒绝」按钮：转交页面通话模块处理
        try { client.postMessage({ type: "NOTIFY_CALL_ACTION", action }); } catch (e) {}
      } else if (data.kind === "call") {
        // 点击来电通知主体：仅聚焦回应用，不自动接听（避免误接）
        try { client.postMessage({ type: "NOTIFY_CALL_FOCUS", kind: "call" }); } catch (e) {}
      }
    } else {
      await self.clients.openWindow("/");
    }
  })());
});
