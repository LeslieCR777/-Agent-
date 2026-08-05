import { config } from '../../shared/config.js';
import { stubSearch } from '../demo.js';

export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

export interface NewsResult {
  title: string;
  link: string;
  date: string | null;
  source: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

/**
 * 搜索策略：
 * 1. 配了 SERPAPI_KEY → 用 SerpAPI（稳定，接口已适配）
 * 2. 无 key / demo 模式 → 用 Bing 网页搜索（免费无 key，真实结果）
 * 3. Bing 失败 → 回退 demo 桩（保证链路不中断）
 */

/** SerpAPI 搜索 */
async function serpSearch(query: string, numResults: number, engine: string): Promise<{ title: string; link: string; snippet: string }[]> {
  const params = new URLSearchParams({
    engine,
    q: query,
    api_key: config.serpApi.key,
    num: String(numResults),
  });
  const res = await fetch(`${config.serpApi.baseUrl}?${params}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  const data = (await res.json()) as { organic_results?: { title?: string; link?: string; snippet?: string }[] };
  return (data.organic_results ?? []).slice(0, numResults).map((r) => ({
    title: r.title ?? '',
    link: r.link ?? '',
    snippet: r.snippet ?? '',
  }));
}

/**
 * Bing 网页搜索（无 key）。解析 <li class="b_algo"> 结构。
 * 返回 title/link/snippet；失败抛错由调用方降级。
 */
export async function bingSearch(query: string, numResults = 6): Promise<SearchResult[]> {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${numResults}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const html = await res.text();
  const out: SearchResult[] = [];
  // 匹配 <li class="b_algo"> 块
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const href = block.match(/<a[^>]*href="([^"]+)"/);
    const title = block.match(/<a[^>]*>(.*?)<\/a>/)?.[1] ?? '';
    // 摘要：b_caption / b_lineclamp 段落
    const snippet = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1]
      ?? block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1]
      ?? '';
    if (href && title) {
      out.push({
        title: stripHtml(title).trim().slice(0, 120),
        link: decodeBingLink(href[1]),
        snippet: stripHtml(snippet).trim().slice(0, 300),
      });
    }
    if (out.length >= numResults) break;
  }
  return out;
}

/** 解码 Bing 跳转链接（https://www.bing.com/ck/a?...&u=a1aHR0cDovL3JlYWw%3D → 真实 URL） */
function decodeBingLink(href: string): string {
  if (!href.includes('bing.com/ck/a')) return href;
  const m = href.match(/u=a1([^&]+)/);
  if (!m) return href;
  try {
    // base64url 解码 → URL
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return decoded || href;
  } catch {
    return href;
  }
}

/** 去 HTML 标签 */
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

/** 网页搜索：SerpAPI 优先，无 key 用 Bing，失败降级桩 */
export async function webSearch(query: string, numResults = 6): Promise<SearchResult[]> {
  if (config.ciDemoMode) return stubSearch(query);
  try {
    if (config.serpApi.key) return await serpSearch(query, numResults, config.serpApi.engine);
    const results = await bingSearch(query, numResults);
    if (results.length === 0) return stubSearch(query); // Bing 空结果降级
    return results;
  } catch {
    return stubSearch(query); // 任何搜索失败 → demo 桩兜底
  }
}

/** 新闻搜索：SerpAPI 优先，无 key 用 Bing（Bing 无专用新闻接口，用网页搜索近似） */
export async function newsSearch(query: string, numResults = 5): Promise<NewsResult[]> {
  if (config.ciDemoMode) {
    return stubSearch(query).map((s) => ({ title: s.title, link: s.link, date: null, source: 'stub' }));
  }
  try {
    if (config.serpApi.key) {
      const params = new URLSearchParams({
        engine: `${config.serpApi.engine}_news`,
        q: query,
        api_key: config.serpApi.key,
        num: String(numResults),
      });
      const res = await fetch(`${config.serpApi.baseUrl}?${params}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`news search HTTP ${res.status}`);
      const data = (await res.json()) as { news_results?: { title?: string; link?: string; date?: string; source?: { name?: string } }[] };
      return (data.news_results ?? []).slice(0, numResults).map((r) => ({
        title: r.title ?? '', link: r.link ?? '', date: r.date ?? null, source: r.source?.name ?? '',
      }));
    }
    const results = await bingSearch(query, numResults);
    if (results.length === 0) {
      return stubSearch(query).map((s) => ({ title: s.title, link: s.link, date: null, source: 'stub' }));
    }
    return results.map((r) => ({ title: r.title, link: r.link, date: null, source: 'Bing' }));
  } catch {
    return stubSearch(query).map((s) => ({ title: s.title, link: s.link, date: null, source: 'stub' }));
  }
}
