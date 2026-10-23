import {
  channelTestResultSchema,
  notificationChannelSchema,
  NOTIFICATION_EVENTS,
  webhookUrlProblem,
  type ChannelKind,
  type ChannelTestResult,
  type CreateChannelRequest,
  type LowStockMode,
  type NotificationChannel,
  type NotificationEvent,
  type UpdateChannelRequest,
} from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, redirect } from '@tanstack/react-router';
import { Plus, Send } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormDialog } from '@/components/form-dialog';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { Label, Select } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { StatusShape } from '@/components/ui/status-shape';
import { apiRequest } from '@/lib/api';
import {
  channelKindLabels,
  channelState,
  channelStateLabels,
  channelStateTones,
  describeEvents,
  eventLabels,
  lowStockModeLabels,
} from '@/lib/notifications';
import { notificationSettingsQuery } from '@/lib/queries';
import { formatDateTime } from '@/lib/tickets';
import { authedRoute } from './authed';

export const adminNotificationsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin/notifications',
  beforeLoad: ({ context }) => {
    if (context.session.user.role !== 'admin') throw redirect({ to: '/' });
  },
  component: NotificationsPage,
});

/** The dialog is closed, adding a channel, or editing one. */
type Editing = null | 'new' | NotificationChannel;

function NotificationsPage() {
  const settings = useQuery(notificationSettingsQuery);
  const [editing, setEditing] = useState<Editing>(null);
  return (
    <>
      <PageHeader
        title="Notifications"
        caption="Post new tickets, assignments and low stock to Slack or Teams channels. Messages carry the subject and a link, never what was written."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" strokeWidth={1.75} />
            Add channel
          </Button>
        }
      />
      {settings.isPending && <p className="m-0 text-ink-muted">Loading channels…</p>}
      <ErrorMessage error={settings.error} />
      {settings.data && (
        <div className="flex max-w-4xl flex-col gap-6">
          {!settings.data.siteUrl && (
            <p
              role="status"
              className="m-0 flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-warning"
            >
              <span className="mt-[5px]">
                <StatusShape tone="warning" />
              </span>
              Messages are sent without an Open button because APP_HOSTNAME is not set. Add it to
              the .env file and restart Open ITSM.
            </p>
          )}
          {settings.data.channels.length === 0 ? (
            <Card>
              <p className="m-0">
                No channels yet, so nothing is posted. Add a Slack or Teams channel to start.
              </p>
            </Card>
          ) : (
            settings.data.channels.map((channel) => (
              <ChannelCard key={channel.id} channel={channel} onEdit={() => setEditing(channel)} />
            ))
          )}
          <SetupSteps />
        </div>
      )}
      <ChannelDialog editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
}

