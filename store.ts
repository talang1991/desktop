// store.ts
// 真正的 PostgreSQL 持久层（Deno 原生驱动 deno.land/x/postgres）。
// 通过 DATABASE_URL 连接；启动时自动建表（幂等）。
// 若 DB 暂时不可用，服务器仍会启动并提供静态页面与聊天；认证/链接接口会返回 503，
// 连接恢复后下一次请求自动重试（连接池重连）。

import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;

// 数据库不可用时抛出，api 层据此返回 503
export class DbUnavailableError extends Error {
  constructor(msg = "数据库暂时不可用") {
    super(msg);
    this.name = "DbUnavailableError";
  }
}

// ---------------- 类型 ----------------
export interface StoredUser {
  id: number;
  username: string;
  password_hash: string;
  avatar: string;
  role: string;
  created_at: string;
}
export type UserRole = "user" | "admin";
interface LinkRow {
  id: number;
  user_id: number;
  name: string;
  url: string;
  category: string;
  emoji: string;
  color: string;
  open_new: boolean;
  open_mode: string;
  sort_order: number;
  created_at: string;
}

// ---------------- 连接池 ----------------
let pool: Pool | null = null;

function parseDatabaseUrl(raw: string) {
  const url = new URL(raw.split("?")[0]);
  const dbName = url.pathname.replace(/^\//, "") || "postgres";
  const sslmode = (raw.match(/[?&]sslmode=([a-z\-]+)/i)?.[1] ?? "").toLowerCase();
  const tlsEnabled = sslmode !== "disable"; // require/prefer/verify-full/verify-ca/默认 -> 启用 TLS
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    hostname: url.hostname,
    port: Number(url.port) || 5432,
    database: dbName,
    tls: { enabled: tlsEnabled },
  };
}

// 判断是否为「连接级瞬时错误」：池化代理（如 Prisma）常会杀掉空闲连接，
// 导致查询时出现 broken pipe / connection reset / TLS 握手超时等，重试一次通常即可恢复。
function isTransientConnError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)) ?? "";
  return /broken pipe|connection reset|ECONNRESET|terminated|closed by peer|ETIMEDOUT|timeout|TLS|handshake|ECONNREFUSED|connection closed/i
    .test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 单条查询的执行超时（毫秒）：池化代理偶发把查询挂死（无连接错误、只是不返回），
// 若不加超时，整个请求会一直挂到外层超时。这里用 Promise.race 让查询在 STMT_TIMEOUT
// 内未完成即被视为「瞬时错误」进入重试，从而快速失败 / 尽快恢复，而不是卡住整个请求。
const STMT_TIMEOUT = 8000;
function withStmtTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed out")), STMT_TIMEOUT)),
  ]);
}

// 连接池执行：成功自动释放；遇到瞬时连接错误时丢弃坏连接并重试（最多 MAX 次）。
// 这样即便池化代理杀掉空闲连接，单次请求也会在内部透明重试到拿到可用连接，对外不再随机 500。
async function withClient<T>(fn: (c: any) => Promise<T>): Promise<T> {
  if (!pool) throw new DbUnavailableError();
  const MAX = 6;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    let client: any;
    try {
      // 连接阶段也加超时：池化代理偶发「TCP 已连但协议层挂死」，
      // 若不限制，pool.connect() 会一直阻塞，导致整个请求（甚至服务启动）卡死。
      client = await withStmtTimeout(pool.connect());
    } catch (e) {
      lastErr = e;
      if (attempt < MAX) { await sleep(250 * attempt); continue; }
      break;
    }
    let broken = false;
    try {
      return await withStmtTimeout(fn(client));
    } catch (e) {
      lastErr = e;
      if (isTransientConnError(e) && attempt < MAX) {
        broken = true;
        try { await client.end(); } catch {} // 不要放回池，直接关闭坏连接
        await sleep(250 * attempt);
        continue;
      }
      throw e;
    } finally {
      if (!broken) {
        try { client.release(); } catch {}
      }
    }
  }
  if (isTransientConnError(lastErr) || lastErr instanceof DbUnavailableError) {
    throw new DbUnavailableError("数据库连接不稳定：" + ((lastErr instanceof Error ? lastErr.message : String(lastErr)) ?? ""));
  }
  throw lastErr as Error;
}

// 单条查询/写入助手：返回 rows（已按 T 断言）
async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withClient(async (c: any) => {
    const res = await c.queryObject(sql, params);
    return res.rows as T[];
  });
}

