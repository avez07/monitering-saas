import { useState } from 'react';
import {
  Plus,
  Users,
  Trash2,
  Shield,
  Check,
  ArrowUpRight,
  Download,
  CreditCard,
  Mail,
  Settings,
  Folder,
  Clock3,
  Globe,
  FileText,
  CheckCircle2,
} from 'lucide-react';
import { useApi, useWorkspace, useAction, formatNumber, formatDate } from '../lib/workspace';
import { download } from '../lib/api';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  FormModal,
  PageHeader,
  QueryState,
  Tabs,
  Toggle,
  Field,
  Input,
  Select,
} from '../components/ui';

const usd = (cents) => `${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const inr = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export function TeamPage() {
  const ws = useWorkspace(),
    query = useApi('/members'),
    action = useAction();
  return (
    <>
      <PageHeader
        title="Team & access"
        description="The right people. The right access. One shared picture."
      />
      <div className="callout">
        <Shield size={18} />
        <p>
          Email invitations are coming soon. Until then, new team members cannot be added, because
          we never create accounts or set passwords on someone’s behalf.
        </p>
      </div>
      <div className="team-summary">
        <span className="team-avatar-group">
          {(query.data || []).slice(0, 5).map((m, i) => (
            <span className={`avatar avatar-${i}`} key={m.id}>
              {m.name
                .split(' ')
                .map((n) => n[0])
                .slice(0, 2)
                .join('')}
            </span>
          ))}
        </span>
        <div>
          <strong>
            {query.data?.length || 0} of {ws.plan.members} seats used
          </strong>
          <span>Your {ws.plan.name} plan grows with your team.</span>
        </div>
        <span className="role-note">
          <Shield size={15} />
          Role-based access
        </span>
      </div>
      <Card>
        <CardHeader title="Workspace members" subtitle="Manage accounts and project access" />
        <QueryState query={query}>
          <DataTable
            rows={query.data}
            emptyTitle="No members found"
            columns={[
              {
                key: 'name',
                label: 'Member',
                render: (r) => (
                  <div className="resource-name">
                    <span className="avatar">
                      {r.name
                        .split(' ')
                        .map((n) => n[0])
                        .slice(0, 2)
                        .join('')}
                    </span>
                    <div>
                      <strong>
                        {r.name}
                        {r.userId === ws.user.id && <span className="you-label">You</span>}
                      </strong>
                      <small>{r.email}</small>
                    </div>
                  </div>
                ),
              },
              {
                key: 'role',
                label: 'Role',
                render: (r) =>
                  r.role === 'owner' ? (
                    <span className="role-chip">
                      <Shield size={13} />
                      Owner
                    </span>
                  ) : (
                    <Select
                      aria-label={`Role for ${r.name}`}
                      value={r.role}
                      onChange={(e) =>
                        action.mutate({
                          path: `/members/${r.id}`,
                          method: 'PATCH',
                          body: { role: e.target.value, projectIds: r.projectIds || [] },
                        })
                      }
                    >
                      <option>admin</option>
                      <option>editor</option>
                      <option>viewer</option>
                    </Select>
                  ),
              },
              {
                key: 'projects',
                label: 'Project access',
                render: (r) =>
                  r.projectIds?.length
                    ? r.projectIds
                        .map((id) => ws.projects.find((p) => p.id === id)?.name || id)
                        .join(', ')
                    : 'All projects',
              },
              { key: 'createdAt', label: 'Joined', render: (r) => formatDate(r.createdAt) },
              {
                key: 'actions',
                label: '',
                sortable: false,
                render: (r) =>
                  r.role !== 'owner' &&
                  r.userId !== ws.user.id && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${r.name}`}
                      onClick={() => action.mutate({ path: `/members/${r.id}`, method: 'DELETE' })}
                    >
                      <Trash2 size={15} />
                    </Button>
                  ),
              },
            ]}
          />
        </QueryState>
      </Card>
      <div className="role-cards">
        {[
          { role: 'Owner', description: 'Workspace, billing, team, and all monitoring controls.' },
          { role: 'Admin', description: 'Team, settings, and monitoring. View billing.' },
          { role: 'Editor', description: 'Resources, agents, alerts, and uptime monitors.' },
          { role: 'Viewer', description: 'Read-only access to assigned monitoring projects.' },
        ].map((r) => (
          <Card key={r.role}>
            <Shield size={18} />
            <h3>{r.role}</h3>
            <p>{r.description}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
export function BillingPage() {
  const ws = useWorkspace(),
    query = useApi('/billing'),
    action = useAction(),
    [interval, setInterval] = useState('monthly');
  return (
    <>
      <PageHeader
        title="Billing & usage"
        description="Predictable limits. Room to grow. No surprises."
      />
      <div className="billing-notice">
        <CreditCard size={18} />
        <p>
          <strong>Billing is not live yet.</strong> You can try plan changes, but no payment method
          is connected and no money is charged.
        </p>
        <Badge>Mock provider</Badge>
      </div>
      <QueryState query={query}>
        {(data) => {
          const current = data.plans.find((p) => p.id === data.subscription.planId);
          return (
            <>
              <Card className="current-plan">
                <div>
                  <span className="eyebrow">YOUR CURRENT PLAN</span>
                  <h2>
                    {current.name}
                    <Badge status={data.subscription.status} />
                  </h2>
                  <p>
                    {data.subscription.cancelAtPeriodEnd
                      ? 'Cancels at the end of this billing period'
                      : 'Current period ends'}{' '}
                    {formatDate(data.subscription.periodEnd)}
                  </p>
                </div>
                <div className="plan-price">
                  {usd(current.priceUsdCents)}
                  <small>/ month · {inr(current.priceInrPaise)} in India</small>
                </div>
              </Card>
              <div className="section-heading">
                <div>
                  <h2>A plan for your next chapter</h2>
                  <p>Per server pricing with a free plan. Taxes are added at checkout.</p>
                </div>
                <div className="segmented">
                  <button
                    className={interval === 'monthly' ? 'active' : ''}
                    onClick={() => setInterval('monthly')}
                  >
                    Monthly
                  </button>
                  <button
                    className={interval === 'annual' ? 'active' : ''}
                    onClick={() => setInterval('annual')}
                  >
                    Annually <span>2 months free</span>
                  </button>
                </div>
              </div>
              <div className="plan-grid">
                {data.plans.map((p) => (
                  <Card key={p.id} className={`plan-card ${p.id === 'pro' ? 'featured' : ''}`}>
                    {p.id === 'pro' && <span className="plan-recommended">MOST POPULAR</span>}
                    <span className="plan-name">{p.name}</span>
                    <p>
                      {
                        {
                          free: 'Try it on a couple of servers.',
                          starter: 'For a small startup.',
                          pro: 'For teams shipping every day.',
                          business: 'For a larger fleet.',
                        }[p.id]
                      }
                    </p>
                    <div className="plan-price">
                      {usd(interval === 'annual' ? p.priceUsdCents * 10 : p.priceUsdCents)}
                      <small>
                        /{interval === 'annual' ? 'year' : 'month'} ·{' '}
                        {inr(interval === 'annual' ? p.priceInrPaise * 10 : p.priceInrPaise)}
                      </small>
                    </div>
                    <Button
                      variant={p.id === 'pro' ? 'default' : 'secondary'}
                      className="w-full"
                      loading={action.isPending}
                      disabled={
                        ws.role !== 'owner' ||
                        (p.id === current.id &&
                          interval === data.subscription.interval &&
                          !data.subscription.cancelAtPeriodEnd)
                      }
                      onClick={() =>
                        action.mutate({ path: '/billing/change', body: { planId: p.id, interval } })
                      }
                    >
                      {p.id === current.id &&
                      interval === data.subscription.interval &&
                      !data.subscription.cancelAtPeriodEnd
                        ? 'Current plan'
                        : `Try ${p.name} plan`}
                    </Button>
                    <ul>
                      {[
                        `${p.includedServers} servers included`,
                        p.extraServerUsdCents
                          ? `Extra servers ${usd(p.extraServerUsdCents)} / ${inr(p.extraServerInrPaise)} each`
                          : 'No extra servers',
                        `${p.monitors} website checks (every ${p.minCheckIntervalSeconds >= 60 ? `${p.minCheckIntervalSeconds / 60} min` : `${p.minCheckIntervalSeconds}s`})`,
                        `${p.retentionDays}-day history`,
                        `${p.members} team ${p.members === 1 ? 'member' : 'members'}`,
                        `${p.alertRules} alert rules`,
                      ].map((f) => (
                        <li key={f}>
                          <Check size={14} />
                          {f}
                        </li>
                      ))}
                    </ul>
                  </Card>
                ))}
              </div>
              <div className="two-col billing-bottom">
                <Card>
                  <CardHeader title="Your plan limits" subtitle="Enforced on the server" />
                  <div className="subscription-details">
                    <div>
                      <span>Servers included</span>
                      <strong>{current.includedServers}</strong>
                    </div>
                    <div>
                      <span>Website checks</span>
                      <strong>{current.monitors}</strong>
                    </div>
                    <div>
                      <span>Alert rules</span>
                      <strong>{current.alertRules}</strong>
                    </div>
                  </div>
                </Card>
                <Card>
                  <CardHeader
                    title="Subscription details"
                    subtitle="Backend-enforced entitlements"
                  />
                  <div className="subscription-details">
                    <div>
                      <span>Billing cycle</span>
                      <strong className="capitalize">{data.subscription.interval}</strong>
                    </div>
                    <div>
                      <span>Status</span>
                      <Badge status={data.subscription.status} />
                    </div>
                    <div>
                      <span>Payment provider</span>
                      <strong>Not connected yet</strong>
                    </div>
                    {ws.role === 'owner' && (
                      <Button
                        variant="ghost"
                        className="danger-text"
                        disabled={data.subscription.cancelAtPeriodEnd}
                        onClick={() => action.mutate({ path: '/billing/cancel' })}
                      >
                        {data.subscription.cancelAtPeriodEnd
                          ? 'Cancellation scheduled'
                          : 'Cancel at period end'}
                      </Button>
                    )}
                  </div>
                </Card>
              </div>
              <Card>
                <CardHeader
                  title="Invoice history"
                  subtitle="Simulated invoices are clearly marked"
                />
                <DataTable
                  rows={data.invoices}
                  emptyTitle="Your invoice history starts here"
                  emptyDescription="Try a plan change to generate a simulated invoice."
                  columns={[
                    {
                      key: 'number',
                      label: 'Invoice',
                      render: (r) => (
                        <span className="icon-label">
                          <FileText size={16} />
                          {r.number}
                        </span>
                      ),
                    },
                    { key: 'createdAt', label: 'Date', render: (r) => formatDate(r.createdAt) },
                    {
                      key: 'amount',
                      label: 'Amount',
                      render: (r) => (r.currency === 'INR' ? inr(r.amount) : usd(r.amount)),
                    },
                    { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
                    {
                      key: 'download',
                      label: '',
                      sortable: false,
                      render: (r) => (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            download(
                              `${r.number}.json`,
                              JSON.stringify(r, null, 2),
                              'application/json',
                            )
                          }
                        >
                          <Download size={15} />
                          JSON
                        </Button>
                      ),
                    },
                  ]}
                />
              </Card>
            </>
          );
        }}
      </QueryState>
    </>
  );
}
export function SettingsPage() {
  const ws = useWorkspace(),
    action = useAction(),
    [tab, setTab] = useState('workspace'),
    [modal, setModal] = useState(null);
  const settings = useApi('/settings'),
    audit = useApi('/audit'),
    notifications = useApi('/notifications'),
    environments = useApi('/environments');
  const projectOptions = ws.projects.map((p) => ({ value: p.id, label: p.name }));
  async function saveSettings(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    action.mutate({
      path: '/settings',
      method: 'PATCH',
      body: { name: body.name, settings: { timezone: body.timezone } },
    });
  }
  const definitions = {
    project: {
      title: 'Create project',
      path: '/projects',
      fields: [{ name: 'name', label: 'Project name', placeholder: 'Customer Platform' }],
    },
    environment: {
      title: 'Create environment',
      path: '/environments',
      fields: [
        {
          name: 'name',
          label: 'Environment name',
          placeholder: 'production',
          hint: 'Lowercase letters, digits, and hyphens.',
        },
        { name: 'projectId', label: 'Project', options: projectOptions },
      ],
    },
    channel: {
      title: 'Add email channel',
      path: '/notifications/channels',
      fields: [
        { name: 'name', label: 'Channel name', placeholder: 'Engineering team' },
        {
          name: 'address',
          label: 'Recipient email',
          type: 'email',
          placeholder: 'engineering@company.com',
        },
      ],
    },
  };
  return (
    <>
      <PageHeader title="Settings" description="Make this workspace work for you." />
      <Tabs
        tabs={[
          { value: 'workspace', label: 'Workspace' },
          { value: 'projects', label: 'Projects & environments' },
          { value: 'notifications', label: 'Notifications' },
          { value: 'audit', label: 'Audit log' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'workspace' && (
        <QueryState query={settings}>
          {(data) => (
            <div className="settings-grid">
              <Card>
                <CardHeader
                  title="Workspace details"
                  subtitle="The essentials for your organization"
                />
                <form className="settings-form" onSubmit={saveSettings}>
                  <Field label="Workspace name">
                    <Input name="name" required minLength={2} defaultValue={data.name} />
                  </Field>
                  <Field label="Workspace slug" hint="Used as your workspace identifier.">
                    <Input value={data.slug} disabled />
                  </Field>
                  <Field
                    label="Timezone"
                    hint="Stored as workspace metadata. Browser locale controls display times in this pilot."
                  >
                    <Select
                      name="timezone"
                      defaultValue={data.settings?.timezone || 'Asia/Kolkata'}
                    >
                      <option>Asia/Kolkata</option>
                      <option>UTC</option>
                      <option>America/New_York</option>
                      <option>Europe/London</option>
                      <option>Asia/Singapore</option>
                    </Select>
                  </Field>
                  <Button loading={action.isPending}>Save changes</Button>
                </form>
              </Card>
              <div>
                <Card>
                  <CardHeader
                    title="Maintenance window"
                    subtitle="Pause email notifications while you work"
                  />
                  <div className="settings-section">
                    <p className="muted">
                      Alert evaluation continues. Emails are paused during the configured window.
                    </p>
                    <Badge
                      status={
                        data.settings?.maintenanceUntil &&
                        new Date(data.settings.maintenanceUntil) > new Date()
                          ? 'active'
                          : 'inactive'
                      }
                    />
                    <Button
                      variant="secondary"
                      onClick={() =>
                        action.mutate({
                          path: '/settings',
                          method: 'PATCH',
                          body: {
                            settings: {
                              maintenanceUntil:
                                data.settings?.maintenanceUntil &&
                                new Date(data.settings.maintenanceUntil) > new Date()
                                  ? null
                                  : new Date(Date.now() + 3600000).toISOString(),
                            },
                          },
                        })
                      }
                    >
                      <Clock3 size={15} />
                      {data.settings?.maintenanceUntil &&
                      new Date(data.settings.maintenanceUntil) > new Date()
                        ? 'End maintenance'
                        : 'Pause emails for 1 hour'}
                    </Button>
                  </div>
                </Card>
                <div className="callout">
                  <Settings size={18} />
                  <p>
                    Service endpoints and credentials are centralized in the root <code>.env</code>.
                    See START.md for local and Docker startup instructions.
                  </p>
                </div>
              </div>
            </div>
          )}
        </QueryState>
      )}
      {tab === 'projects' && (
        <div className="form-stack">
          <Card>
            <CardHeader title="Projects" subtitle="Organize services and control access">
              <Button size="sm" onClick={() => setModal('project')}>
                <Plus size={14} />
                Create project
              </Button>
            </CardHeader>
            <DataTable
              rows={ws.projects}
              columns={[
                {
                  key: 'name',
                  label: 'Project',
                  render: (r) => (
                    <span className="icon-label">
                      <Folder size={17} />
                      <strong>{r.name}</strong>
                    </span>
                  ),
                },
                { key: 'slug', label: 'Slug', render: (r) => <code>{r.slug}</code> },
                { key: 'createdAt', label: 'Created', render: (r) => formatDate(r.createdAt) },
              ]}
            />
          </Card>
          <Card>
            <CardHeader title="Environments" subtitle="Group resources by deployment stage">
              <Button variant="secondary" size="sm" onClick={() => setModal('environment')}>
                <Plus size={14} />
                Add environment
              </Button>
            </CardHeader>
            <QueryState query={environments}>
              <DataTable
                rows={environments.data}
                columns={[
                  {
                    key: 'name',
                    label: 'Environment',
                    render: (r) => <span className="environment-tag">{r.name}</span>,
                  },
                  {
                    key: 'projectId',
                    label: 'Project',
                    render: (r) => ws.projects.find((p) => p.id === r.projectId)?.name,
                  },
                  { key: 'id', label: 'ID', render: (r) => <code>{r.id}</code> },
                ]}
              />
            </QueryState>
          </Card>
        </div>
      )}
      {tab === 'notifications' && (
        <Card>
          <CardHeader
            title="Email notification channels"
            subtitle={
              notifications.data?.provider === 'local'
                ? 'Local adapter: messages are visible in Alerts → Notification history.'
                : 'SMTP delivery enabled.'
            }
          >
            <Button size="sm" onClick={() => setModal('channel')}>
              <Plus size={14} />
              Add channel
            </Button>
          </CardHeader>
          <QueryState query={notifications}>
            {(data) => (
              <DataTable
                rows={data.channels}
                emptyTitle="No email channels"
                columns={[
                  {
                    key: 'name',
                    label: 'Channel',
                    render: (r) => (
                      <span className="icon-label">
                        <Mail size={16} />
                        <strong>{r.name}</strong>
                      </span>
                    ),
                  },
                  { key: 'address', label: 'Recipient' },
                  { key: 'type', label: 'Type', render: () => 'Email' },
                  {
                    key: 'enabled',
                    label: 'Enabled',
                    render: (r) => (
                      <Toggle
                        label={`Enable ${r.name}`}
                        checked={r.enabled}
                        onChange={(enabled) =>
                          action.mutate({
                            path: `/notifications/channels/${r.id}`,
                            method: 'PATCH',
                            body: { enabled },
                          })
                        }
                      />
                    ),
                  },
                ]}
              />
            )}
          </QueryState>
        </Card>
      )}
      {tab === 'audit' && (
        <Card>
          <CardHeader
            title="Workspace activity"
            subtitle="The most recent 100 administrative actions"
          />
          <QueryState query={audit}>
            <DataTable
              rows={audit.data}
              columns={[
                {
                  key: 'action',
                  label: 'Action',
                  render: (r) => <code className="audit-action">{r.action}</code>,
                },
                { key: 'target', label: 'Target' },
                {
                  key: 'userId',
                  label: 'Actor',
                  render: (r) => (r.userId === ws.user.id ? ws.user.name : r.userId.slice(0, 10)),
                },
                { key: 'createdAt', label: 'When', render: (r) => formatDate(r.createdAt) },
              ]}
            />
          </QueryState>
        </Card>
      )}
      {modal && (
        <FormModal
          open
          onOpenChange={(v) => !v && setModal(null)}
          {...definitions[modal]}
          loading={action.isPending}
          onSubmit={async (body) => {
            await action.mutateAsync({ path: definitions[modal].path, body });
            ws.notify('Saved successfully.');
          }}
        />
      )}
    </>
  );
}
