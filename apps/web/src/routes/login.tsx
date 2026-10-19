import { sessionResponseSchema } from '@open-itsm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createRoute, redirect, useNavigate } from '@tanstack/react-router';
import type { FormEvent } from 'react';
import { z } from 'zod';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { apiRequest } from '@/lib/api';
import { sessionQuery, setupStatusQuery, storeSession } from '@/lib/queries';
import { rootRoute } from './root';

/** Only same-site paths are followed after sign-in, never another origin. */
function safeRedirect(target: string | undefined): string {
  return target && target.startsWith('/') && !target.startsWith('//') ? target : '/';
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: async ({ context, search }) => {
    const setup = await context.queryClient.ensureQueryData(setupStatusQuery);
    if (setup.required) throw redirect({ to: '/setup' });
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (session) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: LoginPage,
});

function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = loginRoute.useSearch();

  const login = useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      apiRequest('POST', '/api/auth/login', { body, schema: sessionResponseSchema }),
    onSuccess: async (session) => {
      storeSession(queryClient, session);
      await navigate({ href: safeRedirect(search.redirect) });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    login.mutate({ email: String(form.get('email')), password: String(form.get('password')) });
  }

  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <Card className="space-y-6">
        <h1 className="text-xl font-semibold">Sign in to Open ITSM</h1>
        <form className="space-y-4" onSubmit={onSubmit}>
          <FormField label="Email" name="email" type="email" required autoComplete="username" />
          <FormField
            label="Password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
          />
          <ErrorMessage error={login.error} />
          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
