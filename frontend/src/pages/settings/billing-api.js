import { api } from '@/lib/api';

// Billing calls (docs/api/billing.md). Owner changes, admin reads, viewer has no access.
export const getBilling = () => api('/billing');
export const cancelSubscription = () => api('/billing/cancel', { method: 'POST' });
export const saveBillingProfile = (profile) =>
  api('/billing/profile', { method: 'PUT', body: profile });
export const openPortal = () => api('/billing/portal', { method: 'POST' });

/**
 * Start a plan change. Resolves to one of:
 *   { url }                  paid plan, nothing active: send the browser there (Stripe / Razorpay)
 *   { pending, message }     changed at the provider; the plan updates after its webhook
 *   { scheduled, effectiveAt } downgrade to Free at the end of the paid period
 *   { switched }             immediate switch to Free
 * Errors: 503 payments not set up, 400 over the new plan's limits, 409 other provider active.
 */
export function startCheckout(planId, { interval = 'monthly', currency = 'INR' } = {}) {
  return api('/billing/checkout', { method: 'POST', body: { planId, interval, currency } });
}
