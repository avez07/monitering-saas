---
title: Alerts
description: "Set up simple alerts from templates and choose where they are sent: email, Telegram, Slack, Discord or webhook."
group: Using YuktiOps
order: 6
---

An alert tells you when something needs attention. You describe it in plain words, for example: "Alert me when **disk space used** is above **85%** for **5 minutes** on **all servers**, and send it to **Email and Telegram**."

## Start from a template

Go to **Alerts** and choose a template. You can change any number afterwards.

- Server goes down
- Disk almost full (85%)
- CPU stays very high (90% for 5 minutes)
- Memory almost full
- Website is down
- Website is slow (over 3 seconds for 5 minutes)
- SSL certificate expires soon
- Domain expires soon
- Container stopped
- Service stopped

New accounts start with three alerts already on: server down, disk almost full, and website down (it applies once you add a website). Container and service alerts work once you turn on container or service monitoring for a server (see [Install the agent](/docs/install)).

## Where alerts are sent

Under **Alerts, Where to send alerts**, add one or more contacts:

| Contact | Notes |
| --- | --- |
| Email | The Free plan includes email |
| Telegram | Connect with a one-click link to our bot (included in Free) |
| Slack | Paste an incoming webhook URL (paid plans) |
| Discord | Paste a webhook URL (paid plans) |
| Webhook | Our servers send a signed message to your URL (paid plans) |

Each contact has a **Send test** button. Use it. A test now is better than a surprise later. Each alert rule picks its contacts; the default is all of them.

## Good to know

- "For 5 minutes" means the problem must last that long. A short spike will not wake you up.
- You get a message when a problem starts and another when it is resolved.
- A silent server is detected from our side. If it has not reported for about three minutes, you get a "server down" alert even if your own monitoring is down too.
