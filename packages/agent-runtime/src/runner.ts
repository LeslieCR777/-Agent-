import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '@platform/config.js';
import { logger } from '@platform/logger.js';
import { AGENT_WORKDIR } from '@contracts/constants.js';

/** Claude 原生 Messages API runner；CLI 代码仅作为离线测试适配器保留。 */

/** 单次 Agent 调用轨迹（Golden Trace）：prompt/output/耗时/模型。评估框架用，热路径无 sink 时零开销。 */
export interface AgentTrace {
  prompt: string;
  output: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  model: string;
  startedAt: string;
}

export interface RunnerCallbacks {
  onLog?: (line: string) => void;
  onTrace?: (t: AgentTrace) => void;
}

export interface RunnerResult {
  output: string;
  errorOutput: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/** 长任务超时保护，避免上游 API 无响应导致 Worker 长期占用。 */
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

/**
 * 启动离线测试 Agent 子进程。
 * Windows 下 .cmd/.bat 包装必须走 shell，否则 EINVAL；prompt 由调用方写 stdin，
 * 不拼进命令，无 shell 注入面。
 */
export function spawnAgent(args: string[], opts: { cwd: string }): ChildProcess {
  const useShell = process.platform === 'win32';
  const childEnv = { ...process.env };
  return useShell
    ? spawn([config.agentCli, ...args].join(' '), [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.cwd,
        env: childEnv,
        windowsHide: true,
        shell: true,
      })
    : spawn(config.agentCli, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.cwd,
        env: childEnv,
      });
}

/** 仅供离线 echo 测试组装参数。 */
export function agentArgs(): string[] {
  const args = ['-p', '--output-format', 'text'];
  if (config.agentModel) args.splice(1, 0, '--model', config.agentModel);
  return args;
}

async function runClaudeAgent(prompt: string, callbacks: RunnerCallbacks): Promise<RunnerResult> {
  const startedAt = Date.now();
  try {
    const baseUrl = config.anthropic.baseUrl.replace(/\/+$/, '');
    const response = await fetch(baseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.anthropic.apiKey,
        'anthropic-version': config.anthropic.version,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.agentModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8192,
        stream: false,
      }),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    const raw = await response.text();
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      return { output: '', errorOutput: 'Claude HTTP ' + response.status + ': ' + raw.slice(0, 2000), exitCode: 1, timedOut: false, durationMs };
    }
    const data = JSON.parse(raw) as {
      model?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    const output = (data.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    if (!output) {
      return { output: '', errorOutput: 'Claude returned empty content', exitCode: 1, timedOut: false, durationMs };
    }
    callbacks.onLog?.(output);
    callbacks.onTrace?.({
      prompt: prompt.slice(0, 4000), output: output.slice(0, 8000),
      exitCode: 0, timedOut: false, durationMs,
      model: data.model ?? config.agentModel, startedAt: new Date(startedAt).toISOString(),
    });
    return { output, errorOutput: '', exitCode: 0, timedOut: false, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      output: '', errorOutput: err instanceof Error ? err.message : String(err),
      exitCode: 1, timedOut, durationMs,
    };
  }
}

export function runAgent(prompt: string, callbacks: RunnerCallbacks = {}, opts: { cwd?: string } = {}): Promise<RunnerResult> {
  if (config.anthropic.apiKey) return runClaudeAgent(prompt, callbacks);
  // The echo adapter is retained only for existing offline tests. Runtime execution
  // never falls back to Claude CLI when API credentials are missing.
  if (config.agentCli !== 'echo') {
    return Promise.resolve({
      output: '',
      errorOutput: 'ANTHROPIC_API_KEY is required for Claude native API',
      exitCode: 1,
      timedOut: false,
      durationMs: 0,
    });
  }
  return new Promise((resolvePromise, reject) => {
    const workdir = opts.cwd ?? resolveWorkspace();
    mkdirSync(workdir, { recursive: true });
    const startedAt = Date.now();

    let child: ChildProcess;
    try {
      child = spawnAgent(agentArgs(), { cwd: workdir });
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
      const durationMs = Date.now() - startedAt;
      // Golden Trace：有 sink 才 emit（热路径零开销）
      callbacks.onTrace?.({
        prompt: prompt.slice(0, 4000),
        output: out.slice(0, 8000),
        exitCode: code ?? -1,
        timedOut,
        durationMs,
        model: config.agentModel,
        startedAt: new Date(startedAt).toISOString(),
      });
      resolvePromise({ output: out, errorOutput: errBuf.slice(0, 4000), exitCode: code ?? -1, timedOut, durationMs });
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

function resolveWorkspace(): string {
  return resolve(process.cwd(), AGENT_WORKDIR);
}

/**
 * 准备任务专属工作目录：<cwd>/.agent-workspace/tasks/<taskId>/。
 * attachments 为资产 id 列表（JSON 字符串），从 API 下载资产文件到该目录，
 * 让 prompt 可以写相对路径引用（如 "读取 ./data.csv"）。隔离各任务上下文。
 * await 确保资产在 Worker 执行前就位；单个资产下载失败不阻塞（记日志继续）。
 */
export async function prepareTaskDir(taskId: string, attachments: string | null): Promise<string> {
  const dir = resolve(resolveWorkspace(), 'tasks', taskId);
  mkdirSync(dir, { recursive: true });

  if (attachments) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(attachments) as string[];
    } catch {
      ids = [];
    }
    for (const id of ids) {
      try {
        const name = await downloadAssetInto(id, dir);
        logger.info('runner', `asset ${id.slice(0, 8)} -> ${name}`);
      } catch (err) {
        logger.warn('runner', `asset download failed ${id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return dir;
}

/** 从 API 下载资产到任务目录，返回落盘文件名（同步等待，Worker 执行前资产就位） */
async function downloadAssetInto(assetId: string, dir: string): Promise<string> {
  const res = await fetch(`${config.apiBaseUrl}/api/assets/${assetId}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`asset HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 用原始文件名落盘（从 Content-Disposition 取）
  const disp = res.headers.get('content-disposition') ?? '';
  const m = disp.match(/filename="?([^";]+)"?/i);
  const name = m ? decodeURIComponent(m[1]) : assetId;
  const safe = name.split(/[\\/]/).pop() ?? assetId;
  writeFileSync(resolve(dir, safe), buf);
  return safe;
}