function ensureDb() {
  if (!pool) throw new DbUnavailableError();
}

// ---------------- 密码哈希（pbkdf2$iter$saltB64$keyB64，兼容历史账号）----------------
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
async function deriveKey(password: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, keyMat, 256);
  return new Uint8Array(bits);
}
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${bufToB64(salt)}$${bufToB64(key)}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
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
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------- 初始化 / 建表 / 迁移 ----------------
export async function initStore(): Promise<void> {
  const raw = Deno.env.get("DATABASE_URL");
  if (!raw) {
    console.error(
      "[store] 未设置 DATABASE_URL：数据库不可用。静态页面与聊天仍可用，登录/链接接口将返回 503。",
    );
    return;
  }
  try {
    const cfg = parseDatabaseUrl(raw);
    pool = new Pool(cfg, 5);
    // 反向代理（Prisma 池化）偶发连接抖动：启动建表重试几次，提高一次启动即连上的概率
    let schemaOk = false;
    let lastErr = "";
    // 外层只做「快速探活」：连接/查询不稳时让 withClient 的语句超时（8s）快速失败，
    // 不在此长等；失败则降级运行，后续请求由 withClient 自动重试重连。
    for (let attempt = 1; attempt <= 2 && !schemaOk; attempt++) {
      try {
        await withClient(async (c) => {
          await c.queryObject(
            `CREATE TABLE IF NOT EXISTS users (
              id SERIAL PRIMARY KEY,
              username TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              avatar TEXT NOT NULL DEFAULT '',
              created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )`,
          );
          // 兼容已存在的 users 表（线上生产库）：非破坏性补充 avatar 列
          await c.queryObject(
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT ''`,
          );
          // 角色：普通用户 user / 管理员 admin（默认 user）；CHECK 约束保证取值合法，DO 块幂等可重复执行
          await c.queryObject(
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'`,
          );
          await c.queryObject(
            `DO $$ BEGIN
               ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (role IN ('user','admin'));
             EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
          );
          await c.queryObject(
            `CREATE TABLE IF NOT EXISTS links (
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              title TEXT NOT NULL,
              url TEXT NOT NULL,
              category TEXT NOT NULL DEFAULT '未分类',
              icon TEXT NOT NULL DEFAULT '',
              color TEXT NOT NULL DEFAULT '#4f6ef7',
              open_new BOOLEAN NOT NULL DEFAULT true,
              open_mode TEXT NOT NULL DEFAULT 'new',
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )`,
          );
          await c.queryObject(
            `CREATE TABLE IF NOT EXISTS sessions (
              token TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              expires_at TIMESTAMPTZ NOT NULL
            )`,
          );
          // 兼容已存在的 sessions 表：补充多端登录所需的设备/UA/时间列
          await c.queryObject(
            `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device TEXT NOT NULL DEFAULT 'desktop'`,
          );
          await c.queryObject(
            `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT NOT NULL DEFAULT ''`,
          );
          await c.queryObject(
            `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
          );
          await c.queryObject(
            `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ NOT NULL DEFAULT now()`,
          );
          await c.queryObject(
            `CREATE TABLE IF NOT EXISTS friendships (
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              UNIQUE (user_id, friend_id)
            )`,
          );
          // 兼容已存在的旧库：补充 open_mode 列（CREATE TABLE IF NOT EXISTS 不会为已有表加列）
          await c.queryObject(
            `ALTER TABLE links ADD COLUMN IF NOT EXISTS open_mode TEXT NOT NULL DEFAULT 'new'`,
          );
          // 兼容已存在的旧库：补充 sort_order 列（拖动排序用；老库无此列会导致排序读写静默失败）
          await c.queryObject(
            `ALTER TABLE links ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`,
          );
          // 群聊：群表 + 群成员表
          await c.queryObject(
            `CREATE TABLE IF NOT EXISTS chat_groups (
              id SERIAL PRIMARY KEY,
              name TEXT NOT NULL,
              owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              avatar TEXT NOT NULL DEFAULT '',
              created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )`,
          );
          await c.queryObject(
            `CREATE TABLE IF NOT EXISTS group_members (
              group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              PRIMARY KEY (group_id, user_id)
            )`,
          );
        });
        schemaOk = true;
      } catch (e) {
        lastErr = (e as Error).message;
        if (attempt < 6) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (schemaOk) {
      console.error("[store] PostgreSQL 已连接，表结构已就绪。");
      await migrateFromJson();
    } else {
      // 保留 pool，后续请求会自动重试重连
      console.error(
        "[store] 数据库初始化失败（已重试），降级运行（静态/聊天可用，认证/链接不可用，连接恢复后自动重试）：",
        lastErr,
      );
    }
  } catch (e) {
    // 保留 pool，后续请求会自动重试重连
    console.error(
      "[store] 数据库初始化失败，降级运行（静态/聊天可用，认证/链接不可用，连接恢复后自动重试）：",
      (e as Error).message,
    );
  }
}

// 首次启动且 PG 为空时，把本地 data.json 的账号/链接迁移进 PostgreSQL（一次性）
async function migrateFromJson(): Promise<void> {
  let data: { users?: any[]; links?: any[] };
  try {
    const txt = await Deno.readTextFile("./data.json");
    data = JSON.parse(txt);
  } catch {
    return;
  }
  const ju = data.users ?? [];
  const jl = data.links ?? [];
  if (!ju.length && !jl.length) return;
  try {
    await withClient(async (c) => {
      const cnt = await c.queryObject(`SELECT COUNT(*)::int AS n FROM users`);
      if ((cnt.rows[0]?.n ?? 0) > 0) return; // 已有数据则跳过
      for (const u of ju) {
        await c.queryObject(
          `INSERT INTO users (id, username, password_hash, created_at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (username) DO NOTHING`,
          [u.id, u.username, u.password_hash, u.created_at ?? new Date().toISOString()],
        );
      }
      for (const l of jl) {
        await c.queryObject(
          `INSERT INTO links (id, user_id, name, url, category, emoji, color, open_new, open_mode, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO NOTHING`,
          [
            l.id, l.user_id, l.name, l.url,
            l.category ?? "未分类", l.emoji ?? "", l.color ?? "#4f6ef7",
            l.openNew !== false, l.openMode ?? "new", new Date(l.createdAt ?? Date.now()).toISOString(),
          ],
        );
      }
      console.error(`[store] 已从本地 data.json 迁移 ${ju.length} 用户 / ${jl.length} 链接到 PostgreSQL。`);
    });
  } catch (e) {
    console.error("[store] 本地数据迁移跳过：", (e as Error).message);
  }
}

// ---------------- 用户 ----------------
function validUsername(u: string): boolean {
  return /^[a-zA-Z0-9_\-]{3,32}$/.test(u);
}

export async function registerUser(username: string, password: string, avatar = ""): Promise<StoredUser> {
  if (!validUsername(username)) throw new Error("用户名需为 3-32 位字母/数字/下划线/连字符");
  if (password.length < 6) throw new Error("密码至少 6 位");
  ensureDb();
  const exist = await query<{ id: number }>(`SELECT id FROM users WHERE username = $1`, [username]);
  if (exist.length) throw new Error("用户名已存在");
  const hash = await hashPassword(password);
  const av = String(avatar || "").slice(0, ICON_MAX);
  const rows = await query<{ id: number; username: string; role: string }>(
    `INSERT INTO users (username, password_hash, avatar) VALUES ($1,$2,$3) RETURNING id, username, role`,
    [username, hash, av],
  );
  return { id: rows[0].id, username: rows[0].username, password_hash: hash, avatar: av, role: rows[0].role, created_at: new Date().toISOString() };
}

export async function findUserByUsername(username: string): Promise<StoredUser | null> {
  ensureDb();
  const rows = await query<StoredUser>(
    `SELECT id, username, password_hash, avatar, role, created_at FROM users WHERE username = $1`,
    [username],
  );
  return rows[0] ?? null;
}

// ---------------- 会话 ----------------
// device: "mobile" | "desktop" | "tablet"（多端登录展示用）；userAgent 原样留存便于排查
export async function createSession(
  userId: number,
  device = "desktop",
  userAgent = "",
): Promise<string> {
  ensureDb();
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_MS);
  await query(
    `INSERT INTO sessions (token, user_id, expires_at, device, user_agent, created_at, last_active)
     VALUES ($1,$2,$3,$4,$5, now(), now())`,
    [token, userId, expires.toISOString(), device, userAgent],
  );
  return token;
}

// 列出某用户的所有会话（按登录时间倒序），用于「登录设备」管理面板
export async function listSessions(
  userId: number,
): Promise<Array<{ token: string; device: string; user_agent: string; created_at: string; last_active: string }>> {
  ensureDb();
  const rows = await query<{ token: string; device: string; user_agent: string; created_at: string; last_active: string }>(
    `SELECT token, device, user_agent, created_at, last_active
     FROM sessions WHERE user_id = $1 ORDER BY last_active DESC`,
    [userId],
  );
  return rows;
}

// 剔除某用户除当前 token 外的所有会话（一键登出其他设备），返回被踢出的会话数
export async function deleteOtherSessions(userId: number, exceptToken: string): Promise<number> {
  ensureDb();
  const rows = await query<{ token: string }>(
    `DELETE FROM sessions WHERE user_id = $1 AND token <> $2 RETURNING token`,
    [userId, exceptToken],
  );
  return rows.length;
}

// 撤销指定会话（须属于该用户，防止越权踢人）
export async function revokeSession(token: string, userId: number): Promise<boolean> {
  ensureDb();
  const rows = await query<{ token: string }>(
    `DELETE FROM sessions WHERE token = $1 AND user_id = $2 RETURNING token`,
    [token, userId],
  );
  return rows.length > 0;
}

// 更新会话活跃时间（/api/me 拉取时顺带刷新，用于「最近活跃」展示）
export async function touchSession(token: string): Promise<void> {
  ensureDb();
  await query(`UPDATE sessions SET last_active = now() WHERE token = $1`, [token]).catch(() => {});
}

export async function getUserByToken(token: string): Promise<{ id: number; username: string; avatar: string; role: string } | null> {
  ensureDb();
  const rows = await query<{ id: number; username: string; avatar: string; role: string; expires_at: string }>(
    `SELECT u.id, u.username, u.avatar, u.role, s.expires_at FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = $1`,
    [token],
  );
  const r = rows[0];
  if (!r) return null;
  if (new Date(r.expires_at).getTime() < Date.now()) {
    await query(`DELETE FROM sessions WHERE token = $1`, [token]).catch(() => {});
    return null;
  }
  return { id: r.id, username: r.username, avatar: r.avatar, role: r.role };
}

// 按 id 取用户基本信息（用于会议房间名单展示），不存在返回 null
export async function getUserById(id: number): Promise<{ id: number; username: string; avatar: string; role: string } | null> {
  ensureDb();
  if (!Number.isFinite(id) || id < 0) return null; // 访客为负 id，无需查库
  const rows = await query<{ id: number; username: string; avatar: string; role: string }>(
    `SELECT id, username, avatar, role FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// 更新当前用户头像（emoji 或图片链接）
export async function updateUserAvatar(userId: number, avatar: string): Promise<boolean> {
  ensureDb();
  const rows = await query<{ id: number }>(
    `UPDATE users SET avatar = $1 WHERE id = $2 RETURNING id`,
    [String(avatar || "").slice(0, ICON_MAX), userId],
  );
  return rows.length > 0;
}

// 更新当前用户昵称（即展示名，复用 username 列）。
// 仅用于“已登录用户修改自己的展示名”路径，校验较注册更宽松（允许中文/空格等），
// 但受 username 列的 UNIQUE 约束限制（重复昵称会失败）。
export async function updateUserUsername(
  userId: number,
  username: string,
): Promise<{ ok: boolean; username?: string; error?: string }> {
  ensureDb();
  const name = String(username ?? "").trim();
  if (!name) return { ok: false, error: "昵称不能为空" };
  if (name.length > 32) return { ok: false, error: "昵称最多 32 个字符" };
  try {
    const rows = await query<{ id: number; username: string }>(
      `UPDATE users SET username = $1 WHERE id = $2 RETURNING id, username`,
      [name, userId],
    );
    if (rows.length === 0) return { ok: false, error: "用户不存在" };
    return { ok: true, username: rows[0].username };
  } catch (e) {
    const msg = String((e as { message?: string })?.message || e);
    if (/unique/i.test(msg)) return { ok: false, error: "该昵称已被使用" };
    return { ok: false, error: "昵称保存失败，请重试" };
  }
}

export async function deleteSession(token: string): Promise<void> {
  ensureDb();
  await query(`DELETE FROM sessions WHERE token = $1`, [token]).catch(() => {});
}

// ---------------- 角色管理（管理后台用）----------------
// 修改用户角色（仅 'user' / 'admin' 合法）。返回是否有该行被更新。
export async function updateUserRole(userId: number, role: string): Promise<boolean> {
  ensureDb();
  if (role !== "user" && role !== "admin") throw new Error("无效的角色");
  const rows = await query<{ id: number }>(
    `UPDATE users SET role = $1 WHERE id = $2 RETURNING id`,
    [role, userId],
  );
  return rows.length > 0;
}

// ---------------- 管理后台聚合查询 ----------------
// 全部用户：含角色、头像、注册时间、链接数（按注册时间倒序）
export async function listAllUsers(): Promise<
  Array<{ id: number; username: string; avatar: string; role: string; created_at: string; link_count: number }>
> {
  ensureDb();
  const rows = await query<{
    id: number; username: string; avatar: string; role: string; created_at: string; link_count: number;
  }>(
    `SELECT u.id, u.username, u.avatar, u.role, u.created_at,
            (SELECT COUNT(*) FROM links l WHERE l.user_id = u.id)::int AS link_count
     FROM users u ORDER BY u.created_at DESC`,
    [],
  );
  return rows;
}

export async function countUsers(): Promise<number> {
  ensureDb();
  const rows = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users`);
  return rows[0]?.n ?? 0;
}

export async function countLinks(): Promise<number> {
  ensureDb();
  const rows = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM links`);
  return rows[0]?.n ?? 0;
}

// 最近 N 天注册的用户数（默认 7 天）
export async function recentRegistrations(days = 7): Promise<number> {
  ensureDb();
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM users WHERE created_at >= now() - ($1 || ' days')::interval`,
    [days],
  );
  return rows[0]?.n ?? 0;
}

