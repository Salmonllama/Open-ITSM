import { daysUntil, type EntraSettings, type EntraState } from '@open-itsm/shared';
import type { Tone } from '@/components/ui/status-shape';

export const entraStateLabels: Record<EntraState, string> = {
  not_configured: 'Not configured',
  off: 'Switched off',
  connected: 'On',
  failing: 'Needs attention',
  secret_expiring: 'Secret expires soon',
  secret_expired: 'Secret expired',
};

export const entraStateTones: Record<EntraState, Tone> = {
  not_configured: 'neutral',
  off: 'neutral',
  connected: 'success',
  failing: 'danger',
  secret_expiring: 'warning',
  secret_expired: 'danger',
};

function days(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

export function describeEntraState(settings: EntraSettings, now = new Date()): string {
  const left = settings.secretExpiresOn ? daysUntil(settings.secretExpiresOn, now) : 0;
  switch (settings.state) {
    case 'not_configured':
      return 'Microsoft Entra ID sign-in is not set up. Everyone signs in with a local account.';
    case 'off':
      return 'Microsoft Entra ID sign-in is switched off. Your settings are saved, and local accounts still work.';
    case 'connected':
      return 'Members of the configured technician group can sign in with Microsoft. Local accounts always remain available.';
    case 'failing':
      return `Microsoft sign-in failed on the last attempt: ${settings.lastError ?? 'check the settings below.'} Local accounts still work.`;
    case 'secret_expiring':
      return left === 0
        ? 'The Entra ID client secret expires today. Create a new secret in Entra ID and save it here.'
        : `The Entra ID client secret expires in ${days(left)}. Create a new secret in Entra ID and save it here before then.`;
    case 'secret_expired':
      return 'The Entra ID client secret has expired, so Microsoft sign-in cannot work. Create a new secret in Entra ID and save it here. Local accounts still work.';
  }
}
