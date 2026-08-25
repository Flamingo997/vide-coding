-- Cloudflare D1 数据库 Schema
-- 影新鲜 - 影视上新定档时间线
-- 使用方法：在 Cloudflare Dashboard 或 wrangler CLI 执行此文件

-- ============ 用户表 ============
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,           -- 用户名（如 admin）
  password_hash TEXT NOT NULL,   -- SHA-256 密码哈希
  role TEXT DEFAULT 'user',      -- user / admin
  created_at INTEGER NOT NULL
);

-- ============ 会话表 ============
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,        -- 随机 session token
  user_id TEXT NOT NULL,         -- 关联用户
  expires_at INTEGER NOT NULL,   -- 过期时间戳（毫秒）
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ============ 收藏夹表 ============
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,         -- 收藏者用户名
  item_id TEXT NOT NULL,         -- 影片 ID（如 tmdb-movie-123）
  item_data TEXT NOT NULL,       -- 完整卡片 JSON（标题/海报/简介/来源等）
  saved_at INTEGER NOT NULL,     -- 收藏时间戳（毫秒）
  UNIQUE(user_id, item_id)       -- 同一用户不可重复收藏同一影片
);

-- ============ 快讯兜底表 ============
CREATE TABLE IF NOT EXISTS news_flash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  time_label TEXT,               -- 显示用时间文本（如 "3小时前"）
  ts INTEGER,                    -- 时间戳（毫秒）
  url TEXT,                      -- 原文链接
  sort_order INTEGER DEFAULT 0   -- 排序权重
);

-- ============ 默认数据 ============

-- 默认管理员（密码：admin123，上线后请修改）
-- SHA-256('admin123') = 240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9
INSERT OR IGNORE INTO users (id, password_hash, role, created_at) VALUES
  ('admin', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9', 'admin', 1787630000000);

-- 快讯兜底数据（环球影讯 2026-08-21 截图）
INSERT OR IGNORE INTO news_flash (title, time_label, ts, url, sort_order) VALUES
  ('亚马逊意外泄露杰森·斯坦森新片', '3天前', 1787297340000, 'https://ent.huanqiu.com/film', 1),
  ('一句"好好吃饭"，安放中国人温情大义', '3天前', 1787273280000, 'https://ent.huanqiu.com/film', 2),
  ('评《藏锋》：在藏锋与亮剑之间', '3天前', 1787273220000, 'https://ent.huanqiu.com/film', 3),
  ('诺兰版奥德修斯与儒家展开"对话"？', '3天前', 1787272200000, 'https://ent.huanqiu.com/film', 4),
  ('年轻创作者借国产AI圆影视梦', '3天前', 1787272080000, 'https://ent.huanqiu.com/film', 5),
  ('韩媒：IMAX领跑，高端影厅成韩国票房回暖引擎', '4天前', 1787191200000, 'https://ent.huanqiu.com/film', 6),
  ('致敬法律人的热血--谈电视剧《重器》的拍摄', '5天前', 1787181360000, 'https://ent.huanqiu.com/film', 7),
  ('微短剧精品化不能过度依赖数据反馈', '6天前', 1787095620000, 'https://ent.huanqiu.com/film', 8),
  ('微短剧出海下半场：从"规模"到"价值"的惊险一跃', '6天前', 1787095260000, 'https://ent.huanqiu.com/film', 9),
  ('评《痴迷》：痴迷不是爱的真意', '6天前', 1787094780000, 'https://ent.huanqiu.com/film', 10);

-- ============ 索引 ============
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_favorites_user_item ON favorites(user_id, item_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
