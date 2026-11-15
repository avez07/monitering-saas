# Billing setup (Razorpay for INR, Stripe for USD)

Code is complete; it activates when you add keys. Without keys, checkout returns `503 Payments are not configured yet.`

## Environment variables (`.env`)
| Variable | Purpose |
|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API keys (Settings > API Keys) |
| `RAZORPAY_WEBHOOK_SECRET` | secret you type when creating the Razorpay webhook |
| `STRIPE_SECRET_KEY` | `sk_test_...` / `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` of the webhook endpoint |
| `BILLING_PRICE_MAP` | JSON: our plan id -> provider price/plan ids (below) |
| `COMPANY_GSTIN`, `COMPANY_STATE` | your GSTIN and 2-digit state code (decides CGST+SGST vs IGST) |
| `BILLING_DEV_MODE` | `true` only on a dev machine: `/api/billing/change` switches plans without payment. Default `false`; the server refuses to start in production with it on. |

`BILLING_PRICE_MAP` example (single line in `.env`):
`{"starter":{"stripe":{"monthly":"price_1...","annual":"price_1..."},"razorpay":{"monthly":"plan_...","annual":"plan_..."}},"pro":{...},"business":{...}}`

## Stripe (USD)
1. Create a Stripe account; stay in Test mode first.
2. Products: create Starter ($9), Pro ($29), Business ($99). For each add a monthly recurring price and an annual price (10 x monthly). Put each `price_...` id in `BILLING_PRICE_MAP`.
3. Developers > Webhooks > Add endpoint `https://<API_PUBLIC_URL>/api/webhooks/stripe`, events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.
4. Settings > Billing > Customer portal: enable it (cancel, update card, invoices).
5. Local test: `stripe listen --forward-to localhost:4000/api/webhooks/stripe` (prints a temporary `whsec_`), card `4242 4242 4242 4242`; failing card `4000 0000 0000 0341`.

## Razorpay (INR, GST)
1. Create a Razorpay account (Test mode first); complete KYC for live.
2. Subscriptions > Plans: create monthly and annual plans for Starter, Pro, Business. Plan amount must be the GST-inclusive total: price x 1.18 (Starter 599 -> 706.82, etc.). Put the `plan_...` ids in `BILLING_PRICE_MAP`.
3. Settings > Webhooks: URL `https://<API_PUBLIC_URL>/api/webhooks/razorpay`, secret = `RAZORPAY_WEBHOOK_SECRET`, events: `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.updated`, `refund.processed`.
4. Test mode: use Razorpay test cards/UPI (`success@razorpay`), webhooks need a public tunnel (ngrok/cloudflared) to your API.
5. Enter your GSTIN in `COMPANY_GSTIN`. Customers may add their GSTIN in Plan & billing; invoices show CGST/SGST (same state) or IGST.

## Notes
- Currency picks the provider: INR -> Razorpay, USD -> Stripe.
- Plan changes happen only after a verified webhook; replays are ignored (table `WebhookEvent`).
- Payment failure: 7-day grace, then Free. The worker runs this check hourly.
- Extra-server (per-unit) billing is not implemented; plans are flat prices.
