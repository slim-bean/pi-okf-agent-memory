import assert from 'node:assert/strict';
import { test, after, afterEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHarness, waitFor } from './support.mjs';
import { jiti } from './loader.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'pi-okf-managed-'));
const saved = Object.fromEntries(['OKF_BIN', 'OKF_KNOWLEDGE_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map(k => [k, process.env[k]]));
delete process.env.OKF_BIN; delete process.env.OKF_KNOWLEDGE_DIR;
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';
const { resolveOkfBin } = await jiti.import(join(root, 'index.ts'));
const { registerUpgrades } = await jiti.import(join(root, 'lib/upgrade-extension.ts'));
const { UpgradeRunner, UPGRADE_STEPS } = await jiti.import(join(root, 'lib/upgrades.ts'));
const { resolveKnowledgeDir } = await jiti.import(join(root, 'lib/okf.ts'));
const { idleBlocker, UPGRADE_HOST } = await jiti.import(join(root, 'lib/managed-upgrades.ts'));
const binary = resolveOkfBin(), skillsDir = join(root, 'skills');
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let sequence = 0;
const harnesses = [];
function fixture() {
  const cwd = join(work, `fixture-${++sequence}`), bundle = join(cwd, 'knowledge');
  execFileSync(binary, ['init', bundle]);
  git(bundle, 'init', '-q'); git(bundle, 'config', 'user.name', 'Host Tests'); git(bundle, 'config', 'user.email', 'host-tests@example.invalid'); git(bundle, 'config', 'commit.gpgSign', 'false');
  return { cwd, bundle };
}
function harness(cwd, overrides = {}) {
  const h = createHarness(pi => registerUpgrades(pi, { skillsDir, packageVersion, getBinary: () => binary, getBundle: resolveKnowledgeDir, ...overrides }), cwd, { hasUI: false, mode: 'rpc' });
  harnesses.push(h); return h;
}
const runner = (bundle, version = packageVersion, steps = UPGRADE_STEPS) => new UpgradeRunner(bundle, skillsDir, version, steps);
function send(h, request) { h.events.emit(UPGRADE_HOST.request, { protocol: 1, ...request }); }
function binding(h) {
  const id = `status-${++sequence}`; send(h, { id, action: 'status' });
  const response = h.hostResponses.findLast(r => r.id === id);
  assert.equal(response.phase, 'status', JSON.stringify(response));
  return { session: response.session, packageVersion: response.packageVersion, bundle: response.snapshot.status.bundle };
}
function requestRun(h, id = `run-${++sequence}`) {
  const request = { ...binding(h), id, action: 'run', runtimeId: 'sandbox-uid/pod-uid/session-generation-1' };
  send(h, request); return { protocol: 1, ...request };
}
const response = (h, id) => h.hostResponses.findLast(r => r.id === id);
async function launched(h) { await waitFor(() => h.prompts.length === 1, 'upgrade prompt'); await h.emit('agent_start'); }
async function settle(h) { h.ctx.isIdle = () => true; await h.emit('agent_settled'); }
async function terminal(h, id) { await waitFor(() => response(h, id)?.terminal, 'terminal host result'); return response(h, id); }
afterEach(async () => { for (const h of harnesses.splice(0)) await h.emit('session_shutdown', { reason: 'quit' }); });
after(() => {
  rmSync(work, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('host status/start is load-order safe; ordinary startup does nothing without a request', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd);
  send(h, { id: 'early', action: 'status' });
  assert.equal(response(h, 'early').code, 'not_ready');
  await h.emit('session_start', { reason: 'startup' });
  assert.equal(h.hostReady.length, 1);
  binding(h);
  assert.equal(h.prompts.length, 0); assert.equal(h.confirmations.length, 0);
  assert.equal(existsSync(runner(bundle).stateDir), false);
  send(h, { ...binding(h), id: 'bad-target', action: 'run', runtimeId: 'host', bundle: '/another/bundle' });
  assert.equal(response(h, 'bad-target').code, 'binding_mismatch');
  assert.equal(existsSync(runner(bundle).stateDir), false);
});

test('host runs every pending step without dialogs, commits, and releases maintenance only after settle', async () => {
  const { cwd, bundle } = fixture();
  const steps = ['001-first', '002-second'].map(id => ({ ...UPGRADE_STEPS[0], id, title: id }));
  const h = harness(cwd, { steps }); await h.emit('session_start');
  const request = requestRun(h); await launched(h);
  assert.match(h.prompts[0], /HOST-MANAGED REVIEW/);
  assert.match(h.prompts[0], /No interactive user is waiting/);
  assert.equal(h.confirmations.length, 0);
  assert.equal(runner(bundle, packageVersion, steps).lockInfo().runtimeId, request.runtimeId);
  h.ctx.isIdle = () => false;
  await h.call('memory_upgrade', { action: 'complete', step: '001-first' });
  await h.call('memory_upgrade', { action: 'complete', step: '002-second' });
  assert.equal(response(h, request.id).phase, 'finishing');
  assert.equal(response(h, request.id).terminal, false);
  assert.equal(existsSync(runner(bundle).lockPath), true);
  await settle(h);
  const done = await terminal(h, request.id);
  assert.equal(done.phase, 'completed'); assert.equal(done.maintenance.active, false);
  assert.equal(done.target.bundle, request.bundle);
  assert.equal(git(bundle, 'rev-parse', 'HEAD').trim(), done.result.commit);
  assert.equal(existsSync(runner(bundle).lockPath), false);
  assert.equal(h.entries.some(e => e.data.event === 'completed'), true);
  // Duplicate IDs replay the receipt instead of launching another turn/commit.
  send(h, request); assert.equal(response(h, request.id).result.commit, done.result.commit);
  send(h, { ...request, runtimeId: 'different-runtime' });
  assert.equal(response(h, request.id).code, 'id_conflict');
  assert.equal(h.prompts.length, 1); assert.equal(git(bundle, 'rev-list', '--count', 'HEAD').trim(), '1');
});

test('busy agents, pending messages, host maintenance and unresolved tool calls defer launch', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd); await h.emit('session_start');
  h.ctx.isIdle = () => false;
  const req = requestRun(h);
  await waitFor(() => response(h, req.id)?.code === 'agent_busy');
  h.ctx.isIdle = () => true; h.ctx.hasPendingMessages = () => true; await h.emit('agent_settled');
  await waitFor(() => response(h, req.id)?.code === 'pending_messages');
  h.ctx.hasPendingMessages = () => false;
  send(h, { ...binding(h), id: 'hygiene-hold', action: 'hold', key: 'context-hygiene', held: true });
  await waitFor(() => response(h, req.id)?.code === 'host_hold');
  assert.equal(existsSync(runner(bundle).stateDir), false);
  h.ctx.branch = [{ type: 'message', id: 'assistant', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }] } }];
  send(h, { ...binding(h), id: 'hygiene-done', action: 'hold', key: 'context-hygiene', held: false });
  await waitFor(() => response(h, req.id)?.code === 'unresolved_tools');
  h.ctx.branch.push({ type: 'message', id: 'result', message: { role: 'toolResult', toolCallId: 'call', content: [] } });
  await h.emit('agent_settled'); await launched(h);
  send(h, { ...binding(h), id: 'too-late-hold', action: 'hold', key: 'hygiene', held: true });
  assert.equal(response(h, 'too-late-hold').code, 'maintenance_busy');
  await h.call('memory_upgrade', { action: 'block', reason: 'Need an operator decision.' });
  await settle(h);
  assert.equal((await terminal(h, req.id)).code, 'needs_attention');
});

