/** Pure helpers for reading inbound email: ticket references, threading and loop protection. */

export type Header = { name: string; value: string };

function header(headers: Header[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** The ticket number in a subject such as `RE: [#42] Printer jams`, if any. */
export function ticketNumberInSubject(subject: string): number | undefined {
  const match = /\[#(\d{1,9})\]/.exec(subject);
  return match ? Number(match[1]) : undefined;
}

/** Message IDs (with their angle brackets) from In-Reply-To and References, newest first. */
export function referencedMessageIds(headers: Header[]): string[] {
  const ids = [
    ...(header(headers, 'In-Reply-To') ?? '').matchAll(/<[^<>\s]+>/g),
    ...[...(header(headers, 'References') ?? '').matchAll(/<[^<>\s]+>/g)].reverse(),
  ].map((m) => m[0]);
  return [...new Set(ids)];
}

/**
 * Mail no person wrote: auto-replies, out-of-office notices, bounces and list mail. Answering it
 * could start a loop between two mailboxes, so it never opens or updates a ticket.
 */
export function isAutomated(headers: Header[], fromAddress: string): boolean {
  const autoSubmitted = header(headers, 'Auto-Submitted')?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  const precedence = header(headers, 'Precedence')?.trim().toLowerCase();
  if (precedence && ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return true;
  if (header(headers, 'X-Autoreply') || header(headers, 'X-Autorespond')) return true;
  if (header(headers, 'List-Id') || header(headers, 'List-Unsubscribe')) return true;
  const contentType = header(headers, 'Content-Type')?.toLowerCase() ?? '';
  if (contentType.includes('multipart/report')) return true;
  return /^(mailer-daemon|postmaster|no-?reply)@/i.test(fromAddress);
}

/** The subject a new ticket takes: trimmed, never blank, at most `max` characters. */
export function ticketSubject(subject: string | null | undefined, max: number): string {
  const clean = (subject ?? '').replace(/\s+/g, ' ').trim();
  return (clean || '(no subject)').slice(0, max);
}

/** A message body, trimmed and kept under `max` characters with a note when cut. */
export function messageBody(text: string | null | undefined, max: number): string {
  const clean = (text ?? '').replace(/\r\n/g, '\n').trim();
  if (clean.length <= max) return clean;
  const note = '\n\n[Message shortened: the rest is in the original email.]';
  return clean.slice(0, max - note.length) + note;
}

/** The outbound subject: the ticket reference first, so replies find their way back. */
export function outboundSubject(number: number, subject: string, isReply: boolean): string {
  const withoutRef = subject.replace(/\s*\[#\d{1,9}\]\s*/g, ' ').trim();
  return `${isReply ? 'RE: ' : ''}[#${number}] ${withoutRef}`;
}
