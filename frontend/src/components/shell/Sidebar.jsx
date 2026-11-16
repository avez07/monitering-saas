import { NavLink } from 'react-router-dom';
import { Activity, Bell, Container, Plug, ScrollText, Waypoints, Globe, LayoutDashboard, Layers, Server, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Logo } from './Logo';

export const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/servers', label: 'Servers', icon: Server },
  { to: '/containers', label: 'Containers', icon: Container },
  { to: '/services', label: 'Services', icon: Layers },
  { to: '/websites', label: 'Websites & APIs', icon: Globe },
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export const NAV_APPS = [
  { to: '/apps', label: 'App services', icon: Activity, end: true },
  { to: '/apps/traces', label: 'Traces', icon: Waypoints },
  { to: '/apps/logs', label: 'Logs', icon: ScrollText },
  { to: '/apps/connect', label: 'Connect your app', icon: Plug },
];

/** Navigation list, shared by the desktop sidebar and the mobile drawer. */
function NavItems({ items, onNavigate }) {
  return items.map(({ to, label, icon: Icon, end }) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-sidebar-foreground transition-colors',
          'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
          isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
        )
      }
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      {label}
    </NavLink>
  ));
}

export function SidebarNav({ onNavigate }) {
  const [first, ...rest] = [NAV.slice(0, 5), NAV.slice(5)];
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 px-3">
      <NavItems items={first} onNavigate={onNavigate} />
      <p id="nav-apps" className="mt-4 px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Apps
      </p>
      <div role="group" aria-labelledby="nav-apps" className="flex flex-col gap-1">
        <NavItems items={NAV_APPS} onNavigate={onNavigate} />
      </div>
      <div className="mt-4 flex flex-col gap-1">
        <NavItems items={rest[0]} onNavigate={onNavigate} />
      </div>
    </nav>
  );
}

export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
      <div className="flex h-14 items-center px-6">
        <Logo />
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        <SidebarNav />
      </div>
    </aside>
  );
}
