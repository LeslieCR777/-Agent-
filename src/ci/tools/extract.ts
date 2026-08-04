/**
 * 结构化抽取（三级检测第二级）。纯正则启发式，不引 cheerio ——
 * 够用即可：把「页面全文」压缩成 LLM 关心的定价/招聘片段，省 token 且稳定。
 */

export interface PricingCandidate {
  plan: string;
  price: string;
  features: string[];
}

export interface JobListing {
  title: string;
  location: string;
  url: string;
}

/** 去标签 → 纯文本（保留换行） */
export function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** 定价抽取：扫「金额 + 周期关键词」附近文本 */
export function extractPricing(html: string): PricingCandidate[] {
  const text = extractText(html);
  const out: PricingCandidate[] = [];
  // 匹配 ¥299/月、$49/mo、¥1,999 每年 等
  const priceRe = /(¥|￥|\$)\s*([\d,]+\.?\d*)\s*(\/|\\|每|per)?\s*(月|年|季|mo|month|year|yr|w|week)?/gi;
  let m: RegExpExecArray | null;
  while ((m = priceRe.exec(text)) !== null && out.length < 12) {
    const price = m[0].trim();
    const start = Math.max(0, m.index - 60);
    const end = Math.min(text.length, m.index + m[0].length + 80);
    const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
    // 只保留有定价语义上下文的（plan/价/订阅/每月 等），过滤纯数字噪音
    if (!/(月|年|价|订阅|方案|plan|mo|month|year|per)/i.test(ctx)) continue;
    out.push({ plan: ctx.slice(0, 80), price, features: [] });
  }
  return out;
}

/** 招聘链接启发式抽取 */
export function extractJobListings(html: string): JobListing[] {
  const links: JobListing[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && links.length < 20) {
    const url = m[1];
    const label = extractText(m[2]).replace(/\s+/g, ' ').trim();
    // 招聘关键词命中：url 或 文案
    const isJob =
      /(careers|jobs|join-us|join_us|招聘|加入我们|职位|工作机会)/i.test(url) ||
      /(招聘|加入我们|职位|apply|open role|job)/i.test(label);
    if (!isJob) continue;
    const key = `${url}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ title: label.slice(0, 80) || url.slice(0, 80), location: '', url });
  }
  return links;
}
