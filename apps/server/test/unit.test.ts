import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { attachmentDisposition, cleanFileName } from '../src/attachments.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { SetupToken } from '../src/auth/setup-token.js';
import { decryptSecret, encryptSecret, SecretDecryptError } from '../src/crypto.js';
import {
  isAutomated,
  messageBody,
  outboundSubject,
  referencedMessageIds,
  ticketNumberInSubject,
} from '../src/mail/headers.js';
import { runRecovery } from '../src/recovery.js';
import { recoveryIo } from './helpers/io.js';
import { unusedDb } from './helpers/app.js';

describe('password hashing', () => {
  it('produces argon2id PHC strings that verify only the right password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong horse battery')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password here')).not.toBe(
      await hashPassword('same password here'),
    );
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('SetupToken', () => {
  it('matches only the issued value and stops matching once cleared', () => {
    const token = new SetupToken();
    expect(token.matches('')).toBe(false);
    const value = token.issue();
    expect(token.matches(value)).toBe(true);
    expect(token.matches(`${value}x`)).toBe(false);
    token.clear();
    expect(token.matches(value)).toBe(false);
  });
});

describe('recovery CLI arguments', () => {
  const deps = { db: unusedDb(), sessionSecret: 'x'.repeat(32) };

  it('prints usage for help and exits 0', async () => {
    const io = recoveryIo();
    expect(await runRecovery(['help'], deps, io)).toBe(0);
    expect(io.lines.join('\n')).toContain('reset-password <email>');
  });

  it('exits 2 for an unknown command or a missing email', async () => {
    expect(await runRecovery(['frobnicate'], deps, recoveryIo())).toBe(2);
    expect(await runRecovery(['reset-password'], deps, recoveryIo())).toBe(2);
  });
});

describe('stored secrets', () => {
  const key = randomBytes(32);

  it('round-trips and never contains the plaintext', () => {
    const stored = encryptSecret(key, 'my~secret', 'mail.client_secret');
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain('my~secret');
    expect(decryptSecret(key, stored, 'mail.client_secret')).toBe('my~secret');
  });

  it('refuses another key, another setting or a changed value', () => {
    const stored = encryptSecret(key, 'my~secret', 'mail.client_secret');
    expect(() => decryptSecret(randomBytes(32), stored, 'mail.client_secret')).toThrow(
      SecretDecryptError,
    );
    expect(() => decryptSecret(key, stored, 'other')).toThrow(SecretDecryptError);
    const parts = stored.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(key, parts.join('.'), 'mail.client_secret')).toThrow(
      SecretDecryptError,
    );
  });
});

describe('email headers', () => {
  it('finds the ticket reference in a subject', () => {
    expect(ticketNumberInSubject('RE: [#42] Printer jams')).toBe(42);
    expect(ticketNumberInSubject('AW: Fwd: [#7] x')).toBe(7);
    expect(ticketNumberInSubject('#42 without brackets')).toBeUndefined();
  });

  it('lists replied-to message IDs, In-Reply-To first then References newest first', () => {
    expect(
      referencedMessageIds([
        { name: 'in-reply-to', value: '<c@x>' },
        { name: 'References', value: '<a@x> <b@x>\r\n <c@x>' },
      ]),
    ).toEqual(['<c@x>', '<b@x>', '<a@x>']);
  });

  it('recognises mail no person wrote', () => {
    expect(isAutomated([{ name: 'Auto-Submitted', value: 'auto-replied' }], 'a@x.com')).toBe(true);
    expect(isAutomated([{ name: 'Auto-Submitted', value: 'no' }], 'a@x.com')).toBe(false);
    expect(isAutomated([{ name: 'Precedence', value: 'bulk' }], 'a@x.com')).toBe(true);
    expect(isAutomated([{ name: 'List-Id', value: '<l.x.com>' }], 'a@x.com')).toBe(true);
    expect(isAutomated([], 'no-reply@x.com')).toBe(true);
    expect(isAutomated([], 'dana@x.com')).toBe(false);
  });

  it('builds the outbound subject with one reference', () => {
    expect(outboundSubject(12, 'VPN drops', true)).toBe('RE: [#12] VPN drops');
    expect(outboundSubject(12, '[#12] VPN drops', false)).toBe('[#12] VPN drops');
  });

  it('shortens a long body with a note', () => {
    const body = messageBody('x'.repeat(200), 100);
    expect(body).toHaveLength(100);
    expect(body).toMatch(/Message shortened/);
  });
});

describe('attachment names', () => {
  it('keeps only a safe base name', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\Users\\a\\report?.pdf')).toBe('report_.pdf');
    expect(cleanFileName('..')).toBe('attachment');
    expect(cleanFileName(null)).toBe('attachment');
  });

  it('downloads under the original name in any browser', () => {
    expect(attachmentDisposition('Résumé "final".pdf')).toBe(
      `attachment; filename="R_sum_ _final_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf`,
    );
  });
});