// ---------------- 链接 ----------------
function toLinkShape(l: LinkRow) {
  return {
    id: l.id,
    name: l.name,
    url: l.url,
    category: l.category,
    emoji: l.emoji,
    color: l.color,
    openNew: l.open_new,
    openMode: l.open_mode,
    sortOrder: l.sort_order,
    createdAt: new Date(l.created_at).getTime(),
  };
}

export async function listLinks(userId: number): Promise<unknown[]> {
  ensureDb();
  const rows = await query<LinkRow>(
    `SELECT id, user_id, title AS name, url, category, icon AS emoji, color, open_new, open_mode, sort_order, created_at
     FROM links WHERE user_id = $1 ORDER BY sort_order ASC, created_at DESC`,
    [userId],
  );
  return rows.map(toLinkShape);
}

const ICON_MAX = 2048; // 图标字段可存 emoji 或 favicon 链接，限制长度避免撑爆 DB

export async function createLink(
  userId: number,
  data: { name: string; url: string; category: string; emoji: string; color: string; openNew: boolean; openMode?: string; sortOrder?: number },
): Promise<unknown> {
  ensureDb();
  const icon = String(data.emoji || "").slice(0, ICON_MAX);
  const rows = await query<LinkRow>(
    `INSERT INTO links (user_id, title, url, category, icon, color, open_new, open_mode, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, user_id, title AS name, url, category, icon AS emoji, color, open_new, open_mode, sort_order, created_at`,
    [
      userId, data.name, data.url,
      data.category || "未分类", icon, data.color || "#4f6ef7",
      data.openNew !== false, data.openMode || "new", Number(data.sortOrder) || 0,
    ],
  );
  return toLinkShape(rows[0]);
}

