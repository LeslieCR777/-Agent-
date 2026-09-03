import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '@platform/config.js';
import { stubFetch } from '../demo.js';

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
  fetchMs: number;
}

const UA = 'CI-Agent-Swarm/1.0 (+safe-fetch; contact=administrator)';
const MAX_RETRIES = 3;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'application/json'];

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function isForbiddenIp(address: string): boolean {
  if (address === '::1' || address === '::' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return true;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(normalized) !== 4) return false;
  const [a, b] = normalized.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function assertSafeHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeUrlError('invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UnsafeUrlError('only HTTP/HTTPS is allowed');
  if (url.username || url.password) throw new UnsafeUrlError('URL credentials are forbidden');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
    throw new UnsafeUrlError('local or metadata host is forbidden');
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => isForbiddenIp(item.address))) {
    throw new UnsafeUrlError('private, loopback, link-local or reserved address is forbidden');
  }
  return url;
}

async function readLimitedBody(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Error('response body exceeds 10 MB');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('response body exceeds 10 MB');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

async function fetchWithSafeRedirects(raw: string): Promise<Response> {
  let url = await assertSafeHttpUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: ALLOWED_CONTENT_TYPES.join(',') },
      signal: AbortSignal.timeout(30_000),
      redirect: 'manual',
    });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    if (hop === MAX_REDIRECTS) throw new Error('too many redirects');
    url = await assertSafeHttpUrl(new URL(location, url).toString());
  }
  throw new Error('redirect validation failed');
}

/** 每次请求和每一跳重定向均执行 SSRF 校验，并限制类型与正文大小。 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  if (config.ciDemoMode) {
    const stub = stubFetch(url);
    return { url, finalUrl: url, status: 200, contentType: 'text/html', html: stub.html, fetchMs: 0 };
  }
  const start = Date.now();
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithSafeRedirects(url);
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.includes(contentType)) throw new Error(`content type not allowed: ${contentType || 'unknown'}`);
      const html = await readLimitedBody(res);
      return { url, finalUrl: res.url || url, status: res.status, contentType, html, fetchMs: Date.now() - start };
    } catch (err) {
      lastErr = err;
      if (err instanceof UnsafeUrlError) throw err;
      if (attempt < MAX_RETRIES - 1) await sleep(500 * 2 ** attempt);
    }
  }
  throw new Error(`fetch ${url} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
