import {
  adminUserSchema,
  assetListResponseSchema,
  assetSchema,
  assetTypeSchema,
  serviceAccountSchema,
  type AssetListQuery,
  type SessionResponse,
} from '@open-itsm/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiRequest, fetchSession, fetchSetupStatus, setCsrfToken } from './api';

export const setupStatusQuery = queryOptions({
  queryKey: ['setup-status'],
  queryFn: fetchSetupStatus,
  staleTime: Infinity,
});

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: () => fetchSession(),
  staleTime: 60_000,
});

export const usersQuery = queryOptions({
  queryKey: ['users'],
  queryFn: () => apiRequest('GET', '/api/users', { schema: z.array(adminUserSchema) }),
});

export const assetTypesQuery = queryOptions({
  queryKey: ['asset-types'],
  queryFn: () => apiRequest('GET', '/api/asset-types', { schema: z.array(assetTypeSchema) }),
});

export function assetTypeQuery(id: string) {
  return queryOptions({
    queryKey: ['asset-types', id],
    queryFn: () => apiRequest('GET', `/api/asset-types/${id}`, { schema: assetTypeSchema }),
  });
}

export function assetsQuery(query: AssetListQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return queryOptions({
    queryKey: ['assets', 'list', query],
    queryFn: () => apiRequest('GET', `/api/assets?${params}`, { schema: assetListResponseSchema }),
    placeholderData: (previous) => previous,
  });
}

export function assetQuery(id: string) {
  return queryOptions({
    queryKey: ['assets', id],
    queryFn: () => apiRequest('GET', `/api/assets/${id}`, { schema: assetSchema }),
  });
}

export const serviceAccountsQuery = queryOptions({
  queryKey: ['service-accounts'],
  queryFn: () =>
    apiRequest('GET', '/api/service-accounts', { schema: z.array(serviceAccountSchema) }),
});

/** Stores a fresh session (after setup or login) so routes see it without refetching. */
export function storeSession(queryClient: QueryClient, session: SessionResponse | null) {
  setCsrfToken(session?.csrfToken);
  queryClient.setQueryData(sessionQuery.queryKey, session);
}
