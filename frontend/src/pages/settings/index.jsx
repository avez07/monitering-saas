import { Navigate, Route, Routes } from 'react-router-dom';
import { ComingSoon } from '@/components/app';

// STUB: the settings owner replaces this folder. Required routes: team, api-key, plan, account.
export default function Settings() {
  return (
    <Routes>
      <Route index element={<Navigate to="team" replace />} />
      <Route
        path="team"
        element={<ComingSoon title="Team" description="People who can access this organization." />}
      />
      <Route
        path="api-key"
        element={<ComingSoon title="API key" description="The key your servers use to connect." />}
      />
      <Route
        path="plan"
        element={<ComingSoon title="Plan & billing" description="Your plan and usage." />}
      />
      <Route
        path="account"
        element={<ComingSoon title="Account" description="Your profile and password." />}
      />
      <Route path="*" element={<Navigate to="team" replace />} />
    </Routes>
  );
}
