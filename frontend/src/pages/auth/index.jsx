import { useLocation } from 'react-router-dom';
import Login from './Login';
import Register from './Register';
import ForgotPassword from './ForgotPassword';
import ResetPassword from './ResetPassword';
import VerifyEmail from './VerifyEmail';
import Invite from './Invite';

/** One entry for every signed-out route; picks the page from the path. */
export default function Auth() {
  const { pathname } = useLocation();
  if (pathname.startsWith('/register')) return <Register />;
  if (pathname.startsWith('/forgot-password')) return <ForgotPassword />;
  if (pathname.startsWith('/reset-password')) return <ResetPassword />;
  if (pathname.startsWith('/verify-email')) return <VerifyEmail />;
  if (pathname.startsWith('/invite')) return <Invite />;
  return <Login />;
}
