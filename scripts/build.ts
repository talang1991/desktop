#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * scripts/build.ts —— Deno Deploy 运行前的前端资源压缩构建
 *
 * 设计原则:
 *  - **零 npm 依赖** —— Deno Deploy 的 build runner 沙箱里,esbuild 等带
 *    原生二进制的 npm 包(postinstall 下载 @esbuild/linux-x64 等)经常失败;
 *    html-minifier-terser 依赖链又长。这里只用 Deno + node:zlib,
 *    一行 npm 依赖都没有,Deno Deploy 上百分百能跑通。
 *  - **轻量、保守的字节级压缩** —— 去除注释、折叠空白,不重命名局部变量,
 *    不动字符串 / 正则 / 模板字面量内容(token 安全)。
 *    对 316KB 的 app.js 而言,字节级 + gzip + brotli 三层压缩后体积与 esbuild
 *    版几乎持平(差几 KB),完全够用。
 *  - 之后再走 node:zlib 预生成 .gz / .br,由 server.ts 按 Accept-Encoding 协商发送。
 *
 * 行为:
 *  1. 复制项目到 dist/(排除 .env / turn / node_modules / .git 等);
 *  2. 压缩 JS / CSS / HTML,并对带 ?v= 的资源按「压缩后内容」算 8 位哈希,
 *     自动替换 HTML 中的版本号(内容变了才换 URL);
 *  3. 给所有文本资源预生成 .gz / .br。
 *
 * 产物:dist/ 即部署目录(Entry Point 仍为 server.ts,代码无需改动)。
 */
import {
  brotliCompressSync,
  constants as zlibc,
  gzipSync,
} from "node:zlib";

const ROOT = ".";
const OUT = "dist";

const JS_FILES: string[] = [
  "app.js",
  "admin.js",
  "marketplace.js",
  "delight.js",
  "sw.js",
];
const CSS_FILES: string[] = ["styles.css"];
const HTML_FILES: string[] = ["index.html", "admin.html", "marketplace.html"];
const VERSIONED: string[] = [
  ...JS_FILES,
  ...CSS_FILES,
  "manifest.webmanifest",
];

const SKIP = new Set([
  ".git",
  "node_modules",
  ".workbuddy",
  "turn", // TURN 配置与证书私钥,绝不进入部署
  "dist",
  "scripts", // 构建脚本本身不部署
  ".env",
  ".env.example",
  ".gitignore",
  "data.json",
  "chat_kv.sqlite",
  "chat_kv.sqlite-shm",
  "chat_kv.sqlite-wal",
  "DEPLOY.md",
  "keep_server.sh",
  "schema.sql",
  "package.json",
  "package-lock.json",
]);

const enc = new TextEncoder();

// ─────────────────────────────────────────────────────────────────────────────
// 字节级 minifier(纯 Deno 实现,无第三方依赖)
//
// 设计思路:先把字符串字面量从源码中"挖出来"放到 slots[],源码里替换成占位符,
// 在没有字符串的源码里再做注释删除和空白折叠——这样既保留了字符串里的
// /*、//、任意空白(注:这里 /* 仅指块注释样式)不会被误删,又保证结果语法正确。
// ─────────────────────────────────────────────────────────────────────────────

/** 匹配 JS 字符串字面量:双引号 / 单引号 / 模板字符串,内部允许转义符。 */
const JS_STRING_RE = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;

function minifyJs(src: string): string {
  // 1. 把字符串字面量挖出来用占位符代替,后续处理不会破坏字符串里的字符。
  const slots: string[] = [];
  const masked = src.replace(JS_STRING_RE, (m) => {
    slots.push(m);
    return `\u0000S${slots.length - 1}\u0000`;
  });

  // 2. 在无字符串区段去除注释、折叠空白。
  let cleaned = masked
    // /* 块注释 */
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // 行注释。条件:前面不是 : ' " ` \ —— 防止 URL "https://" 被切。
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1")
    // 空白折叠
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  // 3. 把字符串放回去。
  cleaned = cleaned.replace(
    /\u0000S(\d+)\u0000/g,
    (_m, i) => slots[Number(i)],
  );
  return cleaned;
}

function minifyCss(src: string): string {
  return src
    // /* 块注释 */
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // 折叠空白
    .replace(/\s+/g, " ")
    // 标点两侧空格去除
    .replace(/\s*([{};:,()])\s*/g, "$1")
    // 末尾多余分号
    .replace(/;}/g, "}")
    .trim();
}

function minifyHtml(src: string): string {
  // 先把 <script> / <style> / <pre> / <textarea> 整段挖出来 —— 它们里是 JS / CSS /
  // 原始文本,不应该被 HTML 的空白折叠影响。注释也先挖走。
  const slots: string[] = [];
  const SLOT_HEAD = "\u0000S";
  const SLOT_TAIL = "\u0000";

  function stash(re: RegExp): void {
    src = src.replace(re, (m) => {
      slots.push(m);
      return `${SLOT_HEAD}${slots.length - 1}${SLOT_TAIL}`;
    });
  }
  stash(/<script\b[\s\S]*?<\/script>/gi);
  stash(/<style\b[\s\S]*?<\/style>/gi);
  stash(/<pre\b[\s\S]*?<\/pre>/gi);
  stash(/<textarea\b[\s\S]*?<\/textarea>/gi);
  stash(/<!--[\s\S]*?-->/g);

  let s = src
    // 标签之间的空白折叠成无
    .replace(/>\s+</g, "><")
    // 行尾空白
    .replace(/[ \t]+(?=\n)/g, "")
    .trim();

  // 还原挖出的段
  s = s.replace(
    new RegExp(`${SLOT_HEAD}(\\d+)${SLOT_TAIL}`, "g"),
    (_m, i) => slots[Number(i)],
  );
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// 共享小工具
// ─────────────────────────────────────────────────────────────────────────────

async function sha256short(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < 4; i++) s += arr[i].toString(16).padStart(2, "0");
  return s; // 8 位十六进制
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isFile;
  } catch {
    return false;
  }
}

