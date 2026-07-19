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
    myAvatar = user.avatar || "";
    $("#userName").textContent = user.username;
    renderAvatarInto($("#userAvatar"), myAvatar, (user.username || "?").charAt(0).toUpperCase());
    await loadLinks();
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
  let pc = null;
  let dc = null;
  let myId = null;
  let currentPeer = null;        // 当前对话好友 userId（number）
  let currentPeerName = "";
  let p2pReady = false;
  let relayActive = false;
  let enteringMsg = null;
  let friends = [];              // [{id, username, online}]
  let friendRequests = [];       // [{id, userId, username}]
  let presenceFriends = new Set();

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
    connectSignaling();
    loadFriends();
  }
  function closeChat() { chatPanel.hidden = true; }

  // ---------- 信令连接（带 token 鉴权）----------
  async function connectSignaling() {
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
      ws.onopen = () => { setChatStatus("信令已连接", "ok"); subscribePresence(); resolve(); };
      ws.onclose = () => {
        setChatStatus("信令断开", "warn");
        // 面板仍打开时自动重连，并重发正在进行的呼叫
        if (!chatPanel.hidden) {
          setTimeout(() => {
            if (!chatPanel.hidden) connectSignaling().then(() => { if (currentPeer) reCall(); });
          }, 1500);
        }
      };
      ws.onerror = () => {};
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        onSignalMessage(m);
      };
    });
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
        break;
      case "presence":
        updateFriendOnline(m.userId, m.online);
        break;
      case "incoming-call":
        handleIncomingCall(m.from);
        break;
      case "call-offline":
        if (currentPeer === m.to) {
          setChatStatus("对方不在线", "warn");
          clearEntering();
          disableChatInput();
        }
        break;
      case "signal":
        handleSignal(m.data, m.from);
        break;
      case "chat":
        clearEntering();
        addChatMessage("peer", m.text, m.ts);
        break;
      case "peer-left":
        if (currentPeer === m.from) {
          setChatStatus("对方已结束对话", "warn");
          teardownP2P();
          disableChatInput();
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
    } catch (e) {
      // 鉴权失效等：忽略，面板仍可用（点击好友时会再次尝试）
    }
  }
  function updateFriendOnline(userId, online) {
    const f = friends.find((x) => x.id === userId);
    if (f) { f.online = online; renderFriends(); }
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
        row.innerHTML =
          `<span class="avatar-wrap">` +
          `<span class="avatar sm">${renderAvatar(f.avatar, f.username.charAt(0).toUpperCase())}</span>` +
          `<span class="dot ${f.online ? "on" : "off"}"></span>` +
          `</span>` +
          `<span class="fname">${escapeHtml(f.username)}</span>` +
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
    currentPeer = f.id;
    currentPeerName = f.username;
    chatPeerName.textContent = f.username;
    renderAvatarInto($("#chatPeerAvatar"), f.avatar, f.username.charAt(0).toUpperCase());
    renderFriends();
    resetChatMessages(f.username);
    await connectSignaling();
    if (!sigSocket) return;
    startCall(f.id, f.username);
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
    if (currentPeer !== from) {
      currentPeer = from;
      currentPeerName = f.username;
      chatPeerName.textContent = f.username;
      renderAvatarInto($("#chatPeerAvatar"), f.avatar || "", f.username.charAt(0).toUpperCase());
      renderFriends();
      resetChatMessages(f.username);
    }
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
    ch.onmessage = (e) => addChatMessage("peer", String(e.data));
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
    if (p2pReady && dc && dc.readyState === "open") {
      dc.send(text);
    } else if (sigSocket && sigSocket.readyState === WebSocket.OPEN) {
      sigSocket.send(JSON.stringify({ type: "chat", to: currentPeer, text }));
    } else {
      setChatStatus("未连接，无法发送", "warn");
      return;
    }
    addChatMessage("me", text);
    chatInput.value = "";
    chatInput.style.height = "auto";
  }

  function addChatMessage(role, text, ts) {
    const empty = chatMessages.querySelector(".chat-empty");
    if (empty) empty.remove();
    const div = document.createElement("div");
    if (role === "system") {
      div.className = "chat-msg system";
      div.style.alignSelf = "center";
      div.style.background = "transparent";
      div.style.color = "var(--text-soft)";
      div.style.fontSize = "12px";
      div.textContent = text;
    } else {
      div.className = "chat-msg " + (role === "me" ? "me" : "peer");
      div.textContent = text;
      if (ts) {
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        div.appendChild(meta);
      }
    }
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
  }
  function clearEntering() {
    if (enteringMsg && enteringMsg.parentNode) { enteringMsg.remove(); enteringMsg = null; }
  }

  resetChatMessages();

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
