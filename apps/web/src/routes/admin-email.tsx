import {
  daysUntil,
  MAIL_SECRET_WARN_DAYS,
  mailSettingsSchema,
  mailTestResultSchema,
  type MailSettings,
  type MailSettingsRequest,
  type MailTestResult,
} from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, redirect } from '@tanstack/react-router';
import { Copy, RefreshCw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { Label } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { StatusShape } from '@/components/ui/status-shape';
import { apiRequest } from '@/lib/api';
import { describeMailStatus, mailStateLabels, mailStateTones } from '@/lib/mail';
import { mailSettingsQuery } from '@/lib/queries';
import { formatDateTime } from '@/lib/tickets';
import { authedRoute } from './authed';

export const adminEmailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin/email',
  beforeLoad: ({ context }) => {
    if (context.session.user.role !== 'admin') throw redirect({ to: '/' });
  },
  component: EmailPage,
});

function EmailPage() {
  const settings = useQuery(mailSettingsQuery);
  return (
    <>
      <PageHeader
        title="Email"
        caption="Connect the shared support mailbox in Microsoft 365. Email to it opens tickets, and replies go out from it."
      />
      {settings.isPending && <p className="m-0 text-ink-muted">Loading email settings…</p>}
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

function useRefreshMail() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['mail'] });
}

