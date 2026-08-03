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
