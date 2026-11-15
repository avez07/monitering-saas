import { config } from '../../config.js';
import { createStripe } from './stripe.js';
import { createRazorpay } from './razorpay.js';

let override = null;
let built = null;

/** Providers built from the environment (cached). Tests call `setProviders` with mocked ones. */
export function getProviders() {
  if (override) return override;
  built ||= { stripe: createStripe({ config }), razorpay: createRazorpay({ config }) };
  return built;
}
export function setProviders(next) {
  override = next;
}
export const providerForCurrency = (currency) =>
  getProviders()[currency === 'INR' ? 'razorpay' : 'stripe'];
