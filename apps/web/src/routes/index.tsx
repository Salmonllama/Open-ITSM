import { queryOptions, useQuery } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import type { ComponentStatus } from '@open-itsm/shared';
import { fetchHealth } from '@/lib/api';
import { cn } from '@/lib/utils';
import { rootRoute } from './root';

const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: () => fetchHealth(),
  refetchInterval: 15_000,
});

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: SystemStatus,
});

function SystemStatus() {
  const { data, error, isPending } = useQuery(healthQuery);

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">System status</h1>
      {isPending && <p className="text-muted-foreground">Checking…</p>}
      {error && <p className="text-destructive">Could not reach the server: {error.message}</p>}
      {data && (
        <>
          <ul className="divide-y rounded-lg border bg-card">
            {Object.entries(data.checks).map(([name, status]) => (
              <li key={name} className="flex items-center justify-between px-4 py-3">
                <span className="capitalize">{name}</span>
                <StatusBadge status={status} />
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">Version {data.version}</p>
        </>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: ComponentStatus }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-sm font-medium',
        status === 'ok' ? 'text-success' : 'text-destructive',
      )}
    >
      {status === 'ok' ? 'OK' : 'Error'}
    </span>
  );
}
