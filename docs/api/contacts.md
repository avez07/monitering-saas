# Contacts API ("Where to send alerts")

Cookie-authenticated, CSRF-guarded. Errors `{ "error": "..." }`. Any member can read; `owner`/`admin` can write, test and delete. Lists are `{ items, ...meta }`.

Contact JSON (secrets and webhook URLs are never returned in full):

```json
{
  "id": "uuid", "type": "slack", "name": "Ops channel", "enabled": true,
  "status": "connected",
  "target": "hooks.slack.com/…a1b2",
  "lastTest": { "at": "...", "ok": true, "error": null },
  "createdAt": "..."
}
```

- `type`: `email` | `telegram` | `slack` | `discord` | `webhook`.
- `status`: `connected` or `pending` (Telegram not yet linked).
- `target`: email address in full; masked URL for slack/discord/webhook; Telegram chat name (or `"Not linked yet"`).
- Free plan: only `email` and `telegram`; other types get 402 `"Your Free plan sends alerts by Email and Telegram. Upgrade to add Slack, Discord or Webhook."`.

## Endpoints

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /api/contacts` | | `{ items, allowedTypes: ["email","telegram"], telegram: { configured, botName } }` |
| `POST /api/contacts` | email `{type:"email", name, address}`; slack/discord/webhook `{type, name, url}`; telegram `{type:"telegram", name}` | 201 contact. Webhook adds `secret` (shown once). Telegram adds `link` |
| `PATCH /api/contacts/:id` | `{ name?, enabled?, address?, url? }` | contact |
| `DELETE /api/contacts/:id` | | 204 (also removed from rules' `contactIds`) |
| `POST /api/contacts/:id/test` | | `{ ok: true }` or `{ ok: false, error: "plain reason" }` (always 200 once the contact exists) |
| `POST /api/contacts/:id/telegram-link` | | new `link` (re-link a chat) |
| `POST /api/contacts/:id/rotate-secret` | | `{ secret }` (webhook only, shown once) |
| `GET /api/contacts/deliveries?limit=50` | | `{ items: [{ id, contactId, contactName, type, subject, status, error, createdAt, deliveredAt }] }` |

## Telegram link flow

1. `POST /api/contacts {type:"telegram", name:"My phone"}` returns the contact (`status: "pending"`) with
   `"link": { "url": "https://t.me/<bot>?start=<code>", "code": "...", "expiresAt": "..." }` (valid 15 minutes). 503 if the server has no bot configured (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_NAME`, `TELEGRAM_WEBHOOK_SECRET`).
2. The user opens `url` in Telegram and presses Start. Telegram calls our webhook `POST /api/contacts/telegram/webhook` (public; requires header `X-Telegram-Bot-Api-Secret-Token` equal to `TELEGRAM_WEBHOOK_SECRET`). The bot binds the chat and replies "Connected".
3. The frontend polls `GET /api/contacts` until the contact `status` is `connected`.

## Webhook contacts

Body is JSON. Headers: `X-YuktiOps-Timestamp` (unix seconds) and `X-YuktiOps-Signature: sha256=<hex>` where hex = HMAC-SHA256(secret, `<timestamp>.<raw body>`). Payload:

```json
{ "event": "alert.fired", "sentAt": "...",
  "incident": { "id": "...", "name": "Disk almost full on web-1", "severity": "warning", "state": "firing", "value": 91.2, "startedAt": "..." },
  "message": "text", "url": "https://app.../alerts" }
```

`event` is `alert.fired`, `alert.resolved` or `test`. URLs go through the SSRF guard (public addresses only, re-resolved at send time, redirects are not followed). Slack URLs must be on `hooks.slack.com`, Discord on `discord.com` / `discordapp.com`.
