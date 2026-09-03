// 前端模型 —— 字段对齐后端真实表列（apps/api/src/db/queries/analysis.ts、schema.mysql.sql、
// infrastructure/migrations/002_phase_two_core.migration.sql）。不声明恒 0 / 死列
// （ci_runs.token_count/search_count/estimated_cost、dashboard.overdue_actions）。

export type RunStatus = 'draft' | 'queued' | 'running' | 'waiting_review' | 'published' | 'failed' | 'cancelled';
export type StageStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ReviewStatus = 'pending' | 'verified' | 'rejected' | 'disputed' | 'expired';
export type StageKind = 'monitor' | 'research' | 'compare' | 'battlecard' | 'quality';

export interface Competitor {
  id: string;
  name: string;
  website?: string | null;
  monitor_urls?: string | null;
  notes?: string | null;
  status?: string | null;
  enabled?: boolean | number;
  created_at?: string | null;
  last_checked_at?: string | null;
  last_error?: string | null;
}

export interface Run {
  id: string;
  brief_id: string;
  status: RunStatus;
  current_stage: StageKind | null;
  progress: number;
  snapshot?: {
    competitor?: { id?: string; name?: string | null; [k: string]: unknown } | null;
    our_product?: { id?: string; name?: string | null; [k: string]: unknown } | null;
    comparison_competitors?: Array<{ id?: string; name?: string | null; website?: string | null }>;
    brief?: Record<string, unknown>;
    source_policy?: { allow_unverified?: boolean; [k: string]: unknown };
    [k: string]: unknown;
  } | null;
  model_version?: string | null;
  prompt_version?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  created_by?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  cancelled_at?: string | null;
}

export interface Evidence {
  id: string;
  run_id: string;
  competitor_id?: string | null;
  request_url: string;
  final_url?: string | null;
  title?: string | null;
  http_status?: number | null;
  content_type?: string | null;
  body_hash?: string | null;
  snapshot_uri?: string | null;
  raw_content?: string | null;
  source_type?: string | null;
  market?: string | null;
  language?: string | null;
  published_at?: string | null;
  captured_at: string;
  status: ReviewStatus;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  review_reason?: string | null;
}

export interface EvidencePage {
  evidence: Evidence[];
  total: number;
  page: number;
  size: number;
}

export interface AnalysisBriefRow {
  id: string;
  our_product_id?: string | null;
  competitor_ids: string[];
  purpose?: string | null;
  market?: string | null;
  time_range_start?: string | null;
  time_range_end?: string | null;
  included_sources: string[];
  excluded_sources: string[];
  max_runtime_seconds?: number | null;
  cost_budget?: number | null;
  allow_unverified?: number | null;
  created_by?: string | null;
  created_at?: string | null;
}

export interface RunStageRow {
  id: string;
  run_id: string;
  stage: StageKind;
  round: number;
  status: StageStatus;
  attempt: number;
  task_id?: string | null;
  input_ref?: { competitor_id?: string | null; [k: string]: unknown } | null;
  output_ref?: { result?: string | null; [k: string]: unknown } | null;
  model?: string | null;
  prompt_version?: string | null;
  tools?: string[];
  error_message?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string | null;
}

export interface RunDetailPayload {
  run: Run;
  brief: AnalysisBriefRow | null;
  stages: RunStageRow[];
  evidence: EvidencePage;
  artifacts: RunArtifacts;
  gate: {
    allowed: boolean;
    allow_unverified: boolean;
    total: number;
    verified: number;
    rejected: number;
  };
}

export interface RunArtifacts {
  insights: Array<{ id: string; topic: string; summary?: string | null; key_findings: string[]; confidence?: number | null; sources?: Array<{ title: string; url: string }> }>;
  matrices: Array<{ id: string; overall_assessment?: string | null; left_competitor?: string; right_competitor?: string; dimensions: Array<{ dimension: string; our_score?: number; competitor_score?: number; left_score?: number; right_score?: number; notes?: string }> }>;
  battlecards: Array<{ id: string; quality_score?: number | null; content: {
    elevator_pitch?: string; our_strengths?: string[]; our_weaknesses?: string[];
    competitor_strengths?: string[]; competitor_weaknesses?: string[];
    key_differentiators?: string[]; objection_handling?: Record<string, string>;
  } }>;
  reports: Array<{ id: string; version: number; status: string; content: { title?: string; summary?: string; [key: string]: unknown } }>;
}

export interface ClaimRow {
  id: string;
  run_id: string;
  statement: string;
  subject: string;
  claim_type?: string | null;
  market?: string | null;
  valid_at?: string | null;
  confidence: number;
  status: ReviewStatus;
  invalidated_at?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  review_reason?: string | null;
  created_at?: string | null;
  evidence_ids: string[];
}

export interface ClaimPage {
  claims: ClaimRow[];
  total: number;
  page: number;
  size: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  objective: string;
  business_context?: string | null;
  market: string;
  channels: string[];
  topics: string[];
  source_policy?: Record<string, unknown> | null;
  report_template?: string | null;
  alert_policy?: Record<string, unknown> | null;
  status?: string | null;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProjectMember {
  user_id: string;
  role: string;
  created_at?: string | null;
}

export interface ProjectSku {
  id: string;
  code: string;
  name: string;
  status?: string | null;
  side: 'ours' | 'competitor';
  series?: string | null;
  brand?: string | null;
  company?: string | null;
}

export interface ProjectDetailRow extends ProjectRow {
  members: ProjectMember[];
  products: ProjectSku[];
}

export interface ProjectDashboardRow {
  sku_count: number;
  our_sku_count: number;
  competitor_sku_count: number;
  price_snapshot_count: number;
  latest_price_at?: string | null;
  fresh_coverage: number;
  new_evidence: number;
  invalid_evidence: number;
  weekly_price_changes: number;
  weekly_parameter_changes: number;
  pending_reports: number;
}

export interface PriceSnapshotRow {
  id: string;
  sku_id: string;
  market: string;
  channel: string;
  list_price?: number | string | null;
  sale_price?: number | string | null;
  currency?: string | null;
  in_stock?: number | null;
  source_url?: string | null;
  evidence_id?: string | null;
  captured_at?: string | null;
  created_at?: string | null;
}

export interface TimelinePayload {
  products: Array<Record<string, unknown> & { parameters?: Record<string, unknown> }>;
  prices: PriceSnapshotRow[];
}