function ChannelCard({ channel, onEdit }: { channel: NotificationChannel; onEdit: () => void }) {
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const [tested, setTested] = useState<ChannelTestResult>();
  const state = channelState(channel);
  const test = useMutation({
    mutationFn: () =>
      apiRequest('POST', `/api/settings/notifications/${channel.id}/test`, {
        schema: channelTestResultSchema,
      }),
    onSuccess: async (result) => {
      setTested(result);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => apiRequest('DELETE', `/api/settings/notifications/${channel.id}`),
    onSuccess: async () => {
      setConfirming(false);
      await refresh();
    },
  });

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 type-heading">
          {channel.name}
          <span className="ml-2 font-normal text-ink-muted">{channelKindLabels[channel.kind]}</span>
        </h2>
        <StatusBadge tone={channelStateTones[state]}>{channelStateLabels[state]}</StatusBadge>
      </div>
      <p className="m-0">{describeEvents(channel)}</p>
      <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="type-caption text-ink-muted">Webhook</dt>
          <dd className="m-0 type-id [overflow-wrap:anywhere]">{channel.webhookHint}</dd>
        </div>
        <div>
          <dt className="type-caption text-ink-muted">Last message</dt>
          <dd className="m-0">
            {channel.lastSentAt ? formatDateTime(channel.lastSentAt) : 'None yet'}
          </dd>
        </div>
      </dl>
      {channel.lastError && !tested && (
        <p
          role="alert"
          className="m-0 flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-danger"
        >
          <span className="mt-[5px]">
            <StatusShape tone="danger" />
          </span>
          <span>
            {channel.lastErrorAt && (
              <span className="font-semibold">{formatDateTime(channel.lastErrorAt)}: </span>
            )}
            {channel.lastError}
          </span>
        </p>
      )}
      {tested && <TestResult result={tested} />}
      <ErrorMessage error={test.error ?? remove.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={test.isPending}
          onClick={() => {
            setTested(undefined);
            test.mutate();
          }}
        >
          <Send aria-hidden="true" strokeWidth={1.75} />
          {test.isPending ? 'Sending…' : 'Send test message'}
        </Button>
        <Button size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
          Remove
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={`Remove ${channel.name}?`}
        confirmLabel="Remove"
        danger
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      >
        Nothing more is posted to it, and its webhook URL is forgotten. Messages already posted stay
        in {channelKindLabels[channel.kind]}.
      </ConfirmDialog>
    </Card>
  );
}

function TestResult({ result }: { result: ChannelTestResult }) {
  const tone = result.ok ? 'success' : 'danger';
  return (
    <p
      role={result.ok ? 'status' : 'alert'}
      className={
        result.ok
          ? 'm-0 flex items-start gap-2 rounded-md bg-success-soft px-3 py-2 text-success'
          : 'm-0 flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-danger'
      }
    >
      <span className="mt-[5px]">
        <StatusShape tone={tone} />
      </span>
      {result.message}
    </p>
  );
}

const URL_HINTS: Record<ChannelKind, string> = {
  slack: 'From the Slack app’s Incoming Webhooks page: https://hooks.slack.com/services/…',
  teams: 'From the “When a Teams webhook request is received” step of the workflow.',
};

function ChannelDialog({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const refresh = useRefresh();
  const channel = editing && editing !== 'new' ? editing : undefined;
  const [kind, setKind] = useState<ChannelKind>('slack');
  const [urlError, setUrlError] = useState<string>();
  const kindId = useId();
  const shownKind = channel?.kind ?? kind;

  const save = useMutation({
    mutationFn: (body: CreateChannelRequest | UpdateChannelRequest) =>
      channel
        ? apiRequest('PUT', `/api/settings/notifications/${channel.id}`, {
            body,
            schema: notificationChannelSchema,
          })
        : apiRequest('POST', '/api/settings/notifications', {
            body,
            schema: notificationChannelSchema,
          }),
    onSuccess: async () => {
      await refresh();
      close();
    },
  });

  function close() {
    save.reset();
    setUrlError(undefined);
    setKind('slack');
    onClose();
  }

  function submit(form: FormData) {
    const webhookUrl = String(form.get('webhookUrl') ?? '').trim();
    const problem = webhookUrl ? webhookUrlProblem(shownKind, webhookUrl) : null;
    setUrlError(problem ?? undefined);
    if (problem) return;
    const common = {
      name: String(form.get('name') ?? ''),
      events: NOTIFICATION_EVENTS.filter((e) => form.get(`event-${e}`) === 'on'),
      lowStockMode: String(form.get('lowStockMode')) as LowStockMode,
      enabled: form.get('enabled') === 'on',
    };
    save.mutate(channel ? { ...common, webhookUrl } : { ...common, kind: shownKind, webhookUrl });
  }

  const events: NotificationEvent[] = channel?.events ?? ['ticket_created', 'ticket_assigned'];

  return (
    <FormDialog
      open={editing !== null}
      title={channel ? `Edit ${channel.name}` : 'Add channel'}
      submitLabel={channel ? 'Save changes' : 'Add channel'}
      pending={save.isPending}
      error={save.error}
      onCancel={close}
      onSubmit={submit}
    >
      {channel ? (
        <p className="m-0 text-ink-muted">
          {channelKindLabels[channel.kind]} webhook{' '}
          <span className="type-id">{channel.webhookHint}</span>
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor={kindId}>Service</Label>
          <Select
            id={kindId}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ChannelKind);
              setUrlError(undefined);
            }}
          >
            <option value="slack">Slack</option>
            <option value="teams">Microsoft Teams</option>
          </Select>
        </div>
      )}
      <FormField
        label="Name"
        name="name"
        required
        maxLength={100}
        autoComplete="off"
        defaultValue={channel?.name}
        placeholder="IT team"
        hint="Shown only here, to tell channels apart."
      />
      <FormField
        label="Webhook URL"
        name="webhookUrl"
        type="password"
        required={!channel}
        autoComplete="off"
        spellCheck={false}
        placeholder={channel ? 'Stored. Leave blank to keep it.' : undefined}
        onInput={() => setUrlError(undefined)}
        {...(urlError
          ? { error: urlError }
          : {
              hint: `${URL_HINTS[shownKind]} Stored encrypted and never shown again.`,
            })}
      />
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 type-label">Post about</legend>
        {NOTIFICATION_EVENTS.map((event) => (
          <Check key={event} name={`event-${event}`} defaultChecked={events.includes(event)}>
            {eventLabels[event]}
          </Check>
        ))}
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 type-label">Post low stock</legend>
        {(['first', 'every'] as const).map((mode) => (
          <Check
            key={mode}
            type="radio"
            name="lowStockMode"
            value={mode}
            defaultChecked={(channel?.lowStockMode ?? 'first') === mode}
          >
            {lowStockModeLabels[mode]}
          </Check>
        ))}
      </fieldset>
      <Check name="enabled" defaultChecked={channel?.enabled ?? true}>
        Post to this channel
        <span className="block font-normal text-ink-muted">
          Switch off to pause it without losing its settings.
        </span>
      </Check>
    </FormDialog>
  );
}

