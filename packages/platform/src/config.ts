import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ENV,
  DEFAULT_PORT,
  DEFAULT_API_KEY,
  DEFAULT_SERVICE_API_KEY,
  MAX_ASSIGN_COUNT,
  CI_QUALITY_THRESHOLD,
  CI_MAX_REFLEXION_ROUNDS,
} from '@contracts/constants.js';

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
    let v = t.slice(eq + 1).trim();
    // 去掉行内注释（标准 dotenv 行为：值里以空格开头后的 # 视为注释）
    const hashIdx = v.indexOf(' #');
    if (hashIdx !== -1) v = v.slice(0, hashIdx).trim();
    // 去掉可能包裹值的引号
    if (v.length >= 2 && (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    // 已有环境变量优先（命令行注入 > .env）
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

const int = (v: string | undefined, d: number): number =>
  v === undefined || v === '' ? d : Number.parseInt(v, 10);

const bool = (v: string | undefined, d: boolean): boolean =>
  v === undefined || v === '' ? d : v === 'true' || v === '1';

const splitList = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export interface Config {
  port: number;
  webOrigins: string[];
  apiKey: string;
  serviceApiKey: string;
  allowLegacyApiKey: boolean;
  adminUsername: string;
  adminPassword: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  sweepIntervalMs: number;
  maxAssignCount: number;
  agentCli: string;
  agentModel: string;
  anthropic: { apiKey: string; baseUrl: string; version: string };
  workerPollIntervalMs: number;
  apiBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingBaseUrl: string;
  leadPollIntervalMs: number;
  // ── MySQL 存储 ──
  mysql: { host: string; port: number; user: string; password: string; database: string };
  // ── DeepSeek 评审 ──
  deepseek: { apiKey: string; baseUrl: string; model: string };
  ciJudgeCount: number;
  // ── CI 竞品情报 ──
  ourProduct: { name: string; website: string; positioning: string; targetMarket: string };
  ciMonitorCron: string;
  ciQualityThreshold: number;
  ciMaxReflexionRounds: number;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string; from: string };
  alertEmailTo: string[];
  serpApi: { key: string; baseUrl: string; engine: string };
  ciDemoMode: boolean;
}

export const config: Config = {
  port: int(process.env[ENV.PORT], DEFAULT_PORT),
  webOrigins: splitList(process.env[ENV.WEB_ORIGINS] || 'http://localhost:5173'),
  apiKey: process.env[ENV.API_KEY] || DEFAULT_API_KEY,
  serviceApiKey: process.env[ENV.SERVICE_API_KEY] || DEFAULT_SERVICE_API_KEY,
  allowLegacyApiKey: bool(process.env[ENV.ALLOW_LEGACY_API_KEY], true),
  adminUsername: process.env[ENV.ADMIN_USERNAME] || '',
  adminPassword: process.env[ENV.ADMIN_PASSWORD] || '',
  heartbeatIntervalMs: int(process.env[ENV.HEARTBEAT_INTERVAL_MS], 5000),
  heartbeatTimeoutMs: int(process.env[ENV.HEARTBEAT_TIMEOUT_MS], 30000),
  sweepIntervalMs: int(process.env[ENV.SWEEP_INTERVAL_MS], 1000),
  maxAssignCount: int(process.env[ENV.MAX_ASSIGN_COUNT], MAX_ASSIGN_COUNT),
  agentCli: process.env[ENV.AGENT_CLI] || 'claude',
  agentModel: process.env[ENV.AGENT_MODEL] || 'claude-sonnet-5',
  anthropic: {
    apiKey: process.env[ENV.ANTHROPIC_API_KEY] || '',
    baseUrl: process.env[ENV.ANTHROPIC_BASE_URL] || 'https://api.openai-proxy.org/anthropic',
    version: process.env[ENV.ANTHROPIC_VERSION] || '2023-06-01',
  },
  workerPollIntervalMs: int(process.env[ENV.WORKER_POLL_INTERVAL_MS], 3000),
  apiBaseUrl: process.env[ENV.API_BASE_URL] || `http://127.0.0.1:3013`,
  embeddingApiKey: process.env[ENV.EMBEDDING_API_KEY] || '',
  embeddingModel: process.env[ENV.EMBEDDING_MODEL] || 'text-embedding-3-small',
  embeddingBaseUrl: process.env[ENV.EMBEDDING_BASE_URL] || 'https://api.openai.com',
  leadPollIntervalMs: int(process.env[ENV.LEAD_POLL_INTERVAL_MS], 5000),
  // ── MySQL 存储 ──
  mysql: {
    host: process.env[ENV.MYSQL_HOST] || '127.0.0.1',
    port: int(process.env[ENV.MYSQL_PORT], 3306),
    user: process.env[ENV.MYSQL_USER] || 'root',
    password: process.env[ENV.MYSQL_PASSWORD] || '',
    database: process.env[ENV.MYSQL_DATABASE] || 'agent_swarm',
  },
  // ── DeepSeek 评审 ──
  deepseek: {
    apiKey: process.env[ENV.DEEPSEEK_API_KEY] || '',
    baseUrl: process.env[ENV.DEEPSEEK_BASE_URL] || 'https://api.deepseek.com',
    model: process.env[ENV.DEEPSEEK_MODEL] || 'deepseek-chat',
  },
  ciJudgeCount: Math.min(int(process.env[ENV.CI_JUDGE_COUNT], 3), 5),
  // ── CI 竞品情报 ──
  ourProduct: {
    name: process.env[ENV.OUR_PRODUCT_NAME] || '我们（请配置 OUR_PRODUCT_NAME）',
    website: process.env[ENV.OUR_PRODUCT_WEBSITE] || '',
    positioning: process.env[ENV.OUR_PRODUCT_POSITIONING] || '',
    targetMarket: process.env[ENV.OUR_TARGET_MARKET] || '',
  },
  ciMonitorCron: process.env[ENV.CI_MONITOR_CRON] || '0 9 * * *',
  ciQualityThreshold: int(process.env[ENV.CI_QUALITY_THRESHOLD], CI_QUALITY_THRESHOLD),
  ciMaxReflexionRounds: int(process.env[ENV.CI_MAX_REFLEXION_ROUNDS], CI_MAX_REFLEXION_ROUNDS),
  smtp: {
    host: process.env[ENV.SMTP_HOST] || '',
    port: int(process.env[ENV.SMTP_PORT], 465),
    secure: bool(process.env[ENV.SMTP_SECURE], true),
    user: process.env[ENV.SMTP_USER] || '',
    pass: process.env[ENV.SMTP_PASS] || '',
    from: process.env[ENV.SMTP_FROM] || '',
  },
  alertEmailTo: splitList(process.env[ENV.ALERT_EMAIL_TO]),
  serpApi: {
    key: process.env[ENV.SERPAPI_KEY] || '',
    baseUrl: process.env[ENV.SERPAPI_BASE_URL] || 'https://serpapi.com/search.json',
    engine: process.env[ENV.SEARCH_ENGINE] || 'google',
  },
  ciDemoMode: bool(process.env[ENV.CI_DEMO_MODE], false),
};
