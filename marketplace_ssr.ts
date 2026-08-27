// 应用广场「广场」tab 首屏服务端渲染（SSR）
// 让首屏 HTML 直接携带「已上架」应用卡片，避免首屏空白「加载中」，并利于
// 无 JS / 慢网络 / SEO。卡片结构与 marketplace.js 的 cardHtml(a, false) 保持一致。
//
// 已保存判断：前端登录时已把 token 写入同名 Cookie（wal_token）。首屏请求到达时，
// 服务端从 Cookie 取出 token → getUserByToken 解析用户 → listLinks 取该用户链接，
// 归一化 URL 得到「已保存」集合，渲染卡片时直接标记「✓ 已保存」。同时把 savedUrls
// 注入 #ssrPlazaData，供前端水合（填充 myLinkUrls，避免二次请求 /api/links）。
// 若数据库暂不可用，则返回原始模板，前端照常走客户端 loadPlaza() 兜底。
import { listApprovedApps, getUserByToken, listLinks, listBannerApps, type AppStatus, type BannerApp } from "./store.ts";

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
  return '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(app.name) + '" draggable="false" ' +
    "onerror=\"this.style.display='none';this.parentNode.textContent='" + letter + "'\"/>";
}
function badgeHtml(app: AppStatus): string {
  let b = "";
  if (app.category && app.category !== "其它") {
    b += '<span class="mk-badge">' + escapeHtml(app.category) + "</span>";
  }
  if (app.supports_pc) b += '<span class="mk-badge on-pc">PC</span>';
  if (app.supports_mobile) b += '<span class="mk-badge on-mobile">📱手机</span>';
  if (app.supports_pwa) b += '<span class="mk-badge on-pwa">支持 PWA</span>';
  return b;
}
// 广场卡（无 状态/删除/修改/拒绝原因）；savedSet 命中则显示「✓ 已保存」
function plazaCardHtml(app: AppStatus, savedSet: Set<string>): string {
  const alreadySaved = savedSet.has(normUrl(app.url));
  const save = alreadySaved
    ? '<button class="mk-save" data-save="' + app.id + '" disabled>✓ 已保存</button>'
    : '<button class="mk-save" data-save="' + app.id + '">＋ 保存</button>';
  const liked = app.liked ? " liked" : "";
  const like =
    '<button class="mk-like' + liked + '" data-like="' + app.id + '" type="button" ' +
    'aria-pressed="' + (app.liked ? "true" : "false") + '" title="点赞">' +
      '<span class="mk-like-heart">' + (app.liked ? "♥" : "♡") + "</span>" +
      '<span class="mk-like-count">' + (app.like_count || 0) + "</span>" +
    "</button>";
  return (
    '<article class="mk-card">' +
      '<div class="mk-card-head">' +
        '<div class="mk-icon">' + appIconHtml(app) + "</div>" +
        "<div>" +
          '<h3 class="mk-title">' + escapeHtml(app.name) + "</h3>" +
          '<div class="mk-sub">by ' + escapeHtml(app.username || "未知") + "</div>" +
        "</div>" +
      "</div>" +
      '<div class="mk-desc">' + escapeHtml(app.description || "") + "</div>" +
      '<div class="mk-badges">' + badgeHtml(app) + "</div>" +
      '<div class="mk-card-foot">' +
        '<a class="mk-open" href="' + escapeHtml(app.url) + '" target="_blank" rel="noopener">打开</a>' +
        save +
        like +
      "</div>" +
    "</article>"
  );
}

// 应用列表结构化数据（ItemList + SoftwareApplication），注入首屏 HTML 利于 SEO 富结果
function plazaJsonLd(apps: AppStatus[]): string {
  const itemListElement = apps.map((a, i) => {
    let os = "Web";
    if (a.supports_pc && a.supports_mobile) os = "Windows, macOS, Android, iOS, Web";
    else if (a.supports_mobile) os = "Android, iOS, Web";
    else if (a.supports_pc) os = "Windows, macOS, Web";
    return {
      "@type": "ListItem",
      "position": i + 1,
      "item": {
        "@type": "SoftwareApplication",
        "name": a.name,
        "description": a.description || "",
        "url": a.url,
        "applicationCategory": (a.category && a.category !== "其它") ? a.category : "Utilities",
        "operatingSystem": os,
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CNY" },
        "author": { "@type": "Person", "name": a.username || "踏浪" },
      },
    };
  });
  const data = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "应用广场 - 在线网页工具",
    "itemListElement": itemListElement,
  };
  return '<script type="application/ld+json">' + JSON.stringify(data).replace(/</g, "\\u003c") + "</script>";
}

const PLACEHOLDER = '<div class="mk-grid" id="mkGrid"><div class="mk-msg">加载中…</div></div>';
// 头部门面 Banner 占位：SSR 渲染成功时整体替换为轮播结构；失败则保留原样由前端兜底
const BANNER_PLACEHOLDER = '    <div id="mkBanner" class="mk-banner-slot" hidden></div>';