test('an interactive confirmation reserves the slot; disabling the completion tool fails closed', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd); await h.emit('session_start');
  h.ctx.hasUI = true;
  let answer;
  h.ctx.ui.confirm = () => new Promise(resolve => answer = resolve);
  const interactive = h.command();
  const req = requestRun(h);
  await waitFor(() => response(h, req.id)?.code === 'interactive_review_active');
  assert.equal(existsSync(runner(bundle).stateDir), false);
  answer(false); await interactive;
  h.ctx.activeTools = []; await h.emit('agent_settled');
  const failed = await terminal(h, req.id);
  assert.equal(failed.phase, 'blocked'); assert.match(failed.message, /not an active tool/);
  assert.equal(h.prompts.length, 0);
  assert.equal(existsSync(runner(bundle).lockPath), false);
});

test('ordinary input queued by a dispatch observer is rechecked before launching', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd); await h.emit('session_start');
  const off = h.events.on(UPGRADE_HOST.response, r => { if (r.phase === 'running') h.ctx.hasPendingMessages = () => true; });
  const req = requestRun(h);
  await waitFor(() => response(h, req.id)?.code === 'activity_changed');
  assert.equal(h.prompts.length, 0); assert.equal(existsSync(runner(bundle).stateDir), false);
  off(); h.ctx.hasPendingMessages = () => false; await h.emit('agent_settled'); await launched(h);
  await settle(h); assert.equal((await terminal(h, req.id)).phase, 'blocked');
});

