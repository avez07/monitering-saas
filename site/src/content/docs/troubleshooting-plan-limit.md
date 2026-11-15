---
title: Plan limit reached
description: "What to do when YuktiOps says you reached your plan's server limit."
group: Troubleshooting
order: 13
---

**You've reached your plan's server limit.** Each plan allows a fixed number of servers (the Free plan allows 2; see [Pricing](/pricing)). The new server could not be added.

## Fix

Either:

- **Upgrade your plan** in Settings, Plan and billing, or
- **Remove a server you no longer use** (Servers, choose the server, Remove).

Then restart the agent on the server that was refused:

```
sudo systemctl restart yuktiops-agent
```

Servers that were already connected keep working. Reinstalling the agent on the same machine does not use a second slot.