// ---------------- 应用市场头部 Banner 广告位（SSR 轮播）----------------
// 结构与 marketplace.js 的 bannerItemHtml / renderBanner 保持一致，便于前端水合后复用。
function bannerItemHtml(a: BannerApp, i: number): string {
  const icon = (a.icon && isIconUrl(a.icon)) ? a.icon : faviconFor(a.url);
  const plain = a.banner ? "" : " mk-bi-plain";
  const img = a.banner
    ? '<img class="mk-bi-img" src="' + escapeHtml(a.banner) + '" alt="" loading="lazy" />' +
      '<div class="mk-bi-mask"></div>'
    : "";
  const iconInner = icon
    ? '<img src="' + escapeHtml(icon) + '" alt="" />'
    : escapeHtml((a.name || "·").slice(0, 1));
  return (
    '<button class="mk-banner-item' + plain + '" data-i="' + i + '" title="' + escapeHtml(a.name) + '" type="button">' +
      img +
      '<span class="mk-bi-tag">推荐</span>' +
      '<div class="mk-bi-body">' +
        '<div class="mk-bi-icon">' + iconInner + "</div>" +
        '<div class="mk-bi-text">' +
          '<div class="mk-bi-name">' + escapeHtml(a.name) + "</div>" +
          '<div class="mk-bi-sub">' + escapeHtml(a.description || ("by " + (a.username || "未知"))) + "</div>" +
        "</div>" +
      "</div>" +
    "</button>"
  );
}

// 生成头部门面轮播：单张无指示点/箭头，多张带轮播控件；并把 banner 应用列表注入
// #ssrBannerData 供前端水合（免二次请求）。无 banner 时返回隐藏占位。
function bannerSlotHtml(apps: BannerApp[]): string {
  if (!apps.length) {
    return '<div id="mkBanner" class="mk-banner-slot" hidden></div>';
  }
  let items: string;
  let extra = "";
  if (apps.length > 1) {
    // 无限轮播：首前放「末张克隆」，末后放「首张克隆」，与 marketplace.js renderBanner 一致
    const lead = apps[apps.length - 1];
    const tail = apps[0];
    const order = [lead, ...apps, tail];
    items = order.map((a, pos) => {
      const realIndex = pos === 0 ? apps.length - 1 : (pos === order.length - 1 ? 0 : pos - 1);
      return bannerItemHtml(a, realIndex);
    }).join("");
    const dots = apps.map((_, i) =>
      '<button class="mk-bi-dot' + (i === 0 ? " active" : "") + '" data-dot="' + i + '" aria-label="第 ' + (i + 1) + ' 张"></button>'
    ).join("");
    extra =
      '<div class="mk-banner-dots">' + dots + "</div>" +
      '<button class="mk-bi-arrow prev" aria-label="上一张">‹</button>' +
      '<button class="mk-bi-arrow next" aria-label="下一张">›</button>';
  } else {
    items = apps.map((a, i) => bannerItemHtml(a, i)).join("");
  }
  // 首屏首张真实（clone-index=1）居中：translateX = (1080-930)/2 - 930 = -855px
  const inner = '<div class="mk-banner-track" style="transform:translateX(-855px)">' + items + "</div>" + extra;
  const data = '<script type="application/json" id="ssrBannerData">' +
    JSON.stringify(apps).replace(/</g, "\\u003c") + "</script>";
  return '<div id="mkBanner" class="mk-banner-slot" data-ssr="1">' + inner + "</div>" + data;
}

// req 可选：携带 Cookie 时据此判断登录用户并标记「已保存」；不传则按匿名渲染。
export async function renderMarketplaceHtml(req?: Request): Promise<string> {
  const tmpl = await Deno.readTextFile("./marketplace.html");
  try {
    // 解析登录用户：从 Cookie 读取 token（前端登录时写入），用于判断「是否已保存」与「是否已赞」
    let savedSet = new Set<string>();
    let currentUserId: number | undefined;
    if (req) {
      const token = parseCookies(req)[TOKEN_COOKIE];
      if (token) {
        try {
          const user = await getUserByToken(token);
          if (user) {
            currentUserId = user.id;
            const links = await listLinks(user.id) as Array<{ url?: string }>;
            for (const l of links) {
              const u = normUrl(l.url || "");
              if (u) savedSet.add(u);
            }
          }
        } catch { /* 解析失败则按匿名处理，不影响卡片渲染 */ }
      }
    }
    const apps = await listApprovedApps({}, currentUserId);
    // 防止应用数据中嵌入 </script> 提前闭合脚本标签
    const payload = JSON.stringify({ apps, savedUrls: [...savedSet] }).replace(/</g, "\\u003c");
    const cards = apps.length
      ? apps.map((a) => plazaCardHtml(a, savedSet)).join("")
      : '<div class="mk-empty">暂无已上架的应用。成为第一个发布者吧！</div>';
    const gridHtml =
      '<div class="mk-grid" id="mkGrid">' + cards + "</div>" +
      '<script type="application/json" id="ssrPlazaData">' + payload + "</script>";
    let html = tmpl.replace(PLACEHOLDER, gridHtml);
    // 头部门面轮播：SSR 直接注入首屏 HTML，失败则保留占位、由前端 loadBanner 兜底
    try {
      const bannerApps = await listBannerApps();
      html = html.replace(BANNER_PLACEHOLDER, bannerSlotHtml(bannerApps));
    } catch {
      /* 头部门面渲染失败：保留占位，前端走客户端 loadBanner 兜底 */
    }
    // 应用列表结构化数据（ItemList）：注入首屏 HTML 尾部，利于 SEO 富结果
    if (apps.length) {
      html = html.replace("</body>", plazaJsonLd(apps) + "\n</body>");
    }
    return html;
  } catch {
    // 数据库暂不可用：回退原始模板，前端照常走客户端 loadPlaza() 兜底
    return tmpl;
  }
}
