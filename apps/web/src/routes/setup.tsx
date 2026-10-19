import { PASSWORD_MIN_LENGTH, sessionResponseSchema } from '@open-itsm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { apiRequest } from '@/lib/api';
import { setupStatusQuery, storeSession } from '@/lib/queries';
import { rootRoute } from './root';

export const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery({ ...setupStatusQuery, staleTime: 0 });
    if (!status.required) throw redirect({ to: '/login', search: { redirect: undefined } });
  },
  component: SetupPage,
});

function SetupPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mismatch, setMismatch] = useState(false);

  const setup = useMutation({
    mutationFn: (body: { token: string; name: string; email: string; password: string }) =>
      apiRequest('POST', '/api/setup', { body, schema: sessionResponseSchema }),
    onSuccess: async (session) => {
      queryClient.setQueryData(setupStatusQuery.queryKey, { required: false });
      storeSession(queryClient, session);
      await navigate({ to: '/' });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password'));
    if (password !== String(form.get('confirm'))) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setup.mutate({
      token: String(form.get('token')),
      name: String(form.get('name')),
      email: String(form.get('email')),
      password,
    });
  }

  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <Card className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Set up Open ITSM</h1>
          <p className="text-sm text-muted-foreground">
            Create the first administrator. The setup token is printed in the app container&apos;s
            log: run <code className="rounded bg-muted px-1">docker compose logs app</code> on the
            server.
          </p>
        </div>
        <form className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label="Setup token"
            name="token"
            required
            autoComplete="off"
            spellCheck={false}
          />
          <FormField label="Your name" name="name" required autoComplete="name" />
          <FormField label="Email" name="email" type="email" required autoComplete="email" />
          <FormField
            label="Password"
            name="password"
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          />
          <FormField
            label="Confirm password"
            name="confirm"
            type="password"
            required
            autoComplete="new-password"
          />
          {mismatch && <ErrorMessage error="The passwords do not match" />}
          <ErrorMessage error={setup.error} />
          <Button type="submit" className="w-full" disabled={setup.isPending}>
            {setup.isPending ? 'Creating…' : 'Create administrator'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
