/**
 * Agent 输出的 JSON 宽容解析：剥 ```json 围栏、找首个 { 或 [、
 * 容忍前后缀文字。把 Lead 里 tryParseJsonArray 泛化复用。
 */

function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '');
  }
  return t.trim();
}

/** 解析任意 JSON 块（对象或数组）；失败返回 null */
export function parseJsonBlock<T = unknown>(text: string): T | null {
  const t = stripFences(text);
  // 直接从文本里找首个 { 或 [，容忍 LLM 输出的前后缀文字
  const start = Math.min(
    ...['{', '['].map((c) => { const i = t.indexOf(c); return i === -1 ? Infinity : i; })
  );
  if (!Number.isFinite(start)) return null;
  // 从候选起点向后扫描到配对的闭括号
  const open = t[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 解析 JSON 数组（Agent 输出变化列表等） */
export function parseJsonArray<T = unknown>(text: string): T[] | null {
  const block = parseJsonBlock<unknown>(text);
  return Array.isArray(block) ? (block as T[]) : null;
}
