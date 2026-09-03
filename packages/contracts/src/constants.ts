import type { TaskStatus } from './types.js';

/** 环境变量名（集中管理，避免拼写漂移） */
export const ENV = {
  PORT: 'PORT',
  WEB_ORIGINS: 'WEB_ORIGINS',
  API_KEY: 'API_KEY',
  SERVICE_API_KEY: 'SERVICE_API_KEY',
  ALLOW_LEGACY_API_KEY: 'ALLOW_LEGACY_API_KEY',
  ADMIN_USERNAME: 'ADMIN_USERNAME',
  ADMIN_PASSWORD: 'ADMIN_PASSWORD',
  HEARTBEAT_INTERVAL_MS: 'HEARTBEAT_INTERVAL_MS',
  HEARTBEAT_TIMEOUT_MS: 'HEARTBEAT_TIMEOUT_MS',
  SWEEP_INTERVAL_MS: 'SWEEP_INTERVAL_MS',
  MAX_ASSIGN_COUNT: 'MAX_ASSIGN_COUNT',
  AGENT_CLI: 'AGENT_CLI',
  WORKER_POLL_INTERVAL_MS: 'WORKER_POLL_INTERVAL_MS',
  API_BASE_URL: 'API_BASE_URL',
  EMBEDDING_API_KEY: 'EMBEDDING_API_KEY',
  EMBEDDING_MODEL: 'EMBEDDING_MODEL',
  EMBEDDING_BASE_URL: 'EMBEDDING_BASE_URL',
  LEAD_POLL_INTERVAL_MS: 'LEAD_POLL_INTERVAL_MS',
  // ── CI 竞品情报 ──
  OUR_PRODUCT_NAME: 'OUR_PRODUCT_NAME',
  OUR_PRODUCT_WEBSITE: 'OUR_PRODUCT_WEBSITE',
  OUR_PRODUCT_POSITIONING: 'OUR_PRODUCT_POSITIONING',
  OUR_TARGET_MARKET: 'OUR_TARGET_MARKET',
  CI_MONITOR_CRON: 'CI_MONITOR_CRON',
  CI_QUALITY_THRESHOLD: 'CI_QUALITY_THRESHOLD',
  CI_MAX_REFLEXION_ROUNDS: 'CI_MAX_REFLEXION_ROUNDS',
  SMTP_HOST: 'SMTP_HOST',
  SMTP_PORT: 'SMTP_PORT',
  SMTP_SECURE: 'SMTP_SECURE',
  SMTP_USER: 'SMTP_USER',
  SMTP_PASS: 'SMTP_PASS',
  SMTP_FROM: 'SMTP_FROM',
  ALERT_EMAIL_TO: 'ALERT_EMAIL_TO',
  SERPAPI_KEY: 'SERPAPI_KEY',
  SERPAPI_BASE_URL: 'SERPAPI_BASE_URL',
  SEARCH_ENGINE: 'SEARCH_ENGINE',
  CI_DEMO_MODE: 'CI_DEMO_MODE',
  // ── MySQL 存储 ──
  MYSQL_HOST: 'MYSQL_HOST',
  MYSQL_PORT: 'MYSQL_PORT',
  MYSQL_USER: 'MYSQL_USER',
  MYSQL_PASSWORD: 'MYSQL_PASSWORD',
  MYSQL_DATABASE: 'MYSQL_DATABASE',
  // ── 模型 ──
  AGENT_MODEL: 'AGENT_MODEL',
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  ANTHROPIC_BASE_URL: 'ANTHROPIC_BASE_URL',
  ANTHROPIC_VERSION: 'ANTHROPIC_VERSION',
  DEEPSEEK_API_KEY: 'DEEPSEEK_API_KEY',
  DEEPSEEK_BASE_URL: 'DEEPSEEK_BASE_URL',
  DEEPSEEK_MODEL: 'DEEPSEEK_MODEL',
  CI_JUDGE_COUNT: 'CI_JUDGE_COUNT',
} as const;

export const DEFAULT_PORT = 3013;
export const DEFAULT_API_KEY = 'dev-123123';
export const DEFAULT_SERVICE_API_KEY = 'dev-worker-123123';

/** 任务状态机合法迁移表（唯一事实来源，PATCH /status 校验用） */
export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  unassigned: ['claimed'],
  claimed: ['in_progress', 'failed', 'superseded'],
  in_progress: ['completed', 'failed', 'superseded'],
  completed: [],
  failed: [],
  superseded: [],
  stale: ['unassigned', 'failed'], // stale 为瞬态，由清扫器驱动
};

/** 该状态允许谁上报（空 = 任何 agent；'current' = 仅认领该任务的 agent） */
export const STATUS_UPDATER: Record<TaskStatus, 'current' | 'any'> = {
  unassigned: 'any',
  claimed: 'current',
  in_progress: 'current',
  completed: 'any',
  failed: 'any',
  superseded: 'any',
  stale: 'any',
};

export const DEFAULT_PRIORITY = 5;
export const PRIORITY_MIN = 1;
export const PRIORITY_MAX = 10;

export const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'superseded'];

/** 认领上限：超过即 failed，防无限重派 */
export const MAX_ASSIGN_COUNT = 3;
/** 领取任务的强制 Work 目录（隔离 agent 上下文，不污染 AgentWork） */
export const AGENT_WORKDIR = '.agent-workspace';

// ── CI 竞品情报常量 ──

/** CI 任务统一 tag（tasks.tags[0] === 'ci' 即 CI 任务） */
export const CI_TAG = 'ci';

/** 每日竞品监控调度任务的任务模板标记（Worker 据此识别为 daily_monitor 任务） */
export const CI_MONITOR_TEMPLATE = 'CI_DAILY_MONITOR';

/** CI 流水线 stage 顺序（orchestrator 接力用） */
export const CI_STAGE_ORDER: readonly string[] = ['monitor', 'research', 'compare', 'battlecard', 'quality'];

/** Battlecard 质检默认门槛（1-10，低于则回 research 重搜） */
export const CI_QUALITY_THRESHOLD = 7;

/** Reflexion 质量循环最大轮次（round 从 0 起，最多回炉 MAX 次） */
export const CI_MAX_REFLEXION_ROUNDS = 2;

/** CI stage 任务优先级（比默认 5 高，优先被 Worker 领取） */
export const CI_STAGE_PRIORITY = 4;

/** CI 任务默认 schedule 名（server.ts 启动时自动创建） */
export const CI_SCHEDULE_NAME = '每日竞品监控';
