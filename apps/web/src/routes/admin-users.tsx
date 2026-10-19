import {
  PASSWORD_MIN_LENGTH,
  adminUserSchema,
  type AdminUser,
  type CreateUserRequest,
  type UpdateUserRequest,
} from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, redirect } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { Label, Select } from '@/components/ui/input';
import { apiRequest } from '@/lib/api';
import { sessionQuery, usersQuery } from '@/lib/queries';
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

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Users</h1>
      <CreateUserForm />
      {isPending && <p className="text-muted-foreground">Loading…</p>}
      <ErrorMessage error={error} />
      {users && (
        <ul className="divide-y rounded-lg border bg-card">
          {users.map((user) => (
            <UserRow key={user.id} user={user} isSelf={user.id === session?.user.id} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateUserForm() {
  const queryClient = useQueryClient();
  const roleId = useId();
  const [open, setOpen] = useState(false);
  const create = useMutation({
    mutationFn: (body: CreateUserRequest) =>
      apiRequest('POST', '/api/users', { body, schema: adminUserSchema }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: usersQuery.queryKey });
      setOpen(false);
    },
  });

  if (!open) return <Button onClick={() => setOpen(true)}>Add user</Button>;

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
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={onSubmit}>
        <FormField label="Name" name="name" required />
        <FormField label="Email" name="email" type="email" required />
        <div className="space-y-1.5">
          <Label htmlFor={roleId}>Role</Label>
          <Select id={roleId} name="role" defaultValue="technician">
            <option value="technician">Technician</option>
            <option value="admin">Administrator</option>
          </Select>
        </div>
        <FormField
          label="Initial password"
          name="password"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          autoComplete="new-password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. Share it with the user securely.`}
        />
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" disabled={create.isPending}>
            Create user
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <ErrorMessage error={create.error} />
        </div>
      </form>
    </Card>
  );
}

function UserRow({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
  const queryClient = useQueryClient();
  const [settingPassword, setSettingPassword] = useState(false);
  const update = useMutation({
    mutationFn: (body: UpdateUserRequest) =>
      apiRequest('PATCH', `/api/users/${user.id}`, { body, schema: adminUserSchema }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: usersQuery.queryKey }),
  });
  const setPassword = useMutation({
    mutationFn: (password: string) =>
      apiRequest('POST', `/api/users/${user.id}/password`, { body: { password } }),
    onSuccess: () => setSettingPassword(false),
  });

  function onPasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPassword.mutate(String(new FormData(event.currentTarget).get('password')));
  }

  const local = user.role !== 'end_user';

  return (
    <li className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <p className="font-medium">
            {user.name} {isSelf && <span className="text-muted-foreground">(you)</span>}
          </p>
          <p className="text-sm text-muted-foreground">{user.email}</p>
        </div>
        {user.disabled && <span className="text-sm text-destructive">Disabled</span>}
        {local && (
          <Select
            aria-label={`Role for ${user.name}`}
            className="w-40"
            value={user.role}
            disabled={update.isPending}
            onChange={(e) =>
              update.mutate({ role: e.target.value === 'admin' ? 'admin' : 'technician' })
            }
          >
            <option value="technician">Technician</option>
            <option value="admin">Administrator</option>
          </Select>
        )}
        {local && (
          <Button variant="outline" onClick={() => setSettingPassword((v) => !v)}>
            Set password
          </Button>
        )}
        <Button
          variant={user.disabled ? 'outline' : 'destructive'}
          disabled={update.isPending}
          onClick={() => update.mutate({ disabled: !user.disabled })}
        >
          {user.disabled ? 'Enable' : 'Disable'}
        </Button>
      </div>
      <ErrorMessage error={update.error} />
      {settingPassword && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={onPasswordSubmit}>
          <div className="min-w-64 flex-1">
            <FormField
              label={`New password for ${user.name}`}
              name="password"
              type="password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              autoComplete="new-password"
              hint="Signs them out everywhere and clears any lockout."
            />
          </div>
          <Button type="submit" disabled={setPassword.isPending}>
            Save
          </Button>
          <ErrorMessage error={setPassword.error} />
        </form>
      )}
    </li>
  );
}
