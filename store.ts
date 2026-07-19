// store.ts
// 本地可靠存储（JSON 文件，纯 JS，零原生依赖）。
// 为什么需要它：Prisma 池化连接(db.prisma.io)在当前运行环境极不稳定
// （约 50% 几率 TLS 握手超时），导致登录/查询随机 500。
// 因此应用默认使用本地文件存储，100% 可用；并在启动时“尽力”从
// PostgreSQL 导入已有的账号与链接，避免数据丢失。
// 当你在稳定网络或部署到 Deno Deploy（网络可达 Prisma）时，可改回纯 Postgres。

import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const DATA_FILE = "./data.json";
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;

// ---------------- 内存数据 ----------------
interface LocalUser {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}
interface LocalLink {
  id: number;
  user_id: number;
  name: string;
  url: string;
  category: string;
  emoji: string;
  color: string;
  openNew: boolean;
  createdAt: number;
}
interface LocalSession {
  token: string;
  user_id: number;
  expires_at: string; // ISO
}

let users: LocalUser[] = [];
let links: LocalLink[] = [];
let sessions: LocalSession[] = [];
let nextUserId = 1;
let nextLinkId = 1;

// 写文件互斥，避免并发写损坏
let writeChain: Promise<void> = Promise.resolve();
function persist(): Promise<void> {
  const snapshot = JSON.stringify({ users, links, sessions }, null, 2);
  const run = writeChain.then(() => Deno.writeTextFile(DATA_FILE, snapshot));
  writeChain = run.catch(() => {});
  return run;
}

// ---------------- 密码哈希（与旧 Postgres 版本格式兼容 pbkdf2$iter$saltB64$keyB64）----------------
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

// ---------------- 初始化 / 导入 ----------------
function reloadIds() {
  nextUserId = users.reduce((m, u) => Math.max(m, u.id), 0) + 1;
  nextLinkId = links.reduce((m, l) => Math.max(m, l.id), 0) + 1;
}

export async function initStore(): Promise<void> {
  // 读取本地文件
  try {
    const txt = await Deno.readTextFile(DATA_FILE);
    const data = JSON.parse(txt);
    users = data.users ?? [];
    links = data.links ?? [];
    sessions = data.sessions ?? [];
    reloadIds();
    console.error(`[store] 已加载本地数据：${users.length} 用户 / ${links.length} 链接`);
  } catch {
    console.error("[store] 无本地数据，初始化空存储");
    users = []; links = []; sessions = [];
    reloadIds();
  }
  // 尽力从 PostgreSQL 导入已有账号与链接（失败不影响本地运行）
  await importFromPostgres().catch((e) =>
    console.error("[store] PostgreSQL 导入跳过（连接不稳定，已忽略）：", (e as Error).message)
  );
}

