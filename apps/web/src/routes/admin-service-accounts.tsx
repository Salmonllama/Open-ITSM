import {
  ISSUABLE_SCOPES,
  TOKEN_DEFAULT_DAYS,
  TOKEN_MAX_DAYS,
  TOKEN_WARN_DAYS,
  createdTokenSchema,
  serviceAccountSchema,
  type ApiToken,
  type CreateServiceAccountRequest,
  type CreateTokenRequest,
  type CreatedToken,
  type ServiceAccount,
  type UpdateServiceAccountRequest,
} from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, redirect } from '@tanstack/react-router';
import { Copy, KeyRound, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { Label } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, Td, Th } from '@/components/ui/table';
import { apiRequest } from '@/lib/api';
import { formatDate } from '@/lib/assets';
import { serviceAccountsQuery } from '@/lib/queries';
import { authedRoute } from './authed';

export const adminServiceAccountsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin/service-accounts',
  beforeLoad: ({ context }) => {
    if (context.session.user.role !== 'admin') throw redirect({ to: '/' });
  },
  component: ServiceAccountsPage,
});

const scopeDescriptions: Record<(typeof ISSUABLE_SCOPES)[number], string> = {
  'assets:read': 'Read assets, asset types and fields',
  'assets:write': 'Create, change, import and delete assets, asset types and fields',
  'tickets:read': 'Read tickets, their conversations and history',
  'tickets:write': 'Open tickets, reply, add notes, and change status and assignee',
};

const DAY_MS = 24 * 3600 * 1000;

function ServiceAccountsPage() {
  const accounts = useQuery(serviceAccountsQuery);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader
        title="Service accounts"
        caption="Scripts and other systems call the API as a service account, with a token limited to the scopes it needs."
        actions={
          !adding && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" strokeWidth={1.75} />
              New service account
            </Button>
          )
        }
      />
      {adding && <CreateAccountForm onDone={() => setAdding(false)} />}
      {accounts.isPending && <p className="m-0 text-ink-muted">Loading service accounts…</p>}
      <ErrorMessage error={accounts.error} />
      {accounts.data?.length === 0 && (
        <p className="m-0 text-ink-muted">
          No service accounts yet. Create one for each script or system, so you can see what each
          one changed and revoke it on its own.
        </p>
      )}
      {accounts.data?.map((account) => (
        <AccountCard key={account.id} account={account} />
      ))}
    </>
  );
}

function useRefreshAccounts() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: serviceAccountsQuery.queryKey });
}

