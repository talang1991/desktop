#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-run
/**
 * scripts/build.ts —— Deno Deploy 运行前的前端资源压缩构建
 *
 * 功能：
 *  1. 用 esbuild 压缩 JS（app.js / admin.js / marketplace.js / delight.js / sw.js）与 CSS（styles.css）；
 *  2. 用 html-minifier-terser 压缩 index.html / admin.html / marketplace.html；
 *  3. 对带 `?v=` 的资源按「压缩后内容」计算短哈希，自动替换 HTML 中的版本号，
 *     实现「内容变化才换 URL、才让浏览器重新拉取」的精准缓存失效；
 *  4. 为所有文本资源预生成 `.gz` / `.br` 传输压缩文件，由 server.ts 按 Accept-Encoding 协商发送；
 *  5. 原样复制 Deno Deploy 入口所需的 .ts 运行时文件与静态资源到 dist/（排除 .env / node_modules / .git 等）。
 *
 * 产物：dist/ 即部署目录（入口仍为 server.ts，代码无需改动）。
 */
import { build } from "npm:esbuild@0.24.2";
import { minify as htmlMinify } from "npm:html-minifier-terser@7.2.0";
import { gzipSync, brotliCompressSync, constants as zlibc } from "node:zlib";

const ROOT = ".";
const OUT = "dist";

// —— 需要压缩的文本资源（保留原文件名，原地覆盖到 dist/）——
const JS_FILES: string[] = ["app.js", "admin.js", "marketplace.js", "delight.js", "sw.js"];
const CSS_FILES: string[] = ["styles.css"];
const HTML_FILES: string[] = ["index.html", "admin.html", "marketplace.html"];

// —— 参与「版本号哈希（缓存失效）」的资源（HTML 中通过 ?v= 引用）——
const VERSIONED: string[] = [...JS_FILES, ...CSS_FILES, "manifest.webmanifest"];

// —— 复制到 dist/ 时需要整体跳过的条目（含密钥 / 本地数据 / 依赖缓存 / 构建产物）——
const SKIP = new Set([
  ".git",
  "node_modules",
  ".workbuddy",
  "turn", // TURN 配置与证书私钥，绝不进入部署
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

async function minifyJs(path: string): Promise<Uint8Array> {
  const r = await build({
    entryPoints: [path],
    bundle: false,
    minify: true,
    format: "iife", // 经典脚本包裹，保持全局作用域，避免影响页面其它引用
    target: ["es2020"],
    write: false,
    legalComments: "none",
  });
  return enc.encode(r.outputFiles[0].text);
}

async function minifyCss(path: string): Promise<Uint8Array> {
  const r = await build({
    entryPoints: [path],
    bundle: false,
    minify: true,
    loader: { ".css": "css" },
    write: false,
    legalComments: "none",
  });
  return enc.encode(r.outputFiles[0].text);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把 HTML 中 `name(?:\?v=NN)?` 的资源引用替换为 `name?v=<hash>`，实现按内容精准缓存失效 */
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

/** 为文本资源预生成 .gz / .br 传输压缩文件 */
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

const TEXT_EXT = new Set([".js", ".css", ".html", ".webmanifest", ".svg"]);

async function main() {
  console.log("🧹 清理旧的 dist/ ...");
  await Deno.remove(OUT, { recursive: true }).catch(() => {});
  await Deno.mkdir(OUT, { recursive: true });

  console.log("📂 复制运行/静态文件到 dist/（排除密钥与本地数据）...");
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
    const min = await minifyJs(`${ROOT}/${f}`);
    await Deno.writeFile(`${OUT}/${f}`, min);
    versionMap[f] = await sha256short(min);
    report.push(`JS  ${f.padEnd(18)} ${kb(before)} -> ${kb(min.length)}`);
  }

  // 2) CSS
  for (const f of CSS_FILES) {
    const before = (await Deno.stat(`${ROOT}/${f}`)).size;
    const min = await minifyCss(`${ROOT}/${f}`);
    await Deno.writeFile(`${OUT}/${f}`, min);
    versionMap[f] = await sha256short(min);
    report.push(`CSS ${f.padEnd(18)} ${kb(before)} -> ${kb(min.length)}`);
  }

  // 3) manifest.webmanifest（参与版本哈希，但不压缩）
  if (await fileExists(`${OUT}/manifest.webmanifest`)) {
    const bytes = await Deno.readFile(`${OUT}/manifest.webmanifest`);
    versionMap["manifest.webmanifest"] = await sha256short(bytes);
  }

  // 4) HTML（先压缩，再按 versionMap 替换 ?v=）
  for (const f of HTML_FILES) {
    const before = (await Deno.stat(`${ROOT}/${f}`)).size;
    const raw = await Deno.readTextFile(`${ROOT}/${f}`);
    const min = await htmlMinify(raw, {
      collapseWhitespace: true,
      removeComments: true,
      minifyCSS: false, // CSS 已单独压缩
      minifyJS: false, // JS 已单独压缩，避免二次处理
      keepClosingSlash: true,
      caseSensitive: true,
      removeOptionalTags: false,
      preserveLineBreaks: false,
    });
    const bumped = bumpVersion(min, versionMap);
    await Deno.writeFile(`${OUT}/${f}`, enc.encode(bumped));
    report.push(`HTML ${f.padEnd(17)} ${kb(before)} -> ${kb(bumped.length)}`);
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

  console.log("\n✅ 压缩完成（dist/ 即为部署目录）：");
  for (const line of report) console.log("   " + line);
  console.log(`   🗜️  ${compCount} 个文本资源已生成 .gz / .br`);
  console.log("\n下一步：");
  console.log("   deno task build            # 本地重新构建");
  console.log("   cd dist && deno deploy --org <组织> --app <应用> --prod");
}

/** 递归遍历目录（与 Deno std 的 walk 等价的最小实现） */
async function* walk(dir: string): AsyncGenerator<{ path: string; name: string; isFile: boolean }> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) {
      yield* walk(p);
    } else {
      yield { path: p, name: e.name, isFile: true };
    }
  }
}

await main();