function StatusCard({ settings }: { settings: MailSettings }) {
  const refresh = useRefreshMail();
  const [confirming, setConfirming] = useState(false);
  const { status } = settings;
  const checkNow = useMutation({
    mutationFn: () => apiRequest('POST', '/api/settings/mail/check-now'),
    // The check runs in the background; look again once it has had a moment.
    onSuccess: () => setTimeout(() => void refresh(), 3000),
  });
  const disconnect = useMutation({
    mutationFn: () => apiRequest('DELETE', '/api/settings/mail'),
    onSuccess: async () => {
      setConfirming(false);
      await refresh();
    },
  });

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 type-heading">Mailbox</h2>
        <StatusBadge tone={mailStateTones[status.state]}>
          {mailStateLabels[status.state]}
        </StatusBadge>
      </div>
      <p className="m-0">{describeMailStatus(status)}</p>
      {settings.configured && (
        <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-3">
          <div>
            <dt className="type-caption text-ink-muted">Last checked</dt>
            <dd className="m-0">
              {status.lastCheckedAt ? formatDateTime(status.lastCheckedAt) : 'Not yet'}
            </dd>
          </div>
          <div>
            <dt className="type-caption text-ink-muted">Tickets from email</dt>
            <dd className="m-0">{settings.ticketsFromEmail}</dd>
          </div>
          <div>
            <dt className="type-caption text-ink-muted">Connected</dt>
            <dd className="m-0">
              {settings.connectedAt ? formatDateTime(settings.connectedAt) : '—'}
            </dd>
          </div>
        </dl>
      )}
      <ErrorMessage error={checkNow.error ?? disconnect.error} />
      {settings.configured && (
        <div className="flex flex-wrap gap-2">
          {settings.enabled && (
            <Button size="sm" disabled={checkNow.isPending} onClick={() => checkNow.mutate()}>
              <RefreshCw aria-hidden="true" strokeWidth={1.75} />
              {checkNow.isSuccess ? 'Checking…' : 'Check now'}
            </Button>
          )}
          <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Disconnect ${settings.mailbox}?`}
        confirmLabel="Disconnect"
        danger
        pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
        onCancel={() => setConfirming(false)}
      >
        Email to it stops opening tickets and replies are no longer emailed. The client secret is
        forgotten. Tickets and their conversations stay.
      </ConfirmDialog>
    </Card>
  );
}

function SettingsForm({ settings }: { settings: MailSettings }) {
  const refresh = useRefreshMail();
  const [tested, setTested] = useState<MailTestResult>();
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (body: MailSettingsRequest) =>
      apiRequest('PUT', '/api/settings/mail', { body, schema: mailSettingsSchema }),
    onSuccess: async () => {
      setSaved(true);
      await refresh();
    },
  });
  const test = useMutation({
    mutationFn: (body: MailSettingsRequest) =>
      apiRequest('POST', '/api/settings/mail/test', { body, schema: mailTestResultSchema }),
    onSuccess: setTested,
  });

  function read(form: HTMLFormElement): MailSettingsRequest {
    const data = new FormData(form);
    return {
      mailbox: String(data.get('mailbox')),
      tenantId: String(data.get('tenantId')),
      clientId: String(data.get('clientId')),
      clientSecret: String(data.get('clientSecret')),
      secretExpiresOn: String(data.get('secretExpiresOn')),
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
    left !== null && left <= MAIL_SECRET_WARN_DAYS && left >= 0
      ? `Expires in ${left === 1 ? '1 day' : `${left} days`}. Create a new secret before then.`
      : 'Shown next to the secret in Entra ID. You are warned 30 days before.';

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
        <h2 className="m-0 type-heading">Microsoft 365 connection</h2>
        <FormField
          label="Mailbox address"
          name="mailbox"
          type="email"
          required
          autoComplete="off"
          defaultValue={settings.mailbox}
          placeholder="support@contoso.com"
          hint="The shared mailbox people email for help. Changing it starts afresh with mail that arrives from then on."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Directory (tenant) ID"
            name="tenantId"
            required
            mono
            autoComplete="off"
            spellCheck={false}
            defaultValue={settings.tenantId}
            hint="From the app registration's Overview page."
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
            required
            defaultValue={settings.secretExpiresOn ?? ''}
            {...(expiryError ? { error: expiryError } : { hint: expiryHint })}
          />
        </div>
        <div className="flex items-start gap-2">
          <input
            id="mail-enabled"
            type="checkbox"
            name="enabled"
            defaultChecked={settings.configured ? settings.enabled : true}
            className="mt-1 size-4 accent-pine"
          />
          <Label htmlFor="mail-enabled">
            Check the mailbox every minute and email replies
            <span className="block font-normal text-ink-muted">
              Switch off to pause email without losing these settings.
            </span>
          </Label>
        </div>

        {tested && <TestResult result={tested} />}
        <ErrorMessage error={test.error ?? save.error} />
        {saved && !save.isPending && (
          <p role="status" className="m-0 flex items-center gap-2 text-success">
            <StatusShape tone="success" />
            Saved. The mailbox is checked within a minute.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button disabled={test.isPending} onClick={(e) => onTest(e.currentTarget.form)}>
            {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TestResult({ result }: { result: MailTestResult }) {
  if (result.ok) {
    return (
      <p
        role="status"
        className="m-0 flex items-start gap-2 rounded-md bg-success-soft px-3 py-2 text-success"
      >
        <span className="mt-[5px]">
          <StatusShape tone="success" />
        </span>
        {result.message}
      </p>
    );
  }
  return (
    <p
      role="alert"
      className="m-0 flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-danger"
    >
      <span className="mt-[5px]">
        <StatusShape tone="danger" />
      </span>
      <span>
        <span className="font-semibold">
          {result.step === 'sign_in' ? 'Signing in failed. ' : 'Opening the mailbox failed. '}
        </span>
        {result.message}
      </span>
    </p>
  );
}

/** The one-time setup in Entra ID and Exchange Online, with this install's values filled in. */
function SetupSteps({ settings }: { settings: MailSettings }) {
  const mailbox = settings.mailbox || 'support@contoso.com';
  const appId = settings.clientId || '<Application (client) ID>';
  const script = [
    'Connect-ExchangeOnline',
    `New-ServicePrincipal -AppId ${appId} -ObjectId <Object ID> -DisplayName "Open ITSM"`,
    `New-ManagementScope -Name "Open ITSM mailbox" -RecipientRestrictionFilter "PrimarySmtpAddress -eq '${mailbox}'"`,
    `New-ManagementRoleAssignment -App ${appId} -Role "Application Mail.ReadWrite" -CustomResourceScope "Open ITSM mailbox"`,
    `New-ManagementRoleAssignment -App ${appId} -Role "Application Mail.Send" -CustomResourceScope "Open ITSM mailbox"`,
    `Test-ServicePrincipalAuthorization -Identity ${appId} -Resource ${mailbox}`,
  ].join('\n');
  const [copied, setCopied] = useState(false);

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="m-0 type-heading">Setting up Microsoft 365</h2>
      <p className="m-0 text-ink-muted">
        Open ITSM reads and sends mail for this one mailbox only. An Exchange administrator does
        this once.
      </p>
      <ol className="m-0 flex list-decimal flex-col gap-3 pl-5">
        <li>
          In the Microsoft Entra admin center, open <strong>App registrations</strong> and create
          one named Open ITSM (single tenant, no redirect URI). Copy its directory (tenant) ID and
          application (client) ID.
        </li>
        <li>
          Under <strong>Certificates &amp; secrets</strong>, add a client secret. Copy its Value and
          note when it expires.
        </li>
        <li>
          Do not add Mail permissions under API permissions: those reach every mailbox in the
          organization. Exchange grants them below, for this mailbox only.
        </li>
        <li>
          Under <strong>Enterprise applications</strong>, open Open ITSM and copy its Object ID (it
          differs from the app registration&apos;s).
        </li>
        <li>
          In Exchange Online PowerShell, run these, with the Object ID in place:
          <div className="mt-2 flex flex-col gap-2">
            <pre className="m-0 rounded-md bg-surface-sunken px-3 py-2 type-code whitespace-pre-wrap [overflow-wrap:anywhere]">
              {script}
            </pre>
            <div>
              <Button
                size="sm"
                onClick={() =>
                  void navigator.clipboard.writeText(script).then(() => setCopied(true))
                }
              >
                <Copy aria-hidden="true" strokeWidth={1.75} />
                {copied ? 'Copied' : 'Copy commands'}
              </Button>
            </div>
          </div>
        </li>
        <li>
          The last command should show both roles as allowed. Changes can take up to two hours to
          apply; then enter the values here and test the connection.
        </li>
      </ol>
    </Card>
  );
}
