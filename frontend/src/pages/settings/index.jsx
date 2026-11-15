import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { CreditCard, KeyRound, User, Users } from 'lucide-react';
import { PageHeader } from '@/components/app';
import { cn } from '@/lib/utils';
import Team from './Team';
import ApiKey from './ApiKey';
import Plan from './Plan';
import Account from './Account';

const tabs = [
  { to: '/settings/team', label: 'Team', icon: Users },
  { to: '/settings/api-key', label: 'API key', icon: KeyRound },
  { to: '/settings/plan', label: 'Plan & billing', icon: CreditCard },
  { to: '/settings/account', label: 'Account', icon: User },
];

export default function Settings() {
  return (
    <div>
      <PageHeader title="Settings" description="Your team, API key, plan and account." />
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <nav
          aria-label="Settings sections"
          className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:w-52 md:flex-col md:overflow-visible md:p-0"
        >
          {tabs.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )
              }
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <Routes>
            <Route index element={<Navigate to="/settings/team" replace />} />
            <Route path="team" element={<Team />} />
            <Route path="api-key" element={<ApiKey />} />
            <Route path="plan" element={<Plan />} />
            {/* Payment pages return to /settings/billing?checkout=success|cancelled */}
            <Route path="billing" element={<Plan />} />
            <Route path="account" element={<Account />} />
            <Route path="*" element={<Navigate to="/settings/team" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
