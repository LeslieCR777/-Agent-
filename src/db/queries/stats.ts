import { getDb } from '../index.js';

/** 仪表盘统计（需求文档 5.4 GET /api/stats） */

export interface Stats {
  tasks_total: number;
  tasks_by_status: Record<string, number>;
  agents: { total: number; idle: number; busy: number; offline: number };
  memories_total: number;
  sessions_total: number;
  schedules_total: number;
  recent_events: { type: string; count: number }[];
}

export function getStats(): Stats {
  const d = getDb();
  const total = (d.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as unknown as { n: number }).n;

  const statusRows = d.prepare(`SELECT status, COUNT(*) AS n FROM tasks GROUP BY status`).all() as { status: string; n: number }[];
  const tasks_by_status: Record<string, number> = {};
  for (const r of statusRows) tasks_by_status[r.status] = r.n;

  const agentRows = d.prepare(`SELECT status, COUNT(*) AS n FROM agents GROUP BY status`).all() as { status: string; n: number }[];
  const agents = { total: agentRows.reduce((a, r) => a + r.n, 0), idle: 0, busy: 0, offline: 0 };
  for (const r of agentRows) if (r.status in agents) (agents as Record<string, number>)[r.status] = r.n;

  const memories_total = (d.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as unknown as { n: number }).n;
  const sessions_total = (d.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as unknown as { n: number }).n;
  const schedules_total = (d.prepare(`SELECT COUNT(*) AS n FROM scheduled_tasks`).get() as unknown as { n: number }).n;

  const recent = d
    .prepare(`SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC LIMIT 10`)
    .all() as { type: string; n: number }[];

  return {
    tasks_total: total,
    tasks_by_status,
    agents,
    memories_total,
    sessions_total,
    schedules_total,
    recent_events: recent.map((r) => ({ type: r.type, count: Number(r.n) })),
  };
}
