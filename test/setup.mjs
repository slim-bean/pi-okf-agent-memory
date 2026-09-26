import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jiti } from './loader.mjs';
import { createHarness, waitFor } from './support.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = realpathSync(mkdtempSync(join(tmpdir(), 'pi-okf-setup-')));
const keys = ['OKF_BIN', 'OKF_KNOWLEDGE_DIR', 'OKF_SETUP_MODE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
for (const k of keys) delete process.env[k];
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';
const { default: extension, resolveOkfBin } = await jiti.import(join(root, 'index.ts'));
const { inspectSetup, setupBundle } = await jiti.import(join(root, 'lib/setup.ts'));
const { UpgradeRunner, UPGRADE_STEPS } = await jiti.import(join(root, 'lib/upgrades.ts'));
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const { default: host } = await jiti.import(join(root, 'examples/managed-host.ts'));
const binary = resolveOkfBin();
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let seq = 0;
function fixture(existing = false) {
  const cwd = join(work, `project ${++seq}`), bundle = join(cwd, 'knowledge');
  mkdirSync(cwd);
  if (existing) execFileSync(binary, ['init', bundle]);
  return { cwd, bundle };
}
function harness(cwd, options = {}) {
  const h = createHarness(extension, cwd, options), responses = [], ready = [];
  h.events.on('okf:setup:response', r => responses.push(r));
  h.events.on('okf:setup:ready', r => ready.push(r));
  let id = 0;
  return Object.assign(h, { responses, ready,
    request(data) { h.events.emit('okf:setup:request', { protocol: 1, id: `setup-${++id}`, ...data }); return responses.at(-1); },
    setup(args = '') { return h.commands['memory-setup'](args, h.ctx); },
    binding() { const r = this.request({ action: 'status' }); return { session: r.session, packageVersion: r.packageVersion, bundle: r.status.bundle, planId: r.status.planId, runtimeId: 'test/runtime' }; },
  });
}
after(() => {
  rmSync(work, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('factory is inert; TUI startup offers setup, decline/status do not write or launch a turn', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd);
  assert.equal(existsSync(bundle), false); assert.equal(h.confirmations.length, 0);
  await h.emit('session_start', { reason: 'startup' });
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0][1], /Initialize Git inside/);
  assert.equal(existsSync(bundle), false);
  await h.setup('status');
  await h.emit('session_start', { reason: 'resume' });
  assert.equal(h.confirmations.length, 1, 'do not repeat declined prompt for same bundle in same runtime');
  assert.equal(h.prompts.length, 0);
  assert.equal(existsSync(bundle), false);
});

test('approved startup creates a valid Git-backed bundle, no identity/commit/ledger/turn', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd); h.ctx.approve = true;
  await h.emit('session_start', { reason: 'startup' });
  assert.equal(inspectSetup(cwd).phase, 'ready');
  assert.equal(git(bundle, 'rev-parse', '--show-toplevel').trim(), bundle);
  assert.equal(existsSync(join(cwd, '.git')), false);
  assert.equal(existsSync(join(bundle, '.pi-okf-memory')), false);
  assert.throws(() => git(bundle, 'rev-parse', '--verify', 'HEAD'));
  assert.throws(() => git(bundle, 'config', '--get', 'user.email'));
  assert.equal(h.prompts.length, 0); assert.equal(h.confirmations.length, 1);
  const before = readFileSync(join(bundle, 'index.md'));
  await h.setup(); await h.emit('session_start', { reason: 'reload' });
  assert.equal(h.confirmations.length, 1); assert.deepEqual(readFileSync(join(bundle, 'index.md')), before);
});

test('existing legacy bundle keeps every byte including completed upgrade records', () => {
  const { cwd, bundle } = fixture(true);
  mkdirSync(join(bundle, '.pi-okf-memory'));
  writeFileSync(join(bundle, '.pi-okf-memory/state.json'), '{"schema":1,"completed":[]}\n');
  const files = ['index.md', 'log.md', '.pi-okf-memory/state.json'];
  const before = files.map(f => readFileSync(join(bundle, f)));
  const status = setupBundle(cwd, binary, inspectSetup(cwd));
  assert.equal(status.phase, 'ready');
  files.forEach((f, i) => assert.deepEqual(readFileSync(join(bundle, f)), before[i]));
  assert.equal(git(bundle, 'ls-files'), '');
});

