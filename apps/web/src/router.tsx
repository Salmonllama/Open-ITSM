import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { adminServiceAccountsRoute } from './routes/admin-service-accounts';
import { adminUsersRoute } from './routes/admin-users';
import { assetImportRoute } from './routes/asset-import';
import { assetLabelsRoute } from './routes/asset-labels';
import { assetNewRoute } from './routes/asset-new';
import { assetTypeRoute, assetTypesRoute } from './routes/asset-types';
import { assetEditRoute, assetViewRoute } from './routes/asset-view';
import { assetsRoute } from './routes/assets';
import { authedRoute } from './routes/authed';
import { consumablesRoute, consumableViewRoute } from './routes/consumables';
import { indexRoute } from './routes/index';
import { loginRoute } from './routes/login';
import { rootRoute } from './routes/root';
import { scanRoute, tagRoute } from './routes/scan';
import { setupRoute } from './routes/setup';
import { ticketViewRoute } from './routes/ticket-view';
import { ticketsRoute } from './routes/tickets';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  authedRoute.addChildren([
    indexRoute,
    ticketsRoute,
    ticketViewRoute,
    assetsRoute,
    assetNewRoute,
    assetImportRoute,
    assetLabelsRoute,
    assetViewRoute,
    assetEditRoute,
    scanRoute,
    tagRoute,
    assetTypesRoute,
    assetTypeRoute,
    consumablesRoute,
    consumableViewRoute,
    adminUsersRoute,
    adminServiceAccountsRoute,
  ]),
]);

export const router = createRouter({ routeTree, context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
