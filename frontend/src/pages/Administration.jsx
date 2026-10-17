import { useState } from 'react';
import {
  Plus,
  Users,
  UserPlus,
  Trash2,
  Shield,
  Check,
  ArrowUpRight,
  Download,
  CreditCard,
  KeyRound,
  Copy,
  Mail,
  Settings,
  Folder,
  Clock3,
  Globe,
  FileText,
  Ban,
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
  Modal,
  FormModal,
  PageHeader,
  QueryState,
  Tabs,
  Toggle,
  Field,
  Input,
  Select,
  Progress,
  copy,
} from '../components/ui';

export function TeamPage() {
  const ws = useWorkspace(),
    query = useApi('/members'),
    action = useAction(),
    [create, setCreate] = useState(false);
  return (
    <>
      <PageHeader
        title="Team & access"
        description="The right people. The right access. One shared picture."
      >
        <Button onClick={() => setCreate(true)}>
          <UserPlus size={16} />
          Add team member
        </Button>
      </PageHeader>
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
          { role: 'Admin', description: 'Team, settings, keys, and monitoring. View billing.' },
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
      <FormModal
        open={create}
        onOpenChange={setCreate}
        title="Add team member"
        description="Create an account or add an existing Pulse user. No invitation email is sent."
        loading={action.isPending}
        submitLabel="Add member"
        onSubmit={(body) => {
          const { projectId, password, ...rest } = body;
          return action.mutateAsync({
            path: '/members',
            body: {
              ...rest,
              ...(password ? { password } : {}),
              projectIds: projectId ? [projectId] : [],
            },
          });
        }}
        fields={[
          { name: 'name', label: 'Full name', placeholder: 'Jordan Lee' },
          { name: 'email', label: 'Email', type: 'email', placeholder: 'jordan@company.com' },
          {
            name: 'password',
            label: 'Initial password',
            type: 'password',
            required: false,
            minLength: 10,
            hint: 'Required for new accounts. Share it with your teammate directly.',
          },
          { name: 'role', label: 'Role', options: ['viewer', 'editor', 'admin'] },
          {
            name: 'projectId',
            label: 'Project access',
            options: [
              { value: '', label: 'All projects' },
              ...ws.projects.map((p) => ({ value: p.id, label: p.name })),
            ],
            required: false,
          },
        ]}
      />
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
          <strong>Simulated billing is enabled.</strong> Plan changes and invoices are for local
          testing. No payment method is connected and no money is charged.
        </p>
        <Badge>Mock provider</Badge>
      </div>
      <QueryState query={query}>
        {(data) => {
          const current = data.plans.find((p) => p.id === data.subscription.planId);
          const period = new Date().toISOString().slice(0, 7);
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
                  ₹{formatNumber(current.price)}
                  <small>/ month equivalent</small>
                </div>
              </Card>
              <div className="section-heading">
                <div>
                  <h2>A plan for your next chapter</h2>
                  <p>Illustrative pilot prices in INR, before taxes.</p>
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
                    {p.id === 'pro' && <span className="plan-recommended">ROOM TO GROW</span>}
                    <span className="plan-name">{p.name}</span>
                    <p>
                      {p.id === 'starter'
                        ? 'For small stacks with big ideas.'
                        : p.id === 'pro'
                          ? 'For teams shipping every day.'
                          : 'For a bigger view of your business.'}
                    </p>
                    <div className="plan-price">
                      ₹{formatNumber(interval === 'annual' ? p.price * 10 : p.price)}
                      <small>/{interval === 'annual' ? 'year' : 'month'}</small>
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
                        : `Simulate ${p.name} plan`}
                    </Button>
                    <ul>
                      {[
                        `${p.servers} monitored servers`,
                        `${p.containers} containers`,
                        `${p.logGb} GB logs / month`,
                        `${p.traceGb} GB traces / month`,
                        `${p.metricsGb} GB metrics / month`,
                        `${p.retentionDays}-day retention entitlement`,
                        `${p.members} team members`,
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
                  <CardHeader
                    title="This month’s usage"
                    subtitle="Accepted payload bytes, before storage compression"
                  />
                  <div className="usage-list">
                    {[
                      { key: 'logs', label: 'Log ingestion', max: current.logGb },
                      { key: 'traces', label: 'Trace ingestion', max: current.traceGb },
                      { key: 'metrics', label: 'Metrics ingestion', max: current.metricsGb },
                    ].map((u) => {
                      const value =
                        data.usage
                          .filter((r) => r.kind === u.key && r.period === period)
                          .reduce((a, r) => a + r.bytes, 0) /
                        1024 ** 3;
                      return (
                        <div key={u.key}>
                          <span>
                            {u.label}
                            <strong>
                              {value.toFixed(3)} / {u.max} GB
                            </strong>
                          </span>
                          <Progress value={(value / u.max) * 100} />
                        </div>
                      );
                    })}
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
                      <strong>Mock · Local simulation</strong>
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
                  emptyDescription="Simulate a subscription change to generate a demo invoice."
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
                    { key: 'amount', label: 'Amount', render: (r) => `₹${formatNumber(r.amount)}` },
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
    [modal, setModal] = useState(null),
    [secret, setSecret] = useState(null);
  const settings = useApi('/settings'),
    keys = useApi('/keys'),
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
    key: {
      title: 'Create ingestion API key',
      path: '/keys',
      description: 'This key can send telemetry to one project. It cannot query data.',
      fields: [
        { name: 'name', label: 'Key name', placeholder: 'Production SDK' },
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
          { value: 'keys', label: 'API keys' },
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
      {tab === 'keys' && (
        <Card>
          <CardHeader
            title="Ingestion API keys"
            subtitle="Project-scoped credentials for OTLP producers"
          >
            <Button size="sm" onClick={() => setModal('key')}>
              <Plus size={14} />
              Create key
            </Button>
          </CardHeader>
          <QueryState query={keys}>
            <DataTable
              rows={keys.data}
              emptyTitle="No API keys yet"
              emptyDescription="Create a key for an application SDK or collector."
              columns={[
                {
                  key: 'name',
                  label: 'Name',
                  render: (r) => (
                    <span className="icon-label">
                      <KeyRound size={16} />
                      <strong>{r.name}</strong>
                    </span>
                  ),
                },
                { key: 'prefix', label: 'Key prefix', render: (r) => <code>{r.prefix}…</code> },
                {
                  key: 'projectId',
                  label: 'Project',
                  render: (r) => ws.projects.find((p) => p.id === r.projectId)?.name,
                },
                {
                  key: 'revokedAt',
                  label: 'Status',
                  render: (r) => <Badge status={r.revokedAt ? 'revoked' : 'active'} />,
                },
                {
                  key: 'actions',
                  label: '',
                  sortable: false,
                  render: (r) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!r.revokedAt}
                      onClick={() => action.mutate({ path: `/keys/${r.id}`, method: 'DELETE' })}
                    >
                      <Ban size={14} />
                      Revoke
                    </Button>
                  ),
                },
              ]}
            />
          </QueryState>
        </Card>
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
            const result = await action.mutateAsync({ path: definitions[modal].path, body });
            if (result.token) setSecret(result.token);
            else ws.notify('Saved successfully.');
          }}
        />
      )}
      <Modal
        open={!!secret}
        onOpenChange={(v) => !v && setSecret(null)}
        title="Save your API key"
        description="This is the only time the full key is shown. Store it in your application’s .env file."
      >
        <div className="secret-value">
          <code>{secret}</code>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Copy API key"
            onClick={() => copy(secret, ws.notify)}
          >
            <Copy size={16} />
          </Button>
        </div>
      </Modal>
    </>
  );
}
