import { query } from '../index.js';

/** 仪表盘统计（需求文档 5.4 GET /api/stats，MySQL 异步版） */

export interface Stats {
  tasks_total: number;
  tasks_by_status: Record<string, number>;
  agents: { total: number; idle: number; busy: number; offline: number };
  memories_total: number;
  sessions_total: number;
  schedules_total: number;
  ci_competitors: number;
  ci_changes: number;
  ci_alerts: number;
  recent_events: { type: string; count: number }[];
}

export async function getStats(): Promise<Stats> {
  const count = async (sql: string, params: unknown[] = []): Promise<number> => {
    const rows = await query<{ n: number }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  };

  const tasks_total = await count(`SELECT COUNT(*) AS n FROM tasks`);

  const statusRows = await query<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM tasks GROUP BY status`
  );
  const tasks_by_status: Record<string, number> = {};
  for (const r of statusRows) tasks_by_status[r.status] = Number(r.n);

  const agentRows = await query<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM agents GROUP BY status`
  );
  const agents = { total: agentRows.reduce((a, r) => a + Number(r.n), 0), idle: 0, busy: 0, offline: 0 };
  for (const r of agentRows) if (r.status in agents) (agents as Record<string, number>)[r.status] = Number(r.n);

  const memories_total = await count(`SELECT COUNT(*) AS n FROM memories`);
  const sessions_total = await count(`SELECT COUNT(*) AS n FROM sessions`);
  const schedules_total = await count(`SELECT COUNT(*) AS n FROM scheduled_tasks`);

  // CI 统计（新表在旧库上可能不存在，容错返回 0）
  let ci_competitors = 0, ci_changes = 0, ci_alerts = 0;
  try {
    ci_competitors = await count(`SELECT COUNT(*) AS n FROM competitors`);
    ci_changes = await count(`SELECT COUNT(*) AS n FROM competitor_changes`);
    ci_alerts = await count(`SELECT COUNT(*) AS n FROM alerts`);
  } catch { /* 旧库无 CI 表 */ }

  const recent = await query<{ type: string; n: number }>(
    `SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC LIMIT 10`
  );

  return {
    tasks_total,
    tasks_by_status,
    agents,
    memories_total,
    sessions_total,
    schedules_total,
    ci_competitors,
    ci_changes,
    ci_alerts,
    recent_events: recent.map((r) => ({ type: r.type, count: Number(r.n) })),
  };
}
