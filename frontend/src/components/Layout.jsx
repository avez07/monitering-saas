import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  LayoutDashboard,
  Layers3,
  Server,
  Globe,
  Bell,
  Users,
  Radio,
  CreditCard,
  Settings,
  ChevronDown,
  Search,
  Plus,
  ArrowUpRight,
  LogOut,
  Menu,
  X,
  CheckCircle2,
  AlertCircle,
  CircleHelp,
} from 'lucide-react';
import { session } from '../lib/api';
import { useApi, WorkspaceContext } from '../lib/workspace';
import { Badge, Button, Select, Loading, ErrorState } from './ui';
import { Onboarding } from './Onboarding';

export const navigation = [
  {
    title: 'WORKSPACE',
    items: [
      { path: '/', label: 'Overview', icon: LayoutDashboard },
      { path: '/servers', label: 'Servers', icon: Server },
    ],
  },
  {
    title: 'MONITOR',
    items: [
      { path: '/uptime', label: 'Websites', icon: Globe },
      { path: '/alerts', label: 'Alerts', icon: Bell },
    ],
  },
  {
    title: 'MANAGE',
    items: [
      { path: '/agents', label: 'Agents', icon: Radio },
      { path: '/team', label: 'Team & access', icon: Users, admin: true },
      { path: '/billing', label: 'Plan & billing', icon: CreditCard, admin: true },
      { path: '/settings', label: 'Settings', icon: Settings, admin: true },
    ],
  },
];
export function Layout() {
  const bootstrap = useApi('/bootstrap'),
    client = useQueryClient(),
    navigate = useNavigate(),
    location = useLocation();
  const [projectId, setProjectId] = useState(''),
    [environment, setEnvironment] = useState(''),
    [range, setRange] = useState('1h');
  const [onboard, setOnboard] = useState(false),
    [mobile, setMobile] = useState(false),
    [toast, setToast] = useState(null),
    [search, setSearch] = useState('');
  useEffect(() => {
    setMobile(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  if (bootstrap.isPending) return <Loading />;
  if (bootstrap.isError)
    return (
      <div className="boot-error">
        <ErrorState error={bootstrap.error} retry={bootstrap.refetch} />
        <Button
          variant="secondary"
          onClick={() => {
            session.org = null;
            client.invalidateQueries();
          }}
        >
          Reset organization
        </Button>
        <Button variant="ghost" onClick={() => window.dispatchEvent(new Event('yuktiops:logout'))}>
          Sign out
        </Button>
      </div>
    );
  const workspace = bootstrap.data,
    canAdmin = ['owner', 'admin'].includes(workspace.role),
    canEdit = workspace.role !== 'viewer';
  const notify = (message, type = 'success') => setToast({ message, type });
  const context = {
    ...workspace,
    filters: { projectId, environment, range },
    setProjectId,
    setEnvironment,
    setRange,
    notify,
    canAdmin,
    canEdit,
    openOnboarding: () => setOnboard(true),
  };
  const current = navigation.flatMap((g) => g.items).find((i) => i.path === location.pathname);
  function changeOrganization(value) {
    session.org = value;
    setProjectId('');
    setEnvironment('');
    client.clear();
    navigate('/');
  }
  return (
    <WorkspaceContext.Provider value={context}>
      <div className="app-shell">
        <div
          className={`mobile-backdrop ${mobile ? 'visible' : ''}`}
          onClick={() => setMobile(false)}
        />
        <aside className={`sidebar ${mobile ? 'open' : ''}`}>
          <NavLink to="/" className="brand">
            <span className="brand-icon">
              <Activity size={23} />
            </span>
            yukti<span className="brand-dot">ops</span>
            <span className="brand-plan">BETA</span>
          </NavLink>
          <div className="workspace-switch">
            <span className="workspace-avatar">{workspace.organization.name.slice(0, 1)}</span>
            <div>
              <strong>{workspace.organization.name}</strong>
              <span>{workspace.plan.name} workspace</span>
            </div>
            <ChevronDown size={14} />
            <select
              aria-label="Organization"
              value={workspace.organization.id}
              onChange={(e) => changeOrganization(e.target.value)}
            >
              {workspace.organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <nav>
            {navigation.map((group) => (
              <div className="nav-group" key={group.title}>
                <span className="nav-label">{group.title}</span>
                {group.items
                  .filter((i) => !i.admin || canAdmin)
                  .map(({ path, label, icon: Icon }) => (
                    <NavLink
                      to={path}
                      end={path === '/'}
                      key={path}
                      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                    >
                      <Icon size={17} />
                      <span>{label}</span>
                      {path === '/alerts' && <span className="nav-dot" />}
                    </NavLink>
                  ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-help">
              <div className="help-title">
                <span className="help-icon">
                  <Activity size={15} />
                </span>
                Add your first server.
              </div>
              <p>It takes about two minutes.</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setOnboard(true)}
                disabled={!canEdit}
              >
                Connect a server
                <ArrowUpRight size={13} />
              </Button>
            </div>
            <div className="profile">
              <span className="avatar">
                {workspace.user.name
                  .split(' ')
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join('')}
              </span>
              <div>
                <strong>{workspace.user.name}</strong>
                <span>{workspace.role}</span>
              </div>
              <button
                title="Sign out"
                aria-label="Sign out"
                onClick={() => window.dispatchEvent(new Event('yuktiops:logout'))}
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumbs">
              <button
                className="mobile-menu"
                aria-label="Toggle navigation"
                onClick={() => setMobile(!mobile)}
              >
                <Menu size={20} />
              </button>
              <span>Workspace</span>
              <span className="breadcrumb-slash">/</span>
              <strong>{current?.label || 'Overview'}</strong>
            </div>
            <div className="topbar-actions">
              <form
                className="global-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  navigate(`/servers?search=${encodeURIComponent(search)}`);
                }}
              >
                <Search size={15} />
                <input
                  aria-label="Search servers"
                  placeholder="Search servers…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <kbd>↵</kbd>
              </form>
              <button
                className="top-icon"
                aria-label="View alerts"
                onClick={() => navigate('/alerts')}
              >
                <Bell size={18} />
                <i />
              </button>
              <span className="topbar-divider" />
              <span className="avatar small">{workspace.user.name.slice(0, 1)}</span>
            </div>
          </header>
          <main className="main-content">
            <div className="context-row">
              <div className="context-select">
                <Layers3 size={14} />
                <Select
                  aria-label="Project"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">All projects</option>
                  {workspace.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
              <span className="context-divider" />
              <Select
                aria-label="Environment"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
              >
                <option value="">All environments</option>
                <option>production</option>
                <option>staging</option>
                <option>development</option>
              </Select>
              <div className="context-right">
                <span className="connection-state">
                  <i className="status-dot" />
                  {workspace.plan.name} plan
                </span>
              </div>
            </div>
            <Outlet />
          </main>
          <footer className="app-footer">
            <span>
              <Activity size={13} /> YuktiOps
            </span>
            <span>
              Simple server monitoring. <span className="muted">v0.1.0</span>
            </span>
          </footer>
        </div>
        <Onboarding open={onboard} onOpenChange={setOnboard} />
        {toast && (
          <div className={`toast ${toast.type}`} role="status">
            {toast.type === 'error' ? <AlertCircle size={19} /> : <CheckCircle2 size={19} />}
            <span>{toast.message}</span>
            <button aria-label="Dismiss notification" onClick={() => setToast(null)}>
              <X size={16} />
            </button>
          </div>
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}
