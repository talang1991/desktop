// chatstore.ts —— 服务端聊天历史存储（Deno KV）
//
// 职责：在「本地 IndexedDB 没有的数据」时，作为服务端留存，保留最近 3 个月。
//   - 本地优先：前端每条消息先写 IndexedDB；本地缺失/换设备时，再由本模块从 Deno KV 取回并同步到本地。
//   - 3 个月自动过期：每条消息 set 时带 expireIn = 90 天，Deno KV 自动清理更旧的消息。
//   - 幂等：键含消息 id，重复写入（中继兜底 + 客户端补推）只会覆盖，不会重复。
//
// 本地运行：使用显式本地文件路径 ./chat_kv.sqlite（避免 Deno.openKv() 无 --location 报错）。
// Deno Deploy：检测 DENO_DEPLOYMENT_ID 后用托管 KV（Deno.openKv() 不带路径）。

const DAY_MS = 24 * 3600 * 1000;
const RETAIN_MS = 3 * 30 * DAY_MS; // 保留 3 个月

// 运行期是否可用。不可用时所有写/读静默降级（前端本地缓存仍正常工作）。
let kv: Deno.Kv | null = null;
let ready = false;

export function chatKvReady(): boolean {
  return ready;
}

export async function initChatStore(): Promise<void> {
  try {
    const deployed = !!Deno.env.get("DENO_DEPLOYMENT_ID");
    kv = deployed ? await Deno.openKv() : await Deno.openKv("./chat_kv.sqlite");
    ready = true;
    console.error(
      "[chatstore] Deno KV 已就绪（" +
        (deployed ? "hosted" : "local:./chat_kv.sqlite") +
        "），聊天历史保留 3 个月",
    );
  } catch (e) {
    ready = false;
    kv = null;
    console.error(
      "[chatstore] 无法打开 Deno KV，聊天历史服务端存储不可用（本地缓存仍工作）：",
      (e as Error).message,
    );
  }
}

// 会话键：两个好友 userId 的有序组合，保证 A↔B 与 B↔A 落在同一会话
export function convKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

export interface StoredMsg {
  id: string;
  from: number;
  to: number;
  text: string;
  ts: number;
}

export interface StoredGroupMsg {
  id: string;
  groupId: number;
  from: number;
  text: string;
  ts: number;
}

// 存一条消息（按 id 幂等；保留 3 个月）
export async function saveMessage(m: StoredMsg): Promise<void> {
  if (!kv) return;
  try {
    const key = ["msg", convKey(m.from, m.to), m.ts, m.id];
    await kv.set(key, m, { expireIn: RETAIN_MS });
  } catch (e) {
    console.error("[chatstore] save failed:", (e as Error).message);
  }
}

// 取会话中 since 之后的消息（不含 since 本身），按时间升序
export async function getMessages(
  userId: number,
  peerId: number,
  since: number,
): Promise<StoredMsg[]> {
  if (!kv) return [];
  try {
    const c = convKey(userId, peerId);
    const out: StoredMsg[] = [];
    const iter = kv.list({ prefix: ["msg", c], start: ["msg", c, since + 1] });
    for await (const e of iter) out.push(e.value as StoredMsg);
    out.sort((x, y) => x.ts - y.ts);
    return out;
  } catch (e) {
    console.error("[chatstore] get failed:", (e as Error).message);
    return [];
  }
}

// ---------------- 群聊消息 ----------------
// 存一条群消息（按 id 幂等；保留 3 个月）。键含 groupId，使同一群的消息落在同一前缀下。
export async function saveGroupMessage(m: StoredGroupMsg): Promise<void> {
  if (!kv) return;
  try {
    const key = ["gmsg", m.groupId, m.ts, m.id];
    await kv.set(key, m, { expireIn: RETAIN_MS });
  } catch (e) {
    console.error("[chatstore] saveGroupMessage failed:", (e as Error).message);
  }
}

// 取某群 since 之后的消息（不含 since 本身），按时间升序
export async function getGroupMessages(
  groupId: number,
  since: number,
): Promise<StoredGroupMsg[]> {
  if (!kv) return [];
  try {
    const out: StoredGroupMsg[] = [];
    const iter = kv.list({ prefix: ["gmsg", groupId], start: ["gmsg", groupId, since + 1] });
    for await (const e of iter) out.push(e.value as StoredGroupMsg);
    out.sort((x, y) => x.ts - y.ts);
    return out;
  } catch (e) {
    console.error("[chatstore] getGroupMessages failed:", (e as Error).message);
    return [];
  }
}