test('enclosing repository and linked worktrees are reused; unrelated staging untouched', () => {
  const { cwd, bundle } = fixture(); git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'Setup Tests'); git(cwd, 'config', 'user.email', 'tests@example.invalid');
  git(cwd, 'config', 'commit.gpgSign', 'false');
  writeFileSync(join(cwd, 'outside'), 'base'); git(cwd, 'add', 'outside'); git(cwd, 'commit', '-qm', 'base');
  writeFileSync(join(cwd, 'outside'), 'staged'); git(cwd, 'add', 'outside');
  const before = git(cwd, 'diff', '--cached');
  assert.equal(inspectSetup(cwd).initGit, false);
  setupBundle(cwd, binary, inspectSetup(cwd));
  assert.equal(existsSync(join(bundle, '.git')), false); assert.equal(git(cwd, 'diff', '--cached'), before);
  const linked = join(work, `linked ${++seq}`); git(cwd, 'worktree', 'add', '-q', '-b', `branch-${seq}`, linked);
  assert.equal(setupBundle(linked, binary, inspectSetup(linked)).repository, linked);
  assert.equal(existsSync(join(linked, 'knowledge/.git')), false);
});

test('broken Git metadata, bare repos, dangling links and nonempty non-bundles fail closed', () => {
  for (const kind of ['git-file', 'git-dir', 'bare', 'dangling', 'nonempty']) {
    const { cwd, bundle } = fixture(true);
    if (kind === 'git-file') writeFileSync(join(bundle, '.git'), 'gitdir: /nonexistent/okf-test\n');
    if (kind === 'git-dir') mkdirSync(join(bundle, '.git'));
    if (kind === 'bare') { rmSync(bundle, { recursive: true }); git(cwd, 'init', '--bare', '-q', bundle); }
    if (kind === 'dangling') { rmSync(bundle, { recursive: true }); symlinkSync(join(work, 'missing-target'), bundle); }
    if (kind === 'nonempty') rmSync(join(bundle, 'index.md'));
    const status = inspectSetup(cwd);
    assert.equal(status.phase, 'blocked', `${kind}: ${JSON.stringify(status)}`);
    assert.throws(() => setupBundle(cwd, binary, status));
  }
});

test('canonical aliases, missing ancestors, and explicit override never select a fallback', () => {
  const { cwd } = fixture();
  const actual = join(work, `shared ${++seq}`); mkdirSync(actual);
  const alias = join(cwd, 'alias'); symlinkSync(actual, alias);
  process.env.OKF_KNOWLEDGE_DIR = 'alias/new/knowledge';
  try {
    const plan = inspectSetup(cwd); assert.equal(plan.bundle, join(actual, 'new/knowledge'));
    assert.equal(setupBundle(cwd, binary, plan).phase, 'ready');
    assert.equal(existsSync(join(cwd, 'knowledge')), false);
  } finally { delete process.env.OKF_KNOWLEDGE_DIR; }
});

test('changed plans and active/crashed setup or upgrade locks refuse mutation', () => {
  const { cwd, bundle } = fixture(); const plan = inspectSetup(cwd);
  git(cwd, 'init', '-q');
  assert.throws(() => setupBundle(cwd, binary, plan), /plan changed/);
  assert.equal(existsSync(bundle), false);
  mkdirSync(join(cwd, '.knowledge.pi-okf-setup.lock'));
  assert.throws(() => setupBundle(cwd, binary, inspectSetup(cwd)), /setup lock/);
  assert.equal(existsSync(bundle), false);
  const f = fixture(true); mkdirSync(join(f.bundle, '.pi-okf-memory')); writeFileSync(join(f.bundle, '.pi-okf-memory/lock.json'), '{}');
  assert.equal(inspectSetup(f.cwd).phase, 'blocked');
  assert.equal(existsSync(join(f.bundle, '.git')), false);
});