test('shutdown detaches listeners and a reused extension rebinds exactly once', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd); await h.emit('session_start');
  const req = requestRun(h); await launched(h);
  await h.emit('session_shutdown');
  assert.equal(response(h, req.id).code, 'runtime_shutdown'); assert.equal(existsSync(runner(bundle).lockPath), false);
  const count = h.hostResponses.length;
  send(h, { id: 'after-shutdown', action: 'status' }); assert.equal(h.hostResponses.length, count);
  await h.emit('session_start', { reason: 'reload' });
  send(h, { id: 'after-reload', action: 'status' });
  assert.equal(h.hostResponses.filter(r => r.id === 'after-reload').length, 1);
  send(h, { ...req, id: 'old-binding' }); assert.equal(response(h, 'old-binding').code, 'binding_mismatch');
});

test('model failure/incomplete review is blocked, not mistaken for completion or retried endlessly', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd); await h.emit('session_start');
  const req = requestRun(h); await launched(h); await settle(h);
  const stopped = await terminal(h, req.id);
  assert.equal(stopped.phase, 'blocked'); assert.equal(stopped.code, 'review_incomplete');
  assert.equal(runner(bundle).status().finished, false);
  assert.equal(existsSync(runner(bundle).lockPath), false);
  send(h, req); assert.equal(h.prompts.length, 1);
});

test('host cancellation never releases a running agent lock early; stale-session requests fail', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd); await h.emit('session_start');
  const req = requestRun(h); await launched(h); h.ctx.isIdle = () => false;
  send(h, { ...binding(h), id: 'cancel', action: 'cancel', runId: req.id });
  assert.equal(response(h, req.id).phase, 'stopping');
  assert.equal(existsSync(runner(bundle).lockPath), true);
  await assert.rejects(h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id }), /finishing or stopping/);
  await settle(h); assert.equal((await terminal(h, req.id)).phase, 'cancelled');
  const old = binding(h); await h.emit('session_start', { reason: 'resume' });
  send(h, { ...req, ...old, id: 'old-request' });
  assert.equal(response(h, 'old-request').code, 'binding_mismatch');
  assert.equal(h.prompts.length, 1);
});

test('queued deadlines are bounded, and running deadlines report without killing or unlocking', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd, { hostTiming: { timeoutMs: 500, pollMs: 10 } });
  await h.emit('session_start'); h.ctx.isIdle = () => false;
  const queued = requestRun(h);
  assert.equal((await terminal(h, queued.id)).code, 'idle_deadline_exceeded');
  assert.equal(existsSync(runner(bundle).stateDir), false);
  h.ctx.isIdle = () => true;
  const running = requestRun(h); await launched(h); h.ctx.isIdle = () => false;
  await waitFor(() => response(h, running.id)?.code === 'deadline_exceeded');
  assert.equal(response(h, running.id).terminal, false);
  assert.equal(existsSync(runner(bundle).lockPath), true);
  await settle(h); assert.equal((await terminal(h, running.id)).phase, 'blocked');
});

test('a missing agent start gets a bounded dispatch failure; cancelling before dispatch starts no work', async () => {
  const { cwd } = fixture(), h = harness(cwd, { hostTiming: { dispatchMs: 150, pollMs: 10 } });
  await h.emit('session_start');
  const req = requestRun(h);
  await waitFor(() => response(h, req.id)?.code === 'dispatch_not_started');
  assert.equal(response(h, req.id).terminal, false); // issued prompt may still execute later
  assert.equal(h.prompts.length, 1);
  await settle(h);
  assert.equal((await terminal(h, req.id)).code, 'dispatch_not_started');
  const off = h.events.on(UPGRADE_HOST.response, r => {
    if (r.id === 'cancel-before-start' && r.phase === 'running') send(h, { ...binding(h), id: 'cancel-race', action: 'cancel', runId: r.id });
  });
  requestRun(h, 'cancel-before-start');
  assert.equal((await terminal(h, 'cancel-before-start')).phase, 'cancelled');
  off(); assert.equal(h.prompts.length, 1);
});

test('input acceptance covers slow preflight; even apparently idle dispatches keep their lease until settled', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd, { hostTiming: { timeoutMs: 500, dispatchMs: 150, pollMs: 10 } });
  await h.emit('session_start'); const req = requestRun(h);
  await waitFor(() => h.prompts.length === 1);
  await h.emit('input', { source: 'extension', text: `[timestamp] ${h.prompts[0]}` });
  // No agent_start yet: a provider/auth preflight may be asynchronous.
  await waitFor(() => response(h, req.id)?.code === 'deadline_exceeded');
  assert.equal(h.hostResponses.some(r => r.id === req.id && r.code === 'dispatch_not_started'), false);
  assert.equal(response(h, req.id).terminal, false);
  assert.equal(existsSync(runner(bundle).lockPath), true);
  await settle(h);
  assert.equal((await terminal(h, req.id)).code, 'deadline_exceeded');
});

