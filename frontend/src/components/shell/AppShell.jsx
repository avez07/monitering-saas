import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { LoadingState } from '@/components/app/states';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { VerifyBanner } from './VerifyBanner';

/** Signed-in layout: sidebar (drawer on phones), top bar and the routed page. */
export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="lg:pl-64">
        <Topbar />
        <VerifyBanner />
        <main id="main" className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
          <Suspense key={pathname.split('/')[1]} fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
