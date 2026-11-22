import { NavLink } from 'react-router-dom';
import {
  Activity,
  Bell,
  Container,
  Globe,
  Layers,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  ScrollText,
  Server,
  Settings,
  Waypoints,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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

const MAIN = NAV.slice(0, 5);
const SETTINGS = NAV.slice(5);

/** One nav link. Collapsed: icon only with a tooltip. Labels fade out instead of wrapping. */
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
              'absolute left-0 top-2.5 h-5 w-[3px] origin-center rounded-r-full bg-primary transition-[transform,opacity] duration-200',
              isActive ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0',
            )}
          />
          <Icon className={cn('size-[18px] shrink-0', isActive && 'text-primary')} aria-hidden="true" />
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

function SectionLabel({ id, collapsed, children }) {
  return collapsed ? (
    <div role="separator" className="mx-3 my-3 h-px bg-sidebar-border" />
  ) : (
    <p id={id} className="mt-4 px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/60">
      {children}
    </p>
  );
}

/** Navigation list shared by the desktop sidebar and the mobile sheet. */
export function SidebarNav({ collapsed = false, onNavigate }) {
  const props = { collapsed, onNavigate };
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {MAIN.map((i) => (
        <NavItem key={i.to} {...i} {...props} />
      ))}
      <SectionLabel id="nav-apps" collapsed={collapsed}>
        Apps
      </SectionLabel>
      <div role="group" aria-labelledby={collapsed ? undefined : 'nav-apps'} aria-label={collapsed ? 'Apps' : undefined} className="flex flex-col gap-1">
        {NAV_APPS.map((i) => (
          <NavItem key={i.to} {...i} {...props} />
        ))}
      </div>
    </nav>
  );
}

/** Bottom block: settings link. (Theme and account menu live in the top bar.) */
function SidebarFooter({ collapsed, onNavigate }) {
  return (
    <div className="flex flex-col gap-1 border-t border-sidebar-border px-3 py-3">
      {SETTINGS.map((i) => (
        <NavItem key={i.to} {...i} collapsed={collapsed} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

/** Contents of the sidebar (logo, nav, footer). Used inside the desktop aside and the mobile sheet. */
export function SidebarContent({ collapsed = false, onToggle, onNavigate }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center px-3">
        <NavLink
          to="/"
          onClick={onNavigate}
          aria-label="YuktiOps home"
          className="flex h-10 items-center overflow-hidden rounded-xl px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <Logo compact={collapsed} />
        </NavLink>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-2">
        <SidebarNav collapsed={collapsed} onNavigate={onNavigate} />
      </div>
      {onToggle && (
        <div className="px-3 pb-2">
          <Tooltip>
            <TooltipTrigger asChild>
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
                <span className={cn('truncate transition-opacity duration-200', collapsed && 'opacity-0')}>Collapse</span>
              </button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" sideOffset={12}>
                Expand sidebar
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      )}
      <SidebarFooter collapsed={collapsed} onNavigate={onNavigate} />
    </div>
  );
}

/** Desktop sidebar: 256px with labels, collapses to a 72px icon rail with a width transition. */
export function Sidebar({ collapsed, onToggle }) {
  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        'fixed inset-y-0 left-0 z-40 hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out lg:block',
        collapsed ? 'w-[4.5rem]' : 'w-64',
      )}
    >
      <SidebarContent collapsed={collapsed} onToggle={onToggle} />
    </aside>
  );
}
