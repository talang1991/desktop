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
      const chinaTd = document.createElement("td");
      chinaTd.textContent = a.supports_china ? "是" : "否";
      const pwaTd = document.createElement("td");
      pwaTd.textContent = a.supports_pwa ? "是" : "否";
      const statusTd = document.createElement("td");
      statusTd.innerHTML = '<span class="mk-status ' + escapeHtml(a.status) + '">' +
        (stMap[a.status] || a.status) + "</span>";
      const actTd = document.createElement("td");
      let html = "";
      if (a.status !== "approved") html += '<button class="btn ghost small app-approve" data-id="' + a.id + '">通过</button> ';
      if (a.status !== "rejected") html += '<button class="btn ghost small app-reject" data-id="' + a.id + '">拒绝</button>';
      actTd.innerHTML = html || '<span class="admin-self">—</span>';
      tr.appendChild(nameTd);
      tr.appendChild(userTd);
      tr.appendChild(chinaTd);
      tr.appendChild(pwaTd);
      tr.appendChild(statusTd);
      tr.appendChild(actTd);
      tb.appendChild(tr);
    }
    tb.querySelectorAll(".app-approve").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-id"));
        btn.disabled = true;
        try {
          await api("/api/admin/apps/" + id + "/approve", { method: "POST" });
          toast("已通过并上架");
          await loadData();
        } catch (e) {
          btn.disabled = false;
          toast((e && e.message) || "操作失败", "err");
        }
      });
    });
    tb.querySelectorAll(".app-reject").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-id"));
        const reason = prompt("拒绝原因（可选）：");
        if (reason === null) return; // 用户取消
        btn.disabled = true;
        try {
          await api("/api/admin/apps/" + id + "/reject", { method: "POST", body: JSON.stringify({ reason }) });
          toast("已拒绝");
          await loadData();
        } catch (e) {
          btn.disabled = false;
          toast((e && e.message) || "操作失败", "err");
        }
      });
    });
  }

  async function init() {
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
    } catch (e) {
      if (e && e.status === 401) {
        renderNotice('登录态已失效，请返回 <a href="index.html">应用</a> 重新登录。');
      } else {
        renderNotice("加载失败：" + ((e && e.message) || "未知错误"));
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
