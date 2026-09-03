import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty } from '@ui/index.js';
import type { Evidence, ReviewStatus } from './models.js';
import { api } from './api.js';
import { REVIEW_LABELS, SOURCE_LABELS, STATUS_TONE } from './constants.js';
import { fmtTs, label, textSnippet } from './format.js';
import { EvidenceDetails } from './EvidenceDetails.js';

interface Props {
  runId: string;
  notify: (message: string) => void;
  /** 外部（如声明面板）触发本面板重拉。 */
  reloadKey: number;
  /** 本面板完成一次审核后通知外部同步刷新。 */
  onChanged: () => void;
}

const FILTERS: Array<ReviewStatus | 'all'> = ['all', 'pending', 'verified', 'rejected', 'disputed', 'expired'];
const PAGE_SIZE = 20;

export function EvidencePanel({ runId, notify, reloadKey, onChanged }: Props) {
  const [rows, setRows] = useState<Evidence[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<ReviewStatus | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE) });
      if (filter !== 'all') q.set('status', filter);
      const data = await api<{ evidence: Evidence[]; total: number }>(`/api/runs/${runId}/evidence?${q}`);
      setRows(data.evidence); setTotal(data.total); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '证据加载失败'); }
  }, [runId, page, filter]);

  useEffect(() => { void load(); }, [load, reloadKey]);

  async function review(ev: Evidence, status: 'verified' | 'rejected') {
    const reason = status === 'verified' ? '控制台人工核验通过' : window.prompt('请输入驳回原因')?.trim();
    if (!reason) return;
    setBusyId(ev.id);
    try {
      await api(`/api/evidence/${ev.id}/review`, { method: 'PATCH', body: JSON.stringify({ status, reason }) });
      notify(status === 'verified' ? '证据已通过' : '证据已驳回（依赖的声明/报告已级联作废）');
      await load(); onChanged();
    } catch (cause) { notify(cause instanceof Error ? cause.message : '审核失败'); }
    finally { setBusyId(null); }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card
      title="该运行的证据"
      action={
        <div className="panel-actions">
          <span className="muted">共 {total} 条</span>
          <button className="chip-btn" onClick={() => setPage(1)} disabled={!error && page <= 1}>‹</button>
          <button className="chip-btn" onClick={() => setPage(pages)} disabled={!error && page >= pages}>›</button>
        </div>
      }
    >
      <div className="chip-row filter-row">
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`chip-btn${filter === f ? ' active' : ''}`}
            onClick={() => { setFilter(f); setPage(1); }}
          >
            {f === 'all' ? '全部' : (REVIEW_LABELS[f] ?? f)}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {!rows.length ? <Empty>该运行暂无 {filter === 'all' ? '' : (REVIEW_LABELS[filter] ?? filter)}证据</Empty> : (
        <div className="evidence-list">
          {rows.map((ev) => (
            <article className="evidence-item" key={ev.id}>
              <div className="evidence-main">
                <div className="evidence-meta">
                  <Badge>{label(SOURCE_LABELS, ev.source_type) ?? '其他来源'}</Badge>
                  <Badge tone={STATUS_TONE[ev.status]}>{REVIEW_LABELS[ev.status] ?? '未知状态'}</Badge>
                  <span className="mono small">{ev.id.slice(0, 8)}</span>
                  {ev.http_status != null && <span className="muted">HTTP {ev.http_status}</span>}
                  {ev.market && <span className="muted">{ev.market}</span>}
                </div>
                <h3>{ev.title || ev.final_url || '未命名证据'}</h3>
                <p>{textSnippet(ev.raw_content)}</p>
                <div className="status-line">
                  <span>采集于 {fmtTs(ev.captured_at)}</span>
                  {ev.content_type && <span>{ev.content_type}</span>}
                  {ev.review_reason && <span className="muted">理由：{ev.review_reason}</span>}
                  {ev.final_url && (
                    <a href={ev.final_url} target="_blank" rel="noreferrer">查看原始来源 ↗</a>
                  )}
                </div>
                <button className="chip-btn" onClick={() => setExpanded(expanded === ev.id ? null : ev.id)}>{expanded === ev.id ? '收起详情' : '查看详情'}</button>
                {expanded === ev.id && <EvidenceDetails evidence={ev} />}
              </div>
              <>
                <div className="review-actions">
                  {ev.status !== 'verified' && <Button className="button--sm" onClick={() => void review(ev, 'verified')} disabled={busyId === ev.id}>{ev.status === 'pending' ? '通过' : '重新通过'}</Button>}
                  {ev.status !== 'rejected' && <Button tone="danger" className="button--sm" title="驳回将级联作废依赖的声明/报告" onClick={() => void review(ev, 'rejected')} disabled={busyId === ev.id}>驳回</Button>}
                </div>
              </>
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}
