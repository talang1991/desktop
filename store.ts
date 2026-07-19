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
  created_at: string;
}
interface LinkRow {
  id: number;
  user_id: number;
  name: string;
  url: string;
  category: string;
  emoji: string;
  color: string;
  open_new: boolean;
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

// 连接池执行：成功自动释放；连接失败抛 DbUnavailableError（api 返回 503）
async function withClient<T>(fn: (c: any) => Promise<T>): Promise<T> {
  if (!pool) throw new DbUnavailableError();
  let client: any;
  try {
    client = await pool.connect();
  } catch (e) {
    throw new DbUnavailableError("数据库连接失败：" + (e as Error).message);
  }
  try {
    return await fn(client);
  } finally {
    client.release();
  }
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
    for (let attempt = 1; attempt <= 6 && !schemaOk; attempt++) {
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
          `INSERT INTO links (id, user_id, name, url, category, emoji, color, open_new, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO NOTHING`,
          [
            l.id, l.user_id, l.name, l.url,
            l.category ?? "未分类", l.emoji ?? "", l.color ?? "#4f6ef7",
            l.openNew !== false, new Date(l.createdAt ?? Date.now()).toISOString(),
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
  const rows = await query<{ id: number; username: string }>(
    `INSERT INTO users (username, password_hash, avatar) VALUES ($1,$2,$3) RETURNING id, username`,
    [username, hash, av],
  );
  return { id: rows[0].id, username: rows[0].username, password_hash: hash, avatar: av, created_at: new Date().toISOString() };
}

export async function findUserByUsername(username: string): Promise<StoredUser | null> {
  ensureDb();
  const rows = await query<StoredUser>(
    `SELECT id, username, password_hash, avatar, created_at FROM users WHERE username = $1`,
    [username],
  );
  return rows[0] ?? null;
}

// ---------------- 会话 ----------------
export async function createSession(userId: number): Promise<string> {
  ensureDb();
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_MS);
  await query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`,
    [token, userId, expires.toISOString()],
  );
  return token;
}

export async function getUserByToken(token: string): Promise<{ id: number; username: string; avatar: string } | null> {
  ensureDb();
  const rows = await query<{ id: number; username: string; avatar: string; expires_at: string }>(
    `SELECT u.id, u.username, u.avatar, s.expires_at FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = $1`,
    [token],
  );
  const r = rows[0];
  if (!r) return null;
  if (new Date(r.expires_at).getTime() < Date.now()) {
    await query(`DELETE FROM sessions WHERE token = $1`, [token]).catch(() => {});
    return null;
  }
  return { id: r.id, username: r.username, avatar: r.avatar };
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

export async function deleteSession(token: string): Promise<void> {
  ensureDb();
  await query(`DELETE FROM sessions WHERE token = $1`, [token]).catch(() => {});
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
    createdAt: new Date(l.created_at).getTime(),
  };
}

export async function listLinks(userId: number): Promise<unknown[]> {
  ensureDb();
  const rows = await query<LinkRow>(
    `SELECT id, user_id, title AS name, url, category, icon AS emoji, color, open_new, created_at
     FROM links WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(toLinkShape);
}

const ICON_MAX = 2048; // 图标字段可存 emoji 或 favicon 链接，限制长度避免撑爆 DB

export async function createLink(
  userId: number,
  data: { name: string; url: string; category: string; emoji: string; color: string; openNew: boolean },
): Promise<unknown> {
  ensureDb();
  const icon = String(data.emoji || "").slice(0, ICON_MAX);
  const rows = await query<LinkRow>(
    `INSERT INTO links (user_id, title, url, category, icon, color, open_new, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, user_id, title AS name, url, category, icon AS emoji, color, open_new, created_at`,
    [
      userId, data.name, data.url,
      data.category || "未分类", icon, data.color || "#4f6ef7",
      data.openNew !== false, 0,
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
  const SEL = `id, user_id, title AS name, url, category, icon AS emoji, color, open_new, created_at`;
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
): Promise<{ id: number; username: string; status: string }> {
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
    if (exist[0].status === "accepted") throw new Error("你们已经是好友了");
    throw new Error("好友请求已发送，等待对方通过");
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
  return { id: friendId, username: friendUsername, status: "pending" };
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