test('RPC/headless/manual TUI startup never opens unsolicited dialogs or writes', async () => {
  for (const options of [{ mode: 'rpc', hasUI: true }, { mode: 'json', hasUI: false }, { mode: 'tui', hasUI: true }]) {
    const { cwd, bundle } = fixture();
    if (options.mode === 'tui') process.env.OKF_SETUP_MODE = 'manual';
    const h = harness(cwd, options); h.ctx.approve = true;
    await h.emit('session_start', { reason: 'startup' });
    assert.equal(h.confirmations.length, 0); assert.equal(existsSync(bundle), false);
    assert.equal(h.request({ action: 'status' }).status.phase, 'needed');
    assert.equal(existsSync(bundle), false);
    await h.emit('session_shutdown'); delete process.env.OKF_SETUP_MODE;
  }
});

test('unattended bound setup request is deterministic and idempotent; no upgrade consent', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd, { mode: 'rpc', hasUI: true });
  assert.equal(h.request({ action: 'status' }).code, 'not_ready');
  await h.emit('session_start', { reason: 'startup' });
  const request = { id: 'run-1', action: 'run', ...h.binding() };
  assert.equal(h.request({ ...request, session: 'stale' }).code, 'binding_mismatch');
  assert.equal(h.request({ ...request, protocol: 9 }).code, 'unsupported_protocol');
  assert.equal(existsSync(bundle), false);
  const done = h.request(request); assert.equal(done.phase, 'completed', JSON.stringify(done));
  assert.deepEqual(h.request(request), done);
  assert.equal(h.request({ ...request, runtimeId: 'different' }).code, 'id_conflict');
  assert.equal(h.request({ action: 'run', ...h.binding() }).phase, 'completed');
  assert.equal(h.confirmations.length, 0); assert.equal(h.prompts.length, 0);
  assert.equal(existsSync(join(bundle, '.pi-okf-memory')), false);
  await assert.rejects(h.call('memory_upgrade', { action: 'next' }), /No user-approved/);
  await h.emit('session_start', { reason: 'reload' });
  assert.equal(h.request(request).code, 'binding_mismatch');
  await h.emit('session_shutdown'); const n = h.responses.length;
  h.request({ action: 'status' }); assert.equal(h.responses.length, n);
});

test('busy or pending-message host setup refuses rather than queueing or mutating', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd, { hasUI: false, mode: 'json' });
  await h.emit('session_start'); const binding = h.binding();
  h.ctx.isIdle = () => false;
  assert.equal(h.request({ action: 'run', ...binding }).code, 'maintenance_busy');
  h.ctx.isIdle = () => true; h.ctx.hasPendingMessages = () => true;
  assert.equal(h.request({ action: 'run', ...binding }).code, 'maintenance_busy');
  assert.equal(existsSync(bundle), false);
});

test('session or path change during interactive consent invalidates approval', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd, { mode: 'rpc' });
  await h.emit('session_start');
  let answer; h.ctx.ui.confirm = () => new Promise(resolve => answer = resolve);
  const pending = h.setup();
  await h.emit('session_start', { reason: 'fork' }); answer(true); await pending;
  assert.equal(existsSync(bundle), false);
  const second = h.setup(); process.env.OKF_KNOWLEDGE_DIR = 'elsewhere'; answer(true); await second;
  delete process.env.OKF_KNOWLEDGE_DIR;
  assert.equal(existsSync(bundle), false); assert.equal(existsSync(join(cwd, 'elsewhere')), false);
});

test('upgrade review is blocked before consent/ledger when setup is missing', async () => {
  const { cwd, bundle } = fixture(true), h = harness(cwd, { mode: 'rpc' });
  await h.emit('session_start'); h.ctx.approve = true; await h.command();
  assert.equal(h.confirmations.length, 0); assert.equal(h.prompts.length, 0);
  assert.equal(existsSync(join(bundle, '.pi-okf-memory')), false);
  assert.match(h.notices.at(-1)[0], /memory-setup/);
});

test('setup respects upgrade host holds and queued maintenance', async () => {
  const { cwd } = fixture(true), h = harness(cwd, { mode: 'rpc' });
  await h.emit('session_start');
  h.events.emit('okf:upgrade:request', { protocol: 1, id: 'up-status', action: 'status' });
  const up = h.hostResponses.at(-1), target = { session: up.session, packageVersion: up.packageVersion, bundle: up.snapshot.status.bundle };
  h.events.emit('okf:upgrade:request', { protocol: 1, id: 'hold', action: 'hold', ...target, key: 'hygiene', held: true });
  assert.equal(h.request({ action: 'run', ...h.binding() }).code, 'maintenance_busy');
  h.events.emit('okf:upgrade:request', { protocol: 1, id: 'release', action: 'hold', ...target, key: 'hygiene', held: false });
  assert.equal(h.request({ action: 'run', ...h.binding() }).phase, 'completed');
  await h.emit('session_shutdown');
});

