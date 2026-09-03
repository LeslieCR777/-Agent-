import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty } from '@ui/index.js';
import { api, auth } from './api.js';
import type { Competitor, Evidence, Run } from './models.js';
import { Projects } from './Projects.js';
import { RunDetail } from './RunDetail.js';
import { RUN_LABELS, STAGE_LABELS, STATUS_TONE } from './constants.js';
import { EvidenceQueue } from './EvidenceQueue.js';
import { CONSOLE_NAV_ITEMS, routeFromHash, routeToHash, type ConsoleRoute, type ConsoleTab } from './navigation.js';

export function App() {
  const [ready, setReady] = useState(Boolean(auth.token() || auth.legacyKey()));
  if (!ready) return <Login onReady={() => setReady(true)} />;
  return <Console onLogout={() => { auth.clear(); setReady(false); }} />;
}

function Login({ onReady }: { onReady: () => void }) {
  const [mode, setMode] = useState<'login' | 'key'>('login');
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      if (mode === 'key') auth.saveLegacyKey(String(data.get('apiKey') ?? ''));
      else {
        const result = await api<{ access_token: string }>('/api/auth/login', {
          method: 'POST', body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
        });
        auth.saveToken(result.access_token);
      }
      onReady();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败'); }
  }
  return (
    <main className="login-shell">
      <section className="login-copy">
        <span className="eyebrow">CI AGENT SWARM</span>
        <h1>让竞争情报成为<br />可审计的生产流程。</h1>
        <p>从任务边界、证据审核到最终报告，每一步都有状态、有来源、可恢复。</p>
      </section>
      <Card className="login-card">
        <div className="mode-tabs">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>账号登录</button>
          <button className={mode === 'key' ? 'active' : ''} onClick={() => setMode('key')}>开发密钥</button>
        </div>
        <form onSubmit={submit} className="stack">
          {mode === 'login' ? <>
            <label>用户名<input name="username" autoComplete="username" required /></label>
            <label>密码<input name="password" type="password" autoComplete="current-password" required /></label>
          </> : <label>API Key<input name="apiKey" type="password" required placeholder="仅限本地开发" /></label>}
          {error && <p className="error">{error}</p>}
          <Button type="submit">进入控制台</Button>
        </form>
      </Card>
    </main>
  );
}

