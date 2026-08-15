// signaling.ts —— 好友定向的 WebSocket 信令 + 聊天中继兜底，支撑 WebRTC P2P 聊天
//
// 设计目标：真正的端到端 P2P（好友 1:1）。
//   - 聊天内容在两位好友浏览器之间用 WebRTC DataChannel 直连收发，服务端不接触、不存储。
//   - 本服务只做“信令中转”：按目标好友 userId 转发 offer / answer / ICE candidate，帮助建立直连。
//   - 当一方处于对称 NAT 等无法直连时，前端自动降级为“中继模式”，消息经本服务转发给对方（仅转发，不落盘）。
//
// 鉴权：WebSocket 连接必须带 ?token=，服务端用 getUserByToken 校验；未授权立即关闭。
// 在线状态：在线用户维护在 onlineUsers，供 API 层查询（isOnline）与 presence 广播。
//
// 实现说明：使用 npm:ws 附着在主 node:http 服务器上（与 HTTP/API 同端口，同源）。

import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "npm:ws@8.18.0";
import { getUserByToken, isGroupMember, getGroupMemberIds, getUserById } from "./store.ts";
import { saveMessage, saveGroupMessage } from "./chatstore.ts";

// 根据请求推导前端应连接的 ws URL（与页面同源同端口，仅协议换 ws/wss）。
export function getWsPublicUrl(req: Request): string {
  const u = new URL(req.url);
  const fwdProto = req.headers.get("x-forwarded-proto");
  const secure = u.protocol === "https:" || fwdProto === "https" || fwdProto === "wss";
  const host = u.hostname || req.headers.get("host")?.split(":")[0] || "localhost";
  const port = u.port || (secure ? "443" : "80");
  return `${secure ? "wss" : "ws"}://${host}:${port}/ws`;
}

// ICE 服务器列表（下发给浏览器，用于 WebRTC 候选收集）。
const DEFAULT_STUN: Array<{ urls: string }> = [
  { urls: "stun:stun.miwifi.com:3478" },
  { urls: "stun:stun.chat.bilibili.com:3478" },
  { urls: "stun:stun.qq.com:3478" },
];

// 国外/非中文环境使用的 STUN（国内网络通常不通的 Google/Twilio 公共节点）
const DEFAULT_STUN_FOREIGN: Array<{ urls: string }> = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

// 根据请求头 Accept-Language 判定是否走国外节点（浏览器 navigator.language 会带进该头）
function preferForeignIce(req?: Request): boolean {
  if (!req) return false;
  const al = (req.headers.get("accept-language") || "").toLowerCase();
  const first = al.split(",")[0].trim();
  return !first.startsWith("zh");
}

export function getIceServers(req?: Request): Array<{ urls: string; username?: string; credential?: string }> {
  const base = preferForeignIce(req) ? DEFAULT_STUN_FOREIGN : DEFAULT_STUN;
  const list: Array<{ urls: string; username?: string; credential?: string }> = base.map((s) => ({ ...s }));
  const turnUrl = Deno.env.get("TURN_URL");
  if (turnUrl) {
    const entry: { urls: string; username?: string; credential?: string } = { urls: turnUrl };
    const u = Deno.env.get("TURN_USERNAME");
    const c = Deno.env.get("TURN_CREDENTIAL");
    if (u) entry.username = u;
    if (c) entry.credential = c;
    list.push(entry);
  }
  return list;
}

// ---------------- 在线状态（好友在线点 / presence 广播） ----------------
// 一个用户可能开多个标签页，故 userId -> Set<WebSocket>
const onlineUsers = new Map<number, Set<WebSocket>>();
// 每个 ws 订阅了哪些好友的在线状态（用于 presence 推送）
const friendsByWs = new Map<WebSocket, Set<number>>();
// 每个 ws 对应的已鉴权 userId
const userIdByWs = new Map<WebSocket, number>();
// userId -> 用户基本信息（用于会议房间名单回执），含访客
const usersById = new Map<number, { id: number; username: string; avatar?: string }>();
// 会议房间：roomId -> (userId -> 连接计数)。按连接计数而非按 userId 去重，
// 以支持同一账号在多台设备（手机/电脑）同时入会：一台设备离开不会把同账号的另一台设备“踢出”。
const rooms = new Map<string, Map<number, number>>();

