// Real pi startup/command/confirmation smoke test. Isolated settings, offline,
// no credentials/model requests: decline interactive review, then finalize an
// already-reviewed fixture through the real in-process host protocol.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jiti, piPackageDir } from './loader.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'pi-okf-rpc-'));
const { UpgradeRunner, UPGRADE_STEPS } = await jiti.import(join(root, 'lib/upgrades.ts'));
const bundle = join(work, 'knowledge');
const binary = join(root, 'bin', `okf-${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`);
const bridge = join(work, 'host-bridge.ts');
writeFileSync(bridge, `export default function(pi) {
  let ctx;
  pi.events.on('okf:setup:response', r => {
    if (r.id === 'setup-status' && r.phase === 'status') pi.events.emit('okf:setup:request', {
      protocol: 1, id: 'setup-run', action: 'run', runtimeId: 'rpc-test/runtime-1',
      session: r.session, bundle: r.status.bundle, planId: r.status.planId, packageVersion: r.packageVersion,
    });
    if (r.id === 'setup-run') ctx.ui.notify('SETUP_RESULT:' + JSON.stringify(r), 'info');
  });
  pi.registerCommand('test-host-setup', { handler: (_args, nextCtx) => {
    ctx = nextCtx; pi.events.emit('okf:setup:request', { protocol: 1, id: 'setup-status', action: 'status' });
  }});
  pi.events.on('okf:upgrade:response', r => {
    if (r.id === 'host-status' && r.phase === 'status') pi.events.emit('okf:upgrade:request', {
      protocol: 1, id: 'host-run', action: 'run', runtimeId: 'rpc-test/runtime-1',
      session: r.session, bundle: r.snapshot.status.bundle, packageVersion: r.packageVersion,
    });
    if (r.id === 'host-run' && r.terminal) ctx.ui.notify('HOST_RESULT:' + JSON.stringify(r), 'info');
  });
  pi.registerCommand('test-host-upgrade', { handler: (_args, nextCtx) => {
    ctx = nextCtx; pi.events.emit('okf:upgrade:request', { protocol: 1, id: 'host-status', action: 'status' });
  }});
}`);
const manifest = JSON.parse(readFileSync(join(piPackageDir, 'package.json'), 'utf8'));
const cli = join(piPackageDir, typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.pi);
const child = spawn(process.execPath, [cli,
  '--mode', 'rpc', '--no-session', '--offline', '--no-extensions', '--no-skills',
  '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve',
  '-e', join(root, 'index.ts'), '-e', bridge], {
  cwd: work,
  env: { PATH: process.env.PATH, HOME: work, PI_CODING_AGENT_DIR: join(work, 'agent'), PI_OFFLINE: '1', TERM: 'dumb', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const records = [], waiters = new Set();
let buffer = '', stderr = '', exited = false;
const exit = new Promise(resolve => child.on('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
child.stderr.setEncoding('utf8');
child.stderr.on('data', text => stderr += text);
child.stdout.setEncoding('utf8');
child.stdout.on('data', text => {
  buffer += text;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try { records.push(JSON.parse(line)); }
    catch { stderr += `\nInvalid RPC record: ${line}`; }
    for (const check of [...waiters]) check();
  }
});
function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(Error(`RPC timeout. stderr: ${stderr}\nRecords: ${JSON.stringify(records)}`)); }, 20_000);
    function check() {
      const record = records.find(predicate);
      if (record) { clearTimeout(timer); waiters.delete(check); resolve(record); }
    }
    waiters.add(check); check();
  });
}
const send = record => child.stdin.write(JSON.stringify(record) + '\n');
try {
  send({ id: 'commands', type: 'get_commands' });
  const commands = await waitFor(r => r.type === 'response' && r.id === 'commands');
  assert.equal(commands.success, true, JSON.stringify(commands));
  assert.ok(commands.data.commands.some(c => c.name === 'memory-upgrade'));
  assert.ok(commands.data.commands.some(c => c.name === 'memory-setup'));
  const notice = await waitFor(r => r.type === 'extension_ui_request' && r.method === 'notify' && r.message.includes('/memory-setup'));
  assert.match(notice.message, /setup needed/);
  assert.equal(existsSync(bundle), false);
  assert.equal(records.some(r => r.method === 'confirm'), false, 'no unsolicited RPC startup dialog');
  send({ id: 'setup-decline', type: 'prompt', message: '/memory-setup' });
  const setupDialog = await waitFor(r => r.type === 'extension_ui_request' && r.method === 'confirm');
  assert.match(setupDialog.message, /Initialize Git inside/);
  send({ type: 'extension_ui_response', id: setupDialog.id, confirmed: false });
  assert.equal((await waitFor(r => r.type === 'response' && r.id === 'setup-decline')).success, true);
  assert.equal(existsSync(bundle), false);
  send({ id: 'setup-host', type: 'prompt', message: '/test-host-setup' });
  assert.equal((await waitFor(r => r.type === 'response' && r.id === 'setup-host')).success, true);
  const setupReceipt = await waitFor(r => r.method === 'notify' && r.message.startsWith('SETUP_RESULT:'));
  const setupResult = JSON.parse(setupReceipt.message.slice('SETUP_RESULT:'.length));
  assert.equal(setupResult.phase, 'completed', JSON.stringify(setupResult));
  assert.equal(existsSync(join(bundle, '.git')), true);
  assert.equal(existsSync(join(bundle, '.pi-okf-memory')), false);
  send({ id: 'status', type: 'prompt', message: '/memory-upgrade status' });
  assert.equal((await waitFor(r => r.type === 'response' && r.id === 'status')).success, true);
  send({ id: 'review', type: 'prompt', message: '/memory-upgrade' });
  const dialog = await waitFor(r => r.type === 'extension_ui_request' && r.method === 'confirm' && r.id !== setupDialog.id);
  assert.match(dialog.message, /001-validation-contract/);
  send({ type: 'extension_ui_response', id: dialog.id, confirmed: false });
  assert.equal((await waitFor(r => r.type === 'response' && r.id === 'review')).success, true);
  assert.equal(existsSync(join(bundle, '.pi-okf-memory')), false);
  // Seed only test-owned review progress. No paid model is needed to exercise
  // real host consent, idle scheduling, final commit and terminal receipts.
  const git = (...args) => execFileSync('git', ['-C', bundle, ...args], { encoding: 'utf8', env: { ...process.env, HOME: work, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('config', 'user.name', 'RPC Tests'); git('config', 'user.email', 'rpc-tests@example.invalid'); git('config', 'commit.gpgSign', 'false');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const runner = new UpgradeRunner(bundle, join(root, 'skills'), version);
  runner.acquire(); runner.nextInstructions(); runner.complete(UPGRADE_STEPS[0].id, binary); runner.release();
  send({ id: 'host', type: 'prompt', message: '/test-host-upgrade' });
  assert.equal((await waitFor(r => r.type === 'response' && r.id === 'host')).success, true);
  const receipt = await waitFor(r => r.type === 'extension_ui_request' && r.method === 'notify' && r.message.startsWith('HOST_RESULT:'));
  const completed = JSON.parse(receipt.message.slice('HOST_RESULT:'.length));
  assert.equal(completed.phase, 'completed', JSON.stringify(completed));
  assert.equal(completed.maintenance.active, false);
  assert.equal(git('rev-parse', 'HEAD').trim(), completed.result.commit);
  assert.equal(records.filter(r => r.type === 'extension_ui_request' && r.method === 'confirm').length, 2);
  child.stdin.end();
  const outcome = await Promise.race([exit, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error('Pi failed to shut down')), 10_000); timer.unref();
  })]);
  assert.equal(outcome.code, 0, stderr);
  assert.equal(records.some(r => r.type === 'agent_start'), false, 'must not start an agent turn');
  assert.doesNotMatch(stderr, /Failed to load extension|Error loading extension/);
  console.log('PASS real pi RPC: read-only startup, setup/upgrade declines, unattended setup + finalization receipt, no model turn');
} finally {
  if (!exited) { child.kill('SIGTERM'); await exit; }
  rmSync(work, { recursive: true, force: true });
}
