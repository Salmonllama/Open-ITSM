import {
  adminUserSchema,
  assetHistorySchema,
  assetListResponseSchema,
  assetSchema,
  assignmentSuggestionsSchema,
  assetTypeSchema,
  consumableDetailSchema,
  consumableListResponseSchema,
  lowStockSummarySchema,
  openRepairListSchema,
  serviceAccountSchema,
  type AssetListQuery,
  type ConsumableListQuery,
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
  return queryOptions({
    queryKey: ['assets', 'list', query],
    queryFn: () =>
      apiRequest('GET', `/api/assets?${searchParams(query)}`, { schema: assetListResponseSchema }),
    placeholderData: (previous) => previous,
  });
}

export function assetQuery(id: string) {
  return queryOptions({
    queryKey: ['assets', id],
    queryFn: () => apiRequest('GET', `/api/assets/${id}`, { schema: assetSchema }),
  });
}

export function assetHistoryQuery(id: string) {
  return queryOptions({
    queryKey: ['assets', id, 'history'],
    queryFn: () => apiRequest('GET', `/api/assets/${id}/history`, { schema: assetHistorySchema }),
  });
}

export const assignmentSuggestionsQuery = queryOptions({
  queryKey: ['assignment-suggestions'],
  queryFn: () =>
    apiRequest('GET', '/api/assets/assignment-suggestions', {
      schema: assignmentSuggestionsSchema,
    }),
  staleTime: 60_000,
});

function searchParams(query: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params;
}

export function consumablesQuery(query: ConsumableListQuery) {
  return queryOptions({
    queryKey: ['consumables', 'list', query],
    queryFn: () =>
      apiRequest('GET', `/api/consumables?${searchParams(query)}`, {
        schema: consumableListResponseSchema,
      }),
    placeholderData: (previous) => previous,
  });
}

export function consumableQuery(id: string) {
  return queryOptions({
    queryKey: ['consumables', id],
    queryFn: () => apiRequest('GET', `/api/consumables/${id}`, { schema: consumableDetailSchema }),
  });
}

/** Feeds the sidebar count and the notice on the asset list. */
export const lowStockQuery = queryOptions({
  queryKey: ['consumables', 'low-stock'],
  queryFn: () => apiRequest('GET', '/api/consumables/low-stock', { schema: lowStockSummarySchema }),
  staleTime: 60_000,
});

export const openRepairsQuery = queryOptions({
  queryKey: ['repairs', 'open'],
  queryFn: () => apiRequest('GET', '/api/repairs/open', { schema: openRepairListSchema }),
});

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
