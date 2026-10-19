import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, Outlet, createRoute, redirect, useNavigate } from '@tanstack/react-router';
import { Activity, BookOpen, KeyRound, Laptop, LogOut, Shapes, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Logo } from '@/components/logo';
import { ThemeSelect } from '@/components/theme-select';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import { sessionQuery, setupStatusQuery, storeSession } from '@/lib/queries';
import { roleLabels } from '@/lib/roles';
import { cn } from '@/lib/utils';
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

  return (
    <div className="flex min-h-screen flex-wrap">
      <nav
        aria-label="Main"
        className="flex flex-[1_1_232px] flex-col gap-1 border-r border-line bg-surface-sunken px-3 py-4"
      >
        <div className="px-2 pt-2 pb-6">
          <Logo />
        </div>
        <NavLink to="/" icon={<Activity strokeWidth={1.75} />}>
          Status
        </NavLink>
        <NavLink to="/assets" exact={false} icon={<Laptop strokeWidth={1.75} />}>
          Assets
        </NavLink>
        <NavLink to="/asset-types" exact={false} icon={<Shapes strokeWidth={1.75} />}>
          Asset types
        </NavLink>
        {session.user.role === 'admin' && (
          <>
            <NavLink to="/admin/users" icon={<Users strokeWidth={1.75} />}>
              Users
            </NavLink>
            <NavLink to="/admin/service-accounts" icon={<KeyRound strokeWidth={1.75} />}>
              Service accounts
            </NavLink>
          </>
        )}
        <a href="/api/docs" className={navLinkClasses}>
          <span aria-hidden="true" className="contents">
            <BookOpen strokeWidth={1.75} />
          </span>
          API reference
        </a>
        <div className="mt-auto flex flex-col gap-4 border-t border-line px-3 pt-4">
          <div>
            <p className="m-0 type-label">{session.user.name}</p>
            <p className="m-0 type-caption text-ink-muted">{roleLabels[session.user.role]}</p>
          </div>
          <ThemeSelect />
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            <LogOut aria-hidden="true" strokeWidth={1.75} />
            Sign out
          </Button>
        </div>
      </nav>
      <main className="flex min-w-0 flex-[999_1_640px] flex-col gap-6 p-8">
        <Outlet />
      </main>
    </div>
  );
}

const navLinkClasses = cn(
  'flex min-h-10 items-center gap-3 rounded-md px-3 text-ink no-underline',
  'hover:bg-surface-raised hover:text-ink [&_svg]:size-5 [&_svg]:shrink-0',
  'aria-[current=page]:bg-pine-soft aria-[current=page]:font-semibold aria-[current=page]:text-pine',
);

/** A sidebar link; `exact={false}` keeps it selected on the pages below it. */
function NavLink({
  to,
  exact = true,
  icon,
  children,
}: {
  to: '/' | '/assets' | '/asset-types' | '/admin/users' | '/admin/service-accounts';
  exact?: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link to={to} activeOptions={{ exact, includeSearch: false }} className={navLinkClasses}>
      <span aria-hidden="true" className="contents">
        {icon}
      </span>
      {children}
    </Link>
  );
}
