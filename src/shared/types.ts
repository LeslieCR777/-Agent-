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
export type TaskSource = 'api' | 'slack' | 'github' | 'schedule';

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
  | 'log';

export interface AppEvent {
  id: string;
  task_id: string | null;
  agent_id: string | null;
  type: EventType;
  payload: string | null; // JSON 字符串
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
