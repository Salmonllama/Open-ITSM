import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { adminUsersRoute } from './routes/admin-users';
import { authedRoute } from './routes/authed';
import { indexRoute } from './routes/index';
import { loginRoute } from './routes/login';
import { rootRoute } from './routes/root';
import { setupRoute } from './routes/setup';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  authedRoute.addChildren([indexRoute, adminUsersRoute]),
]);

export const router = createRouter({ routeTree, context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
