import { PASSWORD_MIN_LENGTH, sessionResponseSchema } from '@open-itsm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { AuthLayout } from '@/components/auth-layout';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/card';
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
    <AuthLayout
      title="Set up Open ITSM"
      width="max-w-md"
      intro={
        <>
          <p className="m-0 text-ink-muted">
            Create the first administrator account. The setup token is in the app&apos;s log. On the
            server, run:
          </p>
          <code className="block rounded-md bg-surface-sunken px-3 py-2 type-code">
            docker compose logs app
          </code>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <FormField
          label="Setup token"
          name="token"
          required
          mono
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
          error={mismatch ? 'The passwords do not match. Type the same password twice.' : undefined}
        />
        <ErrorMessage error={setup.error} />
        <Button type="submit" variant="primary" className="w-full" disabled={setup.isPending}>
          {setup.isPending ? 'Creating account…' : 'Create administrator'}
        </Button>
      </form>
    </AuthLayout>
  );
}
