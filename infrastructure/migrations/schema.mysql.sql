-- Agent Swarm 建表 SQL（MySQL 8.0+）
-- 与 SQLite 版 schema.sql 结构对齐，类型适配：
--   TEXT PK → VARCHAR(36)；indexed TEXT → VARCHAR(n)；BLOB → LONGBLOB
--   partial index → 普通索引；支持 CHECK / DESC index（MySQL 8.0.16+ / 8.0+）

-- 先建库（若脚本由管理员执行）
CREATE DATABASE IF NOT EXISTS agent_swarm DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE agent_swarm;

SET NAMES utf8mb4;


CREATE TABLE IF NOT EXISTS tasks (
  id            VARCHAR(36) PRIMARY KEY,
  title         VARCHAR(500) NOT NULL,
  prompt        TEXT NOT NULL,
  parent_id     VARCHAR(36),
  status        VARCHAR(20) NOT NULL DEFAULT 'unassigned'
                CHECK (status IN ('unassigned','claimed','in_progress',
                                  'completed','failed','superseded','stale')),
  priority      INT NOT NULL DEFAULT 5,
  agent_id      VARCHAR(36),
  assign_count  INT NOT NULL DEFAULT 0,
  result        LONGTEXT,
  error         TEXT,
  source        VARCHAR(20) NOT NULL DEFAULT 'api',
  tags          TEXT,                -- JSON 数组字符串
  attachments   TEXT,                -- JSON 数组：引用的资产 id 列表
  created_at    VARCHAR(40) NOT NULL,
  claimed_at    VARCHAR(40),
  started_at    VARCHAR(40),
  finished_at   VARCHAR(40),
  KEY idx_tasks_status (status, priority, created_at),
  KEY idx_tasks_parent (parent_id),
  KEY idx_tasks_agent (agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agents (
  id                VARCHAR(36) PRIMARY KEY,
  name              VARCHAR(200) NOT NULL,
  role              VARCHAR(20) NOT NULL DEFAULT 'worker',
  status            VARCHAR(20) NOT NULL DEFAULT 'idle',
  current_task_id   VARCHAR(36),
  last_heartbeat_at VARCHAR(40) NOT NULL,
  created_at        VARCHAR(40) NOT NULL,
  KEY idx_agents_heartbeat (last_heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id          VARCHAR(36) PRIMARY KEY,
  task_id     VARCHAR(36) NOT NULL,
  agent_id    VARCHAR(36) NOT NULL,
  output      LONGTEXT,
  exit_code   INT,
  started_at  VARCHAR(40) NOT NULL,
  finished_at VARCHAR(40),
  KEY idx_sessions_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS memories (
  id              VARCHAR(36) PRIMARY KEY,
  content         TEXT NOT NULL,
  embedding       LONGBLOB,
  source_task_id  VARCHAR(36),
  useful_score    DOUBLE NOT NULL DEFAULT 0,
  created_at      VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id             VARCHAR(36) PRIMARY KEY,
  name           VARCHAR(200) NOT NULL,
  cron           VARCHAR(100) NOT NULL,
  task_template  TEXT NOT NULL,
  enabled        TINYINT NOT NULL DEFAULT 1,
  last_run_at    VARCHAR(40),
  created_at     VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
  id         VARCHAR(36) PRIMARY KEY,
  task_id    VARCHAR(36),
  agent_id   VARCHAR(36),
  type       VARCHAR(40) NOT NULL,
  payload    TEXT,
  created_at VARCHAR(40) NOT NULL,
  KEY idx_events_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assets (
  id            VARCHAR(36) PRIMARY KEY,
  name          VARCHAR(500) NOT NULL,
  filename      VARCHAR(500) NOT NULL,
  original_name VARCHAR(500) NOT NULL,
  size          BIGINT NOT NULL,
  mime          VARCHAR(200),
  description   TEXT,
  created_at    VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===== 竞品情报（CI）模块 =====

CREATE TABLE IF NOT EXISTS competitors (
  id              VARCHAR(36) PRIMARY KEY,
  name            VARCHAR(200) NOT NULL,
  website         VARCHAR(2048),
  monitor_urls    TEXT,                    -- JSON 数组
  notes           TEXT,
  enabled         TINYINT NOT NULL DEFAULT 1,
  status          VARCHAR(20) NOT NULL DEFAULT 'idle',
  created_at      VARCHAR(40) NOT NULL,
  last_checked_at VARCHAR(40),
  last_error      TEXT,
  KEY idx_competitors_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS competitor_pages (
  id              VARCHAR(36) PRIMARY KEY,
  competitor_id   VARCHAR(36) NOT NULL,
  url             VARCHAR(2048) NOT NULL,
  sha256          VARCHAR(64) NOT NULL,
  title           VARCHAR(500),
  last_fetched_at VARCHAR(40) NOT NULL,
  created_at      VARCHAR(40) NOT NULL,
  UNIQUE KEY uk_comp_url (competitor_id, url(512))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS competitor_changes (
  id            VARCHAR(36) PRIMARY KEY,
  competitor_id VARCHAR(36) NOT NULL,
  change_type   VARCHAR(20) NOT NULL,
  title         VARCHAR(500) NOT NULL,
  summary       TEXT,
  url           VARCHAR(2048),
  severity      VARCHAR(20) NOT NULL DEFAULT 'low',
  content_hash  VARCHAR(64) NOT NULL,
  raw_data      TEXT,
  task_id       VARCHAR(36),
  created_at    VARCHAR(40) NOT NULL,
  KEY idx_changes_comp (competitor_id, created_at DESC),
  UNIQUE KEY idx_changes_dedup (competitor_id, content_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS research_insights (
  id            VARCHAR(36) PRIMARY KEY,
  competitor_id VARCHAR(36) NOT NULL,
  topic         VARCHAR(200) NOT NULL,
  summary       TEXT,
  key_findings  TEXT,                       -- JSON 数组
  sources       TEXT,                       -- JSON 数组 {title,url}
  confidence    DOUBLE,
  round         INT NOT NULL DEFAULT 0,
  feedback      TEXT,
  task_id       VARCHAR(36),
  created_at    VARCHAR(40) NOT NULL,
  KEY idx_insights_comp (competitor_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS comparison_matrices (
  id            VARCHAR(36) PRIMARY KEY,
  competitor_id VARCHAR(36) NOT NULL,
  dimensions    TEXT,                       -- JSON 数组 DimensionScore
  overall_assessment TEXT,
  round         INT NOT NULL DEFAULT 0,
  task_id       VARCHAR(36),
  created_at    VARCHAR(40) NOT NULL,
  KEY idx_matrices_comp (competitor_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS battlecards (
  id            VARCHAR(36) PRIMARY KEY,
  competitor_id VARCHAR(36) NOT NULL,
  content       TEXT,                       -- JSON
  quality_score DOUBLE,
  quality_detail TEXT,
  round         INT NOT NULL DEFAULT 0,
  task_id       VARCHAR(36),
  created_at    VARCHAR(40) NOT NULL,
  KEY idx_battlecards_comp (competitor_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS alerts (
  id            VARCHAR(36) PRIMARY KEY,
  competitor_id VARCHAR(36),
  change_id     VARCHAR(36),
  channel       VARCHAR(20) NOT NULL DEFAULT 'email',
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  recipient     VARCHAR(500),
  payload       TEXT,
  error         TEXT,
  created_at    VARCHAR(40) NOT NULL,
  sent_at       VARCHAR(40),
  UNIQUE KEY idx_alerts_change (change_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 我方产品画像（用户自行注册，看板可编辑；空表时回退 .env 的 OUR_PRODUCT_*）
CREATE TABLE IF NOT EXISTS our_profile (
  id            VARCHAR(36) PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  website       VARCHAR(2048),
  positioning   TEXT,
  target_market TEXT,
  updated_at    VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===== 评测（Golden Dataset / Evaluation）=====

CREATE TABLE IF NOT EXISTS eval_cases (
  id          VARCHAR(36) PRIMARY KEY,
  scenario    TEXT NOT NULL,              -- 业务场景描述
  stage       VARCHAR(20) NOT NULL CHECK (stage IN ('monitor','research','compare','battlecard','quality','pipeline')),
  prompt      TEXT NOT NULL,              -- 输入 prompt/上下文（pipeline 为竞品 seed JSON；单 stage 为 stage 输入 JSON）
  ground_truth TEXT NOT NULL,             -- 期望输出（Ground Truth）
  category    VARCHAR(50),                -- 场景模板分类（pricing_change / new_product / ...）
  enabled     TINYINT NOT NULL DEFAULT 1,
  created_at  VARCHAR(40) NOT NULL,
  KEY idx_eval_cases_enabled (enabled, stage, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eval_runs (
  id            VARCHAR(36) PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  cases_total   INT NOT NULL DEFAULT 0,
  cases_passed  INT NOT NULL DEFAULT 0,
  avg_score     DOUBLE,
  avg_latency_ms DOUBLE,
  started_at    VARCHAR(40) NOT NULL,
  finished_at   VARCHAR(40),
  KEY idx_eval_runs_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eval_results (
  id            VARCHAR(36) PRIMARY KEY,
  run_id        VARCHAR(36) NOT NULL,
  case_id       VARCHAR(36) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','failed','error')),
  passed        TINYINT,                  -- 判题通过（0/1）
  score         DOUBLE,                   -- 判题分数 0-10
  latency_ms    INT,
  agent_output  LONGTEXT,                 -- 判题输入（Agent 输出，截断 20k）
  judge_feedback TEXT,
  error         TEXT,
  created_at    VARCHAR(40) NOT NULL,
  KEY idx_eval_results_run (run_id, case_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS eval_traces (
  id          VARCHAR(36) PRIMARY KEY,
  run_id      VARCHAR(36) NOT NULL,
  case_id     VARCHAR(36) NOT NULL,
  stage       VARCHAR(20) NOT NULL,       -- 该 trace 对应的 stage
  prompt      TEXT,                       -- 截断 4k
  output      TEXT,                       -- 截断 8k
  exit_code   INT,
  timed_out   TINYINT,
  duration_ms INT,
  model       VARCHAR(100),
  created_at  VARCHAR(40) NOT NULL,
  KEY idx_eval_traces_run (run_id, case_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===== 阶段一：可靠、可追溯的分析运行中心 =====
CREATE TABLE IF NOT EXISTS analysis_briefs (
  id VARCHAR(36) PRIMARY KEY,
  our_product_id VARCHAR(36),
  competitor_ids TEXT NOT NULL,
  purpose VARCHAR(40) NOT NULL,
  market VARCHAR(100) NOT NULL,
  time_range_start VARCHAR(40),
  time_range_end VARCHAR(40),
  included_sources TEXT,
  excluded_sources TEXT,
  max_runtime_seconds INT NOT NULL DEFAULT 3600,
  cost_budget DOUBLE NOT NULL DEFAULT 10,
  allow_unverified TINYINT NOT NULL DEFAULT 0,
  created_by VARCHAR(100) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  KEY idx_briefs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ci_runs (
  id VARCHAR(36) PRIMARY KEY,
  brief_id VARCHAR(36) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  current_stage VARCHAR(30),
  progress INT NOT NULL DEFAULT 0,
  snapshot LONGTEXT NOT NULL,
  model_version VARCHAR(200),
  prompt_version VARCHAR(100),
  token_count BIGINT NOT NULL DEFAULT 0,
  search_count INT NOT NULL DEFAULT 0,
  estimated_cost DOUBLE NOT NULL DEFAULT 0,
  error_code VARCHAR(100),
  error_message TEXT,
  created_by VARCHAR(100) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  started_at VARCHAR(40),
  finished_at VARCHAR(40),
  cancelled_at VARCHAR(40),
  KEY idx_runs_status_created (status, created_at),
  KEY idx_runs_brief (brief_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ci_run_stages (
  id VARCHAR(36) PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  stage VARCHAR(30) NOT NULL,
  round INT NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'queued',
  attempt INT NOT NULL DEFAULT 0,
  task_id VARCHAR(36),
  input_ref LONGTEXT,
  output_ref LONGTEXT,
  model VARCHAR(200),
  prompt_version VARCHAR(100),
  tools TEXT,
  token_count BIGINT NOT NULL DEFAULT 0,
  estimated_cost DOUBLE NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at VARCHAR(40),
  finished_at VARCHAR(40),
  created_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uk_run_stage_round (run_id, stage, round),
  UNIQUE KEY uk_run_stage_task (task_id),
  KEY idx_run_stages_status (run_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS outbox_events (
  id VARCHAR(36) PRIMARY KEY,
  aggregate_type VARCHAR(50) NOT NULL,
  aggregate_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload LONGTEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  available_at VARCHAR(40) NOT NULL,
  processed_at VARCHAR(40),
  last_error TEXT,
  created_at VARCHAR(40) NOT NULL,
  KEY idx_outbox_pending (status, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS evidence (
  id VARCHAR(36) PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  competitor_id VARCHAR(36),
  request_url VARCHAR(2048) NOT NULL,
  final_url VARCHAR(2048) NOT NULL,
  title VARCHAR(500),
  http_status INT,
  content_type VARCHAR(200),
  body_hash VARCHAR(64) NOT NULL,
  snapshot_uri VARCHAR(2048),
  raw_content LONGTEXT,
  source_type VARCHAR(30) NOT NULL DEFAULT 'website',
  market VARCHAR(100),
  language VARCHAR(30),
  published_at VARCHAR(40),
  captured_at VARCHAR(40) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  reviewed_by VARCHAR(100),
  reviewed_at VARCHAR(40),
  review_reason TEXT,
  UNIQUE KEY uk_evidence_run_hash_url (run_id, body_hash, request_url(512)),
  KEY idx_evidence_review (status, captured_at),
  KEY idx_evidence_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS claims (
  id VARCHAR(36) PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  statement TEXT NOT NULL,
  subject VARCHAR(500) NOT NULL,
  claim_type VARCHAR(50) NOT NULL DEFAULT 'general',
  market VARCHAR(100),
  valid_at VARCHAR(40),
  confidence DOUBLE NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  invalidated_at VARCHAR(40),
  reviewed_by VARCHAR(100),
  reviewed_at VARCHAR(40),
  review_reason TEXT,
  created_at VARCHAR(40) NOT NULL,
  KEY idx_claims_run_status (run_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_id VARCHAR(36) NOT NULL,
  evidence_id VARCHAR(36) NOT NULL,
  relation VARCHAR(30) NOT NULL DEFAULT 'supports',
  PRIMARY KEY (claim_id, evidence_id),
  KEY idx_claim_evidence_evidence (evidence_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS artifact_claims (
  artifact_type VARCHAR(30) NOT NULL,
  artifact_id VARCHAR(36) NOT NULL,
  claim_id VARCHAR(36) NOT NULL,
  validity VARCHAR(30) NOT NULL DEFAULT 'valid',
  PRIMARY KEY (artifact_type, artifact_id, claim_id),
  KEY idx_artifact_claim (claim_id, validity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reports (
  id VARCHAR(36) PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  content LONGTEXT NOT NULL,
  invalidated TINYINT NOT NULL DEFAULT 0,
  invalid_reason TEXT,
  approved_by VARCHAR(100),
  approved_at VARCHAR(40),
  published_at VARCHAR(40),
  created_by VARCHAR(100) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uk_report_run_version (run_id, version),
  KEY idx_reports_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(36) PRIMARY KEY,
  actor VARCHAR(100) NOT NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id VARCHAR(36) NOT NULL,
  before_data LONGTEXT,
  after_data LONGTEXT,
  trace_id VARCHAR(36) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  KEY idx_audit_resource (resource_type, resource_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_tokens (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  scopes TEXT NOT NULL,
  expires_at VARCHAR(40),
  revoked_at VARCHAR(40),
  created_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uk_service_token_hash (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  password_salt VARCHAR(64) NOT NULL,
  password_hash VARCHAR(128) NOT NULL,
  role VARCHAR(30) NOT NULL,
  enabled TINYINT NOT NULL DEFAULT 1,
  created_at VARCHAR(40) NOT NULL,
  last_login_at VARCHAR(40),
  UNIQUE KEY uk_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  actor VARCHAR(100) NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  method VARCHAR(10) NOT NULL,
  path VARCHAR(500) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  status_code INT NOT NULL,
  response_body LONGTEXT NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (actor, idempotency_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