function Console({ onLogout }: { onLogout: () => void }) {
  const [route, setRoute] = useState<ConsoleRoute>(() => routeFromHash(window.location.hash));
  const [runs, setRuns] = useState<Run[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const { tab, runId: selectedRunId } = route;
  const pageTitle = selectedRunId ? '运行详情' : CONSOLE_NAV_ITEMS.find((item) => item.key === tab)?.label ?? '研究项目';

  useEffect(() => {
    const syncRoute = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener('hashchange', syncRoute);
    return () => window.removeEventListener('hashchange', syncRoute);
  }, []);

  useEffect(() => {
    document.title = pageTitle + ' · CI Agent Swarm';
  }, [pageTitle]);

  function navigate(next: ConsoleRoute) {
    const nextHash = routeToHash(next);
    if (window.location.hash === nextHash) setRoute(next);
    else window.location.hash = nextHash;
  }

  function setSelectedRunId(next: string | null) {
    navigate({ tab: 'runs', runId: next });
  }

  function switchTab(next: ConsoleTab) {
    navigate({ tab: next, runId: null });
  }

  const refresh = useCallback(async () => {
    try {
      const [runData, evidenceData, competitorData] = await Promise.all([
        api<{ runs: Run[] }>('/api/runs?size=50'),
        api<{ evidence: Evidence[] }>('/api/evidence?status=pending&size=50'),
        api<{ competitors: Competitor[] }>('/api/competitors'),
      ]);
      setRuns(runData.runs); setEvidence(evidenceData.evidence); setCompetitors(competitorData.competitors);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '加载失败'); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 10_000); return () => clearInterval(timer); }, [refresh]);

  async function createRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    // 异步 handler 里 React 会把 currentTarget 置空，先保存表单引用供 reset 使用
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    try {
      const competitorId = String(form.get('competitor'));
      const briefResult = await api<{ brief: { id: string } }>('/api/analysis-briefs', {
        method: 'POST',
        body: JSON.stringify({
          purpose: 'competitor_only', competitor_ids: [competitorId], market: String(form.get('market')),
          included_sources: ['official', 'news'], excluded_sources: [], max_runtime_seconds: 3600,
          cost_budget: 10, allow_unverified: false,
        }),
      });
      await api('/api/runs', {
        method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ brief_id: briefResult.brief.id, competitor_id: competitorId }),
      });
      setMessage('分析已进入队列'); formEl.reset(); await refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '创建失败'); }
    finally { setBusy(false); }
  }

  async function review(item: Evidence, status: 'verified' | 'rejected') {
    const reason = status === 'verified' ? '控制台人工核验通过' : window.prompt('请输入驳回原因')?.trim();
    if (!reason) return;
    try {
      await api(`/api/evidence/${item.id}/review`, { method: 'PATCH', body: JSON.stringify({ status, reason }) });
      await refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '审核失败'); }
  }

  const inRunDetail = tab === 'runs' && selectedRunId !== null;

  return (
    <div className="app-shell">
      <aside>
        <div><span className="mark">CI</span><strong>Agent Swarm</strong></div>
        <nav aria-label='主导航'>
          <button className={tab === 'projects' ? 'active' : ''} onClick={() => switchTab('projects')}>研究项目</button>
          <button className={tab === 'runs' ? 'active' : ''} onClick={() => switchTab('runs')}>分析运行</button>
          <button className={tab === 'evidence' ? 'active' : ''} onClick={() => switchTab('evidence')}>证据审核 <em>{evidence.length}</em></button>
        </nav>
        <Button tone="quiet" onClick={onLogout}>退出登录</Button>
      </aside>
      <main className="workspace">
        <header className="page-head">
          <div><span className="eyebrow">PHASE TWO</span><h1>{inRunDetail ? '运行详情' : tab === 'projects' ? '研究项目' : tab === 'runs' ? '分析运行' : '证据审核'}</h1></div>
          {!inRunDetail && <Button tone="quiet" onClick={() => void refresh()}>刷新</Button>}
        </header>
        {message && <div className="notice">{message}</div>}
        {tab === 'projects' ? <Projects notify={setMessage} /> : tab === 'runs'
          ? inRunDetail
            ? <RunDetail runId={selectedRunId!} notify={setMessage} onBack={() => { setSelectedRunId(null); void refresh(); }} />
            : <>
              <Card title="发起分析">
                <form className="create-grid" onSubmit={createRun}>
                  <label>竞品<select name="competitor" required defaultValue=""><option value="" disabled>选择竞品</option>{competitors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
                  <label>目标市场<input name="market" required placeholder="例如：中国企业软件" /></label>
                  <Button type="submit" disabled={busy || !competitors.length}>{busy ? '创建中…' : '开始分析'}</Button>
                </form>
                {!competitors.length && <p className="hint">请先通过竞品 API 创建至少一个竞品。</p>}
              </Card>
              <Card title="最近运行" action={<span className="muted">{runs.length} 条 · 点击行查看详情</span>}>
                {!runs.length ? <Empty>暂无分析运行</Empty> : <div className="table-wrap"><table><thead><tr><th>运行</th><th>竞品</th><th>阶段</th><th>状态</th><th>进度</th><th>创建时间</th></tr></thead><tbody>{runs.map(run => <tr key={run.id} className="row-click" role="button" tabIndex={0} onClick={() => setSelectedRunId(run.id)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setSelectedRunId(run.id); } }}><td className="mono">{run.id.slice(0, 8)}</td><td>{run.snapshot?.competitor?.name ?? '—'}</td><td>{run.current_stage ? (STAGE_LABELS[run.current_stage] ?? '未知阶段') : '准备中'}</td><td><Badge tone={STATUS_TONE[run.status] ?? 'neutral'}>{RUN_LABELS[run.status] ?? '未知状态'}</Badge></td><td>{run.progress ?? 0}%</td><td>{new Date(run.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>}
              </Card>
            </>
          : <EvidenceQueue notify={setMessage} onChanged={() => void refresh()} />}
      </main>
    </div>
  );
}
