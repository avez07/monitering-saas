import { config } from '../config.js';

export const GST_RATE = 0.18;
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * GST on an INR amount (paise, before tax). Same state as us: CGST + SGST (half each);
 * any other state or unknown: IGST. Rounding is to the nearest paisa and the parts always sum to `tax`.
 */
export function computeGst(subtotal, profile = {}, company = config) {
  const tax = Math.round(subtotal * GST_RATE);
  const companyState = (company.COMPANY_STATE || company.COMPANY_GSTIN?.slice(0, 2) || '').trim();
  const customerState = (profile.state || profile.gstin?.slice(0, 2) || '').trim();
  const sameState = companyState && customerState && companyState === customerState;
  const breakdown = sameState
    ? { cgst: Math.floor(tax / 2), sgst: tax - Math.floor(tax / 2) }
    : { igst: tax };
  return { subtotal, rate: GST_RATE, tax, total: subtotal + tax, breakdown };
}

/** Subtotal for a plan in the given currency and billing interval (annual = 10 x monthly). */
export function planSubtotal(plan, currency, interval) {
  const monthly = currency === 'INR' ? plan.priceInrPaise : plan.priceUsdCents;
  return interval === 'annual' ? monthly * 10 : monthly;
}
