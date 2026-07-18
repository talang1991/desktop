// db.ts —— PostgreSQL 连接、自动建表、密码哈希、会话令牌
import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const rawUrl = Deno.env.get("DATABASE_URL");
if (!rawUrl) {
  throw new Error("缺少环境变量 DATABASE_URL（PostgreSQL 连接串）");
}

// 解析连接串：原串可能不带 database 名、带 sslmode 查询参数，
// 直接传给 deno postgres 驱动会被误判为 unix socket，故用 options 对象显式传参。
const parsed = new URL(rawUrl.split("?")[0]);
const dbName = parsed.pathname.replace(/^\//, "") || "postgres";

const pool = new Pool(
  {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    hostname: parsed.hostname,
    port: Number(parsed.port) || 5432,
    database: dbName,
    tls: { enabled: true }, // 等价于 sslmode=verify-full（Deno 内置 CA 校验服务器证书）
  },
  5,
);

export interface QueryRow {
  [k: string]: unknown;
}

export async function query<T = QueryRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.queryObject<T>(text, params);
    return result.rows;
  } finally {
    client.release();
  }
}

export async function initDb(): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '未分类',
      icon TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#4f6ef7',
      open_new BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_links_user ON links(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  ];
  for (const sql of statements) {
    try {
      await query(sql);
    } catch (e) {
      console.error("initDb 语句执行失败:", (e as Error).message);
    }
  }
}

// ---------- 密码哈希（Web Crypto PBKDF2，零原生依赖）----------
const PBKDF2_ITER = 120_000;

function bufToB64(buf: Uint8Array): string {
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToBuf(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function deriveKey(
  password: string,
  salt: Uint8Array,
  iter: number,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    keyMat,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${bufToB64(salt)}$${bufToB64(key)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts[0] !== "pbkdf2") return false;
  const iter = Number(parts[1]);
  const salt = b64ToBuf(parts[2]);
  const expected = parts[3];
  const key = await deriveKey(password, salt, iter);
  return bufToB64(key) === expected;
}

export function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
