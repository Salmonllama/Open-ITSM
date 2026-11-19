import { portalSettingsSchema } from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { apiRequest } from '@/lib/api';
import { portalSettingsQuery } from '@/lib/queries';
import { authedRoute } from './authed';

export const adminPortalRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin/portal',
  beforeLoad: ({ context }) => {
    if (context.session.user.role !== 'admin') throw redirect({ to: '/' });
  },
  component: AdminPortalPage,
});

function AdminPortalPage() {
  const settings = useQuery(portalSettingsQuery);
  const queryClient = useQueryClient();
  const [confirmingOff, setConfirmingOff] = useState(false);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest('PUT', '/api/settings/portal', {
        body: { enabled },
        schema: portalSettingsSchema,
      }),
    onSuccess: async () => {
      setConfirmingOff(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['portal', 'settings'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-methods'] }),
      ]);
    },
  });

  const data = settings.data;
  const hasSignInMethod = Boolean(data && (data.entraEnabled || data.mailConnected));

  return (
    <>
      <PageHeader
        title="End-user portal"
        caption="Let requesters sign in to view and reply to their own open tickets. Off by default; email stays the main channel."
      />
      {settings.isPending && <p className="m-0 text-ink-muted">Loading portal settings…</p>}
      <ErrorMessage error={settings.error ?? toggle.error} />
      {data && (
        <div className="flex max-w-4xl flex-col gap-6">
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="m-0 type-heading">Portal status</h2>
              <StatusBadge tone={data.enabled ? 'success' : 'neutral'}>
                {data.enabled ? 'On' : 'Off'}
              </StatusBadge>
            </div>
            <p className="m-0">
              {data.enabled
                ? 'Requesters can sign in to see and reply to their own open tickets. They cannot see internal notes, assets or anyone else’s tickets.'
                : 'The end-user portal is switched off. Requesters use email only.'}
            </p>
            {data.enabled && !hasSignInMethod && (
              <p className="m-0 type-label text-warning">
                Neither Entra ID single sign-on nor the Microsoft 365 mailbox is active yet, so end
                users have no way to sign in. Connect at least one below.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {data.enabled ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={toggle.isPending}
                  onClick={() => setConfirmingOff(true)}
                >
                  Switch off
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate(true)}
                >
                  {toggle.isPending ? 'Switching on…' : 'Switch on'}
                </Button>
              )}
            </div>
          </Card>

          <Card className="flex flex-col gap-3">
            <h2 className="m-0 type-heading">How requesters sign in</h2>
            <p className="m-0 text-ink-muted">
              Requesters never have local passwords. When the portal is on, they sign in using
              whichever of these is connected:
            </p>
            <ul className="m-0 flex flex-col gap-3 pl-0 list-none">
              <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
                <div>
                  <p className="m-0 type-label">Microsoft Entra ID</p>
                  <p className="m-0 type-caption text-ink-muted">
                    People outside the technician group land in the end-user portal.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge tone={data.entraEnabled ? 'success' : 'neutral'}>
                    {data.entraEnabled ? 'On' : 'Off'}
                  </StatusBadge>
                  <Link to="/admin/sso" className="type-label">
                    Configure
                  </Link>
                </div>
              </li>
              <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
                <div>
                  <p className="m-0 type-label">Emailed one-time sign-in link</p>
                  <p className="m-0 type-caption text-ink-muted">
                    Sent through the connected Microsoft 365 shared mailbox; expires in 15 minutes.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge tone={data.mailConnected ? 'success' : 'neutral'}>
                    {data.mailConnected ? 'Connected' : 'Not connected'}
                  </StatusBadge>
                  <Link to="/admin/email" className="type-label">
                    Configure
                  </Link>
                </div>
              </li>
            </ul>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={confirmingOff}
        title="Switch off the end-user portal?"
        confirmLabel="Switch off"
        danger
        pending={toggle.isPending}
        onConfirm={() => toggle.mutate(false)}
        onCancel={() => setConfirmingOff(false)}
      >
        Signed-in end users will be signed out immediately and unused sign-in links will stop
        working. Tickets and email continue normally.
      </ConfirmDialog>
    </>
  );
}
