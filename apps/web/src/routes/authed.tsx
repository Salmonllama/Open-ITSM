import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, Outlet, createRoute, redirect, useNavigate } from '@tanstack/react-router';
import {
  Activity,
  BookOpen,
  Inbox,
  KeyRound,
  Laptop,
  LogOut,
  Menu,
  Package,
  ScanLine,
  Shapes,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Logo } from '@/components/logo';
import { ThemeSelect } from '@/components/theme-select';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import {
  lowStockQuery,
  sessionQuery,
  setupStatusQuery,
  storeSession,
  ticketCountsQuery,
} from '@/lib/queries';
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

  const lowStock = useQuery({ ...lowStockQuery, enabled: !!session });
  const ticketCounts = useQuery({ ...ticketCountsQuery, enabled: !!session });

  if (!session) return null;

  const nav = (onNavigate?: () => void) => (
    <>
      <NavLink to="/" icon={<Activity strokeWidth={1.75} />} onNavigate={onNavigate}>
        Status
      </NavLink>
      <NavLink
        to="/tickets"
        exact={false}
        icon={<Inbox strokeWidth={1.75} />}
        onNavigate={onNavigate}
      >
        <span className="flex-1">Tickets</span>
        {ticketCounts.data && ticketCounts.data.open > 0 && (
          <span className="type-caption text-ink-muted">{ticketCounts.data.open} open</span>
        )}
      </NavLink>
      <NavLink
        to="/assets"
        exact={false}
        icon={<Laptop strokeWidth={1.75} />}
        onNavigate={onNavigate}
      >
        Assets
      </NavLink>
      <NavLink to="/scan" icon={<ScanLine strokeWidth={1.75} />} onNavigate={onNavigate}>
        Scan
      </NavLink>
      <NavLink
        to="/asset-types"
        exact={false}
        icon={<Shapes strokeWidth={1.75} />}
        onNavigate={onNavigate}
      >
        Asset types
      </NavLink>
      <NavLink
        to="/consumables"
        exact={false}
        icon={<Package strokeWidth={1.75} />}
        onNavigate={onNavigate}
      >
        <span className="flex-1">Consumables</span>
        {lowStock.data && lowStock.data.count > 0 && (
          <span className="type-caption text-warning">{lowStock.data.count} low</span>
        )}
      </NavLink>
      {session.user.role === 'admin' && (
        <>
          <NavLink to="/admin/users" icon={<Users strokeWidth={1.75} />} onNavigate={onNavigate}>
            Users
          </NavLink>
          <NavLink
            to="/admin/service-accounts"
            icon={<KeyRound strokeWidth={1.75} />}
            onNavigate={onNavigate}
          >
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
    </>
  );

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <PhoneMenu>{nav}</PhoneMenu>
      <nav
        aria-label="Main"
        className="hidden w-58 shrink-0 flex-col gap-1 border-r border-line bg-surface-sunken px-3 py-4 md:flex print:hidden"
      >
        <div className="px-2 pt-2 pb-6">
          <Logo />
        </div>
        {nav()}
      </nav>
      <main className="flex min-w-0 flex-1 flex-col gap-6 p-4 md:p-8 print:block print:p-0">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * Below 768px the sidebar becomes a top bar with a menu button that opens the same links in a
 * drawer from the left. The drawer is a native modal <dialog>, so focus is trapped and Escape
 * closes it; tapping outside it or choosing a link closes it too.
 */
function PhoneMenu({ children }: { children: (onNavigate: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Close it if the window grows past the phone layout while it is open.
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 48rem)');
    const close = () => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener('change', close);
    return () => wide.removeEventListener('change', close);
  }, []);

  function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) setOpen(false);
  }

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-line bg-surface-sunken px-2 md:hidden print:hidden">
      <Button
        variant="ghost"
        className="size-10 px-0 text-ink [&_svg]:size-5"
        aria-label="Open menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Menu aria-hidden="true" strokeWidth={1.75} />
      </Button>
      <Logo />
      <dialog
        ref={ref}
        aria-label="Menu"
        onClose={() => setOpen(false)}
        onClick={closeOnBackdrop}
        className="drawer m-0 h-dvh max-h-none w-[min(18rem,85vw)] max-w-none border-0 border-r border-line bg-surface-sunken p-0 text-ink shadow-overlay backdrop:bg-ink/40"
      >
        <nav aria-label="Main" className="flex min-h-full flex-col gap-1 px-3 py-4">
          <div className="flex items-center justify-between pb-4 pl-2">
            <Logo />
            <Button
              variant="ghost"
              className="size-10 px-0 text-ink [&_svg]:size-5"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
            >
              <X aria-hidden="true" strokeWidth={1.75} />
            </Button>
          </div>
          {open && children(() => setOpen(false))}
        </nav>
      </dialog>
    </header>
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
  onNavigate,
  children,
}: {
  to:
    | '/'
    | '/tickets'
    | '/assets'
    | '/scan'
    | '/asset-types'
    | '/consumables'
    | '/admin/users'
    | '/admin/service-accounts';
  exact?: boolean;
  icon: ReactNode;
  onNavigate?: () => void;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact, includeSearch: false }}
      className={navLinkClasses}
      onClick={onNavigate}
    >
      <span aria-hidden="true" className="contents">
        {icon}
      </span>
      {children}
    </Link>
  );
}
