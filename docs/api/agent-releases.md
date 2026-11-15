# Agent releases and downloads

Owner: G1 (`backend/src/routes/downloads.js`). Public endpoints, no session and no CSRF header needed.

## `GET /api/agent/releases`

Returns what the Add-server wizard needs to show the Download tab. Cached for 5 minutes (`Cache-Control: public, max-age=300`); if the origin is down the last good answer is kept.

Where `latest.json` comes from:

| Environment variable | Meaning |
| --- | --- |
| `AGENT_DOWNLOADS_BASE_URL` | Production: `https://downloads.yuktiops.com/agent`. `latest.json` is fetched from `<base>/latest.json`; files live at `<base>/v<version>/<name>`. Must be `https://` (plain `http://` only for localhost). |
| `AGENT_DOWNLOADS_DIR` | Local development: a directory containing `latest.json` and `v<version>/` (default `backend/downloads`, written by `npm run agent:dist`). Used only when `AGENT_DOWNLOADS_BASE_URL` is not set. |

### Response `200`

```json
{
  "version": "0.4.1",
  "released": "2026-01-01T00:00:00.000Z",
  "baseUrl": "https://downloads.yuktiops.com/agent",
  "channel": "production",
  "installScriptUrl": "https://get.yuktiops.com",
  "install": {
    "commandTemplate": "curl -fsSL https://get.yuktiops.com | sudo bash -s -- --key=<API_KEY> [--setup=<SETUP_ID>]",
    "uninstallCommand": "sudo yuktiops-agent uninstall"
  },
  "files": [
    {
      "name": "yuktiops-agent_0.4.1_amd64.deb",
      "os": "linux",
      "arch": "amd64",
      "archLabel": "x86-64",
      "kind": "deb",
      "distro": "Ubuntu / Debian",
      "url": "https://downloads.yuktiops.com/agent/v0.4.1/yuktiops-agent_0.4.1_amd64.deb",
      "sha256": "<64 hex characters>"
    }
  ],
  "checksumsUrl": "https://downloads.yuktiops.com/agent/v0.4.1/checksums.txt",
  "signatureUrl": "https://downloads.yuktiops.com/agent/v0.4.1/checksums.txt.sig",
  "docker": {
    "image": "ghcr.io/yuktiops/agent",
    "tag": "0.4.1",
    "run": "docker run -d --name yuktiops-agent --restart unless-stopped -e YUKTIOPS_API_KEY=<API_KEY> -v yuktiops-agent:/var/lib/yuktiops ghcr.io/yuktiops/agent:0.4.1"
  }
}
```

- `kind` is `deb`, `rpm` or `tar.gz`; `arch` is `amd64`, `arm64` or `armv7`. Files are sorted deb, rpm, tar.gz, then by arch.
- `channel` is `local` when served from `AGENT_DOWNLOADS_DIR`. In that case `installScriptUrl` is `<API_PUBLIC_URL>/downloads/install.sh`, `signatureUrl` is `null`, and `commandTemplate` also contains `--base-url=` and `--api=` so the whole flow works on a laptop.
- The endpoint never sees an API key. The wizard replaces `<API_KEY>` and `<SETUP_ID>` itself.
- Entries of `latest.json` with unsafe names, a malformed SHA-256 or an unknown package type are dropped.

Errors: `404` (local mode, nothing built yet: run `npm run agent:dist`), `503` (origin unreachable and nothing cached).

## `GET /downloads/*` (local development)

Serves `backend/downloads/` as built by `npm run agent:dist`:

```
/downloads/latest.json                       no-cache
/downloads/install.sh                        no-cache   (latest installer)
/downloads/v0.0.0-dev/install.sh             immutable  (pinned copy)
/downloads/v0.0.0-dev/checksums.txt          immutable
/downloads/v0.0.0-dev/yuktiops-agent_0.0.0-dev_linux_amd64.tar.gz   immutable
```

No directory listing, no dotfiles, no path traversal, GET/HEAD only. Archives are sent with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. In production the same layout is served by Cloudflare R2 behind `downloads.yuktiops.com/agent/`.

## `latest.json`

```json
{ "version": "0.4.1", "released": "2026-01-01T00:00:00.000Z", "files": { "<file name>": "<sha256>" } }
```

It is written last by the release pipeline (only after the install smoke test passed) and by `npm run agent:dist`.
