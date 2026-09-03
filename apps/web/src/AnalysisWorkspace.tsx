import { Badge, Card, Empty } from '@ui/index.js';
import type { RunDetailPayload, RunStageRow, StageKind } from './models.js';
import { ResultsPanel } from './ResultsPanel.js';
import { RUN_LABELS, STAGE_LABELS, STAGE_ORDER, STATUS_TONE } from './constants.js';
import { fmtTs, textSnippet } from './format.js';
import { effectiveRunProgress, isCompetitorOnlyRun, isRunAnalysisComplete } from './runProgress.js';

interface Props {
  details: RunDetailPayload[];
  refreshing: boolean;
  onRefresh: () => void;
}

const STAGE_STATUS: Record<string, string> = {
  queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消',
};
const COMPETITOR_ONLY_STAGE_ORDER: StageKind[] = ['monitor', 'research', 'compare'];

function competitorName(detail: RunDetailPayload): string {
  return detail.run.snapshot?.competitor?.name || '未命名竞品';
}

function comparisonNames(detail: RunDetailPayload): string[] {
  return (detail.run.snapshot?.comparison_competitors ?? [])
    .map((item) => item.name)
    .filter((name): name is string => Boolean(name));
}

function latestStage(rows: RunStageRow[], stage: StageKind): RunStageRow | undefined {
  return rows.filter((item) => item.stage === stage).at(-1);
}

function stageMessage(row: RunStageRow): string {
  if (row.status === 'running') return 'Agent 正在执行 ' + STAGE_LABELS[row.stage] + '…';
  if (row.status === 'queued') return '已进入队列，等待 Agent 接手';
  if (row.status === 'failed') return row.error_message || '阶段执行失败';
  return row.output_ref?.result ? textSnippet(row.output_ref.result, 360) : STAGE_LABELS[row.stage] + ' 已完成';
}

