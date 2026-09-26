import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createHash } from 'node:crypto';
import { createHarness } from './support.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jiti } from './loader.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'pi-okf-test-'));
const env = { OKF_BIN: process.env.OKF_BIN, OKF_KNOWLEDGE_DIR: process.env.OKF_KNOWLEDGE_DIR, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.OKF_BIN;
delete process.env.OKF_KNOWLEDGE_DIR;
const { default: extension, resolveOkfBin } = await jiti.import(join(root, 'index.ts'));
const { UpgradeRunner, UPGRADE_STEPS } = await jiti.import(join(root, 'lib/upgrades.ts'));
const { registerUpgrades } = await jiti.import(join(root, 'lib/upgrade-extension.ts'));
const { validateBundle, resolveKnowledgeDir } = await jiti.import(join(root, 'lib/okf.ts'));
const binary = resolveOkfBin();
const skills = join(root, 'skills');
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const cli = (...args) => execFileSync(binary, args, { encoding: 'utf8' });
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function initGit(cwd) {
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'user.name', 'Memory Tests');
  git(cwd, 'config', 'user.email', 'memory-tests@example.invalid');
  git(cwd, 'config', 'commit.gpgSign', 'false');
}
let sequence = 0;
function fixture({ empty = false, withGit = true } = {}) {
  const cwd = join(work, `project ${++sequence}`);
  const bundle = join(cwd, 'knowledge');
  cli('init', bundle);
  if (withGit) initGit(bundle);
  if (!empty) {
    cli('create', 'decisions/storage', bundle, '--type', 'Decision', '--title', 'Storage choice', '--desc', 'Keep memory local for privacy.', '--body', 'Local storage avoids remote exposure.');
    cli('create', 'decisions/privacy', bundle, '--type', 'Decision', '--title', 'Privacy', '--desc', 'Minimize data exposure.');
    cli('relate', 'decisions/storage', 'decisions/privacy', bundle, '--desc', 'motivated by privacy');
  }
  return { cwd, bundle };
}
function runner(bundle, steps = UPGRADE_STEPS) { return new UpgradeRunner(bundle, skills, packageVersion, steps); }
const harness = (cwd, options) => createHarness(extension, cwd, options);
function setFrontmatter(bundle, text) {
  const file = join(bundle, 'decisions/storage.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('---\n', `---\n${text}\n`));
}
after(() => {
  rmSync(work, { recursive: true, force: true });
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('vendored version, executable selection, checksums, explicit override failure', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'bin/UPSTREAM.json'), 'utf8'));
  assert.equal(manifest.version, 'v0.4.3');
  assert.match(cli('--version'), /v0\.4\.3/);
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  assert.equal(binary, join(root, `bin/okf-${process.platform}-${arch}`));
  for (const [name, sha] of Object.entries(manifest.binaries)) assert.equal(createHash('sha256').update(readFileSync(join(root, 'bin', name))).digest('hex'), sha);
  assert.equal(manifest.sourceBuilds['okf-linux-amd64'].CGO_ENABLED, '0');
  for (const name of ['okf-linux-amd64', 'okf-linux-arm64']) {
    const elf = readFileSync(join(root, 'bin', name));
    assert.deepEqual([...elf.subarray(0, 5)], [0x7f, 0x45, 0x4c, 0x46, 2]);
    const start = Number(elf.readBigUInt64LE(32)), size = elf.readUInt16LE(54), count = elf.readUInt16LE(56);
    for (let i = 0; i < count; i++) assert.notEqual(elf.readUInt32LE(start + i * size), 3, `${name} must not require a dynamic interpreter`);
  }
  process.env.OKF_BIN = join(work, 'missing-binary');
  assert.equal(resolveOkfBin(), process.env.OKF_BIN);
  delete process.env.OKF_BIN;
});

