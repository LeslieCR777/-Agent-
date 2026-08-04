import { config } from './config.js';

/** 敏感值集合：密钥、Authorization 头。日志输出前一律 scrub。 */
const secrets = new Set<string>();
for (const v of [config.apiKey, config.embeddingApiKey, config.smtp.pass, config.serpApi.key, config.deepseek.apiKey, config.mysql.password]) {
  if (v) secrets.add(v);
}

export function registerSecret(v: string | undefined): void {
  if (v && v.length >= 4) secrets.add(v);
}

function scrub(msg: string): string {
  let out = msg;
  for (const s of secrets) {
    if (s) out = out.split(s).join('***');
  }
  // 兜底：Authorization: Bearer <token> / X-Api-Key 形式
  out = out.replace(/Authorization:\s*Bearer\s+[^\s,;]+/gi, 'Authorization: Bearer ***');
  out = out.replace(/x-api-key:\s*[^\s,;]+/gi, 'x-api-key: ***');
  return out;
}

const ts = (): string => new Date().toISOString();

type Level = 'info' | 'warn' | 'error' | 'debug';

function log(level: Level, scope: string, msg: string, extra?: unknown): void {
  const line = `${ts()} [${level}] [${scope}] ${msg}`;
  const clean = scrub(extra === undefined ? line : `${line} ${JSON.stringify(extra)}`);
  if (level === 'error') console.error(clean);
  else if (level === 'warn') console.warn(clean);
  else console.log(clean);
}

export const logger = {
  info: (scope: string, msg: string, extra?: unknown) => log('info', scope, msg, extra),
  warn: (scope: string, msg: string, extra?: unknown) => log('warn', scope, msg, extra),
  error: (scope: string, msg: string, extra?: unknown) => log('error', scope, msg, extra),
  debug: (scope: string, msg: string, extra?: unknown) => log('debug', scope, msg, extra),
};
