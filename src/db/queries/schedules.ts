import { newId, nowIso, query, exec } from '../index.js';
import type { ScheduledTask } from '../../shared/types.js';

/** 定时任务读写（需求文档 4.5，MySQL 异步版） */

export interface CreateScheduleInput {
  name: string;
  cron: string;
  task_template: string;
  enabled?: boolean;
}

export async function createSchedule(input: CreateScheduleInput): Promise<ScheduledTask> {
  const row: ScheduledTask = {
    id: newId(),
    name: input.name,
    cron: input.cron,
    task_template: input.task_template,
    enabled: input.enabled === false ? 0 : 1,
    last_run_at: null,
    created_at: nowIso(),
  };
  await exec(
    `INSERT INTO scheduled_tasks (id, name, cron, task_template, enabled, last_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.name, row.cron, row.task_template, row.enabled, row.last_run_at, row.created_at]
  );
  return row;
}

export async function listSchedules(enabledOnly = false): Promise<ScheduledTask[]> {
  if (enabledOnly) {
    return query<ScheduledTask>(`SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY created_at ASC`);
  }
  return query<ScheduledTask>(`SELECT * FROM scheduled_tasks ORDER BY created_at ASC`);
}

export async function getSchedule(id: string): Promise<ScheduledTask | null> {
  const rows = await query<ScheduledTask>(`SELECT * FROM scheduled_tasks WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function updateScheduleLastRun(id: string, runAt: string): Promise<void> {
  await exec(`UPDATE scheduled_tasks SET last_run_at = ? WHERE id = ?`, [runAt, id]);
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const affected = await exec(`DELETE FROM scheduled_tasks WHERE id = ?`, [id]);
  return affected === 1;
}

export async function toggleSchedule(id: string, enabled: boolean): Promise<ScheduledTask | null> {
  await exec(`UPDATE scheduled_tasks SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
  return getSchedule(id);
}
