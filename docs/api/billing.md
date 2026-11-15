# Billing API

Base path `/api`. Session cookie + CSRF like every dashboard route. Owner = changes; admin = read-only; viewer = no access.
Money is always integer minor units (USD cents, INR paise). Plan state changes only through verified provider webhooks (or `BILLING_DEV_MODE`), never from client input.

## GET /api/billing  (owner, admin)

```json
{
  "plans": [ { "id": "starter", "name": "Starter", "priceUsdCents": 900, "priceInrPaise": 59900,
               "includedServers": 3, "monitors": 25, "members": 3, "alertRules": 20, "retentionDays": 30, "...": "unchanged plan fields" } ],
  "subscription": { "planId": "pro", "status": "active|past_due|cancelled|trialing", "interval": "monthly|annual",
                    "periodEnd": "ISO", "cancelAtPeriodEnd": false, "provider": "stripe|razorpay|null",
                    "currency": "USD|INR|null", "pastDueSince": "ISO|null" },
  "invoices": [ { "number": "...", "amount": 70800, "subtotal": 59900, "tax": 10782, "taxRate": 0.18,
                  "currency": "INR", "status": "paid|failed|simulated", "provider": "razorpay",
                  "periodStart": "ISO", "periodEnd": "ISO", "url": "hosted invoice url or null", "createdAt": "ISO" } ],
  "provider": "mock",
  "providers": { "razorpay": { "configured": true, "currency": "INR" }, "stripe": { "configured": false, "currency": "USD" } },
  "devMode": false,
  "gst": { "rate": 0.18 },
  "graceDays": 7,
  "profile": { "legalName": "", "email": "", "country": "IN", "state": "", "gstin": "", "address": "" },
  "canManage": true
}
```
`providers.*.configured=false` means checkout returns 503; show "Payments are not available yet". INR total for a plan = `priceInrPaise` + 18 % GST (shown on the invoice). Annual price = 10 x monthly.

## PUT /api/billing/profile  (owner)
Body (all optional strings): `legalName, email, country (ISO-2), state (2-digit GST state code, India), gstin, address`. GSTIN is validated (15 chars) and optional. Returns the saved profile. `GET /api/billing/profile` (owner, admin) returns it.

## POST /api/billing/checkout  (owner)
Body `{ "planId": "pro", "interval": "monthly|annual" (default monthly), "currency": "USD|INR" }`.
- Paid plan, nothing active -> `{ "url": "https://..." }` (Stripe Checkout / Razorpay subscription page). Redirect the browser there. Return pages are `APP_URL/settings/billing?checkout=success|cancelled`.
- Paid plan while a paid subscription exists (same provider/currency) -> plan is changed through the provider: `{ "pending": true, "message": "..." }`; the new plan appears after the provider webhook (refresh in a few seconds).
- `planId: "free"` -> downgrade: with a paid subscription it is cancelled at period end `{ "scheduled": true, "effectiveAt": "ISO" }`; without one the switch is immediate `{ "switched": true }`.
- Errors: `503 {error:"Payments are not configured yet."}`; `400` plain-language over-limit message (below); `409` different provider/currency already active (cancel first); `404` unknown plan.

Downgrade over limit (400, `reason: "plan_limits_exceeded"`): `Your Starter plan allows 3 servers, but you have 5. Remove 2 servers, 1 website check before switching.`

## POST /api/billing/portal  (owner)
Stripe customer portal (card, invoices, cancel) -> `{ "url" }`. `400` if the account is not on Stripe (Razorpay has no portal; use cancel), `503` if unconfigured.

## POST /api/billing/cancel  (owner)
Cancel at period end. Returns the subscription row (`cancelAtPeriodEnd: true`). Access continues until `periodEnd`, then the account moves to Free automatically.

## POST /api/billing/change  (owner, dev only)
`{planId, interval}`; works only when `BILLING_DEV_MODE=true` (otherwise 403). Switches plan with no payment. Never enabled in production.

## Dunning
Failed payment -> subscription `past_due`, `pastDueSince` set, owner emailed. After 7 days with no successful payment the account is moved to Free (existing data kept; new additions blocked above Free limits). A later successful payment on the same subscription restores `active`.

## Webhooks (not for the frontend)
`POST /api/webhooks/stripe`, `POST /api/webhooks/razorpay` - raw body, signature verified, idempotent per (provider, event id).