export async function updateLink(
  userId: number,
  id: number,
  fields: Record<string, unknown>,
): Promise<unknown | null> {
  ensureDb();
  // 线上 links 表列名为 title / icon（历史 schema），此处映射
  const map: Record<string, [string, unknown]> = {
    name: ["title", fields.name],
    url: ["url", fields.url],
    category: ["category", fields.category],
    emoji: ["icon", fields.emoji == null ? undefined : String(fields.emoji).slice(0, ICON_MAX)],
    color: ["color", fields.color],
    openNew: ["open_new", fields.openNew],
    openMode: ["open_mode", fields.openMode],
    sortOrder: ["sort_order", fields.sortOrder == null ? undefined : Number(fields.sortOrder)],
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const key of Object.keys(map)) {
    const [col, val] = map[key];
    if (fields[key] != null) {
      sets.push(`${col} = $${i}`);
      params.push(val);
      i++;
    }
  }
  const SEL = `id, user_id, title AS name, url, category, icon AS emoji, color, open_new, open_mode, sort_order, created_at`;
  if (!sets.length) {
    const cur = await query<LinkRow>(`SELECT ${SEL} FROM links WHERE id = $1 AND user_id = $2`, [id, userId]);
    return cur[0] ? toLinkShape(cur[0]) : null;
  }
  params.push(id, userId);
  const sql = `UPDATE links SET ${sets.join(", ")} WHERE id = $${i} AND user_id = $${i + 1} RETURNING ${SEL}`;
  const rows = await query<LinkRow>(sql, params);
  return rows[0] ? toLinkShape(rows[0]) : null;
}