async function importFromPostgres(): Promise<void> {
  const rawUrl = Deno.env.get("DATABASE_URL");
  if (!rawUrl) return;
  const parsed = new URL(rawUrl.split("?")[0]);
  const dbName = parsed.pathname.replace(/^\//, "") || "postgres";
  const client = new Client({
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    hostname: parsed.hostname,
    port: Number(parsed.port) || 5432,
    database: dbName,
    tls: { enabled: true },
  });
  // 5s 握手超时，连不上就放弃（本地存储照常工作）
  await Promise.race([
    client.connect(),
    new Promise((_, r) => setTimeout(() => r(new Error("PostgreSQL 连接超时")), 5000)),
  ]);

  const pgUsers = await client.queryObject<{ id: number; username: string; password_hash: string }>(
    "SELECT id, username, password_hash FROM users"
  );
  const pgLinks = await client.queryObject<{
    id: number; user_id: number; title: string; url: string;
    category: string; icon: string; color: string; open_new: boolean; created_at: string;
  }>("SELECT id, user_id, title, url, category, icon, color, open_new, created_at FROM links");

  let importedUsers = 0, importedLinks = 0;
  const idMap = new Map<number, number>();
  for (const u of pgUsers.rows) {
    if (users.some((x) => x.username === u.username)) continue;
    const localId = nextUserId++;
    idMap.set(u.id, localId);
    users.push({ id: localId, username: u.username, password_hash: u.password_hash, created_at: new Date().toISOString() });
    importedUsers++;
  }
  for (const l of pgLinks.rows) {
    const localUserId = idMap.get(l.user_id);
    if (!localUserId) continue; // 仅导入已导入用户拥有的链接
    links.push({
      id: nextLinkId++,
      user_id: localUserId,
      name: l.title,
      url: l.url,
      category: l.category || "未分类",
      emoji: l.icon || "",
      color: l.color || "#4f6ef7",
      openNew: l.open_new !== false,
      createdAt: l.created_at ? new Date(l.created_at).getTime() : Date.now(),
    });
    importedLinks++;
  }
  await client.end().catch(() => {});
  if (importedUsers || importedLinks) {
    await persist();
    console.error(`[store] 已从 PostgreSQL 导入 ${importedUsers} 用户 / ${importedLinks} 链接`);
  }
}

// ---------------- 用户 ----------------
function validUsername(u: string): boolean {
  return /^[a-zA-Z0-9_\-]{3,32}$/.test(u);
}

export async function registerUser(username: string, password: string): Promise<LocalUser> {
  if (!validUsername(username)) throw new Error("用户名需为 3-32 位字母/数字/下划线/连字符");
  if (password.length < 6) throw new Error("密码至少 6 位");
  if (users.some((u) => u.username === username)) throw new Error("用户名已存在");
  const hash = await hashPassword(password);
  const user: LocalUser = { id: nextUserId++, username, password_hash: hash, created_at: new Date().toISOString() };
  users.push(user);
  await persist();
  return user;
}

export function findUserByUsername(username: string): LocalUser | null {
  return users.find((u) => u.username === username) ?? null;
}

// ---------------- 会话 ----------------
export async function createSession(userId: number): Promise<string> {
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_MS);
  sessions.push({ token, user_id: userId, expires_at: expires.toISOString() });
  await persist();
  return token;
}
export function getUserByToken(token: string): { id: number; username: string } | null {
  const s = sessions.find((x) => x.token === token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    sessions = sessions.filter((x) => x.token !== token);
    persist();
    return null;
  }
  const u = users.find((x) => x.id === s.user_id);
  return u ? { id: u.id, username: u.username } : null;
}
export async function deleteSession(token: string): Promise<void> {
  sessions = sessions.filter((x) => x.token !== token);
  await persist();
}

// ---------------- 链接 ----------------
function toLinkShape(l: LocalLink) {
  return {
    id: l.id,
    name: l.name,
    url: l.url,
    category: l.category,
    emoji: l.emoji,
    color: l.color,
    openNew: l.openNew,
    createdAt: l.createdAt,
  };
}

export function listLinks(userId: number): unknown[] {
  return links.filter((l) => l.user_id === userId).sort((a, b) => b.createdAt - a.createdAt).map(toLinkShape);
}

export async function createLink(
  userId: number,
  data: { name: string; url: string; category: string; emoji: string; color: string; openNew: boolean },
): Promise<unknown> {
  const link: LocalLink = {
    id: nextLinkId++,
    user_id: userId,
    name: data.name,
    url: data.url,
    category: data.category || "未分类",
    emoji: data.emoji || "",
    color: data.color || "#4f6ef7",
    openNew: data.openNew !== false,
    createdAt: Date.now(),
  };
  links.push(link);
  await persist();
  return toLinkShape(link);
}

export async function updateLink(
  userId: number,
  id: number,
  fields: Record<string, unknown>,
): Promise<unknown | null> {
  const link = links.find((l) => l.id === id && l.user_id === userId);
  if (!link) return null;
  if (fields.name != null) link.name = String(fields.name);
  if (fields.url != null) link.url = String(fields.url);
  if (fields.category != null) link.category = String(fields.category) || "未分类";
  if (fields.emoji != null) link.emoji = String(fields.emoji);
  if (fields.color != null) link.color = String(fields.color);
  if (fields.openNew != null) link.openNew = Boolean(fields.openNew);
  await persist();
  return toLinkShape(link);
}

export async function deleteLink(userId: number, id: number): Promise<boolean> {
  const before = links.length;
  links = links.filter((l) => !(l.id === id && l.user_id === userId));
  const removed = links.length < before;
  if (removed) await persist();
  return removed;
}