test('version-only upgrades adopt the newest installed package without replaying old guides', async () => {
  const { cwd, bundle } = fixture();
  const old = runner(bundle, '0.1.9'); old.acquire(); old.nextInstructions(); old.complete(UPGRADE_STEPS[0].id, binary); old.finalize(binary); old.release();
  const completed = runner(bundle).readState().completed;
  assert.equal(runner(bundle).status().versionPending, true);
  const h = harness(cwd); await h.emit('session_start'); const req = requestRun(h);
  const done = await terminal(h, req.id);
  assert.equal(done.phase, 'completed'); assert.equal(h.prompts.length, 0);
  assert.deepEqual(runner(bundle).readState().completed, completed);
  assert.equal(runner(bundle).readState().application.packageVersion, packageVersion);
  assert.equal(runner(bundle).status().versionPending, false);
  assert.equal(git(bundle, 'rev-list', '--count', 'HEAD').trim(), '2');
  const same = requestRun(h); assert.equal((await terminal(h, same.id)).phase, 'completed');
  assert.equal(git(bundle, 'rev-list', '--count', 'HEAD').trim(), '2');
  assert.throws(() => runner(bundle, '0.1.9').status(), /downgrade refused/);
});

test('cross-pod recovery requires the exact lock and explicit host termination attestation', async () => {
  const { cwd, bundle } = fixture(), h = harness(cwd); await h.emit('session_start');
  const r = runner(bundle); r.acquire('old-pod/generation-7');
  const lock = r.lockInfo();
  // Simulate the old pod disappearing, leaving its persistent lock behind.
  writeFileSync(r.lockPath, JSON.stringify({ ...lock, host: 'retired-pod' }));
  const scope = binding(h);
  send(h, { ...scope, id: 'wrong-token', action: 'recover', lockToken: 'wrong', stoppedRuntimeId: lock.runtimeId, previousRuntimeStopped: true });
  assert.equal(response(h, 'wrong-token').phase, 'blocked');
  send(h, { ...scope, id: 'no-attestation', action: 'recover', lockToken: lock.token, stoppedRuntimeId: lock.runtimeId });
  assert.equal(response(h, 'no-attestation').code, 'invalid_request');
  assert.equal(existsSync(r.lockPath), true);
  send(h, { ...scope, id: 'recovered', action: 'recover', lockToken: lock.token, stoppedRuntimeId: lock.runtimeId, previousRuntimeStopped: true });
  assert.equal(response(h, 'recovered').phase, 'recovered');
  assert.equal(existsSync(r.lockPath), false);
  const local = runner(bundle); local.acquire('live-local');
  send(h, { ...binding(h), id: 'live', action: 'recover', lockToken: local.lockInfo().token, stoppedRuntimeId: 'live-local', previousRuntimeStopped: true });
  assert.equal(response(h, 'live').phase, 'blocked'); assert.equal(local.lockInfo().host, hostname());
  local.release();
});

test('idle pairing guard handles aborted calls, reused IDs, compaction and unreadable state conservatively', () => {
  const h = harness(fixture().cwd);
  const call = (id, stopReason = 'toolUse') => ({ type: 'message', id: `m-${++sequence}`, message: { role: 'assistant', stopReason, content: [{ type: 'toolCall', id, name: 'read', arguments: {} }] } });
  const result = id => ({ type: 'message', id: `r-${++sequence}`, message: { role: 'toolResult', toolCallId: id, content: [] } });
  h.ctx.branch = [call('a', 'aborted'), call('b', 'error')]; assert.equal(idleBlocker(h.ctx), undefined);
  h.ctx.branch = [result('a'), call('a|suffix')]; assert.equal(idleBlocker(h.ctx), 'unresolved_tools');
  h.ctx.branch.push(result('a')); assert.equal(idleBlocker(h.ctx), undefined);
  h.ctx.branch.push(call('a')); assert.equal(idleBlocker(h.ctx), 'unresolved_tools');
  h.ctx.branch.push({ type: 'compaction', id: 'compact', firstKeptEntryId: 'compact', summary: 'summarized', tokensBefore: 42 });
  assert.equal(idleBlocker(h.ctx), undefined);
  h.ctx.sessionManager.getBranch = () => { throw Error('unavailable'); };
  assert.equal(idleBlocker(h.ctx), 'idle_state_unavailable');
});
