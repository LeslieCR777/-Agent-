import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ENV,
  DEFAULT_PORT,
  DEFAULT_API_KEY,
  DEFAULT_DB_PATH,
  MAX_ASSIGN_COUNT,
} from './constants.js';

/**
 * 极简 .env loader：逐行解析 KEY=VALUE（忽略 # 注释与空行）。
 * 进程级缓存，读取一次。
 */
function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    // 已有环境变量优先（命令行注入 > .env）
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

const int = (v: string | undefined, d: number): number =>
  v === undefined || v === '' ? d : Number.parseInt(v, 10);

export interface Config {
  port: number;
  apiKey: string;
  dbPath: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  sweepIntervalMs: number;
  maxAssignCount: number;
  agentCli: string;
  workerPollIntervalMs: number;
  apiBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingBaseUrl: string;
  leadPollIntervalMs: number;
}

export const config: Config = {
  port: int(process.env[ENV.PORT], DEFAULT_PORT),
  apiKey: process.env[ENV.API_KEY] || DEFAULT_API_KEY,
  dbPath: process.env[ENV.DB_PATH] || DEFAULT_DB_PATH,
  heartbeatIntervalMs: int(process.env[ENV.HEARTBEAT_INTERVAL_MS], 5000),
  heartbeatTimeoutMs: int(process.env[ENV.HEARTBEAT_TIMEOUT_MS], 30000),
  sweepIntervalMs: int(process.env[ENV.SWEEP_INTERVAL_MS], 1000),
  maxAssignCount: int(process.env[ENV.MAX_ASSIGN_COUNT], MAX_ASSIGN_COUNT),
  agentCli: process.env[ENV.AGENT_CLI] || 'claude',
  workerPollIntervalMs: int(process.env[ENV.WORKER_POLL_INTERVAL_MS], 3000),
  apiBaseUrl: process.env[ENV.API_BASE_URL] || `http://127.0.0.1:3013`,
  embeddingApiKey: process.env[ENV.EMBEDDING_API_KEY] || '',
  embeddingModel: process.env[ENV.EMBEDDING_MODEL] || 'text-embedding-3-small',
  embeddingBaseUrl: process.env[ENV.EMBEDDING_BASE_URL] || 'https://api.openai.com',
  leadPollIntervalMs: int(process.env[ENV.LEAD_POLL_INTERVAL_MS], 5000),
};
