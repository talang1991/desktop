// api.ts —— 认证与链接 CRUD 路由处理（基于本地可靠存储 store.ts）
import {
  registerUser, findUserByUsername, verifyPassword, createSession,
  getUserByToken, deleteSession, listSessions, deleteOtherSessions, revokeSession,
  listLinks, createLink, updateLink, deleteLink,
  bulkImportLinks,
  sendFriendRequest, listFriends, listFriendRequests, acceptFriendRequest, getFriendRequestRequester, removeFriend,
  updateUserAvatar, updateUserUsername, areFriends,
  createGroup, addGroupMember, listUserGroups, getGroupBasic, isGroupMember, leaveGroup,
  renameGroup, getGroupMemberIds,
  listAllUsers, updateUserRole, countUsers, countLinks, recentRegistrations,
  createApp, listApprovedApps, listMyApps, listAllApps, approveApp, rejectApp, deleteApp, updateApp, countPendingApps,
  DbUnavailableError,
} from "./store.ts";

// 归一化设备类型：仅允许 mobile/tablet/desktop，其它一律 desktop
function normalizeDevice(d: unknown): string {
  const v = String(d || "").toLowerCase();
  if (v === "mobile" || v === "tablet" || v === "desktop") return v;
  return "desktop";
}
// 仅接受 http(s) 链接（应用广场的 url / icon 校验用）
function isHttpUrl(s: unknown): boolean {
  try {
    const u = new URL(String(s || ""));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
import { getWsPublicUrl, getIceServers, isOnline, pushToUser } from "./signaling.ts";
import { saveMessage, getMessages, saveGroupMessage, getGroupMessages, chatKvReady, saveReadCursor, getReadCursor } from "./chatstore.ts";

interface User { id: number; username: string; avatar: string; role: string; }

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

// 仅管理员可访问：返回当前用户（含 role）；非 admin 或已登录返回 null（调用方据此返回 403）
function requireAdmin(req: Request): Promise<User | null> {
  return requireUser(req).then((u) => (u && u.role === "admin" ? u : null));
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
      const { username, password, avatar, device } = await req.json();
      let user: User;
      try {
        user = await registerUser(String(username), String(password), avatar ? String(avatar) : "");
      } catch (e) {
        const msg = (e as Error).message;
        const status = /已存在/.test(msg) ? 409 : 400;
        return json({ error: msg }, status);
      }
      const token = await createSession(user.id, normalizeDevice(device), String(req.headers.get("user-agent") || ""));
      return json({ user: { id: user.id, username: user.username, avatar: user.avatar, role: user.role }, token }, 201);
    }

    // ---- 登录 ----
    if (path === "/api/login" && method === "POST") {
      const { username, password, device } = await req.json();
      const u = await findUserByUsername(String(username));
      if (!u) return json({ error: "用户名或密码错误" }, 401);
      const ok = await verifyPassword(String(password), u.password_hash);
      if (!ok) return json({ error: "用户名或密码错误" }, 401);
      const token = await createSession(u.id, normalizeDevice(device), String(req.headers.get("user-agent") || ""));
      return json({ user: { id: u.id, username: u.username, avatar: u.avatar, role: u.role }, token });
    }

    // ---- 登出 ----
    if (path === "/api/logout" && method === "POST") {
      const token = getBearer(req);
      if (token) await deleteSession(token);
      return json({ ok: true });
    }

    // ---- 当前用户 ----
    if (path === "/api/me" && method === "GET") {
      // getUserByToken 内部已在同一连接上刷新 last_active（见 store.ts）
      const user = await requireUser(req);
      return json({ user: user ? { id: user.id, username: user.username, avatar: user.avatar, role: user.role } : null });
    }

    // ---- 更新当前用户资料（头像 / 昵称）----
    if (path === "/api/me" && method === "PUT") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json();
      let avatar = user.avatar;
      let username = user.username;
      if (typeof b.avatar === "string") {
        avatar = String(b.avatar).slice(0, 2048);
        await updateUserAvatar(user.id, avatar);
      }
      if (typeof b.username === "string" && b.username.trim()) {
        const r = await updateUserUsername(user.id, b.username);
        if (!r.ok) return json({ error: r.error || "昵称保存失败" }, 400);
        username = r.username ?? username;
      }
      return json({ user: { id: user.id, username, avatar } });
    }

    // ---- 管理后台：用户列表（仅管理员）----
    if (path === "/api/admin/users" && method === "GET") {
      const admin = await requireAdmin(req);
      if (!admin) return json({ error: "无权访问" }, 403);
      const users = await listAllUsers();
      return json({ users });
    }

    // ---- 管理后台：修改用户角色（仅管理员；禁止取消自己的管理员角色以免锁死）----
    const adm = path.match(/^\/api\/admin\/users\/(\d+)$/);
    if (adm && method === "PATCH") {
      const admin = await requireAdmin(req);
      if (!admin) return json({ error: "无权访问" }, 403);
      const id = Number(adm[1]);
      const b = await req.json().catch(() => ({}));
      const role = String(b.role || "");
      if (role !== "user" && role !== "admin") return json({ error: "无效的角色" }, 400);
      if (id === admin.id && role !== "admin") {
        return json({ error: "不能取消自己的管理员角色" }, 400);
      }
      const ok = await updateUserRole(id, role);
      if (!ok) return json({ error: "用户不存在" }, 404);
      return json({ ok: true });
    }

    // ---- 管理后台：全局统计（仅管理员）----
    if (path === "/api/admin/stats" && method === "GET") {
      const admin = await requireAdmin(req);
      if (!admin) return json({ error: "无权访问" }, 403);
      const [users, links, recentUsers] = await Promise.all([
        countUsers(),
        countLinks(),
        recentRegistrations(7),
      ]);
      return json({ stats: { users, links, recentUsers } });
    }

    // ---- 应用广场：公开列表（已上架；支持 china / pwa 过滤；无需登录）----
    if (path === "/api/apps" && method === "GET") {
      const china = url.searchParams.get("china") === "1";
      const pwa = url.searchParams.get("pwa") === "1";
      const apps = await listApprovedApps({ china, pwa });
      return json({ apps });
    }

    // ---- 应用广场：发布应用（需登录）----
    if (path === "/api/apps" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return json({ error: "请先登录" }, 401);
      const b = await req.json().catch(() => ({}));
      const name = String(b.name || "").trim();
      const rawUrl = String(b.url || "").trim();
      if (!name) return json({ error: "请填写应用名称" }, 400);
      if (name.length > 60) return json({ error: "应用名称过长（最多 60 字）" }, 400);
      if (!isHttpUrl(rawUrl)) return json({ error: "请填写合法的 http(s) 链接" }, 400);
      const description = String(b.description || "").slice(0, 500);
      const icon = String(b.icon || "").slice(0, 2048);
      const category = (String(b.category || "其它").trim() || "其它").slice(0, 20);
      const supports_china = b.supports_china === true || b.supports_china === "true";
      const supports_pwa = b.supports_pwa === true || b.supports_pwa === "true";
      const r = await createApp(user.id, { name, url: rawUrl, description, icon, category, supports_china, supports_pwa });
      return json({ id: r.id, status: "pending" }, 201);
    }

    // ---- 应用广场：我的发布（需登录）----
    if (path === "/api/apps/mine" && method === "GET") {
      const user = await requireUser(req);
      if (!user) return json({ error: "请先登录" }, 401);
      const apps = await listMyApps(user.id);
      return json({ apps });
    }

    // ---- 应用广场：修改 / 删除自己的应用（需登录）----
    const appRes = path.match(/^\/api\/apps\/(\d+)$/);
    if (appRes) {
      const user = await requireUser(req);
      if (!user) return json({ error: "请先登录" }, 401);
      const id = Number(appRes[1]);
      if (method === "DELETE") {
        const ok = await deleteApp(id, user.id);
        if (!ok) return json({ error: "应用不存在或无权删除" }, 404);
        return json({ ok: true });
      }
      if (method === "PUT") {
        // 修改自己的应用并重新提交审核：字段校验与发布一致；状态重置为 pending
        const b = await req.json().catch(() => ({}));
        const name = String(b.name || "").trim();
        const rawUrl = String(b.url || "").trim();
        if (!name) return json({ error: "请填写应用名称" }, 400);
        if (name.length > 60) return json({ error: "应用名称过长（最多 60 字）" }, 400);
        if (!isHttpUrl(rawUrl)) return json({ error: "请填写合法的 http(s) 链接" }, 400);
        const description = String(b.description || "").slice(0, 500);
        const icon = String(b.icon || "").slice(0, 2048);
        const category = (String(b.category || "其它").trim() || "其它").slice(0, 20);
        const supports_china = b.supports_china === true || b.supports_china === "true";
        const supports_pwa = b.supports_pwa === true || b.supports_pwa === "true";
        const ok = await updateApp(id, user.id, {
          name, url: rawUrl, description, icon, category, supports_china, supports_pwa,
        });
        if (!ok) return json({ error: "应用不存在或无权修改" }, 404);
        return json({ ok: true, status: "pending" });
      }
    }

    // ---- 管理后台：应用审核列表（仅管理员）----
    if (path === "/api/admin/apps" && method === "GET") {
      const admin = await requireAdmin(req);
      if (!admin) return json({ error: "无权访问" }, 403);
      const apps = await listAllApps();
      return json({ apps });
    }

    // ---- 管理后台：通过 / 拒绝应用（仅管理员）----
    const appAct = path.match(/^\/api\/admin\/apps\/(\d+)\/(approve|reject)$/);
    if (appAct && method === "POST") {
      const admin = await requireAdmin(req);
      if (!admin) return json({ error: "无权访问" }, 403);
      const id = Number(appAct[1]);
      let ok = false;
      if (appAct[2] === "approve") {
        ok = await approveApp(id, admin.id);
      } else {
        const b = await req.json().catch(() => ({}));
        ok = await rejectApp(id, admin.id, String(b.reason || "").slice(0, 200));
      }
      if (!ok) return json({ error: "应用不存在" }, 404);
      return json({ ok: true, status: appAct[2] === "approve" ? "approved" : "rejected" });
    }

    // ---- 登录设备管理：列出当前账号所有会话（多端登录）----
    if (path === "/api/sessions" && method === "GET") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const token = getBearer(req);
      const rows = await listSessions(user.id);
      // 标记当前会话，并尽量从 user_agent 推断更友好的设备标签
      const sessions = rows.map((s) => ({
        token: s.token,
        device: s.device,
        ua: s.user_agent,
        created_at: s.created_at,
        last_active: s.last_active,
        current: s.token === token,
      }));
      return json({ sessions });
    }

    // ---- 登录设备管理：撤销指定会话（踢出某台设备）----
    if (path === "/api/sessions/revoke" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json().catch(() => ({}));
      const tk = String(b?.token || "");
      if (!tk) return json({ error: "缺少会话 token" }, 400);
      const ok = await revokeSession(tk, user.id);
      if (!ok) return json({ error: "会话不存在或无权操作" }, 400);
      return json({ ok: true });
    }

    // ---- 登录设备管理：登出除当前设备外的所有其他会话 ----
    if (path === "/api/sessions/logout-others" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const token = getBearer(req);
      if (!token) return json({ error: "未登录" }, 401);
      const n = await deleteOtherSessions(user.id, token);
      return json({ ok: true, revoked: n });
    }

    // ---- 信令服务地址 + ICE 配置（P2P 聊天用）----
    if (path === "/api/ws-info" && method === "GET") {
      return json({ wsUrl: getWsPublicUrl(req), iceServers: getIceServers(req) });
    }

    // ---- 聊天历史：客户端补推（落服务端 Deno KV，保留 3 个月）----
    // 每条消息本地已写 IndexedDB；此处把本地产生/收到的消息同步给服务端，
    // 以便换设备或本地缺失时能从服务端取回。仅好友之间可存。
    if (path === "/api/messages" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json().catch(() => ({}));
      const to = Number(b.to);
      if (!to) return json({ error: "缺少接收方" }, 400);
      if (!(await areFriends(user.id, to))) return json({ error: "只能与好友聊天" }, 403);
      const msgs = Array.isArray(b.messages) ? b.messages : [];
      let count = 0;
      for (const mm of msgs.slice(0, 200)) {
        const text = String(mm?.text ?? "").slice(0, 4000);
        if (!text) continue;
        const id = String(mm?.id || crypto.randomUUID());
        const ts = Number(mm?.ts) || Date.now();
        await saveMessage({ id, from: user.id, to, text, ts });
        count++;
      }
      return json({ ok: true, stored: chatKvReady(), count });
    }

    // ---- 聊天历史：拉取（本地缺失/换设备时从服务端同步）----
    // since 之后的消息（不含 since），按时间升序；服务端仅保留最近 3 个月。
    if (path === "/api/messages" && method === "GET") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const peer = Number(url.searchParams.get("peer"));
      const since = Number(url.searchParams.get("since") || "0");
      if (!peer) return json({ error: "缺少好友参数" }, 400);
      if (!(await areFriends(user.id, peer))) return json({ error: "只能与好友聊天" }, 403);
      const messages = await getMessages(user.id, peer, since);
      return json({ messages, stored: chatKvReady() });
    }

    // ---- 单聊：已读游标（记录 / 读取，用于跨端同步未读）----
    if (path === "/api/messages/read" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json().catch(() => ({}));
      const peer = Number(b.peer);
      const ts = Number(b.ts) || 0;
      if (!peer) return json({ error: "缺少好友参数" }, 400);
      if (!(await areFriends(user.id, peer))) return json({ error: "只能与好友聊天" }, 403);
      await saveReadCursor(user.id, "dm", peer, ts);
      return json({ ok: true });
    }
    if (path === "/api/messages/read" && method === "GET") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const peer = Number(url.searchParams.get("peer"));
      if (!peer) return json({ error: "缺少好友参数" }, 400);
      if (!(await areFriends(user.id, peer))) return json({ error: "只能与好友聊天" }, 403);
      const lastRead = await getReadCursor(user.id, "dm", peer);
      return json({ lastRead });
    }

    // ---- 好友：发送好友请求（按用户名）----
    if (path === "/api/friends" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json();
      try {
        const r = await sendFriendRequest(user.id, String(b.username ?? "").trim());
        // 实时提醒对方：新请求 / 互为好友（对方需保持信令在线）
        if (r.status === "pending") {
          // r.id = 对方 userId（推送目标）；r.requestId = 请求行 id（供前端引用）
          const delivered = pushToUser(r.id, { type: "friend-request", from: user.id, fromUsername: user.username, requestId: r.requestId });
          console.log(`[FRIEND-REQ-DEBUG] A=${user.id} -> B=${r.id} status=pending delivered=${delivered}`);
        } else if (r.status === "accepted") {
          const delivered = pushToUser(r.id, { type: "friend-accepted", from: user.id, fromUsername: user.username });
          console.log(`[FRIEND-REQ-DEBUG] A=${user.id} -> B=${r.id} status=accepted delivered=${delivered}`);
        }
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

    // ---- 群聊：我的群列表（含成员在线状态）----
    if (path === "/api/groups" && method === "GET") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const groups = (await listUserGroups(user.id)).map((g) => ({
        ...g,
        members: (g.members || []).map((m) => ({ ...m, online: isOnline(m.id) })),
      }));
      return json({ groups });
    }

    // ---- 群聊：创建（name + 初始成员 userId 列表）----
    if (path === "/api/groups" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json().catch(() => ({}));
      const name = String(b.name ?? "").trim();
      if (!name) return json({ error: "群名称必填" }, 400);
      let members = Array.isArray(b.members)
        ? b.members.map(Number).filter((n: number) => Number.isFinite(n) && n !== user.id)
        : [];
      members = [...new Set(members)];
      const group = await createGroup(user.id, name, String(b.avatar ?? "").slice(0, 2048), members);
      // 实时通知被邀请成员刷新群列表
      const inviteIds = (group.members || []).map((m) => m.id).filter((id) => id !== user.id);
      for (const id of inviteIds) {
        pushToUser(id, { type: "group-invite", group: { id: group.id, name: group.name, avatar: group.avatar } });
      }
      return json({ group }, 201);
    }

    // ---- 群聊：历史（GET） / 补推（POST）----
    const gm = path.match(/^\/api\/groups\/(\d+)\/messages$/);
    if (gm) {
      const gid = Number(gm[1]);
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      if (!(await isGroupMember(gid, user.id))) return json({ error: "你不在该群聊中" }, 403);
      if (method === "GET") {
        const since = Number(url.searchParams.get("since") || "0");
        const messages = await getGroupMessages(gid, since);
        return json({ messages, stored: chatKvReady() });
      }
      if (method === "POST") {
        const body = await req.json().catch(() => ({}));
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        let count = 0;
        for (const mm of msgs.slice(0, 200)) {
          const text = String(mm?.text ?? "").slice(0, 4000);
          if (!text) continue;
          const id = String(mm?.id || crypto.randomUUID());
          const ts = Number(mm?.ts) || Date.now();
          await saveGroupMessage({ id, groupId: gid, from: user.id, text, ts });
          count++;
        }
        return json({ ok: true, stored: chatKvReady(), count });
      }
    }

    // ---- 群聊：已读游标（记录 / 读取，用于跨端同步未读）----
    const gmr = path.match(/^\/api\/groups\/(\d+)\/read$/);
    if (gmr) {
      const gid = Number(gmr[1]);
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      if (!(await isGroupMember(gid, user.id))) return json({ error: "你不在该群聊中" }, 403);
      if (method === "POST") {
        const b = await req.json().catch(() => ({}));
        const ts = Number(b.ts) || 0;
        await saveReadCursor(user.id, "group", gid, ts);
        return json({ ok: true });
      }
      if (method === "GET") {
        const lastRead = await getReadCursor(user.id, "group", gid);
        return json({ lastRead });
      }
    }

    // ---- 群聊：添加成员（群内成员可添加）----
    const am = path.match(/^\/api\/groups\/(\d+)\/members$/);
    if (am) {
      const gid = Number(am[1]);
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      if (!(await isGroupMember(gid, user.id))) return json({ error: "你不在该群聊中" }, 403);
      if (method === "POST") {
        const body = await req.json().catch(() => ({}));
        const addId = Number(body.userId);
        if (!addId) return json({ error: "缺少 userId" }, 400);
        await addGroupMember(gid, addId);
        const basic = await getGroupBasic(gid);
        pushToUser(addId, {
          type: "group-invite",
          group: { id: gid, name: basic?.name, avatar: basic?.avatar },
        });
        return json({ ok: true });
      }
    }

    // ---- 群聊：退出（群主退出则解散群）----
    const lm = path.match(/^\/api\/groups\/(\d+)\/leave$/);
    if (lm) {
      const gid = Number(lm[1]);
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      if (!(await isGroupMember(gid, user.id))) return json({ error: "你不在该群聊中" }, 403);
      const r = await leaveGroup(gid, user.id);
      return json({ ok: true, disbanded: r.disbanded });
    }

    // ---- 群聊：修改名称（仅群主）----
    const rm = path.match(/^\/api\/groups\/(\d+)$/);
    if (rm && method === "PATCH") {
      const gid = Number(rm[1]);
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const basic = await getGroupBasic(gid);
      if (!basic) return json({ error: "群聊不存在" }, 404);
      if (!(await isGroupMember(gid, user.id))) return json({ error: "你不在该群聊中" }, 403);
      const b = await req.json().catch(() => ({}));
      let updated;
      try {
        updated = await renameGroup(gid, user.id, String(b.name ?? ""));
      } catch (err) {
        return json({ error: (err as Error)?.message || "修改失败" }, 400);
      }
      if (!updated) return json({ error: "群聊不存在" }, 404);
      // 实时通知群内其他成员刷新群名称
      const memberIds = (await getGroupMemberIds(gid)).filter((id) => id !== user.id);
      for (const id of memberIds) {
        pushToUser(id, { type: "group-updated", group: { id: gid, name: updated.name } });
      }
      return json({ ok: true, group: updated });
    }

    // ---- 好友：通过请求 ----
    if (path === "/api/friends/accept" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json();
      const ok = await acceptFriendRequest(user.id, Number(b.requestId));
      if (!ok) return json({ error: "请求不存在或已处理" }, 404);
      // 实时通知发起方：对方已通过，双方应立即刷新好友列表
      const requesterId = await getFriendRequestRequester(Number(b.requestId), user.id);
      if (requesterId != null) {
        const delivered = pushToUser(requesterId, { type: "friend-accepted", from: user.id, fromUsername: user.username });
        console.log(`[FRIEND-ACCEPT-DEBUG] B=${user.id} -> A=${requesterId} delivered=${delivered}`);
      } else {
        console.log(`[FRIEND-ACCEPT-DEBUG] B=${user.id} requestId=${b.requestId} 找不到发起方(requesterId=null)`);
      }
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
        openMode: ["new", "self", "iframe"].includes(b.openMode) ? b.openMode : "new",
        sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : undefined,
      });
      return json({ link }, 201);
    }

    // ---- 数据备份导出（直接从 PostgreSQL 读取当前用户全部链接）----
    if (path === "/api/export" && method === "GET") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const links = await listLinks(user.id);
      return json({
        app: "web-nav-panel",
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: user.id,
        username: user.username,
        links,
      });
    }

    // ---- 数据备份导入（批量写入 PostgreSQL，按 url 去重）----
    // 兼容纯数组 [link,...] 与导出格式 { links:[...] }；忽略非 url 项。
    if (path === "/api/import" && method === "POST") {
      const user = await requireUser(req);
      if (!user) return json({ error: "未登录" }, 401);
      const b = await req.json().catch(() => ({}));
      const items = Array.isArray(b)
        ? b
        : Array.isArray(b?.links)
          ? b.links
          : [];
      if (!Array.isArray(items)) return json({ error: "文件格式不正确" }, 400);
      const res = await bulkImportLinks(user.id, items);
      return json({ ok: true, ...res });
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
          openMode: ["new", "self", "iframe"].includes(b.openMode) ? b.openMode : undefined,
          sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : undefined,
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
