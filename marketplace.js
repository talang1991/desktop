// marketplace.js —— 应用广场独立页面（marketplace.html）逻辑，独立于 app.js
// 复用与主应用相同的 token 存储：
//   - token: localStorage["web-app-launcher:token"]
//   - GET  /api/apps            -> { apps: [...] }（公开，已上架；支持 ?china=1&pwa=1 过滤）
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
    if (app.supports_china) b += '<span class="mk-badge on-china">境内可访问</span>';
    if (app.supports_pwa) b += '<span class="mk-badge on-pwa">支持 PWA</span>';
    return b;
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
        '<div class="mk-desc">' + escapeHtml(app.description || "") + "</div>" +
        '<div class="mk-badges">' + badgeHtml(app) + "</div>" +
        reason +
        '<div class="mk-card-foot">' +
          open +
          save +
          edit +
          del +
        "</div>" +
      "</div>"
    );
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
    try {
      await api("/api/links", {
        method: "POST",
        body: JSON.stringify({
          name: app.name,
          url: app.url,
          category: (app.category && app.category !== "其它") ? app.category : "应用广场",
        }),
      });
      toast("已保存到「我的应用」");
      myLinkUrls.add(normUrl(app.url));
      if (btn) { btn.textContent = "✓ 已保存"; }
    } catch (e) {
      if (btn) btn.disabled = false;
      toast((e && e.message) || "保存失败", "err");
    }
  }

  // ---------- 渲染 ----------
  async function loadPlaza() {
    const grid = document.getElementById("mkGrid");
    const china = document.getElementById("fChina").checked ? 1 : 0;
    const pwa = document.getElementById("fPwa").checked ? 1 : 0;
    grid.innerHTML = '<div class="mk-msg">加载中…</div>';
    try {
      const { apps } = await api("/api/apps?china=" + china + "&pwa=" + pwa);
      appIndex = {};
      apps.forEach((a) => { appIndex[a.id] = a; });
      if (!apps.length) {
        grid.innerHTML = '<div class="mk-empty">暂无已上架的应用。成为第一个发布者吧！</div>';
        return;
      }
      grid.innerHTML = apps.map((a) => cardHtml(a, false)).join("");
      bindSaveButtons(grid);
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
    grid.innerHTML = '<div class="mk-msg">加载中…</div>';
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
    document.getElementById("fChina2").checked = !!app.supports_china;
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
    const supports_china = document.getElementById("fChina2").checked;
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
          body: JSON.stringify({ name, url, category, icon, description, supports_china, supports_pwa }),
        });
        toast("已保存并重新提交，等待管理员审核");
      } else {
        await api("/api/apps", {
          method: "POST",
          body: JSON.stringify({ name, url, category, icon, description, supports_china, supports_pwa }),
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

  async function init() {
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
    document.getElementById("fChina").addEventListener("change", loadPlaza);
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
    await loadPlaza();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
