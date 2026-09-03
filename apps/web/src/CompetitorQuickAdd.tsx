import { FormEvent, useState } from 'react';
import { Button } from '@ui/index.js';
import { api } from './api.js';

interface Props {
  notify: (message: string) => void;
  onCreated: () => void | Promise<void>;
}

function splitValues(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function CompetitorQuickAdd({ notify, onCreated }: Props) {
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const website = String(form.get('website') ?? '').trim();
    const monitorUrls = splitValues(String(form.get('monitor_urls') ?? ''));

    try {
      await api('/api/competitors', {
        method: 'POST',
        body: JSON.stringify({
          name: String(form.get('name') ?? '').trim(),
          website: website || undefined,
          monitor_urls: monitorUrls,
          enabled: true,
        }),
      });
      formEl.reset();
      notify('竞品已加入竞品库，可继续创建项目或发起分析');
      await onCreated();
    } catch (error) {
      notify(error instanceof Error ? error.message : '竞品创建失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className='competitor-quick-form' onSubmit={submit}>
      <label>竞品名称<input name='name' required placeholder='例如：CloudNova' /></label>
      <label>官网 / 店铺 URL<input name='website' type='url' placeholder='https://example.com' /></label>
      <label className='wide'>监控 URL（每行一个）<textarea name='monitor_urls' rows={2} placeholder={'https://example.com/pricing\nhttps://example.com/changelog'} /></label>
      <Button type='submit' disabled={busy}>{busy ? '加入中…' : '加入竞品库'}</Button>
    </form>
  );
}
