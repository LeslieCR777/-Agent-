import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty } from '@ui/index.js';
import type { RunDetailPayload } from './models.js';
import { api } from './api.js';
import { RUN_LABELS, STAGE_LABELS, STATUS_TONE } from './constants.js';
import { EvidencePanel } from './EvidencePanel.js';
import { ClaimsPanel } from './ClaimsPanel.js';
import { effectiveRunProgress, isRunAnalysisComplete, progressDescription } from './runProgress.js';
import { AnalysisWorkspace } from './AnalysisWorkspace.js';

interface Props { runId: string; notify: (message: string) => void; onBack: () => void; }
type Feedback = { tone: 'pending' | 'success' | 'error' | 'blocked'; message: string };
const ACTIVE = new Set(['queued', 'running']);

function gateMessage(gate: RunDetailPayload['gate']): string {
  if (gate.rejected) return '有 ' + gate.rejected + ' 条声明被驳回；请在下方声明面板切换到“已驳回”，点击“重新通过”。';
  if (!gate.total) return '尚无可审核声明，请先审核下方证据和声明。';
  if (!gate.allow_unverified && gate.verified < gate.total) return '还有 ' + (gate.total - gate.verified) + ' 条声明待通过审核。';
  return '证据门禁尚未满足。';
}

function isOurProductRun(
  detail: RunDetailPayload,
  ourProduct: { id?: string; name?: string | null; website?: string | null } | null | undefined,
): boolean {
  const competitor = detail.run.snapshot?.competitor;
  if (!competitor || !ourProduct) return false;
  return Boolean(
    (ourProduct.id && competitor.id && ourProduct.id === competitor.id)
    || (ourProduct.name && competitor.name && ourProduct.name === competitor.name)
    || (ourProduct.website && competitor.website && ourProduct.website === competitor.website),
  );
}