function Check({
  name,
  type = 'checkbox',
  value,
  defaultChecked,
  children,
}: {
  name: string;
  type?: 'checkbox' | 'radio';
  value?: string;
  defaultChecked: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type={type}
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="mt-1 size-4 accent-pine"
      />
      <Label htmlFor={id} className="font-normal">
        {children}
      </Label>
    </div>
  );
}

/** How to get a webhook URL from each service. */
function SetupSteps() {
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="m-0 type-heading">Getting a webhook URL</h2>
      <h3 className="m-0 type-label">Slack</h3>
      <ol className="m-0 flex list-decimal flex-col gap-2 pl-5">
        <li>
          At api.slack.com/apps, create an app from scratch named Open ITSM in your workspace.
        </li>
        <li>
          Open <strong>Incoming Webhooks</strong>, switch it on, and choose{' '}
          <strong>Add New Webhook</strong>. Pick the channel to post to.
        </li>
        <li>Copy the webhook URL and paste it here. Each channel needs its own URL.</li>
      </ol>
      <h3 className="m-0 type-label">Microsoft Teams</h3>
      <ol className="m-0 flex list-decimal flex-col gap-2 pl-5">
        <li>
          In Teams, open the channel&apos;s <strong>More options</strong> menu and choose{' '}
          <strong>Workflows</strong>.
        </li>
        <li>
          Choose the <strong>Send webhook alerts to a channel</strong> template, sign in if asked,
          pick the team and channel, and save.
        </li>
        <li>
          Copy the URL it shows and paste it here. Add a co-owner to the workflow so it keeps
          working if its owner leaves.
        </li>
      </ol>
      <p className="m-0 text-ink-muted">
        Teams retired the older Incoming Webhook connector in 2026, so its URLs are refused.
      </p>
    </Card>
  );
}
