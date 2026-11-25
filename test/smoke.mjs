import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createHash } from 'node:crypto';
import { createHarness, makeCli, reviewSteps } from './support.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jiti } from './loader.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'pi-okf-test-'));
const env = { OKF_KNOWLEDGE_DIR: process.env.OKF_KNOWLEDGE_DIR, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.OKF_KNOWLEDGE_DIR;
const { default: nativeExtension, createMemoryExtension } = await jiti.import(join(root, 'index.ts'));
const { UpgradeRunner, UPGRADE_STEPS: NATIVE_STEPS } = await jiti.import(join(root, 'lib/upgrades.ts'));
const { registerUpgrades } = await jiti.import(join(root, 'lib/upgrade-extension.ts'));
const memory = await jiti.import(join(root, 'lib/memory.ts'));
const { validateBundle, resolveKnowledgeDir } = memory;
// The shipped steps are deterministic. These tests cover the model-reviewed workflow,
// which stays available for future steps, through one reviewed test step.
const UPGRADE_STEPS = reviewSteps(validateBundle);
const extension = createMemoryExtension({ steps: UPGRADE_STEPS });
const skills = join(root, 'skills');
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const cli = makeCli(memory);
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
  assert.match(h.prompts[0], /001 — Baseline contract/);
  assert.doesNotMatch(h.prompts[0], /executable|PATH/);
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
  assert.equal(runner(bundle).readState().completed[0].okfVersion, 'native');
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
  assert.equal(validateBundle(bundle).conceptCount, 0);
});

test('failed validation retains findings and blocks upgrade completion; navigation alone is regenerated', async () => {
  const { cwd, bundle } = fixture();
  const h = harness(cwd);
  // Hand-damaged navigation is not a blocker: validation regenerates it from the concepts.
  writeFileSync(join(bundle, 'index.md'), '# stale\n');
  assert.equal(validateBundle(bundle).findings[0].code, 'index-stale');
  const repaired = await h.call('memory_validate');
  assert.equal(repaired.details.ok, true);
  assert.deepEqual(repaired.details.regenerated, ['index.md']);
  const concept = join(bundle, 'decisions/storage.md');
  const original = readFileSync(concept, 'utf8');
  writeFileSync(concept, original + '\nSee [gone](missing-target.md).\n');
  const broken = await h.call('memory_validate');
  assert.equal(broken.details.ok, false);
  assert.equal(broken.details.findings[0].code, 'broken-link');
  assert.match(broken.content[0].text, /missing-target\.md does not exist/);
  h.ctx.approve = true;
  await h.command();
  await assert.rejects(h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id }), /Upgrade verification failed/);
  assert.equal(existsSync(runner(bundle).statePath), false);
  writeFileSync(concept, original.replace(/^title: .*\n/m, ''));
  const invalid = await h.call('memory_validate');
  assert.equal(invalid.details.ok, false);
  assert.match(invalid.content[0].text, /frontmatter has no title/);
  writeFileSync(concept, original);
  setFrontmatter(bundle, 'stale_after: 2001-01-01\ncustom_field: kept');
  const stale = await h.call('memory_validate');
  assert.equal(stale.details.ok, true); // an expired review date is an advisory, not a blocker
  assert.equal(stale.details.advisories[0].code, 'stale');
  await h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id });
});

