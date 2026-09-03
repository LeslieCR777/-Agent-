import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty } from '@ui/index.js';
import type { Evidence, ReviewStatus } from './models.js';
import { api } from './api.js';
import { REVIEW_LABELS, SOURCE_LABELS, STATUS_TONE } from './constants.js';
import { fmtTs, label, textSnippet } from './format.js';
import { EvidenceDetails } from './EvidenceDetails.js';

const FILTERS: ReviewStatus[] = ['pending', 'verified', 'rejected', 'disputed', 'expired'];

export function EvidenceQueue({ notify, onChanged }: { notify: (message: string) => void; onChanged: () => void }) {
  const [filter, setFilter] = useState<ReviewStatus>('pending');
  const [rows, setRows] = useState<Evidence[]>([]);
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ evidence: Evidence[]; total: number }>(`/api/evidence?status=${filter}&size=50`);
      setRows(data.evidence); setTotal(data.total);
    } catch (cause) { notify(cause instanceof Error ? cause.message : '证据加载失败'); }
  }, [filter, notify]);
  useEffect(() => { void load(); }, [load]);

  async function review(item: Evidence, status: 'verified' | 'rejected') {
    const reason = status === 'verified' ? '控制台人工核验通过' : window.prompt('请输入驳回原因')?.trim();
    if (!reason) return;
    setBusy(item.id);
    try {
      await api(`/api/evidence/${item.id}/review`, { method: 'PATCH', body: JSON.stringify({ status, reason }) });
      notify(status === 'verified' ? '证据已通过' : '证据已驳回');
      await load(); onChanged();
    } catch (cause) { notify(cause instanceof Error ? cause.message : '审核失败'); }
    finally { setBusy(null); }
  }

  return <Card title="证据审核" action={<Badge tone={filter === 'pending' ? 'warning' : 'neutral'}>{total} 条</Badge>}>
    <div className="chip-row filter-row">{FILTERS.map((item) => <button key={item} className={`chip-btn${filter === item ? ' active' : ''}`} onClick={() => { setFilter(item); setExpanded(null); }}>{REVIEW_LABELS[item] ?? item}</button>)}</div>
    {!rows.length ? <Empty>暂无{REVIEW_LABELS[filter] ?? filter}证据</Empty> : <div className="evidence-list">{rows.map((item) => {
      const open = expanded === item.id;
      return <article key={item.id} className="evidence-item"><div className="evidence-main">
        <div className="evidence-meta"><Badge>{label(SOURCE_LABELS, item.source_type) ?? 'source'}</Badge><Badge tone={STATUS_TONE[item.status]}>{REVIEW_LABELS[item.status]}</Badge><span className="mono small">{item.id.slice(0, 8)}</span></div>
        <h3>{item.title || item.final_url || '未命名证据'}</h3><p>{textSnippet(item.raw_content)}</p>
        <div className="status-line"><span>采集于 {fmtTs(item.captured_at)}</span>{item.review_reason && <span>理由：{item.review_reason}</span>}{item.final_url && <a href={item.final_url} target="_blank" rel="noreferrer">来源 ↗</a>}</div>
        <button className="chip-btn" onClick={() => setExpanded(open ? null : item.id)}>{open ? '收起详情' : '查看详情'}</button>
        {open && <EvidenceDetails evidence={item} />}
      </div><div className="review-actions">{item.status !== 'verified' && <Button className="button--sm" disabled={busy === item.id} onClick={() => void review(item, 'verified')}>{item.status === 'pending' ? '通过' : '重新通过'}</Button>}{item.status !== 'rejected' && <Button tone="danger" className="button--sm" disabled={busy === item.id} onClick={() => void review(item, 'rejected')}>驳回</Button>}</div></article>;
    })}</div>}
  </Card>;
}
