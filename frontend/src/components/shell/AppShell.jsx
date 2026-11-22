import { Suspense, useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { LoadingState } from '@/components/app/states';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Sidebar, SidebarContent } from './Sidebar';
import { Topbar } from './Topbar';
import { VerifyBanner } from './VerifyBanner';

const KEY = 'yuktiops.sidebar'; // 'collapsed' | 'expanded'

function readCollapsed() {
  try {
    return localStorage.getItem(KEY) === 'collapsed';
  } catch {
    return false;
  }
}

/**
 * Signed-in layout: collapsible labelled sidebar (off-canvas sheet on phones), top bar and the
 * routed page. Content is full width; the shell applies the page padding once.
 */
export function AppShell() {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(KEY, c ? 'expanded' : 'collapsed');
      } catch {
        /* storage unavailable: the state just won't persist */
      }
      return !c;
    });
  }, []);

  useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-xl focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="w-72 max-w-[85vw] border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-xs lg:hidden"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
          <SidebarContent onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className={cn('transition-[padding] duration-200 ease-out', collapsed ? 'lg:pl-[4.5rem]' : 'lg:pl-64')}>
        <Topbar onOpenMenu={() => setMobileOpen(true)} />
        <VerifyBanner />
        <main id="main" className="w-full px-4 pb-10 pt-6 sm:px-6 lg:px-8 lg:pt-8 2xl:px-10">
          <Suspense key={pathname.split('/')[1]} fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
