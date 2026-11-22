import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, Menu, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { NAV, NAV_APPS } from './Sidebar';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

export { UserMenu };

const ALL = [...NAV, ...NAV_APPS, { to: '/add-server', label: 'Add server' }];

/** Breadcrumb trail for the current path: the matching section, then "Details" for deeper pages. */
function useCrumbs() {
  const { pathname } = useLocation();
  return useMemo(() => {
    const match = ALL.filter((i) =>
      i.to === '/' ? pathname === '/' : pathname === i.to || pathname.startsWith(`${i.to}/`),
    ).sort((a, b) => b.to.length - a.to.length)[0];
    if (!match) return [{ label: 'YuktiOps' }];
    const deeper = match.to !== '/' && pathname.replace(/\/$/, '') !== match.to;
    return deeper ? [{ label: match.label, to: match.to }, { label: 'Details' }] : [{ label: match.label }];
  }, [pathname]);
}

/** Command palette: jump to any page. Opens with Ctrl/Cmd+K. */
function CommandMenu({ open, onOpenChange }) {
  const navigate = useNavigate();
  const go = (to) => {
    onOpenChange(false);
    navigate(to);
  };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search pages and actions..." />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Go to">
          {[...NAV, ...NAV_APPS].map(({ to, label, icon: Icon }) => (
            <CommandItem key={to} value={label} onSelect={() => go(to)}>
              <Icon className="mr-2 size-4" aria-hidden="true" /> {label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Actions">
          <CommandItem value="Add server" onSelect={() => go('/add-server')}>
            <Plus className="mr-2 size-4" aria-hidden="true" /> Add server
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/** `onOpenMenu` opens the off-canvas navigation sheet (phones/tablets). */
export function Topbar({ onOpenMenu }) {
  const crumbs = useCrumbs();
  const [cmdOpen, setCmdOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border/70 bg-background/80 px-4 backdrop-blur-md sm:px-6 lg:px-8">
      <Button variant="ghost" size="icon" className="-ml-2 lg:hidden" aria-label="Open menu" onClick={onOpenMenu}>
        <Menu className="size-5" aria-hidden="true" />
      </Button>
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => (
          <span key={c.label} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
            {c.to ? (
              <Link to={c.to} className="truncate text-muted-foreground transition-colors hover:text-foreground">
                {c.label}
              </Link>
            ) : (
              <span className="truncate font-medium text-foreground" aria-current="page">
                {c.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      <button
        type="button"
        onClick={() => setCmdOpen(true)}
        aria-label="Search"
        className="hidden h-9 w-64 items-center gap-2 rounded-xl border border-input bg-card px-3 text-[13px] text-muted-foreground transition-colors duration-150 hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex"
      >
        <Search className="size-3.5" aria-hidden="true" />
        <span className="flex-1 text-left">Search...</span>
        <kbd className="rounded-md border bg-muted px-1.5 font-mono text-[10px]">Ctrl K</kbd>
      </button>
      <Button variant="ghost" size="icon" className="sm:hidden" aria-label="Search" onClick={() => setCmdOpen(true)}>
        <Search className="size-[18px]" aria-hidden="true" />
      </Button>
      <CommandMenu open={cmdOpen} onOpenChange={setCmdOpen} />

      <Button asChild size="sm" className="shrink-0">
        <Link to="/add-server">
          <Plus className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Add server</span>
          <span className="sr-only sm:hidden">Add server</span>
        </Link>
      </Button>
      <div className="flex items-center gap-1">
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
