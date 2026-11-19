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
  mailSettingsSchema,
  mailStatusSchema,
  notificationSettingsSchema,
  openRepairListSchema,
  requesterListSchema,
  serviceAccountSchema,
  ticketAssigneeListSchema,
  ticketDetailSchema,
  ticketListResponseSchema,
  type AssetListQuery,
  type ConsumableListQuery,
  type SessionResponse,
  type TicketListQuery,
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

export function ticketsQuery(query: TicketListQuery) {
  return queryOptions({
    queryKey: ['tickets', 'list', query],
    queryFn: () =>
      apiRequest('GET', `/api/tickets?${searchParams(query)}`, {
        schema: ticketListResponseSchema,
      }),
    placeholderData: (previous) => previous,
  });
}

/** Feeds the sidebar's open count: the queue counts of an empty search. */
export const ticketCountsQuery = queryOptions({
  queryKey: ['tickets', 'list', 'counts'],
  queryFn: () => apiRequest('GET', '/api/tickets?pageSize=1', { schema: ticketListResponseSchema }),
  select: (data) => data.counts,
  staleTime: 60_000,
});

export function ticketQuery(id: string) {
  return queryOptions({
    queryKey: ['tickets', id],
    queryFn: () => apiRequest('GET', `/api/tickets/${id}`, { schema: ticketDetailSchema }),
  });
}

export const ticketAssigneesQuery = queryOptions({
  queryKey: ['tickets', 'assignees'],
  queryFn: () => apiRequest('GET', '/api/tickets/assignees', { schema: ticketAssigneeListSchema }),
  staleTime: 60_000,
});

export function requestersQuery(q: string) {
  return queryOptions({
    queryKey: ['requesters', q],
    queryFn: () =>
      apiRequest('GET', `/api/requesters?${searchParams({ q })}`, { schema: requesterListSchema }),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
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

/** The mailbox state for staff; refreshed each minute, as often as the mailbox is checked. */
export const mailStatusQuery = queryOptions({
  queryKey: ['mail', 'status'],
  queryFn: () => apiRequest('GET', '/api/mail/status', { schema: mailStatusSchema }),
  refetchInterval: 60_000,
});

export const mailSettingsQuery = queryOptions({
  queryKey: ['mail', 'settings'],
  queryFn: () => apiRequest('GET', '/api/settings/mail', { schema: mailSettingsSchema }),
});

export const notificationSettingsQuery = queryOptions({
  queryKey: ['notifications'],
  queryFn: () =>
    apiRequest('GET', '/api/settings/notifications', { schema: notificationSettingsSchema }),
});