// 房间增加一名参与者（按 userId 计数，支持同账号多连接）
function roomAdd(roomId: string, userId: number): void {
  let m = rooms.get(roomId);
  if (!m) { m = new Map(); rooms.set(roomId, m); }
  m.set(userId, (m.get(userId) || 0) + 1);
}
// 房间移除一名参与者；返回该 userId 是否仍在房间（计数 > 0 说明同账号还有其它设备）
function roomRemove(roomId: string, userId: number): boolean {
  const m = rooms.get(roomId);
  if (!m) return false;
  const c = (m.get(userId) || 0) - 1;
  if (c <= 0) m.delete(userId);
  else m.set(userId, c);
  if (m.size === 0) rooms.delete(roomId);
  return m.has(userId);
}
// 访客 id 自增计数器（从 -1 递减，避免与真实正 id 冲突）
let guestSeq = 0;
// 每个 ws 当前加入的会议房间（用于断开时自动退会）
const roomsByWs = new Map<WebSocket, string>();

export function isOnline(userId: number): boolean {
  const s = onlineUsers.get(userId);
  return !!s && s.size > 0;
}

function send(ws: WebSocket, obj: unknown): void {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    /* 忽略发送失败 */
  }
}

// 向所有订阅了某好友在线状态的连接广播 presence
function notifyPresence(userId: number, online: boolean): void {
  for (const [ws, set] of friendsByWs) {
    if (set.has(userId)) send(ws, { type: "presence", userId, online });
  }
}

function addOnline(userId: number, ws: WebSocket): void {
  let s = onlineUsers.get(userId);
  if (!s) { s = new Set(); onlineUsers.set(userId, s); }
  s.add(ws);
  userIdByWs.set(ws, userId);
  notifyPresence(userId, true);
}

function removeOnline(ws: WebSocket): void {
  const userId = userIdByWs.get(ws);
  if (userId == null) return;
  const s = onlineUsers.get(userId);
  if (s) {
    s.delete(ws);
    if (s.size === 0) {
      onlineUsers.delete(userId);
      usersById.delete(userId); // 该用户最后一个连接断开：移除基本信息
    }
  }
  userIdByWs.delete(ws);
  friendsByWs.delete(ws);
  // 断开时自动退出其所在的会议房间（若有），并通知其它成员。
  // 按连接计数移除：同账号其它设备仍在房间时，不误发 room-leave（避免把同账号其它设备“踢出”）。
  const roomId = roomsByWs.get(ws);
  if (roomId) {
    roomsByWs.delete(ws);
    const m = rooms.get(roomId);
    if (m) {
      const stillIn = roomRemove(roomId, userId);
      if (!stillIn) {
        for (const id of m.keys()) {
          if (id === userId) continue;
          routeTo(id, { type: "room-leave", roomId, from: userId });
        }
      }
    }
  }
  notifyPresence(userId, false);
}

// 把消息路由给目标 userId 的全部连接；返回是否在线
function routeTo(userId: number, obj: unknown): boolean {
  const s = onlineUsers.get(userId);
  if (!s || s.size === 0) return false;
  for (const ws of s) send(ws, obj);
  return true;
}

// 向一组 userId 的每个连接广播（可排除某 userId，如消息发送者自己已本地渲染）
function routeToEach(ids: number[], obj: unknown, exclude?: number): void {
  for (const id of ids) {
    if (exclude != null && id === exclude) continue;
    routeTo(id, obj);
  }
}

// 向会议房间内除 exclude(userId) 外的成员广播
function roomBroadcast(roomId: string, exclude: number, obj: unknown): void {
  const m = rooms.get(roomId);
  if (!m) return;
  for (const id of m.keys()) {
    if (id === exclude) continue;
    routeTo(id, obj);
  }
}

