#!/usr/bin/env node
// Maintainer-only vendoring: explicit release tag, HTTPS assets, SHA-256 checks.
// Does not run downloaded executables or modify any user's knowledge bundle.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(version ?? '') || process.argv.slice(3).some(arg => arg !== '--static-linux')) throw Error('Usage: node scripts/update-okf.mjs vX.Y.Z [--static-linux]');
const staticLinux = process.argv.includes('--static-linux');
const root = fileURLToPath(new URL('../', import.meta.url));
const base = `https://github.com/okf-memory/okf-agent-memory/releases/download/${version}`;
const names = ['okf-darwin-amd64', 'okf-darwin-arm64', 'okf-linux-amd64', 'okf-linux-arm64'];
async function download(name) {
  const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw Error(`${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
const checksums = (await download('checksums.txt')).toString('utf8');
const expected = new Map(checksums.trim().split('\n').map(line => {
  const match = /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line.trim());
  if (!match) throw Error(`Invalid checksum line: ${line}`);
  return [match[2], match[1]];
}));
const staging = await mkdtemp(join(tmpdir(), 'okf-vendor-'));
try {
  const binaries = {}, releaseChecksums = {}, sourceBuilds = {};
  for (const name of names) {
    const bytes = await download(name);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== (expected.get(`bin/${name}`) ?? expected.get(name))) throw Error(`Checksum mismatch or missing entry: ${name}`);
    await writeFile(join(staging, name), bytes, { mode: 0o755 });
    binaries[name] = sha256;
    releaseChecksums[name] = sha256;
  }
  if (staticLinux) {
    // Upstream v0.4.3's linux-amd64 release enables CGO and requires glibc.
    // Preserve this package's static Linux portability; never call this at runtime.
    const source = join(staging, 'source');
    execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', version, 'https://github.com/okf-memory/okf-agent-memory.git', source], { stdio: 'pipe' });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    const toolchain = execFileSync('go', ['version'], { encoding: 'utf8' }).trim();
    const args = ['build', '-trimpath', '-ldflags', `-s -w -X main.Version=${version} -X main.Commit=${commit.slice(0, 7)}`, '-o', join(staging, 'okf-linux-amd64'), './cmd/okf'];
    execFileSync('go', args, { cwd: source, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOAMD64: 'v1', GOWORK: 'off', GOFLAGS: '' }, stdio: 'inherit' });
    binaries['okf-linux-amd64'] = createHash('sha256').update(await readFile(join(staging, 'okf-linux-amd64'))).digest('hex');
    sourceBuilds['okf-linux-amd64'] = { commit, toolchain, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOAMD64: 'v1', flags: ['-trimpath', ...args.slice(2, 4)], package: './cmd/okf' };
  }
  for (const name of ['okf-linux-amd64', 'okf-linux-arm64']) {
    const elf = await readFile(join(staging, name));
    const start = Number(elf.readBigUInt64LE(32)), size = elf.readUInt16LE(54), count = elf.readUInt16LE(56);
    for (let i = 0; i < count; i++) {
      if (elf.readUInt32LE(start + i * size) === 3) throw Error(`${name} needs a dynamic interpreter. Retry with --static-linux (requires Go and Git).`);
    }
  }
  await mkdir(join(root, 'bin'), { recursive: true });
  for (const name of names) {
    await copyFile(join(staging, name), join(root, 'bin', name));
    await chmod(join(root, 'bin', name), 0o755);
  }
  await copyFile(join(root, 'bin/okf-linux-amd64'), join(root, 'bin/okf'));
  await chmod(join(root, 'bin/okf'), 0o755);
  binaries.okf = binaries['okf-linux-amd64'];
  await writeFile(join(root, 'bin/UPSTREAM.json'), JSON.stringify({
    repository: 'https://github.com/okf-memory/okf-agent-memory', version,
    checksumsURL: `${base}/checksums.txt`, releaseChecksums, sourceBuilds, binaries,
  }, null, 2) + '\n');
  console.log(`Vendored ${version}; verified upstream assets${staticLinux ? ' and rebuilt static Linux amd64 from the tagged source' : ''} before replacing binaries.`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
