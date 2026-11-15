---
title: The server clock is wrong
description: "Fix a wrong server clock (clock skew) so YuktiOps charts and alerts are accurate."
group: Troubleshooting
order: 12
---

**Your server's clock is wrong.** If it differs from real time by more than two minutes, we correct the timestamps so no data is lost. Charts and alerts are still safer with a correct clock, and a badly wrong clock can also break secure connections.

## Fix

Turn on automatic time sync and check it:

```
sudo timedatectl set-ntp true
timedatectl status
```

"System clock synchronized: yes" means you are done. Restart the agent if you like: `sudo systemctl restart yuktiops-agent`.

On virtual machines, a clock can drift after the VM is paused or moved. Automatic sync fixes this too.
