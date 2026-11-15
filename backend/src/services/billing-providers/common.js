import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../../lib/errors.js';

/** Default HTTP client. Providers take this as a parameter so tests can inject a mock. */
export async function fetchHttp(url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  return { status: response.status, json, text };
}

export function hmacHex(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Constant-time string comparison (length is not secret for fixed-size hex digests). */
export function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const notConfigured = () =>
  new HttpError(503, 'Payments are not configured yet. Please contact support.');
export const providerFailure = (what) =>
  new HttpError(502, `The payment provider could not ${what}. Please try again in a moment.`);

/** BILLING_PRICE_MAP: { planId: { stripe: { monthly, annual }, razorpay: { monthly, annual } } }. */
export function parsePriceMap(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
export function priceIdFor(map, provider, planId, interval) {
  return map?.[planId]?.[provider]?.[interval] || null;
}
export function planFromPrice(map, provider, priceId) {
  if (!priceId) return null;
  for (const [planId, providers] of Object.entries(map))
    for (const [interval, id] of Object.entries(providers?.[provider] || {}))
      if (id === priceId) return { planId, interval };
  return null;
}