test('before a bundle adopts the generated layout, validation and reads change nothing', async () => {
  const { cwd, bundle } = fixture();
  // An OKF-CLI-era layout: hand-listed root index plus a per-directory index.
  writeFileSync(join(bundle, 'index.md'), '---\nokf_version: "0.2"\n---\n\n# Knowledge Base\n- [decisions](decisions/index.md) — Knowledge maintained from session evidence.\n');
  writeFileSync(join(bundle, 'decisions/index.md'), '# Decisions\n* [Storage choice](storage.md) - Keep memory local for privacy.\n');
  rmSync(join(bundle, 'catalog.md'));
  git(bundle, 'add', '-A'); git(bundle, 'commit', '--quiet', '-m', 'okf era');
  const h = createHarness(nativeExtension, cwd);
  await h.emit('session_start', { reason: 'startup' });
  const checked = await h.call('memory_validate');
  assert.equal(checked.details.ok, true);
  assert.deepEqual(checked.details.regenerated, []);
  assert.equal(checked.details.advisories.at(-1).code, 'navigation-pending');
  await h.call('memory_show', { concept: 'decisions/storage' });
  await h.call('memory_search', { query: 'storage' });
  assert.equal(git(bundle, 'status', '--porcelain'), '', 'inspection must not dirty a bundle awaiting its upgrade');
  // A broken concept is still reported while the upgrade is pending.
  writeFileSync(join(bundle, 'decisions/storage.md'), readFileSync(join(bundle, 'decisions/storage.md'), 'utf8') + '\n[gone](gone.md)\n');
  assert.equal((await h.call('memory_validate')).details.findings[0].code, 'broken-link');
  git(bundle, 'checkout', '--', 'decisions/storage.md');
  // The deterministic upgrade then adopts the layout; afterwards validation regenerates as usual.
  h.ctx.approve = true; await h.command();
  assert.equal(h.prompts.length, 0, 'shipped steps need no model turn');
  assert.equal(git(bundle, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(bundle, 'decisions/index.md')), false);
  writeFileSync(join(bundle, 'index.md'), readFileSync(join(bundle, 'index.md'), 'utf8').replace('Keep memory local', 'Edited by hand'));
  assert.deepEqual((await h.call('memory_validate')).details.regenerated, ['index.md']);
});

