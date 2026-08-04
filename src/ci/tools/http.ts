import { config } from '../../shared/config.js';
import { stubFetch } from '../demo.js';

/** HTTP 抓取（三级检测第二级：结构化抽取的输入）。UA 头 + 重试 + 超时。 */
export interface FetchedPage {
  url: string;
  status: number;
  html: string;
  fetchMs: number;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MAX_RETRIES = 3;

/** GET 页面 HTML；demo 模式返回桩页面。单 URL 失败抛错（由调用方逐 URL 容错）。 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  if (config.ciDemoMode) {
    const stub = stubFetch(url);
    return { url, status: 200, html: stub.html, fetchMs: 0 };
  }
  const start = Date.now();
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
      });
      const html = await res.text();
      return { url, status: res.status, html, fetchMs: Date.now() - start };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES - 1) await sleep(500 * 2 ** attempt);
    }
  }
  throw new Error(`fetch ${url} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
