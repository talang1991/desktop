/* =====================================================================
 * delight.js — 愉悦体验交互层
 * 职责：按钮水波纹、成功时彩带庆祝、卡片入场错峰、Toast 语义着色。
 * 纯增强，不改动任何业务逻辑；尊重 prefers-reduced-motion。
 * ===================================================================== */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 1. 按钮水波纹 ---------- */
  var RIPPLE_TARGETS = ".btn, .chip, .call-ctrl, .icon-edit, .meeting-copy-link, .avatar-btn";

  function spawnRipple(el, x, y) {
    if (reduceMotion) return;
    el.classList.add("ripple-host");
    var rect = el.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height);
    var span = document.createElement("span");
    span.className = "ripple";
    span.style.width = span.style.height = size + "px";
    span.style.left = (x - rect.left - size / 2) + "px";
    span.style.top = (y - rect.top - size / 2) + "px";
    el.appendChild(span);
    span.addEventListener("animationend", function () {
      if (span.parentNode) span.parentNode.removeChild(span);
    });
    // 兜底清理
    setTimeout(function () { if (span.parentNode) span.parentNode.removeChild(span); }, 700);
  }

  document.addEventListener("pointerdown", function (e) {
    var el = e.target.closest ? e.target.closest(RIPPLE_TARGETS) : null;
    if (!el || el.disabled) return;
    spawnRipple(el, e.clientX, e.clientY);
  }, { passive: true });

  /* ---------- 2. 彩带庆祝 ---------- */
  var CONFETTI_COLORS = ["#4f6ef7", "#8b5cf6", "#f472b6", "#2bb673", "#f6c453", "#ff8a5b"];

  function celebrate() {
    if (reduceMotion) return;
    var count = 34;
    for (var i = 0; i < count; i++) {
      var p = document.createElement("div");
      p.className = "confetti";
      p.style.left = (Math.random() * 100) + "vw";
      p.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      p.style.setProperty("--cf-dur", (1.8 + Math.random() * 1.6).toFixed(2) + "s");
      p.style.animationDelay = (Math.random() * 0.35).toFixed(2) + "s";
      p.style.transform = "rotate(" + (Math.random() * 360) + "deg)";
      document.body.appendChild(p);
      (function (node) {
        node.addEventListener("animationend", function () {
          if (node.parentNode) node.parentNode.removeChild(node);
        });
        setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 4200);
      })(p);
    }
  }

  /* ---------- 3. Toast 语义着色 + 成功庆祝 ---------- */
  var OK_RE = /已添加|已导入|导入成功|已更新|已导出|已复制|已清理|已保存|已连接|success|saved|added|imported/i;
  var ERR_RE = /失败|错误|无效|为空|请|不存在|denied|fail|error|invalid/i;

  var toastEl = document.getElementById("toast");
  if (toastEl) {
    var mo = new MutationObserver(function () {
      // hidden 属性被移除 → toast 显示
      if (!toastEl.hasAttribute("hidden")) {
        var txt = (toastEl.textContent || "").trim();
        toastEl.classList.remove("toast-ok", "toast-err");
        if (OK_RE.test(txt)) {
          toastEl.classList.add("toast-ok");
        } else if (ERR_RE.test(txt)) {
          toastEl.classList.add("toast-err");
        }
      }
    });
    mo.observe(toastEl, { attributes: true, attributeFilter: ["hidden"] });
  }

  /* ---------- 4. 卡片入场：登录后只播一次 ---------- */
  // 修复：原本 .card 永久挂着 cardIn 动画，而加载时 renderGrid 会被连续调用多次
  // （本地渲染 → 服务端同步渲染 → 可能的离线补推渲染），每次重建都重播入场动画；
  // 叠加「插入后再改 --i 导致 animation-delay 变化重启动画」，于是加载后出现两次/多次动画。
  // 现改为：仅当 appView 显示后首次出现卡片时，由脚本一次性设好 --i 并加 .enter 触发，
  // entrancePlayed 置位后后续所有 re-render（同步/筛选/搜索）都不再播，保证只出现一次。
  var grid = document.getElementById("appGrid");
  var appView = document.getElementById("appView");
  var entrancePlayed = false; // 本次登录会话是否已播过
  var entranceArmed = false;  // appView 已显示，允许播

  function applyStagger() {
    if (!grid) return;
    var cards = grid.querySelectorAll(".card:not(.card-broken)");
    for (var i = 0; i < cards.length; i++) {
      cards[i].style.setProperty("--i", String(i % 16));
    }
  }

  function playEntrance() {
    if (reduceMotion || !grid || entrancePlayed) return;
    var cards = grid.querySelectorAll(".card:not(.card-broken)");
    if (cards.length === 0) return;
    applyStagger();                       // 先设好 --i，再加 .enter，避免 delay 变化重启
    for (var i = 0; i < cards.length; i++) cards[i].classList.add("enter");
    entrancePlayed = true;
    var total = 520 + (cards.length % 16) * 38;  // 末张入场结束后再移除类
    setTimeout(function () {
      var cur = grid.querySelectorAll(".card.enter");
      for (var j = 0; j < cur.length; j++) cur[j].classList.remove("enter");
    }, total);
  }

  if (grid) {
    var pending = false;
    var mo2 = new MutationObserver(function () {
      if (entranceArmed && !entrancePlayed) {
        // 等当前批次卡片插完再播（childList 可能分批触发）
        if (!pending) {
          pending = true;
          requestAnimationFrame(function () { pending = false; playEntrance(); });
        }
      }
    });
    mo2.observe(grid, { childList: true });
  }

  function armIfVisible() {
    if (!appView) return;
    if (!appView.hasAttribute("hidden")) {
      // 已可见（含会话恢复时已展示的情况）→ 武装并在有卡片时立即播
      entranceArmed = true;
      if (grid && grid.children.length && !entrancePlayed) playEntrance();
    } else {
      // 隐藏（登出）→ 复位，下次登录重新播一次
      entranceArmed = false;
      entrancePlayed = false;
    }
  }

  if (appView) {
    armIfVisible(); // 初始：处理会话恢复时 appView 已可见的情况
    var appMo = new MutationObserver(armIfVisible);
    appMo.observe(appView, { attributes: true, attributeFilter: ["hidden"] });
  }

  // 暴露给其它脚本在关键节点手动庆祝（如首条应用添加）
  window.__delightCelebrate = celebrate;
})();