// 生成房间权威成员名单（含昵称/头像，供前端渲染瓦片与聊天昵称）
async function roomRoster(roomId: string): Promise<Array<{ id: number; name: string; avatar: string }>> {
  const m = rooms.get(roomId);
  if (!m) return [];
  const out: Array<{ id: number; name: string; avatar: string }> = [];
  for (const id of m.keys()) {
    const u = usersById.get(id);
    if (u) { out.push({ id, name: u.username, avatar: u.avatar || "" }); continue; }
    if (id > 0) {
      try {
        const db = await getUserById(id);
        if (db) { out.push({ id, name: db.username, avatar: db.avatar || "" }); usersById.set(id, db); continue; }
      } catch { /* ignore */ }
    }
    out.push({ id, name: String(id), avatar: "" });
  }
  return out;
}

// 向指定 userId 的全部连接实时推送一条消息（如好友请求 / 通过通知）。
// 返回是否在线（有活跃连接）。API 层（好友请求/通过）用它做实时提醒。
export function pushToUser(userId: number, obj: unknown): boolean {
  if (!Number.isFinite(userId)) {
    console.log("[PUSH-DEBUG] pushToUser 无效 userId:", userId);
    return false;
  }
  const s = onlineUsers.get(userId);
  const online = !!s && s.size > 0;
  const type = (obj && typeof obj === "object" && (obj as Record<string, unknown>).type) || "?";
  console.log(`[PUSH-DEBUG] pushToUser userId=${userId} type=${type} online=${online} conns=${s ? s.size : 0}`);
  const delivered = routeTo(userId, obj);
  console.log(`[PUSH-DEBUG] pushToUser userId=${userId} type=${type} delivered=${delivered}`);
  return delivered;
}

