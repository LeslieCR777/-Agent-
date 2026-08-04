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
  // CI 相关 env 清空：避免读到真实 .env 里的 SMTP/SERPAPI 配置
  process.env.CI_DEMO_MODE = '';
  process.env.SMTP_HOST = '';
  process.env.SMTP_PORT = '';
  process.env.SERPAPI_KEY = '';
  process.env.ALERT_EMAIL_TO = '';
  process.env.CI_QUALITY_THRESHOLD = '';
  process.env.CI_MAX_REFLEXION_ROUNDS = '';
  // 清掉 .env 干扰：config 优先读已有 env，这里显式覆盖
  const { config } = await import('../src/shared/config.js');
  config.dbPath = process.env.DB_PATH;
  config.embeddingApiKey = '';
  config.agentCli = 'echo'; // 测试环境用 echo 模拟 agent（避免依赖 claude）
  config.ciDemoMode = false;
  config.smtp.host = '';
  config.smtp.port = 465;
  config.serpApi.key = '';
  config.alertEmailTo = [];
  config.ciQualityThreshold = 7;
  config.ciMaxReflexionRounds = 2;
  const { initDb } = await import('../src/db/index.js');
  initDb(); // 建表
  return;
}

export async function teardownTestDb(): Promise<void> {
  try {
    // 用 closeDb() 把单例 db 置 null，下次 initDb 重新打开新路径（避免测试间残留）
    const { closeDb } = await import('../src/db/index.js');
    closeDb();
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
