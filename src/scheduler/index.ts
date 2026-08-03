import { CronExpressionParser } from 'cron-parser';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { nowIso } from '../db/index.js';
import { listSchedules, updateScheduleLastRun } from '../db/queries/schedules.js';
import { createTask } from '../db/queries/tasks.js';
import { withTransaction } from '../db/index.js';

/**
 * cron 调度器（需求文档 FR-6）。
 * 每 1s 检查一次 enabled 的定时任务：用 cron-parser 从 last_run_at 之后
 * 的下一次触发时间判断，若已到点 → 填 {date} 变量创建任务，
 * 并在同一事务内推进 last_run_at，防止重复触发 / 漏触发。
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

const TICK_MS = 1000;

export function startScheduler(): void {
  if (timer) return;
  logger.info('scheduler', `starting (tick=${TICK_MS}ms)`);
  timer = setInterval(() => {
    void runSchedulerTick();
  }, TICK_MS);
  timer.unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function runSchedulerTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    for (const schedule of listSchedules(true)) {
      const lastRun = schedule.last_run_at ? new Date(schedule.last_run_at) : null;
      try {
        // 首次调度（lastRun 为 null）：基准取 now 前 1 秒，使"刚落地的整点"
        // 也能被 next()（严格大于基准）捕捉到，避免整点被跳过、又不从 epoch 追不完
        const base = lastRun ?? new Date(now.getTime() - 1000);
        const next = nextFireTime(schedule.cron, base);
        if (next === null) continue;
        // 到点了（next 落在过去或刚好现在）且该 next 尚未触发过
        if (next.getTime() <= now.getTime() && (!lastRun || next.getTime() > lastRun.getTime())) {
          fire(schedule.id, schedule.task_template, schedule.name, next);
        }
      } catch (err) {
        logger.error('scheduler', `schedule ${schedule.id} error: ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    running = false;
  }
}

function nextFireTime(cron: string, after: Date): Date | null {
  // 容错：从 after 之后找第一次触发
  const interval = CronExpressionParser.parse(cron, { currentDate: after, tz: 'Asia/Shanghai' });
  try {
    const n = interval.next();
    return n.toDate();
  } catch {
    return null; // 超出可用范围（如 * * * * * 在边界）
  }
}

function fire(scheduleId: string, template: string, name: string, at: Date): void {
  withTransaction(() => {
    // 二次确认：last_run_at 未被其他 tick 推进（防止多实例/重入）
    const s = listSchedules(true).find((x) => x.id === scheduleId);
    if (!s) return;
    const lastRun = s.last_run_at ? new Date(s.last_run_at) : null;
    if (lastRun && lastRun.getTime() >= at.getTime()) return;

    const prompt = renderTemplate(template, at);
    const task = createTask({
      title: `[定时] ${name}`,
      prompt,
      source: 'schedule',
      priority: 5,
    });
    updateScheduleLastRun(scheduleId, at.toISOString());
    logger.info('scheduler', `fired "${name}" at ${at.toISOString()} -> task ${task.id.slice(0, 8)}`);
  });
}

/** 模板渲染：支持 {date} / {time} / {yyyy-mm-dd} 等变量 */
function renderTemplate(template: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = at.getFullYear();
  const mm = pad(at.getMonth() + 1);
  const dd = pad(at.getDate());
  const hh = pad(at.getHours());
  const min = pad(at.getMinutes());
  return template
    .replaceAll('{date}', `${yyyy}-${mm}-${dd}`)
    .replaceAll('{yyyy-mm-dd}', `${yyyy}-${mm}-${dd}`)
    .replaceAll('{time}', `${hh}:${min}`)
    .replaceAll('{now}', at.toISOString());
}
