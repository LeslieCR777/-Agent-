/** 极简、无外部依赖的 UTF-16 PDF 导出器，使用 PDF 标准 CJK 字体映射。 */
export function renderTextPdf(lines: string[]): Buffer {
  const text = lines.flatMap((line) => wrap(line, 72)).slice(0, 52);
  const commands = [
    'BT', '/F1 10 Tf', '48 794 Td', '14 TL',
    ...text.flatMap((line) => [`<${utf16Hex(line)}> Tj`, 'T*']),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>',
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

function utf16Hex(value: string): string {
  const little = Buffer.from(`﻿${value}`, 'utf16le');
  for (let i = 0; i < little.length; i += 2) {
    const byte = little[i];
    little[i] = little[i + 1];
    little[i + 1] = byte;
  }
  return little.toString('hex').toUpperCase();
}

function wrap(value: string, width: number): string[] {
  if (!value) return [''];
  const lines: string[] = [];
  for (let start = 0; start < value.length; start += width) lines.push(value.slice(start, start + width));
  return lines;
}
