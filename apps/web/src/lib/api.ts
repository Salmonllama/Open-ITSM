import {
  healthResponseSchema,
  sessionResponseSchema,
  setupStatusSchema,
  type HealthResponse,
  type SessionResponse,
  type SetupStatus,
} from '@open-itsm/shared';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken: string | undefined;

/** Remembers the CSRF token from the latest session response for write requests. */
export function setCsrfToken(token: string | undefined) {
  csrfToken = token;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export async function apiRequest<S extends z.ZodType>(
  method: Method,
  url: string,
  options: { body?: unknown; schema?: S; fetchImpl?: typeof fetch } = {},
): Promise<z.infer<S>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await (options.fetchImpl ?? fetch)(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(
      res.status,
      body.error ?? 'http_error',
      body.message ?? `HTTP ${res.status}`,
    );
  }
  if (res.status === 204 || !options.schema) return undefined as z.infer<S>;
  return options.schema.parse(await res.json());
}

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

export function fetchSetupStatus(): Promise<SetupStatus> {
  return apiRequest('GET', '/api/setup/status', { schema: setupStatusSchema });
}

/** The current session, or null when signed out. */
export async function fetchSession(fetchImpl?: typeof fetch): Promise<SessionResponse | null> {
  try {
    const session = await apiRequest('GET', '/api/auth/session', {
      schema: sessionResponseSchema,
      fetchImpl,
    });
    setCsrfToken(session.csrfToken);
    return session;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setCsrfToken(undefined);
      return null;
    }
    throw err;
  }
}
