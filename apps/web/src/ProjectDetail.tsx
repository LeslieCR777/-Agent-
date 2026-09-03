import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty } from '@ui/index.js';
import type { Competitor, PriceSnapshotRow, ProjectDashboardRow, ProjectDetailRow, ProjectSku, Run } from './models.js';
import { api } from './api.js';
import { fmtCoverage, fmtPrice, fmtTs } from './format.js';
import { RunDetail } from './RunDetail.js';
import { PROJECT_STATUS_LABELS, RUN_LABELS, STATUS_TONE } from './constants.js';
import { CompetitorMultiSelect } from './CompetitorMultiSelect.js';

interface Props {
  projectId: string;
  notify: (message: string) => void;
  onBack: () => void;
}

function SkuPriceTable({ rows }: { rows: PriceSnapshotRow[] }) {
  const shown = rows.slice(0, 8);
  return (
    <div className="table-wrap price-expand">
      <table>
        <thead><tr><th>采集时间</th><th>渠道</th><th>吊牌价</th><th>售价</th><th>币种</th><th>库存</th></tr></thead>
        <tbody>
          {shown.map((p) => (
            <tr key={p.id}>
              <td>{fmtTs(p.captured_at)}</td>
              <td>{p.channel || '—'}</td>
              <td>{fmtPrice(p.list_price, p.currency)}</td>
              <td>{fmtPrice(p.sale_price, p.currency)}</td>
              <td>{p.currency ?? '—'}</td>
              <td>{p.in_stock === 1 ? '有货' : p.in_stock === 0 ? '缺货' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 8 && <p className="hint">仅显示最近 {shown.length} 条，共 {rows.length} 条</p>}
    </div>
  );
}

export function ProjectDetail({ projectId, notify, onBack }: Props) {
  const [project, setProject] = useState<ProjectDetailRow | null>(null);
  const [dashboard, setDashboard] = useState<ProjectDashboardRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openSku, setOpenSku] = useState<string | null>(null);
  const [priceRows, setPriceRows] = useState<Record<string, PriceSnapshotRow[]>>({});
  const [priceBusy, setPriceBusy] = useState<string | null>(null);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runBusy, setRunBusy] = useState(false);
  const [selectedCompetitorIds, setSelectedCompetitorIds] = useState<string[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, d, c, r] = await Promise.all([
        api<{ project: ProjectDetailRow }>(`/api/projects/${projectId}`),
        api<{ dashboard: ProjectDashboardRow }>(`/api/projects/${projectId}/dashboard`),
        api<{ competitors: Competitor[] }>('/api/competitors'),
        api<{ runs: Run[] }>(`/api/projects/${projectId}/runs`),
      ]);
      setProject(p.project); setDashboard(d.dashboard); setCompetitors(c.competitors); setRuns(r.runs); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '项目加载失败'); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  async function toggleSku(sku: ProjectSku) {
    if (openSku === sku.id) { setOpenSku(null); return; }
    setOpenSku(sku.id);
    if (priceRows[sku.id]) return;
    setPriceBusy(sku.id);
    try {
      const data = await api<{ timeline: { prices: PriceSnapshotRow[] } }>(`/api/skus/${sku.id}/timeline`);
      setPriceRows((prev) => ({ ...prev, [sku.id]: data.timeline.prices }));
    } catch (cause) { notify(cause instanceof Error ? cause.message : '价格历史加载失败'); }
    finally { setPriceBusy(null); }
  }

  async function createAnalysis(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setRunBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      if (selectedCompetitorIds.length !== 2) throw new Error('请选择恰好 2 个竞品进行对比');
      const brief = await api<{ brief: { id: string } }>('/api/analysis-briefs', {
        method: 'POST', body: JSON.stringify({
          purpose: 'competitor_only', competitor_ids: selectedCompetitorIds, market: project?.market,
          included_sources: ['official', 'news'], excluded_sources: [], max_runtime_seconds: 3600,
          cost_budget: 10, allow_unverified: false,
        }),
      });
      const results = await Promise.all(selectedCompetitorIds.map((competitorId) => api<{ run: Run }>('/api/runs', {
        method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ brief_id: brief.brief.id, competitor_id: competitorId, project_id: projectId }),
      })));
      notify('已创建 ' + results.length + ' 条并行对比任务'); setSelectedCompetitorIds([]); setActiveRunId(results[0].run.id); await load();
    } catch (cause) { notify(cause instanceof Error ? cause.message : '分析创建失败'); }
    finally { setRunBusy(false); }
  }

  if (activeRunId) {
    return <RunDetail runId={activeRunId} notify={notify} onBack={() => { setActiveRunId(null); void load(); }} />;
  }

  if (!project) {
    return (
      <>
        <div className="detail-bar"><Button tone="quiet" onClick={onBack}>← 返回项目列表</Button></div>
        <Card>{error ? <p className="error">{error}</p> : <Empty>加载项目详情…</Empty>}</Card>
      </>
    );
  }

  const tiles: Array<{ label: string; value: string; tone?: string }> = dashboard
    ? [
      { label: 'SKU 总数', value: String(dashboard.sku_count) },
      { label: '我方 SKU', value: String(dashboard.our_sku_count), tone: 'success' },
      { label: '竞品 SKU', value: String(dashboard.competitor_sku_count) },
      { label: '价格快照', value: String(dashboard.price_snapshot_count) },
      { label: '价格覆盖', value: fmtCoverage(dashboard.fresh_coverage) },
      { label: '7日价格变化', value: String(dashboard.weekly_price_changes) },
      { label: '7日参数变化', value: String(dashboard.weekly_parameter_changes) },
      { label: '新证据', value: String(dashboard.new_evidence) },
      { label: '失效证据', value: String(dashboard.invalid_evidence) },
      { label: '待发报告', value: String(dashboard.pending_reports) },
      { label: '最近采集', value: fmtTs(dashboard.latest_price_at) },
    ]
    : [];

  return (
    <>
      <div className="detail-bar">
        <Button tone="quiet" onClick={onBack}>← 返回项目列表</Button>
        <div className="detail-bar-actions"><Button tone="quiet" onClick={() => void load()}>刷新</Button></div>
      </div>

      <Card title={project.name} action={<Badge tone="success">{PROJECT_STATUS_LABELS[project.status ?? ''] ?? '状态未知'}</Badge>}>
        <p className="muted" style={{ marginTop: 0 }}>{project.objective}</p>
        <dl className="kv">
          <div><dt>市场</dt><dd>{project.market}</dd></div>
          <div><dt>模板</dt><dd>{project.report_template ?? '—'}</dd></div>
          <div><dt>渠道</dt><dd>{project.channels?.length ? project.channels.join('、') : '—'}</dd></div>
          <div><dt>主题</dt><dd>{project.topics?.length ? project.topics.join('、') : '—'}</dd></div>
          <div><dt>来源策略</dt><dd>{project.source_policy ? Object.keys(project.source_policy).join(', ') : '—'}</dd></div>
          <div><dt>创建</dt><dd>{fmtTs(project.created_at)}</dd></div>
          <div><dt>更新</dt><dd>{fmtTs(project.updated_at)}</dd></div>
          {project.members?.length > 0 && (
            <div><dt>成员</dt><dd>{project.members.map((m) => `${m.user_id}（${m.role}）`).join('、')}</dd></div>
          )}
        </dl>
      </Card>

      <Card title="项目分析" action={<span className="muted">{runs.length} 次运行</span>}>
        <form className="comparison-create-form" onSubmit={createAnalysis}>
          <CompetitorMultiSelect competitors={competitors} value={selectedCompetitorIds} onChange={setSelectedCompetitorIds} />
          <div className="comparison-create-actions">
            <label>目标市场<input value={project.market} readOnly /></label>
            <Button type="submit" disabled={runBusy || selectedCompetitorIds.length !== 2}>{runBusy ? '创建中…' : '开始对比分析'}</Button>
          </div>
        </form>
        {competitors.length < 2 && <p className="hint">请先创建至少两个启用的竞品。</p>}
        {!!runs.length && <div className="table-wrap project-runs"><table>
          <thead><tr><th>运行</th><th>竞品</th><th>状态</th><th>进度</th><th>创建时间</th></tr></thead>
          <tbody>{runs.map((run) => <tr className="row-click" key={run.id} onClick={() => setActiveRunId(run.id)}>
            <td className="mono">{run.id.slice(0, 8)}</td>
            <td>{run.snapshot?.competitor?.name ?? '—'}</td>
            <td><Badge tone={STATUS_TONE[run.status]}>{RUN_LABELS[run.status] ?? '未知状态'}</Badge></td>
            <td>{run.progress}%</td><td>{fmtTs(run.created_at)}</td>
          </tr>)}</tbody>
        </table></div>}
      </Card>

      <Card title="健康指标" action={<Button tone="quiet" className="button--sm" onClick={() => void load()}>刷新</Button>}>
        {tiles.length ? (
          <div className="metric-tiles">
            {tiles.map((t) => (
              <div className="metric-tile" key={t.label}>
                <small>{t.label}</small>
                <strong>{t.value}</strong>
              </div>
            ))}
          </div>
        ) : <Empty>暂无指标</Empty>}
      </Card>

      <Card title={`关联 SKU（${project.products?.length ?? 0}）`}>
        {!project.products?.length ? (
          <>
            <Empty>项目尚未关联 SKU</Empty>
            <p className="hint">通过 SKU 目录 / 项目接口（POST /api/projects/:id/skus）关联 SKU 后，这里会出现监测对象。</p>
          </>
        ) : (
          <div className="sku-list">
            {project.products.map((sku) => {
              const open = openSku === sku.id;
              const prices = priceRows[sku.id];
              const loading = priceBusy === sku.id;
              return (
                <div className="sku-line" key={sku.id}>
                  <div className="sku-line-main">
                    <Badge tone={sku.side === 'ours' ? 'success' : 'neutral'}>{sku.side === 'ours' ? '我方' : '竞品'}</Badge>
                    <span className="sku-code mono">{sku.code}</span>
                    <strong>{sku.name}</strong>
                    <span className="muted small">{[sku.company, sku.brand, sku.series].filter(Boolean).join(' · ')}</span>
                  </div>
                  <button
                    className="chip-btn"
                    onClick={() => void toggleSku(sku)}
                    disabled={loading}
                  >
                    {loading ? '加载中…' : open ? '价格历史 ▾' : '价格历史 ▸'}
                  </button>
                  {open && (loading ? <p className="hint">加载价格历史…</p> : prices && prices.length ? (
                    <SkuPriceTable rows={prices} />
                  ) : prices ? <p className="hint">暂无价格快照</p> : null)}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}