test('startup notices, status, and reload are read-only and do not trigger a turn', async () => {
  const { cwd, bundle } = fixture();
  const h = harness(cwd);
  const before = readdirSync(bundle);
  await h.emit('session_start', { reason: 'startup' });
  assert.match(h.notices[0][0], /1 bundle upgrade step.*pending/);
  assert.equal(h.prompts.length, 0);
  assert.ok(h.widgets.get('okf-upgrade'));
  assert.deepEqual(readdirSync(bundle), before);
  assert.match(h.messages[0].message.content, /2 concepts/);
  assert.doesNotMatch(h.messages[0].message.content, /no concepts yet/);
  assert.equal(h.messages[0].options.deliverAs, 'nextTurn');
  const count = h.messages.length;
  await h.emit('session_start', { reason: 'reload' });
  assert.equal(h.messages.length, count); // no duplicate index; upgrade notice still refreshed
  assert.equal(h.notices.length, 2);
  await h.command('status');
  assert.equal(h.prompts.length, 0);
  assert.equal(existsSync(runner(bundle).stateDir), false);
  const hints = await h.emit('before_agent_start');
  assert.match(hints.find(Boolean).message.content, /Do not begin upgrades/);
});

test('approval is required; canonical instructions, completion, and fresh-session persistence', async () => {
  const { cwd, bundle } = fixture();
  const h = harness(cwd);
  await assert.rejects(h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id }), /No user-approved/);
  await h.command();
  assert.equal(h.prompts.length, 0);
  assert.equal(existsSync(runner(bundle).stateDir), false);
  h.ctx.approve = true;
  await h.command();
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /001 — OKF 0.4 validation/);
  assert.match(h.prompts[0], /no required format conversion/);
  assert.equal(existsSync(runner(bundle).lockPath), true);
  await assert.rejects(h.call('memory_upgrade', { action: 'complete', step: '999-skip' }), /Cannot skip/);
  await assert.rejects(h.call('memory_upgrade', { action: 'finalize' }), /Complete every upgrade step/);
  const done = await h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id });
  assert.equal(done.details.pending.length, 0);
  assert.equal(done.details.finished, true);
  assert.match(done.details.commit, /^[a-f0-9]{40,64}$/);
  assert.equal(git(bundle, 'rev-parse', 'HEAD').trim(), done.details.commit);
  assert.equal(git(bundle, 'show', 'HEAD:.pi-okf-memory/state.json'), readFileSync(runner(bundle).statePath, 'utf8'));
  assert.equal(git(bundle, 'status', '--porcelain'), '');
  assert.doesNotMatch(git(bundle, 'ls-tree', '-r', '--name-only', 'HEAD'), /lock\.json|finalize-pending|\.state-.*\.tmp/);
  assert.equal(runner(bundle).readState().completed[0].okfVersion, 'v0.4.3');
  assert.equal(existsSync(runner(bundle).lockPath), false);
  assert.equal(h.statuses.get('okf-upgrade'), undefined);
  const resumed = harness(cwd);
  await resumed.emit('session_start', { reason: 'resume' });
  assert.equal(resumed.notices.length, 0);
  assert.equal(resumed.prompts.length, 0);
  await assert.rejects(resumed.call('memory_upgrade', { action: 'next' }), /No user-approved/);
});

test('fresh empty bundle is inspected, never seeded or silently marked complete', async () => {
  const { cwd, bundle } = fixture({ empty: true });
  const h = harness(cwd);
  await h.emit('session_start', { reason: 'new' });
  assert.match(h.messages[0].message.content, /no concepts yet/);
  assert.equal(runner(bundle).status().baseline, 'unassessed');
  h.ctx.approve = true;
  await h.command();
  await h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id });
  assert.equal(validateBundle(binary, bundle).validation.concept_count, 0);
});

test('failed validation retains diagnostics; warnings block upgrade completion and persistence claims', async () => {
  const { cwd, bundle } = fixture();
  const index = join(bundle, 'decisions/index.md');
  const original = readFileSync(index, 'utf8');
  writeFileSync(index, original.split('\n').filter(line => !line.includes('(storage.md)')).join('\n'));
  const h = harness(cwd);
  const warning = await h.call('memory_validate');
  assert.equal(warning.details.exitCode, 0);
  assert.equal(warning.details.ok, false);
  assert.match(warning.content[0].text, /not listed in parent index/);
  h.ctx.approve = true;
  await h.command();
  await assert.rejects(h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id }), /Upgrade verification failed/);
  assert.equal(existsSync(runner(bundle).statePath), false);
  writeFileSync(index, original);
  const concept = join(bundle, 'decisions/storage.md');
  const originalConcept = readFileSync(concept, 'utf8');
  setFrontmatter(bundle, 'governance: invalid');
  const invalid = await h.call('memory_validate');
  assert.equal(invalid.details.exitCode, 1);
  assert.equal(invalid.details.ok, false);
  assert.match(invalid.content[0].text, /not constraint\|hold\|context/);
  writeFileSync(concept, originalConcept);
  await h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id });
});

