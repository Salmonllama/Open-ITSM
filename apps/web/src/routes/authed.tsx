import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, Outlet, createRoute, redirect, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import { sessionQuery, setupStatusQuery, storeSession } from '@/lib/queries';
import { rootRoute } from './root';

/** Layout for every signed-in page; sends visitors to setup or login first. */
export const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  beforeLoad: async ({ context, location }) => {
    const setup = await context.queryClient.ensureQueryData(setupStatusQuery);
    if (setup.required) throw redirect({ to: '/setup' });
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (!session) throw redirect({ to: '/login', search: { redirect: location.href } });
    return { session };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { data: session } = useSuspenseQuery(sessionQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => apiRequest('POST', '/api/auth/logout'),
    onSettled: async () => {
      storeSession(queryClient, null);
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      await navigate({ to: '/login', search: { redirect: undefined } });
    },
  });

  if (!session) return null;
  const linkClass = 'rounded-md px-3 py-1.5 text-sm hover:bg-muted';
  const activeClass = 'bg-muted font-medium';

  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <span className="mr-4 font-semibold">Open ITSM</span>
        <nav className="flex gap-1">
          <Link to="/" className={linkClass} activeProps={{ className: activeClass }}>
            Status
          </Link>
          {session.user.role === 'admin' && (
            <Link to="/admin/users" className={linkClass} activeProps={{ className: activeClass }}>
              Users
            </Link>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {session.user.name} · {session.user.role}
          </span>
          <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
