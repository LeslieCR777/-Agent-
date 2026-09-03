import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty } from '@ui/index.js';
import { api } from './api.js';
import type { Competitor, ProjectDashboardRow, ProjectRow } from './models.js';
import { ProjectDetail } from './ProjectDetail.js';
import { PROJECT_STATUS_LABELS } from './constants.js';
import { CompetitorQuickAdd } from './CompetitorQuickAdd.js';

interface Props {
  notify: (message: string) => void;
  onCompetitorsChanged: () => void;
  onOpenCompetitors: () => void;
}

export function Projects({ notify, onCompetitorsChanged, onOpenCompetitors }: Props) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [competitorCount, setCompetitorCount] = useState(0);
  const [dashboards, setDashboards] = useState<Record<string, ProjectDashboardRow>>({});
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [result, competitorResult] = await Promise.all([
        api<{ projects: ProjectRow[] }>('/api/projects'),
        api<{ competitors: Competitor[] }>('/api/competitors'),
      ]);
      setProjects(result.projects);
      setCompetitorCount(competitorResult.competitors.length);
      const entries = await Promise.all(result.projects.map(async (project) => {
        const data = await api<{ dashboard: ProjectDashboardRow }>(`/api/projects/${project.id}/dashboard`);
        return [project.id, data.dashboard] as const;
      }));
      setDashboards(Object.fromEntries(entries));
    } catch (error) { notify(error instanceof Error ? error.message : '项目加载失败'); }
  }, [notify]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    // 异步 handler 里 React 会把 currentTarget 置空，先保存表单引用供 reset 使用
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const list = (name: string) => String(form.get(name) ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    try {
      await api('/api/projects', { method: 'POST', body: JSON.stringify({
        name: form.get('name'), objective: form.get('objective'), market: form.get('market'),
        channels: list('channels'), topics: list('topics'), source_policy: { official_first: true },
      }) });
      formEl.reset(); notify('研究项目已创建'); await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : '项目创建失败'); }
    finally { setBusy(false); }
  }

  function openProject(id: string) {
    setSelectedId(id);
  }

  if (selectedId) {
    return (
      <ProjectDetail
        projectId={selectedId}
        notify={notify}
        onBack={() => { setSelectedId(null); void refresh(); }}
      />
    );
  }

  return <>
    <section className='research-workflow' aria-label='竞品研究工作流'>
      <div><span>01</span><strong>登记竞品</strong><small>名称与监控入口</small></div>
      <div><span>02</span><strong>定义项目</strong><small>市场、渠道与主题</small></div>
      <div><span>03</span><strong>分析运行</strong><small>实时查看执行阶段</small></div>
      <div><span>04</span><strong>证据与报告</strong><small>审核来源并沉淀结论</small></div>
    </section>
    <Card title='快速加入竞品' action={<div className='card-actions'><span className='muted'>已登记 {competitorCount} 个</span><Button tone='quiet' className='button--sm' onClick={onOpenCompetitors}>打开完整竞品库</Button></div>}>
      <p className='section-intro'>入口固定保留在研究项目页。添加后可前往竞品库设置备注、启停监控或直接执行全量分析。</p>
      <CompetitorQuickAdd notify={notify} onCreated={async () => { await refresh(); onCompetitorsChanged(); }} />
    </Card>
    <Card title="创建持续研究项目">
      <form className="project-form" onSubmit={submit}>
        <label>项目名称<input name="name" required placeholder="足球鞋中国市场价格研究" /></label>
        <label>目标市场<input name="market" required placeholder="CN" /></label>
        <label className="wide">研究目标<input name="objective" required placeholder="持续追踪重点 SKU 的价格与参数变化" /></label>
        <label>渠道（逗号分隔）<input name="channels" required placeholder="官网, 电商" /></label>
        <label>主题（逗号分隔）<input name="topics" required placeholder="价格, 新品" /></label>
        <Button type="submit" disabled={busy}>{busy ? '创建中…' : '创建项目'}</Button>
      </form>
    </Card>
    <Card title="研究项目" action={<span className="muted">{projects.length} 个</span>}>
      {!projects.length ? <Empty>暂无研究项目</Empty> : <div className="project-grid">{projects.map((project) => {
        const dashboard = dashboards[project.id];
        return <article
          className="project-card project-card--link"
          key={project.id}
          role="button"
          tabIndex={0}
          onClick={() => openProject(project.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProject(project.id); } }}
        >
          <div><Badge tone="success">{PROJECT_STATUS_LABELS[project.status ?? ''] ?? '状态未知'}</Badge><span className="small">{project.market}</span></div>
          <h3>{project.name}</h3><p>{project.objective}</p>
          <div className="project-metrics">
            <span><strong>{dashboard?.sku_count ?? 0}</strong> SKU</span>
            <span><strong>{dashboard?.price_snapshot_count ?? 0}</strong> 价格快照</span>
            <span><strong>{project.channels.length}</strong> 渠道</span>
          </div>
          <span className="enter-hint">查看详情 →</span>
        </article>;
      })}</div>}
    </Card>
  </>;
}