export async function deleteLink(userId: number, id: number): Promise<boolean> {
  ensureDb();
  const rows = await query<{ id: number }>(
    `DELETE FROM links WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  return rows.length > 0;
}

// ---------------- 批量导入（备份还原，直接落 PostgreSQL）----------------
// 兼容两种文件格式：① 纯数组 [link, ...]；② 导出格式 { links: [...] }。
// 按 url 去重（同用户已存在相同 url 则跳过），返回创建/跳过计数。
export async function bulkImportLinks(
  userId: number,
  items: Array<{ name?: string; url?: string; category?: string; emoji?: string; color?: string; openNew?: boolean; openMode?: string }>,
): Promise<{ created: number; skipped: number; total: number }> {
  ensureDb();
  // 严格校验：剔除空串、字面量 "undefined"/"null"/"NaN" 等明显脏数据，避免向 DB 灌入无法使用的"幽灵链接"
  const isJunk = (v: unknown) => {
    if (v == null) return true;
    const s = String(v).trim().toLowerCase();
    return !s || s === "undefined" || s === "null" || s === "nan";
  };
  const valid = (items || [])
    .filter((a) => a && !isJunk((a as any).url) && !isJunk((a as any).name))
    .map((a) => {
      let u = String(a.url).trim();
      // 与 /api/links POST 一致：缺协议自动补 https://
      if (!/^https?:\/\//i.test(u)) u = "https://" + u;
      return {
        name: String(a.name || "未命名").trim(),
        url: u,
        category: String(a.category || "未分类").trim(),
        emoji: String(a.emoji || "").slice(0, ICON_MAX),
        color: String(a.color || "#4f6ef7"),
        openNew: a.openNew !== false,
        openMode: a.openMode || "new",
        sortOrder: typeof a.sortOrder === "number" ? a.sortOrder : 0,
      };
    });
  if (valid.length === 0) return { created: 0, skipped: 0, total: 0 };

  return withClient(async (c: any) => {
    const existRows = await c.queryObject<{ url: string }>(
      `SELECT url FROM links WHERE user_id = $1`,
      [userId],
    );
    const exist = new Set(existRows.rows.map((r: { url: string }) => r.url));
    let created = 0;
    let skipped = 0;
    await c.queryObject(`BEGIN`);
    try {
      for (const it of valid) {
        if (exist.has(it.url)) { skipped++; continue; }
        await c.queryObject(
          `INSERT INTO links (user_id, title, url, category, icon, color, open_new, open_mode, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [userId, it.name, it.url, it.category, it.emoji, it.color, it.openNew, it.openMode, it.sortOrder || 0],
        );
        created++;
      }
      await c.queryObject(`COMMIT`);
    } catch (e) {
      await c.queryObject(`ROLLBACK`).catch(() => {});
      throw e;
    }
    return { created, skipped, total: valid.length };
  });
}

