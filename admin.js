// admin.js —— 管理后台独立页面（admin.html）逻辑，独立于 app.js
// 复用与主应用相同的 token 存储与接口契约：
//   - token: localStorage["web-app-launcher:token"]
//   - GET /api/me            -> { user: { id, username, avatar, role } }
//   - GET /api/admin/users   -> { users: [{ id, username, avatar, role, created_at, link_count }] }
//   - GET /api/admin/stats   -> { stats: { users, links, recentUsers } }
//   - PATCH /api/admin/users/:id  -> { ok: true }（禁止取消自己的管理员角色）
(function () {
  "use strict";

  const TOKEN_KEY = "web-app-launcher:token";
  const THEME_KEY = "web-app-launcher:theme";

  // ---------- 工具 ----------
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function isIconUrl(s) {
    return !!s && /^(https?:\/\/|\/|data:image\/)/i.test(String(s).trim());
  }
  function renderAvatar(val, fallback) {
    const v = val || "";
    if (isIconUrl(v)) {
      return '<img class="avatar-img" src="' + escapeHtml(v) + '" alt="" draggable="false" ' +
        "onerror=\"this.style.display='none';this.parentNode.textContent='" +
        escapeHtml((fallback || "?").toString().charAt(0).toUpperCase()) + "'\"/>";
    }
    if (v) return escapeHtml(v);
    return escapeHtml((fallback || "?").toString().charAt(0).toUpperCase());
  }
  function fmtDate(s) {
    try {
      return new Date(s).toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return String(s == null ? "" : s); }
  }
  function appIconHtml(app) {
    const src = (app.icon && isIconUrl(app.icon))
      ? app.icon
      : "/favicon-proxy?url=" + encodeURIComponent(String(app.url || ""));
    const letter = escapeHtml((app.name || "?").charAt(0).toUpperCase());
    return '<img src="' + escapeHtml(src) + '" alt="" draggable="false" ' +
      "onerror=\"this.style.display='none';this.parentNode.textContent='" + letter + "'\"/>";
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
          const e = new Error(body.error || (res.status === 401 ? "未登录" : "无权访问"));
          e.status = res.status;
          throw e;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || ("请求失败 (" + res.status + ")"));
        }
        return await res.json();
      } catch (err) {
        if (err.status === 401 || err.status === 403) throw err; // 鉴权错误不重试
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
      document.body.appendChild(layer);
    }
    const el = document.createElement("div");
    el.className = "toast " + (kind === "err" ? "toast-err" : "toast-ok");
    el.textContent = msg;
    layer.appendChild(el);
    setTimeout(() => { el.classList.add("toast-hide"); }, 2400);
    setTimeout(() => { el.remove(); }, 3000);
  }

  // ---------- 状态 ----------
  let currentUser = null;
  let appIndex = {}; // id -> 应用，供「详情」弹窗读取完整字段

  // ---------- 渲染 ----------
  function renderNotice(html) {
    const box = document.getElementById("notice");
    if (box) { box.innerHTML = html; box.hidden = false; }
    const main = document.getElementById("adminMain");
    if (main) main.hidden = true;
  }

  function renderStats(stats) {
    const el = document.getElementById("adminStats");
    if (!el) return;
    const cards = [
      { num: stats.users ?? 0, label: "用户总数" },
      { num: stats.links ?? 0, label: "链接总数" },
      { num: stats.recentUsers ?? 0, label: "近 7 天新增" },
    ];
    el.innerHTML = cards.map((c) =>
      '<div class="stat-card"><div class="stat-num">' + escapeHtml(c.num) +
      '</div><div class="stat-label">' + escapeHtml(c.label) + "</div></div>"
    ).join("");
  }

  function renderUsers(users) {
    const tb = document.getElementById("adminUserRows");
    if (!tb) return;
    tb.innerHTML = "";
    if (!users.length) {
      tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-2)">暂无用户</td></tr>';
      return;
    }
    for (const u of users) {
      const isSelf = currentUser && u.id === currentUser.id;
      const roleBadge = '<span class="role-badge role-' + escapeHtml(u.role) + '">' +
        (u.role === "admin" ? "管理员" : "普通用户") + "</span>";
      let action;
      if (u.role === "admin") {
        action = isSelf
          ? '<span class="admin-self">当前账号</span>'
          : '<button class="btn ghost small role-btn" data-id="' + u.id + '" data-role="user">降为普通用户</button>';
      } else {
        action = '<button class="btn ghost small role-btn" data-id="' + u.id + '" data-role="admin">设为管理员</button>';
      }
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.className = "admin-user-cell";
      const av = document.createElement("span");
      av.className = "avatar sm";
      av.innerHTML = renderAvatar(u.avatar, (u.username || "?").charAt(0).toUpperCase());
      const nm = document.createElement("span");
      nm.textContent = u.username;
      nameTd.appendChild(av);
      nameTd.appendChild(nm);
      tr.appendChild(nameTd);
      tr.insertAdjacentHTML("beforeend",
        "<td>" + roleBadge + "</td><td>" + escapeHtml(u.link_count) +
        "</td><td>" + escapeHtml(fmtDate(u.created_at)) + "</td><td>" +
        escapeHtml(u.last_active ? fmtDate(u.last_active) : "从未登录") + "</td>");
      const actTd = document.createElement("td");
      actTd.innerHTML = action;
      tr.appendChild(actTd);
      tb.appendChild(tr);
    }
    tb.querySelectorAll(".role-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-id"));
        const role = btn.getAttribute("data-role");
        btn.disabled = true;
        try {
          await api("/api/admin/users/" + id, { method: "PATCH", body: JSON.stringify({ role }) });
          toast(role === "admin" ? "已设为管理员" : "已降为普通用户");
          await loadData();
        } catch (e) {
          btn.disabled = false;
          toast((e && e.message) || "操作失败", "err");
        }
      });
    });
  }

  async function loadData() {
    try {
      const [usersRes, statsRes, appsRes] = await Promise.all([
        api("/api/admin/users"),
        api("/api/admin/stats"),
        api("/api/admin/apps"),
      ]);
      renderStats(statsRes.stats || {});
      renderUsers(usersRes.users || []);
      renderApps(appsRes.apps || []);
    } catch (e) {
      if (e && e.status === 403) {
        renderNotice('无权访问：当前账号不是管理员。<a href="index.html">返回应用</a>');
      } else {
        toast((e && e.message) || "加载失败", "err");
      }
    }
  }

  function renderApps(apps) {
    const tb = document.getElementById("adminAppRows");
    if (!tb) return;
    appIndex = {};
    apps.forEach((a) => { appIndex[a.id] = a; });
    const pending = apps.filter((a) => a.status === "pending").length;
    const pc = document.getElementById("pendingCount");
    if (pc) pc.textContent = pending ? ("（待审核 " + pending + "）") : "";
    tb.innerHTML = "";
    if (!apps.length) {
      tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-2)">暂无应用</td></tr>';
      return;
    }
    const stMap = { pending: "待审核", approved: "已上架", rejected: "已拒绝" };
    for (const a of apps) {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.innerHTML = '<div style="font-weight:600">' + escapeHtml(a.name) + "</div>" +
        '<a href="' + escapeHtml(a.url) + '" target="_blank" rel="noopener" style="font-size:12px;color:var(--text-2)">' +
        escapeHtml(a.url) + "</a>";
      const userTd = document.createElement("td");
      userTd.textContent = a.username || "未知";
      const pcTd = document.createElement("td");
      pcTd.textContent = a.supports_pc ? "是" : "否";
      const mobileTd = document.createElement("td");
      mobileTd.textContent = a.supports_mobile ? "是" : "否";
      const pwaTd = document.createElement("td");
      pwaTd.textContent = a.supports_pwa ? "是" : "否";
      const statusTd = document.createElement("td");
      statusTd.innerHTML = '<span class="mk-status ' + escapeHtml(a.status) + '">' +
        (stMap[a.status] || a.status) + "</span>";
      const actTd = document.createElement("td");
      let html = '<button class="btn ghost small app-detail" data-id="' + a.id + '">详情</button> ';
      if (a.status !== "approved") html += '<button class="btn ghost small app-approve" data-id="' + a.id + '">通过</button> ';
      if (a.status !== "rejected") html += '<button class="btn ghost small app-reject" data-id="' + a.id + '">拒绝</button>';
      actTd.innerHTML = html;
      tr.appendChild(nameTd);
      tr.appendChild(userTd);
      tr.appendChild(pcTd);
      tr.appendChild(mobileTd);
      tr.appendChild(pwaTd);
      tr.appendChild(statusTd);
      tr.appendChild(actTd);
      tb.appendChild(tr);
    }
    tb.querySelectorAll(".app-detail").forEach((btn) => {
      btn.addEventListener("click", () => openAppDetail(Number(btn.getAttribute("data-id"))));
    });
    tb.querySelectorAll(".app-approve").forEach((btn) => {
      btn.addEventListener("click", () => approveApp(Number(btn.getAttribute("data-id")), btn));
    });
    tb.querySelectorAll(".app-reject").forEach((btn) => {
      btn.addEventListener("click", () => rejectApp(Number(btn.getAttribute("data-id")), btn));
    });
  }

  // ---------- 审核操作（行内与详情弹窗共用）----------
  async function approveApp(id, btn) {
    if (btn) btn.disabled = true;
    try {
      await api("/api/admin/apps/" + id + "/approve", { method: "POST" });
      toast("已通过并上架");
      closeAppDetail();
      await loadData();
    } catch (e) {
      if (btn) btn.disabled = false;
      toast((e && e.message) || "操作失败", "err");
    }
  }
  async function rejectApp(id, btn) {
    const reason = prompt("拒绝原因（可选）：");
    if (reason === null) { if (btn) btn.disabled = false; return; } // 用户取消
    if (btn) btn.disabled = true;
    try {
      await api("/api/admin/apps/" + id + "/reject", { method: "POST", body: JSON.stringify({ reason }) });
      toast("已拒绝");
      closeAppDetail();
      await loadData();
    } catch (e) {
      if (btn) btn.disabled = false;
      toast((e && e.message) || "操作失败", "err");
    }
  }

  // ---------- 应用详情弹窗 ----------
  function openAppDetail(id) {
    const a = appIndex[id];
    if (!a) return;
    const stMap = { pending: "待审核", approved: "已上架", rejected: "已拒绝" };
    const row = (label, val) =>
      '<div class="detail-row"><div class="detail-label">' + label + "</div><div class=\"detail-val\">" + val + "</div></div>";
    const body = document.getElementById("appDetailBody");
    body.innerHTML =
      '<div class="detail-head">' +
        '<div class="detail-icon">' + appIconHtml(a) + "</div>" +
        "<div>" +
          '<div class="detail-name">' + escapeHtml(a.name) + "</div>" +
          '<a class="detail-url" href="' + escapeHtml(a.url) + '" target="_blank" rel="noopener">' + escapeHtml(a.url) + "</a>" +
        "</div>" +
      "</div>" +
      row("提交者", escapeHtml(a.username || "未知")) +
      row("分类", escapeHtml(a.category || "—")) +
      row("支持 PC", a.supports_pc ? "是" : "否") +
      row("支持手机", a.supports_mobile ? "是" : "否") +
      row("支持 PWA", a.supports_pwa ? "是" : "否") +
      row("状态", '<span class="mk-status ' + escapeHtml(a.status) + '">' + (stMap[a.status] || a.status) + "</span>") +
      row("创建时间", escapeHtml(fmtDate(a.created_at))) +
      (a.description ? row("简介", '<div class="detail-desc">' + escapeHtml(a.description) + "</div>") : "") +
      ((a.status === "rejected" && a.reject_reason)
        ? row("拒绝原因", '<div class="detail-desc" style="color:#d23">' + escapeHtml(a.reject_reason) + "</div>")
        : "");
    const actions = document.getElementById("appDetailActions");
    let ah = "";
    if (a.status !== "approved") ah += '<button class="btn ghost small d-approve">通过</button> ';
    if (a.status !== "rejected") ah += '<button class="btn ghost small d-reject">拒绝</button>';
    actions.innerHTML = ah || '<span class="admin-self">已结束审核</span>';
    const da = actions.querySelector(".d-approve");
    if (da) da.addEventListener("click", () => approveApp(a.id, da));
    const dr = actions.querySelector(".d-reject");
    if (dr) dr.addEventListener("click", () => rejectApp(a.id, dr));
    document.getElementById("appDetailModal").hidden = false;
  }
  function closeAppDetail() {
    const m = document.getElementById("appDetailModal");
    if (m) m.hidden = true;
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

  async function init() {
    // 注册 SW（幂等，PWA/通知所需）；即便未登录也先就绪
    registerServiceWorker();
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      renderNotice('未登录，请先在 <a href="index.html">应用</a> 中登录管理员账号。');
      return;
    }
    try {
      const me = await api("/api/me");
      if (!me.user || me.user.role !== "admin") {
        renderNotice('无权限访问：需要管理员账号。<a href="index.html">返回应用</a>');
        return;
      }
      currentUser = me.user;
      const who = document.getElementById("adminWho");
      if (who) who.textContent = me.user.username;
      await loadData();
      loadVersion();
    } catch (e) {
      if (e && e.status === 401) {
        renderNotice('登录态已失效，请返回 <a href="index.html">应用</a> 重新登录。');
      } else {
        renderNotice("加载失败：" + ((e && e.message) || "未知错误"));
      }
    }
    // 详情弹窗：关闭按钮 / 点遮罩 / Esc
    const detailClose = document.getElementById("appDetailClose");
    if (detailClose) detailClose.addEventListener("click", closeAppDetail);
    const detailModal = document.getElementById("appDetailModal");
    if (detailModal) {
      detailModal.addEventListener("click", (e) => {
        if (e.target.id === "appDetailModal") closeAppDetail();
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && detailModal && !detailModal.hidden) closeAppDetail();
    });
    // 「返回应用」：若由「进入管理后台」按钮以新标签页打开（window.opener 存在），直接关闭本标签页即可返回
    // 原应用（原标签页始终处于登录态、不重载、不出登录检查）；直接访问 / 分享链接进入时，回退到首页。
    const backBtn = document.getElementById("adminBack");
    if (backBtn) {
      backBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (window.opener) { try { window.close(); } catch {} return; }
        if (history.length > 1) history.back();
        else location.href = "index.html";
      });
    }
  }

  // ---------- 版本发布管理（读取 / 保存当前版本记录）----------
  function toLocalInputValue(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function toIsoFromLocal(val) {
    if (!val) return undefined;
    const d = new Date(val); // 无时区部分 → 按本地时间解析
    if (isNaN(d.getTime())) return undefined;
    return d.toISOString();
  }
  async function loadVersion() {
    const saveBtn = document.getElementById("versionSave");
    if (saveBtn) saveBtn.onclick = saveVersion;
    try {
      const r = await api("/api/admin/version");
      if (!r.version) {
        const msg = document.getElementById("versionMsg");
        if (msg) { msg.textContent = r.error || "尚无版本记录（请先部署）"; msg.className = "version-msg err"; }
        return;
      }
      const v = r.version;
      const no = document.getElementById("versionNo");
      if (no) no.textContent = v.version;
      const title = document.getElementById("versionTitle");
      if (title) title.value = v.title || "";
      const note = document.getElementById("versionNote");
      if (note) note.value = v.release_note || "";
      const popup = document.getElementById("versionShowPopup");
      if (popup) popup.checked = !!v.show_popup;
      const pa = document.getElementById("versionPublishedAt");
      if (pa) pa.value = toLocalInputValue(v.published_at);
    } catch (e) {
      const msg = document.getElementById("versionMsg");
      if (msg) { msg.textContent = "加载失败：" + ((e && e.message) || "未知错误"); msg.className = "version-msg err"; }
    }
  }
  async function saveVersion() {
    const title = document.getElementById("versionTitle");
    const note = document.getElementById("versionNote");
    const popup = document.getElementById("versionShowPopup");
    const pa = document.getElementById("versionPublishedAt");
    const msg = document.getElementById("versionMsg");
    const payload = {
      title: title ? title.value.trim() : "",
      release_note: note ? note.value : "",
      show_popup: !!(popup && popup.checked),
      published_at: pa && pa.value ? toIsoFromLocal(pa.value) : undefined,
    };
    if (msg) { msg.textContent = "保存中…"; msg.className = "version-msg"; }
    try {
      await api("/api/admin/version", { method: "PUT", body: JSON.stringify(payload) });
      if (msg) { msg.textContent = "已保存"; msg.className = "version-msg"; }
    } catch (e) {
      if (msg) { msg.textContent = "保存失败：" + ((e && e.message) || "未知错误"); msg.className = "version-msg err"; }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
