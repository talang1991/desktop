// api.ts —— 认证与链接 CRUD 路由处理
import { query, hashPassword, verifyPassword, newSessionToken } from "./db.ts";

const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 3600;

interface User {
  id: number;
  username: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function setCookie(res: Response, token: string | null) {
  const value = token
    ? `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}`
    : `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  res.headers.append("set-cookie", value);
}

function getCookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie");
  if (!h) return null;
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

async function requireUser(req: Request): Promise<User | null> {
  const token = getCookie(req, "sid");
  if (!token) return null;
  const rows = await query<{
    user_id: number;
    username: string;
    expires_at: string;
  }>(
    "SELECT s.user_id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1",
    [token],
  );
  if (!rows.length) return null;
  if (new Date(rows[0].expires_at).getTime() < Date.now()) return null;
  return { id: rows[0].user_id, username: rows[0].username };
}

async function startSession(userId: number): Promise<string> {
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_SECONDS * 1000);
  await query(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)",
    [token, userId, expires.toISOString()],
  );
  return token;
}

function normalize(r: Record<string, unknown>) {
  return {
    id: r.id,
    name: r.title,
    url: r.url,
    category: r.category,
    emoji: r.icon,
    color: r.color,
    openNew: r.open_new,
    createdAt: r.created_at ? new Date(String(r.created_at)).getTime() : Date.now(),
  };
}

function validUsername(u: string): boolean {
  return /^[a-zA-Z0-9_\-]{3,32}$/.test(u);
}

export async function handleApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    // ---- 注册 ----
    if (path === "/api/register" && method === "POST") {
      const { username, password } = await req.json();
      if (!validUsername(String(username))) {
        return json({ error: "用户名需为 3-32 位字母/数字/下划线/连字符" }, 400);
      }
      if (String(password).length < 6) {
        return json({ error: "密码至少 6 位" }, 400);
      }
      const exist = await query("SELECT id FROM users WHERE username=$1", [username]);
      if (exist.length) return json({ error: "用户名已存在" }, 409);
      const hash = await hashPassword(String(password));
      const ins = await query<{ id: number; username: string }>(
        "INSERT INTO users (username, password_hash) VALUES ($1,$2) RETURNING id, username",
        [username, hash],
      );
      const token = await startSession(ins[0].id);
      const res = json({ user: { id: ins[0].id, username: ins[0].username } }, 201);
      setCookie(res, token);
      return res;
    }

    // ---- 登录 ----
    if (path === "/api/login" && method === "POST") {
      const { username, password } = await req.json();
      const rows = await query<{ id: number; username: string; password_hash: string }>(
        "SELECT id, username, password_hash FROM users WHERE username=$1",
        [username],
      );
      if (!rows.length) return json({ error: "用户名或密码错误" }, 401);
      const ok = await verifyPassword(String(password), rows[0].password_hash);
      if (!ok) return json({ error: "用户名或密码错误" }, 401);
      const token = await startSession(rows[0].id);
      const res = json({ user: { id: rows[0].id, username: rows[0].username } });
      setCookie(res, token);
      return res;
    }

    // ---- 登出 ----
    if (path === "/api/logout" && method === "POST") {
      const token = getCookie(req, "sid");
      if (token) await query("DELETE FROM sessions WHERE token=$1", [token]);
      const res = json({ ok: true });
      setCookie(res, null);
      return res;
    }

    // ---- 当前用户 ----
    if (path === "/api/me" && method === "GET") {
      const user = await requireUser(req);
      return json({ user: user ? { id: user.id, username: user.username } : null });
    }

    // ---- 链接列表 ----
    if (path === "/api/links" && method === "GET") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const rows = await query(
        "SELECT id, title, url, category, icon, color, open_new, created_at FROM links WHERE user_id=$1 ORDER BY created_at DESC",
        [user.id],
      );
      return json({ links: rows.map(normalize) });
    }

    // ---- 新建链接 ----
    if (path === "/api/links" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json();
      const name = String(b.name ?? b.title ?? "").trim();
      let u = String(b.url ?? "").trim();
      const category = String(b.category ?? "未分类").trim() || "未分类";
      const emoji = String(b.emoji ?? b.icon ?? "").trim();
      const color = String(b.color ?? "#4f6ef7");
      const openNew = b.openNew !== false;
      if (!name || !u) return json({ error: "名称和网址必填" }, 400);
      if (!/^https?:\/\//i.test(u)) u = "https://" + u;
      const ins = await query(
        "INSERT INTO links (user_id, title, url, category, icon, color, open_new) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, title, url, category, icon, color, open_new, created_at",
        [user.id, name, u, category, emoji, color, openNew],
      );
      return json({ link: normalize(ins[0] as Record<string, unknown>) }, 201);
    }

    // ---- 更新 / 删除单条 ----
    const m = path.match(/^\/api\/links\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);

      if (method === "PUT") {
        const b = await req.json();
        const sets: string[] = [];
        const params: unknown[] = [];
        let i = 1;
        if (b.name != null || b.title != null) {
          sets.push(`title=$${i++}`);
          params.push(String(b.name ?? b.title).trim());
        }
        if (b.url != null) {
          let v = String(b.url);
          if (!/^https?:\/\//i.test(v)) v = "https://" + v;
          sets.push(`url=$${i++}`);
          params.push(v);
        }
        if (b.category != null) {
          sets.push(`category=$${i++}`);
          params.push(String(b.category).trim() || "未分类");
        }
        if (b.emoji != null || b.icon != null) {
          sets.push(`icon=$${i++}`);
          params.push(String(b.emoji ?? b.icon).trim());
        }
        if (b.color != null) {
          sets.push(`color=$${i++}`);
          params.push(String(b.color));
        }
        if (b.openNew != null) {
          sets.push(`open_new=$${i++}`);
          params.push(Boolean(b.openNew));
        }
        if (sets.length === 0) return json({ error: "没有可更新的字段" }, 400);
        params.push(user.id);
        const pUser = i++;
        params.push(id);
        const pId = i++;
        await query(
          `UPDATE links SET ${sets.join(", ")} WHERE id=$${pUser} AND user_id=$${pId}`,
          params,
        );
        const upd = await query(
          "SELECT id, title, url, category, icon, color, open_new, created_at FROM links WHERE id=$1 AND user_id=$2",
          [id, user.id],
        );
        if (!upd.length) return json({ error: "链接不存在" }, 404);
        return json({ link: normalize(upd[0] as Record<string, unknown>) });
      }

      if (method === "DELETE") {
        await query("DELETE FROM links WHERE id=$1 AND user_id=$2", [id, user.id]);
        return json({ ok: true });
      }
    }

    return json({ error: "Not Found" }, 404);
  } catch (e) {
    console.error("API error:", (e as Error).message);
    return json({ error: "服务器错误" }, 500);
  }
}
