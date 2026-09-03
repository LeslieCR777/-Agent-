import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.js';
import { parseCsv } from '@domain/phase-two.js';
import {
  attachProjectSku, canAccessProject, confirmCatalogImport, createCatalogItem, createPriceSnapshot, createProductSnapshot,
  createProject, getProject, previewCatalogImport, productTimeline, projectDashboard,
} from '@api/db/queries/projects.js';

before(async () => { await setupTestDb(); });
after(async () => { await teardownTestDb(); });

test('Research Project freezes scope and assigns its creator as owner', async () => {
  const project = await createProject({
    name: 'Football Boots China Pricing', objective: 'Track monthly price changes', market: 'CN',
    channels: ['official', 'marketplace', 'official'], topics: ['pricing'], actor: 'user:analyst',
  });
  const detail = await getProject(project.id);
  assert.deepEqual(detail?.channels, ['official', 'marketplace', 'official']);
  assert.equal((detail?.members as { role: string }[])[0].role, 'owner');
  assert.equal(await canAccessProject(project.id, 'user:analyst'), true);
  assert.equal(await canAccessProject(project.id, 'user:outsider'), false);
});

test('catalog preserves Company → Brand → Series → SKU hierarchy', async () => {
  const company = await createCatalogItem({ type: 'company', name: 'Acme' });
  const brand = await createCatalogItem({ type: 'brand', name: 'A-Brand', parent_id: company.id });
  const series = await createCatalogItem({ type: 'series', name: 'Speed', parent_id: brand.id });
  const sku = await createCatalogItem({ type: 'sku', name: 'Speed Elite', code: 'SPD-1', parent_id: series.id });
  const sameSku = await createCatalogItem({ type: 'sku', name: 'Ignored rename', code: 'SPD-1', parent_id: series.id });
  assert.equal(sku.id, sameSku.id);
});

test('price and parameter timelines keep market, channel and currency unchanged', async () => {
  const company = await createCatalogItem({ type: 'company', name: 'Timeline Co' });
  const brand = await createCatalogItem({ type: 'brand', name: 'Timeline Brand', parent_id: company.id });
  const series = await createCatalogItem({ type: 'series', name: 'Timeline Series', parent_id: brand.id });
  const sku = await createCatalogItem({ type: 'sku', name: 'Timeline SKU', code: 'TL-1', parent_id: series.id });
  const project = await createProject({
    name: 'Timeline Project', objective: 'Compare channels', market: 'CN', channels: ['official'], topics: ['pricing'], actor: 'user:analyst',
  });
  await attachProjectSku(project.id, sku.id, 'competitor');
  await createPriceSnapshot({ sku_id: sku.id, market: 'CN', channel: 'official', list_price: 1299, sale_price: 999, currency: 'CNY' });
  await createPriceSnapshot({ sku_id: sku.id, market: 'US', channel: 'official', list_price: 199, currency: 'USD' });
  await createProductSnapshot({ sku_id: sku.id, market: 'CN', channel: 'official', parameters: { weight_g: 210 } });
  const timeline = await productTimeline(sku.id, 'CN', 'official');
  assert.equal(timeline.prices.length, 1);
  assert.equal(timeline.prices[0].currency, 'CNY');
  assert.deepEqual(timeline.products[0].parameters, { weight_g: 210 });
  assert.equal((await projectDashboard(project.id)).price_snapshot_count, 2);
});

test('CSV import previews duplicates and only persists after confirmation', async () => {
  const rows = parseCsv(
    'company,brand,series,sku_code,sku_name\nImport Co,Runner,Fast,FAST-1,"Fast, Elite"', {}
  );
  assert.equal(rows[0].sku_name, 'Fast, Elite');
  const preview = await previewCatalogImport({ filename: 'products.csv', mapping: {}, rows, actor: 'user:analyst' });
  assert.equal(preview.status, 'preview');
  const result = await confirmCatalogImport(preview.id);
  assert.equal(result.imported, 1);
  await assert.rejects(() => confirmCatalogImport(preview.id), /IMPORT_ALREADY_CONFIRMED/);
  const duplicate = await previewCatalogImport({ filename: 'again.csv', mapping: {}, rows, actor: 'user:analyst' });
  assert.equal(duplicate.duplicate_count, 1);
});
