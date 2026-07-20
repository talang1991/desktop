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
import { getUserByToken } from "./store.ts";
import { saveMessage } from "./chatstore.ts";

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

export function getIceServers(): Array<{ urls: string; username?: string; credential?: string }> {
  const list: Array<{ urls: string; username?: string; credential?: string }> = DEFAULT_STUN.map((s) => ({ ...s }));
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
    if (s.size === 0) onlineUsers.delete(userId);
  }
  userIdByWs.delete(ws);
  friendsByWs.delete(ws);
  notifyPresence(userId, false);
}

// 把消息路由给目标 userId 的全部连接；返回是否在线
function routeTo(userId: number, obj: unknown): boolean {
  const s = onlineUsers.get(userId);
  if (!s || s.size === 0) return false;
  for (const ws of s) send(ws, obj);
  return true;
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

    let user: { id: number; username: string } | null = null;
    const pending: Array<{ type?: string; [k: string]: unknown }> = [];
    let authed = false;

    const handleMessage = (msg: { type?: string; [k: string]: unknown }) => {
      if (!msg || typeof msg.type !== "string") return;
      switch (msg.type) {
        // 订阅好友在线状态
        case "presence": {
          const ids = Array.isArray(msg.friends) ? (msg.friends as unknown[]).map(Number) : [];
          friendsByWs.set(ws, new Set(ids.filter((n) => Number.isFinite(n))));
          // 立即回送当前状态
          for (const id of ids) send(ws, { type: "presence", userId: id, online: isOnline(id) });
          return;
        }

        // A 呼叫好友 B（按 userId 定向）
        case "call": {
          const to = Number(msg.to);
          if (!to) return;
          const ok = routeTo(to, { type: "incoming-call", from: user!.id });
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

    ws.on("message", (data: Buffer | string) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!authed) { pending.push(msg); return; } // 鉴权完成前先缓存
      try { handleMessage(msg); } catch (err) {
        console.error("[signaling] message handler error:", (err as Error).message);
      }
    });

    ws.on("close", () => removeOnline(ws));
    ws.on("error", () => removeOnline(ws));

    // ---- 鉴权：从 query 取 token ----
    try {
      const u = new URL(req.url || "/ws", "http://localhost");
      const token = u.searchParams.get("token") || "";
      if (token) user = await getUserByToken(token);
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
    send(ws, { type: "welcome", userId: user.id, username: user.username });
    // 处理鉴权期间缓存的消息（如客户端 onopen 即发的 presence 订阅 / call）
    for (const m of pending.splice(0)) {
      try { handleMessage(m); } catch (err) {
        console.error("[signaling] pending message error:", (err as Error).message);
      }
    }
  });
}
