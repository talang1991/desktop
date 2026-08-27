// marketplace.js —— 应用广场独立页面（marketplace.html）逻辑，独立于 app.js
// 复用与主应用相同的 token 存储：
//   - token: localStorage["web-app-launcher:token"]
//   - GET  /api/apps            -> { apps: [...] }（公开，已上架；支持 ?pc=1&mobile=1&pwa=1 过滤）
//   - POST /api/apps            -> { id, status:"pending" }（需登录，发布）
//   - GET  /api/apps/mine       -> { apps: [...] }（需登录；含状态）
//   - DELETE /api/apps/:id      -> { ok:true }（需登录；删除自己的）
(function () {
  "use strict";

  const TOKEN_KEY = "web-app-launcher:token";

  // ---------- 工具 ----------
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function isIconUrl(s) {
    return !!s && /^(https?:\/\/|\/|data:image\/)/i.test(String(s).trim());
  }
  function faviconFor(url) {
    return "/favicon-proxy?url=" + encodeURIComponent(String(url || ""));
  }
  function appIconHtml(app) {
    const src = (app.icon && isIconUrl(app.icon)) ? app.icon : faviconFor(app.url);
    const letter = escapeHtml((app.name || "?").charAt(0).toUpperCase());
    return '<img src="' + escapeHtml(src) + '" alt="" draggable="false" ' +
      "onerror=\"this.style.display='none';this.parentNode.textContent='" + letter + "'\"/>";
  }
  function fmtDate(s) {
    try {
      return new Date(s).toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return String(s == null ? "" : s); }
  }
  // 归一化 URL 用于「是否已保存」匹配：去首尾空白、去掉末尾斜杠、小写
  function normUrl(u) {
    return String(u == null ? "" : u).trim().replace(/\/+$/, "").toLowerCase();
  }

  // ---------- 跨标签页消息总线（与 app.js 同源实现）----------
  // 用途：保存到「我的应用」后，通知其它首页标签（及广场自身）同步列表/已保存徽标。
  // 优先 BroadcastChannel；旧浏览器回退 localStorage 事件（只在其它标签触发，不会自环）。
  const CrossTab = (function () {
    const NAME = "wal-cross-tab";
    const LS_KEY = "wal-crosstab-bus";
    const handlers = new Set();
    let bc = null;
    try { bc = ("BroadcastChannel" in window) ? new BroadcastChannel(NAME) : null; } catch (_) { bc = null; }
    if (bc) {
      bc.onmessage = (e) => emit(e.data);
    } else {
      window.addEventListener("storage", (e) => {
        if (e.key === LS_KEY && e.newValue) {
          try { emit(JSON.parse(e.newValue)); } catch (_) {}
        }
      });
    }
    function emit(msg) { handlers.forEach((h) => { try { h(msg); } catch (_) {} }); }
    return {
      post(msg) {
        if (bc) { try { bc.postMessage(msg); } catch (_) {} }
        else { try { localStorage.setItem(LS_KEY, JSON.stringify(Object.assign({ _t: Date.now() }, msg))); } catch (_) {} }
      },
      on(h) { handlers.add(h); return () => handlers.delete(h); },
    };
  })();

  // 跨标签页：其它首页标签（或本广场在其它标签的实例）改动「我的应用」后，刷新已保存徽标
  CrossTab.on((msg) => {
    if (msg && msg.type === "links-changed") refreshSavedState();
  });

  // ---------- API（带轻量重试；401/403 直接抛出并标记 status）----------
  async function api(path, opts = {}) {
    const headers = { "content-type": "application/json" };
    const tk = localStorage.getItem(TOKEN_KEY);
    if (tk) headers["authorization"] = "Bearer " + tk;
    let lastErr = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const res = await fetch(path, { headers, ...opts });
        if (res.status === 401 || res.status === 403) {
          const body = await res.json().catch(() => ({}));
          const e = new Error(body.error || (res.status === 401 ? "请先登录" : "无权访问"));
          e.status = res.status;
          throw e;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || ("请求失败 (" + res.status + ")"));
        }
        return await res.json();
      } catch (err) {
        if (err.status === 401 || err.status === 403) throw err;
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt)));
        else throw err;
      }
    }
    throw lastErr || new Error("请求失败");
  }

  // ---------- Toast ----------
  function toast(msg, kind) {
    let layer = document.getElementById("toast-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "toast-layer";
      layer.style.cssText =
        "position:fixed;left:0;right:0;bottom:24px;display:flex;flex-direction:column;" +
        "align-items:center;gap:8px;z-index:300;pointer-events:none;";
      document.body.appendChild(layer);
    }
    const el = document.createElement("div");
    el.className = "toast " + (kind === "err" ? "toast-err" : "toast-ok");
    el.textContent = msg;
    el.style.cssText =
      "background:" + (kind === "err" ? "#d23" : "#1a7f37") + ";color:#fff;padding:9px 16px;" +
      "border-radius:10px;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.18);" +
      "opacity:1;transition:opacity .4s;max-width:90vw;";
    layer.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; }, 2200);
    setTimeout(() => { el.remove(); }, 2700);
  }

  function notice(html) {
    const box = document.getElementById("notice");
    if (box) { box.innerHTML = html; box.hidden = false; }
  }
  function clearNotice() {
    const box = document.getElementById("notice");
    if (box) { box.hidden = true; box.innerHTML = ""; }
  }

  function badgeHtml(app) {
    let b = "";
    if (app.category && app.category !== "其它") {
      b += '<span class="mk-badge">' + escapeHtml(app.category) + "</span>";
    }
    if (app.supports_pc) b += '<span class="mk-badge on-pc">PC</span>';
    if (app.supports_mobile) b += '<span class="mk-badge on-mobile">📱手机</span>';
    if (app.supports_pwa) b += '<span class="mk-badge on-pwa">支持 PWA</span>';
    return b;
  }

  // 点赞按钮：已赞态用实心心形 + 主题色高亮；计数实时反映
  function likeHtml(app) {
    const liked = app.liked ? " liked" : "";
    const count = (app.like_count || 0);
    return (
      '<button class="mk-like' + liked + '" data-like="' + app.id + '" ' +
      'type="button" aria-pressed="' + (app.liked ? "true" : "false") + '" ' +
      'title="点赞">' +
        '<span class="mk-like-heart">' + (app.liked ? "♥" : "♡") + "</span>" +
        '<span class="mk-like-count">' + count + "</span>" +
      "</button>"
    );
  }
  // 同步一个点赞按钮的视觉状态（乐观更新 / 服务端回写都用它）
  function renderLikeBtn(btn, app) {
    const liked = !!(app && app.liked);
    const count = app ? (app.like_count || 0) : 0;
    btn.classList.toggle("liked", liked);
    btn.setAttribute("aria-pressed", liked ? "true" : "false");
    btn.innerHTML =
      '<span class="mk-like-heart">' + (liked ? "♥" : "♡") + "</span>" +
      '<span class="mk-like-count">' + count + "</span>";
  }

  function cardHtml(app, mine) {
    const statusMap = { pending: "待审核", approved: "已上架", rejected: "已拒绝" };
    const status = mine
      ? '<span class="mk-status ' + app.status + '">' + (statusMap[app.status] || app.status) + "</span>"
      : "";
    const del = mine
      ? '<button class="mk-del" data-del="' + app.id + '">删除</button>'
      : "";
    // 被拒绝的应用支持「修改并重新提交审核」
    const edit = (mine && app.status === "rejected")
      ? '<button class="mk-edit" data-edit="' + app.id + '">修改并重新提交</button>'
      : "";
    // 被拒绝的应用不展示「打开」和「保存」（避免按钮过载；保存与否对被拒卡无意义）
    const hideOpenAndSave = !!(mine && app.status === "rejected");
    const open = hideOpenAndSave
      ? ""
      : '<a class="mk-open" href="' + escapeHtml(app.url) + '" target="_blank" rel="noopener">打开</a>';
    const alreadySaved = !hideOpenAndSave && myLinkUrls.has(normUrl(app.url));
    const save = hideOpenAndSave
      ? ""
      : (alreadySaved
          ? '<button class="mk-save" data-save="' + app.id + '" disabled>✓ 已保存</button>'
          : '<button class="mk-save" data-save="' + app.id + '">＋ 保存</button>');
    const reason = (mine && app.status === "rejected" && app.reject_reason)
      ? '<div class="mk-sub" style="color:#d23">拒绝原因：' + escapeHtml(app.reject_reason) + "</div>"
      : "";
    // 被拒绝的应用不展示点赞（该卡已无公开意义，避免按钮过载）
    const like = hideOpenAndSave ? "" : likeHtml(app);
    return (
      '<div class="mk-card">' +
        '<div class="mk-card-head">' +
          '<div class="mk-icon">' + appIconHtml(app) + "</div>" +
          "<div>" +
            '<div class="mk-title">' + escapeHtml(app.name) + "</div>" +
            '<div class="mk-sub">by ' + escapeHtml(app.username || "未知") + "</div>" +
          "</div>" +
          (status ? '<div style="margin-left:auto">' + status + "</div>" : "") +
        "</div>" +
        (app.banner ? '<div class="mk-banner"><img src="' + escapeHtml(app.banner) + '" alt="banner" loading="lazy" /></div>' : "") +
        '<div class="mk-desc">' + escapeHtml(app.description || "") + "</div>" +
        '<div class="mk-badges">' + badgeHtml(app) + "</div>" +
        reason +
        '<div class="mk-card-foot">' +
          open +
          save +
          like +
          edit +
          del +
        "</div>" +
      "</div>"
    );
  }

  // 骨架屏：渲染若干张与真实卡片结构一致的占位卡（带 shimmer 动画）
  function skeletonCardHtml() {
    return (
      '<div class="mk-card mk-card--skel">' +
        '<div class="mk-card-head">' +
          '<div class="mk-skel mk-skel-icon"></div>' +
          '<div class="mk-skel-text">' +
            '<div class="mk-skel mk-skel-line" style="width:62%"></div>' +
            '<div class="mk-skel mk-skel-line mk-skel-line-sm" style="width:38%"></div>' +
          '</div>' +
        '</div>' +
        '<div class="mk-skel mk-skel-line" style="width:100%"></div>' +
        '<div class="mk-skel mk-skel-line" style="width:84%"></div>' +
        '<div class="mk-skel-badges">' +
          '<div class="mk-skel mk-skel-pill"></div>' +
          '<div class="mk-skel mk-skel-pill"></div>' +
        '</div>' +
        '<div class="mk-card-foot">' +
          '<div class="mk-skel mk-skel-btn"></div>' +
          '<div class="mk-skel mk-skel-btn"></div>' +
        '</div>' +
      '</div>'
    );
  }
  function showSkeleton(grid, count) {
    const n = count || 6;
    grid.innerHTML = Array.from({ length: n }, skeletonCardHtml).join("");
  }

  // ---------- 状态 ----------
  let currentUser = null;
  let view = "plaza";
  let appIndex = {}; // id -> app 元数据，供「保存到我的应用」读取 name/url/category
  let myLinkUrls = new Set(); // 已保存到「我的应用」的归一化 URL 集合，用于卡片去重标记
  let editingId = null; // 正在修改的应用 id（null = 新建模式）

  // 给当前渲染出的卡片绑定「保存到我的应用」按钮
  function bindSaveButtons(grid) {
    grid.querySelectorAll("[data-save]").forEach((btn) => {
      btn.addEventListener("click", () => saveToMyApps(Number(btn.getAttribute("data-save"))));
    });
  }
  // 给当前渲染出的卡片绑定「点赞」按钮
  function bindLikeButtons(grid) {
    grid.querySelectorAll("[data-like]").forEach((btn) => {
      btn.addEventListener("click", () => toggleLike(Number(btn.getAttribute("data-like"))));
    });
  }

  // 把广场应用保存到用户自己的应用列表（POST /api/links）
  async function saveToMyApps(id) {
    const tk = localStorage.getItem(TOKEN_KEY);
    if (!tk) {
      toast("请先在应用中登录后再保存", "err");
      return;
    }
    const app = appIndex[id];
    if (!app) return;
    const btn = document.querySelector('[data-save="' + id + '"]');
    if (btn) btn.disabled = true;
    // 带上图标：与广场展示一致（自定义图标 URL，否则回退完整 URL 的 favicon 代理）。
    // 否则保存后链接 icon 为空，首页会退化为 origin/favicon.ico，往往抓不到图标。
    const icon = (app.icon && isIconUrl(app.icon)) ? app.icon : faviconFor(app.url);
    try {
      await api("/api/links", {
        method: "POST",
        body: JSON.stringify({
          name: app.name,
          url: app.url,
          category: (app.category && app.category !== "其它") ? app.category : "应用广场",
          emoji: icon,
        }),
      });
      toast("已保存到「我的应用」");
      myLinkUrls.add(normUrl(app.url));
      if (btn) { btn.textContent = "✓ 已保存"; }
      // 跨标签页：通知其它首页标签（及本广场在其它标签的实例）同步「我的应用」列表
      CrossTab.post({ type: "links-changed" });
    } catch (e) {
      if (btn) btn.disabled = false;
      toast((e && e.message) || "保存失败", "err");
    }
  }
  // 跨标签页：其它标签改动「我的应用」后，重新拉取已保存集合并刷新卡片上的「已保存」徽标
  async function refreshSavedState() {
    try {
      const linksRes = await api("/api/links");
      myLinkUrls = new Set((linksRes.links || []).map((l) => normUrl(l.url)));
      syncSavedBadges();
    } catch (_) { /* 取不到则保持现状 */ }
  }
  function syncSavedBadges() {
    document.querySelectorAll("[data-save]").forEach((btn) => {
      const id = Number(btn.getAttribute("data-save"));
      const app = appIndex[id];
      if (!app) return;
      const saved = myLinkUrls.has(normUrl(app.url));
      btn.textContent = saved ? "✓ 已保存" : "＋ 保存";
      btn.disabled = saved;
    });
  }

  // 点赞 / 取消点赞：先乐观更新 UI，再请求服务端；失败回滚并提示
  async function toggleLike(id) {
    const tk = localStorage.getItem(TOKEN_KEY);
    if (!tk) {
      toast("请先在应用中登录后再点赞", "err");
      return;
    }
    const app = appIndex[id];
    const btn = document.querySelector('[data-like="' + id + '"]');
    if (!app) return;
    const prevLiked = !!app.liked;
    const prevCount = app.like_count || 0;
    // 乐观更新
    app.liked = !prevLiked;
    app.like_count = prevCount + (app.liked ? 1 : -1);
    if (btn) renderLikeBtn(btn, app);
    try {
      const r = await api("/api/apps/" + id + "/like", { method: "POST" });
      app.liked = r.liked;
      app.like_count = r.like_count;
      if (btn) renderLikeBtn(btn, app);
    } catch (e) {
      // 回滚到操作前状态
      app.liked = prevLiked;
      app.like_count = prevCount;
      if (btn) renderLikeBtn(btn, app);
      toast((e && e.message) || "点赞失败", "err");
    }
  }

  // ---------- 渲染 ----------
  async function loadPlaza() {
    const grid = document.getElementById("mkGrid");
    const pc = document.getElementById("fPc").checked ? 1 : 0;
    const mobile = document.getElementById("fMobile").checked ? 1 : 0;
    const pwa = document.getElementById("fPwa").checked ? 1 : 0;
    showSkeleton(grid);
    try {
      const { apps } = await api("/api/apps?pc=" + pc + "&mobile=" + mobile + "&pwa=" + pwa);
      appIndex = {};
      apps.forEach((a) => { appIndex[a.id] = a; });
      if (!apps.length) {
        grid.innerHTML = '<div class="mk-empty">暂无已上架的应用。成为第一个发布者吧！</div>';
        return;
      }
      grid.innerHTML = apps.map((a) => cardHtml(a, false)).join("");
      bindSaveButtons(grid);
      bindLikeButtons(grid);
    } catch (e) {
      grid.innerHTML = '<div class="mk-msg">加载失败：' + escapeHtml((e && e.message) || "未知错误") + "</div>";
    }
  }

  async function loadMine() {
    const grid = document.getElementById("mkMine");
    const tk = localStorage.getItem(TOKEN_KEY);
    if (!tk) {
      grid.innerHTML = '<div class="mk-msg">请先在 <a href="index.html" style="color:var(--primary)">应用</a> 中登录后查看你的发布。</div>';
      return;
    }
    showSkeleton(grid);
    try {
      const { apps } = await api("/api/apps/mine");
      appIndex = {};
      apps.forEach((a) => { appIndex[a.id] = a; });
      if (!apps.length) {
        grid.innerHTML = '<div class="mk-empty">你还没有发布过应用。点击右上角「发布应用」试试。</div>';
        return;
      }
      grid.innerHTML = apps.map((a) => cardHtml(a, true)).join("");
      bindSaveButtons(grid);
      bindLikeButtons(grid);
      grid.querySelectorAll("[data-del]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = Number(btn.getAttribute("data-del"));
          if (!confirm("确定删除这个应用？")) return;
          btn.disabled = true;
          try {
            await api("/api/apps/" + id, { method: "DELETE" });
            toast("已删除");
            await loadMine();
          } catch (e) {
            btn.disabled = false;
            toast((e && e.message) || "删除失败", "err");
          }
        });
      });
      grid.querySelectorAll("[data-edit]").forEach((btn) => {
        btn.addEventListener("click", () => openEdit(Number(btn.getAttribute("data-edit"))));
      });
    } catch (e) {
      grid.innerHTML = '<div class="mk-msg">加载失败：' + escapeHtml((e && e.message) || "未知错误") + "</div>";
    }
  }

  function switchTab(tab) {
    view = tab;
    document.querySelectorAll(".mk-tab").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-tab") === tab);
    });
    document.getElementById("plazaView").hidden = tab !== "plaza";
    document.getElementById("mineView").hidden = tab !== "mine";
    if (tab === "plaza") loadPlaza();
    else loadMine();
  }

  // ---------- 发布 / 修改表单 ----------
  function setPublishMode() {
    // 根据 editingId 切换弹窗标题与提交按钮文案
    const isEdit = editingId != null;
    const titleEl = document.getElementById("publishTitle");
    const submitEl = document.getElementById("publishSubmit");
    if (titleEl) titleEl.textContent = isEdit ? "修改应用" : "发布应用";
    if (submitEl) submitEl.textContent = isEdit ? "保存并重新提交审核" : "提交审核";
  }
  function openPublish() {
    const tk = localStorage.getItem(TOKEN_KEY);
    if (!tk) {
      toast("请先在应用中登录后再发布", "err");
      return;
    }
    editingId = null;
    document.getElementById("publishForm").reset();
    setPublishMode();
    document.getElementById("publishModal").hidden = false;
    document.getElementById("fName").focus();
  }
  function openEdit(id) {
    const app = appIndex[id];
    if (!app) return;
    editingId = id;
    document.getElementById("fName").value = app.name || "";
    document.getElementById("fUrl").value = app.url || "";
    document.getElementById("fCategory").value = app.category || "";
    document.getElementById("fIcon").value = app.icon || "";
    document.getElementById("fDesc").value = app.description || "";
    document.getElementById("fPc2").checked = !!app.supports_pc;
    document.getElementById("fMobile2").checked = !!app.supports_mobile;
    document.getElementById("fPwa2").checked = !!app.supports_pwa;
    setPublishMode();
    document.getElementById("publishModal").hidden = false;
    document.getElementById("fName").focus();
  }
  function closePublish() {
    document.getElementById("publishModal").hidden = true;
    editingId = null;
  }
  async function submitPublish(e) {
    e.preventDefault();
    const name = document.getElementById("fName").value.trim();
    const url = document.getElementById("fUrl").value.trim();
    const category = document.getElementById("fCategory").value.trim();
    const icon = document.getElementById("fIcon").value.trim();
    const description = document.getElementById("fDesc").value.trim();
    const supports_pc = document.getElementById("fPc2").checked;
    const supports_mobile = document.getElementById("fMobile2").checked;
    const supports_pwa = document.getElementById("fPwa2").checked;
    if (!name) { toast("请填写应用名称", "err"); return; }
    if (!/^https?:\/\//i.test(url)) { toast("请填写合法的 http(s) 链接", "err"); return; }
    const btn = document.getElementById("publishSubmit");
    btn.disabled = true;
    try {
      if (editingId != null) {
        // 修改模式：PUT 更新字段，后端重置状态为 pending
        await api("/api/apps/" + editingId, {
          method: "PUT",
          body: JSON.stringify({ name, url, category, icon, description, supports_pc, supports_mobile, supports_pwa }),
        });
        toast("已保存并重新提交，等待管理员审核");
      } else {
        await api("/api/apps", {
          method: "POST",
          body: JSON.stringify({ name, url, category, icon, description, supports_pc, supports_mobile, supports_pwa }),
        });
        toast("已提交，等待管理员审核");
      }
      closePublish();
      switchTab("mine");
      await loadMine();
    } catch (err) {
      toast((err && err.message) || "提交失败", "err");
    } finally {
      btn.disabled = false;
    }
  }

  // 首屏水合（hydration）：若服务端已渲染了广场卡片（携带 #ssrPlazaData 数据），
  // 直接用该数据渲染卡片并绑定「保存」按钮，跳过首屏 fetch，避免回退到「加载中」闪烁。
  // 返回 true 表示已水合（无需再 loadPlaza），false 表示需客户端自行加载。
  function hydrateFromSSR() {
    const script = document.getElementById("ssrPlazaData");
    if (!script) return false;
    let data;
    try { data = JSON.parse(script.textContent || "{}"); } catch { return false; }
    // 兼容旧结构：部分缓存可能仍是裸数组；新结构为 { apps, savedUrls }
    const apps = Array.isArray(data) ? data : (data.apps || []);
    // 优先使用 SSR 注入的 savedUrls 填充「已保存」集合（首屏无需再请求 /api/links）
    if (data && Array.isArray(data.savedUrls)) {
      data.savedUrls.forEach((u) => myLinkUrls.add(normUrl(u)));
    }
    script.remove();
    appIndex = {};
    const grid = document.getElementById("mkGrid");
    if (!grid) return false;
    if (!apps.length) {
      grid.innerHTML = '<div class="mk-empty">暂无已上架的应用。成为第一个发布者吧！</div>';
      return true;
    }
    apps.forEach((a) => { appIndex[a.id] = a; });
    grid.innerHTML = apps.map((a) => cardHtml(a, false)).join("");
    bindSaveButtons(grid);
    bindLikeButtons(grid);
    return true;
  }

  // ---------- 版本更新提示（与 app.js 同源逻辑，按本页主脚本 marketplace.js?v= 判定）----------
  // 让应用广场页也能检测新部署并提示刷新，避免用户停留在带版本号的旧缓存上（之前无任何更新机制）。
  function getPageVersion() {
    const s = document.querySelector('script[src*="marketplace.js"]');
    if (s) {
      const m = /[?&]v=([^&"'\s>]+)/.exec(s.getAttribute("src") || s.src || "");
      if (m) return m[1];
    }
    return "unknown";
  }
  function showUpdateBanner(cur) {
    const banner = document.getElementById("updateBanner");
    const txt = document.getElementById("updateText");
    if (txt) txt.textContent = "已更新到新版本 v" + cur + "，点击刷新";
    if (banner) banner.hidden = false;
  }
  function handleServerVersion(ver) {
    if (!ver) return;
    const cur = getPageVersion();
    if (ver !== cur) {
      showUpdateBanner(ver);
      try { localStorage.setItem("mk-app-version", ver); } catch (e) {}
    }
  }
  function setupUpdateBanner() {
    const btn = document.getElementById("updateReload");
    if (btn) btn.onclick = () => location.reload();
    const cur = getPageVersion();
    let last = null;
    try { last = localStorage.getItem("mk-app-version"); } catch (e) {}
    if (last && last !== cur && cur !== "unknown") showUpdateBanner(cur);
    try { localStorage.setItem("mk-app-version", cur); } catch (e) {}
  }
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // 仅安全上下文（https 或 localhost）注册；http 局域网 IP 跳过
    if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((e) => {
        console.warn("[SW] 注册失败（已忽略）:", (e && e.message) || e);
      });
    });
  }
  function setupSWUpdateListener() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = (event && event.data) || {};
      // SW_VERSION_UPDATE 带 url：仅对应页面弹提示，避免误报
      if (data.type === "SW_VERSION_UPDATE" && data.version) {
        if (!data.url || data.url === location.pathname) handleServerVersion(data.version);
      } else if (data.type === "HTML_VERSION" && data.version) {
        handleServerVersion(data.version);
      } else if (data.type === "SW_READY" && data.versions) {
        const v = data.versions[location.pathname];
        if (v) handleServerVersion(v);
      }
    });
    // 主动向已激活的 SW 查询“本页最新版本”，应对 SW 通知早于本监听的竞态
    const query = () => {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: "QUERY_HTML_VERSION", url: location.pathname });
      }
    };
    if (navigator.serviceWorker.controller) query();
    else navigator.serviceWorker.addEventListener("controllerchange", query);
    if (navigator.serviceWorker.ready && typeof navigator.serviceWorker.ready.then === "function") {
      navigator.serviceWorker.ready.then(query).catch(() => {});
    }
    setTimeout(query, 1500);
  }

  async function init() {
    // 注册 SW（幂等）+ 检测新版本提示（与应用页同源机制）
    registerServiceWorker();
    setupUpdateBanner();
    setupSWUpdateListener();
    const tk = localStorage.getItem(TOKEN_KEY);
    if (tk) {
      try {
        const me = await api("/api/me");
        if (me.user) {
          currentUser = me.user;
          const who = document.getElementById("mkWho");
          who.hidden = false;
          who.querySelector("b").textContent = me.user.username;
        }
      } catch { /* 非致命：广场本身可匿名浏览 */ }
      // 拉取「我的应用」列表，标记广场中已保存的应用（避免重复保存）
      try {
        const linksRes = await api("/api/links");
        (linksRes.links || []).forEach((l) => myLinkUrls.add(normUrl(l.url)));
      } catch { /* 非致命 */ }
    }
    // 事件绑定
    document.querySelectorAll(".mk-tab").forEach((b) => {
      b.addEventListener("click", () => switchTab(b.getAttribute("data-tab")));
    });
    // 「返回应用」：若由「应用广场」按钮以新标签页打开（window.opener 存在），直接关闭本标签页即可返回
    // 原应用（原标签页始终处于登录态、不重载、不出登录检查）；直接访问 / 分享链接进入时，回退到首页。
    const backBtn = document.getElementById("mkBack");
    if (backBtn) {
      backBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (window.opener) { try { window.close(); } catch {} return; }
        if (history.length > 1) history.back();
        else location.href = "index.html";
      });
    }
    document.getElementById("fPc").addEventListener("change", loadPlaza);
    document.getElementById("fMobile").addEventListener("change", loadPlaza);
    document.getElementById("fPwa").addEventListener("change", loadPlaza);
    document.getElementById("publishBtn").addEventListener("click", openPublish);
    document.getElementById("publishClose").addEventListener("click", closePublish);
    document.getElementById("publishModal").addEventListener("click", (e) => {
      if (e.target.id === "publishModal") closePublish();
    });
    document.getElementById("publishForm").addEventListener("submit", submitPublish);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !document.getElementById("publishModal").hidden) closePublish();
    });
    // 首屏优先用服务端渲染的数据水合；否则客户端拉取（含筛选/切换 tab 时也会走 loadPlaza）
    if (!hydrateFromSSR()) {
      await loadPlaza();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
