import { useLocation } from 'react-router-dom';
import { ComingSoon } from '@/components/app';
import { AuthLayout } from './AuthLayout';
import Login from './Login';
import Register from './Register';

/**
 * One entry for every signed-out route. Login and Register are real; the other four are stubs
 * (forgot-password, reset-password/:token, verify-email/:token, invite/:token) for the auth owner.
 */
export default function Auth() {
  const { pathname } = useLocation();
  if (pathname === '/login') return <Login />;
  if (pathname === '/register') return <Register />;
  const stubs = {
    '/forgot-password': 'Reset your password',
    '/reset-password': 'Choose a new password',
    '/verify-email': 'Verify your email',
    '/invite': 'Join your team',
  };
  const key = Object.keys(stubs).find((p) => pathname.startsWith(p));
  return (
    <AuthLayout title={stubs[key] || 'Welcome'}>
      <ComingSoon title="Coming soon" description="This step is not available yet." />
    </AuthLayout>
  );
}
