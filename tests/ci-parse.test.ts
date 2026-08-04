import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonBlock, parseJsonArray } from '../src/ci/parse.js';

test('parseJsonBlock：裸 JSON 对象', () => {
  const r = parseJsonBlock<{ a: number }>('{"a":1}');
  assert.equal(r?.a, 1);
});

test('parseJsonBlock：带 ```json 围栏', () => {
  const r = parseJsonBlock<{ a: number }>('```json\n{"a":2}\n```');
  assert.equal(r?.a, 2);
});

test('parseJsonBlock：容忍前后缀文字', () => {
  const r = parseJsonBlock<{ a: number }>('好的，以下是分析结果：\n{"a":3}\n希望有帮助。');
  assert.equal(r?.a, 3);
});

test('parseJsonArray：数组含嵌套字符串', () => {
  const r = parseJsonArray<{ t: string }>(`[{"t":"a"},{"t":"b"}]`);
  assert.equal(r?.length, 2);
  assert.equal(r?.[1].t, 'b');
});

test('parseJsonArray：围栏 + 前缀', () => {
  const r = parseJsonArray<number>('result:\n```json\n[1,2,3]\n```');
  assert.deepEqual(r, [1, 2, 3]);
});

test('parseJsonBlock：非法输入返回 null', () => {
  assert.equal(parseJsonBlock('不是 JSON'), null);
  assert.equal(parseJsonBlock('{"a":'), null);
});
