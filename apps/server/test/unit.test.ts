import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { SetupToken } from '../src/auth/setup-token.js';
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
