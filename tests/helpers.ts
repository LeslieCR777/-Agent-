/**
 * 测试环境准备：连 MySQL 测试库（agent_swarm_test），建表后跑用例。
 * 必须在 import 任何 db 模块之前调用（config 在模块加载时读 env）。
 */
/** 当前测试文件名（node:test 每个文件独立进程，process.argv[1] 是测试文件）→ 独立测试库名 */
function testDbName(): string {
  const base = 'agent_swarm_test';
  const arg = process.argv[1] ?? '';
  const m = arg.match(/([a-zA-Z0-9_-]+)\.test\.ts$/);
  return m ? `${base}_${m[1]}` : base;
}

export async function setupTestDb(): Promise<void> {
  process.env.EMBEDDING_API_KEY = ''; // 强制离线 embedding
  // CI 相关 env 清空：避免读到真实 .env 里的 SMTP/SERPAPI 配置
  process.env.CI_DEMO_MODE = '';
  process.env.SMTP_HOST = '';
  process.env.SMTP_PORT = '';
  process.env.SERPAPI_KEY = '';
  process.env.ALERT_EMAIL_TO = '';
  process.env.CI_QUALITY_THRESHOLD = '';
  process.env.CI_MAX_REFLEXION_ROUNDS = '';
  // 每个测试文件用独立库（node:test 并行跑文件，共享库会互相清表干扰）
  const dbName = testDbName();
  process.env.MYSQL_DATABASE = dbName;

  const { config } = await import('@platform/config.js');
  config.embeddingApiKey = '';
  config.agentCli = 'echo'; // 测试环境用 echo 模拟 agent（避免依赖 claude）
  config.ciDemoMode = false;
  config.smtp.host = '';
  config.smtp.port = 465;
  config.serpApi.key = '';
  config.alertEmailTo = [];
  config.ciQualityThreshold = 7;
  config.ciMaxReflexionRounds = 2;
  config.mysql.database = dbName;

  // 1. 先建测试库（连到无库连接），再让 initDb 建池时库已存在
  const mysql = await import('mysql2/promise');
  const adminConn = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    multipleStatements: true,
  });
  try {
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await adminConn.end();
  }

  // 2. 建池（库已存在）
  const { initDb } = await import('@api/db/index.js');
  await initDb();

  // 3. 每次 setup 建表 + 清空数据（本文件独立库，安全隔离）
  //    建表用独立连接（multipleStatements），清空用池连接
  const { readFileSync, readdirSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const schemaPath = resolve(process.cwd(), 'infrastructure/migrations/schema.mysql.sql');
  const schema = readFileSync(schemaPath, 'utf8');
  // 去掉 CREATE DATABASE / USE / SET NAMES 行（连接已绑定测试库），只留建表
  const tableSql = schema
    .split('\n')
    .filter((line) => !/^\s*(CREATE DATABASE|USE |SET NAMES)/i.test(line))
    .join('\n');
  const migrationDir = resolve(process.cwd(), 'infrastructure/migrations');
  const migrations = readdirSync(migrationDir)
    .filter((name) => name.endsWith('.migration.sql'))
    .sort()
    .map((name) => readFileSync(resolve(migrationDir, name), 'utf8'))
    .join('\n');

  const ddlConn = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: dbName,
    multipleStatements: true,
  });
  try {
    await ddlConn.query(`${tableSql}\n${migrations}`);
  } finally {
    await ddlConn.end();
  }

  // 清空所有表（用池连接 DELETE，避免 TRUNCATE 的 DDL 锁与并发语句冲突）
  const { getPool } = await import('@api/db/index.js');
  const pool = getPool();
  const [tables] = (await pool.query(`SHOW TABLES`)) as unknown as [{ [k: string]: string }[]];
  const names = tables.map((r) => Object.values(r)[0] as string);
  if (names.length) {
    await pool.query(`SET FOREIGN_KEY_CHECKS = 0`);
    for (const t of names) await pool.query(`DELETE FROM \`${t}\``);
    await pool.query(`SET FOREIGN_KEY_CHECKS = 1`);
  }
}

export async function teardownTestDb(): Promise<void> {
  try {
    const { closeDb } = await import('@api/db/index.js');
    await closeDb();
  } catch {
    /* ignore */
  }
}
