import type { TaskStatus } from './types.js';

/** 环境变量名（集中管理，避免拼写漂移） */
export const ENV = {
  PORT: 'PORT',
  API_KEY: 'API_KEY',
  DB_PATH: 'DB_PATH',
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
} as const;

export const DEFAULT_PORT = 3013;
export const DEFAULT_API_KEY = 'dev-123123';
export const DEFAULT_DB_PATH = './agent-swarm.sqlite';

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
