import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadsStatic, releasesRoute, buildReleases } from '../src/routes/downloads.js';
import { setup, closeStore, flushRedis } from './helpers.js';

beforeEach(flushRedis); // the releases cache lives in Redis

const SHA = 'a'.repeat(64);
const VERSION = '1.2.3';
let base, dir;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'yuktiops-dl-'));
  dir = join(base, 'downloads');
  mkdirSync(join(dir, `v${VERSION}`), { recursive: true });
  writeFileSync(join(base, 'secret.txt'), 'top secret');
  writeFileSync(join(dir, '.hidden'), 'dotfile');
  writeFileSync(join(dir, 'install.sh'), '#!/usr/bin/env bash\necho hi\n');
  writeFileSync(join(dir, `v${VERSION}`, 'install.sh'), '#!/usr/bin/env bash\necho pinned\n');
  writeFileSync(join(dir, `v${VERSION}`, `yuktiops-agent_${VERSION}_linux_amd64.tar.gz`), 'not really gzip');
  writeFileSync(join(dir, `v${VERSION}`, 'checksums.txt'), `${SHA}  file\n`);
  writeFileSync(
    join(dir, 'latest.json'),
    JSON.stringify({
      version: VERSION,
      released: '2026-01-01T00:00:00.000Z',
      files: {
        [`yuktiops-agent_${VERSION}_linux_arm64.tar.gz`]: SHA,
        [`yuktiops-agent_${VERSION}_linux_amd64.tar.gz`]: SHA,
        [`yuktiops-agent_${VERSION}_amd64.deb`]: SHA,
        [`yuktiops-agent-${VERSION}.aarch64.rpm`]: SHA,
        'checksums.txt': SHA, // not a download
        '../../etc/passwd': SHA, // path tricks are dropped
        'yuktiops-agent_9.9.9_linux_amd64.tar.gz/../x': SHA,
        [`yuktiops-agent_${VERSION}_linux_armv7.tar.gz`]: 'not-a-hash', // bad hash is dropped
      },
    }),
  );
});
after(async () => {
  rmSync(base, { recursive: true, force: true });
  await closeStore();
});

const staticApp = () => express().use('/downloads', downloadsStatic({ dir }));
const releasesApp = (options) =>
  express().use(releasesRoute({ dir, publicApiUrl: 'http://localhost:4000', ...options }));

