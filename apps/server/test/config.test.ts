import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const validEnv = {
  DATABASE_URL: 'postgres://itsm:secret@db:5432/itsm',
  APP_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  SESSION_SECRET: 'x'.repeat(48),
};

describe('loadConfig', () => {
  it('applies defaults to a minimal valid environment', () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(3030);
    expect(config.appSecretKey).toHaveLength(32);
    expect(config.siteUrl).toBeNull();
  });

  it('builds the site address for message links from APP_HOSTNAME', () => {
    expect(loadConfig({ ...validEnv, APP_HOSTNAME: 'itsm.example.com' }).siteUrl).toBe(
      'https://itsm.example.com',
    );
    expect(loadConfig({ ...validEnv, APP_HOSTNAME: 'localhost' }).siteUrl).toBe(
      'https://localhost',
    );
    expect(loadConfig({ ...validEnv, APP_HOSTNAME: 'itsm.example.com:8443' }).siteUrl).toBe(
      'https://itsm.example.com:8443',
    );
    expect(loadConfig({ ...validEnv, APP_HOSTNAME: '[::1]' }).siteUrl).toBe('https://[::1]');
    expect(loadConfig({ ...validEnv, APP_HOSTNAME: '' }).siteUrl).toBeNull();
    for (const bad of ['https://x/y', ':80', '[bad', '...', '---', '-a.example.com', 'a..b.com']) {
      expect(() => loadConfig({ ...validEnv, APP_HOSTNAME: bad })).toThrow(ConfigError);
    }
  });

  it('reports every invalid variable without echoing secret values', () => {
    const badKey = 'not-a-real-key';
    try {
      loadConfig({ APP_SECRET_KEY: badKey, SESSION_SECRET: 'short' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('APP_SECRET_KEY');
      expect(message).toContain('SESSION_SECRET');
      expect(message).not.toContain(badKey);
    }
  });
});
