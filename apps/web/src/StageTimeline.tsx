import { Badge, Card, Empty } from '@ui/index.js';
import type { RunStageRow, StageKind } from './models.js';
import { STAGE_LABELS, STAGE_ORDER, STAGE_PROGRESS, STATUS_TONE } from './constants.js';
import { fmtDuration, fmtTs, textSnippet } from './format.js';

interface Props {
  stages: RunStageRow[];
  /** run.current_stage —— 高亮正在执行的阶段 chip。 */
  currentStage: StageKind | null;
}

const STAGE_STATUS_LABELS: Record<string, string> = {
  queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消',
};

function finalStatus(rows: RunStageRow[]): RunStageRow['status'] | null {
  return rows.length ? rows[rows.length - 1].status : null; // 后端已按 round, created_at 排序
}

export function StageTimeline({ stages, currentStage }: Props) {
  if (!stages.length) {
    return (
      <Card title="阶段时间线" action={<span className="muted">尚无阶段</span>}>
        <Empty>该运行尚未产生阶段记录</Empty>
      </Card>
    );
  }

  const grouped = STAGE_ORDER
    .map((stage) => ({ stage, rows: stages.filter((s) => s.stage === stage) }))
    .filter((g) => g.rows.length > 0);

  return (
    <Card title="阶段时间线" action={<span className="muted">{stages.length} 条阶段记录</span>}>
      <div className="stage-tabs">
        {STAGE_ORDER.map((stage) => {
          const rows = stages.filter((s) => s.stage === stage);
          const st = finalStatus(rows);
          const active = stage === currentStage && (st === 'running' || st === 'queued');
          return (
            <span className={`stage-tab${active ? ' active' : ''}`} key={stage}>
              <span className="stage-tab-name">{STAGE_LABELS[stage]}</span>
              {rows.length > 1 && <em className="stage-round">×{rows.length}</em>}
              <small>{st ? STAGE_STATUS_LABELS[st] : '未开始'} · {STAGE_PROGRESS[stage]}%</small>
            </span>
          );
        })}
      </div>

      {grouped.map(({ stage, rows }) => (
        <section className="stage-group" key={stage}>
          <h4 className="stage-group-title">
            {STAGE_LABELS[stage]}
            <span className="muted small">目标进度 {STAGE_PROGRESS[stage]}%</span>
          </h4>
          {rows.map((s) => (
            <div className={`timeline-row timeline-row--${s.status}`} key={s.id}>
              <span className={`dot dot--${s.status}`} aria-hidden="true" />
              <div className="timeline-main">
                <div className="timeline-top">
                  <Badge tone={STATUS_TONE[s.status]}>{STAGE_STATUS_LABELS[s.status]}</Badge>
                  {s.round > 0 && <Badge tone="warning">回炉 R{s.round}</Badge>}
                  {s.attempt > 1 && <span className="chip">尝试 ×{s.attempt}</span>}
                  {s.model && <span className="chip mono">{s.model}</span>}
                  {!!s.tools?.length && (
                    <span className="chip-row">
                      {s.tools.slice(0, 6).map((t) => <span className="chip mono" key={t}>{t}</span>)}
                    </span>
                  )}
                </div>
                {s.output_ref?.result && <p className="snippet">{textSnippet(s.output_ref.result, 260)}</p>}
                {s.status === 'failed' && s.error_message && (
                  <p className="stage-error">{textSnippet(s.error_message, 400)}</p>
                )}
                <div className="status-line">
                  <span>开始 {fmtTs(s.started_at)}</span>
                  <span>结束 {fmtTs(s.finished_at)}</span>
                  <span>用时 {fmtDuration(s.started_at, s.finished_at)}</span>
                  {s.task_id && <span className="mono">task {s.task_id.slice(0, 8)}</span>}
                </div>
              </div>
            </div>
          ))}
        </section>
      ))}
    </Card>
  );
}
