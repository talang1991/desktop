/* Web 应用导航面板 —— 后端 API 驱动，数据存 PostgreSQL */
(function () {
  "use strict";

  const THEME_KEY = "web-app-launcher:theme";
  const TOKEN_KEY = "web-app-launcher:token";
  const COLORS = [
    "#4f6ef7", "#e5484d", "#12a594", "#f5a623",
    "#9b5de5", "#f15bb5", "#00bbf9", "#8ac926",
  ];

  /** @type {Array<{id:number,name:string,url:string,category?:string,emoji?:string,color:string,openNew:boolean,createdAt:number}>} */
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

  async function loadLinks() {
    const { links } = await api("/api/links");
    apps = links;
    renderAll();
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
    updateUnreadTitle();
    loadFriends();
    // 兜底：登录后稍作延迟再补算一次离线未读，避免信令 welcome 晚到导致红点漏算
    setTimeout(() => trySyncAll(), 1500);
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
      card.target = a.openNew === false ? "_self" : "_blank";
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
        if (e.target.closest(".card-menu")) e.preventDefault();
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
      <button data-act="edit">✏️ 编辑</button>
      <button data-act="copy">📋 复制网址</button>
      <button data-act="delete" class="danger">🗑️ 删除</button>
    `;
    ctxEl.style.left = Math.min(x, window.innerWidth - 160) + "px";
    ctxEl.style.top = Math.min(y, window.innerHeight - 160) + "px";
    document.body.appendChild(ctxEl);

    ctxEl.addEventListener("click", (e) => {
      const act = e.target.getAttribute("data-act");
      if (act === "open") window.open(app.url, app.openNew === false ? "_self" : "_blank");
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
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeContextMenu(); closeModal(); closeProfileModal(); } });

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
    $("#fOpenNew").checked = app ? app.openNew !== false : true;
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
      openNew: $("#fOpenNew").checked,
    };

    try {
      if (editingId) {
        await api("/api/links/" + editingId, { method: "PUT", body: JSON.stringify(payload) });
        toast("已更新");
      } else {
        await api("/api/links", { method: "POST", body: JSON.stringify(payload) });
        toast("已添加");
      }
      closeModal();
      await loadLinks();
    } catch (err) {
      toast(err.message || "保存失败");
    }
  });

  async function deleteApp(id) {
    const app = apps.find((a) => a.id === id);
    if (!app) return;
    if (!confirm(`确定删除「${app.name}」？`)) return;
    try {
      await api("/api/links/" + id, { method: "DELETE" });
      toast("已删除");
      await loadLinks();
    } catch (err) {
      toast(err.message || "删除失败");
    }
  }

  // ---------- Import / Export ----------
  function exportJson() {
    if (apps.length === 0) { toast("暂无数据可导出"); return; }
    const blob = new Blob([JSON.stringify(apps, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `web-apps-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已导出备份");
  }
  async function importJson(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data)) throw new Error("格式错误");
        let n = 0;
        for (const a of data) {
          if (!a.url) continue;
          await api("/api/links", {
            method: "POST",
            body: JSON.stringify({
              name: a.name || "未命名",
              url: a.url,
              category: a.category || "未分类",
              emoji: a.emoji || "",
              color: a.color || COLORS[0],
              openNew: a.openNew !== false,
            }),
          });
          n++;
        }
        await loadLinks();
        toast(`已导入 ${n} 个应用`);
      } catch (e) {
        toast("导入失败：文件格式不正确");
      }
    };
    reader.readAsText(file);
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
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
  const chatStatus = $("#chatStatus");
  const chatMessages = $("#chatMessages");
  const chatInput = $("#chatInput");
  const chatSendBtn = $("#chatSend");
  const chatPeerName = $("#chatPeerName");
  const chatClose = $("#chatClose");
  const friendListEl = $("#friendList");
  const friendRequestsEl = $("#friendRequests");
  const friendEmptyEl = $("#friendEmpty");
  const friendSearch = $("#friendSearch");
  const friendAddBtn = $("#friendAdd");
  const chatUnreadBadge = $("#chatUnreadBadge");

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

  // ---------- 状态 ----------
  let sigSocket = null;
  let sigReconnectTimer = null;
  let sigReconnectDelay = 1000;
  let sigStopReconnect = false;
  let pc = null;
  let dc = null;
  let myId = null;
  let currentPeer = null;        // 当前对话好友 userId（number）
  let chatVisible = false;       // 聊天面板是否真正打开（关闭抽屉后仍算「未在看」）
  let currentPeerName = "";
  let currentPeerAvatar = "";
  let p2pReady = false;
  let relayActive = false;
  let enteringMsg = null;
  let renderedIds = new Set();   // 当前会话已渲染的消息 id，避免同步时重复渲染
  let friends = [];              // [{id, username, online}]
  let friendRequests = [];       // [{id, userId, username}]
  let presenceFriends = new Set();
  let unread = {};               // { [peerId]: 未读消息数 }，按当前用户隔离后持久化在 IndexedDB
  let currentUserId = null;      // 当前登录用户 id，用于把 unread 按账号隔离（IndexedDB 按 origin 共享，避免双账号串台）
  let syncingAll = false;        // 防止离线/重连的未读补算并发重入

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
  function resetChatMessages(peerName) {
    chatMessages.innerHTML =
      `<div class="chat-empty">${peerName ? "与 " + escapeHtml(peerName) + " 聊天" : "选择一个好友开始聊天"}</div>`;
  }
  function openChat() {
    chatPanel.hidden = false;
    chatVisible = true;
    // 注意：打开整个聊天面板不应自动清除未读——只有点开“具体某个好友”会话（openConversation）才视为已读。
    // 之前这里会在打开面板时 clearUnread(currentPeer)，而 currentPeer 关抽屉后并不会清空，
    // 导致刚给你发消息的好友红点一打开面板就被抹掉（顶栏若还有其他好友未读则仍显示，造成“顶栏有、列表没有”）。
    console.log("[UNREAD-DEBUG] openChat currentPeer=", currentPeer);
    connectSignaling();
    loadFriends();
  }
  function closeChat() { chatPanel.hidden = true; chatVisible = false; }

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
        onSignalMessage(m);
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

  function onSignalMessage(m) {
    switch (m.type) {
      case "welcome":
        myId = m.userId;
        trySyncAll(); // 拿到 myId 后补算离线未读（好友列表可能尚未就绪，trySyncAll 内部会再判）
        break;
      case "presence":
        updateFriendOnline(m.userId, m.online);
        break;
      case "incoming-call":
        handleIncomingCall(m.from);
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
      case "peer-left":
        if (currentPeer === m.from) {
          setChatStatus("对方已结束对话（仍可发送离线消息）", "warn");
          teardownP2P();
          // 保持输入框可用：后续走服务端 KV 离线消息
        }
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
    if (f) { f.online = online; renderFriends(); }
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
    renderFriends();
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
    document.title = total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
    if (chatUnreadBadge) {
      if (total > 0) {
        chatUnreadBadge.textContent = total > 99 ? "99+" : String(total);
        chatUnreadBadge.hidden = false;
      } else {
        chatUnreadBadge.hidden = true;
      }
    }
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
    console.log("[UNREAD-DEBUG] renderFriends friends=", friends.map((f) => ({ id: f.id, t: typeof f.id, name: f.username })), "unread=", JSON.parse(JSON.stringify(unread)));
    if (friends.length === 0) {
      friendEmptyEl.hidden = false;
    } else {
      friendEmptyEl.hidden = true;
        friends.forEach((f) => {
          const row = document.createElement("div");
          row.className = "friend-row" + (f.id === currentPeer ? " active" : "");
          const u = unread[f.id] || 0;
          console.log("[UNREAD-DEBUG] renderFriends row", { friendId: f.id, friendIdType: typeof f.id, unreadVal: u });
          const badge = u > 0
            ? `<span class="unread-badge" title="${u} 条未读">${u > 99 ? "99+" : u}</span>`
            : "";
          row.innerHTML =
            `<span class="avatar-wrap">` +
            `<span class="avatar sm">${renderAvatar(f.avatar, f.username.charAt(0).toUpperCase())}</span>` +
            `<span class="dot ${f.online ? "on" : "off"}"></span>` +
            `</span>` +
            `<span class="fname">${escapeHtml(f.username)}</span>${badge}` +
            `<button class="friend-remove" title="移除好友">✕</button>`;
        const open = () => openConversation(f);
        row.querySelector(".fname").onclick = open;
        row.querySelector(".avatar-wrap").onclick = open;
        row.querySelector(".friend-remove").onclick = (e) => {
          e.stopPropagation();
          removeFriend(f);
        };
        friendListEl.appendChild(row);
      });
    }
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
    } catch (e) {
      toast(e.message || "添加失败");
    }
  }
  async function acceptRequest(id) {
    try {
      await api("/api/friends/accept", { method: "POST", body: JSON.stringify({ requestId: id }) });
      toast("已添加为好友");
      await loadFriends();
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
    if (currentPeer && currentPeer !== f.id) endCurrent();
    clearUnread(f.id);
    currentPeer = f.id;
    chatVisible = true;
    chatPanel.hidden = false;
    currentPeerName = f.username;
    currentPeerAvatar = f.avatar || "";
    chatPeerName.textContent = f.username;
    renderAvatarInto($("#chatPeerAvatar"), f.avatar, f.username.charAt(0).toUpperCase());
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
  }
  function reCall() {
    const f = friends.find((x) => x.id === currentPeer);
    if (f) startCall(f.id, f.username);
  }
  function startCall(to, name) {
    setChatStatus(`正在连接 ${name} …`, "warn");
    enteringMsg = addChatMessage("system", `正在连接 ${name} …`);
    // 立即启用中继兜底，后台尝试 P2P 直连
    enableRelay();
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "call", to }));
    }
    startOffer();
  }
  function handleIncomingCall(from) {
    const f = friends.find((x) => x.id === from) || { id: from, username: String(from), online: true, avatar: "" };
    clearUnread(from);
    if (currentPeer !== from) {
      currentPeer = from;
      currentPeerName = f.username;
      currentPeerAvatar = f.avatar || "";
      chatPeerName.textContent = f.username;
      renderAvatarInto($("#chatPeerAvatar"), f.avatar || "", f.username.charAt(0).toUpperCase());
      renderFriends();
      resetChatMessages(f.username);
    }
    enableChatInput();
    setChatStatus(`收到 ${f.username} 的聊天请求，连接中…`, "warn");
    clearEntering();
    enableRelay();
    // 接收方准备 pc（等待对方 offer）
    if (!pc) { pc = new RTCPeerConnection(rtcConfig()); setupPc(); }
  }
  function endCurrent() {
    if (sigSocket && currentPeer) {
      try { sigSocket.send(JSON.stringify({ type: "bye", to: currentPeer })); } catch {}
    }
    teardownP2P();
    currentPeer = null;
    currentPeerName = "";
    currentPeerAvatar = "";
    chatPeerName.textContent = "选择一个好友开始聊天";
    renderAvatarInto($("#chatPeerAvatar"), "", "?");
    setChatStatus("未连接");
    disableChatInput();
    renderFriends();
  }

  // ---------- WebRTC ----------
  function teardownP2P() {
    p2pReady = false;
    if (dc) { try { dc.close(); } catch {} dc = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
  }

  function startOffer() {
    try {
      pc = new RTCPeerConnection(rtcConfig());
      setupPc();
      dc = pc.createDataChannel("chat");
      setupDataChannel(dc);
      pc.createOffer().then((offer) => pc.setLocalDescription(offer))
        .then(() => sendSignal({ sdp: pc.localDescription }))
        .catch(() => enableRelay());
    } catch { enableRelay(); }
  }

  function setupPc() {
    pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ candidate: e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") { setChatStatus("直连失败，改用中继", "warn"); enableRelay(); }
    };
    pc.ondatachannel = (e) => { dc = e.channel; setupDataChannel(dc); };
  }

  function handleSignal(data, from) {
    if (!data) return;
    if (data.sdp) {
      const desc = new RTCSessionDescription(data.sdp);
      if (desc.type === "offer") {
        if (currentPeer == null && from != null) currentPeer = from;
        if (!pc) { pc = new RTCPeerConnection(rtcConfig()); setupPc(); }
        pc.setRemoteDescription(desc).then(() => pc.createAnswer())
          .then((answer) => pc.setLocalDescription(answer))
          .then(() => sendSignal({ sdp: pc.localDescription }))
          .catch(() => enableRelay());
      } else if (desc.type === "answer") {
        if (pc) pc.setRemoteDescription(desc).catch(() => enableRelay());
      }
    } else if (data.candidate) {
      if (pc) pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }
  }

  function setupDataChannel(ch) {
    ch.onopen = () => { p2pReady = true; clearEntering(); setChatStatus("P2P 已直连 🔗", "ok"); enableChatInput(); };
    ch.onmessage = (e) => {
      const data = e.data;
      let m = null;
      try { const p = JSON.parse(data); if (p && p.type === "chat") m = p; } catch {}
      if (m) {
        onChatReceived({
          id: m.id || crypto.randomUUID(),
          from: currentPeer,
          to: myId,
          text: m.text,
          ts: m.ts || Date.now(),
        });
      } else {
        // 兼容旧版（纯文本）数据通道消息
        onChatReceived({
          id: crypto.randomUUID(),
          from: currentPeer,
          to: myId,
          text: String(data),
          ts: Date.now(),
        });
      }
    };
    ch.onclose = () => { p2pReady = false; setChatStatus("直连关闭，改用中继", "warn"); enableRelay(); };
    ch.onerror = () => {};
  }

  function sendSignal(data) {
    if (sigSocket && sigSocket.readyState === WebSocket.OPEN && currentPeer != null) {
      sigSocket.send(JSON.stringify({ type: "signal", to: currentPeer, data }));
    }
  }

  function enableRelay() {
    if (relayActive) return;
    relayActive = true;
    p2pReady = false;
    setChatStatus("中继模式（服务器转发）", "warn");
    enableChatInput();
  }
  function enableChatInput() {
    chatInput.disabled = false; chatSendBtn.disabled = false; chatInput.focus();
  }
  function disableChatInput() {
    chatInput.disabled = true; chatSendBtn.disabled = true; relayActive = false;
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
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
    if (p2pReady && dc && dc.readyState === "open") {
      dc.send(JSON.stringify({ type: "chat", id, ts, text }));
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
  function renderMessageRow(role, text, ts) {
    const empty = chatMessages.querySelector(".chat-empty");
    if (empty) empty.remove();
    const isMe = role === "me";
    const row = document.createElement("div");
    row.className = "chat-msg-row " + (isMe ? "me" : "peer");

    const avatar = document.createElement("div");
    avatar.className = "chat-msg-avatar sm";
    avatar.innerHTML = isMe
      ? renderAvatar(myAvatar, (currentUsername || "?").charAt(0).toUpperCase())
      : renderAvatar(currentPeerAvatar, (currentPeerName || "?").charAt(0).toUpperCase());

    const bubble = document.createElement("div");
    bubble.className = "chat-msg " + (isMe ? "me" : "peer");
    bubble.textContent = text;
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
    } else if (m.from !== myId) {
      // 未选中该好友：累加未读红点提醒（持久化）
      addUnread(m.from);
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
  // 把本地未同步的消息批量补推到服务端（按接收方分组）
  async function flushPending() {
    let unsynced;
    try { unsynced = await ChatDB.pending(); } catch { return; }
    if (!unsynced.length) return;
    const byTo = new Map();
    for (const m of unsynced) {
      const arr = byTo.get(m.to) || [];
      arr.push(m);
      byTo.set(m.to, arr);
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
  }

  function clearEntering() {
    if (enteringMsg && enteringMsg.parentNode) { enteringMsg.remove(); enteringMsg = null; }
  }

  resetChatMessages();

  // 网络恢复时：把本地未同步的消息补推到服务端，并补算离线期间漏掉的未读红点
  window.addEventListener("online", () => { flushPending(); trySyncAll(); });

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
