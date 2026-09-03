import type { Evidence } from './models.js';
import { fmtTs } from './format.js';

export function EvidenceDetails({ evidence }: { evidence: Evidence }) {
  return <div className="evidence-details">
    <dl className="evidence-detail-grid">
      <div><dt>请求地址</dt><dd><a href={evidence.request_url} target="_blank" rel="noreferrer">{evidence.request_url}</a></dd></div>
      {evidence.final_url && evidence.final_url !== evidence.request_url && <div><dt>最终地址</dt><dd><a href={evidence.final_url} target="_blank" rel="noreferrer">{evidence.final_url}</a></dd></div>}
      <div><dt>采集时间</dt><dd>{fmtTs(evidence.captured_at)}</dd></div>
      {evidence.published_at && <div><dt>发布时间</dt><dd>{fmtTs(evidence.published_at)}</dd></div>}
      {evidence.language && <div><dt>语言</dt><dd>{evidence.language}</dd></div>}
      {evidence.market && <div><dt>市场</dt><dd>{evidence.market}</dd></div>}
      {evidence.http_status != null && <div><dt>HTTP 状态</dt><dd>{evidence.http_status}</dd></div>}
      {evidence.content_type && <div><dt>内容类型</dt><dd>{evidence.content_type}</dd></div>}
      {evidence.body_hash && <div><dt>内容指纹</dt><dd className="mono detail-break">{evidence.body_hash}</dd></div>}
      {evidence.reviewed_at && <div><dt>审核时间</dt><dd>{fmtTs(evidence.reviewed_at)}</dd></div>}
      {evidence.reviewed_by && <div><dt>审核人</dt><dd>{evidence.reviewed_by}</dd></div>}
      {evidence.review_reason && <div><dt>审核说明</dt><dd>{evidence.review_reason}</dd></div>}
    </dl>
    <div className="evidence-content"><strong>正文快照</strong><pre>{evidence.raw_content?.trim() || '未保存正文快照，可通过上方来源地址查看原文。'}</pre></div>
  </div>;
}