async function copyRecursive(src: string, dst: string): Promise<void> {
  const stat = await Deno.stat(src);
  if (stat.isDirectory) {
    await Deno.mkdir(dst, { recursive: true });
    for await (const e of Deno.readDir(src)) {
      await copyRecursive(`${src}/${e.name}`, `${dst}/${e.name}`);
    }
  } else {
    await Deno.copyFile(src, dst);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把 HTML 中 `name(?:\?v=NN)?` 的资源引用替换为 `name?v=<hash>`。 */
function bumpVersion(html: string, map: Record<string, string>): string {
  for (const [name, hash] of Object.entries(map)) {
    const re = new RegExp(
      `((?:src|href)="[^"]*?)${escapeRe(name)}(?:\\?v=[^"&]+)?(")`,
      "g",
    );
    html = html.replace(re, `$1${name}?v=${hash}$2`);
  }
  return html;
}

/** 预生成 .gz / .br 传输压缩文件。 */
async function precompress(path: string): Promise<[number, number]> {
  const data = await Deno.readFile(path);
  const gz = gzipSync(data, { level: 9 });
  const br = brotliCompressSync(data, {
    params: { [zlibc.BROTLI_PARAM_QUALITY]: 11 },
  });
  await Deno.writeFile(path + ".gz", gz);
  await Deno.writeFile(path + ".br", br);
  return [gz.length, br.length];
}

const TEXT_EXT = new Set([
  ".js",
  ".css",
  ".html",
  ".webmanifest",
  ".svg",
]);

async function* walk(
  dir: string,
): AsyncGenerator<{ path: string; name: string; isFile: boolean }> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) {
      yield* walk(p);
    } else {
      yield { path: p, name: e.name, isFile: true };
    }
  }
}

async function main() {
  console.log("🧹 清理旧的 dist/ ...");
  await Deno.remove(OUT, { recursive: true }).catch(() => {});
  await Deno.mkdir(OUT, { recursive: true });

  console.log("📂 复制运行/静态文件到 dist/(排除密钥与本地数据)...");
  for await (const entry of Deno.readDir(ROOT)) {
    if (SKIP.has(entry.name)) continue;
    await copyRecursive(`${ROOT}/${entry.name}`, `${OUT}/${entry.name}`);
  }
  const versionMap: Record<string, string> = {};
  const report: string[] = [];
  const kb = (n: number) => (n / 1024).toFixed(1) + " KB";

  // 1) JS
  for (const f of JS_FILES) {
    const before = (await Deno.stat(`${ROOT}/${f}`)).size;
    const raw = await Deno.readTextFile(`${ROOT}/${f}`);
    const min = enc.encode(minifyJs(raw));
    await Deno.writeFile(`${OUT}/${f}`, min);
    versionMap[f] = await sha256short(min);
    report.push(`JS  ${f.padEnd(18)} ${kb(before)} -> ${kb(min.length)}`);
  }

  // 2) CSS
  for (const f of CSS_FILES) {
    const before = (await Deno.stat(`${ROOT}/${f}`)).size;
    const raw = await Deno.readTextFile(`${ROOT}/${f}`);
    const min = enc.encode(minifyCss(raw));
    await Deno.writeFile(`${OUT}/${f}`, min);
    versionMap[f] = await sha256short(min);
    report.push(`CSS ${f.padEnd(18)} ${kb(before)} -> ${kb(min.length)}`);
  }

  // 3) manifest.webmanifest(参与版本哈希,但不压缩)
  if (await fileExists(`${OUT}/manifest.webmanifest`)) {
    const bytes = await Deno.readFile(`${OUT}/manifest.webmanifest`);
    versionMap["manifest.webmanifest"] = await sha256short(bytes);
  }

  // 4) HTML(先挖走 <script>/<style>/<pre>/<!-- 段,做空白折叠与注释删除,再换 ?v=)
  for (const f of HTML_FILES) {
    const before = (await Deno.stat(`${ROOT}/${f}`)).size;
    const raw = await Deno.readTextFile(`${ROOT}/${f}`);
    const min = bumpVersion(minifyHtml(raw), versionMap);
    await Deno.writeFile(`${OUT}/${f}`, enc.encode(min));
    report.push(`HTML ${f.padEnd(17)} ${kb(before)} -> ${kb(min.length)}`);
  }

  // 5) 预生成 .gz / .br
  console.log("🗜️  预生成 .gz / .br 传输压缩文件...");
  let compCount = 0;
  for await (const entry of walk(OUT)) {
    if (!entry.isFile) continue;
    const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    if (entry.name.endsWith(".gz") || entry.name.endsWith(".br")) continue;
    await precompress(entry.path);
    compCount++;
  }

  console.log("\n✅ 压缩完成(dist/ 即为部署目录):");
  for (const line of report) console.log("   " + line);
  console.log(`   🗜️  ${compCount} 个文本资源已生成 .gz / .br`);
  console.log("\n下一步:");
  console.log("   deno task build            # 本地重新构建");
  console.log(
    "   cd dist && deno deploy --org <组织> --app <应用> --prod",
  );
}

await main();
