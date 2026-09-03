// 纯展示工具。

/** 剥 HTML/脚本/样式后截断为纯文本摘要；空值回「无摘要」。 */
export function textSnippet(value?: string | null, max = 180): string {
  if (!value) return '无摘要';
  const text = value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '无摘要';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** ISO 时间 → 本地可读；空回 —。 */
export function fmtTs(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

/** 起止时间差（分钟）。 */
export function fmtDuration(start?: string | null, end?: string | null): string {
  if (!start || !end) return '—';
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '—';
  const sec = Math.max(0, Math.round((b - a) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}分钟`;
  const h = Math.floor(min / 60);
  return `${h}小时${min % 60 ? `${min % 60}分钟` : ''}`;
}

/** 0-1 覆盖率 → 百分比整数。 */
export function fmtCoverage(ratio?: number): string {
  if (ratio === undefined || ratio === null || !Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

/** DECIMAL(可能为 string) 价格 → 展示；currency 为代码前缀。 */
export function fmtPrice(value?: number | string | null, currency?: string | null): string {
  if (value === undefined || value === null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return currency && currency !== 'CNY' ? `${currency} ${s}` : s;
}

/** 置信度 0-1 → 百分比。 */
export function fmtConfidence(confidence?: number): string {
  if (confidence === undefined || confidence === null || !Number.isFinite(confidence)) return '—';
  return `${Math.round(confidence * 100)}%`;
}

/** 渠道/来源等展示文案兜底。 */
export function label(map: Record<string, string>, value?: string | null): string | undefined {
  return value ? map[value] ?? value : undefined;
}
