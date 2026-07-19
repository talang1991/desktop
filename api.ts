// api.ts —— 认证与链接 CRUD 路由处理（基于本地可靠存储 store.ts）
import {
  registerUser, findUserByUsername, verifyPassword, createSession,
  getUserByToken, deleteSession, listLinks, createLink, updateLink, deleteLink,
  sendFriendRequest, listFriends, listFriendRequests, acceptFriendRequest, removeFriend,
  updateUserAvatar,
  DbUnavailableError,
} from "./store.ts";
import { getWsPublicUrl, getIceServers, isOnline } from "./signaling.ts";

interface User { id: number; username: string; avatar: string; }

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

function requireUser(req: Request): Promise<User | null> {
  const token = getBearer(req);
  if (!token) return Promise.resolve(null);
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
      const { username, password, avatar } = await req.json();
      let user: User;
      try {
        user = await registerUser(String(username), String(password), avatar ? String(avatar) : "");
      } catch (e) {
        const msg = (e as Error).message;
        const status = /已存在/.test(msg) ? 409 : 400;
        return json({ error: msg }, status);
      }
      const token = await createSession(user.id);
      return json({ user: { id: user.id, username: user.username, avatar: user.avatar }, token }, 201);
    }

    // ---- 登录 ----
    if (path === "/api/login" && method === "POST") {
      const { username, password } = await req.json();
      const u = await findUserByUsername(String(username));
      if (!u) return json({ error: "用户名或密码错误" }, 401);
      const ok = await verifyPassword(String(password), u.password_hash);
      if (!ok) return json({ error: "用户名或密码错误" }, 401);
      const token = await createSession(u.id);
      return json({ user: { id: u.id, username: u.username, avatar: u.avatar }, token });
    }

    // ---- 登出 ----
    if (path === "/api/logout" && method === "POST") {
      const token = getBearer(req);
      if (token) await deleteSession(token);
      return json({ ok: true });
    }

    // ---- 当前用户 ----
    if (path === "/api/me" && method === "GET") {
      const user = await requireUser(req);
      return json({ user: user ? { id: user.id, username: user.username, avatar: user.avatar } : null });
    }

    // ---- 更新当前用户资料（头像）----
    if (path === "/api/me" && method === "PUT") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json();
      await updateUserAvatar(user.id, String(b.avatar ?? "").slice(0, 2048));
      return json({ user: { id: user.id, username: user.username, avatar: String(b.avatar ?? "") } });
    }

    // ---- 信令服务地址 + ICE 配置（P2P 聊天用）----
    if (path === "/api/ws-info" && method === "GET") {
      return json({ wsUrl: getWsPublicUrl(req), iceServers: getIceServers() });
    }

    // ---- 好友：发送好友请求（按用户名）----
    if (path === "/api/friends" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json();
      try {
        const r = await sendFriendRequest(user.id, String(b.username ?? "").trim());
        return json({ friend: r }, r.status === "accepted" ? 200 : 201);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    // ---- 好友：列表（含在线状态）+ 待通过请求 ----
    if (path === "/api/friends" && method === "GET") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const friends = (await listFriends(user.id)).map((f) => ({ ...f, online: isOnline(f.id) }));
      const requests = await listFriendRequests(user.id);
      return json({ friends, requests });
    }

    // ---- 好友：通过请求 ----
    if (path === "/api/friends/accept" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json();
      const ok = await acceptFriendRequest(user.id, Number(b.requestId));
      if (!ok) return json({ error: "请求不存在或已处理" }, 404);
      return json({ ok: true });
    }

    // ---- 链接列表 ----
    if (path === "/api/links" && method === "GET") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      return json({ links: await listLinks(user.id) });
    }

    // ---- 新建链接 ----
    if (path === "/api/links" && method === "POST") {
      const user = await requireUser(req);
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

    // ---- 好友：删除（移除好友关系）----
    const fm = path.match(/^\/api\/friends\/(\d+)$/);
    if (fm) {
      const id = Number(fm[1]);
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      if (method === "DELETE") {
        const ok = await removeFriend(user.id, id);
        if (!ok) return json({ error: "好友关系不存在" }, 404);
        return json({ ok: true });
      }
    }

    // ---- 更新 / 删除单条 ----
    const m = path.match(/^\/api\/links\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const user = await requireUser(req);
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
    if (e instanceof DbUnavailableError) {
      return json({ error: "数据库暂时不可用，请稍后重试" }, 503);
    }
    console.error("API error:", (e as Error).message);
    return json({ error: "服务器错误" }, 500);
  }
}
