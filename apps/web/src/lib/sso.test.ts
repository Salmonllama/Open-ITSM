import type { EntraSettings } from '@open-itsm/shared';
import { describe, expect, it } from 'vitest';
import { describeEntraState } from './sso';

const base: EntraSettings = {
  configured: true,
  tenantId: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222',
  technicianGroupId: '33333333-3333-4333-8333-333333333333',
  secretExpiresOn: '2026-12-01',
  secretSet: true,
  enabled: true,
  state: 'connected',
  redirectUri: 'https://itsm.example.com/api/auth/entra/callback',
  lastError: null,
  lastErrorAt: null,
};

describe('describeEntraState', () => {
  it('reassures that local accounts still work when SSO fails or expires', () => {
    expect(describeEntraState({ ...base, state: 'failing', lastError: 'Bad secret.' })).toContain(
      'Local accounts still work',
    );
    expect(describeEntraState({ ...base, state: 'secret_expired' })).toContain(
      'Local accounts still work',
    );
  });

  it('names the days remaining when the secret is expiring soon', () => {
    const text = describeEntraState(
      { ...base, state: 'secret_expiring', secretExpiresOn: '2026-11-25' },
      new Date('2026-11-20T12:00:00Z'),
    );
    expect(text).toContain('5 days');
  });
});
