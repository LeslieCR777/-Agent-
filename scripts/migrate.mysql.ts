#!/usr/bin/env node
/**
 * MySQL 建库建表迁移脚本。
 * 用法：
 *   1. 在 .env 配好 MYSQL_HOST/PORT/USER/PASSWORD/DATABASE
 *   2. node --import tsx scripts/migrate.mysql.ts
 * 会连接 MySQL（自动创建库）并执行 src/db/schema.mysql.sql 全部 DDL（幂等）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../src/shared/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const schemaPath = resolve(__dirname, '../src/db/schema.mysql.sql');
  const sql = readFileSync(schemaPath, 'utf8');

  // 先无库连接（自动建库在 SQL 里），再建表
  const conn = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    multipleStatements: true,
  });
  console.log(`connected to ${config.mysql.host}:${config.mysql.port}`);
  try {
    await conn.query(sql);
    console.log('schema applied successfully (idempotent)');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
