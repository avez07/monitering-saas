// Plan definitions (see PLAN.md section 3). Prices are seed data until billing ships.
export const plans = [
  {
    id: 'free',
    name: 'Free',
    priceUsdCents: 0,
    priceInrPaise: 0,
    includedServers: 2,
    extraServerUsdCents: 0,
    extraServerInrPaise: 0,
    monitors: 5,
    minCheckIntervalSeconds: 300,
    members: 1,
    alertRules: 5,
    retentionDays: 7,
  },
  {
    id: 'starter',
    name: 'Starter',
    priceUsdCents: 900,
    priceInrPaise: 59900,
    includedServers: 3,
    extraServerUsdCents: 300,
    extraServerInrPaise: 19900,
    monitors: 25,
    minCheckIntervalSeconds: 60,
    members: 3,
    alertRules: 20,
    retentionDays: 30,
  },
  {
    id: 'pro',
    name: 'Pro',
    priceUsdCents: 2900,
    priceInrPaise: 199900,
    includedServers: 10,
    extraServerUsdCents: 250,
    extraServerInrPaise: 16900,
    monitors: 100,
    minCheckIntervalSeconds: 60,
    members: 10,
    alertRules: 100,
    retentionDays: 90,
  },
  {
    id: 'business',
    name: 'Business',
    priceUsdCents: 9900,
    priceInrPaise: 699900,
    includedServers: 40,
    extraServerUsdCents: 200,
    extraServerInrPaise: 13900,
    monitors: 500,
    minCheckIntervalSeconds: 30,
    members: 1000,
    alertRules: 500,
    retentionDays: 365,
  },
];

/** Insert missing plans and keep existing ones in sync with the definitions above. */
export async function seedPlans(store) {
  for (const plan of plans) {
    const { id, ...fields } = plan;
    if (await store.find('subscriptionPlan', { id }))
      await store.update('subscriptionPlan', id, fields);
    else await store.create('subscriptionPlan', plan);
  }
}
