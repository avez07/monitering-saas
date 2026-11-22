import { lazy } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { AppShell } from '@/components/shell/AppShell';
import { AdminShell } from '@/components/shell/AdminShell';
import { SuspendedNotice } from '@/components/shell/SuspendedNotice';
import { ErrorState, LoadingState } from '@/components/app/states';
import { useSession } from '@/lib/session';

/**
 * ROUTE TABLE (owned by the frontend foundation). Every page folder exports `default` from
 * its index.jsx and handles its own sub-routes (`/servers/*` etc. use nested <Routes>).
 * To add a page, add a lazy import and one entry below.
 */
const Auth = lazy(() => import('@/pages/auth'));
const Overview = lazy(() => import('@/pages/overview'));
const Servers = lazy(() => import('@/pages/servers'));
const Containers = lazy(() => import('@/pages/containers'));
const Dashboards = lazy(() => import('@/pages/dashboards'));
const Services = lazy(() => import('@/pages/services'));
const Websites = lazy(() => import('@/pages/websites'));
const Alerts = lazy(() => import('@/pages/alerts'));
const Settings = lazy(() => import('@/pages/settings'));
const Apps = lazy(() => import('@/pages/apps'));
const AddServer = lazy(() => import('@/pages/add-server'));
const Admin = lazy(() => import('@/pages/admin'));

/** Signed-out only (login, register, forgot password): signed-in users go to the dashboard. */
function GuestOnly() {
  const { status } = useSession();
  if (status === 'checking') return <LoadingState fullScreen />;
  if (status === 'in') return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Signed-in only: sends everybody else to /login. */
function RequireAuth() {
  const { status, ready, bootError } = useSession();
  if (status === 'checking') return <LoadingState fullScreen />;
  if (status === 'out') return <Navigate to="/login" replace />;
  if (bootError)
    return (
      <ErrorState
        title="We couldn't load your account"
        error={bootError}
        onRetry={() => window.location.reload()}
      />
    );
  if (!ready) return <LoadingState fullScreen />;
  return <Outlet />;
}

/** Yukti staff only (platform admin): everyone else goes back to the dashboard. */
function RequirePlatformAdmin() {
  const { isPlatformAdmin } = useSession();
  if (!isPlatformAdmin) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** The customer app needs an organization that is not suspended (staff without one go to /admin). */
function RequireActiveOrg() {
  const { organization, isPlatformAdmin, suspended } = useSession();
  if (!organization && isPlatformAdmin) return <Navigate to="/admin" replace />;
  if (suspended) return <SuspendedNotice />;
  return <Outlet />;
}

export const routes = [
  {
    element: <GuestOnly />,
    children: [
      { path: '/login', element: <Auth /> },
      { path: '/register', element: <Auth /> },
      { path: '/forgot-password', element: <Auth /> },
    ],
  },
  // Token links work whether or not you are signed in.
  { path: '/reset-password', element: <Auth /> },
  { path: '/verify-email', element: <Auth /> },
  { path: '/reset-password/:token', element: <Auth /> },
  { path: '/verify-email/:token', element: <Auth /> },
  { path: '/invite/:token', element: <Auth /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <RequirePlatformAdmin />,
        children: [
          { element: <AdminShell />, children: [{ path: '/admin/*', element: <Admin /> }] },
        ],
      },
      {
        element: <RequireActiveOrg />,
        children: [
          {
            element: <AppShell />,
            children: [
              { path: '/', element: <Overview /> },
              { path: '/servers/*', element: <Servers /> },
              { path: '/containers/*', element: <Containers /> },
              { path: '/dashboards/*', element: <Dashboards /> },
              { path: '/services/*', element: <Services /> },
              { path: '/websites/*', element: <Websites /> },
              { path: '/apps/*', element: <Apps /> },
              { path: '/alerts/*', element: <Alerts /> },
              { path: '/settings/*', element: <Settings /> },
              { path: '/add-server', element: <AddServer /> },
              { path: '*', element: <Navigate to="/" replace /> },
            ],
          },
        ],
      },
    ],
  },
];