test('search ranks sections, show reads concepts, write/move maintain navigation, links and the log', async () => {
  const { cwd, bundle } = fixture();
  const h = harness(cwd);
  const found = JSON.parse((await h.call('memory_search', { query: 'storage privacy', limit: 1 })).content[0].text);
  assert.equal(found.length, 1);
  assert.equal(found[0].concept, 'decisions/storage');
  // A partial match still returns something rather than an empty list.
  assert.equal(JSON.parse((await h.call('memory_search', { query: 'storage zebra unrelated' })).content[0].text)[0].concept, 'decisions/storage');
  assert.deepEqual(JSON.parse((await h.call('memory_search', { query: 'zebra' })).content[0].text), []);
  const shown = (await h.call('memory_show', { concept: 'decisions/storage.md' })).content[0].text;
  assert.match(shown, /# Storage choice/);
  assert.match(shown, /Local storage avoids remote exposure/);
  await assert.rejects(h.call('memory_search', { query: ' ' }), /Supply a query/);
  await assert.rejects(h.call('memory_search', { query: 'storage', limit: 51 }), /limit must/);
  await assert.rejects(h.call('memory_show', { concept: '--help' }), /Invalid concept ID/);
  await assert.rejects(h.call('memory_show', { concept: '../outside' }), /Invalid concept ID/);
  await assert.rejects(h.call('memory_show', { concept: 'decisions/absent' }), /not found/);
  await assert.rejects(h.call('memory_write', { concept: 'decisions/new-topic', body: 'x' }), /requires title and description/);
  await assert.rejects(h.call('memory_write', { concept: 'Bad Id', title: 't', description: 'd' }), /Invalid concept ID/);
  await assert.rejects(h.call('memory_write', { concept: 'decisions/index', title: 't', description: 'd' }), /Invalid concept ID/);
  const created = await h.call('memory_write', { concept: 'decisions/new-topic', title: 'New: topic', description: "It's quoted; safely.", type: 'Decision',
    body: 'Because of [storage](storage.md).', tags: ['alpha', 'beta'] });
  assert.equal(created.details.created, true);
  const file = readFileSync(join(bundle, 'decisions/new-topic.md'), 'utf8');
  assert.match(file, /^---\ntype: Decision\ntitle: "New: topic"\ndescription: "It's quoted; safely\."\ncreated: /);
  assert.match(file, /tags: \[alpha, beta\]/);
  assert.match(readFileSync(join(bundle, 'index.md'), 'utf8'), /\* \[New: topic\]\(decisions\/new-topic\.md\) - It's quoted; safely\./);
  assert.match(readFileSync(join(bundle, 'catalog.md'), 'utf8'), /`decisions\/new-topic` \(active\)/);
  assert.match(readFileSync(join(bundle, 'log.md'), 'utf8'), /\*\*Creation\*\*: Documented concept `decisions\/new-topic\.md` \(New: topic\)/);
  await h.call('memory_write', { concept: 'decisions/new-topic', append: '## Later\n\nMore rationale.' });
  const updated = readFileSync(join(bundle, 'decisions/new-topic.md'), 'utf8');
  assert.match(updated, /Because of \[storage\]\(storage\.md\)\.\n\n## Later\n\nMore rationale\.\n$/);
  assert.match(updated, /title: "New: topic"/); // unrelated fields survive an update
  assert.equal((await h.call('memory_show', { concept: 'decisions/new-topic', section: 'later' })).content[0].text.includes('Because of'), false);
  await assert.rejects(h.call('memory_write', { concept: 'decisions/new-topic', body: 'a', append: 'b' }), /not both/);
  await assert.rejects(h.call('memory_write', { concept: 'decisions/new-topic', body: '---\ntitle: x\n---\nbody' }), /frontmatter/);
  await h.call('memory_write', { concept: 'decisions/storage', append: 'Sibling link: [privacy](privacy.md#why).' });
  const moved = await h.call('memory_move', { from: 'decisions/storage', to: 'archive/storage' });
  assert.deepEqual(moved.details.relinked.sort(), ['archive/storage.md', 'decisions/new-topic.md']);
  assert.match(readFileSync(join(bundle, 'decisions/new-topic.md'), 'utf8'), /\[storage\]\(\.\.\/archive\/storage\.md\)/);
  assert.match(readFileSync(join(bundle, 'archive/storage.md'), 'utf8'), /\[privacy\]\(\.\.\/decisions\/privacy\.md#why\)/);
  await assert.rejects(h.call('memory_move', { from: 'decisions/privacy', to: 'archive/storage' }), /already exists/);
  assert.equal((await h.call('memory_validate')).details.ok, true);
});

test('usage is recorded once the bundle ignores the ledger; stats, demote and pin commands manage the session index', async () => {
  const { cwd, bundle } = fixture();
  const h = harness(cwd);
  const run = (name, args = '') => h.commands[name](args, h.ctx);
  const index = () => readFileSync(join(bundle, 'index.md'), 'utf8');
  const ledger = join(bundle, '.pi-okf-memory/usage.jsonl');
  await h.emit('session_start', { reason: 'startup' });
  await h.call('memory_show', { concept: 'decisions/storage' });
  assert.equal(existsSync(ledger), false, 'a read before adoption must not create files in the bundle');
  h.ctx.approve = true; await h.command(); await h.call('memory_upgrade', { action: 'complete', step: UPGRADE_STEPS[0].id });
  const head = git(bundle, 'rev-parse', 'HEAD');
  await h.emit('session_start', { reason: 'startup' });
  assert.match(h.messages.at(-1).message.content, /standing rules and recently used concepts only; use memory_search for everything else/);
  assert.doesNotMatch(h.messages.at(-1).message.content, /executable/i);
  await h.call('memory_search', { query: 'privacy exposure' });
  await h.call('memory_show', { concept: 'decisions/storage' });
  // A direct file read is use too.
  await h.emit('tool_call', { toolName: 'read', input: { path: join(bundle, 'decisions/privacy.md') } });
  await h.emit('tool_call', { toolName: 'read', input: { path: join(bundle, 'index.md') } });
  await h.emit('tool_call', { toolName: 'read', input: { path: join(cwd, 'elsewhere.md') } });
  const events = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)).map(e => [e.k, e.id]);
  assert.deepEqual(events, [['session', undefined], ['hit', 'decisions/privacy'], ['hit', 'decisions/storage'], ['open', 'decisions/storage'], ['open', 'decisions/privacy']]);
  assert.equal(git(bundle, 'status', '--porcelain'), '', 'usage never dirties the repository');
  assert.equal(git(bundle, 'rev-parse', 'HEAD'), head);
  await run('memory-stats');
  const report = h.messages.at(-1).message.content;
  assert.match(report, /2 concepts; index\.md is \d+ chars \(Active budget 2000 chars, demotion after 20 idle sessions\)/);
  assert.match(report, /active\s+0\s+1\s+1\s+0\s+decisions\/storage/);
  await run('memory-demote', 'decisions/storage');
  assert.doesNotMatch(index(), /storage\.md/);
  assert.match(index(), /1 more concept \(decisions\/ 1\)/);
  assert.match(h.notices.at(-1)[0], /left the session index/);
  await run('memory-demote', 'idle');                       // a rebalance respects the manual demotion
  assert.doesNotMatch(index(), /storage\.md/);
  await h.call('memory_show', { concept: 'decisions/storage' });   // the next read brings it back
  assert.match(index(), /storage\.md/);
  await run('memory-pin', 'decisions/privacy');
  assert.match(index(), /## Standing rules\n\* \[Privacy\]\(decisions\/privacy\.md\)/);
  await run('memory-demote', 'decisions/privacy');
  assert.match(h.notices.at(-1)[0], /is pinned/);
  await run('memory-pin', 'decisions/privacy off');
  assert.doesNotMatch(index(), /## Standing rules/);
  await run('memory-demote', 'decisions/absent');
  assert.match(h.notices.at(-1)[0], /not found/);
  await run('memory-consolidate');
  assert.match(h.notices.at(-1)[0], /No concept has 4 or more stacked/);
  const prompts = h.prompts.length;
  await run('memory-consolidate', 'decisions/storage');
  assert.equal(h.prompts.length, prompts + 1);
  assert.match(h.prompts.at(-1), /Wait for my approval/);
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
    other.acquire(); other.nextInstructions(); other.complete(UPGRADE_STEPS[0].id); other.finalize(); other.release();
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

test('unknown, newer or corrupt ledger state is refused rather than overwritten', () => {
  const { bundle } = fixture();
  const r = runner(bundle);
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id); r.release();
  const saved = readFileSync(r.statePath, 'utf8');
  // A ledger written while an OKF binary was bundled stays readable.
  writeFileSync(r.statePath, saved.replace('"native"', '"v0.7.0"'));
  assert.equal(r.status().completed[0].okfVersion, 'v0.7.0');
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
  assert.throws(() => r.complete('001-first'), /undelivered/);
  r.nextInstructions();
  assert.throws(() => r.complete('003-third'), /Cannot skip/);
  r.complete('001-first'); r.release();
  const resumed = runner(bundle, steps);
  assert.deepEqual(resumed.status().pending.map(x => x.id), ['002-second', '003-third']);
  resumed.acquire();
  assert.match(resumed.nextInstructions(), /Upgrade 2\/3/);
  resumed.complete('002-second');
  resumed.nextInstructions(); resumed.complete('003-third'); resumed.release();
  assert.deepEqual(verified, ['001-first', '002-second', '003-third']);
  assert.throws(() => runner(bundle, steps.slice(0, 2)).status(), /package downgrade/);
});

test('multiple step completions in one tool batch cannot bypass instruction delivery', async () => {
  const { cwd, bundle } = fixture();
  const steps = ['001-first', '002-second'].map(id => ({ id, title: id, instructions: '001-validation-contract.md', verify() {} }));
  const h = harness(cwd, { extensionFactory: pi => registerUpgrades(pi, {
    skillsDir: skills, packageVersion, getBundle: resolveKnowledgeDir, steps,
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
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id); r.release();
  const valid = JSON.parse(readFileSync(r.statePath, 'utf8'));
  writeFileSync(r.statePath, JSON.stringify({ ...valid, completed: [...valid.completed, ...valid.completed] }));
  assert.throws(() => r.status(), /out-of-order/);
  writeFileSync(r.statePath, JSON.stringify({ ...valid, completed: [{ ...valid.completed[0], id: '002-skipped' }] }));
  assert.throws(() => r.status(), /out-of-order/);
  rmSync(r.statePath);
  const missing = runner(bundle, [{ ...UPGRADE_STEPS[0], instructions: 'missing.md' }]);
  missing.acquire();
  assert.throws(() => missing.nextInstructions(), /ENOENT/);
  assert.throws(() => missing.complete(UPGRADE_STEPS[0].id), /undelivered/);
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
  await assert.rejects(h.call('memory_search', { query: 'foo' }), /No knowledge bundle/);
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
  assert.equal(existsSync(join(installed, 'bin')), false);
  const loaded = await jiti.import(join(installed, 'index.ts'));
  const h = harness(cwd, { extensionFactory: loaded.createMemoryExtension({ steps: UPGRADE_STEPS }) });
  await h.emit('session_start', { reason: 'startup' });
  assert.equal(h.prompts.length, 0);
  h.ctx.approve = true;
  await h.command();
  assert.match(h.prompts[0], /001 — Baseline contract/);
  assert.ok(h.prompts[0].includes(join(cwd, '.pi/skills/okf-memory-upgrade')));
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
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id); r.release();
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
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id);
  assert.throws(() => r.finalize(), /finalization is incomplete[\s\S]*not a git repository/);
  assert.equal(existsSync(join(bundle, '.git')), false);
  assert.equal(r.status().finished, false);
  initGit(bundle);
  assert.equal(r.finalize().finished, true);
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
    r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id);
    assert.throws(() => r.finalize(), /finalization is incomplete/);
    assert.equal(r.status().finished, false);
    assert.equal(spawnSync('git', ['-C', bundle, 'config', '--get', 'user.email']).status, 1);
    initGit(bundle);
    assert.equal(r.finalize().finished, true);
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
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id);
  assert.throws(() => r.finalize(), /ignored\/missing/);
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
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id);
  assert.throws(() => r.finalize(), /Upgrade verification failed|changed during finalization/);
  assert.equal(git(bundle, 'show', 'HEAD:decisions/privacy.md'), 'broken concept without frontmatter\n');
  assert.equal(validateBundle(bundle).ok, false);
  assert.equal(r.status().finished, false);
  assert.equal(existsSync(r.finalizePath), true);
  r.release();
});

test('verifiers run again after commit even when Git reports a clean bundle', () => {
  const { bundle } = fixture();
  let checks = 0;
  const steps = [{ ...UPGRADE_STEPS[0], verify() { if (++checks === 3) throw new Error('post-commit verification failed'); } }];
  const r = runner(bundle, steps);
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id);
  assert.throws(() => r.finalize(), /post-commit verification failed/);
  assert.equal(checks, 3);
  assert.equal(git(bundle, 'status', '--porcelain'), '');
  assert.equal(r.status().finished, false);
  r.release();
});

test('finalization refuses in-progress Git operations and tracked lock files', () => {
  const { bundle } = fixture();
  const r = runner(bundle);
  r.acquire(); r.nextInstructions(); r.complete(UPGRADE_STEPS[0].id);
  writeFileSync(join(bundle, '.git/MERGE_HEAD'), '0000000000000000000000000000000000000000\n');
  assert.throws(() => r.finalize(), /MERGE_HEAD/);
  rmSync(join(bundle, '.git/MERGE_HEAD'));
  git(bundle, 'add', '--force', '.pi-okf-memory/lock.json');
  assert.throws(() => r.finalize(), /Transient upgrade lock/);
  git(bundle, 'rm', '--cached', '.pi-okf-memory/lock.json');
  assert.equal(r.finalize().finished, true);
  r.release();
});

test('optional workspace corpus read-only check', { skip: !existsSync('/workspace/knowledge/index.md') }, () => {
  // Never migrate, modify, or assume particular concepts in a user's real bundle.
  const result = validateBundle('/workspace/knowledge');
  assert.ok(Number.isInteger(result.conceptCount));
});
