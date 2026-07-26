/* Web 应用导航面板 —— 后端 API 驱动，数据存 PostgreSQL */
(function () {
  "use strict";

  const THEME_KEY = "web-app-launcher:theme";
  const TOKEN_KEY = "web-app-launcher:token";
  const COLORS = [
    "#4f6ef7", "#e5484d", "#12a594", "#f5a623",
    "#9b5de5", "#f15bb5", "#00bbf9", "#8ac926",
  ];

  /** @type {Array<{id:number,name:string,url:string,category?:string,emoji?:string,color:string,openNew:boolean,openMode?:'new'|'self'|'iframe',createdAt:number}>} */
  let apps = [];
  let activeCategory = "全部";
  let searchTerm = "";
  let editingId = null;
  let selectedColor = COLORS[0];
  let currentUsername = "";
  let myAvatar = "";

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const grid = $("#appGrid");
  const emptyState = $("#emptyState");
  const appCount = $("#appCount");
  const filtersEl = $("#categoryFilters");
  const searchInput = $("#searchInput");
  const modal = $("#modal");
  const modalTitle = $("#modalTitle");
  const form = $("#appForm");
  const colorRow = $("#colorRow");
  const categoryList = $("#categoryList");
  const profileModal = $("#profileModal");

  // ---------- API ----------
  async function api(path, opts = {}) {
    const headers = { "content-type": "application/json" };
    const tk = localStorage.getItem(TOKEN_KEY);
    if (tk) headers["authorization"] = "Bearer " + tk;
    let res;
    try {
      res = await fetch(path, {
        headers,
        ...opts,
      });
    } catch {
      throw new Error("网络请求失败，请确认服务已启动（本地应为 http://localhost:8000）");
    }
    if (res.status === 401 && path !== "/api/me") {
      showAuth();
      throw new Error("会话已失效，请重新登录");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  // ---------- 链接：本地缓存优先 + 服务端同步 ----------
  function genTempId() {
    const u = (crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + "_" + Math.random().toString(16).slice(2));
    return "tmp_" + u;
  }

  // 从本地 IndexedDB 重新载入当前用户的链接并刷新界面（同步内存 apps）
  async function refreshApps() {
    if (currentUserId == null) return;
    apps = await LinkDB.allByUser(currentUserId);
    renderAll();
  }

  // 进入应用 / 需要展示链接时调用：先秒开本地缓存，再后台与服务器对齐
  async function loadLinks() {
    if (currentUserId == null) { apps = []; renderAll(); return; }
    const local = await LinkDB.allByUser(currentUserId);
    apps = local;
    renderAll();
    await syncLinks();
  }

  // 与服务器对齐：以服务端为准重写缓存，并保留本地离线产生的待同步记录，
  // 最后把离线操作补推到服务端（断网恢复时也走这里）。
  async function syncLinks() {
    if (currentUserId == null) return;
    let serverLinks = [];
    try {
      const data = await api("/api/links");
      serverLinks = data.links || [];
    } catch (e) {
      // 离线：保留本地缓存即可（apps 已是本地数据），稍后 online 事件会重试
      return;
    }
    const serverIds = new Set(serverLinks.map((l) => Number(l.id)));
    const local = await LinkDB.allByUser(currentUserId);
    const pending = local.filter((l) => l.synced === false); // 离线新建 / 待更新 / 待删除
    // 整库重写：先清当前用户缓存，再写入服务端权威数据
    await LinkDB.clearByUser(currentUserId);
    const serverRecs = serverLinks.map((l) => ({ ...l, userId: currentUserId, synced: true }));
    await LinkDB.putMany(serverRecs);
    // 把离线产生的待同步记录重新并入（不会被服务端数据覆盖）
    for (const p of pending) {
      if (p._tombstone) {
        await LinkDB.put(p);                       // 待删除：保留墓碑，flush 时重试 DELETE
      } else if (String(p.id).startsWith("tmp_")) {
        await LinkDB.put(p);                       // 离线新建：尚未拿到服务端 id，保留
      } else if (p.op === "update" && serverIds.has(Number(p.id))) {
        await LinkDB.put(p);                       // 待更新且服务端仍在：保留本地编辑
      }
      // 其余（服务端已不存在的待更新）直接丢弃，避免脏数据
    }
    apps = await LinkDB.allByUser(currentUserId);
    renderAll();
    // 联网了：把离线操作补推到服务端
    await flushPendingLinks();
  }

  // 把本地未同步（synced=false）的记录补推到服务端
  async function flushPendingLinks() {
    if (currentUserId == null) return;
    const local = await LinkDB.allByUser(currentUserId);
    const pending = local.filter((l) => l.synced === false);
    for (const l of pending) {
      try {
        if (l._tombstone || l.op === "delete") {
          await api("/api/links/" + l.id, { method: "DELETE" });
          await LinkDB.delete(l.id);
        } else if (String(l.id).startsWith("tmp_") || l.op === "create") {
          const obj = { name: l.name, url: l.url, category: l.category, emoji: l.emoji, color: l.color, openNew: l.openNew, openMode: l.openMode };
          const data = await api("/api/links", { method: "POST", body: JSON.stringify(obj) });
          await LinkDB.delete(l.id);
          await LinkDB.put({ ...data.link, userId: currentUserId, synced: true });
        } else if (l.op === "update") {
          const obj = { name: l.name, url: l.url, category: l.category, emoji: l.emoji, color: l.color, openNew: l.openNew, openMode: l.openMode };
          const data = await api("/api/links/" + l.id, { method: "PUT", body: JSON.stringify(obj) });
          await LinkDB.put({ ...data.link, userId: currentUserId, synced: true });
        }
      } catch (e) {
        // 仍未成功（如再次断网）：保留 synced=false，下次 syncLinks 重试
        continue;
      }
    }
    // flush 后可能有数据变化（临时 id 转正 / 墓碑清除），刷新内存与界面
    apps = await LinkDB.allByUser(currentUserId);
    renderAll();
  }

  // 新建（离线友好）：先落本地，再尝试推服务端；失败则作为离线待同步保留
  async function createLinkLocal(payload) {
    const rec = {
      id: genTempId(), userId: currentUserId, synced: false, op: "create",
      name: payload.name, url: payload.url,
      category: payload.category || "未分类",
      emoji: payload.emoji || "", color: payload.color,
      openNew: payload.openNew !== false,
      openMode: payload.openMode || "new",
      createdAt: Date.now(),
    };
    await LinkDB.put(rec);
    await refreshApps();
    try {
      const obj = { name: rec.name, url: rec.url, category: rec.category, emoji: rec.emoji, color: rec.color, openNew: rec.openNew, openMode: rec.openMode };
      const data = await api("/api/links", { method: "POST", body: JSON.stringify(obj) });
      await LinkDB.delete(rec.id);
      await LinkDB.put({ ...data.link, userId: currentUserId, synced: true });
      await refreshApps();
    } catch (e) {
      toast("已离线保存，联网后自动同步");
    }
  }

  // 更新（离线友好）：本地立即更新，再推服务端；离线新建项仍按 create 处理
  async function updateLinkLocal(id, payload) {
    const existing = await LinkDB.get(id);
    if (!existing) return;
    const isTemp = String(id).startsWith("tmp_");
    const merged = { ...existing, ...payload, synced: false, op: isTemp ? "create" : "update" };
    await LinkDB.put(merged);
    await refreshApps();
    try {
      const obj = { name: merged.name, url: merged.url, category: merged.category, emoji: merged.emoji, color: merged.color, openNew: merged.openNew, openMode: merged.openMode };
      if (isTemp) {
        const data = await api("/api/links", { method: "POST", body: JSON.stringify(obj) });
        await LinkDB.delete(id);
        await LinkDB.put({ ...data.link, userId: currentUserId, synced: true });
      } else {
        const data = await api("/api/links/" + id, { method: "PUT", body: JSON.stringify(obj) });
        await LinkDB.put({ ...data.link, userId: currentUserId, synced: true });
      }
      await refreshApps();
    } catch (e) {
      toast("已离线保存，联网后自动同步");
    }
  }

  // 删除（离线友好）：本地立即移除；服务端删除失败则保留墓碑，联网后重试
  async function deleteLinkLocal(id) {
    const existing = await LinkDB.get(id);
    const isTemp = String(id).startsWith("tmp_");
    await LinkDB.delete(id);
    await refreshApps();
    if (isTemp || !existing) return; // 从未同步到服务端，无需 DELETE
    try {
      await api("/api/links/" + id, { method: "DELETE" });
    } catch (e) {
      await LinkDB.put({ id, userId: currentUserId, synced: false, op: "delete", _tombstone: true });
      toast("已离线删除，联网后同步");
    }
  }

  // ---------- 登录态 ----------
  function showAuth() {
    $("#appView").hidden = true;
    $("#authView").hidden = false;
    apps = [];
    clearAuthError();
  }
  async function enterApp(user) {
    $("#authView").hidden = true;
    $("#appView").hidden = false;
    currentUsername = user.username;
    currentUserId = user.id;
    myAvatar = user.avatar || "";
    $("#userName").textContent = user.username;
    renderAvatarInto($("#userAvatar"), myAvatar, (user.username || "?").charAt(0).toUpperCase());
    await loadLinks();
    // 登录即建立持久信令连接（标记为在线 + 接收好友在线状态），断线会自动重连
    sigStopReconnect = false;
    connectSignaling();
    await loadUnread();
    await loadGroupUnread();
    updateUnreadTitle();
    loadConversations();      // 读取本地保存的会话顺序
    loadFriends();
    loadGroups();
    // 兜底：登录后稍作延迟再补算一次离线未读，避免信令 welcome 晚到导致红点漏算
    setTimeout(() => { trySyncAll(); syncAllGroupUnread(); }, 1500);
  }
  async function checkAuth() {
    try {
      const { user } = await api("/api/me");
      if (user) await enterApp(user);
      else showAuth();
    } catch {
      showAuth();
    }
  }
  function showAuthError(msg) {
    const el = $("#authError");
    el.textContent = msg;
    el.hidden = false;
  }
  function clearAuthError() {
    $("#authError").hidden = true;
  }

  // ---------- Helpers ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function hostnameOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch (e) { return url; }
  }
  function faviconUrl(url) {
    try { return new URL(url).origin + "/favicon.ico"; }
    catch (e) { return ""; }
  }
  // 图标字段可存 emoji，也可存 favicon 链接（http(s)/相对路径/data:image）
  function isIconUrl(s) {
    return !!s && /^(https?:\/\/|\/|data:image\/)/i.test(String(s).trim());
  }
  function fallbackChar(url) {
    return (hostnameOf(url).charAt(0) || "?").toUpperCase();
  }
  // 渲染头像：emoji 文本 / 图片链接 / 兜底首字母
  function renderAvatar(val, fallback) {
    const v = val || "";
    if (isIconUrl(v)) {
      return `<img src="${escapeHtml(v)}" alt="" onerror="this.style.display='none';this.parentNode.textContent='${escapeHtml((fallback || "?").toString().charAt(0).toUpperCase())}'"/>`;
    }
    if (v) return escapeHtml(v);
    return escapeHtml((fallback || "?").toString().charAt(0).toUpperCase());
  }
  function renderAvatarInto(el, val, fallback) {
    if (!el) return;
    el.innerHTML = renderAvatar(val, fallback);
  }

  // ---------- Render ----------
  function renderCategories() {
    const cats = ["全部", ...Array.from(new Set(apps.map((a) => a.category || "未分类").filter(Boolean)))];
    filtersEl.innerHTML = "";
    cats.forEach((cat) => {
      const b = document.createElement("button");
      b.className = "chip" + (cat === activeCategory ? " active" : "");
      b.textContent = cat;
      b.onclick = () => { activeCategory = cat; renderCategories(); renderGrid(); };
      filtersEl.appendChild(b);
    });

    categoryList.innerHTML = "";
    Array.from(new Set(apps.map((a) => a.category).filter(Boolean))).forEach((c) => {
      const o = document.createElement("option");
      o.value = c;
      categoryList.appendChild(o);
    });
  }

  function renderGrid() {
    const term = searchTerm.trim().toLowerCase();
    const filtered = apps.filter((a) => {
      const matchCat = activeCategory === "全部" || (a.category || "未分类") === activeCategory;
      const matchTerm = !term ||
        a.name.toLowerCase().includes(term) ||
        a.url.toLowerCase().includes(term);
      return matchCat && matchTerm;
    });

    appCount.textContent = `${apps.length} 个应用` + (apps.length !== filtered.length ? `（显示 ${filtered.length}）` : "");
    grid.innerHTML = "";

    if (filtered.length === 0) {
      emptyState.hidden = false;
      emptyState.querySelector("h2").textContent = apps.length === 0 ? "还没有应用" : "没有匹配的应用";
      emptyState.querySelector("p").textContent = apps.length === 0
        ? "点击右上角「＋ 添加应用」开始收集你的常用网站。"
        : "试试更换分类或搜索关键词。";
      return;
    }
    emptyState.hidden = true;

    filtered.forEach((a) => {
      const card = document.createElement("a");
      card.className = "card";
      card.href = a.url;
      const aMode = a.openMode || (a.openNew === false ? "self" : "new");
      // 内嵌模式：链接仍保留 href 以便中键/组合键在新标签打开，普通左键交给 openApp 处理
      card.target = aMode === "iframe" ? "_self" : (a.openNew === false ? "_self" : "_blank");
      card.rel = "noopener noreferrer";
      card.title = a.url;

      const iconVal = a.emoji || "";
      let iconHtml;
      if (isIconUrl(iconVal)) {
        // 自定义 favicon 链接
        iconHtml =
          `<div class="icon" style="background:${a.color}22"><img src="${escapeHtml(iconVal)}" alt="" ` +
          `onerror="this.style.display='none';this.parentNode.textContent='${escapeHtml(fallbackChar(a.url))}'"/></div>`;
      } else if (iconVal) {
        // emoji 文本
        iconHtml = `<div class="icon" style="background:${a.color}22">${escapeHtml(iconVal)}</div>`;
      } else {
        // 未设置 -> 用网站默认 favicon
        iconHtml =
          `<div class="icon" style="background:${a.color}22"><img src="${escapeHtml(faviconUrl(a.url))}" alt="" ` +
          `onerror="this.style.display='none';this.parentNode.textContent='${escapeHtml(fallbackChar(a.url))}'"/></div>`;
      }

      card.innerHTML = `
        ${a.category ? `<span class="cat-tag">${escapeHtml(a.category)}</span>` : ""}
        <button class="card-menu" title="更多操作" data-menu="${a.id}">⋯</button>
        ${iconHtml}
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="url">${escapeHtml(hostnameOf(a.url))}</div>
      `;

      card.addEventListener("click", (e) => {
        if (e.target.closest(".card-menu")) { e.preventDefault(); return; }
        // 普通左键（非组合键）走 openApp，支持「内嵌窗口」等打开方式
        if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          openApp(a);
        }
      });
      card.querySelector(".card-menu").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(a.id, e.clientX, e.clientY);
      });

      grid.appendChild(card);
    });
  }

  function renderAll() {
    renderCategories();
    renderGrid();
  }

  // ---------- 打开方式（新标签 / 本窗口 / 内嵌 iframe）----------
  function openApp(a) {
    const mode = a.openMode || (a.openNew === false ? "self" : "new");
    if (mode === "iframe") openIframe(a.url, a.name);
    else if (mode === "self") window.open(a.url, "_self");
    else window.open(a.url, "_blank");
  }
  // ---------- 内嵌 iframe 查看器（多页面常驻；最多两个并排分屏）----------
  const IFRAME_MIN_W = 360; // 单个内嵌页最小宽度
  let iframeActive = [];    // 当前“打开中”的页面（最多 2 个，用于左右分屏）
  let splitRatio = 0.5;     // 分屏时分隔条位置（0~1，左边占比）
  let dividerEl = null;     // 分屏分隔条
  let iframeDragPage = null; // 当前正被拖拽的页面（拖到屏幕另一侧重分屏）
  let iframeDockHidden = localStorage.getItem("iframeDockHidden") === "1"; // 内嵌栏（最小化卡片）是否收起
  function updateDockVisibility() {
    const dock = $("#iframeDock");
    if (!dock) return;
    dock.hidden = dock.querySelectorAll(".iframe-page").length === 0;
  }
  // 收起/展开底部那排最小化卡片（不影响激活/分屏页）
  function applyDockHidden() {
    const dock = $("#iframeDock");
    if (!dock) return;
    dock.classList.toggle("dock-hidden", iframeDockHidden);
    const t = $("#iframeDockToggle");
    if (t) t.textContent = iframeDockHidden ? "显示内嵌栏 ▴" : "隐藏内嵌栏 ▾";
  }
  function toggleDockHidden() {
    iframeDockHidden = !iframeDockHidden;
    localStorage.setItem("iframeDockHidden", iframeDockHidden ? "1" : "0");
    applyDockHidden();
  }
  function closeIframePage(page) {
    if (!page) return;
    const i = iframeActive.indexOf(page);
    if (i >= 0) iframeActive.splice(i, 1);
    page.remove(); // iframe 随节点移除而卸载
    layoutIframePages();
  }
  function syncIframePageButtons(page) {
    if (!page) return;
    const maxBtn = page.querySelector(".iframe-max");
    const minBtn = page.querySelector(".iframe-min");
    const inActive = iframeActive.includes(page);
    const isFullSole = inActive && iframeActive.length === 1 && !page.classList.contains("half");
    const isHalf = inActive && page.classList.contains("half");
    const isSplit = inActive && iframeActive.length === 2;
    // 最小化按钮：打开中（单页/半屏/分屏）显示，卡片态由 CSS 隐藏，始终表示“最小化/收起（—）”
    if (minBtn) { minBtn.textContent = "—"; minBtn.title = "最小化"; }
    // 最大化按钮：单页全屏隐藏（CSS）；半屏/分屏显示“最大化/铺满”；卡片显示“打开”
    if (maxBtn) {
      if (isFullSole) { /* 单页全屏由 CSS 隐藏，无需设置 */ }
      else if (isHalf) { maxBtn.textContent = "□"; maxBtn.title = "最大化（铺满）"; }
      else if (isSplit) { maxBtn.textContent = "□"; maxBtn.title = "最大化当前页"; }
      else { maxBtn.textContent = "□"; maxBtn.title = "打开"; } // 卡片态
    }
  }
  // 根据当前活动页集合重新布局：0=仅卡片；1=单页全屏 或 半屏（dock 还有其它页时）；2=左右分屏
  function layoutIframePages() {
    const dock = $("#iframeDock");
    if (!dock) return;
    const pages = [...dock.querySelectorAll(".iframe-page")];
    const n = iframeActive.length;
    const chatOpen = document.body.classList.contains("chat-open");
    const chatW = chatOpen ? Math.min(560, window.innerWidth) : 0;
    const avail = window.innerWidth - chatW;
    // 清空所有页面定位/状态类，下一步按需重新设置
    pages.forEach((p) => {
      p.classList.remove("active", "split", "half");
      p.style.left = ""; p.style.right = "";
      p._wasSplit = false;
    });
    if (n === 1) {
      const p = iframeActive[0];
      const total = pages.length;
      if (total >= 2 && !p._forceFull) {
        // 半屏态：占据一侧（左半），留出空区域，dock 仍可见，便于打开另一页凑分屏
        p.classList.add("active", "half");
        p._wasSplit = true;
        const D = Math.max(IFRAME_MIN_W, Math.min(splitRatio * avail, avail - IFRAME_MIN_W));
        p.style.left = "0px";
        p.style.right = Math.max(window.innerWidth - D, chatW) + "px";
      } else {
        // 单页全屏：清除内联定位，由 CSS 的 inset:0 控制
        p.classList.add("active");
      }
    } else if (n === 2) {
      const L = iframeActive[0], R = iframeActive[1];
      [L, R].forEach((x) => { x.classList.add("active", "split"); x._forceFull = false; x._wasSplit = true; });
      const D = Math.max(IFRAME_MIN_W, Math.min(splitRatio * avail, avail - IFRAME_MIN_W));
      L.style.left = "0px";
      L.style.right = (window.innerWidth - D) + "px";
      R.style.left = D + "px";
      R.style.right = chatW + "px";
      if (dividerEl) { dividerEl.style.display = "block"; dividerEl.style.left = D + "px"; }
    }
    if (n !== 2 && dividerEl) dividerEl.style.display = "none";
    // 对所有页面（含已最小化的卡片）统一同步按钮图标，避免状态与图标错位
    pages.forEach((p) => syncIframePageButtons(p));
    updateDockVisibility();
  }
  function maximizeIframePage(page) {
    if (!page) return;
    // “最大化 / 打开”：让该页独占全屏（移除其他打开中的页，并强制铺满，即使 dock 还有其它页）
    iframeActive = [page];
    page._forceFull = true;
    layoutIframePages();
  }
  function minimizeCurrent(page) {
    if (!page) return;
    // “最小化 / 收起”：把当前页从打开中移除，收进 dock（不影响其他页）
    const i = iframeActive.indexOf(page);
    if (i >= 0) {
      iframeActive.splice(i, 1);
      if (iframeActive.length === 1) iframeActive[0]._forceFull = true; // 分屏中收起一个 → 另一个铺满
      layoutIframePages();
    }
  }
  function activateIframePage(page) {
    if (!page) return;
    // 从 dock 卡片点开 = 独占全屏：替换其它打开中的页（原页收成卡片），不再半屏/并排
    iframeActive = [page];
    page._forceFull = true;
    layoutIframePages();
  }
  function openIframe(url, title) {
    const safeUrl = String(url || "").trim();
    if (!safeUrl) { toast("链接地址为空，无法打开"); return; }
    const safeTitle = title || hostnameOf(safeUrl) || "未命名链接";
    const dock = $("#iframeDock");
    if (!dock) { window.open(safeUrl, "_blank"); return; }
    // 若该 url 的页面已存在（无论打开中还是最小化卡片），直接复用。内嵌打开走“强制全屏”，
    // 不进入半屏（半屏仅限从 dock 卡片点开时触发，便于再开另一个凑分屏）
    const existing = [...dock.querySelectorAll(".iframe-page")].find((p) => p.dataset.url === safeUrl);
    if (existing) { maximizeIframePage(existing); return; }
    const page = document.createElement("div");
    page.className = "iframe-page";
    page.dataset.url = safeUrl;
    page.innerHTML =
      `<div class="iframe-resizer left" title="拖动调整宽度"></div>` +
      `<div class="iframe-resizer right" title="拖动调整宽度"></div>` +
      `<div class="iframe-bar">` +
        `<span class="iframe-title">${escapeHtml(safeTitle)}</span>` +
        `<a class="iframe-url" target="_blank" rel="noopener noreferrer" href="${escapeHtml(safeUrl)}">${escapeHtml(safeUrl)}</a>` +
        `<div class="iframe-actions">` +
          `<button class="iframe-newtab btn ghost small" title="在新标签页打开">↗ 新标签</button>` +
          `<button class="iframe-max iframe-x" title="最大化">□</button>` +
          `<button class="iframe-min iframe-x" title="最小化">—</button>` +
          `<button class="iframe-close iframe-x" title="关闭">✕</button>` +
        `</div>` +
      `</div>` +
      `<iframe class="iframe-frame" referrerpolicy="no-referrer" ` +
      `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-modals"></iframe>`;
    page.querySelector(".iframe-close").addEventListener("click", (e) => { e.stopPropagation(); closeIframePage(page); });
    page.querySelector(".iframe-max").addEventListener("click", (e) => {
      e.stopPropagation();
      // 已打开中（半屏/分屏）→ 强制独占全屏；卡片态（已最小化）→ 走“打开”流程（尊重半屏/分屏：有其它页先半屏，便于再开另一个凑分屏）
      if (iframeActive.includes(page)) maximizeIframePage(page);
      else activateIframePage(page);
    });
    page.querySelector(".iframe-min").addEventListener("click", (e) => {
      e.stopPropagation();
      minimizeCurrent(page); // 最小化/收起当前页（不影响其他页）
    });
    page.querySelector(".iframe-newtab").addEventListener("click", (e) => { e.stopPropagation(); window.open(safeUrl, "_blank"); });
    // 点击 dock 卡片（非按钮/非拖拽条区域）打开（加入活动页，最多两个并排）
    page.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest(".iframe-resizer")) return;
      if (!iframeActive.includes(page)) activateIframePage(page);
    });
    // 恢复上次拖拽后的左/右边界（聊天打开时右侧留给 CSS 处理，避免被聊天面板覆盖）
    const savedL = parseInt(localStorage.getItem("iframeLeft"), 10);
    const savedR = parseInt(localStorage.getItem("iframeRight"), 10);
    if (savedL >= 0) page.style.left = savedL + "px";
    if (savedR >= 0 && !chatVisible) page.style.right = savedR + "px";
    dock.appendChild(page);
    // 内嵌打开（新建）同样强制全屏：覆盖式打开，不进入半屏。半屏仅由 dock 卡片点开触发
    maximizeIframePage(page);
    initIframeResizers(page);
    // 让页面（含最小化卡片）可拖拽：拖到屏幕左/右半释放 → 与另一页面分屏
    page.draggable = true;
    page.addEventListener("dragstart", (e) => {
      iframeDragPage = page;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", page.dataset.url || ""); } catch (_) {}
      document.body.classList.add("iframe-dragging");
    });
    page.addEventListener("dragend", () => {
      iframeDragPage = null;
      document.body.classList.remove("iframe-dragging", "iframe-drop-left", "iframe-drop-right");
      const hint = document.getElementById("iframeDropHint");
      if (hint) hint.style.display = "none";
    });
    page.querySelector(".iframe-frame").src = safeUrl; // 节点一次性插入并设置 src，保持常驻运行
  }

  // ---------- 内嵌页左右边缘拖拽调整宽度（仅单页全屏态生效；分屏态用分隔条）----------
  function initIframeResizers(page) {
    const leftR = page.querySelector(".iframe-resizer.left");
    const rightR = page.querySelector(".iframe-resizer.right");
    if (!leftR || !rightR) return;
    function persist() {
      const r = page.getBoundingClientRect();
      localStorage.setItem("iframeLeft", String(Math.round(r.left)));
      localStorage.setItem("iframeRight", String(Math.round(window.innerWidth - r.right)));
    }
    function startDrag(resizer, which) {
      return (e) => {
        e.preventDefault();
        e.stopPropagation();
        resizer.classList.add("active");
        document.body.classList.add("resizing");
        const rect = page.getBoundingClientRect();
        const startLeft = rect.left;
        const startRight = window.innerWidth - rect.right;
        const startX = e.clientX;
        const winW = window.innerWidth;
        function onMove(ev) {
          if (which === "left") {
            let nl = startLeft + (ev.clientX - startX);
            nl = Math.max(0, Math.min(nl, winW - IFRAME_MIN_W - startRight));
            page.style.left = nl + "px";
            page.style.right = startRight + "px";
          } else {
            let nr = startRight - (ev.clientX - startX);
            nr = Math.max(0, Math.min(nr, winW - IFRAME_MIN_W - startLeft));
            page.style.right = nr + "px";
            page.style.left = startLeft + "px";
          }
        }
        function onUp() {
          resizer.classList.remove("active");
          document.body.classList.remove("resizing");
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          persist();
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      };
    }
    leftR.addEventListener("mousedown", startDrag(leftR, "left"));
    rightR.addEventListener("mousedown", startDrag(rightR, "right"));
  }

  // ---------- 分屏分隔条（左右分屏时拖动调整左右占比）----------
  function initIframeDivider() {
    if (!dividerEl) return;
    const saved = parseFloat(localStorage.getItem("iframeSplitRatio"));
    if (saved > 0 && saved < 1) splitRatio = saved;
    dividerEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dividerEl.classList.add("active");
      document.body.classList.add("resizing");
      const startX = e.clientX;
      const startRatio = splitRatio;
      const chatOpen = document.body.classList.contains("chat-open");
      const chatW = chatOpen ? Math.min(560, window.innerWidth) : 0;
      const avail = window.innerWidth - chatW;
      function onMove(ev) {
        let nr = startRatio + (ev.clientX - startX) / avail;
        nr = Math.max(IFRAME_MIN_W / avail, Math.min(nr, 1 - IFRAME_MIN_W / avail));
        splitRatio = nr;
        layoutIframePages();
      }
      function onUp() {
        dividerEl.classList.remove("active");
        document.body.classList.remove("resizing");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        localStorage.setItem("iframeSplitRatio", String(splitRatio));
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  let _chatOpenPrev = false;
  function initIframeInfra() {
    dividerEl = document.createElement("div");
    dividerEl.className = "iframe-divider";
    dividerEl.style.display = "none";
    document.body.appendChild(dividerEl);
    initIframeDivider();
    // 内嵌栏收起/展开按钮：常驻 dock 内（非 .iframe-page 子节点），隐藏卡片后仍可点
    const dock = $("#iframeDock");
    if (dock && !$("#iframeDockToggle")) {
      const t = document.createElement("button");
      t.id = "iframeDockToggle";
      t.className = "iframe-dock-toggle";
      t.addEventListener("click", (e) => { e.stopPropagation(); toggleDockHidden(); });
      dock.insertBefore(t, dock.firstChild);
    }
    applyDockHidden();
    // 聊天面板开/关时重新布局内嵌页，让出右侧空间避免被覆盖
    _chatOpenPrev = document.body.classList.contains("chat-open");
    const mo = new MutationObserver(() => {
      const now = document.body.classList.contains("chat-open");
      if (now !== _chatOpenPrev) { _chatOpenPrev = now; layoutIframePages(); }
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    // 拖拽页面到屏幕左/右半释放 → 与另一页面左右分屏
    const dropHint = document.createElement("div");
    dropHint.id = "iframeDropHint";
    dropHint.className = "iframe-drop-hint";
    dropHint.style.display = "none";
    document.body.appendChild(dropHint);
    document.addEventListener("dragover", (e) => {
      if (!iframeDragPage) return;
      e.preventDefault();
      const left = e.clientX < window.innerWidth / 2;
      document.body.classList.toggle("iframe-drop-left", left);
      document.body.classList.toggle("iframe-drop-right", !left);
      dropHint.style.display = "block";
      dropHint.classList.toggle("left", left);
      dropHint.classList.toggle("right", !left);
    });
    document.addEventListener("drop", (e) => {
      if (!iframeDragPage) return;
      e.preventDefault();
      const page = iframeDragPage;
      iframeDragPage = null;
      document.body.classList.remove("iframe-dragging", "iframe-drop-left", "iframe-drop-right");
      dropHint.style.display = "none";
      // 找“搭档页”：优先当前活动页，否则 dock 里另一个页面
      let mate = iframeActive.find((p) => p !== page);
      if (!mate) {
        const d = $("#iframeDock");
        mate = d && [...d.querySelectorAll(".iframe-page")].find((p) => p !== page);
      }
      if (!mate) { maximizeIframePage(page); return; } // 仅此一页：直接全屏
      const left = e.clientX < window.innerWidth / 2;
      // 放下在左半 → 被拖页在左、搭档在右；右半反之。layout 的 n===2 分支完成分屏定位
      iframeActive = left ? [page, mate] : [mate, page];
      layoutIframePages();
    });
  }
  initIframeInfra();

  // ---------- Context menu ----------
  let ctxEl = null;
  function openContextMenu(id, x, y) {
    closeContextMenu();
    const app = apps.find((a) => a.id === id);
    if (!app) return;
    ctxEl = document.createElement("div");
    ctxEl.className = "ctx-menu";
    ctxEl.innerHTML = `
      <button data-act="open">🔗 打开</button>
      <button data-act="embed">🖥️ 内嵌打开</button>
      <button data-act="edit">✏️ 编辑</button>
      <button data-act="copy">📋 复制网址</button>
      <button data-act="delete" class="danger">🗑️ 删除</button>
    `;
    ctxEl.style.left = Math.min(x, window.innerWidth - 160) + "px";
    ctxEl.style.top = Math.min(y, window.innerHeight - 160) + "px";
    document.body.appendChild(ctxEl);

    ctxEl.addEventListener("click", (e) => {
      const act = e.target.getAttribute("data-act");
      if (act === "open") openApp(app);
      else if (act === "embed") openIframe(app.url, app.name);
      else if (act === "edit") openModal(app);
      else if (act === "copy") { navigator.clipboard.writeText(app.url); toast("已复制网址"); }
      else if (act === "delete") deleteApp(id);
      closeContextMenu();
    });
  }
  function closeContextMenu() {
    if (ctxEl) { ctxEl.remove(); ctxEl = null; }
  }
  document.addEventListener("click", (e) => {
    if (ctxEl && !ctxEl.contains(e.target)) closeContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeContextMenu(); closeModal(); closeProfileModal();
      // 关闭所有打开中的内嵌页（单页 .active 或分屏 .split 都在 iframeActive 中）
      if (iframeActive.length) {
        [...iframeActive].forEach((p) => closeIframePage(p));
      }
    }
  });

  // ---------- Modal ----------
  function renderColorRow() {
    colorRow.innerHTML = "";
    COLORS.forEach((c) => {
      const d = document.createElement("div");
      d.className = "color-dot" + (c === selectedColor ? " active" : "");
      d.style.background = c;
      d.onclick = () => { selectedColor = c; renderColorRow(); };
      colorRow.appendChild(d);
    });
  }
  function openModal(app) {
    editingId = app ? app.id : null;
    modalTitle.textContent = app ? "编辑应用" : "添加应用";
    $("#fName").value = app ? app.name : "";
    $("#fUrl").value = app ? app.url : "";
    $("#fCategory").value = app && app.category ? app.category : "";
    $("#fEmoji").value = app && app.emoji ? app.emoji : "";
    $("#fOpenMode").value = app ? (app.openMode || (app.openNew === false ? "self" : "new")) : "new";
    selectedColor = app && app.color ? app.color : COLORS[0];
    renderColorRow();
    updateIconPreview();
    modal.hidden = false;
    setTimeout(() => $("#fName").focus(), 50);
  }
  // 图标预览：emoji 显示文字，链接显示图片，空则显示网站默认 favicon
  function updateIconPreview() {
    const el = $("#iconPreview");
    if (!el) return;
    const val = $("#fEmoji").value.trim();
    const color = selectedColor || COLORS[0];
    let inner = "";
    if (isIconUrl(val)) {
      inner = `<img src="${escapeHtml(val)}" alt="" onerror="this.style.display='none';this.parentNode.textContent='${escapeHtml(fallbackChar($("#fUrl").value))}'"/>`;
    } else if (val) {
      inner = escapeHtml(val);
    } else if ($("#fUrl").value.trim()) {
      const fv = faviconUrl($("#fUrl").value.trim());
      inner = `<img src="${escapeHtml(fv)}" alt="" onerror="this.style.display='none';this.parentNode.textContent='${escapeHtml(fallbackChar($("#fUrl").value))}'"/>`;
    } else {
      inner = "🌐";
    }
    el.style.background = color + "22";
    el.innerHTML = inner;
  }
  function closeModal() { modal.hidden = true; editingId = null; }

  // ---------- 个人资料 / 头像 ----------
  function openProfileModal() {
    $("#profileUsername").textContent = currentUsername;
    $("#pAvatar").value = myAvatar;
    updateAvatarPreview();
    profileModal.hidden = false;
  }
  function updateAvatarPreview() {
    const el = $("#avatarPreview");
    if (!el) return;
    const val = $("#pAvatar").value.trim();
    el.style.background = "var(--surface-2)";
    el.innerHTML = renderAvatar(val, (currentUsername || "?").charAt(0).toUpperCase());
  }
  async function saveAvatar() {
    try {
      const r = await api("/api/me", {
        method: "PUT",
        body: JSON.stringify({ avatar: $("#pAvatar").value.trim() }),
      });
      myAvatar = r.user.avatar;
      renderAvatarInto($("#userAvatar"), myAvatar, (currentUsername || "?").charAt(0).toUpperCase());
      closeProfileModal();
      toast("头像已更新");
    } catch (e) {
      toast(e.message || "保存失败");
    }
  }
  function closeProfileModal() { profileModal.hidden = true; }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#fName").value.trim();
    let url = $("#fUrl").value.trim();
    if (!name || !url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;

    const payload = {
      name,
      url,
      category: $("#fCategory").value.trim() || "未分类",
      emoji: $("#fEmoji").value.trim(),
      color: selectedColor,
      openNew: $("#fOpenMode").value !== "iframe",
      openMode: $("#fOpenMode").value,
    };

    const wasEditing = editingId;
    editingId = null;
    closeModal();
    try {
      if (wasEditing) {
        await updateLinkLocal(wasEditing, payload);
        toast("已更新");
      } else {
        await createLinkLocal(payload);
        toast("已添加");
      }
    } catch (err) {
      toast(err.message || "保存失败");
    }
  });

  async function deleteApp(id) {
    const app = apps.find((a) => a.id === id);
    if (!app) return;
    if (!confirm(`确定删除「${app.name}」？`)) return;
    await deleteLinkLocal(id);
    toast("已删除");
  }

  // ---------- Import / Export（走服务端 PostgreSQL）----------
  async function exportJson() {
    try {
      const data = await api("/api/export");
      if (!data.links || data.links.length === 0) { toast("暂无数据可导出"); return; }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `web-apps-${data.username || "backup"}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`已导出备份（${data.links.length} 条）`);
    } catch (e) {
      toast("导出失败：" + (e.message || "请稍后重试"));
    }
  }
  async function importJson(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        const links = Array.isArray(parsed)
          ? parsed
          : (parsed && Array.isArray(parsed.links) ? parsed.links : null);
        if (!links) throw new Error("格式不正确");
        const data = await api("/api/import", {
          method: "POST",
          body: JSON.stringify({ links }),
        });
        await syncLinks();
        toast(`已导入 ${data.created} 条，跳过重复 ${data.skipped} 条`);
      } catch (e) {
        toast("导入失败：" + (e.message || "文件格式不正确"));
      }
    };
    reader.readAsText(file);
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg, onClick) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    t.style.cursor = onClick ? "pointer" : "";
    if (onClick) {
      t.onclick = () => { t.hidden = true; t.onclick = null; onClick(); };
    } else {
      t.onclick = null;
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, onClick ? 4000 : 1800);
  }

  // ---------- Theme ----------
  function applyTheme(theme) {
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    localStorage.setItem(THEME_KEY, theme);
  }

  // ---------- Auth events ----------
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "登录中…";
    try {
      const data = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("#loginUser").value.trim(),
          password: $("#loginPass").value,
        }),
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      $("#loginForm").reset();
      await enterApp(data.user);
    } catch (err) {
      showAuthError(err.message || "登录失败");
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });
  $("#registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "注册中…";
    try {
      const data = await api("/api/register", {
        method: "POST",
        body: JSON.stringify({
          username: $("#regUser").value.trim(),
          password: $("#regPass").value,
        }),
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      $("#registerForm").reset();
      await enterApp(data.user);
    } catch (err) {
      showAuthError(err.message || "注册失败");
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });
  $("#toRegister").onclick = (e) => {
    e.preventDefault();
    $("#loginForm").hidden = true;
    $("#registerForm").hidden = false;
    $("#authSub").textContent = "创建账号以保存你的应用";
    clearAuthError();
  };
  $("#toLogin").onclick = (e) => {
    e.preventDefault();
    $("#registerForm").hidden = true;
    $("#loginForm").hidden = false;
    $("#authSub").textContent = "登录以同步你的应用";
    clearAuthError();
  };
  $("#logoutBtn").onclick = async () => {
    disconnectSignaling();
    try { await api("/api/logout", { method: "POST" }); } catch {}
    localStorage.removeItem(TOKEN_KEY);
    showAuth();
  };

  // ---------- Events ----------
  $("#addBtn").onclick = () => openModal(null);
  $("#exportBtn").onclick = exportJson;
  $("#importBtn").onclick = () => $("#importFile").click();
  $("#importFile").onchange = (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ""; };
  $("#themeBtn").onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    applyTheme(cur === "dark" ? "light" : "dark");
  };
  searchInput.oninput = (e) => { searchTerm = e.target.value; renderGrid(); };
  modal.querySelectorAll("[data-close]").forEach((el) => el.onclick = closeModal);

  // 个人资料 / 头像
  $("#userAvatarBtn").onclick = openProfileModal;
  $("#pAvatar").addEventListener("input", updateAvatarPreview);
  $("#saveAvatar").onclick = saveAvatar;
  profileModal.querySelectorAll("[data-close]").forEach((el) => el.onclick = closeProfileModal);

  // 图标预览实时更新 + 一键填入网站默认 favicon
  $("#fEmoji").addEventListener("input", updateIconPreview);
  $("#fUrl").addEventListener("input", updateIconPreview);
  $("#fEmojiAuto").onclick = () => {
    const u = $("#fUrl").value.trim();
    if (!u) { toast("请先填写网址"); return; }
    $("#fEmoji").value = faviconUrl(u);
    updateIconPreview();
  };

  // =====================================================================
  // 好友聊天（P2P + 中继兜底）
  // 鉴权后的 WebSocket 按好友 userId 定向路由信令与消息；聊天内容默认走 WebRTC
  // DataChannel 在两位好友浏览器间直连收发，无法直连时由服务器中继转发（仅转发不落盘）。
  // 注意：DOM 常量必须先于事件绑定声明，否则事件回调访问到 TDZ 中的 const 会抛 ReferenceError。
  // =====================================================================
  const chatPanel = $("#chatPanel");
  const chatResizer = $("#chatResizer");
  const chatStatus = $("#chatStatus");
  const chatMessages = $("#chatMessages");
  const chatInput = $("#chatInput");
  const chatSendBtn = $("#chatSend");
  const chatPeerName = $("#chatPeerName");
  const chatClose = $("#chatClose");

  // 语音/视频通话 UI 元素
  const btnVoiceCall = $("#btnVoiceCall");
  const btnVideoCall = $("#btnVideoCall");
  const callPanel = $("#callPanel");
  const callIncoming = $("#callIncoming");
  const remoteVideo = $("#remoteVideo");
  const localVideo = $("#localVideo");
  const callRemoteName = $("#callRemoteName");
  const callStateLabel = $("#callStateLabel");
  const callRemoteAvatar = $("#callRemoteAvatar");
  const btnCallMute = $("#btnCallMute");
  const btnCallCam = $("#btnCallCam");
  const btnCallHangup = $("#btnCallHangup");
  const incomingAvatar = $("#incomingAvatar");
  const incomingName = $("#incomingName");
  const incomingType = $("#incomingType");
  const btnIncomingAccept = $("#btnIncomingAccept");
  const btnIncomingDecline = $("#btnIncomingDecline");
  // 群会议相关 DOM
  const meetingPanel = $("#meetingPanel");
  const meetingGrid = $("#meetingGrid");
  const meetingLocalVideo = $("#meetingLocalVideo");
  const meetingGroupName = $("#meetingGroupName");
  const meetingCount = $("#meetingCount");
  const btnMeetingMute = $("#btnMeetingMute");
  const btnMeetingCam = $("#btnMeetingCam");
  const btnMeetingHangup = $("#btnMeetingHangup");
  const btnMeetingLeave = $("#btnMeetingLeave");
  const groupMeetingBtn = $("#groupMeetingBtn");       // 群聊头部：发起会议
  const groupMeetingBtn2 = $("#groupMeetingBtn2");     // 群详情：发起会议
  const groupCallInvite = $("#groupCallInvite");
  const groupCallAvatar = $("#groupCallAvatar");
  const groupCallName = $("#groupCallName");
  const groupCallType = $("#groupCallType");
  const btnGroupCallJoin = $("#btnGroupCallJoin");
  const btnGroupCallIgnore = $("#btnGroupCallIgnore");
  const friendListEl = $("#friendList");
  const friendRequestsEl = $("#friendRequests");
  const friendEmptyEl = $("#friendEmpty");
  const friendSearch = $("#friendSearch");
  const friendAddBtn = $("#friendAdd");
  const chatUnreadBadge = $("#chatUnreadBadge");

  // 群聊相关 DOM
  const groupListEl = $("#groupList");
  const groupEmptyEl = $("#groupEmpty");
  const groupCreateBtn = $("#groupCreateBtn");
  const groupModal = $("#groupModal");
  const groupNameInput = $("#groupNameInput");
  const groupMemberPicker = $("#groupMemberPicker");
  const groupCreateConfirm = $("#groupCreateConfirm");
  const groupAddModal = $("#groupAddModal");
  const groupAddPicker = $("#groupAddPicker");
  const groupAddMemberBtn = $("#groupAddMember");
  const groupLeaveBtn = $("#groupLeave");
  const chatGroupActions = $("#chatGroupActions");

  // 统一会话（私聊 + 群聊）列表 DOM
  const convListEl = $("#convList");
  const convEmptyEl = $("#convEmpty");

  // Tab 栏（会话 / 好友 / 群组）DOM
  const chatTabs = document.querySelectorAll(".chat-tab");
  const tabPanels = document.querySelectorAll(".tab-panel");
  const tabConvBadge = $("#tabConvBadge");
  const tabFriendBadge = $("#tabFriendBadge");

  // 聊天主区域三视图（chatView / 好友详情 / 群组详情）
  const chatView = $("#chatView");
  const friendView = $("#friendView");
  const groupView = $("#groupView");
  const friendDetailAvatar = $("#friendDetailAvatar");
  const friendDetailName = $("#friendDetailName");
  const friendDetailStatus = $("#friendDetailStatus");
  const friendMessageBtn = $("#friendMessageBtn");
  const friendRemoveBtn = $("#friendRemoveBtn");
  const groupDetailAvatar = $("#groupDetailAvatar");
  const groupDetailName = $("#groupDetailName");
  const groupDetailMeta = $("#groupDetailMeta");
  const groupDetailMembers = $("#groupDetailMembers");
  const groupMessageBtn = $("#groupMessageBtn");
  const groupAddMemberBtn2 = $("#groupAddMemberBtn2");
  const groupLeaveBtn2 = $("#groupLeaveBtn2");
  const groupRenameBtn = $("#groupRenameBtn");
  const groupNameEdit = $("#groupNameEdit");
  groupNameEdit.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const g = groups.find((x) => x.id === currentGroup); if (g) saveGroupRename(g); }
    else if (e.key === "Escape") { e.preventDefault(); cancelGroupRename(); }
  });
  groupNameEdit.addEventListener("blur", () => { if (!groupNameEdit.hidden) cancelGroupRename(); });

  // ---------- 本地聊天缓存（IndexedDB）----------
  // 设计：每条聊天消息先写本地 IndexedDB（离线可用、刷新不丢）；
  // 本地缺失/换设备时，再从服务端 Deno KV（保留 3 个月）拉取并同步回本地。
  const ChatDB = (function () {
    const DB_NAME = "p2p-chat-cache";
    const STORE = "messages";
    const META = "meta";
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const os = db.createObjectStore(STORE, { keyPath: "id" });
            os.createIndex("byConv", "conv", { unique: false });
            os.createIndex("bySynced", "synced", { unique: false });
          }
          if (!db.objectStoreNames.contains(META)) {
            db.createObjectStore(META, { keyPath: "k" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbp;
    }
    function store(mode, name) {
      const s = name || STORE;
      return open().then((db) => db.transaction(s, mode).objectStore(s));
    }
    function done(r) {
      return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    }
    return {
      async put(m) {
        m.conv = m.conv || convKeyLocal(m.from, m.to);
        if (m.synced === undefined) m.synced = false;
        const os = await store("readwrite");
        return done(os.put(m));
      },
      async has(id) {
        const os = await store("readonly");
        return !!await done(os.get(id));
      },
      // 同一会话全部消息，按时间升序
      async allForConv(conv) {
        const os = await store("readonly");
        const idx = os.index("byConv");
        const out = [];
        return new Promise((res, rej) => {
          const cur = idx.openCursor(IDBKeyRange.only(conv));
          cur.onsuccess = () => {
            const c = cur.result;
            if (c) { out.push(c.value); c.continue(); }
            else { out.sort((a, b) => a.ts - b.ts); res(out); }
          };
          cur.onerror = () => rej(cur.error);
        });
      },
      // 本地该会话最新一条消息的时间戳（用于增量同步 since）
      async maxTs(conv) {
        const all = await this.allForConv(conv);
        return all.length ? all[all.length - 1].ts : 0;
      },
      // 尚未同步到服务端的消息（用于断网恢复后补推）
      async pending() {
        const os = await store("readonly");
        const idx = os.index("bySynced");
        const out = [];
        return new Promise((res, rej) => {
          const cur = idx.openCursor(IDBKeyRange.only(false));
          cur.onsuccess = () => {
            const c = cur.result;
            if (c) { out.push(c.value); c.continue(); }
            else res(out);
          };
          cur.onerror = () => rej(cur.error);
        });
      },
      // ---- 元信息（key-value），用于持久化未读消息数等 ----
      async getMeta(k, def) {
        const os = await store("readonly", META);
        const row = await done(os.get(k));
        return row ? row.v : def;
      },
      async setMeta(k, v) {
        const os = await store("readwrite", META);
        return done(os.put({ k, v }));
      },
    };
  })();

  // ---------- 链接本地缓存（IndexedDB）----------
  // 每个用户的链接缓存在本地，UI 优先读本地（秒开），后台与 PostgreSQL 同步。
  // 记录结构：{ id, userId, name, url, category, emoji, color, openNew, createdAt, synced, op?, _tombstone? }
  //   id: 服务端数字 id；离线新建时为字符串 "tmp_<uuid>"
  //   synced: 是否已与服务端一致；op: 待同步操作 create/update/delete；_tombstone: 待删除
  const LinkDB = (function () {
    const DB_NAME = "web-app-links-cache";
    const DB_VERSION = 1;
    const STORE = "links";
    const META = "meta";
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const os = db.createObjectStore(STORE, { keyPath: "id" });
            os.createIndex("byUser", "userId", { unique: false });
          }
          if (!db.objectStoreNames.contains(META)) {
            db.createObjectStore(META, { keyPath: "k" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbp;
    }
    function store(mode, name) {
      const s = name || STORE;
      return open().then((db) => db.transaction(s, mode).objectStore(s));
    }
    function done(r) {
      return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    }
    return {
      async put(link) {
        const os = await store("readwrite");
        return done(os.put(link));
      },
      async putMany(links) {
        const os = await store("readwrite");
        return Promise.all(links.map((l) => done(os.put(l))));
      },
      async all() {
        const os = await store("readonly");
        return new Promise((res, rej) => {
          const out = [];
          const cur = os.openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (c) { out.push(c.value); c.continue(); } else res(out);
          };
          cur.onerror = () => rej(cur.error);
        });
      },
      async allByUser(userId) {
        const os = await store("readonly");
        const idx = os.index("byUser");
        return new Promise((res, rej) => {
          const out = [];
          const cur = idx.openCursor(IDBKeyRange.only(Number(userId)));
          cur.onsuccess = () => {
            const c = cur.result;
            if (c) { out.push(c.value); c.continue(); } else res(out);
          };
          cur.onerror = () => rej(cur.error);
        });
      },
      async get(id) {
        const os = await store("readonly");
        return await done(os.get(id));
      },
      async delete(id) {
        const os = await store("readwrite");
        return done(os.delete(id));
      },
      // 清空某用户全部缓存（用于整库与服务端对齐前）
      async clearByUser(userId) {
        const all = await this.allByUser(userId);
        await Promise.all(all.map((l) => this.delete(l.id)));
      },
      async getMeta(k, def) {
        const os = await store("readonly", META);
        const row = await done(os.get(k));
        return row ? row.v : def;
      },
      async setMeta(k, v) {
        const os = await store("readwrite", META);
        return done(os.put({ k, v }));
      },
    };
  })();

  // 会话键：两个好友 userId 的有序组合（与后端 convKey 一致）
  function convKeyLocal(a, b) {
    a = Number(a); b = Number(b);
    return a < b ? `${a}_${b}` : `${b}_${a}`;
  }
  function currentConv() {
    return (myId != null && currentPeer != null) ? convKeyLocal(myId, currentPeer) : null;
  }

  // ---------- 事件 ----------
  $("#chatBtn").onclick = openChat;
  chatClose.onclick = closeChat;
  chatSendBtn.onclick = sendChat;
  friendAddBtn.onclick = addFriend;
  friendSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addFriend(); } });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  });

  // 语音/视频通话事件
  if (btnVoiceCall) btnVoiceCall.onclick = () => { if (currentPeer != null) startMediaCall(currentPeer, "audio"); };
  if (btnVideoCall) btnVideoCall.onclick = () => { if (currentPeer != null) startMediaCall(currentPeer, "video"); };
  if (btnCallMute) btnCallMute.onclick = toggleMute;
  if (btnCallCam) btnCallCam.onclick = toggleCamera;
  if (btnCallHangup) btnCallHangup.onclick = endCall;
  if (btnIncomingAccept) btnIncomingAccept.onclick = acceptCall;
  if (btnIncomingDecline) btnIncomingDecline.onclick = declineCall;

  // 群会议事件
  if (groupMeetingBtn) groupMeetingBtn.onclick = () => { const g = groups.find((x) => x.id === currentGroup); if (g) startGroupMeeting(g.id, "video"); };
  if (groupMeetingBtn2) groupMeetingBtn2.onclick = () => { const g = groups.find((x) => x.id === currentGroup); if (g) startGroupMeeting(g.id, "video"); };
  if (btnMeetingMute) btnMeetingMute.onclick = toggleMeetingMute;
  if (btnMeetingCam) btnMeetingCam.onclick = toggleMeetingCam;
  if (btnMeetingHangup) btnMeetingHangup.onclick = leaveGroupMeeting;
  if (btnMeetingLeave) btnMeetingLeave.onclick = leaveGroupMeeting;
  if (btnGroupCallJoin) btnGroupCallJoin.onclick = () => {
    const pg = pendingGroupCall;
    if (pg) joinGroupMeeting(pg.groupId, pg.media, pg.from);
  };
  if (btnGroupCallIgnore) btnGroupCallIgnore.onclick = hideGroupCallInvite;

  // 群聊事件
  groupCreateBtn.onclick = openGroupModal;
  groupCreateConfirm.onclick = submitCreateGroup;
  groupAddMemberBtn.onclick = openAddMemberModal;
  groupLeaveBtn.onclick = leaveCurrentGroup;
  groupModal.querySelectorAll("[data-close]").forEach((el) => (el.onclick = () => { groupModal.hidden = true; }));
  groupAddModal.querySelectorAll("[data-close]").forEach((el) => (el.onclick = () => { groupAddModal.hidden = true; }));

  // Tab 栏切换
  chatTabs.forEach((b) => { b.onclick = () => switchChatTab(b.dataset.tab); });

  // ---------- 状态 ----------
  let sigSocket = null;
  let sigReconnectTimer = null;
  let sigReconnectDelay = 1000;
  let sigStopReconnect = false;
  let myId = null;
  let currentPeer = null;        // 当前“显示中”的对话好友 userId（number）；仅用于界面，绝不被来电改动
  let chatVisible = false;       // 聊天面板是否真正打开（关闭抽屉后仍算「未在看」）
  let currentPeerName = "";
  let currentPeerAvatar = "";
  // 每个好友一条独立连接：peers = Map<peerId, { pc, dc, p2pReady, status }>
  const peers = new Map();
  // 缓存各 peer 最近一次收到的远端流，供“先收到流、后加入会议”时补渲染到会议网格
  const peerStreams = new Map();
  let relayActive = false;       // 中继兜底开关（全局：只要任一好友可走中继即为 true）
  let enteringMsg = null;
  let renderedIds = new Set();   // 当前会话已渲染的消息 id，避免同步时重复渲染
  let friends = [];              // [{id, username, online}]
  let friendRequests = [];       // [{id, userId, username}]
  let presenceFriends = new Set();
  let unread = {};               // { [peerId]: 未读消息数 }，按当前用户隔离后持久化在 IndexedDB
  let currentUserId = null;      // 当前登录用户 id，用于把 unread 按账号隔离（IndexedDB 按 origin 共享，避免双账号串台）
  let syncingAll = false;        // 防止离线/重连的未读补算并发重入

  // ---- 群聊状态 ----
  let chatMode = "peer";         // "peer" | "group"
  let currentGroup = null;       // 当前显示的群聊 id（group 模式）
  let currentGroupAvatar = "";
  let groups = [];               // [{id, name, avatar, ownerId, members:[{id,username,avatar,online}]}]
  let groupUnread = {};          // { [groupId]: 未读消息数 }
  let groupRenderedIds = new Set(); // 当前群会话已渲染的消息 id（避免同步重复渲染）

  // ---- 统一会话（私聊 + 群聊）----
  // conversations 数组：[{ type:"peer"|"group", id, lastTs, lastText }]，按 lastTs 降序
  // 这就是“会话”概念——把 p2p 聊天和群聊都视为会话，可关闭、新消息/新好友会前置。
  let conversations = [];

  // 默认 ICE 配置。Google STUN 在国内多数网络不通，已移除；
  // 实际优先使用后端 /api/ws-info 下发的 iceServers（含可选 TURN）。
  const DEFAULT_ICE = [
    { urls: "stun:stun.miwifi.com:3478" },
    { urls: "stun:stun.chat.bilibili.com:3478" },
    { urls: "stun:stun.qq.com:3478" },
  ];
  let cachedIceServers = null;
  function rtcConfig() {
    const servers = (cachedIceServers && cachedIceServers.length) ? cachedIceServers : DEFAULT_ICE;
    return { iceServers: servers };
  }

  function setChatStatus(text, cls) {
    chatStatus.textContent = text;
    chatStatus.className = "chat-status" + (cls ? " " + cls : "");
  }
  // 跨天日期分割：记录最近一条已渲染消息的“本地日期”，日期变化时插入分割条
  let lastRenderedDate = null;
  // 根据时间戳生成日期分割文字（今天 / 昨天 / M月D日 / Y年M月D日）
  function formatDateLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOfToday - startOfMsg) / 86400000);
    if (diffDays <= 0) return "今天";
    if (diffDays === 1) return "昨天";
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + "月" + d.getDate() + "日";
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }
  // 若与上次渲染的消息不在同一天，则在消息前插入一条日期分割
  function maybeDateSeparator(ts) {
    if (!ts) return;
    const d = new Date(ts);
    const key = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
    if (key !== lastRenderedDate) {
      lastRenderedDate = key;
      const sep = document.createElement("div");
      sep.className = "chat-date-sep";
      sep.textContent = formatDateLabel(ts);
      chatMessages.appendChild(sep);
    }
  }
  function resetChatMessages(peerName) {
    chatMessages.innerHTML =
      `<div class="chat-empty">${peerName ? "与 " + escapeHtml(peerName) + " 聊天" : "选择一个好友开始聊天"}</div>`;
    lastRenderedDate = null;
  }
  function openChat() {
    chatPanel.hidden = false;
    document.body.classList.add("chat-open");
    chatVisible = true;
    // 打开面板时回到聊天视图（而不是残留的好友/群组详情页）
    showChatView();
    // 注意：打开整个聊天面板不应自动清除未读——只有点开“具体某个好友”会话（openConversation）才视为已读。
    // 之前这里会在打开面板时 clearUnread(currentPeer)，而 currentPeer 关抽屉后并不会清空，
    // 导致刚给你发消息的好友红点一打开面板就被抹掉（顶栏若还有其他好友未读则仍显示，造成“顶栏有、列表没有”）。
    console.log("[UNREAD-DEBUG] openChat currentPeer=", currentPeer);
    connectSignaling();
    loadFriends();
    loadGroups();
  }
  function closeChat() {
    if (callState !== "idle") endCall(); // 关闭聊天面板时若正在通话，先结束并通知对方
    if (meetingActive) leaveGroupMeeting(); // 群会议随聊天面板关闭而结束
    chatPanel.hidden = true; document.body.classList.remove("chat-open"); chatVisible = false;
    updateCallButtons();
  }

  // ---------- 聊天面板拖拽调整宽度 ----------
  function initChatResizer() {
    const saved = parseInt(localStorage.getItem("chatPanelWidth"), 10);
    if (saved && saved >= 320) chatPanel.style.width = saved + "px";

    chatResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      chatResizer.classList.add("active");
      document.body.classList.add("resizing");
      const startX = e.clientX;
      const startW = chatPanel.getBoundingClientRect().width;
      function onMove(ev) {
        let newW = startW + (startX - ev.clientX);
        const maxW = window.innerWidth - 80;
        newW = Math.max(320, Math.min(newW, maxW));
        chatPanel.style.width = newW + "px";
      }
      function onUp() {
        chatResizer.classList.remove("active");
        document.body.classList.remove("resizing");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        const cur = parseInt(chatPanel.style.width, 10);
        if (cur) localStorage.setItem("chatPanelWidth", String(cur));
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  initChatResizer();

  // ---------- 侧边栏（会话/好友/群组列表）拖拽调整宽度 ----------
  function initSidebarResizer() {
    const sidebar = document.querySelector(".chat-sidebar");
    const sResizer = $("#sidebarResizer");
    if (!sidebar || !sResizer) return;
    const saved = parseInt(localStorage.getItem("chatSidebarWidth"), 10);
    if (saved && saved >= 180) sidebar.style.width = saved + "px";

    sResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      sResizer.classList.add("active");
      document.body.classList.add("resizing");
      const startX = e.clientX;
      const startW = sidebar.getBoundingClientRect().width;
      function onMove(ev) {
        let newW = startW + (ev.clientX - startX);
        const panelWidth = chatPanel.getBoundingClientRect().width;
        const maxW = Math.max(260, panelWidth - 360);
        newW = Math.max(180, Math.min(newW, maxW));
        sidebar.style.width = newW + "px";
      }
      function onUp() {
        sResizer.classList.remove("active");
        document.body.classList.remove("resizing");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        const cur = parseInt(sidebar.style.width, 10);
        if (cur) localStorage.setItem("chatSidebarWidth", String(cur));
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  initSidebarResizer();

  // ---------- 信令连接（带 token 鉴权，全程持久 + 自动重连）----------
  async function connectSignaling() {
    if (sigStopReconnect) return;
    if (sigSocket && (sigSocket.readyState === WebSocket.OPEN || sigSocket.readyState === WebSocket.CONNECTING)) return;
    try {
      const res = await fetch("/api/ws-info");
      const j = await res.json();
      if (Array.isArray(j && j.iceServers) && j.iceServers.length) cachedIceServers = j.iceServers;
    } catch { /* 忽略，使用默认 STUN */ }

    // WebSocket 地址以【浏览器当前页面协议】为准；token 通过 query 传给信令服务做鉴权。
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const token = localStorage.getItem(TOKEN_KEY) || "";
    const wsUrl = `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    sigSocket = ws;
    return new Promise((resolve) => {
      ws.onopen = () => {
        sigReconnectDelay = 1000; // 连接成功，重置退避
        console.log("[SIG-CLIENT] ws 已打开，信令连接成功 (token len=" + token.length + ")");
        setChatStatus("信令已连接", "ok");
        subscribePresence();
        flushPending();            // 断网恢复后把本地未同步的消息补推到服务端
        if (currentPeer) reCall(); // 重连后恢复进行中的对话
        trySyncAll();              // 离线期间漏掉的消息补算未读红点（myId 已就绪，好友列表可能尚未就绪）
        resolve();
      };
      ws.onclose = () => {
        if (sigSocket === ws) sigSocket = null;
        setChatStatus("信令断开", "warn");
        scheduleReconnect();
        resolve();
      };
      ws.onerror = () => {};
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        try { onSignalMessage(m); }
        catch (err) { console.error("[SIG-CLIENT] onSignalMessage 异常(已捕获，不影响其他消息):", (err && err.message) || err); }
      };
    });
  }

  // 断线后按指数退避自动重连（无论聊天面板是否打开），保证在线状态/好友在线点在重启后恢复
  function scheduleReconnect() {
    if (sigStopReconnect) return;
    clearTimeout(sigReconnectTimer);
    sigReconnectTimer = setTimeout(() => { connectSignaling(); }, sigReconnectDelay);
    sigReconnectDelay = Math.min(sigReconnectDelay * 2, 15000);
  }

  // 登出时停止重连并关闭连接
  function disconnectSignaling() {
    sigStopReconnect = true;
    clearTimeout(sigReconnectTimer);
    if (sigSocket) { try { sigSocket.close(); } catch {} sigSocket = null; }
  }

  function subscribePresence() {
    if (!sigSocket || sigSocket.readyState !== WebSocket.OPEN) return;
    presenceFriends = new Set(friends.map((f) => f.id));
    sigSocket.send(JSON.stringify({ type: "presence", friends: [...presenceFriends] }));
  }

  async function onSignalMessage(m) {
    console.log("[SIG-CLIENT] recv:", m.type, m.fromUsername ? "from=" + m.fromUsername : "", m.from ? "fromId=" + m.from : "");
    switch (m.type) {
      case "welcome":
        myId = m.userId;
        trySyncAll(); // 拿到 myId 后补算离线未读（好友列表可能尚未就绪，trySyncAll 内部会再判）
        break;
      case "presence":
        updateFriendOnline(m.userId, m.online);
        break;
      case "friend-request":
        // 收到好友请求：弹提示并刷新请求列表（对方主动发来，实时提醒）
        try { toast(`收到 ${m.fromUsername || "好友"} 的好友请求`); } catch (e) { console.error("[SIG-CLIENT] toast 失败:", e); }
        try { loadFriends(); } catch (e) { console.error("[SIG-CLIENT] loadFriends 失败:", e); }
        break;
      case "friend-accepted":
        // 对方通过了我的好友请求：弹提示并刷新好友列表
        try { toast(`${m.fromUsername || "好友"} 已通过你的好友请求`); } catch (e) { console.error("[SIG-CLIENT] toast 失败:", e); }
        try { loadFriends(); } catch (e) { console.error("[SIG-CLIENT] loadFriends 失败:", e); }
        break;
      case "incoming-call":
        handleIncomingCall(m.from, m.media);
        break;
      case "call-offline":
        if (currentPeer === m.to) {
          setChatStatus("对方不在线（可发送离线消息）", "warn");
          clearEntering();
          // 离线也允许输入：消息会存到服务端 KV，对方上线后可收取
        }
        break;
      case "signal":
        handleSignal(m.data, m.from);
        break;
      case "chat":
        clearEntering();
        onChatReceived({
          id: m.id || crypto.randomUUID(),
          from: m.from,
          to: myId,
          text: m.text,
          ts: m.ts || Date.now(),
        });
        break;
      case "group-chat":
        // 群消息：来自群内某成员，按群会话渲染或累计未读
        onGroupMessage({
          id: m.id || crypto.randomUUID(),
          groupId: m.groupId,
          from: m.from,
          text: m.text,
          ts: m.ts || Date.now(),
        });
        break;
      case "group-invite":
        // 被加入群聊：刷新群列表（并补算未读），把该群会话前置
        try { toast(`你被拉入群聊「${m.group?.name || "群聊"}」`); } catch {}
        try {
          await loadGroups();
          if (m.group && m.group.id != null) {
            upsertConversation("group", m.group.id, Date.now(), null, false);
          }
        } catch {}
        break;
      case "group-updated":
        // 群名称被群主修改：刷新群列表；若正在查看该群则同步详情页
        try {
          await loadGroups();
          if (chatMode === "group" && Number(currentGroup) === m.group?.id && !groupView.hidden) {
            const g = groups.find((x) => x.id === m.group.id);
            if (g) showGroupDetail(g);
          }
        } catch {}
        break;
      case "group-call":
        // 群会议发起邀请：弹出“加入会议”提示（若已在同群会议中则忽略）
        onGroupCall(m.groupId, m.from, m.media);
        break;
      case "group-join":
        // 有成员加入会议：与其建立连接（全网状）
        onGroupJoin(m.groupId, m.from);
        break;
      case "group-leave":
        // 有成员离开会议：清理其瓦片与连接
        onGroupLeave(m.groupId, m.from);
        break;
      case "peer-left":
        if (currentPeer === m.from) {
          setChatStatus("对方已结束对话（仍可发送离线消息）", "warn");
        }
        if (callPeerId === m.from) endCallLocal(); // 对方整体断开：清理进行中的通话
        // 群会议中的成员：其连接由会议生命周期管理（离开用 group-leave），
        // 不应因对方结束 1:1 会话的 bye 而被拆除；连接失败会由 ICE 状态清理瓦片。
        if (meetingActive && meetingMembers.has(Number(m.from))) break;
        dropPeerConn(m.from); // 关闭该好友连接，不影响其它好友
        break;
      case "error":
        setChatStatus("错误：" + m.error, "warn");
        break;
      case "ping":
        try { sigSocket.send(JSON.stringify({ type: "pong" })); } catch {}
        break;
    }
  }

  // ---------- 好友列表 / 请求 ----------
  async function loadFriends() {
    try {
      const data = await api("/api/friends");
      friends = data.friends || [];
      friendRequests = data.requests || [];
      renderFriends();
      subscribePresence();
      trySyncAll(); // 好友列表就绪后，补算离线/重开期间漏掉的未读红点（myId 可能尚未就绪，trySyncAll 内部会再判）
    } catch (e) {
      // 鉴权失效等：忽略，面板仍可用（点击好友时会再次尝试）
    }
  }
  function updateFriendOnline(userId, online) {
    const f = friends.find((x) => x.id === userId);
    if (!f) return;
    f.online = online;
    // 在线状态变化只原地切换小圆点，避免整列重建导致点击竞态（mousedown→mouseup 之间行被替换丢 click）
    const row = friendListEl && friendListEl.querySelector('.friend-row[data-uid="' + userId + '"]');
    if (row) {
      const dot = row.querySelector(".dot");
      if (dot) dot.className = "dot " + (online ? "on" : "off");
    } else {
      renderFriends();
    }
    // 会话行内的在线小圆点同步原地更新（peer 类型）
    const convRow = convListEl && convListEl.querySelector('.conv-row[data-cid="' + userId + '"][data-ctype="peer"] .dot');
    if (convRow) convRow.className = "dot " + (online ? "on" : "off");
  }
  // 原地更新某会话行的未读角标，避免收到消息时整列重建引发点击竞态
  function patchConvUnread(peerId, count) {
    if (!convListEl) return;
    const row = convListEl.querySelector('.conv-row[data-cid="' + peerId + '"]');
    if (!row) return;
    let badge = row.querySelector(".unread-badge");
    if (count > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "unread-badge";
        row.appendChild(badge);
      }
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.title = count + " 条未读";
    } else if (badge) {
      badge.remove();
    }
  }
  // 未读消息计数（红点提醒）：内存 + IndexedDB 双写，刷新后仍在
  async function loadUnread() {
    if (currentUserId == null) return;
    try { unread = (await ChatDB.getMeta("unread:" + currentUserId, {})) || {}; } catch { unread = {}; }
  }
  async function saveUnread() {
    if (currentUserId == null) return;
    try { await ChatDB.setMeta("unread:" + currentUserId, unread); } catch {}
  }
  function bumpUnread(peerId, n) {
    peerId = Number(peerId);
    n = Number(n) || 1;
    unread[peerId] = (unread[peerId] || 0) + n;
    saveUnread();
    updateUnreadTitle();
    patchConvUnread(peerId, unread[peerId]);
  }
  function addUnread(peerId) {
    peerId = Number(peerId);
    console.log("[UNREAD-DEBUG] addUnread", { peerId, peerIdType: typeof peerId, unread: JSON.parse(JSON.stringify(unread)), friends: friends.map((f) => ({ id: f.id, t: typeof f.id, name: f.username })) });
    bumpUnread(peerId, 1);
  }
  // 仅在「已拿到 myId 且好友列表已加载」两个前置都满足时才补算离线未读/拉离线消息。
  // 解决：onopen 时 myId 尚未就绪（welcome 是后续 onmessage）、loadFriends 时 myId 可能尚未就绪，
  // 二者任一先到都不应提前 return 而漏掉同步；二者齐备后必跑一次。
  function trySyncAll() {
    if (myId == null || friends.length === 0) {
      console.log("[UNREAD-DEBUG] trySyncAll skipped (前置未齐备)", { myId, friendsLen: friends.length });
      return;
    }
    syncAllUnread();
  }
  // 离线 / 重开页面后：从服务端 KV 拉取本地缺失的消息，补算未读红点。
  // 触发：进入应用(loadFriends 后)、信令重连(onopen)、浏览器恢复在线(online 事件)。
  // 以「本地该会话最新 ts」为 since 向服务端取增量，自己发的消息不计入未读，本地已有的不重复计。
  async function syncAllUnread() {
    if (syncingAll) return;
    if (myId == null || friends.length === 0) return;
    syncingAll = true;
    console.log("[UNREAD-DEBUG] syncAllUnread start", { myId, friendsLen: friends.length, chatVisible, currentPeer });
    try {
      for (const f of friends) {
        const conv = convKeyLocal(myId, f.id);
        const since = await ChatDB.maxTs(conv);
        let msgs = [];
        let data = null;
        try {
          data = await api(`/api/messages?peer=${f.id}&since=${since}`);
          msgs = (data && data.messages) || [];
        } catch (e) { console.log("[UNREAD-DEBUG] syncAllUnread GET fail", f.username, String(e && e.message || e)); continue; }
        console.log("[UNREAD-DEBUG] syncAllUnread pull", { peer: f.username, peerId: f.id, since, pulled: msgs.length, stored: (data && data.stored) });
        const newPeerMsgs = [];
        let newCount = 0;
        for (const m of msgs) {
          if (m.from === myId) continue;            // 自己的消息不算未读
          if (await ChatDB.has(m.id)) continue;     // 本地已有，跳过（避免重复计）
          await ChatDB.put({ ...m, conv, synced: true }).catch(() => {});
          newCount++;
          newPeerMsgs.push(m);
        }
        if (newCount > 0) {
          // 关键：无论聊天面板是否打开，只要该好友会话「当前没被打开查看」，就始终累计未读红点。
          // 之前用 `!(chatVisible && currentPeer === f.id)` 作为 bump 的门槛，导致用户一打开该好友会话
          // （currentPeer 已指向对方）时，离线补算被静默跳过 → 离线消息有、红点无。
          const viewing = chatVisible && Number(currentPeer) === Number(f.id);
          console.log("[UNREAD-DEBUG] syncAllUnread +unread", f.username, newCount, "viewing=", viewing);
          if (viewing) {
            // 该会话正打开：新消息立即渲染并标记为已读，不残留红点
            for (const m of newPeerMsgs) {
              if (!renderedIds.has(m.id)) {
                renderedIds.add(m.id);
                renderMessageRow("peer", m.text, m.ts);
              }
            }
            clearUnread(f.id);
          } else {
            bumpUnread(f.id, newCount);   // 未打开该好友：累计未读红点（离线消息核心通知）
          }
        }
      }
    } finally {
      syncingAll = false;
    }
  }
  function clearUnread(peerId) {
    peerId = Number(peerId);
    console.log("[UNREAD-DEBUG] clearUnread", { peerId, had: !!unread[peerId], unread: JSON.parse(JSON.stringify(unread)) });
    if (unread[peerId]) {
      delete unread[peerId];
      saveUnread();
      updateUnreadTitle();
      renderFriends();
    }
  }
  // 未读总数提醒：① 顶栏 💬 按钮上的红点徽标（抽屉关闭也始终可见）② 浏览器标签标题前缀
  const BASE_TITLE = "Web 应用导航面板";
  function updateUnreadTitle() {
    let total = 0;
    for (const k in unread) total += unread[k] || 0;
    for (const k in groupUnread) total += groupUnread[k] || 0;
    document.title = total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
    if (chatUnreadBadge) {
      if (total > 0) {
        chatUnreadBadge.textContent = total > 99 ? "99+" : String(total);
        chatUnreadBadge.hidden = false;
      } else {
        chatUnreadBadge.hidden = true;
      }
    }
    updateTabBadges();
  }
  function renderFriends() {
    // 待通过请求
    friendRequestsEl.innerHTML = "";
    if (friendRequests.length) {
      friendRequestsEl.hidden = false;
      friendRequests.forEach((r) => {
        const row = document.createElement("div");
        row.className = "req-row";
        const label = document.createElement("span");
        label.className = "req-name";
        label.textContent = `${r.username} 请求加你好友`;
        const btn = document.createElement("button");
        btn.className = "btn primary small";
        btn.textContent = "接受";
        btn.onclick = () => acceptRequest(r.id);
        row.appendChild(label);
        row.appendChild(btn);
        friendRequestsEl.appendChild(row);
      });
    } else {
      friendRequestsEl.hidden = true;
    }

    // 好友列表
    friendListEl.innerHTML = "";
    if (friends.length === 0) {
      friendEmptyEl.hidden = false;
    } else {
      friendEmptyEl.hidden = true;
        friends.forEach((f) => {
          const row = document.createElement("div");
          row.className = "friend-row" + (f.id === currentPeer ? " active" : "");
          row.dataset.uid = f.id;
          row.innerHTML =
            `<span class="avatar-wrap">` +
            `<span class="avatar sm">${renderAvatar(f.avatar, f.username.charAt(0).toUpperCase())}</span>` +
            `<span class="dot ${f.online ? "on" : "off"}"></span>` +
            `</span>` +
            `<span class="fname">${escapeHtml(f.username)}</span>` +
            `<button class="friend-remove" title="移除好友">✕</button>`;
        const open = () => showFriendDetail(f);
        row.onclick = open;
        row.querySelector(".friend-remove").onclick = (e) => {
          e.stopPropagation();
          removeFriend(f);
        };
        friendListEl.appendChild(row);
      });
    }
    renderConversations();
    updateTabBadges();
  }

  async function addFriend() {
    const username = friendSearch.value.trim();
    if (!username) return;
    try {
      const r = await api("/api/friends", { method: "POST", body: JSON.stringify({ username }) });
      friendSearch.value = "";
      toast(r.friend.status === "accepted"
        ? `已与 ${r.friend.username} 成为好友`
        : `已向 ${r.friend.username} 发送好友请求`);
      await loadFriends();
      // 新加好友（已成为好友）→ 把会话前置
      if (r.friend.status === "accepted") {
        const f = friends.find((x) => x.username === username);
        if (f) upsertConversation("peer", f.id, Date.now(), null, false);
      }
    } catch (e) {
      toast(e.message || "添加失败");
    }
  }
  async function acceptRequest(id) {
    try {
      const req = friendRequests.find((x) => x.id === id);
      await api("/api/friends/accept", { method: "POST", body: JSON.stringify({ requestId: id }) });
      toast("已添加为好友");
      await loadFriends();
      // 新加好友（对方通过请求）→ 把会话前置
      if (req) {
        const f = friends.find((x) => x.username === req.username);
        if (f) upsertConversation("peer", f.id, Date.now(), null, false);
      }
    } catch (e) {
      toast(e.message || "操作失败");
    }
  }
  async function removeFriend(f) {
    if (!confirm(`确定移除好友「${f.username}」？`)) return;
    try {
      await api("/api/friends/" + f.id, { method: "DELETE" });
      toast("已移除好友");
      if (currentPeer === f.id) endCurrent();
      await loadFriends();
    } catch (e) {
      toast(e.message || "操作失败");
    }
  }

  // ---------- 会话（1:1）----------
  async function openConversation(f) {
    // 切换好友时不再“结束”上一个好友的通话——网状连接下应保留其后台 P2P 通道，
    // 仅切换当前显示的会话；显式“结束对话”按钮才会调用 endCurrent。
    chatMode = "peer";
    currentGroup = null;
    chatGroupActions.hidden = true;
    clearUnread(f.id);
    currentPeer = f.id;
    chatVisible = true;
    chatPanel.hidden = false;
    document.body.classList.add("chat-open");
    switchChatTab("conversations");
    showChatView();
    currentPeerName = f.username;
    currentPeerAvatar = f.avatar || "";
    chatPeerName.textContent = f.username;
    renderAvatarInto($("#chatPeerAvatar"), f.avatar, f.username.charAt(0).toUpperCase());
    // 重置顶栏状态，避免从群聊切换过来时仍残留“群聊·X人”
    const p = peers.get(Number(f.id));
    if (p && (p.p2pReady || (p.pc && p.pc.connectionState === "connected"))) {
      setChatStatus("P2P 已直连 🔗", "ok");
    } else if (p && p.pc && p.pc.connectionState === "connecting") {
      setChatStatus("正在连接…", "warn");
    } else {
      setChatStatus(f.online ? "在线" : "离线", f.online ? "ok" : "");
    }
    enableChatInput();
    renderFriends();
    resetChatMessages(f.username);
    renderedIds = new Set();
    // 先渲染本地缓存（即时、离线可用）
    await loadConversation();
    await connectSignaling();
    if (!sigSocket) return;
    startCall(f.id, f.username);
    // 再从服务端拉取本地缺失的历史（保留 3 个月），合并到本地
    await syncConversation(f.id);
    // 拉取并渲染完成后，当前会话已是「已读」状态：清掉该好友红点，
    // 避免后台离线补算（syncAllUnread）在打开会话期间 bump 后残留红点。
    clearUnread(f.id);
    // 打开会话：确保该会话出现在列表（首次发起聊天时创建），不改已有排序
    ensureConversation("peer", f.id);
    updateCallButtons();
  }
  function reCall() {
    const f = friends.find((x) => x.id === currentPeer);
    if (f) startCall(f.id, f.username);
  }

  // ---------- 每好友一条独立连接（网状）：A 可与 B 直连，同时后台与 C 建连 ----------
  // currentPeer 仅表示“当前显示的是哪个会话”，来电绝不再改动它（避免抢界面）。
  function getPeerConn(id) { return peers.get(Number(id)); }
  function ensurePeerConn(id) {
    id = Number(id);
    let p = peers.get(id);
    if (!p) { p = { pc: null, dc: null, p2pReady: false, status: "new" }; peers.set(id, p); }
    return p;
  }
  // 关闭并移除某好友的连接（不影响其它好友）
  function dropPeerConn(id) {
    id = Number(id);
    const p = peers.get(id);
    if (!p) return;
    try { if (p.dc) p.dc.close(); } catch {}
    try { if (p.pc) p.pc.close(); } catch {}
    peers.delete(id);
    peerStreams.delete(id); // 一并清理缓存的远端流，避免会议网格残留旧流
  }
  // 仅清理某好友旧 pc/dc（用于重协商），保留 map 条目
  function teardownPeer(id) {
    id = Number(id);
    const p = peers.get(id);
    if (!p) return;
    p.p2pReady = false;
    try { if (p.dc) p.dc.close(); } catch {}
    try { if (p.pc) p.pc.close(); } catch {}
    p.pc = null; p.dc = null;
  }
  // 仅当该好友是当前显示会话时，才更新聊天状态栏（C 来电不得改动 B 的界面）
  function setPeerStatus(id, text, cls) {
    if (currentPeer != null && Number(currentPeer) === Number(id)) setChatStatus(text, cls);
  }

  // ===================== 语音 / 视频通话状态 =====================
  // 复用每个好友已有的 RTCPeerConnection（完美协商）：通话时动态 addTrack 触发重协商，
  // 无需为媒体另建连接；媒体控制（接听/拒绝/挂断）通过 signal(data.kind:"media") 兜底。
  let localStream = null;          // 本端媒体流（麦克风/摄像头）
  let callPeerId = null;           // 当前通话对象 userId
  let callType = null;             // "audio" | "video"
  let callState = "idle";          // idle | outgoing | incoming | active
  let callIsCaller = false;        // 本端是否为发起方
  let pendingRemoteStream = null;  // 来电未接听前缓存的远端流（避免提前播放音频）
  let micMuted = false;
  let camOff = false;
  let incomingCallFrom = null;     // 正在响铃的来电对象
  let incomingCallType = null;

  // ===================== 群会议（多人 WebRTC 全网状）=====================
  // 每个成员与群内其他在线成员各建一条 RTCPeerConnection（复用 peers map 与完美协商），
  // 无需媒体服务器；signal 仍按 userId 定向转发 SDP/ICE，“谁在会议里”由 group-call/join/leave 广播。
  let meetingActive = false;       // 是否正在群会议中
  let meetingGroupId = null;       // 会议所属群 id
  let meetingType = null;          // "audio" | "video"
  let meetingMembers = new Set();  // 会议成员 userId 集合（含自己 myId）
  // 待接听的群会议邀请（点击“加入”时用到）
  let pendingGroupCall = null;     // { groupId, from, media }

  function startCall(to, name, mediaType) {
    to = Number(to);
    enableChatInput();
    const p = ensurePeerConn(to);
    const st = p.pc ? p.pc.connectionState : null;
    const hasLive = p.pc && (st === "connected" || st === "connecting" || st === "new");
    // 媒体呼叫：始终通知对方（即便已有连接），用于弹出接听界面
    if (mediaType && sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "call", to, media: mediaType }));
    }
    if (hasLive) return; // 已有可用连接：不重复建连、不降级状态
    // 只有该好友是当前显示会话时，才显示“正在连接”
    if (currentPeer != null && Number(currentPeer) === to) {
      setChatStatus(`正在连接 ${name} …`, "warn");
      enteringMsg = addChatMessage("system", `正在连接 ${name} …`);
    }
    enableRelay(to);
    if (!mediaType && sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "call", to }));
    }
    startOffer(to, name);
  }

  function handleIncomingCall(from, media) {
    from = Number(from);
    const f = friends.find((x) => x.id === from) || { id: from, username: String(from), online: true, avatar: "" };
    const viewingThis = currentPeer != null && Number(currentPeer) === from && chatVisible;
    // 仅当正在查看该好友时才清未读；否则保留红点，由后续消息 onChatReceived 累加
    if (viewingThis) clearUnread(from);
    // 音视频来电：弹出接听界面（绝不改动 currentPeer，绝不抢当前显示的会话）
    if (media) {
      showIncomingCall(from, media, f);
      // 仍确保该好友 pc 就绪（应答方），便于后续协商媒体轨道
      const p = ensurePeerConn(from);
      if (!p.pc) { p.pc = new RTCPeerConnection(rtcConfig()); p.pc._peerId = from; setupPc(p); p.mediaAdded = false; }
      enableRelay(from);
      return;
    }
    const p = ensurePeerConn(from);
    // 若本端已有 offer（我方也曾主动呼叫该好友），回退为应答方，避免双向 offer 死锁
    if (p.pc && p.pc.signalingState === "have-local-offer") teardownPeer(from);
    // 准备该好友的连接（应答方）；绝不改动 currentPeer，绝不抢界面
    if (!p.pc) {
      p.pc = new RTCPeerConnection(rtcConfig());
      p.pc._peerId = from;
      setupPc(p);
      p.mediaAdded = false;
      if (viewingThis) {
        setChatStatus(`收到 ${f.username} 的聊天请求，连接中…`, "warn");
        clearEntering();
      }
    }
    enableRelay(from);
  }

  function endCurrent() {
    if (callState !== "idle") endCall(); // 退出会话时若正在通话，先通知对方并清理
    if (meetingActive) leaveGroupMeeting();
    if (sigSocket && currentPeer != null) {
      try { sigSocket.send(JSON.stringify({ type: "bye", to: currentPeer })); } catch {}
    }
    dropPeerConn(currentPeer); // 仅结束当前好友的通话，其它好友连接保持
    currentPeer = null;
    currentPeerName = "";
    currentPeerAvatar = "";
    chatPeerName.textContent = "选择一个好友开始聊天";
    renderAvatarInto($("#chatPeerAvatar"), "", "?");
    setChatStatus("未连接");
    disableChatInput();
    renderFriends();
  }

  // ---------- WebRTC（每好友独立 pc/dc）----------
  function startOffer(to, name) {
    to = Number(to);
    const p = ensurePeerConn(to);
    teardownPeer(to); // 清理该好友旧连接
    try {
      p.pc = new RTCPeerConnection(rtcConfig());
      p.pc._peerId = to;
      setupPc(p);
      p.mediaAdded = false;
      p.dc = p.pc.createDataChannel("chat");
      p.dc._peerId = to;
      setupDataChannel(p.dc);
      // 创建 DataChannel 会触发 onnegotiationneeded → 自动生成 offer（完美协商）
    } catch { enableRelay(to); }
  }

  function setupPc(p) {
    const id = p.pc._peerId;
    // 完美协商（Perfect Negotiation）状态位：避免双向同时发 offer 造成 glare
    p.makingOffer = false;
    p.ignoreOffer = false;
    // 由双方 userId 大小决定“礼貌方”，结果两端一致，可预判冲突归属
    p.polite = (myId != null) ? (myId < id) : true;
    p.pc.onicecandidate = (e) => { if (e.candidate) sendSignal(id, { candidate: e.candidate }); };
    // 新增/移除媒体轨道（addTrack）会自动触发本事件 → 生成新 offer（含媒体），无需另建连接
    p.pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await p.pc.setLocalDescription();
        sendSignal(id, { sdp: p.pc.localDescription });
      } catch (err) {
        console.error("[WEBRTC] negotiationneeded error:", (err && err.message) || err);
      } finally {
        p.makingOffer = false;
      }
    };
    p.pc.onconnectionstatechange = () => {
      p.status = p.pc.connectionState;
      if (p.pc.connectionState === "failed") {
        // 群会议中：某成员连接失败 → 清理其瓦片（对方可能已异常退出）
        if (meetingActive && meetingMembers.has(id)) {
          meetingMembers.delete(id);
          removeMeetingTile(id);
          try { if (p.pc) p.pc.close(); } catch {}
          peers.delete(id);
          updateMeetingCount();
          return;
        }
        p.p2pReady = false;
        setPeerStatus(id, "直连失败，改用中继", "warn");
        enableRelay(id);
      } else if (p.pc.connectionState === "connected") {
        setPeerStatus(id, "P2P 已直连 🔗", "ok");
      }
    };
    // 接收远端音视频轨道
    p.pc.ontrack = (e) => {
      const stream = e.streams && e.streams[0];
      if (!stream) return;
      // 始终缓存，供会议加入后补渲染（避免“先收到流、后加入会议”导致画面缺失）
      peerStreams.set(id, stream);
      // 群会议成员：直接渲染到会议网格（每个成员一条独立 pc）
      if (meetingActive && meetingMembers.has(id)) {
        attachMeetingStream(id, stream);
        return;
      }
      // 来电未接听前不要渲染/播放（尤其音频自动播放），先缓存，接听后再呈现
      if (callIsCaller || callState === "active") {
        attachRemoteStream(stream);
      } else if (callPeerId === id) {
        pendingRemoteStream = stream;
      }
    };
    p.pc.ondatachannel = (e) => {
      const ch = e.channel;
      ch._peerId = id;
      p.dc = ch;
      setupDataChannel(ch);
    };
  }

  async function handleSignal(data, from) {
    from = Number(from);
    if (!data) return;
    // 媒体控制信令（接听 / 拒绝 / 挂断）走独立通道，不参与 SDP/ICE 协商
    if (data.kind === "media") { handleMediaControl(data, from); return; }
    const p = ensurePeerConn(from);
    if (!p.pc) { p.pc = new RTCPeerConnection(rtcConfig()); p.pc._peerId = from; setupPc(p); }
    try {
      if (data.sdp) {
        const desc = new RTCSessionDescription(data.sdp);
        // 完美协商：检测 offer 冲突（本端正在发 offer 或连接非稳定态）
        const offerCollision = (desc.type === "offer") && (p.makingOffer || p.pc.signalingState !== "stable");
        p.ignoreOffer = !p.polite && offerCollision;
        if (p.ignoreOffer) {
          console.log("[WEBRTC] 忽略冲突 offer（impolite 方）", from);
          return;
        }
        try {
          // polite 方遇到冲突时，必须先回滚本地 offer 再接受对方 offer；
          // 否则 setRemoteDescription 在 have-local-offer 状态抛错，最终协商只保留一方媒体轨道（单向流）。
          if (offerCollision) {
            await p.pc.setLocalDescription({ type: "rollback" });
          }
          await p.pc.setRemoteDescription(desc);
          if (desc.type === "offer") {
            // 关键：主叫在收到“被叫已接听并 addTrack”的 offer 时，才补加本端媒体，
            // 使本次 answer 即携带主叫音视频。双方媒体在“单次协商(OFFER_B)”内完成，
            // 避免主叫先发 OFFER_A 含媒体、被叫接听又 OFFER_B 重复协商，导致主叫媒体流
            // 在重协商后失效、被叫端画面卡在失效的旧 MediaStream（单向流根因）。
            // 被叫侧此时 localStream 尚为 null（未接听），因此不会在此误加。
            if (localStream && !p.mediaAdded) addLocalMediaTracks(p);
            await p.pc.setLocalDescription(); // 自动生成 answer（含本端媒体）
            sendSignal(from, { sdp: p.pc.localDescription });
          }
        } catch (err) {
          console.error("[WEBRTC] setRemoteDescription error:", (err && err.message) || err);
          if (!p.ignoreOffer) enableRelay(from);
        }
      } else if (data.candidate) {
        p.pc.addIceCandidate(data.candidate).catch((err) => {
          if (!p.ignoreOffer) console.warn("[WEBRTC] addIceCandidate failed:", (err && err.message) || err);
        });
      }
    } catch (err) {
      console.error("[WEBRTC] handleSignal error:", (err && err.message) || err);
    }
  }

  function setupDataChannel(ch) {
    const id = ch._peerId;
    const p = peers.get(Number(id));
    ch.onopen = () => {
      if (p) p.p2pReady = true;
      clearEntering();
      setPeerStatus(id, "P2P 已直连 🔗", "ok");
      enableChatInput();
    };
    ch.onmessage = (e) => {
      const data = e.data;
      let m = null;
      try { const pp = JSON.parse(data); if (pp && pp.type === "chat") m = pp; } catch {}
      // 该数据通道专属于 id 这个好友，from 就是它（不再用全局 currentPeer）
      if (m) {
        onChatReceived({ id: m.id || crypto.randomUUID(), from: id, to: myId, text: m.text, ts: m.ts || Date.now() });
      } else {
        onChatReceived({ id: crypto.randomUUID(), from: id, to: myId, text: String(data), ts: Date.now() });
      }
    };
    ch.onclose = () => { if (p) p.p2pReady = false; setPeerStatus(id, "直连关闭，改用中继", "warn"); enableRelay(id); };
    ch.onerror = () => {};
  }

  function sendSignal(to, data) {
    to = Number(to);
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "signal", to, data }));
    }
  }

  function enableRelay(to) {
    relayActive = true;
    if (to != null) {
      const p = peers.get(Number(to));
      if (p) p.p2pReady = false;
      setPeerStatus(to, "中继模式（服务器转发）", "warn");
    } else {
      setChatStatus("中继模式（服务器转发）", "warn");
    }
    enableChatInput();
  }
  function enableChatInput() {
    chatInput.disabled = false; chatSendBtn.disabled = false; chatInput.focus();
  }
  function disableChatInput() {
    chatInput.disabled = true; chatSendBtn.disabled = true; relayActive = false;
  }

  // ===================== 语音 / 视频通话 =====================
  // 发起/接听/挂断逻辑；媒体轨道动态加入已有的 per-friend pc（完美协商自动重协商）。

  // 仅在「私聊 + 已打开会话 + 无进行中通话」时显示通话按钮
  function updateCallButtons() {
    const show = chatMode === "peer" && currentPeer != null && chatVisible && !chatView.hidden;
    const idle = callState === "idle";
    if (btnVoiceCall) btnVoiceCall.hidden = !(show && idle);
    if (btnVideoCall) btnVideoCall.hidden = !(show && idle);
    updateMeetingButtons();
  }

  async function startMediaCall(peerId, type) {
    peerId = Number(peerId);
    if (callState !== "idle") { toast("已有进行中的通话"); return; }
    if (meetingActive) { toast("请先离开当前群会议"); return; }
    const f = friends.find((x) => x.id === peerId);
    if (!f) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("当前浏览器不支持音视频通话"); return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (err) {
      toast("无法访问摄像头/麦克风：" + ((err && err.message) || err.name || err));
      return;
    }
    callPeerId = peerId;
    callType = type;
    callState = "outgoing";
    callIsCaller = true;
    micMuted = false; camOff = false;
    bindLocalVideo();
    showCallPanel(type, f);
    setCallStateLabel("等待对方接听…");
    updateCallButtons();
    // 建立 P2P 连接并通知对方（startCall 发送带 media 的 call）。
    // 注意：主叫不在此时 addTrack，而是等收到被叫“已接听”的 offer 时再补加本端媒体，
    // 让双方媒体在单次协商内完成（见 handleSignal 的 offer 分支），彻底避免单向流问题。
    startCall(peerId, f.username, type);
  }

  function addLocalMediaTracks(p) {
    if (!localStream || p.mediaAdded) return;
    for (const track of localStream.getTracks()) {
      try { p.pc.addTrack(track, localStream); } catch (e) { console.error("[WEBRTC] addTrack failed", e); }
    }
    p.mediaAdded = true;
  }

  function bindLocalVideo() {
    if (localVideo && localStream) localVideo.srcObject = localStream;
  }

  function showCallPanel(type, f) {
    if (!callPanel) return;
    callPanel.hidden = false;
    callPanel.dataset.type = type;
    if (callRemoteName) callRemoteName.textContent = (f && f.username) || String(callPeerId);
    if (callRemoteAvatar) {
      callRemoteAvatar.hidden = type !== "audio";
      if (type === "audio" && f) renderAvatarInto(callRemoteAvatar, f.avatar, (f.username || "?").charAt(0).toUpperCase());
    }
    if (remoteVideo) remoteVideo.hidden = type === "audio";
    if (btnCallMute) { btnCallMute.textContent = "🎤"; btnCallMute.classList.remove("off"); }
    if (btnCallCam) { btnCallCam.hidden = type !== "video"; btnCallCam.textContent = "📹"; btnCallCam.classList.remove("off"); }
  }

  function setCallStateLabel(text) {
    if (callStateLabel) callStateLabel.textContent = text || "";
  }

  function attachRemoteStream(stream) {
    if (!remoteVideo) return;
    if (callType === "audio") {
      remoteVideo.srcObject = stream;     // 语音通话：仍持有音频流，但隐藏视频画面
      remoteVideo.hidden = true;
      if (callRemoteAvatar) callRemoteAvatar.hidden = false;
    } else {
      remoteVideo.srcObject = stream;
      remoteVideo.hidden = false;
      if (callRemoteAvatar) callRemoteAvatar.hidden = true;
    }
    if (callState !== "active") {
      callState = "active";
      setCallStateLabel("通话中");
      updateCallButtons();
    }
  }

  function showIncomingCall(from, type, f) {
    if (!callIncoming) return;
    // 聊天面板未打开时，来电弹窗不可见——自动展开面板以便接听
    if (chatPanel.hidden) {
      chatPanel.hidden = false;
      document.body.classList.add("chat-open");
      chatVisible = true;
    }
    // 已有其它通话进行中：直接拒绝对方，避免多路并发
    if (callState !== "idle" && callState !== "incoming") {
      if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
        sigSocket.send(JSON.stringify({ type: "signal", to: from, data: { kind: "media", action: "decline" } }));
      }
      return;
    }
    incomingCallFrom = from;
    incomingCallType = type;
    callState = "incoming";
    if (incomingName) incomingName.textContent = (f && f.username) || String(from);
    if (incomingType) incomingType.textContent = type === "video" ? "邀请你进行视频通话" : "邀请你进行语音通话";
    if (incomingAvatar) renderAvatarInto(incomingAvatar, f && f.avatar, ((f && f.username) || "?").charAt(0).toUpperCase());
    callIncoming.hidden = false;
    try { playRingtone(); } catch {}
  }

  function hideIncomingCall() {
    if (callIncoming) callIncoming.hidden = true;
  }

  async function acceptCall() {
    const from = incomingCallFrom;
    const type = incomingCallType;
    if (from == null) return;
    hideIncomingCall();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("当前浏览器不支持音视频通话"); declineCall(); return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (err) {
      toast("无法访问摄像头/麦克风：" + ((err && err.message) || err.name || err));
      declineCall(); return;
    }
    callPeerId = from;
    callType = type;
    callState = "active";
    callIsCaller = false;
    micMuted = false; camOff = false;
    bindLocalVideo();
    const f = friends.find((x) => x.id === from) || { username: String(from), avatar: "" };
    showCallPanel(type, f);
    setCallStateLabel("通话中");
    // 来电前已协商下来的远端流，接听后立刻呈现
    if (pendingRemoteStream) { attachRemoteStream(pendingRemoteStream); pendingRemoteStream = null; }
    // 向已有 pc 加入本端轨道 → 触发重协商（完美协商处理 glare）
    const p = getPeerConn(from);
    if (p && p.pc) addLocalMediaTracks(p);
  }

  function declineCall() {
    const from = incomingCallFrom;
    hideIncomingCall();
    if (from != null && sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "signal", to: from, data: { kind: "media", action: "decline" } }));
    }
    resetCallState();
  }

  // 本端主动挂断：通知对方并本地清理
  function endCall() {
    if (callPeerId != null && sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "signal", to: callPeerId, data: { kind: "media", action: "end" } }));
    }
    endCallLocal();
  }

  // 本地清理（用于收到对方结束/拒接，或本地挂断后）：停止轨道、移除发送器、复位 UI
  function endCallLocal() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (callPeerId != null) {
      const p = getPeerConn(callPeerId);
      if (p && p.pc) {
        p.pc.getSenders().forEach((s) => { try { if (s.track) p.pc.removeTrack(s); } catch {} });
        p.mediaAdded = false;
      }
    }
    if (remoteVideo) remoteVideo.srcObject = null;
    if (localVideo) localVideo.srcObject = null;
    if (callPanel) callPanel.hidden = true;
    resetCallState();
  }

  function resetCallState() {
    callPeerId = null;
    callType = null;
    callState = "idle";
    callIsCaller = false;
    pendingRemoteStream = null;
    micMuted = false; camOff = false;
    incomingCallFrom = null;
    incomingCallType = null;
    updateCallButtons();
  }

  function handleMediaControl(data, from) {
    from = Number(from);
    if (data.action === "decline") {
      if (callIsCaller && callPeerId === from) {
        toast("对方拒绝了通话");
        endCallLocal();
      }
    } else if (data.action === "end") {
      if (callPeerId === from) {
        toast("对方已结束通话");
        endCallLocal();
      }
    }
  }

  function toggleMute() {
    if (!localStream) return;
    micMuted = !micMuted;
    localStream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
    if (btnCallMute) {
      btnCallMute.textContent = micMuted ? "🔇" : "🎤";
      btnCallMute.classList.toggle("off", micMuted);
    }
  }

  function toggleCamera() {
    if (!localStream || callType !== "video") return;
    camOff = !camOff;
    localStream.getVideoTracks().forEach((t) => { t.enabled = !camOff; });
    if (btnCallCam) {
      btnCallCam.textContent = camOff ? "🚫" : "📹";
      btnCallCam.classList.toggle("off", camOff);
    }
  }

  // ===================== 群会议（多人 WebRTC 全网状）=====================
  // 每个成员与群内其他在线成员各建一条 RTCPeerConnection（复用 peers map 与完美协商），
  // 无需媒体服务器；SDP/ICE 仍走 signal（按 userId 定向），“谁在会议里”由 group-call/join/leave 广播。
  async function startGroupMeeting(groupId, type) {
    groupId = Number(groupId);
    type = type === "audio" ? "audio" : "video";
    if (callState !== "idle") { toast("请先结束当前通话"); return; }
    if (meetingActive) { toast("已在会议中"); return; }
    const g = groups.find((x) => x.id === groupId);
    if (!g) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("当前浏览器不支持音视频会议"); return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (err) {
      toast("无法访问摄像头/麦克风：" + ((err && err.message) || err.name || err));
      return;
    }
    meetingActive = true;
    meetingGroupId = groupId;
    meetingType = type;
    meetingMembers = new Set([myId]);
    micMuted = false; camOff = false;
    bindMeetingLocal();
    showMeetingPanel(g);
    // 与所有在线成员建立连接（各建一条 pc，立即携带本端媒体）
    const others = (g.members || []).filter((m) => m.id !== myId && m.online);
    others.forEach((m) => connectMeetingPeer(m.id));
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "group-call", groupId, media: type }));
    }
    toast("已发起群会议，正在呼叫在线成员…");
    updateMeetingButtons();
  }

  async function joinGroupMeeting(groupId, type, from) {
    groupId = Number(groupId);
    type = type === "audio" ? "audio" : "video";
    if (callState !== "idle") { toast("请先结束当前通话"); return; }
    if (meetingActive && meetingGroupId !== groupId) { toast("已在其它群会议中"); return; }
    const g = groups.find((x) => x.id === groupId);
    if (!g) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("当前浏览器不支持音视频会议"); return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (err) {
      toast("无法访问摄像头/麦克风：" + ((err && err.message) || err.name || err));
      return;
    }
    meetingActive = true;
    meetingGroupId = groupId;
    meetingType = type;
    meetingMembers = meetingMembers || new Set();
    meetingMembers.add(myId);
    micMuted = false; camOff = false;
    bindMeetingLocal();
    showMeetingPanel(g);
    // 与所有在线成员建立连接（含发起者与各成员），保证全网状
    const others = (g.members || []).filter((m) => m.id !== myId && m.online);
    others.forEach((m) => connectMeetingPeer(m.id));
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "group-join", groupId }));
    }
    hideGroupCallInvite();
    updateMeetingButtons();
  }

  // 与某一群成员建立（或复用）一条带媒体的 pc；全网状核心：每人各持一条到其它成员的 pc
  function connectMeetingPeer(memberId) {
    memberId = Number(memberId);
    if (memberId === myId || !meetingActive) return;
    const p = ensurePeerConn(memberId);
    const st = p.pc ? p.pc.connectionState : null;
    // 已连接 / 连接中：无需重建，仅兼容“迟到补加媒体”，并补渲染已缓存的远端流
    if (p.pc && (st === "connected" || st === "connecting" || st === "new")) {
      if (localStream && !p.mediaAdded) addLocalMediaTracks(p);
      if (peerStreams.has(memberId)) attachMeetingStream(memberId, peerStreams.get(memberId));
      return;
    }
    teardownPeer(memberId);
    try {
      p.pc = new RTCPeerConnection(rtcConfig());
      p.pc._peerId = memberId;
      setupPc(p);
      p.mediaAdded = false;
      // 群会议：立即携带本端媒体（mesh 每人各自带媒体，无需等对方先发 offer），触发协商
      if (localStream) addLocalMediaTracks(p);
      meetingMembers.add(memberId);
      // 若该成员此前已发来流（先于本端加入会议到达），补渲染到网格
      if (peerStreams.has(memberId)) attachMeetingStream(memberId, peerStreams.get(memberId));
    } catch (e) {
      console.error("[MEETING] connectMeetingPeer 失败", memberId, e);
    }
  }

  function bindMeetingLocal() {
    if (meetingLocalVideo && localStream) meetingLocalVideo.srcObject = localStream;
    if (meetingPanel) {
      meetingPanel.dataset.type = meetingType || "video";
      if (btnMeetingCam) btnMeetingCam.hidden = meetingType !== "video";
    }
  }

  function showMeetingPanel(g) {
    if (!meetingPanel) return;
    meetingPanel.hidden = false;
    if (meetingGroupName) meetingGroupName.textContent = (g && g.name) || "群会议";
    updateMeetingCount();
  }

  function updateMeetingCount() {
    if (!meetingCount) return;
    meetingCount.textContent = meetingMembers.size + " 人";
  }

  // 将某成员的远端流挂到会议网格的一个瓦片里（按 userId 区分）
  function attachMeetingStream(id, stream) {
    if (!meetingGrid) return;
    let tile = meetingGrid.querySelector('.meeting-tile[data-uid="' + id + '"]');
    if (!tile) {
      tile = document.createElement("div");
      tile.className = "meeting-tile";
      tile.dataset.uid = id;
      const v = document.createElement("video");
      v.className = "meeting-video";
      v.autoplay = true; v.playsInline = true;
      const nm = document.createElement("span");
      nm.className = "meeting-name";
      const info = groupMemberName(meetingGroupId, id);
      nm.textContent = info.name || String(id);
      tile.appendChild(v);
      tile.appendChild(nm);
      const init = (info.name || String(id)).trim().charAt(0).toUpperCase();
      tile.dataset.initial = init || "?";
      meetingGrid.appendChild(tile);
      updateMeetingCount();
    }
    const v = tile.querySelector("video");
    if (v.srcObject !== stream) v.srcObject = stream;
  }

  function removeMeetingTile(id) {
    if (!meetingGrid) return;
    const tile = meetingGrid.querySelector('.meeting-tile[data-uid="' + id + '"]');
    if (tile) tile.remove();
    updateMeetingCount();
  }

  function clearMeetingTiles() {
    if (!meetingGrid) return;
    meetingGrid.querySelectorAll(".meeting-tile:not(.self)").forEach((t) => t.remove());
  }

  function leaveGroupMeeting() {
    if (!meetingActive) return;
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "group-leave", groupId: meetingGroupId }));
    }
    // 关闭所有会议成员 pc（同时清理 peers map 条目，避免与 1:1 连接互相污染）
    for (const id of meetingMembers) {
      if (id !== myId) dropPeerConn(id);
    }
    clearMeetingTiles();
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    meetingActive = false;
    meetingGroupId = null;
    meetingType = null;
    meetingMembers = new Set();
    if (meetingPanel) meetingPanel.hidden = true;
    if (meetingLocalVideo) meetingLocalVideo.srcObject = null;
    updateMeetingButtons();
  }

  // ---- 收到群会议广播 ----
  function onGroupCall(groupId, from, media) {
    groupId = Number(groupId);
    if (meetingActive && meetingGroupId === groupId) return; // 已在同群会议中，忽略
    const g = groups.find((x) => x.id === groupId);
    const info = groupMemberName(groupId, from);
    showGroupCallInvite(g, from, media, info.name);
  }
  function onGroupJoin(groupId, from) {
    from = Number(from);
    if (!meetingActive || meetingGroupId !== Number(groupId)) return;
    connectMeetingPeer(from);
  }
  function onGroupLeave(groupId, from) {
    from = Number(from);
    if (!meetingActive || meetingGroupId !== Number(groupId)) return;
    meetingMembers.delete(from);
    removeMeetingTile(from);
    dropPeerConn(from);
    updateMeetingCount();
  }

  function showGroupCallInvite(g, from, media, name) {
    if (!groupCallInvite) return;
    pendingGroupCall = { groupId: g ? g.id : null, from, media: media || "video" };
    if (groupCallName) groupCallName.textContent = (name || "群成员") + " 邀请你加入群会议";
    if (groupCallType) groupCallType.textContent = (media === "audio" ? "语音" : "视频") + "会议 · " + (g ? g.name : "群聊");
    if (groupCallAvatar) {
      const info = groupMemberName(pendingGroupCall.groupId, from);
      renderAvatarInto(groupCallAvatar, info.avatar, (name || "?").charAt(0).toUpperCase());
    }
    groupCallInvite.hidden = false;
  }
  function hideGroupCallInvite() {
    if (groupCallInvite) groupCallInvite.hidden = true;
    pendingGroupCall = null;
  }

  function toggleMeetingMute() {
    if (!localStream) return;
    micMuted = !micMuted;
    localStream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
    if (btnMeetingMute) {
      btnMeetingMute.textContent = micMuted ? "🔇" : "🎤";
      btnMeetingMute.classList.toggle("off", micMuted);
    }
  }
  function toggleMeetingCam() {
    if (!localStream || meetingType !== "video") return;
    camOff = !camOff;
    localStream.getVideoTracks().forEach((t) => { t.enabled = !camOff; });
    if (btnMeetingCam) {
      btnMeetingCam.textContent = camOff ? "🚫" : "📹";
      btnMeetingCam.classList.toggle("off", camOff);
    }
  }

  function updateMeetingButtons() {
    const inGroupChat = chatMode === "group" && currentGroup != null && chatVisible && !chatView.hidden && !meetingActive;
    const inGroupDetail = chatMode === "group" && currentGroup != null && chatVisible && !groupView.hidden && !meetingActive;
    if (groupMeetingBtn) groupMeetingBtn.hidden = !inGroupChat;
    if (groupMeetingBtn2) groupMeetingBtn2.hidden = !inGroupDetail;
  }

  // 用 WebAudio 生成短促提示音，避免依赖外部音频文件
  function playRingtone() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 660;
      g.gain.value = 0.05;
      o.start();
      setTimeout(() => { try { o.stop(); ctx.close(); } catch {} }, 600);
    } catch {}
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    if (chatMode === "group") { sendGroupChat(text); return; }
    if (currentPeer == null) { setChatStatus("请先选择一个好友", "warn"); return; }
    if (myId == null) { setChatStatus("连接中，请稍候…", "warn"); return; }
    const id = crypto.randomUUID();
    const ts = Date.now();
    const msg = { id, from: myId, to: currentPeer, text, ts, synced: false };
    // 总是先本地渲染 + 落 IndexedDB + 补推到服务端：
    // 这样即使对方当前离线、实时通道不可用，消息也会存到服务端 KV，
    // 待对方上线后由其拉取（离线消息），不会丢失。
    renderedIds.add(id);
    renderMessageRow("me", text, ts);
    ChatDB.put(msg).then(() => flushPending());
    // 若实时通道可用，额外实时送达（对方在线时立即可见）
    const peer = friends.find((f) => f.id === currentPeer);
    let delivered = false;
    const p = getPeerConn(currentPeer);
    if (p && p.p2pReady && p.dc && p.dc.readyState === "open") {
      p.dc.send(JSON.stringify({ type: "chat", id, ts, text }));
      delivered = true;
    } else if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "chat", to: currentPeer, id, ts, text }));
      delivered = true;
    }
    // 在线则实时已送达；离线（通道不可用）则消息已存服务端，对方上线后接收
    if (delivered) {
      setChatStatus(peer && peer.online ? "已发送" : "已发送（对方可能离线，上线后接收）", "ok");
    } else {
      setChatStatus("已发送（离线消息，对方上线后接收）", "ok");
    }
    chatInput.value = "";
    chatInput.style.height = "auto";
    // 自己发送 → 会话前置并更新预览
    upsertConversation("peer", currentPeer, ts, text, false);
  }

  function addChatMessage(role, text, ts) {
    if (role === "system") {
      const empty = chatMessages.querySelector(".chat-empty");
      if (empty) empty.remove();
      const div = document.createElement("div");
      div.className = "chat-msg system";
      div.style.alignSelf = "center";
      div.style.background = "transparent";
      div.style.color = "var(--text-soft)";
      div.style.fontSize = "12px";
      div.textContent = text;
      chatMessages.appendChild(div);
      chatMessages.scrollTop = chatMessages.scrollHeight;
      return div;
    }
    return renderMessageRow(role, text, ts);
  }
  // 渲染一条 me/peer 消息气泡行
  // senderName / senderAvatar 仅在群聊中（role==="peer"）用于显示发送者名与头像
  function renderMessageRow(role, text, ts, senderName, senderAvatar) {
    const empty = chatMessages.querySelector(".chat-empty");
    if (empty) empty.remove();
    // 跨天插入日期分割
    maybeDateSeparator(ts);
    const isMe = role === "me";
    const row = document.createElement("div");
    row.className = "chat-msg-row " + (isMe ? "me" : "peer");

    const avatar = document.createElement("div");
    avatar.className = "chat-msg-avatar sm";
    const av = isMe ? myAvatar : (senderAvatar != null ? senderAvatar : currentPeerAvatar);
    const fb = isMe
      ? (currentUsername || "?").charAt(0).toUpperCase()
      : ((senderName || currentPeerName) || "?").charAt(0).toUpperCase();
    avatar.innerHTML = renderAvatar(av, fb);

    const bubble = document.createElement("div");
    bubble.className = "chat-msg " + (isMe ? "me" : "peer");
    if (!isMe && senderName) {
      const sn = document.createElement("div");
      sn.className = "chat-msg-sender";
      sn.textContent = senderName;
      bubble.appendChild(sn);
    }
    const body = document.createElement("span");
    body.className = "chat-msg-text";
    body.textContent = text;
    bubble.appendChild(body);
    if (ts) {
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      bubble.appendChild(meta);
    }

    row.appendChild(avatar);
    row.appendChild(bubble);
    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return row;
  }

  // ---------- 本地缓存 + 与服务端同步 ----------
  // 收到一条消息（中继或 P2P）：写本地 IndexedDB，必要时渲染，并补推到服务端
  async function onChatReceived(m) {
    m.synced = false;
    await ChatDB.put(m).catch(() => {});
    flushPending();
    const viewing = chatVisible && currentPeer != null && Number(currentPeer) === Number(m.from);
    console.log("[UNREAD-DEBUG] onChatReceived", { from: m.from, fromType: typeof m.from, myId, currentPeer, chatVisible, viewing, text: String(m.text || "").slice(0, 20) });
    if (viewing) {
      // 正在看这个好友的对话：直接渲染为已读
      if (!renderedIds.has(m.id)) {
        renderedIds.add(m.id);
        renderMessageRow(m.from === myId ? "me" : "peer", m.text, m.ts);
      }
      // 新消息把会话前置（更新预览与排序）
      upsertConversation("peer", m.from, m.ts, m.text, false);
    } else if (m.from !== myId) {
      // 未选中该好友：累加未读红点提醒（持久化），并把会话前置
      addUnread(m.from);
      upsertConversation("peer", m.from, m.ts, m.text, false);
    }
  }
  // 打开会话时：先渲染本地缓存（即时、离线可用），再增量同步服务端
  async function loadConversation() {
    const conv = currentConv();
    if (!conv) return;
    const msgs = await ChatDB.allForConv(conv).catch(() => []);
    for (const m of msgs) {
      renderedIds.add(m.id);
      renderMessageRow(m.from === myId ? "me" : "peer", m.text, m.ts);
    }
  }
  // 从服务端拉取本地缺失的消息（since = 本地最新时间），合并进本地并渲染新增
  async function syncConversation(peerId) {
    const my = myId;
    if (my == null) return;
    try {
      const since = await ChatDB.maxTs(convKeyLocal(my, peerId));
      const data = await api(`/api/messages?peer=${peerId}&since=${since}`);
      for (const m of data.messages || []) {
        const exists = await ChatDB.has(m.id);
        await ChatDB.put({ ...m, synced: true }).catch(() => {});
        if (currentPeer === peerId && !renderedIds.has(m.id)) {
          renderedIds.add(m.id);
          if (!exists) renderMessageRow(m.from === myId ? "me" : "peer", m.text, m.ts);
        } else {
          renderedIds.add(m.id);
        }
      }
    } catch (e) {
      // 服务端不可用/未登录：本地缓存仍可用，稍后重连会自动重试
    }
  }
  // 把本地未同步的消息批量补推到服务端（按接收方分组；群消息按 groupId 分组）
  async function flushPending() {
    let unsynced;
    try { unsynced = await ChatDB.pending(); } catch { return; }
    if (!unsynced.length) return;
    const byTo = new Map();
    const byGroup = new Map();
    for (const m of unsynced) {
      if (typeof m.to === "string" && m.to.startsWith("g:")) {
        const gid = m.to.slice(2);
        const arr = byGroup.get(gid) || [];
        arr.push(m);
        byGroup.set(gid, arr);
      } else {
        const arr = byTo.get(m.to) || [];
        arr.push(m);
        byTo.set(m.to, arr);
      }
    }
    for (const [to, arr] of byTo) {
      try {
        await api("/api/messages", {
          method: "POST",
          body: JSON.stringify({ to, messages: arr.map((m) => ({ id: m.id, ts: m.ts, text: m.text })) }),
        });
        for (const m of arr) { m.synced = true; await ChatDB.put(m).catch(() => {}); }
      } catch (e) {
        // 推送失败（断网/未登录）：保留 synced=false，下次重连/online 再补推
      }
    }
    for (const [gid, arr] of byGroup) {
      try {
        await api(`/api/groups/${gid}/messages`, {
          method: "POST",
          body: JSON.stringify({ messages: arr.map((m) => ({ id: m.id, ts: m.ts, text: m.text })) }),
        });
        for (const m of arr) { m.synced = true; await ChatDB.put(m).catch(() => {}); }
      } catch (e) {
        // 推送失败：保留 synced=false，下次再补推
      }
    }
  }

  // ================= 群聊 =================
  function groupConvKey(gid) { return "g:" + gid; }

  function groupMemberName(gid, userId) {
    const g = groups.find((x) => x.id === gid);
    const m = g && g.members.find((x) => x.id === userId);
    return { name: m ? m.username : "用户", avatar: m ? m.avatar : "" };
  }

  // ---- 群未读（红点）----
  async function loadGroupUnread() {
    if (currentUserId == null) return;
    try { groupUnread = (await ChatDB.getMeta("groupUnread:" + currentUserId, {})) || {}; } catch { groupUnread = {}; }
  }
  async function saveGroupUnread() {
    if (currentUserId == null) return;
    try { await ChatDB.setMeta("groupUnread:" + currentUserId, groupUnread); } catch {}
  }
  function bumpGroupUnread(gid, n) {
    gid = Number(gid);
    n = Number(n) || 1;
    groupUnread[gid] = (groupUnread[gid] || 0) + n;
    saveGroupUnread();
    updateUnreadTitle();
    renderGroups();
  }
  function clearGroupUnread(gid) {
    gid = Number(gid);
    if (groupUnread[gid]) {
      delete groupUnread[gid];
      saveGroupUnread();
      updateUnreadTitle();
      renderGroups();
    }
  }

  // ---- 群列表加载 / 渲染 ----
  async function loadGroups() {
    try {
      const data = await api("/api/groups");
      groups = data.groups || [];
      renderGroups();
      syncAllGroupUnread();
    } catch (e) { /* 鉴权失效等：忽略 */ }
  }

  function renderGroups() {
    groupListEl.innerHTML = "";
    if (groups.length === 0) {
      groupEmptyEl.hidden = false;
    } else {
      groupEmptyEl.hidden = true;
      groups.forEach((g) => {
        const row = document.createElement("div");
        row.className = "group-row" + (chatMode === "group" && currentGroup === g.id ? " active" : "");
        const anyOnline = (g.members || []).some((m) => m.online);
        row.innerHTML =
          `<span class="avatar sm">${renderAvatar(g.avatar, (g.name || "?").charAt(0).toUpperCase())}</span>` +
          `<span class="gname">${escapeHtml(g.name)}</span>` +
          `<span class="gmeta">${(g.members || []).length}人</span>` +
          `<span class="dot ${anyOnline ? "on" : "off"}</span>`;
        row.onclick = () => showGroupDetail(g);
        groupListEl.appendChild(row);
      });
    }
    renderConversations();
  }

  // ---- 打开群会话 ----
  async function openGroupConversation(g) {
    chatMode = "group";
    currentGroup = g.id;
    currentGroupAvatar = g.avatar || "";
    currentPeer = null;
    chatVisible = true;
    chatPanel.hidden = false;
    document.body.classList.add("chat-open");
    switchChatTab("conversations");
    showChatView();
    chatPeerName.textContent = g.name;
    renderAvatarInto($("#chatPeerAvatar"), g.avatar, (g.name || "?").charAt(0).toUpperCase());
    chatGroupActions.hidden = false;
    setChatStatus(`群聊 · ${(g.members || []).length}人`, "");
    enableChatInput();
    renderGroups();
    renderFriends();
    updateMeetingButtons();
    resetChatMessages(g.name);
    groupRenderedIds = new Set();
    await loadGroupConversation(g.id);
    await syncGroupConversation(g.id);
    clearGroupUnread(g.id);
    // 打开群会话：确保该会话出现在列表（首次发起聊天时创建），不改已有排序
    ensureConversation("group", g.id);
  }

  // ---------- 统一会话（私聊 + 群聊）----------
  // 把 p2p 聊天与群聊都视为“会话”，统一成一张按最近活动排序的列表；
  // 会话可关闭（从列表移除，但好友/群本身保留），新消息或新好友会把会话前置。
  function convStorageKey() { return "convOrder:" + (currentUserId || "anon"); }
  function loadConversations() {
    try {
      const raw = localStorage.getItem(convStorageKey());
      const arr = raw ? JSON.parse(raw) : [];
      conversations = Array.isArray(arr) ? arr : [];
    } catch { conversations = []; }
  }
  function saveConversations() {
    try { localStorage.setItem(convStorageKey(), JSON.stringify(conversations)); } catch {}
  }
  // 把某会话提到列表最前（用于新消息/发消息/新好友等活跃场景）；open 参数保留但已不再由会话列表点击调用
  function upsertConversation(type, id, ts, text, open) {
    id = Number(id);
    ts = Number(ts) || Date.now();
    const idx = conversations.findIndex((c) => c.type === type && c.id === id);
    if (idx >= 0) {
      conversations[idx].lastTs = ts;
      if (text != null) conversations[idx].lastText = String(text);
      const [item] = conversations.splice(idx, 1);
      conversations.unshift(item);
    } else {
      conversations.unshift({ type, id, lastTs: ts, lastText: text != null ? String(text) : "" });
    }
    saveConversations();
    renderConversations();
    if (open) {
      if (type === "group") {
        const g = groups.find((x) => x.id === id);
        if (g) openGroupConversation(g);
      } else {
        const f = friends.find((x) => x.id === id);
        if (f) openConversation(f);
      }
    }
  }
  // 关闭（移除）一个会话：从列表移除；若正打开它则同时关闭聊天面板
  function removeConversation(type, id) {
    id = Number(id);
    const idx = conversations.findIndex((c) => c.type === type && c.id === id);
    if (idx < 0) return;
    const wasActive = (type === "group")
      ? (chatMode === "group" && Number(currentGroup) === id)
      : (chatMode === "peer" && Number(currentPeer) === id);
    conversations.splice(idx, 1);
    saveConversations();
    if (wasActive) {
      closeChat();
      chatMode = "peer";
      currentPeer = null;
      currentGroup = null;
      resetChatMessages();
    }
    renderConversations();
  }
  // 把时间戳格式化为会话列表右上角的时间：
  // 当天 → HH:mm；同年跨天 → MM/DD；跨年 → YYYY/MM/DD
  function formatConvTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return p2(d.getHours()) + ":" + p2(d.getMinutes());
    if (d.getFullYear() === now.getFullYear()) return p2(d.getMonth() + 1) + "/" + p2(d.getDate());
    return d.getFullYear() + "/" + p2(d.getMonth() + 1) + "/" + p2(d.getDate());
  }
  // 确保某会话存在于列表中：不存在则创建（插入顶部）；已存在则不动顺序（仅刷新高亮）。
  // 用于「从好友/群组列表发起聊天」——让空会话列表也能立即出现该行，同时不影响已有排序。
  function ensureConversation(type, id) {
    id = Number(id);
    const idx = conversations.findIndex((c) => c.type === type && c.id === id);
    if (idx < 0) {
      // 首次创建会话行时记录一次「打开时间」，用于会话列表右上角展示
      conversations.unshift({ type, id, lastTs: Date.now(), lastText: "", openTs: Date.now() });
      saveConversations();
    }
    // 已存在的会话：重新点击/打开不再更新打开时间（保持首次打开时记录的值）
    renderConversations();
  }
  function renderConversations() {
    if (!convListEl) return;
    convListEl.innerHTML = "";
    if (!conversations.length) {
      if (convEmptyEl) convEmptyEl.hidden = false;
      return;
    }
    if (convEmptyEl) convEmptyEl.hidden = true;
    for (const c of conversations) {
      const isGroup = c.type === "group";
      let name = "会话", avatar = "", online = false;
      if (isGroup) {
        const g = groups.find((x) => x.id === c.id);
        name = g ? g.name : "群聊";
        avatar = g ? (g.avatar || "") : "";
        online = g ? (g.members || []).some((m) => m.online) : false;
      } else {
        const f = friends.find((x) => x.id === c.id);
        name = f ? f.username : "好友";
        avatar = f ? (f.avatar || "") : "";
        online = f ? !!f.online : false;
      }
      const u = isGroup ? (groupUnread[c.id] || 0) : (unread[c.id] || 0);
      const active = isGroup
        ? (chatMode === "group" && Number(currentGroup) === c.id)
        : (chatMode === "peer" && Number(currentPeer) === c.id);
      const row = document.createElement("div");
      row.className = "conv-row" + (active ? " active" : "");
      row.dataset.cid = c.id;
      row.dataset.ctype = c.type;
      const badge = u > 0
        ? `<span class="unread-badge" title="${u} 条未读">${u > 99 ? "99+" : u}</span>`
        : "";
      const preview = escapeHtml((c.lastText || "").slice(0, 20));
      const showTs = c.openTs != null ? c.openTs : c.lastTs;
      const timeLabel = formatConvTime(showTs);
      row.innerHTML =
        `<span class="avatar-wrap">` +
        `<span class="avatar sm">${renderAvatar(avatar, (name || "?").charAt(0).toUpperCase())}</span>` +
        `<span class="dot ${online ? "on" : "off"}"></span>` +
        `</span>` +
        `<span class="conv-main">` +
        `<span class="conv-top">` +
        `<span class="conv-name">${isGroup ? "👥 " : ""}${escapeHtml(name)}</span>` +
        (timeLabel ? `<span class="conv-time">${timeLabel}</span>` : "") +
        `</span>` +
        `<span class="conv-preview">${preview}</span>` +
        `</span>` +
        badge +
        `<button class="conv-close" title="关闭会话">✕</button>`;
      const open = () => {
        if (c.type === "group") {
          const g = groups.find((x) => x.id === c.id);
          if (g) openGroupConversation(g);
        } else {
          const f = friends.find((x) => x.id === c.id);
          if (f) openConversation(f);
        }
      };
      row.onclick = open;
      row.querySelector(".conv-close").onclick = (e) => {
        e.stopPropagation();
        removeConversation(c.type, c.id);
      };
      convListEl.appendChild(row);
    }
  }

  // ---------- Tab 栏切换（会话 / 好友 / 群组）----------
  function switchChatTab(name) {
    chatTabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    tabPanels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
  }
  function setTabBadge(el, count) {
    if (!el) return;
    if (count > 0) {
      el.textContent = count > 99 ? "99+" : String(count);
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
  // 更新各 Tab 上的徽标：会话=总未读、群组=群未读、好友=待处理请求数
  function updateTabBadges() {
    let convTotal = 0;
    for (const k in unread) convTotal += unread[k] || 0;
    for (const k in groupUnread) convTotal += groupUnread[k] || 0;
    setTabBadge(tabConvBadge, convTotal);
    setTabBadge(tabFriendBadge, friendRequests.length);
  }

  // ---------- 聊天主区域三视图切换 ----------
  // 默认聊天视图（会话 Tab 进入聊天时使用）
  function showChatView() {
    chatView.hidden = false;
    friendView.hidden = true;
    groupView.hidden = true;
    updateCallButtons();
    updateMeetingButtons();
  }
  // 点击好友列表项 → 右侧显示好友资料/设置页（不直接进入聊天）
  function showFriendDetail(f) {
    chatVisible = true;
    chatPanel.hidden = false;
    document.body.classList.add("chat-open");
    renderAvatarInto(friendDetailAvatar, f.avatar, (f.username || "?").charAt(0).toUpperCase());
    friendDetailName.textContent = f.username;
    friendDetailStatus.textContent = f.online ? "在线" : "离线";
    chatView.hidden = true;
    friendView.hidden = false;
    groupView.hidden = true;
    updateCallButtons();
    friendMessageBtn.onclick = () => openConversation(f);
    friendRemoveBtn.onclick = async () => {
      await removeFriend(f);
      friendView.hidden = true;
      chatView.hidden = false;
    };
  }
  // 点击群组列表项 → 右侧显示群组资料/设置页（不直接进入聊天）
  function showGroupDetail(g) {
    chatVisible = true;
    chatPanel.hidden = false;
    document.body.classList.add("chat-open");
    currentGroup = g.id; // 供设置页内的「退出/添加成员」操作使用
    renderAvatarInto(groupDetailAvatar, g.avatar, (g.name || "?").charAt(0).toUpperCase());
    groupDetailName.textContent = g.name;
    const members = g.members || [];
    groupDetailMeta.textContent = `${members.length} 名成员`;
    groupDetailMembers.innerHTML = "";
    members.forEach((m) => {
      const row = document.createElement("div");
      row.className = "member-row";
      row.innerHTML =
        `<span class="avatar sm">${renderAvatar(m.avatar, (m.username || "?").charAt(0).toUpperCase())}</span>` +
        `<span class="mname">${escapeHtml(m.username)}</span>` +
        (m.id === g.ownerId ? `<span class="owner-tag">群主</span>` : "");
      groupDetailMembers.appendChild(row);
    });
    chatView.hidden = true;
    friendView.hidden = true;
    groupView.hidden = false;
    updateCallButtons();
    updateMeetingButtons();
    groupMessageBtn.onclick = () => openGroupConversation(g);
    groupAddMemberBtn2.onclick = () => openAddMemberModal();
    groupLeaveBtn2.onclick = async () => {
      await leaveCurrentGroup();
      groupView.hidden = true;
      chatView.hidden = false;
    };
    // 仅群主可见「修改群名称」按钮
    const isOwner = g.ownerId === currentUserId;
    groupRenameBtn.hidden = !isOwner;
    if (isOwner) groupRenameBtn.onclick = () => startRenameGroup(g);
  }

  // 群名称编辑：仅群主，就地编辑
  function startRenameGroup(g) {
    groupDetailName.hidden = true;
    groupNameEdit.value = g.name || "";
    groupNameEdit.hidden = false;
    groupRenameBtn.hidden = true;
    groupNameEdit.focus();
    groupNameEdit.select();
  }
  function cancelGroupRename() {
    groupNameEdit.hidden = true;
    groupDetailName.hidden = false;
    const g = groups.find((x) => x.id === currentGroup);
    groupRenameBtn.hidden = !(g && g.ownerId === currentUserId);
  }
  async function saveGroupRename(g) {
    const name = groupNameEdit.value.trim();
    if (!name) { cancelGroupRename(); return; }
    try {
      const res = await api(`/api/groups/${g.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      const newName = (res && res.group && res.group.name) || name;
      const gg = groups.find((x) => x.id === g.id);
      if (gg) gg.name = newName;
      groupNameEdit.hidden = true;
      groupDetailName.hidden = false;
      groupDetailName.textContent = newName;
      groupRenameBtn.hidden = !(g.ownerId === currentUserId);
      renderGroups();
      renderConversations();
      if (chatMode === "group" && Number(currentGroup) === g.id) {
        chatPeerName.textContent = newName;
        renderAvatarInto($("#chatPeerAvatar"), gg ? gg.avatar : "", (newName || "?").charAt(0).toUpperCase());
      }
      toast("群名称已更新");
    } catch (e) {
      cancelGroupRename();
      toast("修改失败：" + (e?.message || e));
    }
  }

  // ---- 创建群聊 ----
  function openGroupModal() {
    groupNameInput.value = "";
    groupMemberPicker.innerHTML = "";
    if (!friends.length) {
      groupMemberPicker.innerHTML = `<div class="member-pick-empty">还没有好友，无法创建群聊</div>`;
    } else {
      friends.forEach((f) => {
        const row = document.createElement("label");
        row.className = "member-pick-row";
        row.innerHTML =
          `<input type="checkbox" value="${f.id}" />` +
          `<span class="avatar sm">${renderAvatar(f.avatar, f.username.charAt(0).toUpperCase())}</span>` +
          `<span class="mp-name">${escapeHtml(f.username)}</span>`;
        groupMemberPicker.appendChild(row);
      });
    }
    groupModal.hidden = false;
  }

  async function submitCreateGroup() {
    const name = groupNameInput.value.trim();
    if (!name) { toast("请输入群名称"); return; }
    const checks = groupMemberPicker.querySelectorAll('input[type="checkbox"]:checked');
    const members = Array.from(checks).map((c) => Number(c.value));
    try {
      const r = await api("/api/groups", {
        method: "POST",
        body: JSON.stringify({ name, members }),
      });
      groupModal.hidden = true;
      const g = r.group;
      groups.push(g);
      renderGroups();
      toast(`已创建群聊「${g.name}」`);
      openGroupConversation(g);
    } catch (e) {
      toast(e.message || "创建失败");
    }
  }

  // ---- 添加群成员 ----
  function openAddMemberModal() {
    if (currentGroup == null) return;
    const g = groups.find((x) => x.id === currentGroup);
    if (!g) return;
    const inGroup = new Set((g.members || []).map((m) => m.id));
    groupAddPicker.innerHTML = "";
    const candidates = friends.filter((f) => !inGroup.has(f.id));
    if (!candidates.length) {
      groupAddPicker.innerHTML = `<div class="member-pick-empty">没有可添加的好友</div>`;
    } else {
      candidates.forEach((f) => {
        const row = document.createElement("div");
        row.className = "member-pick-row";
        row.innerHTML =
          `<span class="avatar sm">${renderAvatar(f.avatar, f.username.charAt(0).toUpperCase())}</span>` +
          `<span class="mp-name">${escapeHtml(f.username)}</span>` +
          `<button class="mp-add" type="button">添加</button>`;
        row.querySelector(".mp-add").onclick = async () => {
          try {
            await api(`/api/groups/${currentGroup}/members`, {
              method: "POST",
              body: JSON.stringify({ userId: f.id }),
            });
            toast(`已邀请 ${f.username} 加入群聊`);
            await loadGroups();
            const gg = groups.find((x) => x.id === currentGroup);
            if (gg) setChatStatus(`群聊 · ${(gg.members || []).length}人`, "");
            const btn = row.querySelector(".mp-add");
            btn.textContent = "已添加";
            btn.disabled = true;
          } catch (e) {
            toast(e.message || "添加失败");
          }
        };
        groupAddPicker.appendChild(row);
      });
    }
    groupAddModal.hidden = false;
  }

  // ---- 退出群聊 ----
  async function leaveCurrentGroup() {
    if (currentGroup == null) return;
    const g = groups.find((x) => x.id === currentGroup);
    if (!confirm(`确定退出群聊「${g ? g.name : "该群"}」？`)) return;
    try {
      await api(`/api/groups/${currentGroup}/leave`, { method: "DELETE" });
      groups = groups.filter((x) => x.id !== currentGroup);
      clearGroupUnread(currentGroup);
      toast("已退出群聊");
    } catch (e) {
      toast(e.message || "退出失败");
      return;
    }
    chatMode = "peer";
    currentGroup = null;
    chatGroupActions.hidden = true;
    currentPeer = null;
    chatPeerName.textContent = "选择一个好友开始聊天";
    renderAvatarInto($("#chatPeerAvatar"), "", "?");
    setChatStatus("未连接");
    disableChatInput();
    resetChatMessages();
    renderGroups();
  }

  // ---- 群消息：发送 ----
  function sendGroupChat(text) {
    if (currentGroup == null) { setChatStatus("请先选择一个群聊", "warn"); return; }
    if (myId == null) { setChatStatus("连接中，请稍候…", "warn"); return; }
    const id = crypto.randomUUID();
    const ts = Date.now();
    const gid = currentGroup;
    const conv = groupConvKey(gid);
    const rec = { id, from: myId, to: conv, groupId: gid, text, ts, conv, synced: false };
    groupRenderedIds.add(id);
    renderMessageRow("me", text, ts);
    ChatDB.put(rec).then(() => flushPending());
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "group-chat", groupId: gid, id, ts, text }));
      setChatStatus(`群聊 · ${(groups.find((x) => x.id === gid)?.members || []).length}人`, "");
    } else {
      setChatStatus("已发送（离线消息，上线后接收）", "ok");
    }
    chatInput.value = "";
    chatInput.style.height = "auto";
    // 自己发送 → 会话前置并更新预览
    upsertConversation("group", gid, ts, text, false);
  }

  // ---- 群消息：接收 ----
  async function onGroupMessage(m) {
    const gid = Number(m.groupId);
    const conv = groupConvKey(gid);
    const rec = { id: m.id, from: m.from, to: conv, groupId: gid, text: m.text, ts: m.ts, conv, synced: false };
    await ChatDB.put(rec).catch(() => {});
    flushPending();
    const viewing = chatMode === "group" && currentGroup === gid && chatVisible;
    if (viewing) {
      if (!groupRenderedIds.has(m.id)) {
        groupRenderedIds.add(m.id);
        const sm = groupMemberName(gid, m.from);
        renderMessageRow(m.from === myId ? "me" : "peer", m.text, m.ts, sm.name, sm.avatar);
      }
      // 新消息把会话前置（更新预览与排序）
      upsertConversation("group", gid, m.ts, m.text, false);
    } else if (m.from !== myId) {
      bumpGroupUnread(gid);
      upsertConversation("group", gid, m.ts, m.text, false);
    }
  }

  // ---- 群消息：本地缓存渲染 ----
  async function loadGroupConversation(gid) {
    const conv = groupConvKey(gid);
    const msgs = await ChatDB.allForConv(conv).catch(() => []);
    for (const m of msgs) {
      groupRenderedIds.add(m.id);
      const sm = groupMemberName(gid, m.from);
      renderMessageRow(m.from === myId ? "me" : "peer", m.text, m.ts, sm.name, sm.avatar);
    }
  }

  // ---- 群消息：从服务端增量同步 ----
  async function syncGroupConversation(gid) {
    const my = myId;
    if (my == null) return;
    try {
      const since = await ChatDB.maxTs(groupConvKey(gid));
      const data = await api(`/api/groups/${gid}/messages?since=${since}`);
      for (const m of data.messages || []) {
        const exists = await ChatDB.has(m.id);
        await ChatDB.put({ ...m, to: groupConvKey(gid), groupId: gid, conv: groupConvKey(gid), synced: true }).catch(() => {});
        if (currentGroup === gid && !groupRenderedIds.has(m.id)) {
          groupRenderedIds.add(m.id);
          if (!exists) {
            const sm = groupMemberName(gid, m.from);
            renderMessageRow(m.from === myId ? "me" : "peer", m.text, m.ts, sm.name, sm.avatar);
          }
        }
      }
    } catch (e) { /* 服务端不可用：本地缓存仍可用 */ }
  }

  // ---- 群未读：离线/重连补算 ----
  async function syncAllGroupUnread() {
    if (myId == null || groups.length === 0) return;
    for (const g of groups) {
      const gid = g.id;
      const since = await ChatDB.maxTs(groupConvKey(gid));
      let msgs = [];
      try {
        const data = await api(`/api/groups/${gid}/messages?since=${since}`);
        msgs = data.messages || [];
      } catch (e) { continue; }
      const viewing = chatMode === "group" && currentGroup === gid && chatVisible;
      for (const m of msgs) {
        if (m.from === myId) continue;
        if (await ChatDB.has(m.id)) continue;
        await ChatDB.put({ ...m, to: groupConvKey(gid), groupId: gid, conv: groupConvKey(gid), synced: true }).catch(() => {});
        if (viewing) {
          if (!groupRenderedIds.has(m.id)) {
            groupRenderedIds.add(m.id);
            const sm = groupMemberName(gid, m.from);
            renderMessageRow(m.from === myId ? "me" : "peer", m.text, m.ts, sm.name, sm.avatar);
          }
        } else {
          bumpGroupUnread(gid);
        }
      }
      if (viewing) clearGroupUnread(gid);
    }
  }

  function clearEntering() {
    if (enteringMsg && enteringMsg.parentNode) { enteringMsg.remove(); enteringMsg = null; }
  }

  resetChatMessages();

  // 网络恢复时：把本地未同步的消息补推到服务端，并补算离线期间漏掉的未读红点
  window.addEventListener("online", () => { flushPending(); trySyncAll(); syncLinks(); });

  // ---------- Init ----------
  function init() {
    applyTheme(
      localStorage.getItem(THEME_KEY) ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    );
    checkAuth();
  }
  init();
})();
