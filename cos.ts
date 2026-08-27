// cos.ts —— 腾讯云 COS 对象存储（服务端代理上传，v1 签名预签名 PUT 直传）
//
// 设计要点：
// - 浏览器将图片 POST 到后端；后端用 COS v1 签名生成「预签名 PUT URL」，
//   再以 fetch 把图片字节直传到 COS，最后返回公开访问 URL。
// - 浏览器不需要配置 CORS、也不需要持有密钥，规避签名泄露与跨域问题。
// - 密钥从环境变量读取：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION。
//   可选：COS_PUBLIC_BASE 指定公开访问基址（默认用 bucket.cos.region.myqcloud.com）。
//
// 注意：对象 key 仅使用安全字符（a-z0-9-_.），避免 URI 编码歧义；
//       上传 URL 的签名仅对 content-type 头做签名（q-header-list=content-type）。

export interface CosConfig {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
}

// 读取并校验 COS 配置；缺失则抛错（由调用方转成 500/业务错误）
export function getCosConfig(): CosConfig {
  const secretId = Deno.env.get("COS_SECRET_ID");
  const secretKey = Deno.env.get("COS_SECRET_KEY");
  const bucket = Deno.env.get("COS_BUCKET");
  const region = Deno.env.get("COS_REGION");
  if (!secretId || !secretKey || !bucket || !region) {
    throw new Error(
      "COS 未配置（缺少 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION 环境变量）",
    );
  }
  return { secretId, secretKey, bucket, region };
}

// 仅使用安全字符，避免 URI 编码歧义（COS 路径无需编码）
function randomSuffix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(10);
  crypto.getRandomValues(arr);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += chars[arr[i] % chars.length];
  return s;
}

// 生成对象 key：例如 avatars/u123-<ts>-<rand>.png
export function genCosKey(prefix: string, ext: string): string {
  const e = String(ext || "").replace(/^\./, "").replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  const ts = Date.now().toString(36);
  return `${prefix}/${ts}-${randomSuffix()}.${e}`;
}

async function hmacSha1Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: { name: "SHA-1" } },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha1Hex(message: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-1", enc.encode(message));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 生成预签名 PUT URL（COS v1 签名）。仅对 content-type 头签名。
export async function signCosPutUrl(
  key: string,
  contentType: string,
  expireSeconds = 600,
): Promise<string> {
  const cfg = getCosConfig();
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now};${now + expireSeconds}`;

  const httpMethod = "put";
  const uriPathname = "/" + key; // key 仅含安全字符，无需编码
  const httpParameters = ""; // 无额外 query 参数
  const headerList = "content-type";
  const urlParamList = "";
  const headerString = `content-type=${contentType}`;

  const httpString = `${httpMethod}\n${uriPathname}\n${httpParameters}\n${headerString}\n`;
  const signKey = await hmacSha1Hex(cfg.secretKey, keyTime);
  const stringToSign = `sha1\n${keyTime}\n${await sha1Hex(httpString)}\n`;
  const signature = await hmacSha1Hex(signKey, stringToSign);

  const auth = [
    "q-sign-algorithm=sha1",
    `q-ak=${cfg.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    `q-url-param-list=${urlParamList}`,
    `q-signature=${signature}`,
  ].join("&");

  return `https://${cfg.bucket}.cos.${cfg.region}.myqcloud.com/${key}?${auth}`;
}

// 直传对象到 COS，返回公开访问 URL
// 需要 bucket 设置「公有读」或走 COS_PUBLIC_BASE 指定的 CDN 域名。
export async function uploadToCos(
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<string> {
  const url = await signCosPutUrl(key, contentType);
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: bytes,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`COS 上传失败（${res.status}）${text.slice(0, 300)}`);
  }
  const cfg = getCosConfig();
  const base = (
    Deno.env.get("COS_PUBLIC_BASE") ||
    `https://${cfg.bucket}.cos.${cfg.region}.myqcloud.com`
  ).replace(/\/+$/, "");
  return `${base}/${key}`;
}
