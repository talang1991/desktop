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
          celebrate();
        } else if (ERR_RE.test(txt)) {
          toastEl.classList.add("toast-err");
        }
      }
    });
    mo.observe(toastEl, { attributes: true, attributeFilter: ["hidden"] });
  }

  /* ---------- 4. 卡片入场错峰 ---------- */
  var grid = document.getElementById("appGrid");
  if (grid) {
    var rafId = null;
    function reindex() {
      rafId = null;
      var cards = grid.querySelectorAll(".card:not(.card-broken)");
      for (var i = 0; i < cards.length; i++) {
        cards[i].style.setProperty("--i", String(i % 16));
      }
    }
    var mo2 = new MutationObserver(function () {
      if (rafId == null) rafId = requestAnimationFrame(reindex);
    });
    mo2.observe(grid, { childList: true });
    reindex();
  }

  // 暴露给其它脚本在关键节点手动庆祝（如首条应用添加）
  window.__delightCelebrate = celebrate;
})();
