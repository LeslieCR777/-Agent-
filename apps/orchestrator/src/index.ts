import { initDb } from '@api/db/index.js';
import { config } from '@platform/config.js';
import { logger } from '@platform/logger.js';
import { startSweeper, stopSweeper } from '@orchestrator/heartbeat/sweeper.js';
import { startScheduler, stopScheduler } from '@orchestrator/scheduler/index.js';
import { startOutboxDispatcher, stopOutboxDispatcher } from '@orchestrator/outbox/dispatcher.js';
import { createSchedule, listSchedules } from '@api/db/queries/schedules.js';
import { createCompetitor, listCompetitors } from '@api/db/queries/competitors.js';
import { CI_MONITOR_TEMPLATE, CI_SCHEDULE_NAME } from '@contracts/constants.js';

async function bootstrap(): Promise<void> {
  const schedules = await listSchedules();
  if (!schedules.some((item) => item.name === CI_SCHEDULE_NAME)) {
    await createSchedule({
      name: CI_SCHEDULE_NAME,
      cron: config.ciMonitorCron,
      task_template: CI_MONITOR_TEMPLATE,
    });
  }
  if (config.ciDemoMode && (await listCompetitors()).length === 0) {
    await createCompetitor({
      name: 'Demo 竞品 A',
      website: 'https://example.com',
      monitor_urls: ['https://example.com/pricing', 'https://example.com/careers'],
      notes: 'CI_DEMO_MODE 自动创建',
    });
  }
}

async function main(): Promise<void> {
  await initDb();
  await bootstrap();
  startSweeper();
  startScheduler();
  startOutboxDispatcher();
  logger.info('orchestrator', 'orchestrator started');
  const shutdown = () => {
    stopSweeper();
    stopScheduler();
    stopOutboxDispatcher();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.main) {
  main().catch((error) => {
    logger.error('orchestrator', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
