import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 测试环境准备：每个测试文件（独立进程）用独立临时 DB。
 * 必须在 import 任何 db 模块之前调用（config 在模块加载时读 env）。
 */
export async function setupTestDb(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-swarm-test-'));
  process.env.DB_PATH = join(dir, 'test.sqlite');
  process.env.EMBEDDING_API_KEY = ''; // 强制离线 embedding
  // 清掉 .env 干扰：config 优先读已有 env，这里显式覆盖
  const { config } = await import('../src/shared/config.js');
  config.dbPath = process.env.DB_PATH;
  config.embeddingApiKey = '';
  config.agentCli = 'echo'; // 测试环境用 echo 模拟 agent（避免依赖 claude）
  const { initDb } = await import('../src/db/index.js');
  initDb(); // 建表
  return;
}

export async function teardownTestDb(): Promise<void> {
  try {
    // 先关掉 sqlite 连接，Windows 下文件句柄占用会导致 EPERM
    const { getDb } = await import('../src/db/index.js');
    const d = (getDb as unknown as { close?: () => void });
    d.close?.();
  } catch {
    /* ignore */
  }
  const dir = tmpdirFor();
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 偶发 EPERM，忽略 */
    }
  }
}

function tmpdirFor(): string {
  const p = process.env.DB_PATH ?? '';
  const sep = p.includes('\\') ? '\\' : '/';
  if (p.includes('agent-swarm-test-')) {
    return p.slice(0, p.lastIndexOf(sep));
  }
  return '';
}