test('versioned downloads are immutable, with the right content types', async () => {
  const tarball = await request(staticApp()).get(`/downloads/v${VERSION}/yuktiops-agent_${VERSION}_linux_amd64.tar.gz`);
  assert.equal(tarball.status, 200);
  assert.equal(tarball.headers['content-type'], 'application/gzip');
  assert.equal(tarball.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(tarball.headers['content-disposition'], /attachment/);
  assert.equal(tarball.headers['x-content-type-options'], 'nosniff');

  const sums = await request(staticApp()).get(`/downloads/v${VERSION}/checksums.txt`);
  assert.match(sums.headers['content-type'], /^text\/plain/);
  assert.match(sums.headers['cache-control'], /immutable/);
  const pinned = await request(staticApp()).get(`/downloads/v${VERSION}/install.sh`);
  assert.match(pinned.headers['content-type'], /shellscript/);
  assert.match(pinned.headers['cache-control'], /immutable/);
});

test('latest.json and the unversioned installer are never cached', async () => {
  const latest = await request(staticApp()).get('/downloads/latest.json');
  assert.equal(latest.status, 200);
  assert.match(latest.headers['content-type'], /^application\/json/);
  assert.match(latest.headers['cache-control'], /no-cache/);
  assert.equal(latest.body.version, VERSION);
  const installer = await request(staticApp()).get('/downloads/install.sh');
  assert.match(installer.headers['cache-control'], /no-cache/);
  assert.match(installer.text, /^#!\/usr\/bin\/env bash/);
});

test('no directory listings, no dotfiles, no path traversal, read-only', async () => {
  for (const path of ['/downloads', '/downloads/', `/downloads/v${VERSION}`, `/downloads/v${VERSION}/`]) {
    const response = await request(staticApp()).get(path);
    assert.equal(response.status, 404, path);
    assert.ok(!response.text.includes('checksums.txt'), `${path} must not list files`);
  }
  assert.equal((await request(staticApp()).get('/downloads/.hidden')).status, 404);
  for (const path of [
    '/downloads/..%2fsecret.txt',
    '/downloads/%2e%2e/secret.txt',
    '/downloads/..%5csecret.txt',
    '/downloads/v1.2.3/..%2f..%2fsecret.txt',
    '/downloads/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/downloads/..\\secret.txt',
  ]) {
    const response = await request(staticApp()).get(path);
    assert.ok([400, 403, 404].includes(response.status), `${path} -> ${response.status}`);
    assert.ok(!response.text.includes('top secret'), path);
  }
  assert.equal((await request(staticApp()).post('/downloads/latest.json')).status, 404);
  assert.equal((await request(staticApp()).delete(`/downloads/v${VERSION}/checksums.txt`)).status, 404);
  assert.equal((await request(staticApp()).head('/downloads/latest.json')).status, 200);
});

test('GET /api/agent/releases lists packages for every OS/arch, publicly and cacheably', async () => {
  const response = await request(releasesApp()).get('/api/agent/releases');
  assert.equal(response.status, 200);
  assert.match(response.headers['cache-control'], /max-age=300/);
  const body = response.body;
  assert.equal(body.version, VERSION);
  assert.equal(body.channel, 'local');
  assert.deepEqual(
    body.files.map((f) => `${f.kind}:${f.arch}`),
    ['deb:amd64', 'rpm:arm64', 'tar.gz:amd64', 'tar.gz:arm64'],
    'unsafe names and bad hashes are dropped; deb, rpm, tar.gz in that order',
  );
  const deb = body.files[0];
  assert.equal(deb.url, `http://localhost:4000/downloads/v${VERSION}/yuktiops-agent_${VERSION}_amd64.deb`);
  assert.equal(deb.sha256, SHA);
  assert.equal(deb.os, 'linux');
  assert.equal(body.docker.image, 'ghcr.io/yuktiops/agent');
  assert.match(body.install.commandTemplate, /--base-url=http:\/\/localhost:4000\/downloads/);
  assert.match(body.install.commandTemplate, /--key=<API_KEY>/);
  assert.equal(body.checksumsUrl, `http://localhost:4000/downloads/v${VERSION}/checksums.txt`);
});

test('releases: 404 when nothing was built locally', async () => {
  const response = await request(releasesApp({ dir: join(base, 'empty') })).get('/api/agent/releases');
  assert.equal(response.status, 404);
  assert.match(response.body.error, /agent:dist/);
});

test('releases from the production base URL are fetched once per 5 minutes and survive an outage', async () => {
  let calls = 0;
  let failing = false;
  let clock = 1_000_000;
  const fetchImpl = async (url) => {
    calls++;
    assert.equal(url, 'https://downloads.yuktiops.com/agent/latest.json');
    if (failing) return new Response('nope', { status: 500 });
    return new Response(JSON.stringify({ version: '0.4.1', files: { 'yuktiops-agent_0.4.1_amd64.deb': SHA } }));
  };
  const app = releasesApp({
    baseUrl: 'https://downloads.yuktiops.com/agent/',
    fetchImpl,
    now: () => clock,
  });
  const first = await request(app).get('/api/agent/releases');
  assert.equal(first.status, 200);
  assert.equal(first.body.channel, 'production');
  assert.equal(first.body.files[0].url, 'https://downloads.yuktiops.com/agent/v0.4.1/yuktiops-agent_0.4.1_amd64.deb');
  assert.match(first.body.install.commandTemplate, /^curl -fsSL https:\/\/get\.yuktiops\.com \| sudo bash/);
  await request(app).get('/api/agent/releases');
  assert.equal(calls, 1, 'a second request inside 5 minutes is served from the cache');
  clock += 5 * 60000 + 1;
  failing = true;
  const stale = await request(app).get('/api/agent/releases');
  assert.equal(calls, 2);
  assert.equal(stale.status, 200, 'the last good answer is served while the origin is down');
  assert.equal(stale.body.version, '0.4.1');
  await request(app).get('/api/agent/releases');
  assert.equal(calls, 2, 'a failed refresh is not retried on every request');

  const fresh = releasesApp({
    baseUrl: 'https://downloads.yuktiops.com/agent',
    fetchImpl,
    cacheNamespace: 'fresh',
  });
  const down = await request(fresh).get('/api/agent/releases');
  assert.equal(down.status, 503);
});

test('releases refuse an insecure production base URL and a bad latest.json', async () => {
  assert.throws(() => releasesRoute({ baseUrl: 'http://downloads.example.com/agent' }), /https/);
  assert.doesNotThrow(() => releasesRoute({ baseUrl: 'http://localhost:9000/agent' }));
  assert.throws(() => buildReleases({ version: '../1' }, { baseUrl: 'https://x', local: false }), /valid version/);
  const app = releasesApp({
    baseUrl: 'https://downloads.yuktiops.com/agent',
    fetchImpl: async () => new Response('{"version":"evil\\u0000"}'),
  });
  assert.equal((await request(app).get('/api/agent/releases')).status, 503);
});

test('the real app serves /downloads and /api/agent/releases without a session', async () => {
  process.env.AGENT_DOWNLOADS_DIR = dir;
  delete process.env.AGENT_DOWNLOADS_BASE_URL;
  const { app } = await setup();
  const releases = await request(app).get('/api/agent/releases');
  assert.equal(releases.status, 200, releases.text);
  assert.equal(releases.body.version, VERSION);
  const file = await request(app).get(`/downloads/v${VERSION}/checksums.txt`);
  assert.equal(file.status, 200);
  assert.equal((await request(app).get('/downloads/')).status, 404);
  delete process.env.AGENT_DOWNLOADS_DIR;
});
