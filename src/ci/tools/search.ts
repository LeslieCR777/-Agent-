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

/** SerpAPI 兼容搜索；无 key / demo 模式回退确定性桩结果 */
export async function webSearch(query: string, numResults = 6): Promise<SearchResult[]> {
  if (!config.serpApi.key || config.ciDemoMode) return stubSearch(query);
  const params = new URLSearchParams({
    engine: config.serpApi.engine,
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

/** 新闻搜索 */
export async function newsSearch(query: string, numResults = 5): Promise<NewsResult[]> {
  if (!config.serpApi.key || config.ciDemoMode) {
    return stubSearch(query).map((s) => ({ title: s.title, link: s.link, date: null, source: 'stub' }));
  }
  const params = new URLSearchParams({
    engine: `${config.serpApi.engine}_news`,
    q: query,
    api_key: config.serpApi.key,
    num: String(numResults),
  });
  const res = await fetch(`${config.serpApi.baseUrl}?${params}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`news search HTTP ${res.status}`);
  const data = (await res.json()) as { news_results?: { title?: string; link?: string; date?: string; source?: { name?: string } }[] };
  return (data.news_results ?? []).slice(0, numResults).map((r) => ({
    title: r.title ?? '',
    link: r.link ?? '',
    date: r.date ?? null,
    source: r.source?.name ?? '',
  }));
}
