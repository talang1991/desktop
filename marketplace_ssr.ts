// 应用广场「广场」tab 首屏服务端渲染（SSR）
// 让首屏 HTML 直接携带「已上架」应用卡片，避免首屏空白「加载中」，并利于
// 无 JS / 慢网络 / SEO。卡片结构与 marketplace.js 的 cardHtml(a, false) 保持一致。
//
// 已保存判断：前端登录时已把 token 写入同名 Cookie（wal_token）。首屏请求到达时，
// 服务端从 Cookie 取出 token → getUserByToken 解析用户 → listLinks 取该用户链接，
// 归一化 URL 得到「已保存」集合，渲染卡片时直接标记「✓ 已保存」。同时把 savedUrls
// 注入 #ssrPlazaData，供前端水合（填充 myLinkUrls，避免二次请求 /api/links）。
// 若数据库暂不可用，则返回原始模板，前端照常走客户端 loadPlaza() 兜底。
import { listApprovedApps, getUserByToken, listLinks, type AppStatus } from "./store.ts";

// 与前端 localStorage token key 对应的 Cookie 名（前端在登录/注册/启动时写入）
const TOKEN_COOKIE = "wal_token";

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const h = req.headers.get("cookie");
  if (!h) return out;
  for (const part of h.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* 保留原始值 */ }
    out[k] = v;
  }
  return out;
}

// 与 marketplace.js normUrl 保持一致：去首尾空白、去末尾斜杠、小写
function normUrl(u: string): string {
  return String(u == null ? "" : u).trim().replace(/\/+$/, "").toLowerCase();
}

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
// 广场卡（无 状态/删除/修改/拒绝原因）；savedSet 命中则显示「✓ 已保存」
function plazaCardHtml(app: AppStatus, savedSet: Set<string>): string {
  const alreadySaved = savedSet.has(normUrl(app.url));
  const save = alreadySaved
    ? '<button class="mk-save" data-save="' + app.id + '" disabled>✓ 已保存</button>'
    : '<button class="mk-save" data-save="' + app.id + '">＋ 保存</button>';
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
        save +
      "</div>" +
    "</div>"
  );
}

const PLACEHOLDER = '<div class="mk-grid" id="mkGrid"><div class="mk-msg">加载中…</div></div>';

// req 可选：携带 Cookie 时据此判断登录用户并标记「已保存」；不传则按匿名渲染。
export async function renderMarketplaceHtml(req?: Request): Promise<string> {
  const tmpl = await Deno.readTextFile("./marketplace.html");
  try {
    const apps = await listApprovedApps({});
    // 解析登录用户：从 Cookie 读取 token（前端登录时写入），用于判断「是否已保存」
    let savedSet = new Set<string>();
    if (req) {
      const token = parseCookies(req)[TOKEN_COOKIE];
      if (token) {
        try {
          const user = await getUserByToken(token);
          if (user) {
            const links = await listLinks(user.id) as Array<{ url?: string }>;
            for (const l of links) {
              const u = normUrl(l.url || "");
              if (u) savedSet.add(u);
            }
          }
        } catch { /* 解析失败则按匿名处理，不影响卡片渲染 */ }
      }
    }
    // 防止应用数据中嵌入 </script> 提前闭合脚本标签
    const payload = JSON.stringify({ apps, savedUrls: [...savedSet] }).replace(/</g, "\\u003c");
    const cards = apps.length
      ? apps.map((a) => plazaCardHtml(a, savedSet)).join("")
      : '<div class="mk-empty">暂无已上架的应用。成为第一个发布者吧！</div>';
    const gridHtml =
      '<div class="mk-grid" id="mkGrid">' + cards + "</div>" +
      '<script type="application/json" id="ssrPlazaData">' + payload + "</script>";
    return tmpl.replace(PLACEHOLDER, gridHtml);
  } catch {
    // 数据库暂不可用：回退原始模板，前端照常走客户端 loadPlaza() 兜底
    return tmpl;
  }
}
