import { backupFileSchema, type BackupReason } from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, redirect } from '@tanstack/react-router';
import { Download, HardDriveDownload } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, Td, Th } from '@/components/ui/table';
import { apiRequest } from '@/lib/api';
import { formatBytes } from '@/lib/mail';
import { backupStatusQuery } from '@/lib/queries';
import { formatDateTime } from '@/lib/tickets';
import { authedRoute } from './authed';

export const adminBackupsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin/backups',
  beforeLoad: ({ context }) => {
    if (context.session.user.role !== 'admin') throw redirect({ to: '/' });
  },
  component: BackupsPage,
});

const reasonLabels: Record<BackupReason, string> = {
  scheduled: 'Nightly',
  manual: 'Manual',
  pre_migration: 'Before upgrade',
};

function BackupsPage() {
  const status = useQuery(backupStatusQuery);
  const queryClient = useQueryClient();

  const backupNow = useMutation({
    mutationFn: () => apiRequest('POST', '/api/backups', { schema: backupFileSchema }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: backupStatusQuery.queryKey });
    },
  });

  const data = status.data;

  return (
    <>
      <PageHeader
        title="Backups"
        caption="Nightly backups save the database and ticket attachments to the backups volume."
        actions={
          <Button
            variant="primary"
            disabled={backupNow.isPending}
            onClick={() => backupNow.mutate()}
          >
            <HardDriveDownload aria-hidden="true" strokeWidth={1.75} />
            {backupNow.isPending ? 'Creating backup…' : 'Backup now'}
          </Button>
        }
      />

      <ErrorMessage error={status.error ?? backupNow.error} />
      {backupNow.data && (
        <p role="status" className="m-0 type-label text-success">
          Backup created: <span className="type-id">{backupNow.data.name}</span>
        </p>
      )}

      {status.isPending && <p className="m-0 text-ink-muted">Loading backups…</p>}
      {data && (
        <div className="flex max-w-4xl flex-col gap-6">
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="m-0 type-heading">Schedule and retention</h2>
              <StatusBadge tone={data.lastError ? 'danger' : 'success'}>
                {data.lastError ? 'Last backup failed' : 'Active'}
              </StatusBadge>
            </div>
            <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-3">
              <div>
                <dt className="type-caption text-ink-muted">Schedule</dt>
                <dd className="m-0">Nightly at 02:00 UTC</dd>
              </div>
              <div>
                <dt className="type-caption text-ink-muted">Retention</dt>
                <dd className="m-0">
                  {data.retentionDays} {data.retentionDays === 1 ? 'day' : 'days'}
                </dd>
              </div>
              <div>
                <dt className="type-caption text-ink-muted">Last backup</dt>
                <dd className="m-0">
                  {data.lastBackupAt ? formatDateTime(data.lastBackupAt) : 'Not yet'}
                </dd>
              </div>
            </dl>
            {data.lastError && <ErrorMessage error={data.lastError} />}
            <p className="m-0 type-caption text-ink-muted">
              Copy the <code className="type-code">backups</code> volume off this server regularly,
              and keep a separate copy of <code className="type-code">APP_SECRET_KEY</code> from{' '}
              <code className="type-code">.env</code> so stored integration credentials can be
              decrypted after a restore.
            </p>
          </Card>

          {data.backups.length === 0 ? (
            <Card>
              <p className="m-0 text-ink-muted">
                No backups yet. Press Backup now to create the first one.
              </p>
            </Card>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Archive</Th>
                  <Th>Type</Th>
                  <Th>Created</Th>
                  <Th>Size</Th>
                  <Th>
                    <span className="sr-only">Download</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {data.backups.map((b) => (
                  <tr key={b.name}>
                    <Td className="type-id">{b.name}</Td>
                    <Td>
                      <StatusBadge tone="neutral">{reasonLabels[b.reason]}</StatusBadge>
                    </Td>
                    <Td>{formatDateTime(b.createdAt)}</Td>
                    <Td>{formatBytes(b.sizeBytes)}</Td>
                    <Td className="text-right">
                      <a
                        href={`/api/backups/${encodeURIComponent(b.name)}`}
                        className={buttonClasses('secondary', 'sm')}
                      >
                        <Download aria-hidden="true" strokeWidth={1.75} />
                        Download
                      </a>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          <Card className="flex flex-col gap-2">
            <h2 className="m-0 type-heading">Restoring a backup</h2>
            <p className="m-0">
              On the server host, stop the app and restore both the database and attachments with:
            </p>
            <pre className="m-0 overflow-x-auto rounded-md border border-line bg-surface-sunken p-3 type-code">
              ./scripts/restore.sh /path/to/open-itsm-backup.tar.gz
            </pre>
            <p className="m-0 type-caption text-ink-muted">
              If you restore onto a new server, put the original{' '}
              <code className="type-code">APP_SECRET_KEY</code> in{' '}
              <code className="type-code">.env</code> so stored Microsoft 365, Entra ID and chat
              credentials keep working.
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