function CreateAccountForm({ onDone }: { onDone: () => void }) {
  const refresh = useRefreshAccounts();
  const create = useMutation({
    mutationFn: (body: CreateServiceAccountRequest) =>
      apiRequest('POST', '/api/service-accounts', { body, schema: serviceAccountSchema }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      name: String(form.get('name')),
      description: String(form.get('description')),
    });
  }

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <h2 className="m-0 type-heading">New service account</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Name"
            name="name"
            required
            autoComplete="off"
            hint="Shown in the audit log, like Inventory sync."
          />
          <FormField
            label="Description (optional)"
            name="description"
            autoComplete="off"
            maxLength={500}
            hint="What it does and who looks after it."
          />
        </div>
        <ErrorMessage error={create.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Create service account
          </Button>
          <Button onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

function AccountCard({ account }: { account: ServiceAccount }) {
  const refresh = useRefreshAccounts();
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<CreatedToken>();
  const [confirming, setConfirming] = useState<'disable' | 'delete'>();
  const update = useMutation({
    mutationFn: (body: UpdateServiceAccountRequest) =>
      apiRequest('PATCH', `/api/service-accounts/${account.id}`, {
        body,
        schema: serviceAccountSchema,
      }),
    onSuccess: async () => {
      setConfirming(undefined);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => apiRequest('DELETE', `/api/service-accounts/${account.id}`),
    onSuccess: async () => {
      setConfirming(undefined);
      await refresh();
    },
  });

  const active = account.tokens.filter((t) => !t.revokedAt);
  const headingId = `account-${account.id}`;

  return (
    <Card className="flex flex-col gap-4 p-6">
      <section aria-labelledby={headingId} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id={headingId} className="m-0 type-heading">
                {account.name}
              </h2>
              {account.disabled ? (
                <StatusBadge tone="neutral">Disabled</StatusBadge>
              ) : (
                <StatusBadge tone="success">Active</StatusBadge>
              )}
            </div>
            {account.description && <p className="m-0 text-ink-muted">{account.description}</p>}
            <p className="m-0 type-caption text-ink-muted">
              Created {formatDate(account.createdAt)}
              {account.createdBy && ` by ${account.createdBy}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!account.disabled && !issuing && (
              <Button
                size="sm"
                onClick={() => {
                  setIssued(undefined);
                  setIssuing(true);
                }}
              >
                <KeyRound aria-hidden="true" strokeWidth={1.75} />
                Issue token
              </Button>
            )}
            {account.disabled ? (
              <Button
                size="sm"
                disabled={update.isPending}
                onClick={() => update.mutate({ disabled: false })}
              >
                Enable
              </Button>
            ) : (
              <Button size="sm" onClick={() => setConfirming('disable')}>
                Disable
              </Button>
            )}
            <Button size="sm" onClick={() => setConfirming('delete')}>
              Delete
            </Button>
          </div>
        </div>
        {update.error && !confirming && <ErrorMessage error={update.error} />}

        {issuing && (
          <IssueTokenForm
            account={account}
            onIssued={(token) => {
              setIssuing(false);
              setIssued(token);
            }}
            onCancel={() => setIssuing(false)}
          />
        )}
        {issued && <IssuedToken issued={issued} onDone={() => setIssued(undefined)} />}

        {account.tokens.length > 0 ? (
          <Table>
            <thead>
              <tr>
                <Th>Token</Th>
                <Th>Scopes</Th>
                <Th>Created</Th>
                <Th>Expires</Th>
                <Th>Last used</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {account.tokens.map((token) => (
                <TokenRow key={token.id} account={account} token={token} />
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="m-0 type-caption text-ink-muted">No tokens issued.</p>
        )}
      </section>

      <ConfirmDialog
        open={confirming === 'disable'}
        title={`Disable ${account.name}?`}
        confirmLabel="Disable"
        danger
        pending={update.isPending}
        onConfirm={() => update.mutate({ disabled: true })}
        onCancel={() => {
          setConfirming(undefined);
          update.reset();
        }}
      >
        <p className="m-0">
          Its {active.length} active {active.length === 1 ? 'token stops' : 'tokens stop'} working
          until you enable it again.
        </p>
        {confirming === 'disable' && <ErrorMessage error={update.error} />}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirming === 'delete'}
        title={`Delete ${account.name}?`}
        confirmLabel="Delete service account"
        danger
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => {
          setConfirming(undefined);
          remove.reset();
        }}
      >
        <p className="m-0">
          The account and its tokens are removed. An account that has changed anything stays in the
          audit log, so it can only be disabled.
        </p>
        {confirming === 'delete' && <ErrorMessage error={remove.error} />}
      </ConfirmDialog>
    </Card>
  );
}

function IssueTokenForm({
  account,
  onIssued,
  onCancel,
}: {
  account: ServiceAccount;
  onIssued: (token: CreatedToken) => void;
  onCancel: () => void;
}) {
  const refresh = useRefreshAccounts();
  const issue = useMutation({
    mutationFn: (body: CreateTokenRequest) =>
      apiRequest('POST', `/api/service-accounts/${account.id}/tokens`, {
        body,
        schema: createdTokenSchema,
      }),
    onSuccess: async (token) => {
      onIssued(token);
      await refresh();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    issue.mutate({
      scopes: ISSUABLE_SCOPES.filter((s) => form.get(s) === 'on'),
      expiresInDays: Number(form.get('expiresInDays')),
    });
  }

  return (
    <form
      className="flex flex-col gap-4 rounded-md border border-line bg-surface p-4"
      onSubmit={onSubmit}
    >
      <h3 className="m-0 type-heading">Issue a token for {account.name}</h3>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 type-label">Scopes</legend>
        {ISSUABLE_SCOPES.map((scope) => (
          <div key={scope} className="flex items-start gap-2">
            <input
              id={`${account.id}-${scope}`}
              type="checkbox"
              name={scope}
              defaultChecked={scope === 'assets:read'}
              className="mt-1 size-4 accent-pine"
            />
            <Label htmlFor={`${account.id}-${scope}`}>
              <span className="type-code">{scope}</span>{' '}
              <span className="font-normal text-ink-muted">{scopeDescriptions[scope]}</span>
            </Label>
          </div>
        ))}
        <p className="m-0 type-caption text-ink-muted">
          Ticket scopes arrive with tickets. Give a token only what the script needs.
        </p>
      </fieldset>
      <div className="max-w-xs">
        <FormField
          label="Expires after (days)"
          name="expiresInDays"
          type="number"
          required
          min={1}
          max={TOKEN_MAX_DAYS}
          defaultValue={TOKEN_DEFAULT_DAYS}
          hint={`At most ${TOKEN_MAX_DAYS} days. Issue a new token before this one runs out.`}
        />
      </div>
      <ErrorMessage error={issue.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={issue.isPending}>
          Issue token
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function IssuedToken({ issued, onDone }: { issued: CreatedToken; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-md border border-line bg-surface-sunken p-4"
    >
      <p className="m-0 type-label">
        Copy this token now. It is shown only once; if it is lost, revoke it and issue another.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 rounded-sm bg-surface-raised px-3 py-2 type-code break-all">
          {issued.token}
        </code>
        <Button
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(issued.token).then(() => setCopied(true))
          }
        >
          <Copy aria-hidden="true" strokeWidth={1.75} />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="m-0 type-caption text-ink-muted">
        Send it as <code className="type-code">Authorization: Bearer &lt;token&gt;</code>, never in
        the address or the body.
      </p>
      <div>
        <Button size="sm" variant="ghost" onClick={onDone}>
          I have saved it
        </Button>
      </div>
    </div>
  );
}

function tokenState(token: ApiToken): {
  tone: 'neutral' | 'danger' | 'warning' | 'success';
  label: string;
} {
  if (token.revokedAt) return { tone: 'neutral', label: 'Revoked' };
  const left = Date.parse(token.expiresAt) - Date.now();
  if (left <= 0) return { tone: 'danger', label: 'Expired' };
  if (left <= TOKEN_WARN_DAYS * DAY_MS) {
    const days = Math.ceil(left / DAY_MS);
    return { tone: 'warning', label: `Expires in ${days} ${days === 1 ? 'day' : 'days'}` };
  }
  return { tone: 'success', label: 'Active' };
}

function TokenRow({ account, token }: { account: ServiceAccount; token: ApiToken }) {
  const refresh = useRefreshAccounts();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () =>
      apiRequest('POST', `/api/service-accounts/${account.id}/tokens/${token.id}/revoke`),
    onSuccess: async () => {
      setConfirming(false);
      await refresh();
    },
  });
  const state = tokenState(token);
  const label = `oitsm_${token.publicId}_…`;

  return (
    <tr>
      <Td className="whitespace-nowrap">
        <span className="type-id">{label}</span>
        <div className="mt-1">
          <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
        </div>
      </Td>
      <Td className="type-code">{token.scopes.join(' ')}</Td>
      <Td className="type-caption whitespace-nowrap text-ink-muted">
        {formatDate(token.createdAt)}
        {token.createdBy && <div>by {token.createdBy}</div>}
      </Td>
      <Td className="type-caption whitespace-nowrap">{formatDate(token.expiresAt)}</Td>
      <Td className="type-caption whitespace-nowrap text-ink-muted">
        {token.lastUsedAt ? formatDate(token.lastUsedAt) : 'Never'}
      </Td>
      <Td>
        {!token.revokedAt && (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setConfirming(true)}>
              Revoke
            </Button>
          </div>
        )}
        <ConfirmDialog
          open={confirming}
          title={`Revoke ${label}?`}
          confirmLabel="Revoke token"
          danger
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate()}
          onCancel={() => {
            setConfirming(false);
            revoke.reset();
          }}
        >
          <p className="m-0">
            Anything using this token for {account.name} stops working at once. This cannot be
            undone.
          </p>
          {confirming && <ErrorMessage error={revoke.error} />}
        </ConfirmDialog>
      </Td>
    </tr>
  );
}
