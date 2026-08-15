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
    // 带着会议链接进入且未登录：展示访客入会页（输入昵称即可入会，无需注册）
    if (pendingMeetingId) {
      if ($("#appView")) $("#appView").hidden = true;
      if ($("#authView")) $("#authView").hidden = true;
      if (guestJoinView) guestJoinView.hidden = false;
      if (guestNameInput) { guestNameInput.value = ""; guestNameInput.focus(); }
      return;
    }
    $("#appView").hidden = true;
    if ($("#authView")) $("#authView").hidden = false;
    // 回到账号/密码输入框（隐藏转圈）
    hideAuthSpinner();
    $("#loginForm").hidden = false;
    $("#registerForm").hidden = true;
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
    // 通过会议链接登录：展示“点击加入”闸门（避免无手势弹摄像头权限被拦截）
    if (pendingMeetingId) {
      try { joinMeetingFromLink(pendingMeetingId); } catch (e) { console.error("[INIT] 链接入会闸门失败:", e); }
    }
  }
  async function checkAuth() {
    const tk = localStorage.getItem(TOKEN_KEY);
    if (!tk) {
      // 本端无登录态：直接展示账号/密码输入框
      showAuth();
      return;
    }
    // 本端存在登录态：先展示转圈等待服务端校验，并隐藏账号/密码输入框
    if ($("#appView")) $("#appView").hidden = true;
    if ($("#authView")) $("#authView").hidden = false;
    showAuthSpinner(t("auth.verifying"));
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
  // 本端已有登录态：展示转圈等待服务端校验，同时隐藏账号/密码输入框
  function showAuthSpinner(msg) {
    const sp = $("#authSpinner");
    if (!sp) return;
    const txt = sp.querySelector(".auth-spinner-text");
    if (txt && msg) txt.textContent = msg;
    sp.hidden = false;
    $("#loginForm").hidden = true;
    $("#registerForm").hidden = true;
    clearAuthError();
  }
  function hideAuthSpinner() {
    const sp = $("#authSpinner");
    if (sp) sp.hidden = true;
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

    if (apps.length === filtered.length) {
      i18nText(appCount, "app.count", { n: apps.length });
    } else {
      i18nText(appCount, "app.count.showing", { n: apps.length, m: filtered.length });
    }
    grid.innerHTML = "";

    if (filtered.length === 0) {
      emptyState.hidden = false;
      const emptyH2 = emptyState.querySelector("h2");
      const emptyP = emptyState.querySelector("p");
      i18nText(emptyH2, apps.length === 0 ? "app.empty.title" : "app.empty.match");
      i18nText(emptyP, apps.length === 0 ? "app.empty.hint" : "app.empty.try");
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
      closeContextMenu(); closeModal(); closeProfileModal(); closeSettings();
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
    i18nText(modalTitle, app ? "app.modal.edit" : "app.modal.add");
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

  // ---------- 个人资料 / 头像 / 昵称 ----------
  function openProfileModal() {
    $("#pNickname").value = currentUsername;
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
  // 把服务端返回的最新资料写回本地（昵称 / 头像），并刷新相关展示
  function applyProfileUpdate(u) {
    if (!u) return;
    if (typeof u.username === "string" && u.username) {
      currentUsername = u.username;
      const un = $("#userName");
      if (un) un.textContent = currentUsername;
    }
    if (typeof u.avatar === "string") {
      myAvatar = u.avatar;
    }
    renderAvatarInto($("#userAvatar"), myAvatar, (currentUsername || "?").charAt(0).toUpperCase());
    // 重新拉取好友 / 群，使新昵称在列表中生效
    if (typeof loadFriends === "function") loadFriends();
    if (typeof loadGroups === "function") loadGroups();
  }
  async function saveProfile() {
    try {
      const nickname = $("#pNickname").value.trim();
      const avatar = $("#pAvatar").value.trim();
      const r = await api("/api/me", {
        method: "PUT",
        body: JSON.stringify({ username: nickname, avatar }),
      });
      applyProfileUpdate(r.user);
      closeProfileModal();
      toast("资料已更新");
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
      category: $("#fCategory").value.trim() || t("app.category.uncategorized"),
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

  // ---------- i18n（中英文切换） ----------
  const I18N = {
    zh: {
      "app.title": "Web 应用导航",
      "auth.title": "Web 应用导航",
      "auth.sub": "登录以同步你的应用",
      "auth.username.ph": "用户名",
      "auth.password.ph": "密码",
      "auth.login": "登录",
      "auth.noAccount.pre": "还没有账号？",
      "auth.register.link": "注册一个",
      "auth.regUsername.ph": "用户名（3-32 位）",
      "auth.regPassword.ph": "密码（至少 6 位）",
      "auth.register": "注册",
      "auth.hasAccount.pre": "已有账号？",
      "auth.login.link": "去登录",
      "auth.logging": "登录中…",
      "auth.registering": "注册中…",
      "auth.verifying": "正在验证登录态…",
      "update.text": "已更新到新版本 v",
      "update.reload": "刷新",
      "settings.title": "设置",
      "settings.backup": "数据备份",
      "settings.import": "📥 从 JSON 文件导入",
      "settings.export": "📤 导出为 JSON 备份",
      "settings.backupHint": "导入会按网址去重合并；导出为当前账号的全部应用备份。",
      "settings.language": "语言",
      "settings.appearance": "外观",
      "settings.theme.dark": "🌓 主题：深色",
      "settings.theme.light": "🌓 主题：浅色",
      "settings.cache": "缓存",
      "settings.clearCache": "🧹 清空缓存",
      "settings.clearCacheConfirm": "确定清空本地缓存？这会清除本机聊天记录与界面布局，但不会退出登录。",
      "settings.cacheHint": "仅清除本机缓存（聊天记录与界面布局），保留登录状态、语言与主题。",
      "settings.cacheCleared": "缓存已清空",
      "topbar.search.ph": "搜索应用名称或网址…",
      "topbar.add": "＋ 添加应用",
      "topbar.chat": "💬 聊天",
      "topbar.meeting": "📹 视频会议",
      "topbar.settings": "⚙ 设置",
      "topbar.logout": "登出",
      "app.modal.add": "添加应用",
      "app.modal.edit": "编辑应用",
      "app.modal.name": "名称",
      "app.modal.namePh": "例如：Gmail",
      "app.modal.url": "网址",
      "app.modal.urlPh": "https://mail.google.com",
      "app.modal.category": "分类",
      "app.modal.categoryPh": "工作 / 工具 / 娱乐",
      "app.modal.icon": "图标（Emoji 或 favicon 链接）",
      "app.modal.iconPh": "🌟 或 https://…/favicon.ico",
      "app.modal.iconAuto": "使用网站默认 favicon",
      "app.modal.color": "主题色",
      "app.modal.openMode": "打开方式",
      "app.modal.openMode.new": "新标签页打开",
      "app.modal.openMode.self": "当前窗口打开",
      "app.modal.openMode.iframe": "内嵌窗口（iframe）打开",
      "app.modal.cancel": "取消",
      "app.modal.save": "保存",
      "app.empty.title": "还没有应用",
      "app.empty.match": "没有匹配的应用",
      "app.empty.hint": "点击右上角「＋ 添加应用」开始收集你的常用网站。",
      "app.empty.try": "试试更换分类或搜索关键词。",
      "app.count": "{n} 个应用",
      "app.count.showing": "{n} 个应用（显示 {m}）",
      "app.category.uncategorized": "未分类",
      "profile.title": "个人资料",
      "profile.avatarLabel": "头像（Emoji 或图片链接）",
      "profile.avatarPh": "🌟 或 https://…/avatar.png",
      "profile.nicknameLabel": "昵称（展示给你的好友与会议中的其他人）",
      "profile.nicknamePh": "你的昵称",
      "profile.usernameLabel": "用户名",
      "profile.cancel": "取消",
      "profile.save": "保存",
      "chat.title": "聊天",
      "chat.close": "关闭",
      "chat.resizer": "拖动调整宽度",
      "chat.tab.conversations": "💬 会话",
      "chat.tab.friends": "👤 好友",
      "chat.tab.groups": "👥 群组",
      "chat.conv.empty": "还没有会话，去「好友」或「群组」开始聊天吧",
      "chat.friend.search.ph": "输入用户名添加好友",
      "chat.friend.add": "添加",
      "chat.friend.empty": "还没有好友，添加好友后即可开始聊天",
      "chat.group.title": "👥 群聊",
      "chat.group.create1": "＋ 创建",
      "chat.group.empty": "还没有群聊，点「＋ 创建」开始",
      "chat.peer.placeholder": "选择一个好友开始聊天",
      "chat.status.disconnected": "未连接",
      "chat.call.voice": "语音通话",
      "chat.call.video": "视频通话",
      "chat.call.meeting": "发起群会议",
      "chat.group.addMember": "＋成员",
      "chat.group.leave": "退出",
      "chat.input.ph": "输入消息…（Enter 发送，Shift+Enter 换行）",
      "chat.send": "发送",
      "chat.friend.voiceChat": "📞 语音聊天",
      "chat.friend.videoChat": "📹 视频聊天",
      "chat.friend.message": "发消息",
      "chat.friend.remove": "移除好友",
      "chat.group.rename": "修改群名称",
      "chat.group.nameEdit.ph": "输入新群名称，回车保存",
      "chat.group.members": "群成员",
      "chat.group.sendMsg": "发消息",
      "chat.group.startMeeting": "📹 发起会议",
      "chat.group.meeting": "📹 会议",
      "chat.group.rejoin": "🔄 重新加入",
      "chat.group.addMember2": "＋添加成员",
      "chat.group.leave2": "退出群聊",
      "chat.back": "返回",
      "chat.status.signalConnected": "信令已连接",
      "chat.status.signalDisconnected": "信令断开",
      "chat.status.offline": "对方不在线（可发送离线消息）",
      "chat.status.p2p": "P2P 已直连 🔗",
      "chat.status.connecting": "正在连接…",
      "chat.status.online": "在线",
      "chat.status.relay": "直连失败，改用中继",
      "chat.status.peerEnded": "对方已结束对话（仍可发送离线消息）",
      "call.mute": "静音 / 取消静音",
      "call.cam": "开关摄像头",
      "call.share": "共享屏幕",
      "call.full": "全屏 / 退出全屏",
      "call.hangup": "挂断",
      "call.accept": "接听",
      "call.decline": "拒绝",
      "call.chat": "💬 聊天",
      "call.chat.close": "关闭",
      "call.chat.placeholder": "输入消息…",
      "call.chat.send": "发送",
      "call.chat.empty": "通话中可发送文字消息",
      "call.incoming.voice": "语音通话邀请",
      "call.incoming.video": "视频通话邀请",
      "call.incoming.chat": "聊天请求",
      "call.state.calling": "呼叫中…",
      "call.state.ringing": "等待对方接听…",
      "call.state.connected": "通话中",
      "call.state.reconnecting": "重连中…",
      "call.remote.cameraOff": "对方已关闭摄像头",
      "meeting.title": "群会议",
      "meeting.leave": "离开会议",
      "meeting.exitSpotlight": "退出聚焦，恢复网格",
      "meeting.full": "全屏切换",
      "meeting.mute": "静音 / 取消静音",
      "meeting.cam": "开关摄像头",
      "meeting.share": "共享屏幕",
      "meeting.hangup": "挂断 / 离开",
      "meeting.me": "我",
      "meeting.left": "你已离开会议",
      "meeting.rejoin": "重新加入",
      "meeting.close": "关闭",
      "meeting.join": "加入会议",
      "meeting.joinHint": "点击下方「加入会议」开始音视频",
      "meeting.chat": "会议聊天",
      "meeting.chat.title": "会议聊天",
      "meeting.chat.placeholder": "说点什么…（Enter 发送）",
      "meeting.chat.send": "发送",
      "meeting.roomTitle": "视频会议",
      "meeting.copyLink": "🔗 复制邀请链接",
      "meeting.linkCopied": "邀请链接已复制",
      "meeting.inviteHint": "会议已创建，点击左上角「复制邀请链接」分享给他人",
      "meeting.guest.title": "加入视频会议",
      "meeting.guest.sub": "输入昵称即可加入，无需注册",
      "meeting.guest.namePh": "你的昵称",
      "meeting.guest.join": "加入会议",
      "meeting.guest.toLogin": "我是成员，去登录",
      "meeting.chat.empty": "会议中发消息，只有本会议成员可见",
      "meeting.invite.join": "加入",
      "meeting.invite.ignore": "忽略",
      "meeting.invite.voice": "语音会议邀请",
      "meeting.invite.video": "视频会议邀请",
      "meeting.count": "{n} 人",
      "chat.friend.request": "{name} 请求加你好友",
      "chat.friend.accept": "接受",
      "chat.removed": "已移除好友",
      "chat.added": "已添加为好友",
      "chat.add.fail": "添加失败",
      "chat.op.fail": "操作失败",
      "chat.became.friend": "已与 {name} 成为好友",
      "chat.sent.request": "已向 {name} 发送好友请求",
      "chat.pulled.in": "你被拉入群聊「{name}」",
      "chat.friend.requested": "{name} 已通过你的好友请求",
      "chat.request.recv": "收到 {name} 的好友请求",
      "chat.confirm.remove": "确定移除好友「{name}」？",
      "chat.status.offlineLabel": "离线",
      "chat.status.pickFriend": "请先选择一个好友",
      "chat.status.pickGroup": "请先选择一个群聊",
      "chat.status.connecting2": "连接中，请稍候…",
      "chat.status.sent": "已发送",
      "chat.status.sentOffline": "已发送（对方可能离线，上线后接收）",
      "chat.status.sentOffline2": "已发送（离线消息，对方上线后接收）",
      "chat.status.relayMode": "中继模式（服务器转发）",
      "chat.status.groupMembers": "群聊 · {n}人",
      "chat.status.connectingName": "正在连接 {name} …",
      "chat.status.chatReq": "收到 {name} 的聊天请求，连接中…",
      "call.incoming.voiceMsg": "邀请你进行语音通话",
      "call.incoming.videoMsg": "邀请你进行视频通话",
      "meeting.invite.voiceMsg": "语音会议 · {name}",
      "meeting.invite.videoMsg": "视频会议 · {name}",
      "chat.group.created": "已创建群聊「{name}」",
      "chat.confirm.leaveGroup": "确定退出群聊「{name}」？",
      "chat.group.left": "已退出群聊",
      "chat.thisGroup": "该群",
      "chat.group.nameUpdated": "群名称已更新",
      "chat.group.noFriendToCreate": "还没有好友，无法创建群聊",
      "chat.group.enterName": "请输入群名称",
      "chat.group.createFail": "创建失败",
      "chat.group.noCandidate": "没有可添加的好友",
      "chat.group.invited": "已邀请 {name} 加入群聊",
      "chat.group.added": "已添加",
      "chat.group.modalTitle": "创建群聊",
      "chat.group.nameLabel": "群名称",
      "chat.group.namePh": "例如：项目组 / 家人们",
      "chat.group.selectMembers": "选择成员（从好友中）",
      "chat.group.addMemberTitle": "添加成员",
      "chat.group.selectFriends": "选择好友加入群聊",
      "chat.group.cancel": "取消",
      "chat.group.create": "创建",
      "call.busy": "已有进行中的通话",
      "call.leaveMeetingFirst": "请先离开当前群会议",
      "call.noMediaSupport": "当前浏览器不支持音视频通话",
      "call.noMediaAccess": "无法访问摄像头/麦克风：",
      "call.rejected": "对方拒绝了通话",
      "call.ended": "对方已结束通话",
      "call.shareVideoOnly": "仅视频通话中可共享屏幕",
      "call.noShareSupport": "当前浏览器不支持屏幕共享",
      "call.shareFail": "无法共享屏幕：",
      "call.noVideoTrack": "未找到视频轨道，无法共享",
      "call.endCallFirst": "请先结束当前通话",
      "meeting.alreadyIn": "已在会议中",
      "meeting.noSupport": "当前浏览器不支持音视频会议",
      "meeting.inviting": "已发起群会议，正在呼叫成员…",
      "meeting.inOther": "已在其它群会议中",
      "meeting.shareVideoOnly": "仅视频会议中可共享屏幕",
      "chat.group.renameFail": "修改失败："
    },
    en: {
      "app.title": "Web App Navigator",
      "auth.title": "Web App Navigator",
      "auth.sub": "Sign in to sync your apps",
      "auth.username.ph": "Username",
      "auth.password.ph": "Password",
      "auth.login": "Sign In",
      "auth.noAccount.pre": "No account?",
      "auth.register.link": "Sign up",
      "auth.regUsername.ph": "Username (3-32 chars)",
      "auth.regPassword.ph": "Password (min 6 chars)",
      "auth.register": "Sign Up",
      "auth.hasAccount.pre": "Have an account?",
      "auth.login.link": "Sign in",
      "auth.logging": "Signing in…",
      "auth.registering": "Signing up…",
      "auth.verifying": "Verifying your session…",
      "update.text": "Updated to version v",
      "update.reload": "Reload",
      "settings.title": "Settings",
      "settings.backup": "Data Backup",
      "settings.import": "📥 Import from JSON",
      "settings.export": "📤 Export as JSON backup",
      "settings.backupHint": "Import merges by URL (dedup); export backs up all your apps.",
      "settings.language": "Language",
      "settings.appearance": "Appearance",
      "settings.theme.dark": "🌓 Theme: Dark",
      "settings.theme.light": "🌓 Theme: Light",
      "settings.cache": "Cache",
      "settings.clearCache": "🧹 Clear Cache",
      "settings.clearCacheConfirm": "Clear local cache? This wipes local chat history and layout, but won't log you out.",
      "settings.cacheHint": "Only local cache (chat history & layout) is cleared; login, language and theme are kept.",
      "settings.cacheCleared": "Cache cleared",
      "topbar.search.ph": "Search apps by name or URL…",
      "topbar.add": "＋ Add App",
      "topbar.chat": "💬 Chat",
      "topbar.meeting": "📹 Video Meeting",
      "topbar.settings": "⚙ Settings",
      "topbar.logout": "Log Out",
      "app.modal.add": "Add App",
      "app.modal.edit": "Edit App",
      "app.modal.name": "Name",
      "app.modal.namePh": "e.g. Gmail",
      "app.modal.url": "URL",
      "app.modal.urlPh": "https://mail.google.com",
      "app.modal.category": "Category",
      "app.modal.categoryPh": "Work / Tools / Entertainment",
      "app.modal.icon": "Icon (Emoji or favicon URL)",
      "app.modal.iconPh": "🌟 or https://…/favicon.ico",
      "app.modal.iconAuto": "Use site favicon",
      "app.modal.color": "Theme Color",
      "app.modal.openMode": "Open Mode",
      "app.modal.openMode.new": "Open in new tab",
      "app.modal.openMode.self": "Open in current window",
      "app.modal.openMode.iframe": "Open in embedded iframe",
      "app.modal.cancel": "Cancel",
      "app.modal.save": "Save",
      "app.empty.title": "No apps yet",
      "app.empty.match": "No matching apps",
      "app.empty.hint": "Click \"＋ Add App\" in the top-right to collect your favorite sites.",
      "app.empty.try": "Try a different category or search keyword.",
      "app.count": "{n} apps",
      "app.count.showing": "{n} apps (showing {m})",
      "app.category.uncategorized": "Uncategorized",
      "profile.title": "Profile",
      "profile.avatarLabel": "Avatar (Emoji or image URL)",
      "profile.avatarPh": "🌟 or https://…/avatar.png",
      "profile.nicknameLabel": "Nickname (shown to your friends and others in meetings)",
      "profile.nicknamePh": "Your nickname",
      "profile.usernameLabel": "Username",
      "profile.cancel": "Cancel",
      "profile.save": "Save",
      "chat.title": "Chat",
      "chat.close": "Close",
      "chat.resizer": "Drag to resize width",
      "chat.tab.conversations": "💬 Chats",
      "chat.tab.friends": "👤 Friends",
      "chat.tab.groups": "👥 Groups",
      "chat.conv.empty": "No chats yet. Start one from Friends or Groups.",
      "chat.friend.search.ph": "Enter username to add friend",
      "chat.friend.add": "Add",
      "chat.friend.empty": "No friends yet. Add friends to start chatting.",
      "chat.group.title": "👥 Group Chats",
      "chat.group.create1": "＋ Create",
      "chat.group.empty": "No groups yet. Tap “＋ Create”.",
      "chat.peer.placeholder": "Select a friend to start chatting",
      "chat.status.disconnected": "Disconnected",
      "chat.call.voice": "Voice call",
      "chat.call.video": "Video call",
      "chat.call.meeting": "Start group meeting",
      "chat.group.addMember": "＋Member",
      "chat.group.leave": "Leave",
      "chat.input.ph": "Type a message… (Enter to send, Shift+Enter for new line)",
      "chat.send": "Send",
      "chat.friend.voiceChat": "📞 Voice Chat",
      "chat.friend.videoChat": "📹 Video Chat",
      "chat.friend.message": "Message",
      "chat.friend.remove": "Remove Friend",
      "chat.group.rename": "Rename group",
      "chat.group.nameEdit.ph": "Enter new group name, press Enter to save",
      "chat.group.members": "Members",
      "chat.group.sendMsg": "Message",
      "chat.group.startMeeting": "📹 Start Meeting",
      "chat.group.meeting": "📹 Meeting",
      "chat.group.rejoin": "🔄 Rejoin",
      "chat.group.addMember2": "＋Add Member",
      "chat.group.leave2": "Leave Group",
      "chat.back": "Back",
      "chat.status.signalConnected": "Signal connected",
      "chat.status.signalDisconnected": "Signal disconnected",
      "chat.status.offline": "Offline (you can send offline messages)",
      "chat.status.p2p": "P2P connected 🔗",
      "chat.status.connecting": "Connecting…",
      "chat.status.online": "Online",
      "chat.status.relay": "P2P failed, using relay",
      "chat.status.peerEnded": "Peer ended conversation (offline messages still allowed)",
      "call.mute": "Mute / Unmute",
      "call.cam": "Toggle camera",
      "call.share": "Share screen",
      "call.full": "Fullscreen / Exit fullscreen",
      "call.hangup": "Hang up",
      "call.accept": "Accept",
      "call.decline": "Decline",
      "call.chat": "💬 Chat",
      "call.chat.close": "Close",
      "call.chat.placeholder": "Type a message…",
      "call.chat.send": "Send",
      "call.chat.empty": "Send text messages during the call",
      "call.incoming.voice": "Incoming voice call",
      "call.incoming.video": "Incoming video call",
      "call.incoming.chat": "Chat request",
      "call.state.calling": "Calling…",
      "call.state.ringing": "Waiting for answer…",
      "call.state.connected": "On call",
      "call.state.reconnecting": "Reconnecting…",
      "call.remote.cameraOff": "Camera off",
      "meeting.title": "Group Meeting",
      "meeting.leave": "Leave meeting",
      "meeting.exitSpotlight": "Exit spotlight, back to grid",
      "meeting.full": "Toggle fullscreen",
      "meeting.mute": "Mute / Unmute",
      "meeting.cam": "Toggle camera",
      "meeting.share": "Share screen",
      "meeting.hangup": "Hang up / Leave",
      "meeting.me": "You",
      "meeting.left": "You left the meeting",
      "meeting.rejoin": "Rejoin",
      "meeting.close": "Close",
      "meeting.join": "Join Meeting",
      "meeting.joinHint": "Tap “Join Meeting” below to start audio/video",
      "meeting.chat": "Meeting chat",
      "meeting.chat.title": "Meeting Chat",
      "meeting.chat.placeholder": "Say something… (Enter to send)",
      "meeting.chat.send": "Send",
      "meeting.chat.empty": "Messages here are visible only to meeting participants",
      "meeting.roomTitle": "Video Meeting",
      "meeting.copyLink": "🔗 Copy Invite Link",
      "meeting.linkCopied": "Invite link copied",
      "meeting.inviteHint": "Meeting created. Tap “Copy Invite Link” at the top to share with others",
      "meeting.guest.title": "Join Video Meeting",
      "meeting.guest.sub": "Enter a nickname to join, no sign-up needed",
      "meeting.guest.namePh": "Your nickname",
      "meeting.guest.join": "Join Meeting",
      "meeting.guest.toLogin": "I'm a member, log in",
      "meeting.invite.join": "Join",
      "meeting.invite.ignore": "Ignore",
      "meeting.invite.voice": "Voice meeting invite",
      "meeting.invite.video": "Video meeting invite",
      "meeting.count": "{n} people",
      "chat.friend.request": "{name} wants to add you as a friend",
      "chat.friend.accept": "Accept",
      "chat.removed": "Friend removed",
      "chat.added": "Added as friend",
      "chat.add.fail": "Failed to add",
      "chat.op.fail": "Operation failed",
      "chat.became.friend": "You and {name} are now friends",
      "chat.sent.request": "Friend request sent to {name}",
      "chat.pulled.in": "You were added to group “{name}”",
      "chat.friend.requested": "{name} accepted your friend request",
      "chat.request.recv": "Friend request from {name}",
      "chat.confirm.remove": "Remove friend “{name}”?",
      "chat.status.offlineLabel": "Offline",
      "chat.status.pickFriend": "Please select a friend first",
      "chat.status.pickGroup": "Please select a group first",
      "chat.status.connecting2": "Connecting, please wait…",
      "chat.status.sent": "Sent",
      "chat.status.sentOffline": "Sent (recipient may be offline; delivered when online)",
      "chat.status.sentOffline2": "Sent as offline message; delivered when online",
      "chat.status.relayMode": "Relay mode (server forwarding)",
      "chat.status.groupMembers": "Group · {n}",
      "chat.status.connectingName": "Connecting to {name}…",
      "chat.status.chatReq": "Chat request from {name}, connecting…",
      "call.incoming.voiceMsg": "Incoming voice call",
      "call.incoming.videoMsg": "Incoming video call",
      "meeting.invite.voiceMsg": "Voice meeting · {name}",
      "meeting.invite.videoMsg": "Video meeting · {name}",
      "chat.group.created": "Group “{name}” created",
      "chat.confirm.leaveGroup": "Leave group “{name}”?",
      "chat.group.left": "Left group",
      "chat.thisGroup": "this group",
      "chat.group.nameUpdated": "Group name updated",
      "chat.group.noFriendToCreate": "No friends to create a group",
      "chat.group.enterName": "Please enter a group name",
      "chat.group.createFail": "Failed to create",
      "chat.group.noCandidate": "No friends available to add",
      "chat.group.invited": "Invited {name} to the group",
      "chat.group.added": "Added",
      "chat.group.modalTitle": "Create Group",
      "chat.group.nameLabel": "Group name",
      "chat.group.namePh": "e.g. Project Team / Family",
      "chat.group.selectMembers": "Select members (from friends)",
      "chat.group.addMemberTitle": "Add Members",
      "chat.group.selectFriends": "Select friends to join",
      "chat.group.cancel": "Cancel",
      "chat.group.create": "Create",
      "call.busy": "Call in progress",
      "call.leaveMeetingFirst": "Leave the current meeting first",
      "call.noMediaSupport": "Browser doesn't support audio/video calls",
      "call.noMediaAccess": "Cannot access camera/mic: ",
      "call.rejected": "Peer declined the call",
      "call.ended": "Peer ended the call",
      "call.shareVideoOnly": "Screen share only available in video call",
      "call.noShareSupport": "Browser doesn't support screen sharing",
      "call.shareFail": "Cannot share screen: ",
      "call.noVideoTrack": "No video track to share",
      "call.endCallFirst": "End the current call first",
      "meeting.alreadyIn": "Already in a meeting",
      "meeting.noSupport": "Browser doesn't support video meetings",
      "meeting.inviting": "Group meeting started, calling members…",
      "meeting.inOther": "Already in another group meeting",
      "meeting.shareVideoOnly": "Screen share only in video meeting",
      "chat.group.renameFail": "Failed to rename: "
    }
  };
  const LANG_KEY = "lang";
  function getLang() {
    const l = localStorage.getItem(LANG_KEY);
    if (l === "en" || l === "zh") return l;
    const nav = (navigator.language || "zh-CN").toLowerCase();
    return nav.startsWith("zh") ? "zh" : "en";
  }
  function t(key, lang) {
    lang = lang || getLang();
    return (I18N[lang] && I18N[lang][key] != null) ? I18N[lang][key] : (I18N.zh[key] != null ? I18N.zh[key] : key);
  }
  // 带参数的翻译：tp("meeting.count", { n: 3 }) → "3 人"
  function tp(key, params, lang) {
    let s = t(key, lang);
    if (params) { for (const k in params) s = s.split("{" + k + "}").join(params[k]); }
    return s;
  }
  // 运行时动态设置的文本：记录 key 到 dataset，语言切换时 applyI18n 自动刷新
  function i18nText(el, key, params) {
    el.dataset.i18nKey = key;
    if (params) el.dataset.i18nParams = JSON.stringify(params); else delete el.dataset.i18nParams;
    el.textContent = tp(key, params);
  }
  function i18nTitle(el, key, params) {
    el.dataset.i18nTitleKey = key;
    if (params) el.dataset.i18nTitleParams = JSON.stringify(params); else delete el.dataset.i18nTitleParams;
    el.title = tp(key, params);
  }
  function applyI18n(lang) {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      const txt = t(key, lang);
      if (txt != null) el.textContent = txt;
    });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      const key = el.getAttribute("data-i18n-ph");
      const txt = t(key, lang);
      if (txt != null) el.setAttribute("placeholder", txt);
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      const txt = t(key, lang);
      if (txt != null) el.setAttribute("title", txt);
    });
    document.querySelectorAll("[data-i18n-key]").forEach((el) => {
      const key = el.dataset.i18nKey;
      if (key) { const params = el.dataset.i18nParams ? JSON.parse(el.dataset.i18nParams) : null; const txt = tp(key, params, lang); if (txt != null) el.textContent = txt; }
    });
    document.querySelectorAll("[data-i18n-title-key]").forEach((el) => {
      const key = el.dataset.i18nTitleKey;
      if (key) { const params = el.dataset.i18nTitleParams ? JSON.parse(el.dataset.i18nTitleParams) : null; const txt = tp(key, params, lang); if (txt != null) el.setAttribute("title", txt); }
    });
    document.documentElement.lang = (lang === "en") ? "en" : "zh-CN";
  }
  function setLang(lang) {
    if (lang !== "en" && lang !== "zh") lang = "zh";
    localStorage.setItem(LANG_KEY, lang);
    applyI18n(lang);
    document.querySelectorAll(".lang-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-lang") === lang);
    });
    if (typeof refreshThemeToggle === "function") refreshThemeToggle();
  }

  // ---------- Auth events ----------
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = t("auth.logging");
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
    btn.disabled = true; btn.textContent = t("auth.registering");
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
    hideAuthSpinner();
    $("#loginForm").hidden = true;
    $("#registerForm").hidden = false;
    $("#authSub").textContent = "创建账号以保存你的应用";
    clearAuthError();
  };
  $("#toLogin").onclick = (e) => {
    e.preventDefault();
    hideAuthSpinner();
    $("#registerForm").hidden = true;
    $("#loginForm").hidden = false;
    $("#authSub").textContent = "登录以同步你的应用";
    clearAuthError();
  };
  async function logout() {
    disconnectSignaling();
    try { await api("/api/logout", { method: "POST" }); } catch {}
    localStorage.removeItem(TOKEN_KEY);
    if (typeof closeSettings === "function") closeSettings();
    showAuth();
  }

  // ---------- Events ----------
  $("#settingsBtn").onclick = openSettings;
  $("#addBtn").onclick = () => openModal(null);
  $("#exportBtn").onclick = exportJson;
  $("#importBtn").onclick = () => $("#importFile").click();
  $("#importFile").onchange = (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ""; };
  $("#themeToggleBtn").onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    applyTheme(cur === "dark" ? "light" : "dark");
    refreshThemeToggle();
  };
  // 语言切换：任意 .lang-btn 点击切换并持久化；登录页与设置页控件联动
  document.querySelectorAll(".lang-btn").forEach((b) => {
    b.addEventListener("click", () => setLang(b.getAttribute("data-lang")));
  });
  setLang(getLang()); // 启动时应用已保存语言并同步控件高亮
  searchInput.oninput = (e) => { searchTerm = e.target.value; renderGrid(); };
  modal.querySelectorAll("[data-close]").forEach((el) => el.onclick = closeModal);

  // 个人资料 / 头像 / 昵称
  $("#userAvatarBtn").onclick = openProfileModal;
  $("#pAvatar").addEventListener("input", updateAvatarPreview);
  $("#saveAvatar").onclick = saveProfile;
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
  const btnCallShare = $("#btnCallShare");
  const btnCallFull = $("#btnCallFull");
  const btnCallHangup = $("#btnCallHangup");
  const btnCallChat = $("#btnCallChat");
  const btnCallChatClose = $("#btnCallChatClose");
  const callChat = $("#callChat");
  const callChatList = $("#callChatList");
  const callChatInput = $("#callChatInput");
  const callChatSend = $("#callChatSend");
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
  const btnMeetingShare = $("#btnMeetingShare");
  const btnMeetingHangup = $("#btnMeetingHangup");
  const btnMeetingLeave = $("#btnMeetingLeave");
  const btnMeetingRejoin = $("#btnMeetingRejoin");     // 离开后：重新加入
  const btnMeetingCloseLeft = $("#btnMeetingCloseLeft"); // 离开后：彻底关闭
  const meetingLeftBar = $("#meetingLeftBar");
  const meetingFilmstrip = $("#meetingFilmstrip");
  const meetingSelfAvatar = $("#meetingSelfAvatar");
  const btnMeetingFull = $("#btnMeetingFull");
  const btnMeetingSpotExit = $("#btnMeetingSpotExit");
  const groupMeetingBtn = $("#groupMeetingBtn");       // 群聊头部：发起会议 / 重新加入
  const groupMeetingBtn2 = $("#groupMeetingBtn2");     // 群详情：发起会议
  const groupCallInvite = $("#groupCallInvite");
  const groupCallAvatar = $("#groupCallAvatar");
  const groupCallName = $("#groupCallName");
  const groupCallType = $("#groupCallType");
  // 会议内聊天相关 DOM
  const meetingChat = $("#meetingChat");
  const meetingChatList = $("#meetingChatList");
  const meetingChatInput = $("#meetingChatInput");
  const meetingChatSend = $("#meetingChatSend");
  const btnMeetingChat = $("#btnMeetingChat");
  const btnMeetingChatClose = $("#btnMeetingChatClose");
  const btnGroupCallJoin = $("#btnGroupCallJoin");
  const btnGroupCallIgnore = $("#btnGroupCallIgnore");
  // 独立会议房间相关 DOM
  const meetingStartBtn = $("#meetingStartBtn");           // 顶栏：创建会议
  const btnMeetingCopyLink = $("#btnMeetingCopyLink");     // 会议内：复制邀请链接
  const guestJoinView = $("#guestJoinView");               // 访客入会页（未登录）
  const guestJoinForm = $("#guestJoinForm");
  const guestNameInput = $("#guestName");
  const guestToLogin = $("#guestToLogin");                 // 访客页：去登录
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

  // 会话列表点击用事件委托（而非给每个 row 单独绑 onclick）：
  // renderConversations 每次都 convListEl.innerHTML="" 全量重建，直接绑定会在重建瞬间丢点击；
  // 委托挂在 convListEl 上，innerHTML 清空不会移除它自身，故任何重建后点击都有效。
  convListEl.addEventListener("click", (e) => {
    const closeBtn = e.target.closest(".conv-close");
    if (closeBtn) {
      e.stopPropagation();
      const row = closeBtn.closest(".conv-row");
      if (row) removeConversation(row.dataset.ctype, Number(row.dataset.cid));
      return;
    }
    const row = e.target.closest(".conv-row");
    if (!row) return;
    const cid = Number(row.dataset.cid);
    const ctype = row.dataset.ctype;
    if (ctype === "group") {
      const g = groups.find((x) => x.id === cid);
      if (g) openGroupConversation(g);
    } else {
      const f = friends.find((x) => x.id === cid);
      if (f) openConversation(f);
    }
  });

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
  const friendVoiceCallBtn = $("#friendVoiceCallBtn");
  const friendVideoCallBtn = $("#friendVideoCallBtn");
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
  if (btnCallShare) btnCallShare.onclick = toggleScreenShare;
  if (btnCallFull) btnCallFull.onclick = toggleCallFullscreen;
  if (btnCallHangup) btnCallHangup.onclick = endCall;
  if (btnCallChat) btnCallChat.onclick = toggleCallChat;
  if (btnCallChatClose) btnCallChatClose.onclick = () => closeCallChat();
  if (callChatSend) callChatSend.onclick = sendCallChat;
  if (callChatInput) {
    callChatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCallChat(); }
    });
    callChatInput.addEventListener("input", () => {
      callChatInput.style.height = "auto";
      callChatInput.style.height = Math.min(callChatInput.scrollHeight, 120) + "px";
    });
  }
  // 全屏状态变化（含按 ESC 退出）时同步按钮高亮
  const syncCallFullBtn = () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (btnCallFull) btnCallFull.classList.toggle("active", !!fsEl && fsEl === callPanel);
  };
  document.addEventListener("fullscreenchange", syncCallFullBtn);
  document.addEventListener("webkitfullscreenchange", syncCallFullBtn);
  if (btnIncomingAccept) btnIncomingAccept.onclick = acceptCall;
  if (btnIncomingDecline) btnIncomingDecline.onclick = declineCall;

  // 群会议事件
  if (groupMeetingBtn) groupMeetingBtn.onclick = onMeetingHeaderBtn;
  if (groupMeetingBtn2) groupMeetingBtn2.onclick = onMeetingHeaderBtn;
  if (btnMeetingMute) btnMeetingMute.onclick = toggleMeetingMute;
  if (btnMeetingCam) btnMeetingCam.onclick = toggleMeetingCam;
  if (btnMeetingShare) btnMeetingShare.onclick = toggleMeetingScreenShare;
  if (btnMeetingHangup) btnMeetingHangup.onclick = () => leaveGroupMeeting(false); // 软离开：可重入会
  if (btnMeetingLeave) btnMeetingLeave.onclick = () => leaveGroupMeeting(false);   // 软离开：可重入会
  if (btnMeetingFull) btnMeetingFull.onclick = toggleMeetingFullscreen;
  if (btnMeetingSpotExit) btnMeetingSpotExit.onclick = exitSpotlight;
  // 会议内聊天事件
  if (btnMeetingChat) btnMeetingChat.onclick = toggleMeetingChat;
  if (btnMeetingChatClose) btnMeetingChatClose.onclick = () => closeMeetingChat();
  if (meetingChatSend) meetingChatSend.onclick = sendMeetingChat;
  if (meetingChatInput) {
    meetingChatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); sendMeetingChat(); }
    });
    meetingChatInput.addEventListener("input", () => {
      meetingChatInput.style.height = "auto";
      meetingChatInput.style.height = Math.min(meetingChatInput.scrollHeight, 120) + "px";
    });
  }
  // 全屏状态由浏览器原生事件驱动（兼容 ESC 退出），同步按钮高亮
  const _meetFsChange = () => {
    if (!btnMeetingFull) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    btnMeetingFull.classList.toggle("active", !!fsEl && (fsEl === meetingPanel));
  };
  document.addEventListener("fullscreenchange", _meetFsChange);
  document.addEventListener("webkitfullscreenchange", _meetFsChange);
  // 点击任一视频瓦片：聚焦该成员（大画面），再次点击同一瓦片退出聚焦
  if (meetingPanel) {
    meetingPanel.addEventListener("click", (e) => {
      const tile = e.target.closest(".meeting-tile");
      if (!tile || !meetingPanel.contains(tile)) return;
      const uid = tile.dataset.uid;
      if (!uid) return;
      toggleSpotlight(uid);
    });
  }
  if (btnMeetingRejoin) btnMeetingRejoin.onclick = rejoinGroupMeeting;
  if (btnMeetingCloseLeft) btnMeetingCloseLeft.onclick = () => leaveGroupMeeting(true); // 彻底关闭
  if (btnGroupCallJoin) btnGroupCallJoin.onclick = () => {
    const pg = pendingGroupCall;
    if (pg) joinGroupMeeting(pg.groupId, pg.media, pg.from);
  };
  if (btnGroupCallIgnore) btnGroupCallIgnore.onclick = hideGroupCallInvite;

  // 独立会议房间：顶栏按钮创建会议 / 会议内复制邀请链接 / 访客入会
  if (meetingStartBtn) meetingStartBtn.onclick = createMeeting;
  if (btnMeetingCopyLink) btnMeetingCopyLink.onclick = copyMeetingLink;
  if (guestJoinForm) guestJoinForm.addEventListener("submit", onGuestJoinSubmit);
  if (guestToLogin) guestToLogin.onclick = (e) => { e.preventDefault(); showAuth(); };

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
  // 非中文环境使用的 STUN（国内网络通常不通的 Google/Twilio 公共节点）
  const DEFAULT_ICE_FOREIGN = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ];
  function isZhLocale() {
    const nav = (navigator.language || "zh-CN").toLowerCase();
    return nav.startsWith("zh");
  }
  let cachedIceServers = null;
  function rtcConfig() {
    const fallback = isZhLocale() ? DEFAULT_ICE : DEFAULT_ICE_FOREIGN;
    const servers = (cachedIceServers && cachedIceServers.length) ? cachedIceServers : fallback;
    return { iceServers: servers };
  }

  // 固定状态文本 → i18n key 映射（调用点传中文即可自动翻译，语言切换时由 applyI18n 刷新）
  const STATUS_KEY_MAP = {
    "信令已连接": "chat.status.signalConnected",
    "信令断开": "chat.status.signalDisconnected",
    "对方不在线（可发送离线消息）": "chat.status.offline",
    "对方已结束对话（仍可发送离线消息）": "chat.status.peerEnded",
    "P2P 已直连 🔗": "chat.status.p2p",
    "正在连接…": "chat.status.connecting",
    "未连接": "chat.status.disconnected",
    "在线": "chat.status.online",
    "离线": "chat.status.offlineLabel",
    "中继模式（服务器转发）": "chat.status.relayMode",
    "请先选择一个好友": "chat.status.pickFriend",
    "请先选择一个群聊": "chat.status.pickGroup",
    "连接中，请稍候…": "chat.status.connecting2",
    "已发送": "chat.status.sent",
    "已发送（对方可能离线，上线后接收）": "chat.status.sentOffline",
    "已发送（离线消息，对方上线后接收）": "chat.status.sentOffline2"
  };
  function setChatStatus(text, cls, opts) {
    opts = opts || {};
    const key = opts.key || STATUS_KEY_MAP[text];
    if (key) { i18nText(chatStatus, key, opts.params); }
    else { chatStatus.textContent = text; delete chatStatus.dataset.i18nKey; delete chatStatus.dataset.i18nParams; }
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
    if (meetingActive || meetingLeft) leaveGroupMeeting(false); // 软离开：保留重入会入口
    chatPanel.hidden = true; document.body.classList.remove("chat-open"); chatVisible = false;
    chatPanel.classList.remove("mobile-conversation");
    updateCallButtons();
  }
  // ---------- 设置抽屉 ----------
  const settingsPanel = $("#settingsPanel");
  function refreshThemeToggle() {
    const el = $("#themeToggleBtn");
    if (!el) return;
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    el.textContent = t(isDark ? "settings.theme.dark" : "settings.theme.light");
  }
  function openSettings() {
    settingsPanel.hidden = false;
    refreshThemeToggle();
  }
  function closeSettings() { settingsPanel.hidden = true; }
  const settingsClose = $("#settingsClose");
  if (settingsClose) settingsClose.onclick = closeSettings;
  const logoutBtn2 = $("#logoutBtn2");
  if (logoutBtn2) logoutBtn2.onclick = logout;

  // 清空本地缓存：保留登录、语言、主题等偏好，清除聊天记录与界面布局等本地缓存
  const clearCacheBtn = $("#clearCacheBtn");
  if (clearCacheBtn) clearCacheBtn.onclick = () => {
    if (!confirm(t("settings.clearCacheConfirm"))) return;
    const keep = [TOKEN_KEY, LANG_KEY, THEME_KEY]; // 白名单：保留登录与偏好
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && !keep.includes(k)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
    loadConversations();
    if (typeof renderConversations === "function") renderConversations();
    closeSettings();
    toast(t("settings.cacheCleared"));
  };

  // 移动端单栏：窄屏进入会话/详情时切到“全屏聊天”态（隐藏列表）；返回/关闭时退回列表
  function maybeMobileConversation() {
    if (window.innerWidth <= 768) chatPanel.classList.add("mobile-conversation");
  }
  const chatBackBtn = $("#chatBackBtn");
  if (chatBackBtn) chatBackBtn.onclick = () => chatPanel.classList.remove("mobile-conversation");

  // ---------- 聊天面板拖拽调整宽度 ----------
  function initChatResizer() {
    const saved = parseInt(localStorage.getItem("chatPanelWidth"), 10);
    if (saved && saved >= 320 && saved <= window.innerWidth - 80) chatPanel.style.width = saved + "px";

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
    const panelW = chatPanel.getBoundingClientRect().width || window.innerWidth;
    if (saved && saved >= 180 && saved <= panelW - 200) sidebar.style.width = saved + "px";

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
    let wsUrl = `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`;
    // 访客通过会议链接 + 昵称入会：把 room/name 拼到 ws url，服务端据此分配临时身份
    if (isGuest && guestRoomId) {
      wsUrl += `&room=${encodeURIComponent(guestRoomId)}&name=${encodeURIComponent(guestName || "Guest")}`;
    }
    const ws = new WebSocket(wsUrl);
    sigSocket = ws;
    return new Promise((resolve) => {
      ws.onopen = () => {
        sigReconnectDelay = 1000; // 连接成功，重置退避
        console.log("[SIG-CLIENT] ws 已打开，信令连接成功 (token len=" + token.length + ")");
        setChatStatus("信令已连接", "ok");
        subscribePresence();
        flushPending();            // 断网恢复后把本地未同步的消息补推到服务端
        flushPendingSignals();     // 冲刷自动入会时缓存的 room-* 信令（如 room-join）
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
        try { toast(tp("chat.request.recv", { name: m.fromUsername || "好友" })); } catch (e) { console.error("[SIG-CLIENT] toast 失败:", e); }
        try { loadFriends(); } catch (e) { console.error("[SIG-CLIENT] loadFriends 失败:", e); }
        break;
      case "friend-accepted":
        // 对方通过了我的好友请求：弹提示并刷新好友列表
        try { toast(tp("chat.friend.requested", { name: m.fromUsername || "好友" })); } catch (e) { console.error("[SIG-CLIENT] toast 失败:", e); }
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
      case "meeting-chat": {
        // 会议内聊天：仅渲染到会议聊天抽屉（会议进行中或刚软离开时）
        if (typeof onMeetingMessage === "function") {
          onMeetingMessage({ id: m.id, groupId: m.groupId, from: m.from, text: m.text, ts: m.ts || Date.now() });
        }
        break;
      }
      case "call-chat": {
        // 一对一通话内的文字聊天：仅渲染到通话聊天抽屉（且对端须是当前通话对象）
        if (typeof onCallChatMessage === "function") {
          onCallChatMessage({ id: m.id, from: m.from, text: m.text, ts: m.ts || Date.now() });
        }
        break;
      }
      case "group-invite":
        // 被加入群聊：刷新群列表（并补算未读），把该群会话前置
        try { toast(tp("chat.pulled.in", { name: m.group?.name || "群聊" })); } catch {}
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
      case "group-roster":
        // 服务端回执的权威会议成员名单：以它为准建立（补齐）全网状连接
        onGroupRoster(m.groupId, m.members);
        break;
      case "group-screen":
        // 某成员开始共享屏幕：标记其瓦片为 contain（完整显示，不裁切）
        onGroupScreen(m.groupId, m.from);
        break;
      case "group-screen-stop":
        // 某成员停止共享屏幕：恢复普通视频裁切显示
        onGroupScreenStop(m.groupId, m.from);
        break;
      case "group-cam":
        // 某成员摄像头开关：标记其瓦片是否显示头像占位
        onGroupCam(m.groupId, m.from, m.on);
        break;
      // ---- 独立会议房间信令（与群会议对称，key 为 roomId）----
      case "room-join":
        onRoomJoin(m.from, m.name);
        break;
      case "room-leave":
        onRoomLeave(m.from);
        break;
      case "room-roster":
        onRoomRoster(m.roomId, m.members);
        break;
      case "room-screen":
        onRoomScreen(m.from, true);
        break;
      case "room-screen-stop":
        onRoomScreen(m.from, false);
        break;
      case "room-cam":
        onRoomCam(m.from, m.on);
        break;
      case "room-chat":
        onRoomChat(m);
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
  function renderFriendList() {
    // 待通过请求
    friendRequestsEl.innerHTML = "";
    if (friendRequests.length) {
      friendRequestsEl.hidden = false;
      friendRequests.forEach((r) => {
        const row = document.createElement("div");
        row.className = "req-row";
        const label = document.createElement("span");
        label.className = "req-name";
        label.textContent = tp("chat.friend.request", { name: r.username });
        const btn = document.createElement("button");
        btn.className = "btn primary small";
        i18nText(btn, "chat.friend.accept");
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
            `<button class="friend-remove" data-i18n-title="chat.friend.remove">✕</button>`;
        const open = () => showFriendDetail(f);
        row.onclick = open;
        row.querySelector(".friend-remove").onclick = (e) => {
          e.stopPropagation();
          removeFriend(f);
        };
        friendListEl.appendChild(row);
      });
    }
  }
  // 完整刷新（好友 + 会话列表 + 标签徽章）；renderFriendList 只刷好友侧（用于切换会话时清好友高亮，避免连带重建会话列表）
  function renderFriends() {
    renderFriendList();
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
        ? tp("chat.became.friend", { name: r.friend.username })
        : tp("chat.sent.request", { name: r.friend.username }));
      await loadFriends();
      // 新加好友（已成为好友）→ 把会话前置
      if (r.friend.status === "accepted") {
        const f = friends.find((x) => x.username === username);
        if (f) upsertConversation("peer", f.id, Date.now(), null, false);
      }
    } catch (e) {
      toast(e.message || t("chat.add.fail"));
    }
  }
  async function acceptRequest(id) {
    try {
      const req = friendRequests.find((x) => x.id === id);
      await api("/api/friends/accept", { method: "POST", body: JSON.stringify({ requestId: id }) });
      toast(t("chat.added"));
      await loadFriends();
      // 新加好友（对方通过请求）→ 把会话前置
      if (req) {
        const f = friends.find((x) => x.username === req.username);
        if (f) upsertConversation("peer", f.id, Date.now(), null, false);
      }
    } catch (e) {
      toast(e.message || t("chat.op.fail"));
    }
  }
  async function removeFriend(f) {
    if (!confirm(tp("chat.confirm.remove", { name: f.username }))) return;
    try {
      await api("/api/friends/" + f.id, { method: "DELETE" });
      toast(t("chat.removed"));
      if (currentPeer === f.id) endCurrent();
      await loadFriends();
    } catch (e) {
      toast(e.message || t("chat.op.fail"));
    }
  }

  // ---------- 会话（1:1）----------
  // 异步取消令牌：openConversation / openGroupConversation 都是 async 且内部有多处 await，
  // 快速连点时两个流程会并发交错写 currentPeer / DOM / 信令 / 通话，导致后一次打开被前一次残留
  // 流程覆盖或打断（表现为“点了没反应”）。用 token 保证“只有最后一次点击的流程”能跑完副作用。
  let activeOpenToken = 0;
  async function openConversation(f) {
    const myToken = ++activeOpenToken;
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
    maybeMobileConversation();
    switchChatTab("conversations");
    showChatView();
    currentPeerName = f.username;
    currentPeerAvatar = f.avatar || "";
    chatPeerName.textContent = f.username;
    delete chatPeerName.dataset.i18nKey;
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
    if (myToken !== activeOpenToken) return;
    await connectSignaling();
    if (myToken !== activeOpenToken) return;
    if (!sigSocket) return;
    startCall(f.id, f.username);
    // 再从服务端拉取本地缺失的历史（保留 3 个月），合并到本地
    await syncConversation(f.id);
    if (myToken !== activeOpenToken) return;
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
  let remoteIsSharingScreen = false; // 对端是否正在共享屏幕（决定远端视频用 contain 显示）
  let micMuted = false;
  let camOff = false;
  let screenStream = null;         // 屏幕共享流（getDisplayMedia）
  let isSharingScreen = false;     // 是否正在共享屏幕
  let incomingCallFrom = null;     // 正在响铃的来电对象
  let incomingCallType = null;

  // ===================== 群会议（多人 WebRTC 全网状）=====================
  // 每个成员与群内其他在线成员各建一条 RTCPeerConnection（复用 peers map 与完美协商），
  // 无需媒体服务器；signal 仍按 userId 定向转发 SDP/ICE，“谁在会议里”由 group-call/join/leave 广播。
  let meetingActive = false;       // 是否正在群会议中
  let meetingGroupId = null;       // 会议所属群 id
  let meetingType = null;          // "audio" | "video"
  let meetingMembers = new Set();  // 会议成员 userId 集合（含自己 myId）
  let meetingLeft = false;         // 是否已软离开（保留 groupId/type，可重新加入）
  let spotlightUid = null;         // 聚焦观看的成员 uid（"self" 或数字 userId）；null 为网格模式
  let screenSharingMembers = new Set(); // 正在共享屏幕的会议成员 uid 集合（不含自己，自己单独标记）
  let camOffMembers = new Set();       // 已关闭摄像头的会议成员 uid 集合（不含自己，自己用 camOff 标记）
  // 待接听的群会议邀请（点击“加入”时用到）
  let pendingGroupCall = null;     // { groupId, from, media }
  // 独立会议房间（通过会议链接创建/加入，不依赖群）
  let meetingMode = "group";        // "group" | "room"
  let meetingRoomId = null;         // 房间模式下的会议 id（来自链接）
  let roomPeers = new Map();        // room 模式下 id -> { name, avatar }（用于瓦片/聊天昵称）
  let pendingSignals = [];          // 信令未连通时缓存的发送（如自动入会时房间 join）
  let pendingMeetingId = null;      // 启动/登录时从 URL ?meeting= 解析出的待加入会议 id
  let isGuest = false;              // 访客（未登录，通过 ?meeting= 链接 + 昵称入会）
  let guestName = "";               // 访客昵称
  let guestRoomId = null;           // 访客 WS 鉴权用的 room（拼到 ws url）
  let meetingJoinPending = false;   // 通过链接入会但尚在“点击加入”闸门（未取媒体）

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
      setChatStatus("", "warn", { key: "chat.status.connectingName", params: { name } });
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
        setChatStatus("", "warn", { key: "chat.status.chatReq", params: { name: f.username } });
        clearEntering();
      }
    }
    enableRelay(from);
  }

  function endCurrent() {
    if (callState !== "idle") endCall(); // 退出会话时若正在通话，先通知对方并清理
    if (meetingActive || meetingLeft) leaveGroupMeeting(false); // 软离开：保留重入会入口
    if (sigSocket && currentPeer != null) {
      try { sigSocket.send(JSON.stringify({ type: "bye", to: currentPeer })); } catch {}
    }
    dropPeerConn(currentPeer); // 仅结束当前好友的通话，其它好友连接保持
    currentPeer = null;
    currentPeerName = "";
    currentPeerAvatar = "";
    i18nText(chatPeerName, "chat.peer.placeholder");
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
      let stream = e.streams && e.streams[0];
      if (!stream) {
        // 某些浏览器 addTrack 未关联 stream 时 e.streams 为空，用事件轨道组装本地流，避免丢流黑屏
        try { stream = new MediaStream([e.track]); } catch { return; }
      }
      // 始终缓存，供会议加入后补渲染（避免“先收到流、后加入会议”导致画面缺失）
      peerStreams.set(id, stream);
      // 群会议成员：直接渲染到会议网格（每个成员一条独立 pc）
      if (meetingActive) {
        // 兜底：会议中收到未登记成员的流（如本地 g.members 快照滞后、权威名单尚未到达，
        // 或既有 1:1 连接未入会籍），立即登记并渲染，避免“重入会后少一个人”的瓦片缺失。
        if (!meetingMembers.has(id) && isGroupMemberId(meetingGroupId, id)) {
          meetingMembers.add(id);
          updateMeetingCount();
        }
        if (meetingMembers.has(id)) { attachMeetingStream(id, stream); return; }
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
    // 对端共享屏幕状态：远端视频改用 contain 完整显示（不裁切）
    if (data.kind === "screen") {
      remoteIsSharingScreen = !!data.on;
      if (remoteVideo) remoteVideo.classList.toggle("screen", remoteIsSharingScreen);
      return;
    }
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
    // 好友详情页语音/视频按钮：仅在好友资料视图可见且无进行中的通话时显示
    const friendShow = idle && !friendView.hidden;
    if (friendVoiceCallBtn) friendVoiceCallBtn.hidden = !friendShow;
    if (friendVideoCallBtn) friendVideoCallBtn.hidden = !friendShow;
    updateMeetingButtons();
  }

  async function startMediaCall(peerId, type) {
    peerId = Number(peerId);
    if (callState !== "idle") { toast(t("call.busy")); return; }
    if (meetingActive) { toast(t("call.leaveMeetingFirst")); return; }
    const f = friends.find((x) => x.id === peerId);
    if (!f) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast(t("call.noMediaSupport")); return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (err) {
      toast(t("call.noMediaAccess") + ((err && err.message) || err.name || err));
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
    if (btnCallShare) { btnCallShare.hidden = type !== "video"; btnCallShare.classList.remove("active"); }
    // 新通话开始：复位屏幕共享状态
    isSharingScreen = false;
    screenStream = null;
  }

  const CALLSTATE_KEY_MAP = {
    "等待对方接听…": "call.state.ringing",
    "通话中": "call.state.connected",
    "呼叫中…": "call.state.calling",
    "重连中…": "call.state.reconnecting"
  };
  function setCallStateLabel(text, opts) {
    opts = opts || {};
    const key = opts.key || CALLSTATE_KEY_MAP[text];
    if (callStateLabel) {
      if (key) i18nText(callStateLabel, key, opts.params);
      else { callStateLabel.textContent = text || ""; delete callStateLabel.dataset.i18nKey; }
    }
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
    // 来电卡片已脱离 chatPanel 成为独立浮层，无论聊天面板是否打开都弹出
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
    if (incomingType) i18nText(incomingType, type === "video" ? "call.incoming.videoMsg" : "call.incoming.voiceMsg");
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
      toast(t("call.noMediaSupport")); declineCall(); return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (err) {
      toast(t("call.noMediaAccess") + ((err && err.message) || err.name || err));
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
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
    }
    isSharingScreen = false;
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
    closeCallChat();
    resetCallChatList();
    resetCallState();
  }

  function resetCallState() {
    callPeerId = null;
    callType = null;
    callState = "idle";
    callIsCaller = false;
    pendingRemoteStream = null;
    remoteIsSharingScreen = false;
    if (remoteVideo) remoteVideo.classList.remove("screen");
    micMuted = false; camOff = false;
    incomingCallFrom = null;
    incomingCallType = null;
    updateCallButtons();
  }

  function handleMediaControl(data, from) {
    from = Number(from);
    if (data.action === "decline") {
      if (callIsCaller && callPeerId === from) {
        toast(t("call.rejected"));
        endCallLocal();
      }
    } else if (data.action === "end") {
      if (callPeerId === from) {
        toast(t("call.ended"));
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

  // 屏幕共享：仅在视频通话中可用。用 getDisplayMedia 取得屏幕流，
  // 通过 RTCRtpSender.replaceTrack 替换已发送的视频轨道（无需重协商），对方即看到你的屏幕。
  async function toggleScreenShare() {
    if (callType !== "video" || callState !== "active") {
      toast(t("call.shareVideoOnly")); return;
    }
    if (isSharingScreen) { await stopScreenShare(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast(t("call.noShareSupport")); return;
    }
    let screen;
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    } catch (err) {
      toast(t("call.shareFail") + ((err && err.message) || err.name || err));
      return;
    }
    const p = ensurePeerConn(callPeerId);
    const sender = p && p.pc ? p.pc.getSenders().find((s) => s.track && s.track.kind === "video") : null;
    if (!sender) {
      screen.getTracks().forEach((t) => t.stop());
      toast(t("call.noVideoTrack")); return;
    }
    const screenTrack = screen.getVideoTracks()[0];
    try { await sender.replaceTrack(screenTrack); } catch (e) { console.error("[WEBRTC] replaceTrack failed", e); }
    screenStream = screen;
    isSharingScreen = true;
    if (localVideo) { localVideo.srcObject = screenStream; localVideo.classList.add("screen"); } // 本地预览切到屏幕（contain 完整显示）
    if (btnCallShare) btnCallShare.classList.add("active");
    // 通知对端：本端开始共享，远端视频改用 contain 完整显示
    if (callPeerId != null) sendSignal(callPeerId, { kind: "screen", on: true });
    // 浏览器原生“停止共享”时同步状态
    screenTrack.onended = () => { stopScreenShare(); };
  }

  async function stopScreenShare() {
    if (!isSharingScreen || !screenStream) return;
    const p = ensurePeerConn(callPeerId);
    const camTrack = localStream ? localStream.getVideoTracks()[0] : null;
    if (p && p.pc && camTrack) {
      const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) { try { await sender.replaceTrack(camTrack); } catch (e) { console.error("[WEBRTC] replaceTrack back failed", e); } }
    }
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
    isSharingScreen = false;
    if (localVideo) { if (localStream) localVideo.srcObject = localStream; localVideo.classList.remove("screen"); } // 预览切回摄像头
    if (btnCallShare) btnCallShare.classList.remove("active");
    // 通知对端：本端停止共享，远端视频恢复裁切显示
    if (callPeerId != null) sendSignal(callPeerId, { kind: "screen", on: false });
  }

  // 全屏：把整个通话面板（含远端视频、本端画中画、控制条）切到全屏，再次点击退出。
  // 兼容标准 Fullscreen API 与 Safari 的 webkit 前缀。
  function toggleCallFullscreen() {
    if (!callPanel) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) { try { exit.call(document); } catch (e) { console.error("[UI] 退出全屏失败", e); } }
    } else {
      const req = callPanel.requestFullscreen || callPanel.webkitRequestFullscreen;
      if (req) { try { req.call(callPanel); } catch (e) { console.error("[UI] 全屏失败", e); } }
    }
  }

  // ===================== 群会议（多人 WebRTC 全网状）=====================
  // 每个成员与群内其他在线成员各建一条 RTCPeerConnection（复用 peers map 与完美协商），
  // 无需媒体服务器；SDP/ICE 仍走 signal（按 userId 定向），“谁在会议里”由 group-call/join/leave 广播。
  async function startGroupMeeting(groupId, type) {
    groupId = Number(groupId);
    type = type === "audio" ? "audio" : "video";
    if (callState !== "idle") { toast(t("call.endCallFirst")); return; }
    if (meetingActive) { toast(t("meeting.alreadyIn")); return; }
    const g = groups.find((x) => x.id === groupId);
    if (!g) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast(t("meeting.noSupport")); return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (err) {
      toast(t("call.noMediaAccess") + ((err && err.message) || err.name || err));
      return;
    }
    meetingActive = true;
    meetingMode = "group";
    meetingGroupId = groupId;
    meetingType = type;
    meetingMembers = new Set([myId]);
    micMuted = false; camOff = false;
    bindMeetingLocal();
    showMeetingPanel(g);
    // 与所有群成员建立连接（不以 g.members[].online 过滤：该字段仅 loadGroups 时快照，
    // 可能落后于真实在线状态，按它过滤会在重入会时漏掉“快照中离线、实际在线”的成员）。
    // 真正可达性由 WebRTC 连接本身判定，离线成员的连接会在失败时自动清理。
    const others = (g.members || []).filter((m) => m.id !== myId);
    others.forEach((m) => connectMeetingPeer(m.id));
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "group-call", groupId, media: type }));
    }
    toast(t("meeting.inviting"));
    updateMeetingButtons();
  }

  async function joinGroupMeeting(groupId, type, from) {
    groupId = Number(groupId);
    type = type === "audio" ? "audio" : "video";
    if (callState !== "idle") { toast(t("call.endCallFirst")); return; }
    if (meetingActive && meetingGroupId !== groupId) { toast(t("meeting.inOther")); return; }
    const g = groups.find((x) => x.id === groupId);
    if (!g) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast(t("meeting.noSupport")); return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (err) {
      toast(t("call.noMediaAccess") + ((err && err.message) || err.name || err));
      return;
    }
    meetingActive = true;
    meetingMode = "group";
    meetingGroupId = groupId;
    meetingType = type;
    // 重入会时不要沿用软离开时残留的 meetingMembers（可能含已退会成员），重建为只含自己
    meetingMembers = new Set([myId]);
    micMuted = false; camOff = false;
    bindMeetingLocal();
    showMeetingPanel(g);
    // 与所有群成员建立连接（不以在线快照过滤，见 startGroupMeeting 说明）；全网状
    const others = (g.members || []).filter((m) => m.id !== myId);
    others.forEach((m) => connectMeetingPeer(m.id));
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "group-join", groupId }));
    }
    hideGroupCallInvite();
    updateMeetingButtons();
  }

  // 与某一群成员建立（或复用）一条带媒体的 pc；全网状核心：每人各持一条到其它成员的 pc
  // 立即为会议成员创建头像占位瓦片（远端流到达前就可见“已加入”），流到达后 ontrack 补全视频
  function ensureMeetingTile(id) {
    if (!meetingActive) return;
    attachMeetingStream(id, null);
  }

  async function connectMeetingPeer(memberId) {
    memberId = Number(memberId);
    if (memberId === myId || !meetingActive) return;
    const p = ensurePeerConn(memberId);
    const st = p.pc ? p.pc.connectionState : null;
    // 已连接 / 连接中：无需重建，仅兼容“迟到补加媒体”，并补渲染已缓存的远端流
    if (p.pc && (st === "connected" || st === "connecting" || st === "new")) {
      if (localStream && !p.mediaAdded) addLocalMediaTracks(p);
      maybeApplyScreenShare(p); // 共享中：迟到成员也立即发送屏幕轨道
      // 已存在的连接也要登记为会议成员（如会议前已存在 1:1 pc，早期返回没加过），
      // 否则该成员流到达时因不在 meetingMembers 而不渲染，造成瓦片缺失。
      meetingMembers.add(memberId);
      if (meetingActive) ensureMeetingTile(memberId);
      if (peerStreams.has(memberId)) attachMeetingStream(memberId, peerStreams.get(memberId));
      return;
    }
    teardownPeer(memberId);
    try {
      p.pc = new RTCPeerConnection(rtcConfig());
      p.pc._peerId = memberId;
      setupPc(p);
      p.mediaAdded = false;
      meetingMembers.add(memberId);
      if (meetingActive) ensureMeetingTile(memberId); // 立即出现头像占位，确保“已加入”可见
      // 群会议：立即携带本端媒体（mesh 每人各自带媒体，无需等对方先发 offer），触发协商
      if (localStream) {
        addLocalMediaTracks(p);
      } else {
        // 无本地媒体（无摄像头 / insecure context）：【不要】发“空协商（空 offer）”。
        // 空 offer 不含任何媒体 m-line，会使本次协商中对方即便有摄像头也无法下行视频（最终黑屏）。
        // 这里仅建立 RTCPeerConnection，等待有媒体的一方发起 offer；对方 answer 后视频正常下行。
        // （若双方都无媒体则不建立连接，但头像占位瓦片已显示，符合预期。）
      }
      maybeApplyScreenShare(p); // 共享中：新连接也立即发送屏幕轨道
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
      if (btnMeetingShare) { btnMeetingShare.hidden = meetingType !== "video"; btnMeetingShare.classList.remove("active"); }
    }
    // 新会议开始：复位摄像头/屏幕共享状态（与 1:1 共用，互斥）
    if (btnMeetingCam) { btnMeetingCam.textContent = "📹"; btnMeetingCam.classList.remove("off"); }
    camOff = false;
    isSharingScreen = false;
    screenStream = null;
    // 本端头像占位（关摄像头 / 未共享 / 未拿到媒体时居中显示）
    if (meetingSelfAvatar) {
      const selfName = currentUsername || (typeof guestName === "string" ? guestName : "");
      const selfLetter = (selfName || "?").trim().charAt(0).toUpperCase() || "?";
      const av = (typeof myAvatar === "string" && myAvatar) ? myAvatar : "";
      meetingSelfAvatar.innerHTML = av
        ? renderAvatar(av, selfLetter)
        : '<span class="avatar-letter">' + escapeHtml(selfLetter) + "</span>";
    }
    updateTileVideoState("self");
  }

  function showMeetingPanel(g) {
    if (!meetingPanel) return;
    meetingPanel.hidden = false;
    if (meetingGroupName) {
      const name = (g && g.name) || t("meeting.title");
      meetingGroupName.textContent = name;
      delete meetingGroupName.dataset.i18nKey;
    }
    if (btnMeetingCopyLink) btnMeetingCopyLink.hidden = (meetingMode !== "room");
    updateMeetingCount();
  }

  function updateMeetingCount() {
    if (!meetingCount) return;
    i18nText(meetingCount, "meeting.count", { n: meetingMembers.size });
  }

  // 全屏：把整个会议面板切到全屏，再次点击退出（兼容 Safari webkit 前缀）。
  function toggleMeetingFullscreen() {
    if (!meetingPanel) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) { try { exit.call(document); } catch (e) { console.error("[UI] 退出全屏失败", e); } }
    } else {
      const req = meetingPanel.requestFullscreen || meetingPanel.webkitRequestFullscreen;
      if (req) { try { req.call(meetingPanel); } catch (e) { console.error("[UI] 全屏失败", e); } }
    }
  }

  // 点击瓦片切换聚焦：同一瓦片再点一次退出；点不同瓦片切换聚焦对象。
  function toggleSpotlight(uid) {
    if (spotlightUid != null && String(spotlightUid) === String(uid)) {
      exitSpotlight();
    } else {
      enterSpotlight(uid);
    }
  }

  function enterSpotlight(uid) {
    if (!meetingGrid) return;
    spotlightUid = uid;
    if (meetingPanel) meetingPanel.classList.add("spotlight");
    if (btnMeetingSpotExit) btnMeetingSpotExit.hidden = false;
    // 收集所有瓦片（主网格 + 胶片条都可能含瓦片，切换聚焦时需统一重排）
    const allTiles = Array.from(meetingGrid.querySelectorAll(".meeting-tile"));
    if (meetingFilmstrip) meetingFilmstrip.querySelectorAll(".meeting-tile").forEach((t) => allTiles.push(t));
    allTiles.forEach((tile) => {
      const isSpot = String(tile.dataset.uid) === String(uid);
      tile.classList.toggle("spotlight", isSpot);
      // 被聚焦者进主网格（大画面），其余进底部胶片条（横向一排）
      const target = isSpot ? meetingGrid : meetingFilmstrip;
      if (tile.parentElement !== target) target.appendChild(tile);
    });
    if (meetingFilmstrip) meetingFilmstrip.hidden = false;
  }

  function exitSpotlight() {
    spotlightUid = null;
    if (meetingPanel) meetingPanel.classList.remove("spotlight");
    if (btnMeetingSpotExit) btnMeetingSpotExit.hidden = true;
    // 胶片条中的瓦片全部移回主网格，并取消聚焦高亮
    if (meetingFilmstrip) {
      Array.from(meetingFilmstrip.querySelectorAll(".meeting-tile")).forEach((tile) => {
        tile.classList.remove("spotlight");
        meetingGrid.appendChild(tile);
      });
      meetingFilmstrip.hidden = true;
    }
    if (meetingGrid) meetingGrid.querySelectorAll(".meeting-tile.spotlight").forEach((t) => t.classList.remove("spotlight"));
  }

  // 将某成员的远端流挂到会议网格的一个瓦片里（按 userId 区分）。
  // 聚焦模式下：被聚焦的成员留在主网格（大画面），其余成员进入底部胶片条。
  function attachMeetingStream(id, stream) {
    if (!meetingGrid) return;
    let tile = meetingGrid.querySelector('.meeting-tile[data-uid="' + id + '"]')
            || (meetingFilmstrip && meetingFilmstrip.querySelector('.meeting-tile[data-uid="' + id + '"]'));
    if (!tile) {
      tile = document.createElement("div");
      tile.className = "meeting-tile";
      tile.dataset.uid = id;
      const v = document.createElement("video");
      v.className = "meeting-video";
      v.autoplay = true; v.playsInline = true;
      const nm = document.createElement("span");
      nm.className = "meeting-name";
      const info = meetingPeerInfo(id);
      nm.textContent = info.name || String(id);
      // 无视频（摄像头关闭且未共享屏幕）时居中显示头像占位
      const av = document.createElement("div");
      av.className = "meeting-avatar";
      const letter = (info.name || String(id)).trim().charAt(0).toUpperCase() || "?";
      av.innerHTML = info.avatar
        ? renderAvatar(info.avatar, letter)
        : '<span class="avatar-letter">' + escapeHtml(letter) + "</span>";
      tile.appendChild(v);
      tile.appendChild(av);
      tile.appendChild(nm);
      const init = (info.name || String(id)).trim().charAt(0).toUpperCase();
      tile.dataset.initial = init || "?";
      // 若该成员正在共享屏幕，直接标记为 contain 显示（避免后续才收到广播导致先被裁切）
      if (screenSharingMembers.has(Number(id))) tile.classList.add("screen");
      // 聚焦模式且不是被聚焦者 → 进胶片条；否则进主网格
      const intoStrip = spotlightUid != null && String(spotlightUid) !== String(id);
      const container = (intoStrip && meetingFilmstrip) ? meetingFilmstrip : meetingGrid;
      container.appendChild(tile);
      if (spotlightUid != null && String(spotlightUid) === String(id)) {
        tile.classList.add("spotlight");
      }
      updateMeetingCount();
    }
    const v = tile.querySelector("video");
    if (v.srcObject !== stream) v.srcObject = stream;
    updateTileVideoState(id); // 同步头像占位显示（摄像头关 / 未共享时）
  }

  function removeMeetingTile(id) {
    if (!meetingGrid) return;
    const tile = meetingGrid.querySelector('.meeting-tile[data-uid="' + id + '"]')
              || (meetingFilmstrip && meetingFilmstrip.querySelector('.meeting-tile[data-uid="' + id + '"]'));
    if (tile) tile.remove();
    // 被聚焦的成员离开 → 退出聚焦模式，恢复网格
    if (spotlightUid != null && String(spotlightUid) === String(id)) exitSpotlight();
    updateMeetingCount();
  }

  function clearMeetingTiles() {
    if (meetingGrid) meetingGrid.querySelectorAll(".meeting-tile:not(.self)").forEach((t) => t.remove());
    if (meetingFilmstrip) meetingFilmstrip.innerHTML = "";
  }

  // 离开会议。soft=false 为彻底关闭（清空所有状态、隐藏面板）；soft=true 为软离开：
  // 仅断开媒体与成员连接，但保留 meetingGroupId/meetingType 与“已离开”标记，
  // 面板转入“你已离开会议”状态，提供「重新加入」入口，实现离开后可重入会。
  function leaveGroupMeeting(soft) {
    // 独立房间模式：复用 room-* 信令的离开逻辑（签名一致：soft=false 为硬关闭）
    if (meetingMode === "room") { leaveMeetingRoom(soft); return; }
    const wasInMeeting = meetingActive || meetingLeft;
    if (!wasInMeeting) return;
    // 仍在会议中才广播离开，通知其它成员移除本端瓦片（软离开后再次彻底关闭则无需重复广播）
    if (meetingActive && sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "group-leave", groupId: meetingGroupId }));
    }
    // 关闭所有会议成员 pc（同时清理 peers map 条目，避免与 1:1 连接互相污染）
    for (const id of meetingMembers) {
      if (id !== myId) dropPeerConn(id);
    }
    clearMeetingTiles();
    // 复位聚焦状态（离开会议后下次进入应为网格模式）
    spotlightUid = null;
    screenSharingMembers = new Set();
    if (meetingPanel) meetingPanel.classList.remove("spotlight");
    if (btnMeetingSpotExit) btnMeetingSpotExit.hidden = true;
    if (meetingFilmstrip) meetingFilmstrip.hidden = true;
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
    }
    isSharingScreen = false;
    if (btnMeetingShare) btnMeetingShare.classList.remove("active");
    camOffMembers = new Set(); // 清空远端关摄像头标记
    if (meetingLocalVideo) meetingLocalVideo.srcObject = null;
    meetingActive = false;
    if (soft) {
      // 软离开：保留 groupId/type，转入“已离开”状态，可重新加入
      meetingLeft = true;
      showMeetingLeft();
    } else {
      // 彻底关闭
      meetingLeft = false;
      meetingGroupId = null;
      meetingType = null;
      meetingMembers = new Set();
      hideMeetingLeft();
      if (meetingPanel) meetingPanel.hidden = true;
      closeMeetingChat();
      if (meetingChatList) meetingChatList.innerHTML = ""; // 彻底关闭：清空会议聊天记录
    }
    updateMeetingButtons();
  }

  // 转入“已离开会议”状态：面板保持打开但隐藏视频网格与控制条，显示重新加入入口
  function showMeetingLeft() {
    if (meetingPanel) { meetingPanel.hidden = false; meetingPanel.classList.add("left"); }
    if (meetingLeftBar) meetingLeftBar.hidden = false;
    // 通过链接入会但尚在“点击加入”闸门：把提示语/按钮改为“加入”
    const leftText = meetingLeftBar && meetingLeftBar.querySelector(".meeting-left-text");
    if (meetingJoinPending) {
      if (leftText) i18nText(leftText, "meeting.joinHint");
      if (btnMeetingRejoin) i18nText(btnMeetingRejoin, "meeting.join");
    } else {
      if (leftText) i18nText(leftText, "meeting.left");
      if (btnMeetingRejoin) i18nText(btnMeetingRejoin, "meeting.rejoin");
    }
    // 复位控制按钮的静音/摄像头视觉状态
    if (btnMeetingMute) { btnMeetingMute.textContent = "🎤"; btnMeetingMute.classList.remove("off"); }
    if (btnMeetingCam) { btnMeetingCam.textContent = "📹"; btnMeetingCam.classList.remove("off"); }
  }
  function hideMeetingLeft() {
    if (meetingPanel) meetingPanel.classList.remove("left");
    if (meetingLeftBar) meetingLeftBar.hidden = true;
  }

  // ===================== 独立会议房间（通过链接创建/加入，不依赖群）=====================
  // 与会者通过会议链接 ?meeting=<id> 加入；WebRTC 网格与群会议完全复用，
  // 仅信令改用 room-* 类型、参与名单由服务端内存房间维护。

  // 生成会议房间 id（去除易混淆字符）
  function randomRoomId() {
    const chars = "abcdefghijkmnpqrstuvwxyz23456789";
    let s = "";
    for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // 会议邀请链接（用于复制/分享）
  function meetingInviteLink(roomId) {
    return location.origin + location.pathname + "?meeting=" + encodeURIComponent(roomId);
  }

  // 统一信令发送：未连通时缓存，连通后由 onopen 冲刷（解决自动入会时信令尚未就绪）
  function emitSignal(obj) {
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      try { sigSocket.send(JSON.stringify(obj)); } catch { /* ignore */ }
    } else {
      pendingSignals.push(obj);
    }
  }
  function flushPendingSignals() {
    if (!sigSocket || sigSocket.readyState !== WebSocket.OPEN) return;
    const arr = pendingSignals; pendingSignals = [];
    for (const o of arr) { try { sigSocket.send(JSON.stringify(o)); } catch { /* ignore */ } }
  }

  // 加入（或创建）一个独立会议房间。roomId 为要加入的房间；为空则视为创建新会议。
  async function joinMeeting(roomId, type) {
    type = type === "audio" ? "audio" : "video";
    if (callState !== "idle") { toast(t("call.endCallFirst")); return; }
    if (meetingActive) {
      if (String(meetingRoomId) === String(roomId)) return; // 已在同会议
      toast(t("meeting.inOther")); return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast(t("meeting.noSupport")); }
    // 获取媒体失败（无摄像头 / insecure context / 拒绝授权）不阻断入会：
    // 仍建立连接并看到他人，他人看到自己的头像占位。否则新人因拿不到媒体而“根本没加入会议”。
    let gotMedia = false;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
      gotMedia = true;
    } catch (err) {
      localStream = null;
      console.warn("[MEETING] 获取媒体失败，仅以无媒体方式入会:", (err && err.message) || err);
      toast(t("call.noMediaAccess") + ((err && err.message) || err.name || err));
    }
    meetingMode = "room";
    meetingRoomId = String(roomId);
    meetingActive = true;
    meetingType = type;
    meetingMembers = new Set([myId]);
    meetingLeft = false;
    meetingJoinPending = false;
    roomPeers = new Map();
    micMuted = false; camOff = false;
    hideMeetingLeft(); // 闸门→进入会议：移除 .left 类，否则 CSS 把 .meeting-grid 和 .call-controls 都隐藏了
    bindMeetingLocal();
    showMeetingPanel(null);
    if (meetingGroupName) i18nText(meetingGroupName, "meeting.roomTitle");
    if (btnMeetingCopyLink) btnMeetingCopyLink.hidden = false;
    if (meetingPanel) meetingPanel.dataset.room = meetingRoomId;
    // 通知房间内其它成员并拉取权威名单
    emitSignal({ type: "room-join", roomId: meetingRoomId });
    toast(t("meeting.inviting"));
    updateMeetingButtons();
  }

  // 创建会议：生成房间 id 后加入
  async function createMeeting() {
    if (callState !== "idle") { toast(t("call.endCallFirst")); return; }
    if (meetingActive) { toast(t("meeting.alreadyIn")); return; }
    const roomId = randomRoomId();
    await joinMeeting(roomId, "video");
    toast(t("meeting.inviteHint"));
  }

  // 软/硬离开独立会议房间（与 leaveGroupMeeting 对称，仅用 room-* 信令）
  function leaveMeetingRoom(soft) {
    const wasIn = meetingActive || meetingLeft;
    if (!wasIn) return;
    if (meetingActive && sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "room-leave", roomId: meetingRoomId }));
    }
    for (const id of meetingMembers) { if (id !== myId) dropPeerConn(id); }
    clearMeetingTiles();
    spotlightUid = null; screenSharingMembers = new Set();
    if (meetingPanel) meetingPanel.classList.remove("spotlight");
    if (btnMeetingSpotExit) btnMeetingSpotExit.hidden = true;
    if (meetingFilmstrip) meetingFilmstrip.hidden = true;
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    if (screenStream) { screenStream.getTracks().forEach((t) => t.stop()); screenStream = null; }
    isSharingScreen = false;
    if (btnMeetingShare) btnMeetingShare.classList.remove("active");
    camOffMembers = new Set();
    if (meetingLocalVideo) meetingLocalVideo.srcObject = null;
    meetingActive = false;
    if (soft) {
      meetingLeft = true; showMeetingLeft();
    } else {
      meetingLeft = false; meetingRoomId = null; meetingMembers = new Set();
      meetingJoinPending = false;
      hideMeetingLeft();
      if (meetingPanel) meetingPanel.hidden = true;
      if (btnMeetingCopyLink) btnMeetingCopyLink.hidden = true;
      if (meetingPanel) delete meetingPanel.dataset.room;
      closeMeetingChat();
      if (meetingChatList) meetingChatList.innerHTML = "";
    }
    updateMeetingButtons();
  }

  // 重新加入之前软离开的独立会议
  async function rejoinMeetingRoom() {
    if (meetingActive || meetingRoomId == null) return;
    // 不要提前清 meetingLeft：joinMeeting 成功后自会清；若取媒体失败则保留闸门可重试
    await joinMeeting(meetingRoomId, meetingType || "video");
  }

  // 复制会议邀请链接（带降级方案，兼容非 https / 旧浏览器）
  function copyMeetingLink() {
    if (!meetingRoomId) { toast(t("meeting.alreadyIn")); return; }
    const link = meetingInviteLink(meetingRoomId);
    const done = () => toast(t("meeting.linkCopied"));
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(done, () => fallbackCopy(link, done));
      } else {
        fallbackCopy(link, done);
      }
    } catch (e) { fallbackCopy(link, done); }
  }
  function fallbackCopy(text, cb) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      if (cb) cb();
    } catch (e) { toast(text); }
  }

  // 访客（未登录）提交昵称后入会：建立 room+name 的临时身份连接并直接加入
  async function enterGuestMeeting(name) {
    const rid = pendingMeetingId || meetingRoomId;
    if (!rid) { toast(t("meeting.noSupport")); return; }
    isGuest = true; guestName = name; guestRoomId = rid; meetingRoomId = rid;
    // meetingPanel 位于 appView 内，需显示 appView 才能露出浮层；仪表盘在浮层之下、无登录数据故为空
    if (guestJoinView) guestJoinView.hidden = true;
    if ($("#authView")) $("#authView").hidden = true;
    if ($("#appView")) $("#appView").hidden = false;
    connectSignaling(); // 以 room+name 的临时身份连接（onopen 时冲刷缓存的 room-join）
    try {
      // 在“点击加入”手势内获取媒体并缓存 room-join（信令未连通时由 emitSignal 缓冲）
      await joinMeeting(rid, "video");
    } catch (err) {
      console.error("[GUEST] 入会失败:", err);
    }
  }
  function onGuestJoinSubmit(e) {
    e.preventDefault();
    const name = (guestNameInput && guestNameInput.value || "").trim();
    if (!name) { if (guestNameInput) guestNameInput.focus(); return; }
    enterGuestMeeting(name);
  }

  // 已登录用户通过会议链接进入：先展示“点击加入”闸门（避免无手势时弹摄像头权限被浏览器拦截）
  function joinMeetingFromLink(roomId) {
    roomId = String(roomId);
    if (callState !== "idle") { toast(t("call.endCallFirst")); return; }
    if (meetingActive) {
      if (String(meetingRoomId) === roomId) return;
      toast(t("meeting.inOther")); return;
    }
    meetingMode = "room";
    meetingRoomId = roomId;
    meetingType = meetingType || "video";
    meetingActive = false;
    meetingLeft = true;        // 复用软离开状态条作为“加入会议”闸门
    meetingJoinPending = true;
    roomPeers = new Map();
    showMeetingPanel(null);
    if (meetingGroupName) i18nText(meetingGroupName, "meeting.roomTitle");
    if (btnMeetingCopyLink) btnMeetingCopyLink.hidden = false;
    if (meetingPanel) meetingPanel.dataset.room = roomId;
    showMeetingLeft();
    toast(t("meeting.inviteHint"));
  }

  // 房间模式下：按 id 取昵称/头像（优先 roomPeers，其次回退 id）
  function meetingPeerInfo(id) {
    id = Number(id);
    if (meetingMode === "room") {
      const r = roomPeers.get(id);
      if (r) return { name: r.name || String(id), avatar: r.avatar || "" };
      return { name: String(id), avatar: "" };
    }
    return groupMemberName(meetingGroupId, id);
  }

  // ---- 房间信令处理（与群会议对称，仅 key 为 roomId）----
  function onRoomJoin(from, name) {
    from = Number(from);
    if (!meetingActive || meetingRoomId == null) return;
    // 记录新加入者昵称（服务端 room-join 已携带），供瓦片/聊天显示
    if (name) roomPeers.set(from, { name, avatar: "" });
    teardownPeer(from);
    connectMeetingPeer(from);
    if (isSharingScreen && sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      emitSignal({ type: "room-screen", roomId: meetingRoomId, to: from });
    }
    if (camOff && sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      emitSignal({ type: "room-cam", roomId: meetingRoomId, on: false, to: from });
    }
  }
  function onRoomLeave(from) {
    from = Number(from);
    if (!meetingActive) return;
    meetingMembers.delete(from); roomPeers.delete(from);
    screenSharingMembers.delete(from); camOffMembers.delete(from);
    removeMeetingTile(from); dropPeerConn(from); updateMeetingCount();
  }
  function onRoomRoster(roomId, members) {
    roomId = String(roomId);
    if (!meetingActive || String(meetingRoomId) !== roomId) return;
    roomPeers = new Map();
    meetingMembers = new Set([myId]);
    (members || []).forEach((m) => {
      const id = Number(m.id);
      roomPeers.set(id, { name: m.name || String(id), avatar: m.avatar || "" });
      if (id === myId) return;
      meetingMembers.add(id);
      connectMeetingPeer(id);
    });
    updateMeetingCount();
  }
  function onRoomScreen(from, on) {
    from = Number(from);
    if (!meetingActive) return;
    if (on) { screenSharingMembers.add(from); setTileScreenFlag(from, true); }
    else { screenSharingMembers.delete(from); setTileScreenFlag(from, false); updateTileVideoState(from); }
  }
  function onRoomCam(from, on) {
    from = Number(from);
    if (!meetingActive) return;
    if (on) camOffMembers.delete(from); else camOffMembers.add(from);
    updateTileVideoState(from);
  }
  function onRoomChat(m) {
    if (!meetingActive && !meetingLeft) return;
    if (String(meetingRoomId) !== String(m.roomId)) return;
    appendMeetingMessage(m.from, m.text, m.ts || Date.now(), Number(m.from) === Number(myId));
  }

  // 重新加入之前软离开的会议（复用 group-join 广播，按同一群、同一类型重建全网状连接）
  async function rejoinGroupMeeting() {
    // 独立房间模式：复用 room-* 信令的重入逻辑
    if (meetingMode === "room") { await rejoinMeetingRoom(); return; }
    if (meetingActive) return;
    const gid = meetingGroupId;
    const type = meetingType || "video";
    if (gid == null) return;
    await joinGroupMeeting(gid, type);
  }

  // 群聊头部/详情的会议按钮：若本群有“已离开”的会议则重新加入，否则发起新会议
  function onMeetingHeaderBtn() {
    const g = groups.find((x) => x.id === currentGroup);
    if (!g) return;
    if (meetingLeft && Number(meetingGroupId) === Number(g.id)) rejoinGroupMeeting();
    else startGroupMeeting(g.id, "video");
  }

  // ---- 会议内聊天（文本，仅本会议成员可见，不落 KV） ----
  function toggleMeetingChat() {
    if (!meetingChat) return;
    const open = meetingChat.hidden;
    meetingChat.hidden = !open;
    if (btnMeetingChat) btnMeetingChat.classList.toggle("active", open);
    if (open && meetingChatInput) { meetingChatInput.focus(); }
  }
  function closeMeetingChat() {
    if (meetingChat) meetingChat.hidden = true;
    if (btnMeetingChat) btnMeetingChat.classList.remove("active");
  }
  function appendMeetingMessage(fromId, text, ts, mine) {
    if (!meetingChatList) return;
    const empty = meetingChatList.querySelector(".meeting-chat-empty");
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = "meeting-chat-msg" + (mine ? " me" : "");
    const meta = document.createElement("div");
    meta.className = "meeting-chat-meta";
    const nm = document.createElement("span");
    nm.className = "meeting-chat-name";
    nm.textContent = mine ? t("meeting.me") : (meetingPeerInfo(fromId).name || ("#" + fromId));
    const tm = document.createElement("span");
    tm.className = "meeting-chat-time";
    tm.textContent = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    meta.append(nm, tm);
    const body = document.createElement("div");
    body.className = "meeting-chat-text";
    body.textContent = text;
    row.append(meta, body);
    meetingChatList.appendChild(row);
    meetingChatList.scrollTop = meetingChatList.scrollHeight;
  }
  function sendMeetingChat() {
    if (!meetingChatInput) return;
    const text = meetingChatInput.value.trim();
    if (!text) return;
    if (!meetingActive || (meetingMode === "group" && meetingGroupId == null)) { toast(t("meeting.alreadyIn")); return; }
    const id = crypto.randomUUID();
    const ts = Date.now();
    appendMeetingMessage(myId, text, ts, true);
    if (meetingMode === "room") {
      emitSignal({ type: "room-chat", roomId: meetingRoomId, id, ts, text });
    } else if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "meeting-chat", groupId: meetingGroupId, id, ts, text }));
    }
    meetingChatInput.value = "";
    meetingChatInput.style.height = "auto";
  }
  function onMeetingMessage(m) {
    if (meetingGroupId == null || Number(meetingGroupId) !== Number(m.groupId)) return;
    if (!meetingActive && !meetingLeft) return; // 仅会议进行中或刚软离开时可阅读
    appendMeetingMessage(m.from, m.text, m.ts || Date.now(), Number(m.from) === Number(myId));
  }

  // ---- 一对一通话内聊天 ----
  function toggleCallChat() {
    if (!callChat) return;
    if (callChat.hidden) openCallChat(); else closeCallChat();
  }
  function openCallChat() {
    if (!callChat) return;
    callChat.hidden = false;
    if (callPanel) callPanel.classList.add("chat-open");
    if (btnCallChat) btnCallChat.classList.add("active");
    if (callChatInput) { callChatInput.focus(); }
  }
  function closeCallChat() {
    if (!callChat) return;
    callChat.hidden = true;
    if (callPanel) callPanel.classList.remove("chat-open");
    if (btnCallChat) btnCallChat.classList.remove("active");
    if (callChatInput) callChatInput.style.height = "auto";
  }
  function resetCallChatList() {
    if (!callChatList) return;
    callChatList.innerHTML = '<div class="call-chat-empty">' + t("call.chat.empty") + "</div>";
  }
  function appendCallMessage(fromId, text, ts, mine) {
    if (!callChatList) return;
    const empty = callChatList.querySelector(".call-chat-empty");
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = "call-chat-msg" + (mine ? " me" : "");
    const meta = document.createElement("div");
    meta.className = "call-chat-meta";
    const nm = document.createElement("span");
    nm.className = "call-chat-name";
    nm.textContent = mine ? t("meeting.me") : (friends.find((x) => x.id === Number(fromId))?.username || ("#" + fromId));
    const tm = document.createElement("span");
    tm.className = "call-chat-time";
    tm.textContent = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    meta.append(nm, tm);
    const body = document.createElement("div");
    body.className = "call-chat-text";
    body.textContent = text;
    row.append(meta, body);
    callChatList.appendChild(row);
    callChatList.scrollTop = callChatList.scrollHeight;
  }
  function sendCallChat() {
    if (!callChatInput) return;
    const text = callChatInput.value.trim();
    if (!text) return;
    if (callPeerId == null || callState === "idle") { toast(t("call.busy")); return; }
    const id = crypto.randomUUID();
    const ts = Date.now();
    appendCallMessage(myId, text, ts, true);
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "call-chat", to: callPeerId, id, ts, text }));
    }
    callChatInput.value = "";
    callChatInput.style.height = "auto";
  }
  function onCallChatMessage(m) {
    if (callPeerId == null || callState === "idle") return;
    if (Number(callPeerId) !== Number(m.from)) return; // 仅渲染当前通话对端的消息
    appendCallMessage(m.from, m.text, m.ts || Date.now(), Number(m.from) === Number(myId));
    openCallChat(); // 收到对方消息自动展开抽屉，确保可见
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
    // 重入会时对方上一条连接已被其 group-leave 拆除；此处强制重建一条全新 pc，
    // 避免复用可能存在的旧连接（旧 localStream 已 stop，复用会导致画面卡在失效流）。
    teardownPeer(from);
    connectMeetingPeer(from);
    // 我正在共享屏幕时，晚加入的成员没收到过 group-screen 广播，主动定向补发一次，
    // 让其把本端瓦片标记为 contain、完整显示共享屏幕
    if (isSharingScreen && sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "group-screen", groupId: meetingGroupId, to: from }));
    }
    // 我关闭了摄像头时，晚加入的成员没收到过 group-cam 广播，主动定向补发一次，
    // 让其把本端瓦片显示头像占位
    if (camOff && sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "group-cam", groupId: meetingGroupId, on: false, to: from }));
    }
  }
  function onGroupLeave(groupId, from) {
    from = Number(from);
    if (!meetingActive || meetingGroupId !== Number(groupId)) return;
    meetingMembers.delete(from);
    screenSharingMembers.delete(from); // 离开者若曾共享屏幕，清理标记
    camOffMembers.delete(from);        // 离开者若曾关摄像头，清理标记
    removeMeetingTile(from);
    dropPeerConn(from);
    updateMeetingCount();
  }

  // 服务端回执的权威群成员名单（发起/加入会议时收到）：以它为准重建成员集合并补齐连接。
  // 这是“重入会后其他人窗口少一个人”的根因修复——本地 g.members 只是某次 loadGroups 的快照，
  // 可能与服务端真实成员不一致；若快照漏了某人，本端就不会向其建连，对方也就收不到本端媒体。
  // 用服务端权威名单兜底，保证发起/加入方对外连接始终完整。
  function onGroupRoster(groupId, members) {
    groupId = Number(groupId);
    if (!meetingActive || Number(meetingGroupId) !== groupId) return;
    meetingMembers = new Set([myId]);
    (members || []).forEach((m) => {
      m = Number(m);
      if (m === myId) return;
      meetingMembers.add(m);
      connectMeetingPeer(m); // 幂等：已连接则早返回，仅补建缺失连接
    });
    updateMeetingCount();
  }

  // 标记/取消标记某成员瓦片为“共享屏幕”状态（CSS 用 object-fit: contain 完整显示，避免裁切）
  function setTileScreenFlag(uid, on) {
    uid = String(uid);
    const tile = (meetingGrid && meetingGrid.querySelector('.meeting-tile[data-uid="' + uid + '"]'))
              || (meetingFilmstrip && meetingFilmstrip.querySelector('.meeting-tile[data-uid="' + uid + '"]'));
    if (tile) tile.classList.toggle("screen", !!on);
  }

  // 根据某成员是否"有视频"决定瓦片是否显示头像占位。
  // 语音（audio）会议 / 视频会议中关摄像头且未共享屏幕 → 无视频，居中显示头像。
  function updateTileVideoState(uid) {
    const tile = (meetingGrid && meetingGrid.querySelector('.meeting-tile[data-uid="' + String(uid) + '"]'))
              || (meetingFilmstrip && meetingFilmstrip.querySelector('.meeting-tile[data-uid="' + String(uid) + '"]'));
    if (!tile) return;
    let noVideo;
    if (uid === "self") {
      // 本端：audio / 关摄像头 / 未共享屏幕 / 根本没拿到媒体（无摄像头/insecure context/拒绝授权）→ 无视频
      noVideo = meetingType === "audio" ? true : (camOff && !isSharingScreen);
      if (!localStream) noVideo = true;
    } else {
      const id = Number(uid);
      noVideo = meetingType === "audio" ? true : (camOffMembers.has(id) && !screenSharingMembers.has(id));
    }
    tile.classList.toggle("no-video", !!noVideo);
  }

  // 收到某成员开始/停止共享屏幕的广播：标记其瓦片为 contain 显示
  function onGroupScreen(groupId, from) {
    from = Number(from);
    if (!meetingActive || meetingGroupId !== Number(groupId)) return;
    screenSharingMembers.add(from);
    setTileScreenFlag(from, true);
  }
  function onGroupScreenStop(groupId, from) {
    from = Number(from);
    if (!meetingActive || meetingGroupId !== Number(groupId)) return;
    screenSharingMembers.delete(from);
    setTileScreenFlag(from, false);
    updateTileVideoState(from); // 恢复视频显示后，可能需隐藏头像占位
  }

  // 收到某成员摄像头开关状态：标记其瓦片是否显示头像占位（关摄像头且未共享屏幕时显示）
  function onGroupCam(groupId, from, on) {
    from = Number(from);
    if (!meetingActive || meetingGroupId !== Number(groupId)) return;
    if (on) camOffMembers.delete(from); else camOffMembers.add(from);
    updateTileVideoState(from);
  }

  function showGroupCallInvite(g, from, media, name) {
    if (!groupCallInvite) return;
    pendingGroupCall = { groupId: g ? g.id : null, from, media: media || "video" };
    if (groupCallName) groupCallName.textContent = (name || "群成员") + " 邀请你加入群会议";
    if (groupCallType) i18nText(groupCallType, media === "audio" ? "meeting.invite.voiceMsg" : "meeting.invite.videoMsg", { name: g ? g.name : "群聊" });
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
    // 广播摄像头开关状态：让其他成员把本端瓦片显示/隐藏头像占位
    if (meetingActive && sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "group-cam", groupId: meetingGroupId, on: !camOff }));
    }
    updateTileVideoState("self");
  }

  // 群会议屏幕共享（全网状）：对每一条成员连接的视频发送轨道 replaceTrack 为屏幕轨道。
  // 1:1 共用 screenStream/isSharingScreen 状态（通话与会议互斥，不会同时发生）。
  async function toggleMeetingScreenShare() {
    if (meetingType !== "video" || !meetingActive) { toast(t("meeting.shareVideoOnly")); return; }
    if (isSharingScreen) { await stopMeetingScreenShare(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast(t("call.noShareSupport")); return;
    }
    let screen;
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    } catch (err) {
      toast(t("call.shareFail") + ((err && err.message) || err.name || err));
      return;
    }
    const screenTrack = screen.getVideoTracks()[0];
    screenStream = screen;
    isSharingScreen = true;
    await replaceMeetingVideoTrack(screenTrack);        // 已建立的连接立即换屏
    if (meetingLocalVideo) meetingLocalVideo.srcObject = screenStream;
    if (btnMeetingShare) btnMeetingShare.classList.add("active");
    setTileScreenFlag("self", true);                    // 本端预览也完整显示屏幕（不裁切）
    // 广播：通知其他成员把本端瓦片改为 contain，完整显示共享屏幕
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "group-screen", groupId: meetingGroupId }));
    }
    screenTrack.onended = () => { stopMeetingScreenShare(); }; // 浏览器原生停止共享同步
  }

  async function stopMeetingScreenShare() {
    if (!isSharingScreen || !screenStream) return;
    const camTrack = localStream ? localStream.getVideoTracks()[0] : null;
    await replaceMeetingVideoTrack(camTrack);           // 换回摄像头（camTrack 为 null 时停止发送视频）
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
    isSharingScreen = false;
    if (meetingLocalVideo && localStream) meetingLocalVideo.srcObject = localStream;
    if (btnMeetingShare) btnMeetingShare.classList.remove("active");
    setTileScreenFlag("self", false);                   // 恢复本端摄像头裁切显示
    // 广播：通知其他成员恢复本端瓦片为普通视频裁切显示
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "group-screen-stop", groupId: meetingGroupId }));
    }
  }

  // 将所有会议成员连接的视频发送轨道替换为 targetTrack（屏幕或摄像头）
  async function replaceMeetingVideoTrack(targetTrack) {
    for (const id of meetingMembers) {
      if (id === myId) continue;
      const p = getPeerConn(id);
      if (!p || !p.pc) continue;
      const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (!sender) continue;
      try { await sender.replaceTrack(targetTrack); }
      catch (e) { console.error("[MEETING] replaceTrack 失败", id, e); }
    }
  }

  // connectMeetingPeer 内调用：若该成员连接刚建好媒体，且本端正在共享，则立即把视频轨道换成屏幕
  function maybeApplyScreenShare(p) {
    if (!isSharingScreen || !screenStream || !p || !p.pc) return;
    const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (!sender) return;
    const screenTrack = screenStream.getVideoTracks()[0];
    try { sender.replaceTrack(screenTrack); }
    catch (e) { console.error("[MEETING] applyScreenShare 失败", e); }
  }

  function updateMeetingButtons() {
    // 软离开且停留在同一群：头部按钮变为“重新加入”，点击即重入会
    const rejoinMode = meetingLeft && currentGroup != null && Number(currentGroup) === Number(meetingGroupId) && !meetingActive;
    const inGroupChat = chatMode === "group" && currentGroup != null && chatVisible && !chatView.hidden;
    const inGroupDetail = chatMode === "group" && currentGroup != null && chatVisible && !groupView.hidden;
    if (groupMeetingBtn) {
      groupMeetingBtn.hidden = !(inGroupChat && !meetingActive);
      i18nText(groupMeetingBtn, rejoinMode ? "chat.group.rejoin" : "chat.group.meeting");
    }
    if (groupMeetingBtn2) {
      groupMeetingBtn2.hidden = !(inGroupDetail && !meetingActive);
      i18nText(groupMeetingBtn2, rejoinMode ? "chat.group.rejoin" : "chat.group.startMeeting");
    }
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

  // 判断某 userId 是否属于某群的成员（用于会议中收到流时做兜底登记校验）
  function isGroupMemberId(gid, uid) {
    const g = groups.find((x) => x.id === Number(gid));
    return !!(g && (g.members || []).some((m) => Number(m.id) === Number(uid)));
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
    const myToken = ++activeOpenToken;
    chatMode = "group";
    currentGroup = g.id;
    currentGroupAvatar = g.avatar || "";
    currentPeer = null;
    chatVisible = true;
    chatPanel.hidden = false;
    document.body.classList.add("chat-open");
    maybeMobileConversation();
    // 若离开的是其它群的会议，切换到本群时静默清理软离开状态，避免残留“已离开”面板
    if (meetingLeft && meetingGroupId != null && Number(meetingGroupId) !== Number(g.id)) {
      meetingLeft = false; meetingGroupId = null; meetingType = null;
      hideMeetingLeft();
      if (meetingPanel) meetingPanel.hidden = true;
      closeMeetingChat();
      if (meetingChatList) meetingChatList.innerHTML = "";
    }
    switchChatTab("conversations");
    showChatView();
    chatPeerName.textContent = g.name;
    delete chatPeerName.dataset.i18nKey;
    renderAvatarInto($("#chatPeerAvatar"), g.avatar, (g.name || "?").charAt(0).toUpperCase());
    chatGroupActions.hidden = false;
    setChatStatus("", "", { key: "chat.status.groupMembers", params: { n: (g.members || []).length } });
    enableChatInput();
    renderGroups();
    renderFriendList();
    updateMeetingButtons();
    resetChatMessages(g.name);
    groupRenderedIds = new Set();
    await loadGroupConversation(g.id);
    if (myToken !== activeOpenToken) return;
    await syncGroupConversation(g.id);
    if (myToken !== activeOpenToken) return;
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
      // 点击分发统一由 convListEl 的事件委托处理（见上方 addEventListener），此处不再单独绑定，
      // 避免 renderConversations 全量重建时丢失点击。
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
    maybeMobileConversation();
    renderAvatarInto(friendDetailAvatar, f.avatar, (f.username || "?").charAt(0).toUpperCase());
    friendDetailName.textContent = f.username;
    friendDetailStatus.textContent = f.online ? "在线" : "离线";
    chatView.hidden = true;
    friendView.hidden = false;
    groupView.hidden = true;
    updateCallButtons();
    friendMessageBtn.onclick = () => openConversation(f);
    if (friendVoiceCallBtn) friendVoiceCallBtn.onclick = () => startMediaCall(f.id, "audio");
    if (friendVideoCallBtn) friendVideoCallBtn.onclick = () => startMediaCall(f.id, "video");
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
    maybeMobileConversation();
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
        delete chatPeerName.dataset.i18nKey;
        renderAvatarInto($("#chatPeerAvatar"), gg ? gg.avatar : "", (newName || "?").charAt(0).toUpperCase());
      }
      toast(t("chat.group.nameUpdated"));
    } catch (e) {
      cancelGroupRename();
      toast(t("chat.group.renameFail") + (e?.message || e));
    }
  }

  // ---- 创建群聊 ----
  function openGroupModal() {
    groupNameInput.value = "";
    groupMemberPicker.innerHTML = "";
    if (!friends.length) {
      groupMemberPicker.innerHTML = `<div class="member-pick-empty" data-i18n="chat.group.noFriendToCreate">还没有好友，无法创建群聊</div>`;
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
    if (!name) { toast(t("chat.group.enterName")); return; }
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
      toast(tp("chat.group.created", { name: g.name }));
      openGroupConversation(g);
    } catch (e) {
      toast(e.message || t("chat.group.createFail"));
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
      groupAddPicker.innerHTML = `<div class="member-pick-empty" data-i18n="chat.group.noCandidate">没有可添加的好友</div>`;
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
            toast(tp("chat.group.invited", { name: f.username }));
            await loadGroups();
            const gg = groups.find((x) => x.id === currentGroup);
            if (gg) setChatStatus("", "", { key: "chat.status.groupMembers", params: { n: (gg.members || []).length } });
            const btn = row.querySelector(".mp-add");
            i18nText(btn, "chat.group.added");
            btn.disabled = true;
          } catch (e) {
            toast(e.message || t("chat.add.fail"));
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
    if (!confirm(tp("chat.confirm.leaveGroup", { name: g ? g.name : t("chat.thisGroup") }))) return;
    try {
      await api(`/api/groups/${currentGroup}/leave`, { method: "DELETE" });
      groups = groups.filter((x) => x.id !== currentGroup);
      clearGroupUnread(currentGroup);
      toast(t("chat.group.left"));
    } catch (e) {
      toast(e.message || "退出失败");
      return;
    }
    chatMode = "peer";
    currentGroup = null;
    chatGroupActions.hidden = true;
    currentPeer = null;
    i18nText(chatPeerName, "chat.peer.placeholder");
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
      setChatStatus("", "", { key: "chat.status.groupMembers", params: { n: (groups.find((x) => x.id === gid)?.members || []).length } });
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

  // ---------- Service Worker：对带版本号的 JS/CSS 做本地缓存，离线也可用 ----------
  function registerServiceWorker() {
    // 非安全上下文（如 http 局域网 IP）或旧浏览器没有 navigator.serviceWorker，直接跳过不影响主流程
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((e) => {
        console.warn("[SW] 注册失败（已忽略，不影响主流程）:", (e && e.message) || e);
      });
    });
  }

  // 从当前加载的 app.js 脚本 URL 中提取版本号（?v=），作为本次部署的“版本标识”
  function getAppVersion() {
    const s = document.querySelector('script[src*="app.js"]');
    if (s) {
      const m = /[?&]v=([^&"']+)/.exec(s.getAttribute("src") || s.src || "");
      if (m) return m[1];
    }
    return "unknown";
  }
  // 检测到新版本：展示顶部提示条，并接入“刷新”按钮以应用最新资源
  function showUpdateBanner(cur) {
    const banner = $("#updateBanner");
    const txt = $("#updateText");
    if (txt) txt.textContent = t("update.text") + cur;
    if (banner) banner.hidden = false;
  }
  function setupUpdateBanner() {
    const btn = $("#updateReload");
    if (btn) btn.onclick = () => location.reload();
    // 对比本次运行的版本与上次记录的版本，不一致说明发生了版本更新
    const cur = getAppVersion();
    const last = localStorage.getItem("app-version");
    if (last && last !== cur && cur !== "unknown") showUpdateBanner(cur);
    localStorage.setItem("app-version", cur);
  }
  // 接收 Service Worker 的版本通知，并主动查询，确保本端优先（旧缓存）场景下更新“及时上报”。
  // 两种来源：
  //  ① SW_VERSION_UPDATE —— SW 后台拉到新 HTML 时主动推送（快速路径，可能因竞态早于本监听而丢失）；
  //  ② HTML_VERSION / SW_READY.htmlVersion —— 页面监听就绪后主动查询 SW 缓存元数据得到的最新服务端版本
  //     （竞态安全兜底，保证不漏报）。
  function handleServerVersion(ver) {
    if (!ver) return;
    const cur = getAppVersion(); // 当前页（旧缓存）的版本
    if (ver !== cur) {
      showUpdateBanner(ver);
      localStorage.setItem("app-version", ver);
    }
  }
  function setupSWUpdateListener() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = (event && event.data) || {};
      if (data.type === "SW_VERSION_UPDATE" && data.version) handleServerVersion(data.version);
      else if (data.type === "HTML_VERSION" && data.version) handleServerVersion(data.version);
      else if (data.type === "SW_READY" && data.htmlVersion) handleServerVersion(data.htmlVersion);
    });
    // 监听就绪后主动问一次 SW：当前服务端最新 HTML 版本是多少（避免错过 SW 的主动推送）
    const query = () => {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: "QUERY_HTML_VERSION" });
      }
    };
    if (navigator.serviceWorker.controller) query();
    else navigator.serviceWorker.addEventListener("controllerchange", query);
  }

  // ---------- Init ----------
  function init() {
    applyTheme(
      localStorage.getItem(THEME_KEY) ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    );
    // 解析会议邀请链接 ?meeting=<id>：未登录→访客入会页；已登录→登录后展示加入闸门
    try {
      const params = new URLSearchParams(location.search);
      const m = params.get("meeting");
      if (m) pendingMeetingId = m;
    } catch (e) {}
    registerServiceWorker();
    setupSWUpdateListener();
    setupUpdateBanner();
    checkAuth();
  }
  init();
})();
