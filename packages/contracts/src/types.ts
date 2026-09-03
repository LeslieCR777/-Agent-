/**
 * 全局共享类型（可被所有模块依赖）。
 * 与需求文档 4.x 表结构一一对应。
 */

export type TaskStatus =
  | 'unassigned'
  | 'claimed'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'superseded'
  | 'stale';

export type AgentStatus = 'idle' | 'busy' | 'offline';
export type AgentRole = 'lead' | 'worker';
export type TaskSource = 'api' | 'slack' | 'github' | 'schedule' | 'ci';

export interface Task {
  id: string;
  title: string;
  prompt: string;
  parent_id: string | null;
  status: TaskStatus;
  priority: number;
  agent_id: string | null;
  assign_count: number;
  result: string | null;
  error: string | null;
  source: TaskSource;
  tags: string | null; // JSON 数组字符串
  attachments: string | null; // JSON 数组：资产 id 列表
  created_at: string; // ISO8601
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  current_task_id: string | null;
  last_heartbeat_at: string; // ISO8601
  created_at: string;
}

export interface Session {
  id: string;
  task_id: string;
  agent_id: string;
  output: string | null;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
}

export interface Memory {
  id: string;
  content: string;
  embedding: Uint8Array | null;
  source_task_id: string | null;
  useful_score: number;
  created_at: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  task_template: string;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
}

export type EventType =
  | 'task_created'
  | 'task_claimed'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_stale'
  | 'task_superseded'
  | 'agent_registered'
  | 'agent_offline'
  | 'log'
  // ── 竞品情报（CI）事件 ──
  | 'ci_pipeline_started'
  | 'ci_change_detected'
  | 'ci_insight_created'
  | 'ci_matrix_created'
  | 'ci_battlecard_created'
  | 'ci_quality_checked'
  | 'ci_alert_sent';

export interface AppEvent {
  id: string;
  task_id: string | null;
  agent_id: string | null;
  type: EventType;
  payload: string | null; // JSON 字符串
  created_at: string;
}

export interface Asset {
  id: string;
  name: string;
  filename: string;       // 磁盘存储名（assets/<id>/filename）
  original_name: string;
  size: number;
  mime: string | null;
  description: string | null;
  created_at: string;
}

export interface Embedding {
  id: string;
  content: string;
  source_task_id: string | null;
  useful_score: number;
  created_at: string;
  /** 检索 / 存储用向量（不在 JSON 响应中暴露原始字节） */
  vector: Float64Array;
}

// ── 竞品情报（CI）领域类型 ──

export type ChangeType =
  | 'pricing'
  | 'product'
  | 'hiring'
  | 'news'
  | 'patent'
  | 'blog'
  | 'open_source';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** 流水线 stage（每个 stage 是一个独立的 Worker 任务） */
export type CiStage = 'monitor' | 'research' | 'compare' | 'battlecard' | 'quality' | 'daily_monitor';

export interface Competitor {
  id: string;
  name: string;
  website: string | null;
  monitor_urls: string | null; // JSON 数组
  notes: string | null;
  enabled: number;
  status: string; // idle | monitoring | error
  created_at: string;
  last_checked_at: string | null;
  last_error: string | null;
}

/** monitor 阶段 LLM 产出的单条变化（Worker 上报的原始结构） */
export interface CompetitorChange {
  competitor: string;
  change_type: ChangeType;
  title: string;
  summary: string;
  url: string;
  severity: Severity;
  raw_data?: unknown;
}

/** 落库后的变化行 */
export interface CompetitorChangeRow {
  id: string;
  competitor_id: string;
  change_type: ChangeType;
  title: string;
  summary: string | null;
  url: string | null;
  severity: Severity;
  content_hash: string;
  raw_data: string | null;
  task_id: string | null;
  created_at: string;
}

export interface ResearchInsight {
  topic: string;
  summary: string;
  key_findings: string[];
  sources: { title: string; url: string }[];
  confidence: number;
}

export interface ResearchInsightRow extends ResearchInsight {
  id: string;
  competitor_id: string;
  round: number;
  feedback: string | null;
  task_id: string | null;
  created_at: string;
}

export interface DimensionScore {
  dimension: string;
  // Legacy matrix fields are kept so older full analyses remain readable.
  our_score?: number; // 0-10
  competitor_score?: number; // 0-10
  // competitor_only analyses use neutral left/right labels instead of an
  // implicit "our product" baseline.
  left_score?: number; // 0-10
  right_score?: number; // 0-10
  notes: string;
}

export interface ComparisonMatrix {
  dimensions: DimensionScore[];
  overall_assessment: string;
  left_competitor?: string;
  right_competitor?: string;
}

export interface ComparisonMatrixRow extends ComparisonMatrix {
  id: string;
  competitor_id: string;
  round: number;
  task_id: string | null;
  created_at: string;
}

export interface Battlecard {
  our_strengths: string[];
  our_weaknesses: string[];
  competitor_strengths: string[];
  competitor_weaknesses: string[];
  key_differentiators: string[];
  objection_handling: Record<string, string>;
  elevator_pitch: string;
}

export interface BattlecardRow {
  id: string;
  competitor_id: string;
  content: Battlecard;
  quality_score: number | null;
  quality_detail: string | null;
  round: number;
  task_id: string | null;
  created_at: string;
}

/** quality 阶段产出 */
export interface QualityResult {
  score: number; // 1-10
  feedback: string;
}

export interface AlertRecord {
  id: string;
  competitor_id: string | null;
  change_id: string | null;
  channel: string;
  status: string; // pending|sent|failed|demo
  recipient: string | null;
  payload: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

// ── 评测（Golden Dataset / Evaluation）──

/** 评测目标的 stage：单个阶段 或 完整流水线 */
export type EvalStage = 'monitor' | 'research' | 'compare' | 'battlecard' | 'quality' | 'pipeline';

export type EvalRunStatus = 'running' | 'completed' | 'failed';
export type EvalResultStatus = 'running' | 'passed' | 'failed' | 'error';

export interface EvalCase {
  id: string;
  scenario: string;      // 业务场景描述
  stage: EvalStage;
  prompt: string;        // 输入 prompt/上下文（pipeline 为竞品 seed JSON；单 stage 为 stage 输入 JSON）
  ground_truth: string;  // 期望输出（Ground Truth）
  category: string | null;
  enabled: number;
  created_at: string;
}

export interface EvalRun {
  id: string;
  name: string;
  status: EvalRunStatus;
  cases_total: number;
  cases_passed: number;
  avg_score: number | null;
  avg_latency_ms: number | null;
  started_at: string;
  finished_at: string | null;
}

export interface EvalResult {
  id: string;
  run_id: string;
  case_id: string;
  status: EvalResultStatus;
  passed: number | null;
  score: number | null;
  latency_ms: number | null;
  agent_output: string | null;
  judge_feedback: string | null;
  error: string | null;
  created_at: string;
}

export interface EvalTrace {
  id: string;
  run_id: string;
  case_id: string;
  stage: string;
  prompt: string | null;
  output: string | null;
  exit_code: number | null;
  timed_out: number | null;
  duration_ms: number | null;
  model: string | null;
  created_at: string;
}