export function AnalysisWorkspace({ details, refreshing, onRefresh }: Props) {
  const complete = details.length > 0 && details.every((item) => isRunAnalysisComplete(item.run, item.stages));
  const active = details.some((item) => item.run.status === 'queued' || item.run.status === 'running');
  const streamRows = details.flatMap((detail) => detail.stages.map((stage) => ({
    detail, stage, time: stage.started_at || stage.created_at || detail.run.created_at,
  }))).sort((a, b) => String(a.time).localeCompare(String(b.time)));

  return (
    <div className='analysis-workspace'>
      <Card className='agent-flow' title='Agent 协作流程' action={<span className='live-indicator'>{complete ? '已结束' : active ? 'LIVE' : '等待审核'}</span>}>
        {!details.length ? <Empty>等待分析任务</Empty> : details.map((detail) => (
          <section className='agent-run' key={detail.run.id}>
            <div className='agent-run__head'>
              <strong>{competitorName(detail)}</strong>
              <Badge tone={STATUS_TONE[detail.run.status]}>{RUN_LABELS[detail.run.status] || '未知状态'}</Badge>
            </div>
            <div className='agent-stage-list'>
              {(isCompetitorOnlyRun(detail.run) ? COMPETITOR_ONLY_STAGE_ORDER : STAGE_ORDER).map((stage) => {
                const row = latestStage(detail.stages, stage);
                const status = row?.status || (detail.run.current_stage === stage ? 'running' : 'idle');
                return (
                  <div className={'agent-stage agent-stage--' + status} key={stage}>
                    <span className='agent-stage__dot' />
                    <div><strong>{STAGE_LABELS[stage]}</strong><small>{row ? STAGE_STATUS[row.status] : '未开始'}</small></div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </Card>

      <div className='analysis-output'>
        <Card title={complete ? '执行记录' : '流式执行输出'} action={<span className='muted'>{streamRows.length} 条更新</span>}>
          {!streamRows.length ? <Empty>Agent 启动后，输出会持续显示在这里</Empty> : (
            <div className='stream-console' aria-live='polite'>
              {streamRows.map(({ detail, stage, time }) => (
                <article className={'stream-line stream-line--' + stage.status} key={stage.id}>
                  <div className='stream-line__meta'>
                    <time>{fmtTs(time)}</time>
                    <span>{competitorName(detail)}</span>
                    <b>{STAGE_LABELS[stage.stage]}</b>
                  </div>
                  <p>{stageMessage(stage)}{stage.status === 'running' && <i className='stream-cursor' />}</p>
                </article>
              ))}
            </div>
          )}
        </Card>

        {complete ? (
          <>
            <ComparisonChart details={details} />
            <Card title='完整分析结果' action={<span className='muted'>{details.length} 个竞品</span>}>
              <div className='batch-result-tabs'>
                {details.map((detail) => (
                  <section className='batch-result' key={detail.run.id}>
                    <div className='batch-result__head'><h3>{competitorName(detail)}</h3><Badge tone={STATUS_TONE[detail.run.status]}>{RUN_LABELS[detail.run.status]}</Badge></div>
                    <ResultsPanel
                      artifacts={detail.artifacts}
                      status={detail.run.status}
                      progress={effectiveRunProgress(detail.run, detail.stages, detail.artifacts)}
                      competitorOnly={isCompetitorOnlyRun(detail.run)}
                      comparisonNames={comparisonNames(detail)}
                      onRefresh={onRefresh}
                      refreshing={refreshing}
                    />
                  </section>
                ))}
              </div>
            </Card>
          </>
        ) : (
          <Card title='最终结果'>
            <div className='result-waiting'><span className='result-waiting__spinner' /><strong>多 Agent 正在并行分析</strong><p>全部竞品完成后，这里将生成完整报告和多维对比图。</p></div>
          </Card>
        )}
      </div>
    </div>
  );
}

function ComparisonChart({ details }: { details: RunDetailPayload[] }) {
  const matrices = details.map((detail) => ({ detail, matrix: detail.artifacts.matrices[0] })).filter((item) => item.matrix);
  const dimensions = [...new Set(matrices.flatMap(({ matrix }) => matrix!.dimensions.map((item) => item.dimension)))].slice(0, 8);
  if (!dimensions.length) return <Card title='竞品对比图'><Empty>分析结果中暂无可绘制的评分维度</Empty></Card>;

  const first = matrices[0];
  const names = first ? comparisonNames(first.detail) : [];
  const hasPeerScores = Boolean(first?.matrix?.dimensions.some((item) => item.left_score != null || item.right_score != null));
  const series = hasPeerScores && first ? [
    {
      name: first.matrix!.left_competitor || names[0] || '竞品 1', tone: 'competitor-0',
      values: dimensions.map((dimension) => first.matrix!.dimensions.find((item) => item.dimension === dimension)?.left_score ?? 0),
    },
    {
      name: first.matrix!.right_competitor || names[1] || '竞品 2', tone: 'competitor-1',
      values: dimensions.map((dimension) => first.matrix!.dimensions.find((item) => item.dimension === dimension)?.right_score ?? 0),
    },
  ] : matrices.slice(0, 2).map(({ detail, matrix }, index) => ({
    name: competitorName(detail), tone: 'competitor-' + (index % 5),
    values: dimensions.map((dimension) => matrix!.dimensions.find((item) => item.dimension === dimension)?.competitor_score ?? 0),
  }));

  return (
    <Card title='竞品多维对比图' action={<span className='muted'>评分范围 0–10</span>}>
      <div className='comparison-legend'>{series.map((item) => <span key={item.name}><i className={'chart-swatch chart-swatch--' + item.tone} />{item.name}</span>)}</div>
      <div className='comparison-bars'>
        {dimensions.map((dimension, dimensionIndex) => (
          <section className='comparison-dimension' key={dimension}>
            <strong>{dimension}</strong>
            <div>{series.map((item) => (
              <div className='comparison-bar-row' key={item.name}>
                <span>{item.name}</span>
                <div className='comparison-bar-track'><i className={'comparison-bar chart-swatch--' + item.tone} style={{ width: Math.max(0, Math.min(100, item.values[dimensionIndex] * 10)) + '%' }} /></div>
                <b>{item.values[dimensionIndex].toFixed(1)}</b>
              </div>
            ))}</div>
          </section>
        ))}
      </div>
    </Card>
  );
}
