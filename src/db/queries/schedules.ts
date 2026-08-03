import { getDb, newId, nowIso } from '../index.js';
import type { ScheduledTask } from '../../shared/types.js';

/** 定时任务读写（需求文档 4.5） */

export interface CreateScheduleInput {
  name: string;
  cron: string;
  task_template: string;
  enabled?: boolean;
}

export function createSchedule(input: CreateScheduleInput): ScheduledTask {
  const row: ScheduledTask = {
    id: newId(),
    name: input.name,
    cron: input.cron,
    task_template: input.task_template,
    enabled: input.enabled === false ? 0 : 1,
    last_run_at: null,
    created_at: nowIso(),
  };
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks (id, name, cron, task_template, enabled, last_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.id, row.name, row.cron, row.task_template, row.enabled, row.last_run_at, row.created_at);
  return row;
}

export function listSchedules(enabledOnly = false): ScheduledTask[] {
  if (enabledOnly) {
    return getDb()
      .prepare(`SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY created_at ASC`)
      .all() as unknown as ScheduledTask[];
  }
  return getDb().prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at ASC`).all() as unknown as ScheduledTask[];
}

export function getSchedule(id: string): ScheduledTask | null {
  const row = getDb().prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id);
  return (row as unknown as ScheduledTask | undefined) ?? null;
}

export function updateScheduleLastRun(id: string, runAt: string): void {
  getDb().prepare(`UPDATE scheduled_tasks SET last_run_at = ? WHERE id = ?`).run(runAt, id);
}

export function deleteSchedule(id: string): boolean {
  const res = getDb().prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
  return res.changes === 1;
}

export function toggleSchedule(id: string, enabled: boolean): ScheduledTask | null {
  const d = getDb();
  d.prepare(`UPDATE scheduled_tasks SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
  return getSchedule(id);
}
