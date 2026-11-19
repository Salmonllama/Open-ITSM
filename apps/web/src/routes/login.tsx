import { emailLinkResponseSchema, sessionResponseSchema } from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { AuthLayout } from '@/components/auth-layout';
import { FormField } from '@/components/form-field';
import { Button, buttonClasses } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/card';
import { apiRequest } from '@/lib/api';
import { authMethodsQuery, sessionQuery, setupStatusQuery, storeSession } from '@/lib/queries';
import { rootRoute } from './root';

/** Only same-site paths are followed after sign-in, never another origin. */
function safeRedirect(target: string | undefined): string {
  return target && target.startsWith('/') && !target.startsWith('//') ? target : '/';
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: z.object({
    redirect: z.string().optional(),
    ssoError: z.string().optional(),
  }),
  beforeLoad: async ({ context, search }) => {
    const setup = await context.queryClient.ensureQueryData(setupStatusQuery);
    if (setup.required) throw redirect({ to: '/setup' });
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (session) {
      if (session.user.role === 'end_user') throw redirect({ to: '/portal' });
      throw redirect({ href: safeRedirect(search.redirect) });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = loginRoute.useSearch();
  const methods = useQuery(authMethodsQuery);
  const [linkOpen, setLinkOpen] = useState(false);

  const login = useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      apiRequest('POST', '/api/auth/login', { body, schema: sessionResponseSchema }),
    onSuccess: async (session) => {
      storeSession(queryClient, session);
      if (session.user.role === 'end_user') {
        await navigate({ to: '/portal' });
      } else {
        await navigate({ href: safeRedirect(search.redirect) });
      }
    },
  });

  const emailLink = useMutation({
    mutationFn: (email: string) =>
      apiRequest('POST', '/api/auth/email-link', {
        body: { email },
        schema: emailLinkResponseSchema,
      }),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    login.mutate({ email: String(form.get('email')), password: String(form.get('password')) });
  }

  function onEmailLinkSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    emailLink.mutate(String(form.get('linkEmail')));
  }

  const entraHref = search.redirect
    ? `/api/auth/entra/start?${new URLSearchParams({ redirect: safeRedirect(search.redirect) })}`
    : '/api/auth/entra/start';

  return (
    <AuthLayout title="Sign in">
      <div className="flex flex-col gap-4">
        {search.ssoError && <ErrorMessage error={search.ssoError} />}
        {methods.data?.entra.enabled && (
          <>
            <a href={entraHref} className={buttonClasses('secondary', 'md') + ' w-full'}>
              Sign in with Microsoft
            </a>
            <div className="flex items-center gap-3 type-caption text-ink-muted">
              <span className="h-px flex-1 bg-line" />
              <span>or sign in with a local account</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          </>
        )}
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <FormField label="Email" name="email" type="email" required autoComplete="username" />
          <FormField
            label="Password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
          />
          <ErrorMessage error={login.error} />
          <Button type="submit" variant="primary" className="w-full" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        {methods.data?.emailLink.enabled && (
          <div className="border-t border-line pt-4">
            {!linkOpen ? (
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => setLinkOpen(true)}
              >
                Viewing your own tickets? Email me a sign-in link
              </Button>
            ) : (
              <form className="flex flex-col gap-3" onSubmit={onEmailLinkSubmit}>
                <FormField
                  label="Your email address"
                  name="linkEmail"
                  type="email"
                  required
                  autoComplete="email"
                  hint="A one-time link will be emailed to you to view your open tickets."
                />
                <ErrorMessage error={emailLink.error} />
                {emailLink.data && (
                  <p role="status" className="m-0 type-caption text-success">
                    {emailLink.data.message}
                  </p>
                )}
                <Button type="submit" className="w-full" disabled={emailLink.isPending}>
                  {emailLink.isPending ? 'Sending link…' : 'Send sign-in link'}
                </Button>
              </form>
            )}
          </div>
        )}
      </div>
    </AuthLayout>
  );
}
