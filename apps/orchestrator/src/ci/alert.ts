import { createTransport } from 'nodemailer';
import { config } from '@platform/config.js';
import { logger } from '@platform/logger.js';
import { getCompetitor } from '@api/db/queries/competitors.js';
import { pendingHighCriticalChanges, insertAlert, updateAlertStatus } from '@api/db/queries/ci.js';
import { insertEvent } from '@api/db/queries/events.js';
import type { CompetitorChangeRow } from '@contracts/types.js';

/**
 * 告警 Agent（服务端实现，无需再跑一次 LLM）：
 * monitor 阶段已由 LLM 给变化打 severity 标，这里只需过滤 high/critical 并推送。
 * 幂等保证：alerts.change_id 唯一，每条变化只告警一次。
 * v1 渠道：邮件 SMTP（nodemailer）。未配置 SMTP / demo 模式 → 插 status='demo' 记录不真发。
 */

function buildHtml(change: CompetitorChangeRow): string {
  const severityColor: Record<string, string> = { high: '#d97706', critical: '#dc2626' };
  const color = severityColor[change.severity] ?? '#111';
  const rows = [
    ['变化类型', change.change_type],
    ['标题', change.title],
    ['摘要', change.summary ?? ''],
    ['URL', change.url ?? ''],
    ['检测时间', change.created_at],
  ]
    .map(([k, v]) => `<tr><td style="padding:6px 12px;font-weight:600;white-space:nowrap">${k}</td><td style="padding:6px 12px">${escapeHtml(v ?? '')}</td></tr>`)
    .join('');
  return `<div style="font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif;max-width:640px;margin:auto">
  <h2 style="color:${color}">[${change.severity.toUpperCase()}] 竞品变化：${escapeHtml(change.title)}</h2>
  <table style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb">${rows}</table>
  ${change.url ? `<p><a href="${escapeHtml(change.url)}" style="color:#2563eb">查看原文</a></p>` : ''}
  <hr style="border:none;border-top:1px solid #eee">
  <p style="color:#6b7280;font-size:12px">竞品情报系统自动发送 · ${escapeHtml(config.ourProduct.name)}</p>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** 推送一条变化（真发或 demo 占位），返回 alert 记录 */
async function deliver(change: CompetitorChangeRow, competitorName: string): Promise<void> {
  const html = buildHtml(change);
  const recipient = config.alertEmailTo.join(', ');
  const alert = await insertAlert({
    competitor_id: change.competitor_id,
    change_id: change.id,
    channel: 'email',
    recipient: recipient || undefined,
    payload: html,
  });
  // demo / 未配置 SMTP：记录 status='demo'，不真发（不依赖收件人）
  const smtpReady = config.smtp.host && recipient;
  if (!smtpReady || config.ciDemoMode) {
    const reason = config.ciDemoMode
      ? 'demo mode'
      : !config.smtp.host
        ? 'SMTP not configured'
        : 'no recipients configured';
    await updateAlertStatus(alert.id, 'demo', reason);
    logger.info('alert', `[demo] alert for ${competitorName}: ${change.severity} ${change.title} (${reason})`);
    return;
  }

  try {
    const transporter = createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined,
    });
    await transporter.sendMail({
      from: config.smtp.from || config.smtp.user,
      to: recipient,
      subject: `[竞品情报] ${change.severity.toUpperCase()} ${change.title}`,
      html,
    });
    await updateAlertStatus(alert.id, 'sent');
    await insertEvent({
      task_id: change.task_id ?? null,
      type: 'ci_alert_sent',
      payload: { competitor_id: change.competitor_id, change_id: change.id, severity: change.severity },
    });
    logger.info('alert', `sent ${change.severity} alert for ${competitorName}: ${change.title}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateAlertStatus(alert.id, 'failed', msg);
    logger.error('alert', `send failed: ${msg}`);
  }
}

/** 对该竞品所有未告警的 high/critical 变化逐个推送（幂等） */
export async function maybeSendAlerts(competitorId: string): Promise<{ queued: number }> {
  const competitor = await getCompetitor(competitorId);
  if (!competitor) return { queued: 0 };
  const pending = await pendingHighCriticalChanges(competitorId);
  if (pending.length === 0) return { queued: 0 };
  for (const change of pending) {
    await deliver(change, competitor.name);
  }
  return { queued: pending.length };
}
