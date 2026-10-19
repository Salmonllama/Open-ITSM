import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

// OWASP's recommended argon2id baseline: 19 MiB memory, 2 passes, 1 lane.
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;

const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');

/** Returns a PHC string: $argon2id$v=19$m=…,t=…,p=…$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const nonce = randomBytes(16);
  const hash = await argon2Async('argon2id', { message: password, nonce, ...PARAMS });
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(nonce)}$${b64(hash)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const match = PHC.exec(stored);
  if (!match) return false;
  const [, m, t, p, salt, hash] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(hash, 'base64');
  const actual = await argon2Async('argon2id', {
    message: password,
    nonce: Buffer.from(salt, 'base64'),
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  });
  return timingSafeEqual(actual, expected);
}

/** A stored hash for an unusable password, verified against when an email is unknown. */
export const dummyHash = await hashPassword(randomBytes(32).toString('base64'));

/** A random password for recovery resets, readable enough to type. */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}
