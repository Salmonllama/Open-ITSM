import { daysUntil, type EmailStatus, type MailState, type MailStatus } from '@open-itsm/shared';
import type { Tone } from '@/components/ui/status-shape';

export const mailStateLabels: Record<MailState, string> = {
  not_configured: 'Not connected',
  off: 'Switched off',
  connected: 'Connected',
  failing: 'Not working',
  secret_expiring: 'Secret expires soon',
  secret_expired: 'Secret expired',
};

export const mailStateTones: Record<MailState, Tone> = {
  not_configured: 'neutral',
  off: 'neutral',
  connected: 'success',
  failing: 'danger',
  secret_expiring: 'warning',
  secret_expired: 'danger',
};

/** Whether staff should be told about the mailbox above the ticket list. */
export function mailNeedsAttention(status: MailStatus): boolean {
  return ['failing', 'secret_expiring', 'secret_expired'].includes(status.state);
}

function days(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

/** One sentence on the mailbox: what is happening, then what to do. */
export function describeMailStatus(status: MailStatus, now = new Date()): string {
  const left = status.secretExpiresOn ? daysUntil(status.secretExpiresOn, now) : 0;
  switch (status.state) {
    case 'not_configured':
      return 'No mailbox is connected, so email does not open tickets and replies are not emailed.';
    case 'off':
      return `Checking ${status.mailbox} is switched off. Email waits in the mailbox and replies are saved but not emailed.`;
    case 'connected':
      return `Email to ${status.mailbox} opens tickets, and replies are emailed.`;
    case 'failing':
      return `Email to ${status.mailbox} is not arriving: ${status.lastError ?? 'the last check failed.'}`;
    case 'secret_expiring':
      return left === 0
        ? `The client secret for ${status.mailbox} expires today. Create a new one in Entra ID and enter it under Email.`
        : `The client secret for ${status.mailbox} expires in ${days(left)}. Create a new one in Entra ID and enter it under Email before then.`;
    case 'secret_expired':
      return `The client secret for ${status.mailbox} has expired, so email has stopped. Create a new one in Entra ID and enter it under Email.`;
  }
}

/** The short mailbox note in the ticket list caption. */
export function mailCaption(status: MailStatus): string {
  if (status.state === 'not_configured') return 'no mailbox connected';
  if (status.state === 'off') return 'mailbox switched off';
  return `email to ${status.mailbox}`;
}

/** How a reply went out, after "reply" on the ticket page. */
export function describeEmailStatus(status: EmailStatus | null, emailedAt: string | null): string {
  switch (status) {
    case 'sent':
      return 'sent by email';
    case 'queued':
      return 'sending by email…';
    case 'failed':
      return 'not emailed: sending failed';
    default:
      return emailedAt ? 'sent by email' : 'not emailed: no mailbox connected';
  }
}

/** File sizes as people read them: 512 bytes, 14 KB, 3.2 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
