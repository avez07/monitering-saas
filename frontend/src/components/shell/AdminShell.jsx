import { Suspense, useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ArrowLeft,
  Building2,
  LayoutDashboard,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { LoadingState } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

const KEY = 'yuktiops.admin-sidebar'; // 'collapsed' | 'expanded'

export const ADMIN_NAV = [
  { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/admin/orgs', label: 'Organizations', icon: Building2 },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
];

function readCollapsed() {
  try {
    return localStorage.getItem(KEY) === 'collapsed';
  } catch {
    return false;
  }
}

/** "Yukti Admin" pill: always visible so staff never mistake the admin for a customer's dashboard. */
export function AdminBadge({ compact = false, className }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-primary',
        className,
      )}
    >
      <ShieldCheck className="size-3" aria-hidden="true" />
      {compact ? <span className="sr-only">Yukti Admin</span> : 'Yukti Admin'}
    </span>
  );
}

function NavItem({ to, label, icon: Icon, end, collapsed, onNavigate }) {
  const link = (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex h-10 items-center gap-3 overflow-hidden rounded-xl px-3 text-sm font-medium text-sidebar-foreground transition-colors duration-200',
          'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
          isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={cn(
              'absolute left-0 top-2.5 h-5 w-[3px] rounded-r-full bg-primary transition-[transform,opacity] duration-200',
              isActive ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0',
            )}
          />
          <Icon
            className={cn('size-[18px] shrink-0', isActive && 'text-primary')}
            aria-hidden="true"
          />
          <span
            className={cn(
              'truncate transition-opacity duration-200',
              collapsed ? 'pointer-events-none opacity-0' : 'opacity-100',
            )}
          >
            {label}
          </span>
        </>
      )}
    </NavLink>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={12}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function AdminSidebarContent({ collapsed = false, onToggle, onNavigate }) {
  const { organization } = useSession();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <NavLink
          to="/admin"
          onClick={onNavigate}
          aria-label="Yukti Admin home"
          className="flex h-10 items-center overflow-hidden rounded-xl px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <Logo compact={collapsed} />
        </NavLink>
      </div>
      <div className="px-3 pb-2">
        <AdminBadge compact={collapsed} className={collapsed ? 'mx-auto flex w-fit px-1.5' : ''} />
      </div>
      <nav
        aria-label="Admin"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-3 py-2"
      >
        {ADMIN_NAV.map((item) => (
          <NavItem key={item.to} {...item} collapsed={collapsed} onNavigate={onNavigate} />
        ))}
      </nav>
      {onToggle && (
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            className="flex h-9 w-full items-center gap-3 overflow-hidden rounded-xl px-3 text-xs font-medium text-sidebar-foreground/80 transition-colors duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-[18px] shrink-0" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="size-[18px] shrink-0" aria-hidden="true" />
            )}
            <span
              className={cn('truncate transition-opacity duration-200', collapsed && 'opacity-0')}
            >
              Collapse
            </span>
          </button>
        </div>
      )}
      {organization && (
        <div className="border-t border-sidebar-border px-3 py-3">
          <NavItem
            to="/"
            label="Back to dashboard"
            icon={ArrowLeft}
            end
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        </div>
      )}
    </div>
  );
}

/** Layout for /admin/*: same theme tokens and collapsible sidebar as the app, with its own nav. */
export function AdminShell() {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(KEY, c ? 'expanded' : 'collapsed');
      } catch {
        /* storage unavailable */
      }
      return !c;
    });
  }, []);
  useEffect(() => setMobileOpen(false), [pathname]);
  const section = ADMIN_NAV.filter((i) =>
    i.end ? pathname === i.to : pathname.startsWith(i.to),
  ).at(-1);

  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-xl focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <aside
        data-collapsed={collapsed}
        className={cn(
          'fixed inset-y-0 left-0 z-40 hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out lg:block',
          collapsed ? 'w-[4.5rem]' : 'w-64',
        )}
      >
        <AdminSidebarContent collapsed={collapsed} onToggle={toggle} />
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="w-72 max-w-[85vw] border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-xs lg:hidden"
        >
          <SheetTitle className="sr-only">Admin navigation</SheetTitle>
          <SheetDescription className="sr-only">Yukti Admin navigation</SheetDescription>
          <AdminSidebarContent onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <div
        className={cn(
          'transition-[padding] duration-200 ease-out',
          collapsed ? 'lg:pl-[4.5rem]' : 'lg:pl-64',
        )}
      >
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border/70 bg-background/80 px-4 backdrop-blur-md sm:px-6 lg:px-8">
          <Button
            variant="ghost"
            size="icon"
            className="-ml-2 lg:hidden"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-5" aria-hidden="true" />
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
            <AdminBadge className="lg:hidden" />
            <span className="truncate font-medium">{section?.label ?? 'Yukti Admin'}</span>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main id="main" className="w-full px-4 pb-10 pt-6 sm:px-6 lg:px-8 lg:pt-8 2xl:px-10">
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
