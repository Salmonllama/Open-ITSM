import type { MailStatus } from '@open-itsm/shared';
import { describe, expect, it } from 'vitest';
import { describeEmailStatus, describeMailStatus, formatBytes, mailCaption } from './mail';

const base: MailStatus = {
  state: 'connected',
  mailbox: 'support@example.com',
  secretExpiresOn: '2026-12-31',
  lastCheckedAt: null,
  lastError: null,
};
const now = new Date('2026-10-21T12:00:00Z');

describe('describeMailStatus', () => {
  it('says what works when connected', () => {
    expect(describeMailStatus(base, now)).toBe(
      'Email to support@example.com opens tickets, and replies are emailed.',
    );
  });

  it('counts the days left on the secret', () => {
    const soon = { ...base, state: 'secret_expiring' as const, secretExpiresOn: '2026-10-22' };
    expect(describeMailStatus(soon, now)).toMatch(/expires in 1 day\./);
    expect(describeMailStatus({ ...soon, secretExpiresOn: '2026-10-21' }, now)).toMatch(
      /expires today/,
    );
  });

  it('passes on why checking failed', () => {
    expect(
      describeMailStatus({ ...base, state: 'failing', lastError: 'Microsoft refused the app.' }),
    ).toBe('Email to support@example.com is not arriving: Microsoft refused the app.');
  });
});

describe('mailCaption', () => {
  it('names the mailbox or says there is none', () => {
    expect(mailCaption(base)).toBe('email to support@example.com');
    expect(mailCaption({ ...base, state: 'not_configured', mailbox: null })).toBe(
      'no mailbox connected',
    );
  });
});

describe('describeEmailStatus', () => {
  it('covers every state', () => {
    expect(describeEmailStatus('sent', '2026-10-21T00:00:00Z')).toBe('sent by email');
    expect(describeEmailStatus('queued', null)).toBe('sending by email…');
    expect(describeEmailStatus('failed', null)).toBe('not emailed: sending failed');
    expect(describeEmailStatus('not_sent', null)).toBe('not emailed: no mailbox connected');
  });
});

describe('formatBytes', () => {
  it('rounds to what people read', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(14_500)).toBe('14 KB');
    expect(formatBytes(3.2 * 1024 * 1024)).toBe('3.2 MB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
  });
});
