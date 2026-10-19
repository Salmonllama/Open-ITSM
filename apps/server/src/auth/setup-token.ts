import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The one-time token that authorizes the first-run wizard. It lives only in memory and is
 * printed to the log at startup while no users exist, so claiming a fresh install requires
 * access to the host's container logs.
 */
export class SetupToken {
  private value: string | undefined;

  constructor(initial?: string) {
    this.value = initial;
  }

  issue(): string {
    this.value = randomBytes(18).toString('base64url');
    return this.value;
  }

  matches(candidate: string): boolean {
    if (!this.value) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.value);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  clear(): void {
    this.value = undefined;
  }
}
