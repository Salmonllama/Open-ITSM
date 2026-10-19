import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { indexRoute } from './routes/index';
import { rootRoute } from './routes/root';

export const queryClient = new QueryClient();

const routeTree = rootRoute.addChildren([indexRoute]);

export const router = createRouter({ routeTree, context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