// ---------------- 好友关系 ----------------
interface FriendOut {
  id: number;
  username: string;
  avatar: string;
}
interface FriendRequestOut {
  id: number;
  userId: number;
  username: string;
  avatar: string;
}

// 发送好友请求（按用户名）。若对方已向我发过请求，则直接互为好友。
export async function sendFriendRequest(
  userId: number,
  friendUsername: string,
): Promise<{ id: number; username: string; status: string; requestId?: number }> {
  if (!validUsername(friendUsername)) throw new Error("用户名格式不正确");
  ensureDb();
  const fu = await query<{ id: number }>(`SELECT id FROM users WHERE username = $1`, [friendUsername]);
  if (!fu.length) throw new Error("用户不存在");
  const friendId = fu[0].id;
  if (friendId === userId) throw new Error("不能添加自己为好友");

  const exist = await query<{ id: number; status: string }>(
    `SELECT id, status FROM friendships WHERE user_id = $1 AND friend_id = $2`,
    [userId, friendId],
  );
  if (exist.length) {
    if (exist[0].status === "accepted") {
      // 已是好友：幂等返回，不报错（前端重复点击时友好）
      return { id: friendId, username: friendUsername, status: "accepted" };
    }
    // 已有 pending 请求：幂等返回，不报错（避免重复点击报 400）
    return { id: friendId, username: friendUsername, status: "pending", requestId: exist[0].id };
  }

  // 对方已向我发过请求 -> 直接通过，互为好友
  const rev = await query<{ id: number }>(
    `SELECT id FROM friendships WHERE user_id = $2 AND friend_id = $1 AND status = 'pending'`,
    [userId, friendId],
  );
  if (rev.length) {
    await query(`UPDATE friendships SET status = 'accepted' WHERE id = $1`, [rev[0].id]);
    return { id: friendId, username: friendUsername, status: "accepted" };
  }

  const rows = await query<{ id: number }>(
    `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
    [userId, friendId],
  );
  // id 保留为「对方 userId」（用于实时推送目标）；requestId 才是好友请求行 id（供前端引用）
  return { id: friendId, username: friendUsername, status: "pending", requestId: rows[0].id };
}

// 已通过的好友列表（双向）
export async function listFriends(userId: number): Promise<FriendOut[]> {
  ensureDb();
  const rows = await query<FriendOut>(
    `SELECT u.id, u.username, u.avatar AS "avatar" FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
     WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
     ORDER BY u.username`,
    [userId],
  );
  return rows;
}

// 收到的待通过好友请求（我是被请求方）
export async function listFriendRequests(userId: number): Promise<FriendRequestOut[]> {
  ensureDb();
  const rows = await query<FriendRequestOut>(
    `SELECT f.id, f.user_id AS "userId", u.username, u.avatar AS "avatar" FROM friendships f
     JOIN users u ON u.id = f.user_id
     WHERE f.friend_id = $1 AND f.status = 'pending'
     ORDER BY f.created_at DESC`,
    [userId],
  );
  return rows;
}

// 通过好友请求（仅被请求方可操作）
export async function acceptFriendRequest(userId: number, requestId: number): Promise<boolean> {
  ensureDb();
  const rows = await query<{ id: number }>(
    `UPDATE friendships SET status = 'accepted' WHERE id = $1 AND friend_id = $2 RETURNING id`,
    [requestId, userId],
  );
  return rows.length > 0;
}

// 取某条好友请求的发起方 userId（用于「通过」后实时通知对方）。
// 传 friendId 做权限校验，避免越权查询他人请求。
export async function getFriendRequestRequester(requestId: number, friendId: number): Promise<number | null> {
  ensureDb();
  const rows = await query<{ user_id: number }>(
    `SELECT user_id FROM friendships WHERE id = $1 AND friend_id = $2 AND status = 'accepted'`,
    [requestId, friendId],
  );
  return rows.length ? rows[0].user_id : null;
}

// 删除好友（双向都删）
export async function removeFriend(userId: number, friendId: number): Promise<boolean> {
  ensureDb();
  const rows = await query<{ id: number }>(
    `DELETE FROM friendships
     WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)
     RETURNING id`,
    [userId, friendId],
  );
  return rows.length > 0;
}

// 判断两人是否已是好友（用于聊天历史的访问控制）
export async function areFriends(a: number, b: number): Promise<boolean> {
  ensureDb();
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return false;
  const rows = await query<{ id: number }>(
    `SELECT id FROM friendships
     WHERE status = 'accepted'
       AND ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))
     LIMIT 1`,
    [a, b],
  );
  return rows.length > 0;
}

// ---------------- 群聊 ----------------
export interface GroupMemberOut {
  id: number;
  username: string;
  avatar: string;
}
export interface GroupOut {
  id: number;
  name: string;
  avatar: string;
  ownerId: number;
  members: GroupMemberOut[];
}

// 判断某用户是否为群成员（群消息收发 / 历史访问的权限校验）
export async function isGroupMember(groupId: number, userId: number): Promise<boolean> {
  ensureDb();
  const rows = await query<{ group_id: number }>(
    `SELECT group_id FROM group_members WHERE group_id = $1 AND user_id = $2 LIMIT 1`,
    [groupId, userId],
  );
  return rows.length > 0;
}

// 群的全部成员 userId（用于实时转发 / 通知）
export async function getGroupMemberIds(groupId: number): Promise<number[]> {
  ensureDb();
  const rows = await query<{ user_id: number }>(
    `SELECT user_id FROM group_members WHERE group_id = $1`,
    [groupId],
  );
  return rows.map((r) => r.user_id);
}

// 群基本信息
export async function getGroupBasic(groupId: number): Promise<{ id: number; name: string; avatar: string; ownerId: number } | null> {
  ensureDb();
  const rows = await query<{ id: number; name: string; avatar: string; owner_id: number }>(
    `SELECT id, name, avatar, owner_id FROM chat_groups WHERE id = $1`,
    [groupId],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { id: r.id, name: r.name, avatar: r.avatar, ownerId: r.owner_id };
}

// 修改群名称：仅群主可改，返回更新后的群基本信息
export async function renameGroup(
  groupId: number,
  ownerId: number,
  name: string,
): Promise<{ id: number; name: string; avatar: string; ownerId: number } | null> {
  ensureDb();
  const basic = await getGroupBasic(groupId);
  if (!basic) return null;
  if (basic.ownerId !== ownerId) throw new Error("只有群主可以修改群名称");
  const gname = String(name || "").trim().slice(0, 64);
  if (!gname) throw new Error("群名称不能为空");
  await query(`UPDATE chat_groups SET name = $1 WHERE id = $2`, [gname, groupId]);
  return { id: basic.id, name: gname, avatar: basic.avatar, ownerId: basic.ownerId };
}

// 加入群成员（幂等）
export async function addGroupMember(groupId: number, userId: number): Promise<void> {
  ensureDb();
  await query(
    `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)
     ON CONFLICT (group_id, user_id) DO NOTHING`,
    [groupId, userId],
  );
}

// 创建群聊：创建群 + 自动加入创建者 + 加入指定的初始成员；返回完整群信息
export async function createGroup(
  ownerId: number,
  name: string,
  avatar: string,
  memberIds: number[],
): Promise<GroupOut> {
  ensureDb();
  const gname = String(name || "").trim().slice(0, 64) || "群聊";
  const av = String(avatar || "").slice(0, ICON_MAX);
  return withClient(async (c: any) => {
    const g = await c.queryObject(
      `INSERT INTO chat_groups (name, owner_id, avatar) VALUES ($1, $2, $3)
       RETURNING id, name, avatar, owner_id AS "ownerId"`,
      [gname, ownerId, av],
    );
    const group = (g.rows as Array<{ id: number; name: string; avatar: string; owner_id: number }>)[0];
    await c.queryObject(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)
      ON CONFLICT DO NOTHING`, [group.id, ownerId]);
    for (const mid of memberIds) {
      if (Number.isFinite(mid) && mid !== ownerId) {
        await c.queryObject(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)
          ON CONFLICT DO NOTHING`, [group.id, mid]);
      }
    }
    const m = await c.queryObject(
      `SELECT u.id, u.username, u.avatar AS "avatar" FROM group_members gm
       JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1 ORDER BY u.username`,
      [group.id],
    );
    return { id: group.id, name: group.name, avatar: group.avatar, ownerId: group.owner_id, members: m.rows as GroupMemberOut[] };
  });
}

// 列出某用户加入的全部群（含成员列表）
export async function listUserGroups(userId: number): Promise<GroupOut[]> {
  ensureDb();
  const rows = await query<{
    id: number; name: string; avatar: string; ownerId: number;
    members: GroupMemberOut[];
  }>(
    `SELECT g.id, g.name, g.avatar, g.owner_id AS "ownerId",
       COALESCE(
         (SELECT json_agg(json_build_object('id', u.id, 'username', u.username, 'avatar', u.avatar)
                          ORDER BY u.username)
          FROM group_members gm2 JOIN users u ON u.id = gm2.user_id WHERE gm2.group_id = g.id),
         '[]'::json
       ) AS members
     FROM chat_groups g
     WHERE g.id IN (SELECT group_id FROM group_members WHERE user_id = $1)
     ORDER BY g.created_at DESC`,
    [userId],
  );
  return rows;
}

// 退出群聊：群主退出则解散群（级联删除成员）；普通成员仅移除自己
export async function leaveGroup(groupId: number, userId: number): Promise<{ disbanded: boolean }> {
  ensureDb();
  const basic = await getGroupBasic(groupId);
  if (!basic) return { disbanded: false };
  if (basic.ownerId === userId) {
    await query(`DELETE FROM chat_groups WHERE id = $1`, [groupId]); // 级联删除 group_members
    return { disbanded: true };
  }
  await query(
    `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [groupId, userId],
  );
  return { disbanded: false };
}
