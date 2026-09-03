#!/usr/bin/env node
/**
 * MySQL 建库建表迁移脚本。
 * 用法：
 *   1. 在 .env 配好 MYSQL_HOST/PORT/USER/PASSWORD/DATABASE
 *   2. node --import tsx scripts/migrate.mysql.ts
 * 会连接 MySQL 并执行当前目录的 schema.mysql.sql 全部 DDL（幂等）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '@platform/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const schemaPath = resolve(__dirname, 'schema.mysql.sql');
  const database = config.mysql.database;
  if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('MYSQL_DATABASE contains invalid characters');
  const sql = readFileSync(schemaPath, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(CREATE DATABASE|USE )/i.test(line))
    .join('\n');

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
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE \`${database}\``);
    await conn.query(sql);
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(200) PRIMARY KEY,
      applied_at VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const files = readdirSync(__dirname).filter((name) => name.endsWith('.migration.sql')).sort();
    for (const file of files) {
      const [rows] = await conn.query('SELECT version FROM schema_migrations WHERE version = ?', [file]);
      if (Array.isArray(rows) && rows.length) continue;
      await conn.beginTransaction();
      try {
        await conn.query(readFileSync(resolve(__dirname, file), 'utf8'));
        await conn.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [file, new Date().toISOString()]);
        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    }
    console.log(`schema applied successfully (${files.length} versioned migrations)`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
