# Account API (email verification, password reset)

All under `/api/auth`, public unless noted, CSRF origin-checked on POST. Errors `{ "error": "..." }`.

- `GET /api/auth/me` (cookie) -> `{ "user": { "id", "name", "email", "emailVerified": true | false } }`. Unverified users can use the product normally; show a banner. `emailVerified` is also on the user object returned by login/register/bootstrap.
- `POST /api/auth/register` now also emails a verification link `APP_URL/verify-email?token=<token>` (valid 3 days).
- `POST /api/auth/verify-email` body `{ "token" }` -> 200 `{ "verified": true }`. 400 `{ "error": "This link is invalid or has expired." }` (also when already used). Works signed out.
- `POST /api/auth/resend-verification` (cookie) -> 200 `{ "sent": true }` (or `{ "sent": false, "alreadyVerified": true }`). Rate-limited (3 per hour per user) -> 429.
- `POST /api/auth/forgot-password` body `{ "email" }` -> **always 200** `{ "message": "If that email has an account, a reset link is on its way." }`. The link is `APP_URL/reset-password?token=<token>`, valid 1 hour, single use; a new request invalidates older links. Rate-limited per IP and per email -> 429.
- `POST /api/auth/reset-password` body `{ "token", "password" (10-128 chars) }` -> 200 `{ "reset": true }`. Revokes **all** sessions of that user (they sign in again). 400 for an invalid, expired or used token.