test('Git errors/redirecting environment and nested corrupt metadata cannot select a wrong repository', () => {
  const { cwd, bundle } = fixture(true);
  const elsewhere = fixture(); git(elsewhere.cwd, 'init', '-q');
  const env = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, PATH: process.env.PATH };
  try {
    process.env.GIT_DIR = join(elsewhere.cwd, '.git'); process.env.GIT_WORK_TREE = elsewhere.cwd;
    assert.equal(inspectSetup(cwd).initGit, true);
    process.env.PATH = '/nonexistent-okf-test';
    const plan = inspectSetup(cwd); assert.equal(plan.phase, 'blocked');
    assert.throws(() => setupBundle(cwd, binary, plan));
    assert.equal(existsSync(join(bundle, '.git')), false);
  } finally {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  git(cwd, 'init', '-q'); mkdirSync(join(bundle, '.git'));
  assert.equal(inspectSetup(cwd).phase, 'blocked', 'broken nested metadata must not be ignored in favor of parent Git');
});

test('legacy finalization failure can be repaired through setup and finalized without replaying review', async () => {
  const { cwd, bundle } = fixture(true);
  const runner = new UpgradeRunner(bundle, join(root, 'skills'), packageVersion);
  runner.acquire(); runner.nextInstructions(); runner.complete(UPGRADE_STEPS[0].id, binary);
  assert.throws(() => runner.finalize(binary), /not a git repository/); runner.release();
  const ledger = readFileSync(runner.statePath, 'utf8');
  const h = harness(cwd); await h.emit('session_start');
  assert.match(h.widgets.get('okf-upgrade').join('\n'), /Memory setup needed/);
  h.ctx.approve = true; await h.setup();
  assert.equal(h.statuses.get('okf-setup'), undefined);
  assert.doesNotMatch((h.widgets.get('okf-upgrade') ?? []).join('\n'), /Memory setup needed|not a git repository/);
  assert.equal(readFileSync(runner.statePath, 'utf8'), ledger);
  git(bundle, 'config', 'user.name', 'Setup Tests'); git(bundle, 'config', 'user.email', 'tests@example.invalid');
  git(bundle, 'config', 'commit.gpgSign', 'false');
  await h.command();
  assert.equal(runner.status().finished, true);
  assert.equal(h.prompts.length, 0, 'Git-only retry must not repeat model review');
  await h.emit('session_shutdown');
});

test('fresh local installation only copies resources; first session uses shared setup', async () => {
  const { cwd, bundle } = fixture();
  execFileSync('bash', [join(root, 'install.sh'), cwd]);
  assert.equal(existsSync(bundle), false); assert.equal(existsSync(join(cwd, '.git')), false);
  const installed = join(cwd, '.pi/extensions/okf-memory');
  assert.equal(existsSync(join(installed, 'lib/setup-extension.ts')), true);
  const { default: copied } = await jiti.import(join(installed, 'index.ts'));
  const h = harness(cwd, { extensionFactory: copied }); h.ctx.approve = true;
  await h.emit('session_start');
  assert.equal(inspectSetup(cwd).phase, 'ready');
  assert.throws(() => git(bundle, 'config', '--get', 'user.name'));
  assert.equal(h.prompts.length, 0);
});

test('opt-in host example handles either load order: setup then upgrade, no dialog', async () => {
  for (const hostFirst of [false, true]) {
    const { cwd } = fixture();
    const h = harness(cwd, { mode: 'tui', extensionFactory: pi => { if (hostFirst) host(pi); extension(pi); if (!hostFirst) host(pi); } });
    await h.emit('session_start', { reason: 'startup' });
    await waitFor(() => h.prompts.length === 1, 'upgrade dispatch');
    assert.equal(inspectSetup(cwd).phase, 'ready');
    assert.equal(h.confirmations.length, 0);
    assert.match(h.prompts[0], /HOST-MANAGED REVIEW/);
    await h.emit('session_shutdown');
  }
});
