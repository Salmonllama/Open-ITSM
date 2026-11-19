import { sessionResponseSchema } from '@open-itsm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { AuthLayout } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/card';
import { apiRequest } from '@/lib/api';
import { sessionQuery, setupStatusQuery, storeSession } from '@/lib/queries';
import { rootRoute } from './root';

export const loginLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login/link',
  validateSearch: z.object({ token: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const setup = await context.queryClient.ensureQueryData(setupStatusQuery);
    if (setup.required) throw redirect({ to: '/setup' });
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (session) {
      throw redirect({ to: session.user.role === 'end_user' ? '/portal' : '/' });
    }
  },
  component: LoginLinkPage,
});

/**
 * Redeems the emailed one-time token on explicit button click (POST) so email link scanners
 * prefetching the URL do not consume the token before the requester arrives.
 */
function LoginLinkPage() {
  const { token } = loginLinkRoute.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const redeem = useMutation({
    mutationFn: (value: string) =>
      apiRequest('POST', '/api/auth/email-link/redeem', {
        body: { token: value },
        schema: sessionResponseSchema,
      }),
    onSuccess: async (session) => {
      storeSession(queryClient, session);
      await navigate({ to: '/portal' });
    },
  });

  if (!token) {
    return (
      <AuthLayout title="Sign-in link">
        <div className="flex flex-col gap-4">
          <ErrorMessage error="This sign-in link is missing its token. Request a new link from the sign-in page." />
          <Link
            to="/login"
            search={{ redirect: undefined, ssoError: undefined }}
            className="type-label"
          >
            Back to sign in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Sign in to your tickets">
      <div className="flex flex-col gap-4">
        <p className="m-0 text-ink-muted">
          Continue to view and reply to your open support tickets. This link works once.
        </p>
        <ErrorMessage error={redeem.error} />
        <Button
          variant="primary"
          className="w-full"
          disabled={redeem.isPending}
          onClick={() => redeem.mutate(token)}
        >
          {redeem.isPending ? 'Signing in…' : 'Continue to your tickets'}
        </Button>
        <Link
          to="/login"
          search={{ redirect: undefined, ssoError: undefined }}
          className="type-caption text-ink-muted"
        >
          Back to sign in
        </Link>
      </div>
    </AuthLayout>
  );
}