export function RunDetail({ runId, notify, onBack }: Props) {
  const [detail, setDetail] = useState<RunDetailPayload | null>(null);
  const [batchDetails, setBatchDetails] = useState<RunDetailPayload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [version, setVersion] = useState(0);
  const load = useCallback(async () => {
    try {
      const primary = await api<RunDetailPayload>('/api/runs/' + runId);
      const batch = await api<{ runs: RunDetailPayload['run'][] }>('/api/runs?brief_id=' + encodeURIComponent(primary.run.brief_id) + '&size=50');
      const details = await Promise.all(batch.runs.map((run) => run.id === runId ? primary : api<RunDetailPayload>('/api/runs/' + run.id)));
      const ourProduct = primary.run.snapshot?.our_product;
      const withoutOurProduct = details.filter((item) => !isOurProductRun(item, ourProduct));
      setDetail(primary); setBatchDetails(withoutOurProduct.length ? withoutOurProduct : details); setError(null);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加载失败'); }
  }, [runId]);
  const refresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);
  useEffect(() => { void refresh(); }, [refresh]);
  const live = batchDetails.some((item) => ACTIVE.has(item.run.status)) || (detail !== null && ACTIVE.has(detail.run.status));
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  async function act(path: string, success: string, targetRunIds: string[] = [runId]) {
    setBusy(true); setFeedback({ tone: 'pending', message: '请求已提交，正在同步运行状态…' });
    try {
      await Promise.all(targetRunIds.map((targetRunId) => api('/api/runs/' + targetRunId + '/' + path, { method: 'POST' })));
      setFeedback({ tone: 'success', message: success }); notify(success); await load(); setVersion((v) => v + 1);
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : '操作失败';
      const blocked = raw.includes('EVIDENCE_GATE_FAILED');
      const message = blocked && detail ? gateMessage(detail.gate) : raw;
      setFeedback({ tone: blocked ? 'blocked' : 'error', message }); notify(message); await load();
    } finally { setBusy(false); }
  }

  if (!detail) return <><div className="detail-bar"><Button tone="quiet" onClick={onBack}>← 返回列表</Button></div><Card>{error ? <p className="error">{error}</p> : <Empty>加载运行详情中…</Empty>}</Card></>;
  const { run, stages, gate } = detail;
  const displayedDetails = batchDetails.length ? batchDetails : [detail];
  const batchComplete = displayedDetails.length > 0 && displayedDetails.every((item) => isRunAnalysisComplete(item.run, item.stages));
  const batchProgress = batchComplete ? 100 : Math.round(displayedDetails.reduce((sum, item) => sum + effectiveRunProgress(item.run, item.stages, item.artifacts), 0) / displayedDetails.length);
  const batchNames = displayedDetails.map((item) => item.run.snapshot?.competitor?.name).filter(Boolean).join('、');
  const pausedRuns = displayedDetails.filter((item) => item.run.status === 'waiting_review'
    && !isRunAnalysisComplete(item.run, item.stages));
  const failedRunIds = displayedDetails.filter((item) => item.run.status === 'failed').map((item) => item.run.id);
  const activeRunIds = displayedDetails.filter((item) => ACTIVE.has(item.run.status)).map((item) => item.run.id);
  const pausedAtGate = run.status === 'waiting_review' && !isRunAnalysisComplete(run, stages);
  const resume = () => {
    const readyIds = pausedRuns.filter((item) => item.gate.allowed).map((item) => item.run.id);
    if (!readyIds.length) {
      const message = '未继续运行：所选竞品仍有声明未通过证据审核。';
      setFeedback({ tone: 'blocked', message }); notify(message); return;
    }
    void act('retry', '已受理：' + readyIds.length + ' 条运行已重新排队，将从竞争对比阶段继续。', readyIds);
  };

  return <><div className="detail-bar">
    <Button tone="quiet" onClick={onBack}>← 返回列表</Button>
    <div className="detail-bar-actions">
      {!!pausedRuns.length && <Button onClick={resume} disabled={busy}>{busy ? '提交中…' : '继续可运行项'}</Button>}
      {!!failedRunIds.length && <Button onClick={() => void act('retry', '已受理：正在重试失败阶段。', failedRunIds)} disabled={busy}>{busy ? '提交中…' : '重试失败项'}</Button>}
      {!!activeRunIds.length && <Button tone="danger" onClick={() => { if (window.confirm('确认取消该批次中正在执行的运行？')) void act('cancel', '批次运行已取消。', activeRunIds); }} disabled={busy}>取消批次</Button>}
      <Button tone="quiet" onClick={() => void refresh()} disabled={busy || refreshing}>{refreshing ? '刷新中…' : '刷新'}</Button>
    </div>
  </div>
  <Card title="运行概览" action={<Badge tone={STATUS_TONE[run.status]}>{RUN_LABELS[run.status] ?? '未知状态'}</Badge>}>
    <div className="run-overview">
      <div className="run-title"><h3>{batchNames || '多竞品对比分析'}</h3><div className="mono small">批次 {run.brief_id.slice(0, 8)} · {displayedDetails.length} 个竞品</div></div>
      <div className="progress-block"><div className={'progress-track' + (live ? ' progress-track--active' : '')}><div className="progress-fill" style={{ width: batchProgress + '%' }} /></div><span className="muted">批次总体进度 {batchProgress}%{run.current_stage ? ' · 当前阶段：' + (STAGE_LABELS[run.current_stage] ?? '未知阶段') : ''}</span><small className="progress-caption">{progressDescription(run, batchProgress, batchComplete)}</small></div>
    </div>
    {feedback && <p className={'run-feedback run-feedback--' + feedback.tone} aria-live="polite">{feedback.message}</p>}
    {run.status === 'failed' && <p className="notice notice--error">{run.error_code ? '[' + run.error_code + '] ' : ''}{run.error_message ?? '运行失败'}</p>}
    {pausedAtGate && <div className={'gate-status' + (gate.allowed ? ' gate-status--ready' : '')}><strong>证据门禁</strong><span>声明已通过 {gate.verified}/{gate.total}</span>{gate.rejected > 0 && <span>已驳回 {gate.rejected}</span>}<p>{gate.allowed ? '门禁已满足，可以继续运行。' : gateMessage(gate)}</p></div>}
    {batchComplete && <p className="notice">分析阶段已完成，请在下方查看结果。</p>}
  </Card>
  <AnalysisWorkspace details={displayedDetails} refreshing={refreshing} onRefresh={() => void refresh()} />
  <div className="batch-review-stack">{displayedDetails.map((item) => <section className="batch-review" key={item.run.id}>
    <div className="batch-review__title"><span className="eyebrow">证据门禁</span><h2>{item.run.snapshot?.competitor?.name ?? '竞品'}审核</h2></div>
    <EvidencePanel runId={item.run.id} notify={notify} reloadKey={version} onChanged={() => { setVersion((v) => v + 1); void load(); }} />
    <ClaimsPanel runId={item.run.id} notify={notify} reloadKey={version} onChanged={() => { setVersion((v) => v + 1); void load(); }} />
  </section>)}</div>
  </>;
}
