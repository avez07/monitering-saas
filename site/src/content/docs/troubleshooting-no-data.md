---
title: No data is arriving
description: "What to check when your new server shows no data in YuktiOps."
group: Troubleshooting
order: 10
---

If the dashboard says "We can't hear from this server yet", the agent is probably not running, or it cannot reach us. When nothing arrives we cannot see the reason from our side, so check the server itself.

## Checklist

1. **Is the agent running?**

   ```
   yuktiops-agent status
   sudo systemctl status yuktiops-agent
   ```

   If it is not running, start it with `sudo systemctl enable --now yuktiops-agent`. If it was never registered, run the install command again from the dashboard.

2. **Can the server reach us?** The most common cause is blocked outbound HTTPS.

   ```
   curl -I https://api.yuktiops.com/api/health
   ```

   If this fails, see [Firewall, proxy or DNS](/docs/troubleshooting-firewall-proxy).

3. **Is the clock right?** See [clock problems](/docs/troubleshooting-clock-skew).

4. **Read the log.**

   ```
   sudo journalctl -u yuktiops-agent -n 100
   ```

5. **Run the doctor.**

   ```
   sudo yuktiops-agent doctor
   ```

Data that could not be sent is kept for up to 15 minutes and sent in order once the connection works again, so a short outage leaves no gap.
