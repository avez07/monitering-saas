import { config } from '../config.js';
import { hashPassword } from '../lib/crypto.js';

export const plans = [
  {
    id: 'starter',
    name: 'Starter',
    price: 1900,
    currency: 'INR',
    servers: 10,
    containers: 30,
    logGb: 10,
    traceGb: 5,
    metricsGb: 5,
    members: 3,
    alertRules: 10,
    retentionDays: 7,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 6900,
    currency: 'INR',
    servers: 100,
    containers: 500,
    logGb: 100,
    traceGb: 50,
    metricsGb: 50,
    members: 20,
    alertRules: 100,
    retentionDays: 30,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 24900,
    currency: 'INR',
    servers: 1000,
    containers: 5000,
    logGb: 1000,
    traceGb: 500,
    metricsGb: 500,
    members: 100,
    alertRules: 1000,
    retentionDays: 90,
  },
];
export async function seed(store, { tenants = 10, demo = true } = {}) {
  for (const plan of plans)
    if (!(await store.find('subscriptionPlan', { id: plan.id })))
      await store.create('subscriptionPlan', plan);
  if (!demo || (await store.find('user', { email: config.DEMO_EMAIL }))) return;
  const user = await store.create('user', {
    name: 'Alex Morgan',
    email: config.DEMO_EMAIL,
    passwordHash: hashPassword(config.DEMO_PASSWORD),
  });
  for (let n = 0; n < tenants; n++) {
    const org = await store.create('organization', {
      name: n === 0 ? 'Acme Studio' : `Pilot Organization ${n + 1}`,
      slug: n === 0 ? 'acme-studio' : `pilot-${n + 1}`,
      settings: { timezone: 'Asia/Kolkata' },
    });
    const owner =
      n === 0
        ? user
        : await store.create('user', {
            name: `Pilot ${n + 1}`,
            email: `pilot${n + 1}@pulse.local`,
            passwordHash: user.passwordHash,
          });
    await store.create('organizationMember', {
      orgId: org.id,
      userId: owner.id,
      role: 'owner',
      projectIds: [],
    });
    const project = await store.create('project', {
      orgId: org.id,
      name: 'Core Platform',
      slug: 'core-platform',
    });
    const staging = await store.create('project', {
      orgId: org.id,
      name: 'Sandbox',
      slug: 'sandbox',
    });
    for (const name of ['production', 'staging', 'development'])
      await store.create('environment', { orgId: org.id, projectId: project.id, name });
    await store.create('subscription', {
      orgId: org.id,
      planId: 'pro',
      status: 'trialing',
      interval: 'monthly',
      periodEnd: new Date(Date.now() + 14 * 86400000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    await store.create('notificationChannel', {
      orgId: org.id,
      name: 'Engineering email',
      type: 'email',
      address: owner.email,
      enabled: true,
    });
    if (n > 0) continue;
    const hosts = [
      'production-api-01',
      'production-api-02',
      'production-worker-01',
      'production-db-01',
      'staging-api-01',
      'production-cache-01',
      'production-web-01',
      'production-worker-02',
    ];
    for (let i = 0; i < hosts.length; i++) {
      const agent = await store.create('agent', {
        orgId: org.id,
        projectId: project.id,
        name: hosts[i],
        platform: 'linux',
        version: '0.1.0',
        status: i === 2 ? 'degraded' : 'healthy',
        lastSeen: new Date().toISOString(),
        demo: true,
      });
      await store.create('monitoredResource', {
        orgId: org.id,
        projectId: project.id,
        agentId: agent.id,
        name: hosts[i],
        type: 'server',
        environment: i === 4 ? 'staging' : 'production',
        status: i === 2 ? 'warning' : 'healthy',
        labels: {
          region: i % 2 ? 'ap-south-1' : 'us-east-1',
          os: 'Ubuntu 24.04',
          ip: `10.0.1.${10 + i}`,
          cpu: [32, 48, 89, 24, 12, 18, 36, 28][i],
          memory: [46, 58, 76, 64, 22, 42, 38, 31][i],
          disk: 24 + i * 5,
          cores: 4,
          ramGb: 16,
        },
      });
    }
    for (let i = 0; i < 24; i++)
      await store.create('monitoredResource', {
        orgId: org.id,
        projectId: project.id,
        name: `${['api', 'web', 'worker', 'scheduler', 'redis', 'nginx'][i % 6]}-${String(i + 1).padStart(2, '0')}`,
        type: 'container',
        environment: 'production',
        status: i === 17 ? 'stopped' : 'running',
        labels: {
          image: `${['node:22-alpine', 'nginx:1.27', 'redis:7-alpine'][i % 3]}`,
          host: hosts[i % 8],
          cpu: 2 + (i % 18),
          memory: 120 + i * 12,
          restarts: i === 17 ? 4 : 0,
        },
      });
    for (const [i, name] of [
      'api-gateway',
      'checkout-service',
      'auth-service',
      'background-worker',
      'web-frontend',
    ].entries())
      await store.create('monitoredResource', {
        orgId: org.id,
        projectId: project.id,
        name,
        type: 'application',
        environment: 'production',
        status: i === 1 ? 'warning' : 'healthy',
        labels: {
          runtime: 'Node.js',
          throughput: 124 + i * 38,
          errorRate: i === 1 ? 2.4 : 0.12,
          p95: 42 + i * 28,
          dependencies: i === 0 ? ['auth-service', 'checkout-service'] : ['postgres-primary'],
        },
      });
    for (const [i, name] of ['postgres-primary', 'mysql-analytics', 'redis-cache'].entries())
      await store.create('monitoredResource', {
        orgId: org.id,
        projectId: project.id,
        name,
        type: 'database',
        environment: 'production',
        status: 'healthy',
        labels: {
          engine: ['PostgreSQL 16', 'MySQL 8', 'Redis 7'][i],
          connections: 18 + i * 8,
          maxConnections: 100,
          latency: 2.4 + i,
          storageGb: 42 + i * 16,
        },
      });
    await store.create('monitoredResource', {
      orgId: org.id,
      projectId: staging.id,
      name: 'sandbox-api-01',
      type: 'server',
      environment: 'development',
      status: 'healthy',
      labels: { cpu: 8, memory: 18, disk: 12, region: 'local', cores: 2, ramGb: 4 },
    });
    const rule = await store.create('alertRule', {
      orgId: org.id,
      projectId: project.id,
      name: 'High CPU utilization',
      metric: 'cpu',
      operator: 'gt',
      threshold: 85,
      durationSeconds: 60,
      cooldownSeconds: 300,
      enabled: true,
      severity: 'warning',
      silenceUntil: null,
    });
    await store.create('alertIncident', {
      orgId: org.id,
      projectId: project.id,
      ruleId: rule.id,
      resourceId: (await store.list('monitoredResource', { orgId: org.id, type: 'server' }))[2].id,
      name: 'High CPU utilization on production-worker-01',
      severity: 'warning',
      state: 'firing',
      value: 89,
      startedAt: new Date(Date.now() - 720000).toISOString(),
      lastNotifiedAt: new Date().toISOString(),
    });
    await store.create('auditLog', {
      orgId: org.id,
      userId: owner.id,
      action: 'workspace.created',
      target: org.name,
      details: {},
    });
  }
}
