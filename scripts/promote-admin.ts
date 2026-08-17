// scripts/promote-admin.ts
// 把指定用户提权为管理员（role = 'admin'）。用于「产生第一个管理员」等初始化场景。
//
// 用法（在项目根目录执行）：
//   deno run -A --env-file=.env scripts/promote-admin.ts <用户名>
// 例如：
//   deno run -A --env-file=.env scripts/promote-admin.ts alice
//
// 等价 SQL（需有 psql 客户端且能连库时）：
//   UPDATE users SET role = 'admin' WHERE username = 'alice';
//
// 说明：users 表的 role 列默认 'user'，合法值为 'user' | 'admin'（受 CHECK 约束约束）。

const username = Deno.args[0];
if (!username) {
  console.error("用法: deno run -A --env-file=.env scripts/promote-admin.ts <用户名>");
  Deno.exit(1);
}

const rawUrl = Deno.env.get("DATABASE_URL");
if (!rawUrl) {
  console.error("缺少环境变量 DATABASE_URL（PostgreSQL 连接串）");
  Deno.exit(1);
}

import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

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

try {
  await client.connect();
  // 先确认用户存在
  const found = await client.queryObject<{ id: number }>(
    `SELECT id FROM users WHERE username = $1`,
    [username],
  );
  if (found.rows.length === 0) {
    console.error(`用户不存在：${username}`);
    Deno.exit(1);
  }
  await client.queryObject(
    `UPDATE users SET role = 'admin' WHERE username = $1`,
    [username],
  );
  console.log(`已将用户 ${username} 设为管理员（role = 'admin'）。现在可用该账号登录并进入「管理后台」。`);
} catch (e) {
  console.error("提权失败：", (e as Error).message);
  Deno.exit(1);
} finally {
  try { await client.end(); } catch {}
}