test('read tools, path search, limits, and command argument boundaries', async () => {
  const { cwd, bundle } = fixture();
  setFrontmatter(bundle, 'governance: constraint\ncode_refs:\n  - src/**');
  const h = harness(cwd);
  const text = await h.call('memory_search', { query: 'storage', limit: 1 });
  assert.equal(JSON.parse(text.content[0].text).length, 1);
  const scoped = await h.call('memory_search', { for_path: 'src/auth/main.ts' });
  assert.equal(JSON.parse(scoped.content[0].text)[0].governance, 'constraint');
  const shown = await h.call('memory_show', { concept: 'decisions/storage.md' });
  assert.deepEqual(JSON.parse(shown.content[0].text).code_refs, ['src/**']);
  await assert.rejects(h.call('memory_search'), /Supply query/);
  await assert.rejects(h.call('memory_search', { query: '--help' }), /cannot search/);
  await assert.rejects(h.call('memory_search', { query: 'help' }), /cannot search/);
  await assert.rejects(h.call('memory_search', { query: 'storage', limit: 101 }), /limit must/);
  await assert.rejects(h.call('memory_show', { concept: '--help' }), /concept ID/);
  assert.equal((await h.call('memory_validate')).details.ok, true);
});

test('cancel, reload, shutdown, and fork drop approval but preserve completed steps', async () => {
  for (const reason of ['cancel', 'reload', 'shutdown', 'fork']) {
    const { cwd, bundle } = fixture();
    const h = harness(cwd);
    h.ctx.approve = true;
    await h.command();
    if (reason === 'cancel') await h.command('cancel');
    else if (reason === 'shutdown') await h.emit('session_shutdown');
    else await h.emit('session_start', { reason });
    assert.equal(existsSync(runner(bundle).lockPath), false);
    assert.equal(runner(bundle).status().pending.length, 1);
    await assert.rejects(h.call('memory_upgrade', { action: 'next' }), /No user-approved/);
  }
});

test('session changes while a confirmation is open invalidate that approval', async () => {
  const { cwd, bundle } = fixture();
  const h = harness(cwd);
  let answer;
  h.ctx.ui.confirm = () => new Promise(resolve => answer = resolve);
  const reviewing = h.command();
  await h.emit('session_start', { reason: 'new' });
  answer(true);
  await reviewing;
  assert.equal(h.prompts.length, 0);
  assert.equal(existsSync(runner(bundle).stateDir), false);
  assert.match(h.notices.at(-1)[0], /changed while awaiting approval/);
});

test('another session completing while confirmation is open does not launch an empty review', async () => {
  const { cwd, bundle } = fixture();
  const h = harness(cwd);
  h.ctx.ui.confirm = async () => {
    const other = runner(bundle);
    other.acquire(); other.nextInstructions(); other.complete(UPGRADE_STEPS[0].id, binary); other.finalize(binary); other.release();
    return true;
  };
  await h.command();
  assert.equal(h.prompts.length, 0);
  assert.equal(existsSync(runner(bundle).lockPath), false);
  assert.match(h.notices.at(-1)[0], /already completed/);
});

test('headless and busy sessions never start a migration; RPC receives no TUI widgets', async () => {
  const { cwd, bundle } = fixture();
  const h = harness(cwd, { hasUI: false, mode: 'print' });
  h.ctx.approve = true;
  await h.emit('session_start', { reason: 'startup' });
  await h.command();
  assert.equal(h.prompts.length, 0);
  assert.equal(h.confirmations.length, 0);
  assert.equal(existsSync(runner(bundle).stateDir), false);
  assert.match(h.messages.at(-1).message.content, /requires user confirmation/);
  assert.ok((await h.emit('before_agent_start')).find(Boolean).message.content.includes('/memory-upgrade'));
  const rpc = harness(cwd, { mode: 'rpc' });
  await rpc.emit('session_start', { reason: 'startup' });
  assert.equal(rpc.widgets.size, 0);
  assert.ok(rpc.notices.length);
  rpc.ctx.isIdle = () => false;
  await rpc.command();
  assert.equal(rpc.confirmations.length, 0);
});

