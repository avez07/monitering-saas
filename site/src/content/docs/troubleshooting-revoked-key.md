---
title: Server disconnected (revoked key)
description: "Reconnect a server that YuktiOps says was disconnected or removed."
group: Troubleshooting
order: 14
---

**This server was disconnected from your account.** Its credential was revoked, so we refuse its data. This happens when:

- the server was removed in the dashboard, or
- the API key was revoked with "Also disconnect all servers" ticked.

## Fix

Reconnect it by running the install command from the dashboard again (**Servers, Add server**). If you revoked the API key, regenerate it first under **Settings, API key** (see [API key](/docs/api-key)). The same machine is recognised and reconnected.

If you did not expect this, check **Settings, Team** for who has access, and regenerate the API key.
