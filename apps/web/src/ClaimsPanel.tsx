import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty } from '@ui/index.js';
import type { ClaimRow, ReviewStatus } from './models.js';
import { api } from './api.js';
import { CLAIM_TYPE_LABELS, REVIEW_LABELS, STATUS_TONE } from './constants.js';
import { fmtConfidence, fmtTs, label, textSnippet } from './format.js';

interface Props {
  runId: string;
  notify: (message: string) => void;
  reloadKey: number;
  onChanged: () => void;
}

// claims 接口无 status=all，仅按具体状态查询（默认 pending）。
const FILTERS: ReviewStatus[] = ['pending', 'verified', 'rejected', 'disputed', 'expired'];
const PAGE_SIZE = 20;

export function ClaimsPanel({ runId, notify, reloadKey, onChanged }: Props) {
  const [rows, setRows] = useState<ClaimRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<ReviewStatus>('pending');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ run_id: runId, status: filter, page: String(page), size: String(PAGE_SIZE) });
      const data = await api<{ claims: ClaimRow[]; total: number }>(`/api/claims?${q}`);
      setRows(data.claims); setTotal(data.total); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '声明加载失败'); }
  }, [runId, filter, page]);

  useEffect(() => { void load(); }, [load, reloadKey]);

  async function review(claim: ClaimRow, status: 'verified' | 'rejected') {
    if (status === 'rejected') {
      const reason = window.prompt('请输入驳回原因')?.trim();
      if (!reason) return;
      await send(claim.id, status, reason);
      return;
    }
    // 先告知门禁规则；后端校验不满足会再以 400 抛回。
    const gateNeeded = claim.claim_type === 'market_share' || claim.claim_type === 'sales';
    if (gateNeeded && !window.confirm('市占/销量类声明需 ≥2 条已核验的证据来源；全部关联证据也须已通过。继续？')) return;
    await send(claim.id, status, '控制台人工核验通过');
  }

  async function send(id: string, status: ReviewStatus, reason: string) {
    setBusyId(id);
    try {
      await api(`/api/claims/${id}/review`, { method: 'PATCH', body: JSON.stringify({ status, reason }) });
      notify(status === 'verified' ? '声明已通过' : '声明已驳回');
      await load(); onChanged();
    } catch (cause) { notify(cause instanceof Error ? cause.message : '审核失败'); }
    finally { setBusyId(null); }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card
      title="该运行的声明（Claims）"
      action={
        <div className="panel-actions">
          <span className="muted">共 {total} 条</span>
          <button className="chip-btn" onClick={() => setPage(1)} disabled={page <= 1}>‹</button>
          <button className="chip-btn" onClick={() => setPage(pages)} disabled={page >= pages}>›</button>
        </div>
      }
    >
      <div className="chip-row filter-row">
        {FILTERS.map((f) => (
          <button key={f} className={`chip-btn${filter === f ? ' active' : ''}`} onClick={() => { setFilter(f); setPage(1); }}>
            {REVIEW_LABELS[f] ?? f}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {!rows.length ? <Empty>该运行暂无{(REVIEW_LABELS[filter] ?? filter)}声明</Empty> : (
        <div className="evidence-list">
          {rows.map((claim) => (
            <article className="evidence-item" key={claim.id}>
              <div className="evidence-main">
                <div className="evidence-meta">
                  <Badge>{label(CLAIM_TYPE_LABELS, claim.claim_type) ?? claim.claim_type}</Badge>
                  <Badge tone={STATUS_TONE[claim.status]}>{REVIEW_LABELS[claim.status] ?? '未知状态'}</Badge>
                  <span className="mono small">{claim.id.slice(0, 8)}</span>
                  <span className="muted">置信度 {fmtConfidence(claim.confidence)}</span>
                  {claim.market && <span className="muted">{claim.market}</span>}
                </div>
                <h3>{claim.statement}</h3>
                <p className="claim-subject">主体：{claim.subject}{claim.valid_at ? ` · 有效期 ${fmtTs(claim.valid_at)}` : ''}</p>
                {!!claim.evidence_ids.length && (
                  <div className="chip-row">
                    <span className="muted">证据：</span>
                    {claim.evidence_ids.map((id) => <span className="chip mono" key={id}>{id.slice(0, 8)}</span>)}
                  </div>
                )}
                {claim.review_reason && <div className="status-line"><span className="muted">理由：{textSnippet(claim.review_reason, 200)}</span></div>}
                <div className="status-line"><span>创建于 {fmtTs(claim.created_at)}</span></div>
              </div>
              <>
                <div className="review-actions">
                  {claim.status !== 'verified' && <Button className="button--sm" title="需关联证据全部已核验通过（市占/销量需 ≥2 条）" onClick={() => void review(claim, 'verified')} disabled={busyId === claim.id}>{claim.status === 'pending' ? '通过' : '重新通过'}</Button>}
                  {claim.status !== 'rejected' && <Button tone="danger" className="button--sm" onClick={() => void review(claim, 'rejected')} disabled={busyId === claim.id}>驳回</Button>}
                </div>
              </>
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}