test('unsupported binary is diagnosed even after completion; unknown state is not overwritten', async () => {
  const { cwd, bundle } = fixture();
  const r = runner(bundle);
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id, binary); r.release();
  const shim = join(work, 'old-okf');
  writeFileSync(shim, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'okf version v0.1.5 (OKF v0.2 specification)'; else exec ${JSON.stringify(binary)} "$@"; fi\n`, { mode: 0o755 });
  process.env.OKF_BIN = shim;
  try {
    const h = harness(cwd);
    await h.emit('session_start', { reason: 'startup' });
    assert.match(h.notices[0][0], /outside the tested range/);
    assert.equal((await h.call('memory_validate')).details.ok, false);
    await assert.rejects(h.call('memory_search', { for_path: 'src/foo.ts' }), /outside the tested range/);
    h.ctx.approve = true;
    await h.command();
    assert.equal(h.prompts.length, 0);
  } finally { delete process.env.OKF_BIN; }
  const saved = readFileSync(r.statePath, 'utf8');
  writeFileSync(r.statePath, '{"schema":999,"completed":[]}');
  assert.throws(() => r.status(), /Unsupported/);
  assert.throws(() => r.acquire(), /Unsupported/);
  writeFileSync(r.statePath, '{broken');
  assert.throws(() => r.status(), /Invalid upgrade state JSON/);
  writeFileSync(r.statePath, saved);
});

test('skipped releases are processed in order and resume after the last completed step', () => {
  const { bundle } = fixture();
  const verified = [];
  const steps = ['001-first', '002-second', '003-third'].map(id => ({ id, title: id, instructions: '001-validation-contract.md', verify: () => verified.push(id) }));
  const r = runner(bundle, steps);
  r.acquire();
  assert.throws(() => r.complete('001-first', binary), /undelivered/);
  r.nextInstructions();
  assert.throws(() => r.complete('003-third', binary), /Cannot skip/);
  r.complete('001-first', binary); r.release();
  const resumed = runner(bundle, steps);
  assert.deepEqual(resumed.status().pending.map(x => x.id), ['002-second', '003-third']);
  resumed.acquire();
  assert.match(resumed.nextInstructions(), /Upgrade 2\/3/);
  resumed.complete('002-second', binary);
  resumed.nextInstructions(); resumed.complete('003-third', binary); resumed.release();
  assert.deepEqual(verified, ['001-first', '002-second', '003-third']);
  assert.throws(() => runner(bundle, steps.slice(0, 2)).status(), /package downgrade/);
});

test('multiple step completions in one tool batch cannot bypass instruction delivery', async () => {
  const { cwd, bundle } = fixture();
  const steps = ['001-first', '002-second'].map(id => ({ id, title: id, instructions: '001-validation-contract.md', verify() {} }));
  const h = harness(cwd, { extensionFactory: pi => registerUpgrades(pi, {
    skillsDir: skills, packageVersion, getBinary: () => binary, getBundle: resolveKnowledgeDir, steps,
  }) });
  h.ctx.approve = true;
  await h.command();
  const complete = step => h.tools.memory_upgrade.execute('batch', { action: 'complete', step }, undefined, undefined, h.ctx);
  await assert.rejects(complete('001-first'), /subsequent model turn/);
  await h.emit('turn_start');
  const next = await complete('001-first');
  assert.match(next.content[0].text, /Upgrade 2\/2/);
  await assert.rejects(complete('002-second'), /subsequent model turn/);
  assert.equal(runner(bundle, steps).readState().completed.length, 1);
  await h.emit('turn_start');
  await complete('002-second');
  assert.equal(runner(bundle, steps).status().pending.length, 0);
});

test('malformed completion order and missing instruction assets cannot advance progress', () => {
  const { bundle } = fixture();
  const r = runner(bundle);
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id, binary); r.release();
  const valid = JSON.parse(readFileSync(r.statePath, 'utf8'));
  writeFileSync(r.statePath, JSON.stringify({ ...valid, completed: [...valid.completed, ...valid.completed] }));
  assert.throws(() => r.status(), /out-of-order/);
  writeFileSync(r.statePath, JSON.stringify({ ...valid, completed: [{ ...valid.completed[0], id: '002-skipped' }] }));
  assert.throws(() => r.status(), /out-of-order/);
  rmSync(r.statePath);
  const missing = runner(bundle, [{ ...UPGRADE_STEPS[0], instructions: 'missing.md' }]);
  missing.acquire();
  assert.throws(() => missing.nextInstructions(), /ENOENT/);
  assert.throws(() => missing.complete(UPGRADE_STEPS[0].id, binary), /undelivered/);
  assert.equal(existsSync(missing.statePath), false);
  missing.release();
});

test('shared bundles canonicalize aliases; concurrent reviews cannot acquire the same lock', async () => {
  const { cwd, bundle } = fixture();
  const alias = join(work, `alias-${sequence}`);
  symlinkSync(bundle, alias, 'dir');
  const a = runner(bundle), b = runner(alias);
  assert.equal(a.statePath, b.statePath);
  a.acquire();
  assert.throws(() => b.acquire(), /Another upgrade review/);
  assert.throws(() => b.recoverableLock(), /still running/);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { jiti } from ${JSON.stringify(new URL('./loader.mjs', import.meta.url).href)};
    const { UpgradeRunner } = await jiti.import(${JSON.stringify(join(root, 'lib/upgrades.ts'))});
    const r = new UpgradeRunner(${JSON.stringify(alias)}, ${JSON.stringify(skills)}, ${JSON.stringify(packageVersion)});
    try { r.acquire(); process.exitCode = 1; } catch (e) { if (!e.message.includes('Another upgrade review')) throw e; }
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  a.release();
  const other = fixture({ empty: true });
  process.env.OKF_KNOWLEDGE_DIR = alias;
  try {
    assert.equal(resolveKnowledgeDir(other.cwd), a.bundle);
    const h = harness(other.cwd); h.ctx.approve = true; await h.command();
    await h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id });
    assert.equal(runner(bundle).status().pending.length, 0);
    assert.equal(runner(other.bundle).status().pending.length, 1);
  } finally { delete process.env.OKF_KNOWLEDGE_DIR; }
});

test('crashed review recovery is explicit and preserves progress; foreign locks are refused', async () => {
  const { cwd, bundle } = fixture();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { jiti } from ${JSON.stringify(new URL('./loader.mjs', import.meta.url).href)};
    const { UpgradeRunner } = await jiti.import(${JSON.stringify(join(root, 'lib/upgrades.ts'))});
    new UpgradeRunner(${JSON.stringify(bundle)}, ${JSON.stringify(skills)}, ${JSON.stringify(packageVersion)}).acquire();
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const r = runner(bundle), h = harness(cwd);
  const expected = r.recoverableLock();
  assert.ok(expected);
  await h.command('unlock');
  assert.ok(existsSync(r.lockPath)); // declined
  h.ctx.approve = true;
  await h.command('unlock');
  assert.equal(existsSync(r.lockPath), false);
  assert.equal(r.status().pending.length, 1);
  writeFileSync(r.lockPath, JSON.stringify({ host: `${hostname()}-foreign`, pid: 42, token: 'foreign' }));
  assert.throws(() => r.recoverableLock(), /foreign/);
  rmSync(r.lockPath);
});

test('symlinked state is rejected; missing bundle offers setup and explicit bad override does not fall back', async () => {
  const { cwd, bundle } = fixture();
  const outside = join(work, `outside-${sequence}`); mkdirSync(outside);
  symlinkSync(outside, runner(bundle).stateDir, 'dir');
  assert.throws(() => runner(bundle).status(), /Unsafe upgrade state path/);
  const noBundle = join(work, 'no-bundle'); mkdirSync(noBundle);
  const h = harness(noBundle);
  await h.emit('session_start', { reason: 'startup' });
  assert.equal(h.messages.length, 0);
  assert.match(h.notices[0][0], /memory-setup/);
  assert.equal(h.confirmations.length, 1);
  assert.equal(existsSync(join(noBundle, 'knowledge')), false);
  await assert.rejects(h.call('memory_search', { query: 'foo' }), /No OKF knowledge bundle/);
  process.env.OKF_KNOWLEDGE_DIR = join(work, 'missing-explicit-bundle');
  try { assert.equal(resolveKnowledgeDir(cwd), null); }
  finally { delete process.env.OKF_KNOWLEDGE_DIR; }
});

test('local installer ships modules/skills and replaces only the recognized legacy entry point', async () => {
  const { cwd, bundle } = fixture();
  const oldEntry = join(cwd, '.pi/extensions/okf-memory.ts');
  mkdirSync(dirname(oldEntry), { recursive: true });
  writeFileSync(oldEntry, readFileSync(join(root, 'index.ts'), 'utf8'));
  const originalIndex = readFileSync(join(bundle, 'index.md'), 'utf8');
  execFileSync('bash', [join(root, 'install.sh'), cwd, bundle], { encoding: 'utf8' });
  assert.equal(existsSync(oldEntry), false);
  assert.equal(existsSync(join(bundle, '.git')), true); // existing repository retained
  assert.equal(spawnSync('git', ['-C', bundle, 'rev-parse', '--verify', 'HEAD']).status, 128); // installer made no commit
  assert.equal(readFileSync(join(bundle, 'index.md'), 'utf8'), originalIndex);
  const installed = join(cwd, '.pi/extensions/okf-memory');
  assert.ok(existsSync(join(installed, 'lib/upgrades.ts')));
  assert.ok(existsSync(join(cwd, '.pi/skills/okf-memory-upgrade/steps/001-validation-contract.md')));
  const loaded = await jiti.import(join(installed, 'index.ts'));
  const h = harness(cwd, { extensionFactory: loaded.default });
  await h.emit('session_start', { reason: 'startup' });
  assert.equal(h.prompts.length, 0);
  h.ctx.approve = true;
  await h.command();
  assert.match(h.prompts[0], /001 — OKF 0.4 validation/);
  assert.ok(h.prompts[0].includes(join(installed, 'bin')));
  await h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id });
  // Reinstallation neither resets the ledger nor nests copied lib/ directories.
  const ledger = readFileSync(runner(bundle).statePath, 'utf8');
  execFileSync('bash', [join(root, 'install.sh'), cwd, bundle], { encoding: 'utf8' });
  assert.equal(readFileSync(runner(bundle).statePath, 'utf8'), ledger);
  assert.equal(existsSync(join(installed, 'lib/lib')), false);
});

test('failed commit remains pending across sessions and retries without repeating the review', async () => {
  const { cwd, bundle } = fixture();
  const hook = join(bundle, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho deliberate-commit-blocker >&2\nexit 1\n', { mode: 0o755 });
  const h = harness(cwd); h.ctx.approve = true; await h.command();
  await assert.rejects(h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id }), /finalization is incomplete[\s\S]*deliberate-commit-blocker/);
  const r = runner(bundle), ledger = readFileSync(r.statePath, 'utf8');
  assert.equal(r.status().pending.length, 0);
  assert.equal(r.status().finalization.pending, true);
  assert.equal(r.status().finished, false);
  assert.equal(existsSync(r.finalizePath), true);
  assert.match((await h.call('memory_upgrade', { action: 'next' })).content[0].text, /final Git commit is required/);
  await h.emit('session_shutdown');
  const resumed = harness(cwd);
  await resumed.emit('session_start', { reason: 'resume' });
  assert.match(resumed.notices[0][0], /required final commit is pending/);
  assert.equal(readFileSync(r.statePath, 'utf8'), ledger);
  rmSync(hook);
  await resumed.command(); // decline: do not finalize automatically
  assert.equal(r.status().finished, false);
  resumed.ctx.approve = true; await resumed.command();
  assert.equal(resumed.prompts.length, 0); // deterministic commit-only retry
  assert.equal(r.status().finished, true);
  assert.equal(readFileSync(r.statePath, 'utf8'), ledger); // no second timestamp/ledger write
  assert.equal(git(bundle, 'rev-list', '--count', 'HEAD').trim(), '1');
  await resumed.command();
  assert.equal(git(bundle, 'rev-list', '--count', 'HEAD').trim(), '1');
});

test('previously recorded but uncommitted upgrades are finalized; normal later edits do not reopen them', async () => {
  const { cwd, bundle } = fixture();
  const r = runner(bundle);
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id, binary); r.release();
  writeFileSync(join(r.stateDir, '.gitignore'), 'lock.json\n.state-*.tmp\n'); // original runner's ignore file
  const ledger = readFileSync(r.statePath, 'utf8');
  const h = harness(cwd);
  await h.emit('session_start', { reason: 'reload' });
  assert.match(h.notices[0][0], /final commit is pending/);
  h.ctx.approve = true; await h.command();
  assert.equal(h.prompts.length, 0);
  assert.equal(r.status().finished, true);
  assert.equal(git(bundle, 'show', 'HEAD:.pi-okf-memory/state.json'), ledger);
  writeFileSync(join(bundle, 'later-work.txt'), 'A subsequent, unrelated knowledge task.\n');
  assert.equal(r.status().finished, true);
  const fresh = harness(cwd); await fresh.emit('session_start', { reason: 'startup' });
  assert.equal(fresh.notices.length, 0);
});

test('embedded bundles commit additions and deletions without touching unrelated staging or ignored files', async () => {
  const { cwd, bundle } = fixture({ withGit: false });
  initGit(cwd);
  writeFileSync(join(cwd, 'source.txt'), 'original source\n');
  writeFileSync(join(cwd, '.gitignore'), 'knowledge/scratch.secret\n');
  writeFileSync(join(bundle, 'remove-me.txt'), 'old knowledge auxiliary file\n');
  git(cwd, 'add', '--all'); git(cwd, 'commit', '-qm', 'Initial project');
  writeFileSync(join(cwd, 'source.txt'), 'staged source\n'); git(cwd, 'add', 'source.txt');
  writeFileSync(join(cwd, 'source.txt'), 'unstaged source\n');
  writeFileSync(join(cwd, 'outside-untracked.txt'), 'do not commit\n');
  writeFileSync(join(bundle, 'scratch.secret'), 'ignored, do not commit\n');
  writeFileSync(join(bundle, 'notes [literal]*.txt'), 'agent-owned bundle work\n');
  rmSync(join(bundle, 'remove-me.txt'));
  const staged = git(cwd, 'diff', '--cached');
  const h = harness(cwd); h.ctx.approve = true; await h.command();
  const done = await h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id });
  assert.equal(done.details.finished, true);
  assert.equal(git(cwd, 'diff', '--cached'), staged);
  assert.equal(git(cwd, 'show', 'HEAD:source.txt'), 'original source\n');
  assert.equal(readFileSync(join(cwd, 'source.txt'), 'utf8'), 'unstaged source\n');
  const changed = git(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim().split('\n');
  assert.ok(changed.every(path => path.startsWith('knowledge/')), changed.join('\n'));
  assert.ok(changed.includes('knowledge/remove-me.txt'));
  assert.ok(changed.includes('knowledge/notes [literal]*.txt'));
  assert.doesNotMatch(git(cwd, 'ls-tree', '-r', '--name-only', 'HEAD'), /scratch.secret|outside-untracked|lock.json|finalize-pending/);
});

test('a missing repository blocks final success without fabricating Git setup', () => {
  const { bundle } = fixture({ withGit: false });
  const r = runner(bundle);
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id, binary);
  assert.throws(() => r.finalize(binary), /finalization is incomplete[\s\S]*not a git repository/);
  assert.equal(existsSync(join(bundle, '.git')), false);
  assert.equal(r.status().finished, false);
  initGit(bundle);
  assert.equal(r.finalize(binary).finished, true);
  r.release();
});

test('post-commit changes stay pending even when the ledger is already in HEAD', async () => {
  const { cwd, bundle } = fixture();
  const hook = join(bundle, '.git/hooks/post-commit');
  writeFileSync(hook, '#!/bin/sh\nprintf "hook-created file\\n" > hook-output.txt\n', { mode: 0o755 });
  const h = harness(cwd); h.ctx.approve = true; await h.command();
  await assert.rejects(h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id }), /changed during finalization/);
  const r = runner(bundle);
  assert.equal(git(bundle, 'show', 'HEAD:.pi-okf-memory/state.json'), readFileSync(r.statePath, 'utf8'));
  assert.equal(r.status().finished, false);
  assert.equal(existsSync(r.finalizePath), true);
  rmSync(hook);
  const done = await h.call('memory_upgrade', { action: 'finalize' });
  assert.equal(done.details.finished, true);
  assert.equal(git(bundle, 'rev-list', '--count', 'HEAD').trim(), '2');
  assert.equal(git(bundle, 'show', 'HEAD:hook-output.txt'), 'hook-created file\n');
});

test('missing Git identity leaves finalization pending rather than inventing an author', () => {
  const { bundle } = fixture();
  git(bundle, 'config', '--unset', 'user.name'); git(bundle, 'config', '--unset', 'user.email');
  git(bundle, 'config', 'user.useConfigOnly', 'true');
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    const r = runner(bundle);
    r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id, binary);
    assert.throws(() => r.finalize(binary), /finalization is incomplete/);
    assert.equal(r.status().finished, false);
    assert.equal(spawnSync('git', ['-C', bundle, 'config', '--get', 'user.email']).status, 1);
    initGit(bundle);
    assert.equal(r.finalize(binary).finished, true);
    r.release();
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});

test('ignored metadata cannot cause an empty path list to stage the enclosing repository', () => {
  const { cwd, bundle } = fixture({ withGit: false });
  initGit(cwd);
  writeFileSync(join(cwd, '.gitignore'), 'knowledge/**\n');
  writeFileSync(join(cwd, 'outside.txt'), 'base\n');
  git(cwd, 'add', '--all'); git(cwd, 'commit', '-qm', 'Initial project');
  writeFileSync(join(cwd, 'outside.txt'), 'staged\n'); git(cwd, 'add', 'outside.txt');
  writeFileSync(join(cwd, 'outside.txt'), 'unstaged\n');
  const staged = git(cwd, 'diff', '--cached');
  const r = runner(bundle);
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id, binary);
  assert.throws(() => r.finalize(binary), /ignored\/missing/);
  assert.equal(git(cwd, 'diff', '--cached'), staged);
  assert.equal(git(cwd, 'show', 'HEAD:outside.txt'), 'base\n');
  assert.equal(r.status().finished, false);
  r.release();
});

test('a hook cannot make invalid committed content count as validated success', () => {
  const { bundle } = fixture();
  const hook = join(bundle, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\nprintf "broken concept without frontmatter\\n" > decisions/privacy.md\ngit add decisions/privacy.md\n', { mode: 0o755 });
  const r = runner(bundle);
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id, binary);
  assert.throws(() => r.finalize(binary), /Upgrade verification failed|changed during finalization/);
  assert.equal(git(bundle, 'show', 'HEAD:decisions/privacy.md'), 'broken concept without frontmatter\n');
  assert.equal(validateBundle(binary, bundle).ok, false);
  assert.equal(r.status().finished, false);
  assert.equal(existsSync(r.finalizePath), true);
  r.release();
});

test('verifiers run again after commit even when Git reports a clean bundle', () => {
  const { bundle } = fixture();
  let checks = 0;
  const steps = [{ ...UPGRADE_STEPS[0], verify() { if (++checks === 3) throw new Error('post-commit verification failed'); } }];
  const r = runner(bundle, steps);
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id, binary);
  assert.throws(() => r.finalize(binary), /post-commit verification failed/);
  assert.equal(checks, 3);
  assert.equal(git(bundle, 'status', '--porcelain'), '');
  assert.equal(r.status().finished, false);
  r.release();
});

test('finalization refuses in-progress Git operations and tracked lock files', () => {
  const { bundle } = fixture();
  const r = runner(bundle);
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id, binary);
  writeFileSync(join(bundle, '.git/MERGE_HEAD'), '0000000000000000000000000000000000000000\n');
  assert.throws(() => r.finalize(binary), /MERGE_HEAD/);
  rmSync(join(bundle, '.git/MERGE_HEAD'));
  git(bundle, 'add', '--force', '.pi-okf-memory/lock.json');
  assert.throws(() => r.finalize(binary), /Transient upgrade lock/);
  git(bundle, 'rm', '--cached', '.pi-okf-memory/lock.json');
  assert.equal(r.finalize(binary).finished, true);
  r.release();
});

test('optional workspace corpus read-only check', { skip: !existsSync('/workspace/knowledge/index.md') }, () => {
  // Never migrate, modify, or assume particular concepts in a user's real bundle.
  const result = validateBundle(binary, '/workspace/knowledge');
  assert.ok(Number.isInteger(result.validation.concept_count));
});
