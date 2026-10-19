import { adminUserSchema, type SessionResponse } from '@open-itsm/shared';
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

/** Stores a fresh session (after setup or login) so routes see it without refetching. */
export function storeSession(queryClient: QueryClient, session: SessionResponse | null) {
  setCsrfToken(session?.csrfToken);
  queryClient.setQueryData(sessionQuery.queryKey, session);
}
