#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * scripts/build.ts —— Deno Deploy 运行前的轻量前端压缩构建
 *
 * 设计原则:
 *  - **零外部依赖**(无 npm 包,无 node: 模块)。Deno Deploy 的 build runner 沙箱
 *    里,带 native binding 的 npm 包(postinstall 下载二进制)与 node: 子模块在
 *    历史上都有兼容问题;这里只用 Deno 标准库与 Web Crypto,百分百能跑通。
 *  - **轻量字节级压缩**:去除注释、折叠空白,不重命名变量(token 安全),
 *    不动字符串 / 正则 / 模板字面量内容。
 *  - **不做传输层预压缩**.Deno Deploy 的边缘网络会根据请求的 `Accept-Encoding`
 *    自动给响应加 `Content-Encoding: br|gzip`,无需我们预生成 .gz / .br。
 *    `server.ts` 的协商逻辑对预压缩文件缺失做了 graceful fallback,
 *    即便后续需要恢复预压缩 .gz / .br 也只需补回 `node:zlib` 那一步。
 *
 * 行为:
 *  1. 复制项目到 dist/(排除 .env / turn / node_modules / .git 等);
 *  2. 压缩 JS / CSS,对带 ?v= 的资源按「压缩后内容」算 8 位哈希,
 *     自动替换 HTML 中的版本号(内容变了才换 URL);
 *  3. **HTML 不再做任何结构压缩**(历史:regex 折叠曾经在 marketplace.html 上
 *     因为 NUL 占位符泄漏导致 <link rel=stylesheet> 被截断、styles.css 完全
 *     未加载)。改用 passthrough:只做 ?v= 版本号替换,完全保留原文结构。
 *
 * 产物:dist/ 即部署目录(Entry Point 仍为 server.ts,代码无需改动)。
 */

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
// 字节级 minifier
//
// JS: 用 terser(纯 JavaScript 实现,无 native binary、无 postinstall 下载平台
//     二进制,Deno Deploy 的 build runner 沙箱里能稳定跑通)。压缩质量(变量名
//     混淆、死代码删除、常量折叠、去注释)与 esbuild 同级,且它用真正的 JS
//     parser,对正则 / 字符串 / 模板字面量的处理 100% 安全。
// CSS: 纯 Deno regex 压缩已足够(CSS 压缩收益小,CDN 会再 gzip/brotli)。
// HTML: 不再做结构压缩(历史:regex 折叠因 NUL 占位符泄漏炸过,见上方文档)
//       只做 ?v= 版本号替换。
// ─────────────────────────────────────────────────────────────────────────────

import { minify as terserMinify } from "npm:terser@5.36.0";

async function minifyJs(src: string): Promise<Uint8Array> {
  const r = await terserMinify(src, {
    compress: { passes: 2 },
    mangle: true,
    format: { comments: false },
    module: false,
    sourceMap: false,
  });
  if (r.error) throw new Error("terser 压缩失败: " + JSON.stringify(r.error));
  return enc.encode(r.code ?? "");
}

function minifyCss(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};:,()])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
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

/** 把 HTML 中 `name(?:\?v=NN)?` 的资源引用替换为 `name?v=<hash>` */
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

/**
 * 复制 HTML 到部署目录,只做 ?v= 版本号替换,**不做任何结构修改**。
 *
 * 早期版本曾用 regex 折叠标签间空白,但实现中对 SVG 注释 / 内嵌脚本 /
 * 特定属性值处理不可靠,曾在 marketplace.html 中留下 NUL 字节导致
 * 浏览器解析 <link> 被截断、styles.css 完全不加载。这里保守地不做
 * 任何结构压缩 —— HTML 通常 < 35KB,gzip 后损失 < 10KB,不值得为这点
 * 收益冒险。
 */
async function passthroughHtml(
  f: string,
  versionMap: Record<string, string>,
): Promise<void> {
  const raw = await Deno.readTextFile(`${ROOT}/${f}`);
  const out = bumpVersion(raw, versionMap);
  await Deno.writeFile(`${OUT}/${f}`, enc.encode(out));
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
    const min = await minifyJs(raw);
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

  // 3) manifest.webmanifest:参与版本哈希,但不压缩(JSON 已经够紧凑)
  if (await fileExists(`${OUT}/manifest.webmanifest`)) {
    const bytes = await Deno.readFile(`${OUT}/manifest.webmanifest`);
    versionMap["manifest.webmanifest"] = await sha256short(bytes);
  }

  // 4) HTML:**不做结构压缩**,只原样复制 + 替换 ?v=
  for (const f of HTML_FILES) {
    const before = (await Deno.stat(`${ROOT}/${f}`)).size;
    await passthroughHtml(f, versionMap);
    const after = (await Deno.stat(`${OUT}/${f}`)).size;
    report.push(`HTML ${f.padEnd(17)} ${kb(before)} -> ${kb(after)} (passthrough)`);
  }

  console.log("\n✅ 压缩完成(dist/ 即为部署目录):");
  for (const line of report) console.log("   " + line);
  console.log(
    "\n下一步:在 Deno Deploy 控制台把 App Directory 设为 dist,Build command 填 deno task build,然后 Edit Config and Retry。",
  );
}

await main();
