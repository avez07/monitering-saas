---
title: Websites and APIs
description: "Monitor a website or API from outside with no install: uptime, speed, keywords, SSL and domain expiry."
group: Using YuktiOps
order: 8
---

Website and API checks run from **our** servers, over the internet, exactly like a visitor would. You install nothing, so this works on shared hosting too.

## Add a check

Go to **Websites and APIs** and click **Add**. Enter the address (for example `https://example.com`).

| Option | What it does |
| --- | --- |
| Check every | How often we visit. Free: every 5 minutes. Paid: every minute. Business: every 30 seconds |
| Keyword | Mark the site as down if a word you choose is missing from the page |
| API check | Choose the method (GET, POST...), headers and the status code you expect |
| SSL certificate | Warns you before it expires |
| Domain expiry | Warns you before your domain name expires |

A site is marked down only after a quick retry, so one dropped connection does not trigger an alert.

## SSL and domain expiry

You get warnings at **30, 14 and 7 days** before the expiry date. Domain expiry is read from public registry data (RDAP) and is not available for every domain ending.

## Limits

Free allows 5 checks, Starter 25, Pro 100 and Business 500. See [Pricing](/pricing).

## Why checks from outside matter

If your site is down because the server is down, the server cannot tell you. A check from outside can. That is why we recommend it even if you use other tools.
