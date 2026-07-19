// api.ts —— 认证与链接 CRUD 路由处理（基于本地可靠存储 store.ts）
import {
  registerUser, findUserByUsername, verifyPassword, createSession,
  getUserByToken, deleteSession, listLinks, createLink, updateLink, deleteLink,
} from "./store.ts";
import { getWsPublicUrl } from "./signaling.ts";

interface User { id: number; username: string; }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    },
  });
}

function getBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

function requireUser(req: Request): User | null {
  const token = getBearer(req);
  if (!token) return null;
  return getUserByToken(token);
}

export async function handleApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // 预检请求（跨源携带 Authorization 头会触发浏览器 OPTIONS 预检）
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      },
    });
  }

  try {
    // ---- 注册 ----
    if (path === "/api/register" && method === "POST") {
      const { username, password } = await req.json();
      let user: User;
      try {
        user = await registerUser(String(username), String(password));
      } catch (e) {
        const msg = (e as Error).message;
        const status = /已存在/.test(msg) ? 409 : 400;
        return json({ error: msg }, status);
      }
      const token = await createSession(user.id);
      return json({ user: { id: user.id, username: user.username }, token }, 201);
    }

    // ---- 登录 ----
    if (path === "/api/login" && method === "POST") {
      const { username, password } = await req.json();
      const u = findUserByUsername(String(username));
      if (!u) return json({ error: "用户名或密码错误" }, 401);
      const ok = await verifyPassword(String(password), u.password_hash);
      if (!ok) return json({ error: "用户名或密码错误" }, 401);
      const token = await createSession(u.id);
      return json({ user: { id: u.id, username: u.username }, token });
    }

    // ---- 登出 ----
    if (path === "/api/logout" && method === "POST") {
      const token = getBearer(req);
      if (token) await deleteSession(token);
      return json({ ok: true });
    }

    // ---- 当前用户 ----
    if (path === "/api/me" && method === "GET") {
      const user = requireUser(req);
      return json({ user: user ? { id: user.id, username: user.username } : null });
    }

    // ---- 信令服务地址（P2P 聊天用）----
    if (path === "/api/ws-info" && method === "GET") {
      return json({ wsUrl: getWsPublicUrl(req) });
    }

    // ---- 链接列表 ----
    if (path === "/api/links" && method === "GET") {
      const user = requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      return json({ links: listLinks(user.id) });
    }

    // ---- 新建链接 ----
    if (path === "/api/links" && method === "POST") {
      const user = requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json();
      const name = String(b.name ?? "").trim();
      let u = String(b.url ?? "").trim();
      if (!name || !u) return json({ error: "名称和网址必填" }, 400);
      if (!/^https?:\/\//i.test(u)) u = "https://" + u;
      const link = await createLink(user.id, {
        name,
        url: u,
        category: String(b.category ?? "未分类").trim(),
        emoji: String(b.emoji ?? "").trim(),
        color: String(b.color ?? "#4f6ef7"),
        openNew: b.openNew !== false,
      });
      return json({ link }, 201);
    }

    // ---- 更新 / 删除单条 ----
    const m = path.match(/^\/api\/links\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const user = requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);

      if (method === "PUT") {
        const b = await req.json();
        const link = await updateLink(user.id, id, {
          name: b.name, url: b.url, category: b.category,
          emoji: b.emoji, color: b.color, openNew: b.openNew,
        });
        if (!link) return json({ error: "链接不存在" }, 404);
        return json({ link });
      }
      if (method === "DELETE") {
        const removed = await deleteLink(user.id, id);
        if (!removed) return json({ error: "链接不存在" }, 404);
        return json({ ok: true });
      }
    }

    return json({ error: "Not Found" }, 404);
  } catch (e) {
    console.error("API error:", (e as Error).message);
    return json({ error: "服务器错误" }, 500);
  }
}
