#!/usr/bin/env node
// Builds the YuktiOps agent.
//
//   node agent/scripts/dist.mjs            cross-compile linux amd64/arm64/armv7 into backend/downloads/
//   node agent/scripts/dist.mjs --host     build one binary for this machine into agent/bin/
//   node agent/scripts/dist.mjs --test     go vet + go test (with the race detector when it can)
//
// Options: --version=X.Y.Z (default 0.0.0-dev), --out=DIR (default backend/downloads).
// Uses the local Go toolchain when there is one (PATH, GO env var, or GOROOT), otherwise the
// golang Docker image. The archives are written deterministically (no timestamps, owner root).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentDir = join(root, 'agent');
const GO_IMAGE = 'golang:1.24';
const targets = [
  { arch: 'amd64', goarch: 'amd64' },
  { arch: 'arm64', goarch: 'arm64' },
  { arch: 'armv7', goarch: 'arm', goarm: '7' },
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const version = (option('version', process.env.AGENT_VERSION || '0.0.0-dev') || '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid version "${version}". Use something like 0.4.1 or 0.0.0-dev.`);
  process.exit(2);
}

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) {
    console.error(`\nCommand failed: ${cmd} ${cmdArgs.join(' ')}`);
    process.exit(result.status || 1);
  }
}

function findGo() {
  const candidates = [process.env.GO, process.env.GOROOT && join(process.env.GOROOT, 'bin', 'go'), 'go'].filter(Boolean);
  for (const c of candidates) {
    const probe = spawnSync(c, ['version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return c;
  }
  return null;
}

function haveDocker() {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

const gitCommit = () => {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', cwd: root });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
};

const go = findGo();
if (!go && !haveDocker()) {
  console.error('Go is not installed and Docker is not available. Install Go 1.24+ (https://go.dev/dl/) or Docker.');
  process.exit(1);
}
console.log(go ? `Using Go: ${go}` : `Go not found, using Docker image ${GO_IMAGE}`);

/** Runs `go <goArgs>` inside agent/ with extra environment, locally or in Docker. */
function runGo(goArgs, env = {}, mounts = []) {
  if (go) return run(go, goArgs, { cwd: agentDir, env: { ...process.env, ...env } });
  const dockerArgs = ['run', '--rm', '-v', `${agentDir.replaceAll('\\', '/')}:/src`, '-w', '/src', '-v', 'yuktiops-gocache:/root/.cache', '-v', 'yuktiops-gomod:/go/pkg'];
  for (const [host, container] of mounts) dockerArgs.push('-v', `${host.replaceAll('\\', '/')}:${container}`);
  for (const [k, v] of Object.entries(env)) dockerArgs.push('-e', `${k}=${v}`);
  return run('docker', [...dockerArgs, GO_IMAGE, 'go', ...goArgs]);
}

if (flag('test')) {
  runGo(['vet', './...']);
  // The race detector needs cgo; in Docker it is available, locally only with a C compiler.
  const race = !go || spawnSync('gcc', ['--version']).status === 0 ? ['-race'] : [];
  runGo(['test', ...race, '-count=1', './...']);
  process.exit(0);
}

const ldflags = (extra = '') =>
  `-s -w -X main.version=${version} -X main.commit=${gitCommit()} -X main.date=${new Date().toISOString().slice(0, 10)} ${extra}`.trim();

function build(target, outFile) {
  const outDir = dirname(outFile);
  mkdirSync(outDir, { recursive: true });
  const env = { CGO_ENABLED: '0', GOOS: target.goos || 'linux', GOARCH: target.goarch, ...(target.goarm ? { GOARM: target.goarm } : {}) };
  const goOut = go ? outFile : `/out/${outFile.split(/[\\/]/).pop()}`;
  runGo(['build', '-trimpath', '-ldflags', ldflags(), '-o', goOut, './cmd/yuktiops-agent'], env, go ? [] : [[outDir, '/out']]);
}

if (flag('host')) {
  const goos = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[os.platform()] || os.platform();
  const goarch = { x64: 'amd64', arm64: 'arm64', arm: 'arm' }[os.arch()] || os.arch();
  // Without a local Go toolchain the Docker image builds a Linux binary, whatever this machine is.
  const file = join(agentDir, 'bin', `yuktiops-agent${go && goos === 'windows' ? '.exe' : ''}`);
  build(go ? { goos, goarch } : { goos: 'linux', goarch }, file);
  console.log(`\nBuilt ${file}`);
  process.exit(0);
}

// ---- release layout -----------------------------------------------------------------------------

/** A minimal, deterministic ustar archive: root-owned, mtime 0. */
function tar(entries) {
  const blocks = [];
  for (const { name, data, mode } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(mode.toString(8).padStart(7, '0') + '\0', 100);
    header.write('0000000\0', 108); // uid
    header.write('0000000\0', 116); // gid
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); // mtime
    header.write('        ', 148); // checksum placeholder
    header.write('0', 156); // regular file
    header.write('ustar\0' + '00', 257);
    header.write('root', 265);
    header.write('root', 297);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const outRoot = resolve(option('out', join(root, 'backend', 'downloads')));
const versionDir = join(outRoot, `v${version}`);
const work = join(agentDir, 'dist', 'work');
rmSync(work, { recursive: true, force: true });
mkdirSync(versionDir, { recursive: true });

const unit = readFileSync(join(agentDir, 'packaging', 'yuktiops-agent.service'));
const readme = existsSync(join(agentDir, 'README.md')) ? readFileSync(join(agentDir, 'README.md')) : Buffer.from('YuktiOps agent\n');
const files = {};
for (const target of targets) {
  const binary = join(work, target.arch, 'yuktiops-agent');
  console.log(`\nBuilding linux/${target.arch} ...`);
  build({ goos: 'linux', ...target }, binary);
  const archive = gzipSync(
    tar([
      { name: 'yuktiops-agent', data: readFileSync(binary), mode: 0o755 },
      { name: 'yuktiops-agent.service', data: unit, mode: 0o644 },
      { name: 'README.md', data: readme, mode: 0o644 },
    ]),
    { level: 9, mtime: 0 },
  );
  const name = `yuktiops-agent_${version}_linux_${target.arch}.tar.gz`;
  writeFileSync(join(versionDir, name), archive);
  files[name] = sha256(archive);
  console.log(`  ${name}  ${(archive.length / 1024 / 1024).toFixed(1)} MB`);
}
rmSync(work, { recursive: true, force: true });

const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(versionDir, 'checksums.txt'), Object.entries(sorted).map(([n, h]) => `${h}  ${n}`).join('\n') + '\n');
writeFileSync(join(outRoot, 'latest.json'), JSON.stringify({ version, released: new Date().toISOString(), files: sorted }, null, 2) + '\n');
const installer = join(agentDir, 'scripts', 'install.sh');
copyFileSync(installer, join(outRoot, 'install.sh'));
copyFileSync(installer, join(versionDir, 'install.sh'));
console.log(`\nWrote ${versionDir}\nWrote ${join(outRoot, 'latest.json')} and install.sh`);
console.log('Serve them with the API (npm run dev) at http://localhost:4000/downloads/ and install with:');
console.log('  curl -fsSL http://localhost:4000/downloads/install.sh | sudo bash -s -- --base-url=http://localhost:4000/downloads --api=http://localhost:4000 --key=yk_live_...');
