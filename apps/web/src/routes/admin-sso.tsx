import {
  daysUntil,
  entraSettingsSchema,
  entraTestResultSchema,
  SSO_SECRET_WARN_DAYS,
  type EntraSettings,
  type EntraSettingsRequest,
  type EntraTestResult,
} from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, redirect } from '@tanstack/react-router';
import { Copy } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { StatusShape } from '@/components/ui/status-shape';
import { apiRequest } from '@/lib/api';
import { entraSettingsQuery } from '@/lib/queries';
import { describeEntraState, entraStateLabels, entraStateTones } from '@/lib/sso';
import { authedRoute } from './authed';

export const adminSsoRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin/sso',
  beforeLoad: ({ context }) => {
    if (context.session.user.role !== 'admin') throw redirect({ to: '/' });
  },
  component: SsoPage,
});

function SsoPage() {
  const settings = useQuery(entraSettingsQuery);
  return (
    <>
      <PageHeader
        title="Single sign-on"
        caption="Let technicians sign in with Microsoft Entra ID using an Entra ID group. Local accounts always stay on."
      />
      {settings.isPending && <p className="m-0 text-ink-muted">Loading single sign-on settings…</p>}
      <ErrorMessage error={settings.error} />
      {settings.data && (
        <div className="flex max-w-4xl flex-col gap-6">
          <StatusCard settings={settings.data} />
          <SettingsForm settings={settings.data} />
          <SetupSteps settings={settings.data} />
        </div>
      )}
    </>
  );
}

function useRefreshSso() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['sso'] }),
      queryClient.invalidateQueries({ queryKey: ['auth-methods'] }),
    ]);
}

function StatusCard({ settings }: { settings: EntraSettings }) {
  const refresh = useRefreshSso();
  const [confirming, setConfirming] = useState(false);
  const disconnect = useMutation({
    mutationFn: () => apiRequest('DELETE', '/api/settings/sso'),
    onSuccess: async () => {
      setConfirming(false);
      await refresh();
    },
  });

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 type-heading">Microsoft Entra ID</h2>
        <StatusBadge tone={entraStateTones[settings.state]}>
          {entraStateLabels[settings.state]}
        </StatusBadge>
      </div>
      <p className="m-0">{describeEntraState(settings)}</p>
      <ErrorMessage error={disconnect.error} />
      {settings.configured && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title="Disconnect Microsoft Entra ID?"
        confirmLabel="Disconnect"
        danger
        pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
        onCancel={() => setConfirming(false)}
      >
        Microsoft sign-in will stop and the stored client secret will be forgotten. Local accounts
        are not affected.
      </ConfirmDialog>
    </Card>
  );
}

