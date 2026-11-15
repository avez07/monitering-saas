---
title: Getting started
description: "Connect your first server to YuktiOps in about five minutes."
group: Start here
order: 1
---

This guide takes you from nothing to a connected server in about five minutes. You do not need to be a system administrator, but you do need to be able to open a terminal on your server (usually with SSH).

## What you need

- A server running Linux (Ubuntu, Debian, RHEL, Rocky, Alma, Amazon Linux or similar), or Docker.
- Permission to run commands with `sudo` on it.
- The server must be able to make outbound HTTPS connections (port 443). It does not need any open incoming ports.

Only have shared hosting? You cannot install the agent there, but you can still monitor your website from the outside. See [Websites and APIs](/docs/websites-and-apis).

## The three steps

1. **Add a server.** Create your account, then click **Add server** in the dashboard. Choose where it runs (for example Ubuntu or Debian).
2. **Run one command.** The dashboard shows a command that already contains your API key. Copy it and paste it into your server's terminal. It looks like this:

   ```
   curl -fsSL https://get.yuktiops.com | sudo bash -s -- --key=yk_live_...
   ```

3. **See your data.** The installer waits up to 30 seconds for the first measurements and prints "Connected". The dashboard shows your server within a minute.

## Check that it works

On the server:

```
yuktiops-agent status
```

You should see something like "Running, Connected, last data sent 12 seconds ago". If not, go to [Troubleshooting](/docs/troubleshooting).

## What next

- [Set up alerts](/docs/alerts) so you hear about problems.
- [Invite your team](/docs/team-roles).
- [Add your website](/docs/websites-and-apis) to be checked from the internet.
