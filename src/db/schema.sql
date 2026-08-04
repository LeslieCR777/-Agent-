-- Agent Swarm 建表 SQL（需求文档 4.x）
-- 主键一律 TEXT UUID；时间存 ISO8601 字符串。
-- 与文档唯一差异：tasks.status 的 CHECK 加入 'stale'
-- （文档 2.2 状态机图含 stale，但 4.1 建表 SQL 漏写）。

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  parent_id     TEXT,
  status        TEXT NOT NULL DEFAULT 'unassigned'
                CHECK (status IN ('unassigned','claimed','in_progress',
                                  'completed','failed','superseded','stale')),
  priority      INTEGER NOT NULL DEFAULT 5,
  agent_id      TEXT,
  assign_count  INTEGER NOT NULL DEFAULT 0,
  result        TEXT,
  error         TEXT,
  source        TEXT NOT NULL DEFAULT 'api',
  tags          TEXT,
  attachments   TEXT,                -- JSON 数组：引用的资产 id 列表，执行时拷入任务目录
  created_at    TEXT NOT NULL,
  claimed_at    TEXT,
  started_at    TEXT,
  finished_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent
  ON tasks(agent_id) WHERE agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'worker',
  status            TEXT NOT NULL DEFAULT 'idle',
  current_task_id   TEXT,
  last_heartbeat_at TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_heartbeat
  ON agents(last_heartbeat_at);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  output      TEXT,
  exit_code   INTEGER,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);

CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  content         TEXT NOT NULL,
  embedding       BLOB,
  source_task_id  TEXT,
  useful_score    REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  cron           TEXT NOT NULL,
  task_template  TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_run_at    TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  task_id    TEXT,
  agent_id   TEXT,
  type       TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

-- 文件资产库：可复用的数据文件，任务可通过 attachments 引用，执行时拷入任务工作目录
CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  filename      TEXT NOT NULL,       -- 存储的文件名（磁盘上）
  original_name TEXT NOT NULL,       -- 上传时的原始文件名
  size          INTEGER NOT NULL,    -- 字节
  mime          TEXT,
  description   TEXT,
  created_at    TEXT NOT NULL
);

-- ===== 竞品情报（CI）模块 =====

-- 竞品注册表：监控与分析的对象（用户决策：注册制管理）
CREATE TABLE IF NOT EXISTS competitors (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  website         TEXT,
  monitor_urls    TEXT,                    -- JSON 数组：要监控的页面 URL
  notes           TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'idle',  -- idle | monitoring | error
  created_at      TEXT NOT NULL,
  last_checked_at TEXT,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_competitors_enabled ON competitors(enabled);

-- 三级检测的"前级哈希"：每次监控后记住每 URL 的 SHA-256，下次快筛
CREATE TABLE IF NOT EXISTS competitor_pages (
  id              TEXT PRIMARY KEY,
  competitor_id   TEXT NOT NULL,
  url             TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  title           TEXT,
  last_fetched_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE(competitor_id, url)
);

-- 竞品变化记录：monitor 阶段 LLM 分类结果（历史保留 + content_hash 去重）
CREATE TABLE IF NOT EXISTS competitor_changes (
  id            TEXT PRIMARY KEY,
  competitor_id TEXT NOT NULL,
  change_type   TEXT NOT NULL,             -- pricing|product|hiring|news|patent|blog|open_source
  title         TEXT NOT NULL,
  summary       TEXT,
  url           TEXT,
  severity      TEXT NOT NULL DEFAULT 'low', -- low|medium|high|critical
  content_hash  TEXT,                       -- 去重键（页 hash，同页同变化不重复记）
  raw_data      TEXT,                       -- 变化原文快照
  task_id       TEXT,                       -- 来源 monitor 任务
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_comp ON competitor_changes(competitor_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_changes_dedup ON competitor_changes(competitor_id, content_hash);

-- 调研洞察：research 阶段产出（多轮历史，Reflexion 用 round 区分）
CREATE TABLE IF NOT EXISTS research_insights (
  id            TEXT PRIMARY KEY,
  competitor_id TEXT NOT NULL,
  topic         TEXT NOT NULL,
  summary       TEXT,
  key_findings  TEXT,                       -- JSON 数组
  sources       TEXT,                       -- JSON 数组 {title,url}
  confidence    REAL,
  round         INTEGER NOT NULL DEFAULT 0, -- Reflexion 轮次
  feedback      TEXT,                       -- 上轮质检反馈（回炉 prompt 用）
  task_id       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insights_comp ON research_insights(competitor_id, created_at DESC);

-- 对比矩阵：compare 阶段 8 维评分（每轮最新）
CREATE TABLE IF NOT EXISTS comparison_matrices (
  id            TEXT PRIMARY KEY,
  competitor_id TEXT NOT NULL,
  dimensions    TEXT,                       -- JSON 数组 DimensionScore（8 维）
  overall_assessment TEXT,
  round         INTEGER NOT NULL DEFAULT 0,
  task_id       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matrices_comp ON comparison_matrices(competitor_id, created_at DESC);

-- 销售战卡：battlecard 阶段产出（quality_score 由 quality 阶段回填）
CREATE TABLE IF NOT EXISTS battlecards (
  id            TEXT PRIMARY KEY,
  competitor_id TEXT NOT NULL,
  content       TEXT,                       -- JSON：strengths/weaknesses/differentiators/objections/elevator
  quality_score REAL,
  quality_detail TEXT,
  round         INTEGER NOT NULL DEFAULT 0,
  task_id       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_battlecards_comp ON battlecards(competitor_id, created_at DESC);

-- 告警记录：high/critical 变化推送（change_id 唯一保证每条只告警一次）
CREATE TABLE IF NOT EXISTS alerts (
  id            TEXT PRIMARY KEY,
  competitor_id TEXT,
  change_id     TEXT,
  channel       TEXT NOT NULL DEFAULT 'email',
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed|demo
  recipient     TEXT,
  payload       TEXT,                       -- 邮件正文快照
  error         TEXT,
  created_at    TEXT NOT NULL,
  sent_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_change ON alerts(change_id);