// 把信令服务（ws）附着到已有的 node:http 服务器上（与 HTTP/API 同端口）
export function attachSignaling(server: Server): void {
  const wss = new WebSocketServer({ server });

  // 心跳：清理掉线连接
  const heartbeat = setInterval(() => {
    wss.clients.forEach((sock) => {
      const s = sock as unknown as { isAlive?: boolean; terminate: () => void; ping: () => void };
      if (s.isAlive === false) return s.terminate();
      s.isAlive = false;
      try { s.ping(); } catch { /* noop */ }
    });
  }, 20000);
  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", async (ws: WebSocket, req: any) => {
    // 先同步挂好消息/关闭/错误处理器，避免鉴权 await 期间到达的消息被丢弃（竞态会导致在线订阅/呼叫丢失）
    const s = ws as unknown as { isAlive?: boolean };
    s.isAlive = true;
    ws.on("pong", () => { s.isAlive = true; });

    let user: { id: number; username: string; guest?: boolean } | null = null;
    const pending: Array<{ type?: string; [k: string]: unknown }> = [];
    let authed = false;

    const handleMessage = async (msg: { type?: string; [k: string]: unknown }) => {
      if (!msg || typeof msg.type !== "string") return;
      // 访客身份仅允许会议房间相关消息与心跳，避免越权操作其它功能
      if (user && user.guest) {
        // 访客身份仅允许会议房间相关消息与心跳；signal 为 WebRTC 媒体协商（offer/answer/ICE），
        // 必须放行，否则通过链接入会的访客无法与任何人建立音视频连接（视频全黑）。
        const allowed = ["room-join", "room-leave", "room-screen", "room-screen-stop", "room-cam", "room-chat", "ping", "signal"];
        if (!allowed.includes(msg.type)) return;
      }
      switch (msg.type) {
        // 订阅好友在线状态
        case "presence": {
          const ids = Array.isArray(msg.friends) ? (msg.friends as unknown[]).map(Number) : [];
          friendsByWs.set(ws, new Set(ids.filter((n) => Number.isFinite(n))));
          // 立即回送当前状态
          for (const id of ids) send(ws, { type: "presence", userId: id, online: isOnline(id) });
          return;
        }

        // A 呼叫好友 B（按 userId 定向）。media 字段（"audio"|"video"）用于区分
        // 普通文字握手呼叫与音视频通话呼叫，让被叫方弹出接听界面。
        case "call": {
          const to = Number(msg.to);
          if (!to) return;
          const media = typeof msg.media === "string" ? msg.media : undefined;
          const ok = routeTo(to, { type: "incoming-call", from: user!.id, media });
          if (!ok) send(ws, { type: "call-offline", to });
          return;
        }

        // WebRTC 信令（offer/answer/ICE），按目标 userId 转发
        case "signal": {
          const to = Number(msg.to);
          if (!to) return;
          routeTo(to, { type: "signal", from: user!.id, data: msg.data });
          return;
        }

        // 中继聊天消息，按目标 userId 转发
        case "chat": {
          const to = Number(msg.to);
          if (!to) return;
          const id = String(msg.id || crypto.randomUUID());
          const ts = Number(msg.ts) || Date.now();
          const text = String(msg.text ?? "").slice(0, 4000);
          routeTo(to, {
            type: "chat",
            from: user!.id,
            id,
            ts,
            text,
          });
          // 服务端留存（本地优先，这里是兜底 + 换设备同步源），保留 3 个月由 KV 自动过期
          saveMessage({ id, from: user!.id, to, text, ts });
          return;
        }

        // 群聊消息中继：校验群成员后，存 KV 并转发给全体在线成员（不含发送者）
        case "group-chat": {
          const groupId = Number(msg.groupId);
          if (!groupId) return;
          if (!(await isGroupMember(groupId, user!.id))) {
            send(ws, { type: "error", error: "你不在该群聊中" });
            return;
          }
          const id = String(msg.id || crypto.randomUUID());
          const ts = Number(msg.ts) || Date.now();
          const text = String(msg.text ?? "").slice(0, 4000);
          if (!text) return;
          const members = (await getGroupMemberIds(groupId)).filter((m) => m !== user!.id);
          routeToEach(members, {
            type: "group-chat",
            groupId,
            from: user!.id,
            id,
            ts,
            text,
          });
          // 服务端留存（换设备同步源），保留 3 个月由 KV 自动过期
          saveGroupMessage({ id, groupId, from: user!.id, text, ts });
          return;
        }

        // 会议内聊天：仅实时广播给群成员（不含发送者），不落 KV（会议结束即清空）
        case "meeting-chat": {
          const groupId = Number(msg.groupId);
          if (!groupId) return;
          if (!(await isGroupMember(groupId, user!.id))) {
            send(ws, { type: "error", error: "你不在该群聊中" });
            return;
          }
          const id = String(msg.id || crypto.randomUUID());
          const ts = Number(msg.ts) || Date.now();
          const text = String(msg.text ?? "").slice(0, 4000);
          if (!text) return;
          const members = (await getGroupMemberIds(groupId)).filter((m) => m !== user!.id);
          routeToEach(members, {
            type: "meeting-chat",
            groupId,
            from: user!.id,
            id,
            ts,
            text,
          });
          return;
        }

        // ---- 一对一通话内的文字聊天（仅转发给对方，不落库）----
        case "call-chat": {
          const to = Number(msg.to);
          if (!to) return;
          const id = String(msg.id || crypto.randomUUID());
          const ts = Number(msg.ts) || Date.now();
          const text = String(msg.text ?? "").slice(0, 4000);
          if (!text) return;
          routeTo(to, {
            type: "call-chat",
            from: user!.id,
            id,
            ts,
            text,
          });
          return;
        }

        // ---- 群会议（多人 WebRTC 全网状）信令广播 ----
        // SDP/ICE 仍走上面已有的 signal（按 userId 定向），这里只负责“谁在会议里”的广播，
        // 让各成员互相建立 RTCPeerConnection。三类消息均校验群成员资格，并排除发送者本人。
        case "group-call": {
          const groupId = Number(msg.groupId);
          if (!groupId) return;
          if (!(await isGroupMember(groupId, user!.id))) {
            send(ws, { type: "error", error: "你不在该群聊中" });
            return;
          }
          const media = typeof msg.media === "string" ? msg.media : "video";
          const members = (await getGroupMemberIds(groupId)).filter((m) => m !== user!.id);
          routeToEach(members, { type: "group-call", groupId, from: user!.id, media });
          // 回执发起者权威成员名单：确保本地 g.members 快照过期也不漏连任何人
          send(ws, { type: "group-roster", groupId, members });
          return;
        }
        case "group-join": {
          const groupId = Number(msg.groupId);
          if (!groupId) return;
          if (!(await isGroupMember(groupId, user!.id))) {
            send(ws, { type: "error", error: "你不在该群聊中" });
            return;
          }
          const members = (await getGroupMemberIds(groupId)).filter((m) => m !== user!.id);
          routeToEach(members, { type: "group-join", groupId, from: user!.id });
          // 回执加入者权威成员名单：确保本地 g.members 快照过期也不漏连任何人（重入会漏人根因）
          send(ws, { type: "group-roster", groupId, members });
          return;
        }
        case "group-leave": {
          const groupId = Number(msg.groupId);
          if (!groupId) return;
          const members = (await getGroupMemberIds(groupId)).filter((m) => m !== user!.id);
          routeToEach(members, { type: "group-leave", groupId, from: user!.id });
          return;
        }
        // 屏幕共享开始/停止广播：让其他成员把该成员的视频瓦片改为 contain（完整显示屏幕，不裁切）。
        // 支持可选 to 定向（晚加入的成员没收到过广播，由共享者主动补发）。
        case "group-screen": {
          const groupId = Number(msg.groupId);
          if (!groupId) return;
          const payload = { type: "group-screen", groupId, from: user!.id };
          if (msg.to) { routeTo(Number(msg.to), payload); }
          else {
            const members = (await getGroupMemberIds(groupId)).filter((m) => m !== user!.id);
            routeToEach(members, payload);
          }
          return;
        }
        case "group-screen-stop": {
          const groupId = Number(msg.groupId);
          if (!groupId) return;
          const payload = { type: "group-screen-stop", groupId, from: user!.id };
          if (msg.to) { routeTo(Number(msg.to), payload); }
          else {
            const members = (await getGroupMemberIds(groupId)).filter((m) => m !== user!.id);
            routeToEach(members, payload);
          }
          return;
        }
        // 摄像头开关广播：通知其他成员把该成员的视频瓦片显示/隐藏头像占位（无视频时显示头像）。
        // 支持可选 to 定向（晚加入的成员没收到过广播，由摄像头关闭者主动补发）。
        case "group-cam": {
          const groupId = Number(msg.groupId);
          if (!groupId) return;
          const payload = { type: "group-cam", groupId, from: user!.id, on: !!msg.on };
          if (msg.to) { routeTo(Number(msg.to), payload); }
          else {
            const members = (await getGroupMemberIds(groupId)).filter((m) => m !== user!.id);
            routeToEach(members, payload);
          }
          return;
        }

        // ---- 独立会议房间（通过会议链接创建/加入，不依赖群）----
        // 房间参与名单保存在内存 rooms 中；下列消息均按 roomId 广播，不校验群成员。
        case "room-join": {
          const roomId = String(msg.roomId || "");
          if (!roomId) return;
          roomAdd(roomId, user!.id);
          roomsByWs.set(ws, roomId);
          const m = rooms.get(roomId)!;
          // 通知房间内其它「账号」有新加入者（让其主动建连）；同账号其它设备本就在房间内，无需重复通知
          for (const id of m.keys()) {
            if (id === user!.id) continue;
            routeTo(id, { type: "room-join", roomId, from: user!.id, name: user!.username });
          }
          // 回执发起者权威名单（含名称，供前端渲染瓦片/聊天昵称）
          const members = await roomRoster(roomId);
          send(ws, { type: "room-roster", roomId, members });
          return;
        }
        case "room-leave": {
          const roomId = String(msg.roomId || "");
          if (!roomId) return;
          roomsByWs.delete(ws);
          const m = rooms.get(roomId);
          if (m) {
            const stillIn = roomRemove(roomId, user!.id);
            // 仅当该账号已完全离开房间才通知其它成员（否则同账号还有其它设备，不应误发离开）
            if (!stillIn) {
              for (const id of m.keys()) {
                if (id === user!.id) continue;
                routeTo(id, { type: "room-leave", roomId, from: user!.id });
              }
            }
          }
          return;
        }
        case "room-screen": {
          const roomId = String(msg.roomId || "");
          if (!roomId) return;
          const payload = { type: "room-screen", roomId, from: user!.id };
          if (msg.to) routeTo(Number(msg.to), payload);
          else roomBroadcast(roomId, user!.id, payload);
          return;
        }
        case "room-screen-stop": {
          const roomId = String(msg.roomId || "");
          if (!roomId) return;
          const payload = { type: "room-screen-stop", roomId, from: user!.id };
          if (msg.to) routeTo(Number(msg.to), payload);
          else roomBroadcast(roomId, user!.id, payload);
          return;
        }
        case "room-cam": {
          const roomId = String(msg.roomId || "");
          if (!roomId) return;
          const payload = { type: "room-cam", roomId, from: user!.id, on: !!msg.on };
          if (msg.to) routeTo(Number(msg.to), payload);
          else roomBroadcast(roomId, user!.id, payload);
          return;
        }
        case "room-chat": {
          const roomId = String(msg.roomId || "");
          if (!roomId) return;
          const id = String(msg.id || crypto.randomUUID());
          const ts = Number(msg.ts) || Date.now();
          const text = String(msg.text ?? "").slice(0, 4000);
          if (!text) return;
          roomBroadcast(roomId, user!.id, { type: "room-chat", roomId, from: user!.id, id, ts, text });
          return;
        }

        // 结束当前对话
        case "bye": {
          const to = Number(msg.to);
          if (!to) return;
          routeTo(to, { type: "peer-left", from: user!.id });
          return;
        }

        case "ping":
          send(ws, { type: "pong" });
          return;
      }
    };

    ws.on("message", async (data: Buffer | string) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!authed) { pending.push(msg); return; } // 鉴权完成前先缓存
      try { await handleMessage(msg); } catch (err) {
        console.error("[signaling] message handler error:", (err as Error).message);
      }
    });

    ws.on("close", () => removeOnline(ws));
    ws.on("error", () => removeOnline(ws));

    // ---- 鉴权：从 query 取 token；或通过会议链接以访客身份入会（?room=&name=）----
    try {
      const u = new URL(req.url || "/ws", "http://localhost");
      const token = u.searchParams.get("token") || "";
      if (token) {
        user = await getUserByToken(token);
      } else {
        const room = u.searchParams.get("room") || "";
        if (room) {
          const name = (u.searchParams.get("name") || "访客").slice(0, 24) || "访客";
          user = { id: -(++guestSeq), username: name, guest: true };
        }
      }
    } catch {
      /* ignore */
    }
    if (!user) {
      send(ws, { type: "error", error: "未授权，请重新登录" });
      try { ws.close(); } catch { /* noop */ }
      return;
    }

    authed = true;
    addOnline(user.id, ws);
    // 记录用户基本信息，供会议房间名单回执（含访客）
    usersById.set(user.id, { id: user.id, username: user.username, avatar: (user as { avatar?: string }).avatar || "" });
    send(ws, { type: "welcome", userId: user.id, username: user.username });
    // 处理鉴权期间缓存的消息（如客户端 onopen 即发的 presence 订阅 / call）
    for (const m of pending.splice(0)) {
      try { await handleMessage(m); } catch (err) {
        console.error("[signaling] pending message error:", (err as Error).message);
      }
    }
  });
}
