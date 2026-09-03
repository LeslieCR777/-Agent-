export type ProjectRole = 'owner' | 'analyst' | 'product' | 'sales' | 'viewer';
export type ProductSide = 'ours' | 'competitor';

export interface ImportRow {
  company: string;
  brand: string;
  series: string;
  sku_code: string;
  sku_name: string;
}

export function requiredText(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field.toUpperCase()}_REQUIRED`);
  return value.trim().slice(0, max);
}

export function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`${field.toUpperCase()}_INVALID`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

export function parseCsv(csv: string, mapping: Record<string, string>): ImportRow[] {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const parse = (line: string) => {
    const cells: string[] = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { cells.push(value.trim()); value = ''; }
      else value += char;
    }
    cells.push(value.trim());
    return cells;
  };
  const headers = parse(lines[0]);
  const fields = ['company', 'brand', 'series', 'sku_code', 'sku_name'] as const;
  const indexes = Object.fromEntries(fields.map((field) => [field, headers.indexOf(mapping[field] ?? field)])) as Record<keyof ImportRow, number>;
  if (Object.values(indexes).some((i) => i < 0)) throw new Error('IMPORT_MAPPING_INVALID');
  return lines.slice(1).map(parse).map((cells) => ({
    company: cells[indexes.company]?.trim() ?? '',
    brand: cells[indexes.brand]?.trim() ?? '',
    series: cells[indexes.series]?.trim() ?? '',
    sku_code: cells[indexes.sku_code]?.trim() ?? '',
    sku_name: cells[indexes.sku_name]?.trim() ?? '',
  })).filter((row) => Object.values(row).every(Boolean));
}
