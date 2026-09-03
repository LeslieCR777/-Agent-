import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty } from '@ui/index.js';
import { api } from './api.js';
import type { Competitor } from './models.js';

interface Props {
  notify: (message: string) => void;
  onChanged: () => void;
}

function splitValues(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function monitorUrlsOf(item: Competitor): string[] {
  if (!item.monitor_urls) return [];
  try {
    const values = JSON.parse(item.monitor_urls) as unknown;
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function isEnabled(value: Competitor['enabled']): boolean {
  return value === true || value === 1;
}

function statusLabel(status: Competitor['status']): string {
  if (status === 'monitoring') return '监控执行中';
  if (status === 'error') return '上次监控失败';
  return '等待监控';
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '尚未检查';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString();
}

export function CompetitorManager({ notify, onChanged }: Props) {
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ competitors: Competitor[] }>('/api/competitors');
      setCompetitors(result.competitors);
    } catch (error) {
      notify(error instanceof Error ? error.message : '竞品加载失败');
    }
  }, [notify]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const name = String(form.get('name') ?? '').trim();
    const website = String(form.get('website') ?? '').trim();
    const monitorUrls = splitValues(String(form.get('monitor_urls') ?? ''));
    const notes = String(form.get('notes') ?? '').trim();

    try {
      await api('/api/competitors', {
        method: 'POST',
        body: JSON.stringify({
          name,
          website: website || undefined,
          monitor_urls: monitorUrls,
          notes: notes || undefined,
          enabled: true,
        }),
      });
      formEl.reset();
      notify('竞品已加入竞品库');
      await refresh();
      onChanged();
    } catch (error) {
      notify(error instanceof Error ? error.message : '竞品创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(item: Competitor) {
    const enabled = isEnabled(item.enabled);
    const actionKey = 'toggle:' + item.id;
    setBusyAction(actionKey);
    try {
      await api('/api/competitors/' + item.id, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !enabled }),
      });
      notify(enabled ? '已暂停竞品监控' : '已恢复竞品监控');
      await refresh();
      onChanged();
    } catch (error) {
      notify(error instanceof Error ? error.message : '更新竞品状态失败');
    } finally {
      setBusyAction(null);
    }
  }

  async function trigger(item: Competitor, mode: 'monitor' | 'analyze') {
    const actionKey = mode + ':' + item.id;
    setBusyAction(actionKey);
    try {
      await api('/api/competitors/' + item.id + '/' + mode, { method: 'POST' });
      notify(mode === 'monitor' ? '监控任务已进入队列' : '全量分析已进入队列');
      await refresh();
      onChanged();
    } catch (error) {
      notify(error instanceof Error ? error.message : '任务提交失败');
    } finally {
      setBusyAction(null);
    }
  }

  async function remove(item: Competitor) {
    if (!window.confirm('确认删除竞品「' + item.name + '」？相关分析结果也可能无法继续关联。')) return;
    const actionKey = 'delete:' + item.id;
    setBusyAction(actionKey);
    try {
      await api('/api/competitors/' + item.id, { method: 'DELETE' });
      notify('竞品已删除');
      await refresh();
      onChanged();
    } catch (error) {
      notify(error instanceof Error ? error.message : '竞品删除失败');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <>
      <Card title='新增竞品' action={<span className='muted'>先登记，再启动监控或分析</span>}>
        <form className='competitor-form' onSubmit={submit}>
          <label>竞品名称<input name='name' required placeholder='例如：CloudNova' /></label>
          <label>官网 / 店铺 URL<input name='website' type='url' placeholder='https://example.com' /></label>
          <label className='wide'>监控 URL（每行一个，也支持逗号分隔）<textarea name='monitor_urls' rows={3} placeholder='https://example.com/pricing&#10;https://example.com/changelog' /></label>
          <label className='wide'>备注<textarea name='notes' rows={2} placeholder='记录重点产品线、市场或需要关注的变化' /></label>
          <div className='form-actions'>
            <span className='hint'>监控 URL 用于定期抓取和变化检测；未填写时默认使用官网地址。</span>
            <Button type='submit' disabled={busy}>{busy ? '加入中…' : '加入竞品库'}</Button>
          </div>
        </form>
      </Card>

      <Card title='竞品库' action={<span className='muted'>{competitors.length} 个</span>}>
        {!competitors.length ? <Empty>还没有竞品，先在上方登记一个。</Empty> : <div className='competitor-grid'>
          {competitors.map((item) => {
            const enabled = isEnabled(item.enabled);
            const urls = monitorUrlsOf(item);
            const toggleKey = 'toggle:' + item.id;
            const monitorKey = 'monitor:' + item.id;
            const analyzeKey = 'analyze:' + item.id;
            return <article className='competitor-card' key={item.id}>
              <div className='competitor-card__head'>
                <div>
                  <div className='competitor-title'>
                    <h3>{item.name}</h3>
                    <Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? '已启用' : '已暂停'}</Badge>
                  </div>
                  <p className='competitor-status'><span className={'status-dot status-dot--' + (item.status ?? 'idle')} />{statusLabel(item.status)}</p>
                </div>
                <Button tone='quiet' className='button--sm' disabled={busyAction === toggleKey} aria-pressed={enabled} onClick={() => void toggleEnabled(item)}>
                  {enabled ? '暂停监控' : '启用监控'}
                </Button>
              </div>
              {item.website ? <a className='competitor-website' href={item.website} target='_blank' rel='noreferrer'>{item.website}</a> : <span className='competitor-website competitor-website--empty'>未设置官网 / 店铺地址</span>}
              <div className='competitor-meta'>
                <span>{urls.length} 个监控入口</span>
                <span>最后检查：{formatTimestamp(item.last_checked_at)}</span>
              </div>
              {urls.length > 0 && <ul className='monitor-url-list'>{urls.map((url) => <li key={url}><a href={url} target='_blank' rel='noreferrer'>{url}</a></li>)}</ul>}
              {item.notes && <p className='competitor-notes'>{item.notes}</p>}
              {item.last_error && <p className='competitor-error'>{item.last_error}</p>}
              <div className='competitor-actions'>
                <Button tone='quiet' className='button--sm' disabled={busyAction === monitorKey || !enabled} onClick={() => void trigger(item, 'monitor')}>{busyAction === monitorKey ? '提交中…' : '立即监控'}</Button>
                <Button className='button--sm' disabled={busyAction === analyzeKey} onClick={() => void trigger(item, 'analyze')}>{busyAction === analyzeKey ? '提交中…' : '全量分析'}</Button>
                <Button tone='danger' className='button--sm' disabled={busyAction === 'delete:' + item.id} onClick={() => void remove(item)}>删除</Button>
              </div>
            </article>;
          })}
        </div>}
      </Card>
    </>
  );
}
