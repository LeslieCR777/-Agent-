import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { apiAsAgent } from './client.js';

/**
 * Worker 心跳线程（需求文档 FR-3）：每 HEARTBEAT_INTERVAL_MS 上报一次。
 * 独立于任务循环运行，任务执行期间也持续上报。
 */

export class Heartbeater {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastError = '';

  constructor(private agentId: string) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.ping();
    }, config.heartbeatIntervalMs);
    this.timer.unref?.();
    logger.info('heartbeat', `heartbeater started every ${config.heartbeatIntervalMs}ms`);
  }

  async ping(): Promise<void> {
    if (this.stopped) return;
    try {
      await apiAsAgent(this.agentId, `/api/agents/${this.agentId}/heartbeat`, { method: 'POST' });
      this.lastError = '';
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // 不打断任务执行：心跳失败多次由服务端超时兜底
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
