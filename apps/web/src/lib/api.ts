import { healthResponseSchema, type HealthResponse } from '@open-itsm/shared';

/**
 * Fetches /healthz. A 503 still carries a valid body describing which
 * component is down, so it is parsed rather than treated as a failure.
 */
export async function fetchHealth(fetchImpl: typeof fetch = fetch): Promise<HealthResponse> {
  const res = await fetchImpl('/healthz', { headers: { accept: 'application/json' } });
  if (!res.ok && res.status !== 503) {
    throw new Error(`Health check failed with HTTP ${res.status}`);
  }
  return healthResponseSchema.parse(await res.json());
}
