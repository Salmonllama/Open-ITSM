import {
  PASSWORD_MIN_LENGTH,
  adminUserSchema,
  type AdminUser,
  type CreateUserRequest,
  type UpdateUserRequest,
} from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, redirect, useNavigate } from '@tanstack/react-router';
import { UserPlus } from 'lucide-react';
import { Fragment, useId, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { Label, Select } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, Td, Th } from '@/components/ui/table';
import { apiRequest } from '@/lib/api';
import { sessionQuery, storeSession, usersQuery } from '@/lib/queries';
import { roleLabels } from '@/lib/roles';
import { authedRoute } from './authed';

export const adminUsersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin/users',
  beforeLoad: ({ context }) => {
    if (context.session.user.role !== 'admin') throw redirect({ to: '/' });
  },
  component: UsersPage,
});

function UsersPage() {
  const { data: users, error, isPending } = useQuery(usersQuery);
  const { data: session } = useQuery(sessionQuery);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader
        title="Users"
        caption={
          users &&
          `${users.length} ${users.length === 1 ? 'user' : 'users'}. Administrators and technicians sign in with a password.`
        }
        actions={
          !adding && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <UserPlus aria-hidden="true" strokeWidth={1.75} />
              Add user
            </Button>
          )
        }
      />
      {adding && <CreateUserForm onDone={() => setAdding(false)} />}
      {isPending && <p className="m-0 text-ink-muted">Loading users…</p>}
      <ErrorMessage error={error} />
      {users && (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <UserRow key={user.id} user={user} isSelf={user.id === session?.user.id} />
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const roleId = useId();
  const create = useMutation({
    mutationFn: (body: CreateUserRequest) =>
      apiRequest('POST', '/api/users', { body, schema: adminUserSchema }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: usersQuery.queryKey });
      onDone();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      name: String(form.get('name')),
      email: String(form.get('email')),
      role: form.get('role') === 'admin' ? 'admin' : 'technician',
      password: String(form.get('password')),
    });
  }

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <h2 className="m-0 type-heading">Add user</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Name" name="name" required autoComplete="off" />
          <FormField label="Email" name="email" type="email" required autoComplete="off" />
          <div className="flex flex-col gap-2">
            <Label htmlFor={roleId}>Role</Label>
            <Select id={roleId} name="role" defaultValue="technician">
              <option value="technician">{roleLabels.technician}</option>
              <option value="admin">{roleLabels.admin}</option>
            </Select>
          </div>
          <FormField
            label="Initial password"
            name="password"
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters. Give it to them in person or over a secure channel.`}
          />
        </div>
        <ErrorMessage error={create.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Add user
          </Button>
          <Button onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

function UserRow({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [settingPassword, setSettingPassword] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const update = useMutation({
    mutationFn: (body: UpdateUserRequest) =>
      apiRequest('PATCH', `/api/users/${user.id}`, { body, schema: adminUserSchema }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: usersQuery.queryKey }),
    onSuccess: () => setConfirmingDisable(false),
  });
  const setPassword = useMutation({
    mutationFn: (password: string) =>
      apiRequest('POST', `/api/users/${user.id}/password`, { body: { password } }),
    onSuccess: async () => {
      setSettingPassword(false);
      if (!isSelf) return;
      // The server ended every session of yours, this one included.
      storeSession(queryClient, null);
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      await navigate({ to: '/login', search: { redirect: undefined } });
    },
  });

  function onPasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPassword.mutate(String(new FormData(event.currentTarget).get('password')));
  }

  const local = user.role !== 'end_user';

  return (
    <Fragment>
      <tr>
        <Td>
          {user.name}
          {isSelf && <span className="type-caption text-ink-muted"> (you)</span>}
        </Td>
        <Td>{user.email}</Td>
        <Td>
          {local ? (
            <Select
              aria-label={`Role for ${user.name}`}
              className="h-7 w-40"
              value={user.role}
              disabled={update.isPending}
              onChange={(e) =>
                update.mutate({ role: e.target.value === 'admin' ? 'admin' : 'technician' })
              }
            >
              <option value="technician">{roleLabels.technician}</option>
              <option value="admin">{roleLabels.admin}</option>
            </Select>
          ) : (
            roleLabels[user.role]
          )}
        </Td>
        <Td>
          {user.disabled ? (
            <StatusBadge tone="neutral">Disabled</StatusBadge>
          ) : (
            <StatusBadge tone="success">Active</StatusBadge>
          )}
        </Td>
        <Td>
          <div className="flex justify-end gap-2">
            {local && (
              <Button
                size="sm"
                aria-expanded={settingPassword}
                onClick={() => setSettingPassword((v) => !v)}
              >
                Set password
              </Button>
            )}
            {user.disabled ? (
              <Button
                size="sm"
                disabled={update.isPending}
                onClick={() => update.mutate({ disabled: false })}
              >
                Enable
              </Button>
            ) : (
              <Button size="sm" onClick={() => setConfirmingDisable(true)}>
                Disable
              </Button>
            )}
          </div>
          <ConfirmDialog
            open={confirmingDisable}
            title={`Disable ${user.name}?`}
            confirmLabel="Disable"
            danger
            pending={update.isPending}
            onConfirm={() => update.mutate({ disabled: true })}
            onCancel={() => {
              setConfirmingDisable(false);
              update.reset();
            }}
          >
            <p className="m-0">
              They are signed out everywhere and cannot sign in until you enable them again.
            </p>
            {confirmingDisable && <ErrorMessage error={update.error} />}
          </ConfirmDialog>
        </Td>
      </tr>
      {update.error && !confirmingDisable && (
        <tr>
          <td colSpan={5} className="px-4 pb-3">
            <ErrorMessage error={update.error} />
          </td>
        </tr>
      )}
      {settingPassword && (
        <tr>
          <td colSpan={5} className="bg-surface px-4 py-4">
            <form className="flex flex-wrap items-end gap-2" onSubmit={onPasswordSubmit}>
              <div className="min-w-64 flex-1">
                <FormField
                  label={`New password for ${user.name}`}
                  name="password"
                  type="password"
                  required
                  minLength={PASSWORD_MIN_LENGTH}
                  autoComplete="new-password"
                  hint={
                    isSelf
                      ? `At least ${PASSWORD_MIN_LENGTH} characters. This signs you out everywhere, including here; sign in again with the new password.`
                      : `At least ${PASSWORD_MIN_LENGTH} characters. This signs them out everywhere and clears any lockout.`
                  }
                />
              </div>
              <Button type="submit" disabled={setPassword.isPending}>
                Save password
              </Button>
              <Button onClick={() => setSettingPassword(false)}>Cancel</Button>
            </form>
            {setPassword.error && (
              <div className="mt-2">
                <ErrorMessage error={setPassword.error} />
              </div>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}
