# Team API

Roles: `owner` (everything incl. billing, delete org, transfer ownership), `admin` (everything except billing and ownership), `viewer` (read-only). `editor` no longer exists (migrated to `admin`). `projectIds` is **no longer used**: it is not returned and not accepted (the DB column remains, unused).
Errors: `{ "error": "message" }`.

## Members (cookie auth)

- `GET /api/members` (admin+): `[{ "id", "userId", "orgId", "role", "name", "email", "createdAt" }]`
- `PATCH /api/members/:id` (admin+) body `{ "role": "admin" | "viewer" }`. The owner row cannot be changed (403). Only the owner can change an admin or promote someone to admin (403 otherwise).
- `DELETE /api/members/:id` (admin+) -> 204. 403 for the owner or yourself. The removed user's requests to this organization fail with 403 immediately; their other organizations keep working.

## Invites (cookie auth, admin+)

- `POST /api/invites` body `{ "email": "a@b.com", "role": "admin" | "viewer" }` -> 201
  `{ "id", "email", "role", "status": "pending", "expiresAt", "createdAt", "invitedByName" }`.
  Sends an email with the link `APP_URL/invite/<token>`. Errors: 402 plan member limit (members + pending invites), 409 already a member or already invited (use resend), 403 for viewers.
- `GET /api/invites` -> list for the org, newest first. `status`: `pending | accepted | revoked | expired`.
- `POST /api/invites/:id/resend` -> 200 invite. Issues a **new** token (the old link stops working), extends expiry to 7 days, re-sends. 409 if not pending.
- `DELETE /api/invites/:id` -> 204 (revokes).

## Invite acceptance (public; CSRF origin check on POST)

- `GET /api/invites/:token` -> `{ "email", "role", "organizationName", "invitedByName", "expiresAt", "userExists": true | false }`.
  404 unknown token; 410 `{ "error", "reason": "expired" | "used" | "revoked" }`.
- `POST /api/invites/:token/accept`
  - New user (no account for that email): body `{ "name": "Jane", "password": "10+ chars" }`. Creates the account (email counted as verified), joins, **starts a session** -> 201.
  - Existing user: must be signed in **as the invited email** (cookie). Body `{}`. Joins -> 200. Signed out: 401 `{ "error", "reason": "signin_required" }`. Signed in as someone else: 403 `reason: "wrong_account"`.
  - Response: `{ "user": { id, name, email, emailVerified }, "organization": { id, name }, "role": "viewer" }`.
  - Single use (a second call is 410 `used`); expired is 410; the member limit is re-checked (402).

Frontend route used in emails: `/invite/:token`.
