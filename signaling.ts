// signaling.ts —— WebSocket 信令 + 聊天中继兜底，支撑 WebRTC P2P 聊天
//
// 设计目标：真正的端到端 P2P。
//   - 聊天内容在两位对端浏览器之间用 WebRTC DataChannel 直连收发，服务端不接触、不存储。
//   - 本服务只做“信令中转”：转发 offer / answer / ICE candidate，帮助双方建立直连。
//   - 当一方处于对称 NAT 等无法直连的环境时，前端自动降级为“中继模式”，
//     此时聊天消息经由本服务转发给同房间的另一人（仅转发，不落盘）。
//
// 房间模型：每个房间最多 2 人（1:1 P2P）。
//
// 实现说明：使用 npm:ws 附着在主 node:http 服务器上（与 HTTP/API 同端口，同源）。
// 之所以不用 Deno.upgradeWebSocket，是因为当前本地 Deno 构建在该环境下对升级握手存在
// 原生崩溃；ws 方案在本地与 Deno Deploy 均可稳定运行。

import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "npm:ws@8.18.0";

// 根据请求推导前端应连接的 ws URL（与页面同源同端口，仅协议换 ws/wss）
export function getWsPublicUrl(req: Request): string {
  const u = new URL(req.url);
  const secure = u.protocol === "https:";
  const host = u.hostname;
  const port = u.port || (secure ? "443" : "80");
  return `${secure ? "wss" : "ws"}://${host}:${port}/ws`;
}

interface Peer {
  ws: WebSocket;
  room: string;
  id: string;
}

const rooms = new Map<string, Set<Peer>>();
const peers = new Map<WebSocket, Peer>();

function send(ws: WebSocket, obj: unknown): void {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    /* 忽略发送失败 */
  }
}

function broadcast(room: string, except: Peer, obj: unknown): void {
  const set = rooms.get(room);
  if (!set) return;
  for (const p of set) if (p !== except) send(p.ws, obj);
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

  wss.on("connection", (ws: WebSocket) => {
    const s = ws as unknown as { isAlive?: boolean };
    s.isAlive = true;
    ws.on("pong", () => { s.isAlive = true; });

    const peer: Peer = { ws, room: "", id: crypto.randomUUID() };
    peers.set(ws, peer);

    ws.on("message", (data: Buffer | string) => {
      try {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "join") {
        const room = String(msg.room ?? "").trim().slice(0, 64);
        if (!room) { send(ws, { type: "error", error: "房间号不能为空" }); return; }
        let set = rooms.get(room);
        if (!set) { set = new Set(); rooms.set(room, set); }
        if (set.size >= 2) { send(ws, { type: "error", error: "房间已满（P2P 仅支持两人）" }); return; }
        peer.room = room;
        set.add(peer);
        const role = set.size === 1 ? "initiator" : "receiver";
        send(ws, { type: "joined", role, room, peerId: peer.id, peers: set.size });
        broadcast(room, peer, { type: "peer-joined", peerId: peer.id, peers: set.size });
        return;
      }

      if (msg.type === "signal") {
        if (!peer.room) return;
        broadcast(peer.room, peer, { type: "signal", from: peer.id, data: msg.data });
        return;
      }

      if (msg.type === "chat") {
        if (!peer.room) return;
        broadcast(peer.room, peer, {
          type: "chat",
          from: peer.id,
          text: String(msg.text ?? "").slice(0, 4000),
          ts: Date.now(),
        });
        return;
      }

      if (msg.type === "bye") {
        leave(peer);
      }
      } catch (err) {
        console.error("[signaling] message handler error:", (err as Error).message);
      }
    });

    ws.on("close", () => leave(peer));
    ws.on("error", () => leave(peer));
  });
}

function leave(peer: Peer): void {
  const room = peer.room;
  peers.delete(peer.ws);
  if (!room) return;
  const set = rooms.get(room);
  if (!set) return;
  set.delete(peer);
  for (const p of set) send(p.ws, { type: "peer-left", peers: set.size });
  if (set.size === 0) rooms.delete(room);
}
