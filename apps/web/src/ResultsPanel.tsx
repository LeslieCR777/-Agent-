import { Badge, Button, Card, Empty } from '@ui/index.js';
import type { RunArtifacts, RunStatus } from './models.js';

export function ResultsPanel({ artifacts, status, progress, competitorOnly = false, comparisonNames = [], onRefresh, refreshing }: {
  artifacts: RunArtifacts; status: RunStatus; progress: number; competitorOnly?: boolean; comparisonNames?: string[];
  onRefresh: () => void; refreshing: boolean;
}) {
  const matrix = artifacts.matrices[0];
  const battlecard = competitorOnly ? undefined : artifacts.battlecards[0];
  const report = competitorOnly ? undefined : artifacts.reports[0];
  const empty = !matrix && !battlecard && !report && !artifacts.insights.length;
  const complete = progress >= 100 || Boolean(report || battlecard);
  const leftName = matrix?.left_competitor || comparisonNames[0] || '竞品 1';
  const rightName = matrix?.right_competitor || comparisonNames[1] || '竞品 2';
  return <Card title={complete ? (competitorOnly ? '竞品对比结果' : '完整分析结果') : '阶段性研究结果'} action={report && <Badge tone="success">报告 v{report.version} · {reportStatus(report.status)}</Badge>}>
    {!complete && !empty && <p className="notice">{competitorOnly ? '当前展示的是调研阶段已经生成的内容。证据审核通过后会生成双竞品对比。' : '当前展示的是调研阶段已经生成的内容。证据与声明审核通过后，系统会继续生成竞争对比、销售战卡和质量检查结果。'}</p>}
    {empty && progress >= 100 ? <div className="result-empty result-empty--attention">
      <strong>运行已完成，但尚未读取到分析产物</strong><p>请刷新结果；如果仍为空，请查看失败阶段并重试。</p>
      <Button tone="quiet" onClick={onRefresh} disabled={refreshing}>{refreshing ? '刷新中…' : '刷新结果'}</Button>
    </div> : empty ? <Empty>{status === 'queued' || status === 'running' ? '分析执行中，结果生成后会显示在这里' : '本次运行尚未生成分析产物'}</Empty> : <div className="results-stack">
      {report && <section className="result-block"><h3>{report.content.title ?? '分析报告'}</h3><p>{report.content.summary ?? '—'}</p></section>}
      {!!artifacts.insights.length && <section className="result-block"><h3>深度研究洞察</h3>{artifacts.insights.map((item) => <article key={item.id} className="insight insight--detailed">
        <div className="insight-heading"><h4>{item.topic}</h4>{item.confidence != null && <Badge tone={item.confidence >= .7 ? 'success' : item.confidence >= .5 ? 'warning' : 'neutral'}>置信度 {Math.round(item.confidence * 100)}%</Badge>}</div>
        <p>{item.summary ?? '—'}</p><ResultList title="关键发现" rows={item.key_findings} />
        {!!item.sources?.length && <div className="result-sources"><h5>参考来源</h5><ol>{item.sources.map((source, index) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a></li>)}</ol></div>}
      </article>)}</section>}
      {matrix && <section className="result-block"><h3>竞争对比</h3><p>{matrix.overall_assessment ?? '—'}</p>
        {!!matrix.dimensions.length && <div className="table-wrap"><table><thead><tr><th>维度</th><th>{leftName}</th><th>{rightName}</th><th>说明</th></tr></thead><tbody>
          {matrix.dimensions.map((item) => { const leftScore = item.left_score ?? item.our_score ?? 0; const rightScore = item.right_score ?? item.competitor_score ?? 0; return <tr key={item.dimension}><td>{item.dimension}</td><td>{leftScore}</td><td>{rightScore}</td><td>{item.notes ?? '—'}</td></tr>; })}
        </tbody></table></div>}
      </section>}
      {battlecard && <section className="result-block"><div className="insight-heading"><h3>销售战卡</h3>{battlecard.quality_score != null && <Badge tone={battlecard.quality_score >= 7 ? 'success' : 'warning'}>质量评分 {battlecard.quality_score}/10</Badge>}</div><p>{battlecard.content.elevator_pitch ?? '—'}</p>
        <div className="result-columns"><ResultList title="我方优势" rows={battlecard.content.our_strengths} /><ResultList title="我方短板" rows={battlecard.content.our_weaknesses} /><ResultList title="关键差异" rows={battlecard.content.key_differentiators} /><ResultList title="竞品强项" rows={battlecard.content.competitor_strengths} /><ResultList title="竞品弱点" rows={battlecard.content.competitor_weaknesses} /><Objections rows={battlecard.content.objection_handling} /></div>
      </section>}
    </div>}
  </Card>;
}

function reportStatus(status: string): string {
  return ({ draft: '草稿', reviewing: '审核中', approved: '已批准', published: '已发布', superseded: '已替代', rejected: '已驳回' } as Record<string, string>)[status] ?? '状态未知';
}
function ResultList({ title, rows = [] }: { title?: string; rows?: string[] }) {
  if (!rows.length) return null;
  return <div>{title && <h4>{title}</h4>}<ul>{rows.map((row, index) => <li key={`${index}-${row}`}>{row}</li>)}</ul></div>;
}
function Objections({ rows = {} }: { rows?: Record<string, string> }) {
  const entries = Object.entries(rows); if (!entries.length) return null;
  return <div><h4>异议处理</h4><ul>{entries.map(([question, answer]) => <li key={question}><strong>{question}：</strong>{answer}</li>)}</ul></div>;
}