function SettingsForm({ settings }: { settings: EntraSettings }) {
  const refresh = useRefreshSso();
  const [tested, setTested] = useState<EntraTestResult>();
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (body: EntraSettingsRequest) =>
      apiRequest('PUT', '/api/settings/sso', { body, schema: entraSettingsSchema }),
    onSuccess: async () => {
      setSaved(true);
      await refresh();
    },
  });

  const test = useMutation({
    mutationFn: (body: EntraSettingsRequest) =>
      apiRequest('POST', '/api/settings/sso/test', { body, schema: entraTestResultSchema }),
    onSuccess: setTested,
  });

  function read(form: HTMLFormElement): EntraSettingsRequest {
    const data = new FormData(form);
    const expires = String(data.get('secretExpiresOn') ?? '').trim();
    return {
      tenantId: String(data.get('tenantId')),
      clientId: String(data.get('clientId')),
      clientSecret: String(data.get('clientSecret')),
      technicianGroupId: String(data.get('technicianGroupId')),
      secretExpiresOn: expires || null,
      enabled: data.get('enabled') === 'on',
    };
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    save.mutate(read(event.currentTarget));
  }

  function onTest(form: HTMLFormElement | null) {
    if (!form || !form.reportValidity()) return;
    setTested(undefined);
    test.mutate(read(form));
  }

  const left = settings.secretExpiresOn ? daysUntil(settings.secretExpiresOn) : null;
  const expiryError =
    left !== null && left < 0
      ? 'This secret has expired. Create a new one and enter it with its expiry date.'
      : undefined;
  const expiryHint =
    left !== null && left <= SSO_SECRET_WARN_DAYS && left >= 0
      ? `Expires in ${left === 1 ? '1 day' : `${left} days`}. Create a new secret before then.`
      : 'Optional. Shown next to the secret in Entra ID; you are warned 30 days before.';

  return (
    <Card>
      <form
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
        onChange={() => {
          setSaved(false);
          setTested(undefined);
        }}
      >
        <h2 className="m-0 type-heading">Entra ID connection</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Directory (tenant) ID"
            name="tenantId"
            required
            mono
            autoComplete="off"
            spellCheck={false}
            defaultValue={settings.tenantId}
            hint="Copy the GUID from the app registration's Overview page."
          />
          <FormField
            label="Application (client) ID"
            name="clientId"
            required
            mono
            autoComplete="off"
            spellCheck={false}
            defaultValue={settings.clientId}
            hint="From the same Overview page."
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Client secret"
            name="clientSecret"
            type="password"
            required={!settings.secretSet}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={settings.secretSet ? 'Stored. Leave blank to keep it.' : undefined}
            hint={
              settings.secretSet
                ? 'Stored encrypted and never shown again. Enter a new one to replace it.'
                : "The secret's Value, not its Secret ID. It is stored encrypted and never shown again."
            }
          />
          <FormField
            label="Secret expires on"
            name="secretExpiresOn"
            type="date"
            defaultValue={settings.secretExpiresOn ?? ''}
            error={expiryError}
            hint={expiryHint}
          />
        </div>
        <FormField
          label="Technician group object ID"
          name="technicianGroupId"
          required
          mono
          autoComplete="off"
          spellCheck={false}
          defaultValue={settings.technicianGroupId}
          hint="Members of this Entra ID group sign in as technicians. Administrators stay local accounts."
        />
        <label className="flex items-center gap-2 type-body">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={settings.configured ? settings.enabled : true}
            className="size-4 accent-pine"
          />
          Offer Sign in with Microsoft on the login page
        </label>
        <ErrorMessage error={save.error ?? test.error} />
        {tested && (
          <div
            role="status"
            className={`flex items-start gap-2 rounded-md border px-3 py-2 type-body ${
              tested.ok
                ? 'border-success/30 bg-success-soft text-success'
                : 'border-danger/30 bg-danger-soft text-danger'
            }`}
          >
            <span className="mt-1 shrink-0">
              <StatusShape tone={tested.ok ? 'success' : 'danger'} />
            </span>
            <span>{tested.message}</span>
          </div>
        )}
        {saved && (
          <p role="status" className="m-0 type-label text-success">
            Settings saved.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={save.isPending || test.isPending}>
            {save.isPending ? 'Saving…' : 'Save settings'}
          </Button>
          <Button
            type="button"
            disabled={save.isPending || test.isPending}
            onClick={(e) => onTest(e.currentTarget.form)}
          >
            {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SetupSteps({ settings }: { settings: EntraSettings }) {
  const [copied, setCopied] = useState(false);
  const redirectUri = settings.redirectUri ?? `${window.location.origin}/api/auth/entra/callback`;

  async function copyUri() {
    await navigator.clipboard.writeText(redirectUri).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="m-0 type-heading">Entra ID setup steps</h2>
      <ol className="m-0 flex flex-col gap-2 pl-5 type-body">
        <li>
          In Microsoft Entra admin center, open <strong>App registrations</strong> and register a
          new Web application for this directory only.
        </li>
        <li>
          Add this Web redirect URI:
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded-sm border border-line bg-surface-sunken px-2 py-1 type-code">
              {redirectUri}
            </code>
            <Button size="sm" onClick={() => void copyUri()}>
              <Copy aria-hidden="true" strokeWidth={1.75} />
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </li>
        <li>
          Under <strong>Certificates &amp; secrets</strong>, create a client secret and copy its{' '}
          <strong>Value</strong> and expiry date into the form above.
        </li>
        <li>
          Under <strong>Token configuration</strong>, add a <strong>Groups claim</strong> (Security
          groups) to the ID token so group checks do not need an extra Microsoft Graph call.
        </li>
        <li>
          Under <strong>API permissions</strong>, add Microsoft Graph delegated permission{' '}
          <code className="type-code">GroupMember.Read.All</code> and grant admin consent. Open ITSM
          uses this as a fallback when a user belongs to too many groups for the token to list.
        </li>
        <li>
          Copy the <strong>Object ID</strong> of your IT technicians group into the form above.
        </li>
      </ol>
      <p className="m-0 type-caption text-ink-muted">
        Local accounts always keep working, even if Entra ID is misconfigured. On the server host,{' '}
        <code className="type-code">docker compose exec app itsm disable-sso</code> switches
        Microsoft sign-in off at any time.
      </p>
    </Card>
  );
}
