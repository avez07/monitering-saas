---
title: Add a service
description: "Monitor a service such as nginx, MySQL, Postgres or Redis on one of your servers."
group: Using YuktiOps
order: 5.5
---

A service is a program on your server that should always be running, such as nginx, MySQL, Postgres or Redis.

## Steps

1. Open **Services** in the dashboard and choose **Add a service**.
2. If the agent is already installed on the machine that runs the service, pick that server. If not, choose **Install the agent on that host** and follow the short dialog.
3. Fill in the service name and, if it listens on the network, its port or URL.
4. Save. The row shows **Waiting for first result** until the agent picks up the change (usually within a minute), then shows the service as running or stopped.
5. Turn on the **Service stopped** alert template so you hear about it ([Alerts](/docs/alerts)).

## Something went wrong?

Stuck on Waiting for first result: run `yuktiops-agent status` on that server and check the service name matches what `systemctl list-units` shows. See [No data](/docs/troubleshooting-no-data).

## Monitor Docker containers without a server

If you only use Docker, run the agent as a container with the Docker socket mounted. See [Docker on Linux](/docs/install-docker-linux).
