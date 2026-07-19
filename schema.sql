-- schema.sql —— Web 应用导航面板 PostgreSQL 表结构
-- 应用启动时会用 CREATE TABLE IF NOT EXISTS 自动建表（见 store.ts），
-- 本文件仅作参考 / 手动建库 / 排查使用。

CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- 格式：pbkdf2$iter$saltBase64$keyBase64
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS links (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,                 -- 前端展示为 name
  url         TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT '未分类',
  icon        TEXT NOT NULL DEFAULT '',      -- 前端展示为 emoji
  color       TEXT NOT NULL DEFAULT '#4f6ef7',
  open_new    BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_links_user ON links(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS friendships (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 请求方
  friend_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 被请求方
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);
