import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { AGENT_WORKDIR } from '../shared/constants.js';

/**
 * 调用命令行 Agent（claude CLI）执行任务（需求文档 FR-2）。
 * 关键点：prompt 全走 stdin，spawn 参数不含动态内容 → Windows 下
 * 无引号/转义地狱。stdout 逐行回调（日志流式上报）。
 */

export interface RunnerCallbacks {
  onLog?: (line: string) => void;
}

export interface RunnerResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
}

/** 长任务超时保护：默认 30 分钟，防止 claude 卡死导致 Worker 空转 */
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

/**
 * 启动命令行 Agent 子进程（供 worker/lead/distill 复用）。
 * Windows 下 .cmd/.bat 包装必须走 shell，否则 EINVAL；prompt 由调用方写 stdin，
 * 不拼进命令，无 shell 注入面。
 */
export function spawnAgent(args: string[], opts: { cwd: string }): ChildProcess {
  const useShell = process.platform === 'win32';
  return useShell
    ? spawn([config.agentCli, ...args].join(' '), [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.cwd,
        env: { ...process.env },
        windowsHide: true,
        shell: true,
      })
    : spawn(config.agentCli, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.cwd,
        env: { ...process.env },
      });
}

export function runAgent(prompt: string, callbacks: RunnerCallbacks = {}): Promise<RunnerResult> {
  return new Promise((resolvePromise, reject) => {
    const workdir = resolveWorkspace();
    mkdirSync(workdir, { recursive: true });

    let child: ChildProcess;
    try {
      child = spawnAgent(['-p', '--output-format', 'text'], { cwd: workdir });
    } catch (err) {
      reject(err as Error);
      return;
    }

    let out = '';
    let errBuf = '';
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      logger.warn('runner', `agent killed after ${RUN_TIMEOUT_MS}ms (timeout)`);
      child.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);
    killTimer.unref?.();

    child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString();
      out += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) callbacks.onLog?.(trimmed);
      }
    });
    child.stderr?.on('data', (d: Buffer) => (errBuf += d.toString()));
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 && errBuf && !out) {
        logger.error('runner', `agent exit ${code}: ${errBuf.slice(0, 300)}`);
      }
      resolvePromise({ output: out, exitCode: code ?? -1, timedOut });
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

function resolveWorkspace(): string {
  return resolve(process.cwd(), AGENT_WORKDIR);
}
