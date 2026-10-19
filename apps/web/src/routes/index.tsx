import { queryOptions, useQuery } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import type { ComponentStatus } from '@open-itsm/shared';
import { PageHeader } from '@/components/page-header';
import { ErrorMessage } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, Td, Th } from '@/components/ui/table';
import { fetchHealth } from '@/lib/api';
import { authedRoute } from './authed';

const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: () => fetchHealth(),
  refetchInterval: 15_000,
});

export const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  component: SystemStatus,
});

const componentNames: Record<string, string> = {
  app: 'App',
  database: 'Database',
  queue: 'Job queue',
};

function SystemStatus() {
  const { data, error, isPending } = useQuery(healthQuery);

  return (
    <>
      <PageHeader
        title="System status"
        caption={data ? `Version ${data.version}. Checks again every 15 seconds.` : undefined}
      />
      {isPending && <p className="m-0 text-ink-muted">Checking…</p>}
      {error && (
        <ErrorMessage
          error={`The status check failed (${error.message}). Check that the app container is running.`}
        />
      )}
      {data && (
        <Table>
          <thead>
            <tr>
              <Th>Component</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.checks).map(([name, status]) => (
              <tr key={name}>
                <Td>{componentNames[name] ?? name}</Td>
                <Td>
                  <HealthBadge status={status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

function HealthBadge({ status }: { status: ComponentStatus }) {
  return status === 'ok' ? (
    <StatusBadge tone="success">OK</StatusBadge>
  ) : (
    <StatusBadge tone="danger">Error</StatusBadge>
  );
}
