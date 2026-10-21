import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * Encrypts a stored credential with AES-256-GCM under APP_SECRET_KEY. The result is
 * `v1.<iv>.<tag>.<ciphertext>` in base64url, so the key or format can change later.
 * `context` (such as the setting's name) is bound as associated data, so a value cannot be
 * moved to another setting.
 */
export function encryptSecret(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export class SecretDecryptError extends Error {
  constructor() {
    super('A stored secret could not be decrypted. Was APP_SECRET_KEY changed?');
    this.name = 'SecretDecryptError';
  }
}

export function decryptSecret(key: Buffer, stored: string, context: string): string {
  const [version, iv, tag, data] = stored.split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) throw new SecretDecryptError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretDecryptError();
  }
}
