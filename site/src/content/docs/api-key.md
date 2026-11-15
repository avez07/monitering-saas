---
title: Your account API key
description: "What the YuktiOps account API key is, how to create, regenerate and revoke it."
group: Using YuktiOps
order: 5
---

One API key per account is used to connect all your servers. It starts with `yk_live_`.

## What it does (and does not do)

- It lets a new server **register**. Each server then receives its own credential and uses that from then on.
- It cannot read your data. It only adds servers.
- It is shown **once**, when you create or regenerate it. We store only a fingerprint, so we cannot show it again.

## Create, regenerate or revoke

Go to **Settings, API key**. Only Owners and Admins can change it.

- **Create:** the first time you click Add server the wizard can create it for you.
- **Regenerate:** gives you a new key. The old key stops working for *new* installs. Servers that are already connected keep running.
- **Revoke:** turns the key off. You can also tick "Also disconnect all servers" if you think it leaked.

Lost the key? Regenerate it. There is no way to look it up.

## Tips

- Treat it like a password. Do not post it in chat or commit it to a repository.
- A server that is installed again is recognised and reconnected, so it does not use up a second server slot.
- Plan limits apply on registration. See [plan limit](/docs/troubleshooting-plan-limit).
