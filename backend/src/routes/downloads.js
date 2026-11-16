import { Router } from 'express';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config, root } from '../config.js';
import { getRedis } from '../lib/redis.js';

const CACHE_MS = 5 * 60000;
const MAX_LATEST_BYTES = 256 * 1024;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,150}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;

export const DOCKER_IMAGE = 'ghcr.io/yuktiops/agent';

const MIME = {
  '.tar.gz': 'application/gzip',
  '.gz': 'application/gzip',
  '.deb': 'application/vnd.debian.binary-package',
  '.rpm': 'application/x-rpm',
  '.json': 'application/json; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.sig': 'text/plain; charset=utf-8',
  '.pem': 'text/plain; charset=utf-8',
};
const mimeFor = (path) => {
  const lower = path.toLowerCase();
  const hit = Object.keys(MIME)
    .filter((ext) => lower.endsWith(ext))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? MIME[hit] : 'application/octet-stream';
};

/** Static files of `npm run agent:dist`, served at /downloads for local development. */
export function downloadsStatic({ dir = downloadsDir() } = {}) {
  const router = Router();
  router.use(
    express.static(resolve(dir), {
      index: false, // never list a directory
      redirect: false,
      dotfiles: 'ignore',
      extensions: false,
      etag: true,
      lastModified: true,
      cacheControl: false, // set below, per file
      setHeaders(res, path) {
        res.setHeader('Content-Type', mimeFor(path));
        // Anything under v<version>/ never changes; latest.json and the root install.sh do.
        const versioned = /[\\/]v\d+\.\d+\.\d+[^\\/]*[\\/]/.test(path);
        res.setHeader(
          'Cache-Control',
          versioned ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate',
        );
        if (/\.(tar\.gz|deb|rpm)$/i.test(path))
          res.setHeader('Content-Disposition', 'attachment');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    }),
  );
  router.use((req, res) => res.status(404).type('text/plain').send('Not found.'));
  return router;
}

export function downloadsDir() {
  return process.env.AGENT_DOWNLOADS_DIR || join(root, 'backend', 'downloads');
}

function classify(name) {
  let m = /^yuktiops-agent_[^_]+_linux_(amd64|arm64|armv7)\.tar\.gz$/.exec(name);
  if (m) return { arch: m[1], kind: 'tar.gz', distro: 'Other Linux' };
  m = /^yuktiops-agent_[^_]+_(amd64|arm64|armv7)\.deb$/.exec(name);
  if (m) return { arch: m[1], kind: 'deb', distro: 'Ubuntu / Debian' };
  m = /^yuktiops-agent-.+\.(x86_64|aarch64|armv7hl)\.rpm$/.exec(name);
  if (m)
    return {
      arch: { x86_64: 'amd64', aarch64: 'arm64', armv7hl: 'armv7' }[m[1]],
      kind: 'rpm',
      distro: 'RHEL / Rocky / Alma / Amazon Linux',
    };
  return null;
}

const ARCH_LABEL = { amd64: 'x86-64', arm64: 'ARM64', armv7: 'ARMv7' };

/** Turns a validated latest.json into the public releases document. */
export function buildReleases(latest, { baseUrl, local, publicApiUrl }) {
  const version = String(latest?.version ?? '');
  if (!VERSION.test(version)) throw new Error('latest.json has no valid version.');
  const files = [];
  for (const [name, sha256] of Object.entries(latest.files ?? {})) {
    if (!FILE_NAME.test(name) || !SHA256.test(String(sha256))) continue;
    const info = classify(name);
    if (!info) continue;
    files.push({
      name,
      os: 'linux',
      arch: info.arch,
      archLabel: ARCH_LABEL[info.arch],
      kind: info.kind,
      distro: info.distro,
      url: `${baseUrl}/v${version}/${name}`,
      sha256,
    });
  }
  const order = { deb: 0, rpm: 1, 'tar.gz': 2 };
  files.sort((a, b) => order[a.kind] - order[b.kind] || a.arch.localeCompare(b.arch));
  const installerBase = local ? `${publicApiUrl}/downloads` : null;
  const installScriptUrl = installerBase ? `${installerBase}/install.sh` : 'https://get.yuktiops.com';
  const flags = local ? ` --base-url=${baseUrl} --api=${publicApiUrl}` : '';
  return {
    version,
    released: typeof latest.released === 'string' ? latest.released.slice(0, 40) : null,
    baseUrl,
    channel: local ? 'local' : 'production',
    installScriptUrl,
    install: {
      // The wizard fills in the placeholders; the API key is never known to this endpoint.
      commandTemplate: `curl -fsSL ${installScriptUrl} | sudo bash -s --${flags} --key=<API_KEY> [--setup=<SETUP_ID>]`,
      uninstallCommand: 'sudo yuktiops-agent uninstall',
    },
    files,
    checksumsUrl: `${baseUrl}/v${version}/checksums.txt`,
    signatureUrl: local ? null : `${baseUrl}/v${version}/checksums.txt.sig`,
    docker: {
      image: DOCKER_IMAGE,
      tag: version,
      run: `docker run -d --name yuktiops-agent --restart unless-stopped -e YUKTIOPS_API_KEY=<API_KEY> -v yuktiops-agent:/var/lib/yuktiops ${DOCKER_IMAGE}:${version}`,
    },
  };
}

/**
 * GET /api/agent/releases: public, cached for 5 minutes. latest.json comes from
 * AGENT_DOWNLOADS_BASE_URL (production: https://downloads.yuktiops.com/agent) or, when that is not
 * set, from the local backend/downloads directory built by `npm run agent:dist`.
 */
export function releasesRoute({
  baseUrl = process.env.AGENT_DOWNLOADS_BASE_URL,
  dir = downloadsDir(),
  fetchImpl = fetch,
  now = Date.now,
  publicApiUrl = config.API_PUBLIC_URL,
  cacheNamespace,
} = {}) {
  const remote = baseUrl ? baseUrl.replace(/\/+$/, '') : null;
  if (remote && !remote.startsWith('https://') && !LOOPBACK.test(remote))
    throw new Error('AGENT_DOWNLOADS_BASE_URL must use https (http is only allowed for localhost).');
  // The last good answer lives in Redis so every instance shares it: { at, body }.
  const cacheKey = `releases:${createHash('sha1')
    .update(cacheNamespace || `${remote || resolve(dir)}|${publicApiUrl}`)
    .digest('hex')}`;
  const readCache = async () => JSON.parse((await getRedis().get(cacheKey)) || 'null');
  const writeCache = (value) => getRedis().set(cacheKey, JSON.stringify(value), 'EX', 86400);
  const router = Router();

  async function load() {
    if (remote) {
      const response = await fetchImpl(`${remote}/latest.json`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`latest.json returned ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_LATEST_BYTES) throw new Error('latest.json is too large');
      return buildReleases(JSON.parse(text), { baseUrl: remote, local: false, publicApiUrl });
    }
    const text = await readFile(join(resolve(dir), 'latest.json'), 'utf8');
    if (text.length > MAX_LATEST_BYTES) throw new Error('latest.json is too large');
    return buildReleases(JSON.parse(text), {
      baseUrl: `${publicApiUrl}/downloads`,
      local: true,
      publicApiUrl,
    });
  }

  router.get('/api/agent/releases', async (req, res) => {
    let cached = await readCache();
    if (!cached || now() - cached.at > CACHE_MS) {
      try {
        cached = { at: now(), body: await load() };
        await writeCache(cached);
      } catch (error) {
        if (!cached) {
          if (!remote && error.code === 'ENOENT')
            return res
              .status(404)
              .json({ error: 'No agent release has been published yet. Run: npm run agent:dist' });
          console.error(`agent releases unavailable: ${error.message}`);
          return res.status(503).json({ error: 'Agent downloads are temporarily unavailable.' });
        }
        // Keep serving the last good answer, and retry in a minute rather than on every request.
        cached = { at: now() - CACHE_MS + 60000, body: cached.body };
        await writeCache(cached);
      }
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.json(cached.body);
  });
  return router;
}
