/* 控制台详情下钻 · 确定性演示造数
 * 只插数据、不投 outbox 事件 —— orchestrator/worker 不会把假 run 当真实任务执行。
 * 用法：node scripts/seed-demo.mjs   （可重复执行：幂等按固定 id 覆盖）
 */
import { createConnection } from 'mysql2/promise';
import { createHash, randomUUID } from 'node:crypto';

const DB = { host: '127.0.0.1', user: 'root', password: '123456', database: 'agent_swarm' };
const ACTOR = 'user:admin';
const MODEL = 'claude-opus-5';
const uid = () => randomUUID();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString();

const c = await createConnection(DB);
try {
  const NOW = Date.now();
  const min = (n) => new Date(NOW - n * 60_000).toISOString();

  // ---------- 清理：删除早期重复测试项目（无任何关联子数据） ----------
  const [oldProjects] = await c.query('SELECT id FROM research_projects');
  for (const row of oldProjects) {
    await c.query('DELETE FROM project_members WHERE project_id=?', [row.id]);
    await c.query('DELETE FROM project_skus WHERE project_id=?', [row.id]);
    await c.query('DELETE FROM project_runs WHERE project_id=?', [row.id]);
    await c.query('DELETE FROM research_projects WHERE id=?', [row.id]);
  }

  // ---------- 固定 id（可重复执行） ----------
  const BOREAL_COMP = 'demo-comp-boreal-0000000000000001';
  const BRIEF = 'demo-brief-boreal-00000000000000001';
  const RUN_FULL = 'demo-run-full-000000000000000001';
  const RUN_FAILED = 'demo-run-failed-00000000000000001';
  const RUN_QUEUED = 'demo-run-queued-00000000000000001';

  // ---------- competitor + brief ----------
  await c.query(
    `INSERT INTO competitors (id,name,website,monitor_urls,notes,enabled,status,created_at,last_checked_at,last_error)
     VALUES (?,?,?,?,?,?,?,?,NULL,NULL)
     ON DUPLICATE KEY UPDATE name=VALUES(name),website=VALUES(website)`,
    [BOREAL_COMP, 'Boreal Sports（竞品）', 'https://www.boreal.example', null, null, 1, 'idle', iso(2880)]
  );
  await c.query(
    `INSERT INTO analysis_briefs
       (id,our_product_id,competitor_ids,purpose,market,time_range_start,time_range_end,
        included_sources,excluded_sources,max_runtime_seconds,cost_budget,allow_unverified,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE market=VALUES(market)`,
    [BRIEF, null, JSON.stringify([BOREAL_COMP]), 'competitor_only', '中国', null, null,
      JSON.stringify(['official', 'news']), JSON.stringify([]), 3600, 10, 0, ACTOR, iso(2880)]
  );

  const snapshot = (competitor, brief) => JSON.stringify({
    schema_version: 1,
    frozen_at: new Date().toISOString(),
    brief: { ...brief, competitor_ids: [competitor.id] },
    our_product: { name: '安泽 Velocity 速度型足球鞋', website: 'https://www.anze.example' },
    competitor,
    source_policy: { included: ['official', 'news'], excluded: [], allow_unverified: false },
    agent: { model: MODEL, quality_judges: 2 },
    prompt_version: 'p1-v1',
  });
  const borealComp = { id: BOREAL_COMP, name: 'Boreal Sports（竞品）', website: 'https://www.boreal.example' };
  const borealBrief = { id: BRIEF, purpose: 'competitor_only', market: '中国', included_sources: ['official', 'news'] };

  // ---------- 3 个演示 run（不投 outbox） ----------
  const runSql = `INSERT INTO ci_runs
      (id,brief_id,status,current_stage,progress,snapshot,model_version,prompt_version,
       token_count,search_count,estimated_cost,error_code,error_message,created_by,created_at,
       started_at,finished_at,cancelled_at)
     VALUES (?,?,?,?,?,?,?,?,0,0,0,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE status=VALUES(status),current_stage=VALUES(current_stage),
       progress=VALUES(progress),error_code=VALUES(error_code),error_message=VALUES(error_message),
       started_at=VALUES(started_at),finished_at=VALUES(finished_at),cancelled_at=VALUES(cancelled_at)`;
  await c.query(runSql, [RUN_FULL, BRIEF, 'waiting_review', 'quality', 100, snapshot(borealComp, borealBrief), MODEL, 'p1-v1',
    null, null, ACTOR, min(10), min(9), null, null]);
  await c.query(runSql, [RUN_FAILED, BRIEF, 'failed', 'research', 40, snapshot(borealComp, borealBrief), MODEL, 'p1-v1',
    'STAGE_FAILED', '上游搜索服务超时：research round 0 重试 3 次仍失败', ACTOR, min(60 * 24), min(60 * 24 - 4), min(60 * 24 - 2), null]);
  await c.query(runSql, [RUN_QUEUED, BRIEF, 'queued', 'monitor', 0, snapshot(borealComp, borealBrief), MODEL, 'p1-v1',
    null, null, ACTOR, min(120), null, null, null]);

  // ---------- ci_run_stages ----------
  const stageSql = `INSERT INTO ci_run_stages
      (id,run_id,stage,round,status,attempt,task_id,input_ref,output_ref,model,prompt_version,
       tools,token_count,estimated_cost,error_message,started_at,finished_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?)
     ON DUPLICATE KEY UPDATE status=VALUES(status),attempt=VALUES(attempt),error_message=VALUES(error_message),
       started_at=VALUES(started_at),finished_at=VALUES(finished_at),output_ref=VALUES(output_ref)`;
  const stage = (runId, st, round, status, attempt, tools, result, err, t0, t1, createdAt) =>
    c.query(stageSql, [uid(), runId, st, round, status, attempt, null,
      JSON.stringify({ task: `${st}#r${round}` }), result ? JSON.stringify({ result }) : null,
      MODEL, 'p1-v1', JSON.stringify(tools ?? []), err ?? null, t0, t1, createdAt]);

  // FULL：全链路 5 阶段（research 出现 Reflexion 回炉 R1）
  await stage(RUN_FULL, 'monitor', 0, 'completed', 1, ['fetch', 'search'],
    '监测：抓取 Boreal 官网与电商价格页共 12 页，识别 Striker Pro 定价与在架变化。', null, min(9.5), min(9.3), min(9.5));
  await stage(RUN_FULL, 'research', 0, 'completed', 1, ['search', 'fetch', 'read'],
    '研究 R0：产出竞品定位、价格带与渠道策略初稿，覆盖 6 个信息维度。', null, min(9.2), min(8.6), min(9.2));
  await stage(RUN_FULL, 'research', 1, 'completed', 1, ['search', 'read'],
    '研究 R1（回炉）：质检发现市场占有率来源仅 1 条，补充采集 2 条新闻源后重写市占结论。', null, min(8.5), min(7.9), min(8.5));
  await stage(RUN_FULL, 'compare', 0, 'completed', 1, ['read', 'matrix'],
    '对比：生成我方 Velocity vs Boreal Striker Pro 的 5 维对比矩阵。', null, min(7.8), min(7.2), min(7.8));
  await stage(RUN_FULL, 'battlecard', 0, 'completed', 1, ['read', 'matrix'],
    '战卡：形成针对 Striker Pro 的销售话术、异议处理与价格应对卡片。', null, min(7.1), min(6.6), min(7.1));
  await stage(RUN_FULL, 'quality', 0, 'completed', 1, ['judge'],
    '质检：综合分 8.2/10，声明均附证据；运行在报告工作流待人工创建报告。', null, min(6.5), min(6.2), min(6.5));

  // FAILED：research 失败
  await stage(RUN_FAILED, 'monitor', 0, 'completed', 1, ['fetch'],
    '监测：官网价格页采集完成，无异常。', null, min(60 * 24 - 4), min(60 * 24 - 3.6), min(60 * 24 - 4));
  await stage(RUN_FAILED, 'research', 0, 'failed', 3, ['search'],
    null, 'search provider timeout (3 attempts)', min(60 * 24 - 3.5), min(60 * 24 - 2), min(60 * 24 - 3.5));

  // QUEUED：monitor 排队中（演示取消）
  await stage(RUN_QUEUED, 'monitor', 0, 'queued', 0, [], null, null, null, null, min(120));

  // ---------- evidence + claims ----------
  const evSql = `INSERT INTO evidence
      (id,run_id,competitor_id,request_url,final_url,title,http_status,content_type,body_hash,
       snapshot_uri,raw_content,source_type,market,language,published_at,captured_at,status,
       reviewed_by,reviewed_at,review_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE title=VALUES(title),status=VALUES(status),review_reason=VALUES(review_reason)`;
  const evidence = (id, runId, url, title, sourceType, raw, captured, status, reason) =>
    c.query(evSql, [id, runId, BOREAL_COMP, url, url, title, 200, 'text/html; charset=utf-8', sha(url),
      null, raw, sourceType, '中国', 'zh', null, captured, status,
      status === 'pending' ? null : ACTOR, status === 'pending' ? null : iso(0), reason ?? null]);

  // FULL run 证据：2 pending / 1 verified / 1 rejected
  const FE1 = 'demo-ev-full-00000000000000000001';
  const FE2 = 'demo-ev-full-00000000000000000002';
  const FE3 = 'demo-ev-full-00000000000000000003';
  const FE4 = 'demo-ev-full-00000000000000000004';
  await evidence(FE1, RUN_FULL, 'https://news.example.com/boreal-striker-pro-2026',
    'Boreal 发布 Striker Pro 二代，国内首发定价下探', 'news',
    '据行业媒体报道，Boreal 于 2026 年夏在国内市场推出 Striker Pro 二代，建议零售价较上代下调约 8%，主打电商渠道首发。',
    min(6 * 60), 'pending', null);
  await evidence(FE2, RUN_FULL, 'https://www.boreal.example/striker-pro',
    'Boreal 官方旗舰店 Striker Pro 详情页', 'official',
    '页面展示 Striker Pro（AG 大底 / 织物鞋面）官方定价与在售尺码，标注“新品首发”标签。',
    min(5 * 60), 'pending', null);
  await evidence(FE3, RUN_FULL, 'https://www.boreal.example/striker-pro/spec',
    'Boreal 官网 Striker Pro 产品参数页', 'official',
    '官方参数：鞋面飞织网布、大底 AG 橡胶、重量约 215g（42 码）、产地越南。',
    min(20 * 60), 'verified', '控制台人工核验通过');
  await evidence(FE4, RUN_FULL, 'https://deal.example.com/rebate/boreal',
    '第三方导购站 Boreal 折扣转载', 'news',
    '导购站转载称“Striker Pro 渠道价低于官方 20%”，未给出具体出处与时间。',
    min(30 * 60), 'rejected', '非一手来源，正文与官网参数冲突，予以驳回');

  // REAL run（库里真实 waiting@research）补证据，演示“研究证据门禁等待”场景
  const REALE1 = 'demo-ev-real-00000000000000000001';
  const REALE2 = 'demo-ev-real-00000000000000000002';
  const REAL_RUN = 'd197140d-0178-4402-87d1-c586ee7487ea';
  await c.query(evSql, [REALE1, REAL_RUN, null, 'https://news.example.com/nike-phantom-6',
    'https://news.example.com/nike-phantom-6', 'NIKE Phantom 6 上架新闻', 200, 'text/html; charset=utf-8', sha('real1'),
    null, '行业资讯：NIKE Phantom 6 系列上架，官方渠道先行，电商渠道铺货滞后约两周。', 'news', '中国', 'zh', null,
    min(140), 'pending', null, null, null]);
  await c.query(evSql, [REALE2, REAL_RUN, null, 'https://www.nike.example/phantom-6',
    'https://www.nike.example/phantom-6', 'NIKE 官网 Phantom 6 页面', 200, 'text/html; charset=utf-8', sha('real2'),
    null, '官网产品页：Phantom 6 定位控制型中场，首发配色与定价信息已公布。', 'official', '中国', 'zh', null,
    min(135), 'pending', null, null, null]);

  const claimSql = `INSERT INTO claims
      (id,run_id,statement,subject,claim_type,market,valid_at,confidence,status,
       invalidated_at,reviewed_by,reviewed_at,review_reason,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE statement=VALUES(statement),status=VALUES(status),review_reason=VALUES(review_reason)`;
  const linkSql = 'INSERT IGNORE INTO claim_evidence (claim_id,evidence_id,relation) VALUES (?,?,?)';
  const claim = async (id, runId, statement, subject, claimType, conf, status, evIds, reason) => {
    await c.query(claimSql, [id, runId, statement, subject, claimType, '中国', null, conf, status,
      status === 'rejected' ? iso(0) : null, status === 'pending' ? null : ACTOR,
      status === 'pending' ? null : iso(0), reason ?? null, min(7 * 60)]);
    for (const eid of evIds) await c.query(linkSql, [id, eid, 'supports']);
  };
  // FULL run claims：市占（双源门禁）/ 通用可过 / 已过 / 已驳（级联）
  await claim('demo-clm-full-00000000000000000001', RUN_FULL,
    'Boreal 在中国中端足球鞋市场占有率约为 12%', 'Boreal 中国市场占有率', 'market_share', 0.62, 'pending', [FE1, FE2], null);
  await claim('demo-clm-full-00000000000000000002', RUN_FULL,
    'Striker Pro 采用新一代 AG 大底与飞织鞋面', 'Striker Pro 产品技术参数', 'product', 0.85, 'pending', [FE3], null);
  await claim('demo-clm-full-00000000000000000003', RUN_FULL,
    'Striker Pro 二代较上代首发定价下调约 8%', 'Striker Pro 定价策略', 'pricing', 0.78, 'verified', [FE3], '控制台人工核验通过');
  await claim('demo-clm-full-00000000000000000004', RUN_FULL,
    '渠道价低于官方 20%（导购站口径）', 'Striker Pro 渠道价差', 'pricing', 0.4, 'rejected', [FE4], '证据驳回，声明级联作废');
  // REAL run claims：市占待双源核验
  await claim('demo-clm-real-00000000000000000001', REAL_RUN,
    'NIKE Phantom 6 电商渠道铺货较官方滞后约两周', 'Phantom 6 渠道铺货节奏', 'general', 0.7, 'pending', [REALE1, REALE2], null);

  // ---------- 项目 + 目录 + 价格 ----------
  const PROJ = 'demo-proj-soccer-0000000000000000001';
  const OURS_COMP = 'demo-co-anze-000000000000000000001';
  const OURS_BRAND = 'demo-br-anze-000000000000000000001';
  const OURS_SERIES = 'demo-se-velocity-000000000000000001';
  const OURS_SKU = 'demo-sku-vel01-0000000000000000001';
  const BOREAL_COMPANY = 'demo-co-boreal-0000000000000000001';
  const BOREAL_BRAND = 'demo-br-boreal-0000000000000000001';
  const BOREAL_SERIES_STR = 'demo-se-striker-0000000000000000001';
  const BOREAL_SERIES_TRX = 'demo-se-traction-0000000000000000001';
  const BOREAL_SKU_STR = 'demo-sku-str01-0000000000000000001';
  const BOREAL_SKU_TRX = 'demo-sku-trx02-0000000000000000001';

  const createdAt = iso(2880);
  await c.query(`INSERT INTO research_projects
      (id,name,objective,business_context,market,channels,topics,source_policy,report_template,alert_policy,status,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE name=VALUES(name),objective=VALUES(objective)`,
    [PROJ, '足球鞋中国市场持续研究', '持续追踪我方 Velocity 与竞品（Boreal Striker / Traction 等）重点 SKU 的价格与参数变化，输出周度战卡。',
      '面向国内足球鞋零售市场，聚焦 300-900 元价格带。', 'CN', JSON.stringify(['官网', '电商']),
      JSON.stringify(['价格', '新品', '渠道']), JSON.stringify({ official_first: true }), 'standard',
      JSON.stringify({ cadence_days: 7 }), 'active', ACTOR, iso(60 * 24 * 6), iso(60 * 24 * 6)]);
  await c.query('INSERT IGNORE INTO project_members (project_id,user_id,role,created_at) VALUES (?,?,?,?)',
    [PROJ, ACTOR, 'owner', createdAt]);
  await c.query('INSERT IGNORE INTO project_runs (project_id,run_id,created_at) VALUES (?,?,?)', [PROJ, RUN_FULL, iso(60)]);

  const cat = async (table, id, name, parent, extra) => {
    const cols = parent ? `id,${parent.key},name,created_at` : 'id,name,created_at';
    const vals = parent ? [id, parent.id, name, createdAt] : [id, name, createdAt];
    const ph = cols.split(',').map(() => '?').join(',');
    await c.query(`INSERT INTO ${table} (${cols}) VALUES (${ph}) ON DUPLICATE KEY UPDATE name=VALUES(name)`, vals);
  };
  await cat('companies', OURS_COMP, '安泽体育（我方示例）');
  await cat('companies', BOREAL_COMPANY, 'Boreal 竞技（竞品）');
  await cat('brands', OURS_BRAND, 'Anze', { key: 'company_id', id: OURS_COMP });
  await cat('brands', BOREAL_BRAND, 'Boreal', { key: 'company_id', id: BOREAL_COMPANY });
  await cat('product_series', OURS_SERIES, 'Velocity 速度系', { key: 'brand_id', id: OURS_BRAND });
  await cat('product_series', BOREAL_SERIES_STR, 'Striker 前锋系', { key: 'brand_id', id: BOREAL_BRAND });
  await cat('product_series', BOREAL_SERIES_TRX, 'Traction 掌控系', { key: 'brand_id', id: BOREAL_BRAND });
  const sku = async (id, seriesId, code, name) => c.query(
    `INSERT INTO skus (id,series_id,code,name,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE name=VALUES(name)`, [id, seriesId, code, name, 'active', createdAt, iso(0)]);
  await sku(OURS_SKU, OURS_SERIES, 'VEL-01', 'Velocity Elite 速度型 FG');
  await sku(BOREAL_SKU_STR, BOREAL_SERIES_STR, 'STR-01', 'Striker Pro 前锋型 AG');
  await sku(BOREAL_SKU_TRX, BOREAL_SERIES_TRX, 'TRX-02', 'Traction 2 掌控型 FG');
  const attach = async (skuId, side) => c.query(
    `INSERT INTO project_skus (project_id,sku_id,side,created_at) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE side=VALUES(side)`, [PROJ, skuId, side, createdAt]);
  await attach(OURS_SKU, 'ours');
  await attach(BOREAL_SKU_STR, 'competitor');
  await attach(BOREAL_SKU_TRX, 'competitor');

  const price = async (skuId, channel, list, sale, inStock, captured) => c.query(
    `INSERT INTO price_snapshots
       (id,sku_id,market,channel,list_price,sale_price,currency,in_stock,source_url,evidence_id,captured_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [uid(), skuId, 'CN', channel, list, sale, 'CNY', inStock, null, null, captured, captured]);
  const day = (d) => new Date(NOW - d * 86_400_000).toISOString();
  // 每个 SKU 4 条：2 条在 7 天内（计入周变化 / 覆盖率），2 条更早
  for (const skuId of [OURS_SKU, BOREAL_SKU_STR, BOREAL_SKU_TRX]) {
    await price(skuId, '天猫旗舰店', 899, 799, 1, day(1));
    await price(skuId, '京东自营', 899, skuId === BOREAL_SKU_TRX ? 0 : 759, skuId === BOREAL_SKU_STR ? 0 : 1, day(3));
    await price(skuId, '官网', 899, 799, 1, day(9));
    await price(skuId, '天猫旗舰店', 999, 899, 1, day(21));
  }
  const pshot = async (parameters) => c.query(
    `INSERT INTO product_snapshots
       (id,sku_id,market,channel,parameters,source_url,evidence_id,captured_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [uid(), OURS_SKU, 'CN', '官网', JSON.stringify(parameters), null, null, day(2), day(2)]);
  await pshot({ 鞋钉: 'FG', 鞋面: '飞织网布', 重量: '205g（42码）' });
  await pshot({ 鞋钉: 'FG', 鞋面: '飞织网布', 重量: '210g（42码）' });
  await pshot({ 鞋钉: 'FG', 鞋面: '飞织网布', 重量: '208g（42码）' });

  // ---------- 汇总 ----------
  const count = async (sql) => Number((await c.query(sql))[0][0].n);
  console.log(JSON.stringify({
    runs: await count('SELECT COUNT(*) n FROM ci_runs'),
    stages: await count('SELECT COUNT(*) n FROM ci_run_stages'),
    evidence: await count('SELECT COUNT(*) n FROM evidence'),
    claims: await count('SELECT COUNT(*) n FROM claims'),
    projects: await count('SELECT COUNT(*) n FROM research_projects'),
    skus: await count('SELECT COUNT(*) n FROM skus'),
    price_snapshots: await count('SELECT COUNT(*) n FROM price_snapshots'),
    full_run: RUN_FULL, failed_run: RUN_FAILED, queued_run: RUN_QUEUED, project: PROJ,
  }, null, 2));
} finally {
  await c.end();
}
