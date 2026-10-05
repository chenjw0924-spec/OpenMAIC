import { createLogger } from '@/lib/logger';

import { smtpConfig } from './config';
import { sendSmtpMail } from './smtp';

const log = createLogger('AuthEmail');

/**
 * The magic-link sign-in email. Kept deliberately plain: one link, its
 * expiry, and a line for people who did not ask for it. Both text and HTML
 * bodies, since some domestic mailboxes still filter HTML-only mail harder.
 *
 * Without SMTP configured the link is logged instead of sent: that keeps
 * local development usable, and /api/auth/session reports the provider as
 * off so the hosted login page never offers it there.
 */
export async function sendMagicLinkEmail(to: string, url: string): Promise<void> {
  const config = smtpConfig();
  if (!config) {
    log.info(`SMTP not configured; magic link for ${to}: ${url}`);
    return;
  }
  const text = [
    '你好，',
    '',
    '点击下面的链接登录课栈（15 分钟内有效，仅可使用一次）：',
    '',
    url,
    '',
    '如果这不是你的操作，请忽略本邮件。',
    '',
    '— 课栈 KeStack',
  ].join('\n');
  const escapedUrl = url.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,'Segoe UI',sans-serif;">
  <div style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e2e8f0;">
    <h1 style="margin:0 0 16px;font-size:18px;color:#0f172a;">登录课栈 KeStack</h1>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#475569;">
      点击下面的按钮完成登录。链接 15 分钟内有效，仅可使用一次。
    </p>
    <a href="${escapedUrl}" style="display:inline-block;background:#7c3aed;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;">登录课栈</a>
    <p style="margin:20px 0 0;font-size:12px;line-height:1.7;color:#94a3b8;word-break:break-all;">
      按钮无法点击？复制此链接到浏览器打开：<br />${escapedUrl}
    </p>
    <p style="margin:20px 0 0;font-size:12px;color:#94a3b8;">如果这不是你的操作，请忽略本邮件。</p>
  </div>
</body>
</html>`;
  await sendSmtpMail(config, { to, subject: '登录课栈', text, html });
}
