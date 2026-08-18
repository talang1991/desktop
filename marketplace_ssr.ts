// 应用广场「广场」tab 首屏服务端渲染（SSR）
// 让首屏 HTML 直接携带「已上架」应用卡片，避免首屏空白「加载中」，并利于
// 无 JS / 慢网络 / SEO。卡片结构与 marketplace.js 的 cardHtml(a, false) 保持一致。
//
// 实现要点：
// - 服务端渲染卡片 HTML 注入到 #mkGrid；
// - 同时附带一个 <script type="application/json" id="ssrPlazaData"> 携带应用数据，
//   供前端 hydrate（填充 appIndex、绑定「保存」按钮、跳过首屏 fetch，避免回退到「加载中」闪烁）；
// - 若数据库暂不可用，则返回原始模板，前端照常走客户端 loadPlaza() 兜底。
import { listApprovedApps, type AppStatus } from "./store.ts";

function escapeHtml(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}
function faviconFor(url: string): string {
  return "/favicon-proxy?url=" + encodeURIComponent(String(url || ""));
}
function isIconUrl(s: string): boolean {
  return !!s && /^(https?:\/\/|\/|data:image\/)/i.test(String(s).trim());
}
function appIconHtml(app: AppStatus): string {
  const src = (app.icon && isIconUrl(app.icon)) ? app.icon : faviconFor(app.url);
  const letter = escapeHtml((app.name || "?").charAt(0).toUpperCase());
  return '<img src="' + escapeHtml(src) + '" alt="" draggable="false" ' +
    "onerror=\"this.style.display='none';this.parentNode.textContent='" + letter + "'\"/>";
}
function badgeHtml(app: AppStatus): string {
  let b = "";
  if (app.category && app.category !== "其它") {
    b += '<span class="mk-badge">' + escapeHtml(app.category) + "</span>";
  }
  if (app.supports_china) b += '<span class="mk-badge on-china">境内可访问</span>';
  if (app.supports_pwa) b += '<span class="mk-badge on-pwa">支持 PWA</span>';
  return b;
}
// 与 marketplace.js cardHtml(a, false) 输出一致（广场卡无 状态/删除/修改/拒绝原因）
function plazaCardHtml(app: AppStatus): string {
  return (
    '<div class="mk-card">' +
      '<div class="mk-card-head">' +
        '<div class="mk-icon">' + appIconHtml(app) + "</div>" +
        "<div>" +
          '<div class="mk-title">' + escapeHtml(app.name) + "</div>" +
          '<div class="mk-sub">by ' + escapeHtml(app.username || "未知") + "</div>" +
        "</div>" +
      "</div>" +
      '<div class="mk-desc">' + escapeHtml(app.description || "") + "</div>" +
      '<div class="mk-badges">' + badgeHtml(app) + "</div>" +
      '<div class="mk-card-foot">' +
        '<a class="mk-open" href="' + escapeHtml(app.url) + '" target="_blank" rel="noopener">打开</a>' +
        '<button class="mk-save" data-save="' + app.id + '">＋ 保存</button>' +
      "</div>" +
    "</div>"
  );
}

const PLACEHOLDER = '<div class="mk-grid" id="mkGrid"><div class="mk-msg">加载中…</div></div>';

export async function renderMarketplaceHtml(): Promise<string> {
  const tmpl = await Deno.readTextFile("./marketplace.html");
  try {
    const apps = await listApprovedApps({});
    // 防止应用数据中嵌入 </script> 提前闭合脚本标签
    const appsJson = JSON.stringify(apps).replace(/</g, "\\u003c");
    const cards = apps.length
      ? apps.map(plazaCardHtml).join("")
      : '<div class="mk-empty">暂无已上架的应用。成为第一个发布者吧！</div>';
    const gridHtml =
      '<div class="mk-grid" id="mkGrid">' + cards + "</div>" +
      '<script type="application/json" id="ssrPlazaData">' + appsJson + "</script>";
    return tmpl.replace(PLACEHOLDER, gridHtml);
  } catch {
    // 数据库暂不可用：回退原始模板，前端照常走客户端 loadPlaza() 兜底
    return tmpl;
  }
}
