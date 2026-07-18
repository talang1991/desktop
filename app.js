/* Web 应用导航面板 —— 本地纯前端实现，数据存于 localStorage */
(function () {
  "use strict";

  const STORE_KEY = "web-app-launcher:apps";
  const THEME_KEY = "web-app-launcher:theme";
  const COLORS = [
    "#4f6ef7", "#e5484d", "#12a594", "#f5a623",
    "#9b5de5", "#f15bb5", "#00bbf9", "#8ac926",
  ];

  /** @type {Array<{id:string,name:string,url:string,category?:string,emoji?:string,color:string,openNew:boolean,createdAt:number}>} */
  let apps = [];
  let activeCategory = "全部";
  let searchTerm = "";

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

  let editingId = null;
  let selectedColor = COLORS[0];

  // ---------- Storage ----------
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      apps = raw ? JSON.parse(raw) : [];
    } catch (e) {
      apps = [];
    }
    if (!Array.isArray(apps)) apps = [];
  }
  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(apps));
  }

  // ---------- Helpers ----------
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
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

    // datalist for add form
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
      emptyState.hidden = apps.length !== 0; // 仅在确实无匹配时显示提示
      if (apps.length === 0) emptyState.querySelector("h2").textContent = "还没有应用";
      else emptyState.querySelector("h2").textContent = "没有匹配的应用";
      emptyState.querySelector("p").textContent = apps.length === 0
        ? "点击右上角「＋ 添加应用」开始收集你的常用网站。"
        : "试试更换分类或搜索关键词。";
      emptyState.hidden = false;
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

      const iconHtml = a.emoji
        ? `<div class="icon" style="background:${a.color}22">${escapeHtml(a.emoji)}</div>`
        : `<div class="icon" style="background:${a.color}22"><img src="${escapeHtml(faviconUrl(a.url))}" alt="" onerror="this.style.display='none';this.parentNode.textContent='${escapeHtml(hostnameOf(a.url).charAt(0).toUpperCase())}'"/></div>`;

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
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeContextMenu(); closeModal(); } });

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
    modal.hidden = false;
    setTimeout(() => $("#fName").focus(), 50);
  }
  function closeModal() { modal.hidden = true; editingId = null; }

  form.addEventListener("submit", (e) => {
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

    if (editingId) {
      const idx = apps.findIndex((a) => a.id === editingId);
      if (idx > -1) apps[idx] = { ...apps[idx], ...payload };
      toast("已更新");
    } else {
      apps.unshift({ id: uid(), createdAt: Date.now(), ...payload });
      toast("已添加");
    }
    save();
    closeModal();
    renderAll();
  });

  function deleteApp(id) {
    const app = apps.find((a) => a.id === id);
    if (!app) return;
    if (!confirm(`确定删除「${app.name}」？`)) return;
    apps = apps.filter((a) => a.id !== id);
    save();
    renderAll();
    toast("已删除");
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
  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data)) throw new Error("格式错误");
        const now = Date.now();
        const incoming = data.map((a) => ({
          id: a.id || uid(),
          name: String(a.name || "未命名"),
          url: String(a.url || ""),
          category: a.category || "未分类",
          emoji: a.emoji || "",
          color: a.color || COLORS[0],
          openNew: a.openNew !== false,
          createdAt: a.createdAt || now,
        })).filter((a) => a.url);
        apps = incoming.concat(apps.filter((a) => !incoming.find((x) => x.id === a.id)));
        save();
        renderAll();
        toast(`已导入 ${incoming.length} 个应用`);
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

  // ---------- Init ----------
  function init() {
    applyTheme(localStorage.getItem(THEME_KEY) || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    load();
    renderAll();
  }
  init();
})();
