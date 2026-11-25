import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jiti } from './loader.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = realpathSync(mkdtempSync(join(tmpdir(), 'pi-okf-store-')));
const saved = Object.fromEntries(['OKF_INDEX_BUDGET', 'OKF_DEMOTE_IDLE_SESSIONS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PI_CODING_AGENT_DIR'].map(k => [k, process.env[k]]));
delete process.env.OKF_INDEX_BUDGET; delete process.env.OKF_DEMOTE_IDLE_SESSIONS;
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';
const memory = await jiti.import(join(root, 'lib/memory.ts'));
const store = await jiti.import(join(root, 'lib/store.ts'));
const view = await jiti.import(join(root, 'lib/view.ts'));
const usage = await jiti.import(join(root, 'lib/usage.ts'));
const { search, stem, tokenize, sections } = await jiti.import(join(root, 'lib/search.ts'));
const { UpgradeRunner, UPGRADE_STEPS, migrateToNativeLayout } = await jiti.import(join(root, 'lib/upgrades.ts'));
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let seq = 0;
function bundle({ ledger = true } = {}) {
  const dir = join(work, `bundle-${++seq}`);
  memory.initBundle(dir);
  if (ledger) { mkdirSync(join(dir, '.pi-okf-memory')); writeFileSync(join(dir, '.pi-okf-memory/.gitignore'), 'lock.json\nusage.jsonl\n'); }
  return dir;
}
const add = (dir, id, extra = {}) => memory.writeConcept(dir, { id, title: `Title ${id}`, description: `Description of ${id}.`, body: `Body of ${id}.`, ...extra });
const read = (dir, name) => readFileSync(join(dir, name), 'utf8');
after(() => {
  rmSync(work, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('frontmatter round-trips unknown and structured fields; values are quoted only when needed', () => {
  const dir = bundle();
  writeFileSync(join(dir, 'legacy.md'), `---\ntype: Requirement\ntitle: Plain title\ndescription: "Quoted: with colon; and 'apostrophe'"\ngenerated: { by: agent/cli, at: "2026-10-05T12:44:22Z" }\nstatus: stable\ntags:\n  - one\n  - two\ncustom:\n  nested: kept\nstale_after: 2099-01-01\n---\n\nBody.\n`);
  const before = store.readConcept(dir, 'legacy');
  assert.deepEqual([before.type, before.title, before.description, before.status, before.tags, before.updated, before.created, before.staleAfter],
    ['Requirement', 'Plain title', "Quoted: with colon; and 'apostrophe'", 'stable', ['one', 'two'], '2026-10-05T12:44:22Z', '2026-10-05T12:44:22Z', '2099-01-01']);
  memory.writeConcept(dir, { id: 'legacy', description: 'New summary', now: new Date('2027-01-02T03:04:05.678Z') });
  const text = read(dir, 'legacy.md');
  assert.match(text, /^---\ntype: Requirement\ntitle: Plain title\ndescription: New summary\n/);
  assert.match(text, /\ncustom:\n  nested: kept\n/);            // structured unknown field untouched
  assert.match(text, /\ntags:\n  - one\n  - two\n/);
  assert.match(text, /\ncreated: "2026-10-05T12:44:22Z"\n/);    // the old last-write stamp becomes the creation time
  assert.match(text, /\ngenerated: \{ by: agent, at: "2027-01-02T03:04:05Z" \}\n/);
  assert.match(text, /\n---\n\nBody\.\n$/);
  for (const [value, encoded] of [['simple words', 'simple words'], ['has: colon', '"has: colon"'], ["it's", '"it\'s"'], ['true', '"true"'], ['12', '"12"'], ['multi\nline', 'multi line']]) {
    assert.equal(store.encodeScalar(value), encoded);
    assert.equal(store.decodeScalar(encoded), value.replace('\n', ' '));
  }
});

test('validation reports unreadable concepts, bad names, symlinks and broken links; code and external links are ignored', () => {
  const dir = bundle();
  add(dir, 'a', { body: 'Good [b](sub/b.md#x), external [x](https://example.com/x.md), anchor [y](#y), `[code](nope.md)`.\n\n```\n[fenced](nope.md)\n```\n' });
  add(dir, 'sub/b', { body: 'Back [a](../a.md) and [index](../index.md).' });
  assert.deepEqual(memory.validateBundle(dir), { ok: true, conceptCount: 2, findings: [], advisories: [] });
  writeFileSync(join(dir, 'nofm.md'), 'no frontmatter\n');
  writeFileSync(join(dir, 'notitle.md'), '---\ndescription: d\n---\n');
  writeFileSync(join(dir, 'Bad Name.md'), '---\ntitle: t\ndescription: d\n---\n');
  symlinkSync(join(dir, 'a.md'), join(dir, 'link.md'));
  writeFileSync(join(dir, 'sub/b.md'), read(dir, 'sub/b.md') + '\n[gone](gone.md) [escape](../../outside.md)\n');
  const result = memory.validateBundle(dir);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(f => [f.code, f.file]).sort(), [
    ['broken-link', 'sub/b.md'], ['broken-link', 'sub/b.md'], ['invalid-concept', 'Bad Name.md'], ['invalid-concept', 'nofm.md'], ['invalid-concept', 'notitle.md'], ['symlink', 'link.md'],
  ].sort());
  assert.equal(result.conceptCount, 2);
});

test('the index holds pinned rules plus an Active set within its budget; the catalog lists everything', () => {
  const dir = bundle({ ledger: false });
  add(dir, 'convention/rule'); add(dir, 'topic-a'); add(dir, 'topic-b'); add(dir, 'old', { status: 'deprecated' });
  const index = read(dir, 'index.md'), catalog = read(dir, 'catalog.md');
  assert.match(index, /^---\nokf_version: "0\.2"\ngenerated_by: pi-okf-agent-memory\n---\n\n# Knowledge\n\n## Standing rules\n\* \[Title convention\/rule\]\(convention\/rule\.md\) - Description of convention\/rule\.\n\n## Active\n/);
  assert.deepEqual(view.parseActive(index), ['topic-a', 'topic-b']);   // deprecated and pinned concepts are never "active"
  assert.match(index, /## Not shown\n1 more concept \(top level 1\)\. Find them with memory_search; \[catalog\.md\]\(catalog\.md\) lists every ID\.\n$/);
  for (const [id, tier] of [['convention/rule', 'pinned'], ['topic-a', 'active'], ['old', 'deprecated']]) assert.ok(catalog.includes(`\`${id}\` (${tier})`), `${id} ${tier}`);
  assert.equal(memory.validateBundle(dir).ok, true);
  // A budget that fits one entry keeps the newest write and drops the rest from the index only.
  process.env.OKF_INDEX_BUDGET = '80';
  try {
    const written = add(dir, 'topic-c');
    assert.deepEqual(written.view.active, ['topic-c']);
    assert.deepEqual(written.view.demoted.sort(), ['topic-a', 'topic-b']);
    assert.match(read(dir, 'index.md'), /3 more concepts/);
    assert.ok(read(dir, 'catalog.md').includes('`topic-a` (catalog)'));
    process.env.OKF_INDEX_BUDGET = '0';
    assert.deepEqual(view.refreshView(dir).active, []);
    assert.doesNotMatch(read(dir, 'index.md'), /## Active/);
  } finally { delete process.env.OKF_INDEX_BUDGET; }
  // pinned: true keeps a non-convention concept in the index regardless of budget or use.
  memory.writeConcept(dir, { id: 'topic-a', pinned: true });
  assert.match(read(dir, 'index.md'), /## Standing rules\n[^#]*topic-a\.md/);
  assert.equal(memory.validateBundle(dir).ok, true);
});

test('usage drives the index: opens promote, idle concepts are demoted at rebalance, manual demotion sticks until reuse', () => {
  const dir = bundle();
  process.env.OKF_DEMOTE_IDLE_SESSIONS = '3';
  try {
    for (const id of ['one', 'two', 'three']) add(dir, id);
    assert.deepEqual(view.parseActive(read(dir, 'index.md')), ['one', 'three', 'two']);
    for (let i = 0; i < 2; i++) usage.recordUsage(dir, 'session');
    usage.recordUsage(dir, 'hit', ['two']);                    // a top search hit keeps a concept alive
    usage.recordUsage(dir, 'session');
    assert.deepEqual(view.refreshView(dir).demoted, [], 'no demotion without an explicit rebalance');
    const rebalanced = view.refreshView(dir, { rebalance: true });
    assert.deepEqual(rebalanced.demoted.sort(), ['one', 'three']);
    assert.deepEqual(rebalanced.active, ['two']);
    const stats = usage.readUsage(dir);
    assert.deepEqual([stats.sessions, usage.idleSessions(stats, 'one'), usage.idleSessions(stats, 'two'), stats.concepts.two.hits], [3, 3, 1, 1]);
    usage.recordUsage(dir, 'open', ['one']);                   // what memory_show records
    assert.deepEqual(view.refreshView(dir, { promote: ['one'] }).promoted, ['one']);
    usage.recordUsage(dir, 'demote', ['one']);
    assert.deepEqual(view.refreshView(dir, { demote: ['one'] }).demoted, ['one']);
    assert.deepEqual(view.refreshView(dir, { rebalance: true }).active, ['two'], 'a rebalance does not undo a manual demotion');
    usage.recordUsage(dir, 'open', ['one']);
    assert.deepEqual(view.refreshView(dir, { rebalance: true }).active, ['one', 'two']);
    // A concept the ledger has never seen (pulled or hand-written) starts its idle clock now.
    writeFileSync(join(dir, 'pulled.md'), '---\ntitle: Pulled\ndescription: Arrived by git pull.\n---\n');
    view.refreshView(dir, { rebalance: true });
    assert.equal(usage.idleSessions(usage.readUsage(dir), 'pulled'), 0);
    // Moving a concept keeps its history.
    memory.moveConcept(dir, 'two', 'archive/two');
    assert.equal(usage.readUsage(dir).concepts['archive/two'].hits, 1);
    assert.equal(usage.readUsage(dir).concepts.two, undefined);
  } finally { delete process.env.OKF_DEMOTE_IDLE_SESSIONS; }
});

test('the usage ledger is never written before the bundle ignores it, and compacts without losing counts', () => {
  const dir = bundle({ ledger: false });
  add(dir, 'one');
  usage.recordUsage(dir, 'session'); usage.recordUsage(dir, 'open', ['one']);
  assert.equal(existsSync(usage.ledgerPath(dir)), false);
  assert.equal(usage.readUsage(dir).available, false);
  mkdirSync(join(dir, '.pi-okf-memory')); writeFileSync(join(dir, '.pi-okf-memory/.gitignore'), 'usage.jsonl\n');
  for (let i = 0; i < 12000; i++) usage.recordUsage(dir, i % 100 === 0 ? 'session' : 'open', ['one']);
  const stats = usage.readUsage(dir);
  assert.deepEqual([stats.sessions, stats.concepts.one.opens], [120, 11880]);
  assert.ok(read(dir, '.pi-okf-memory/usage.jsonl').length < 600 * 1024);
  assert.match(read(dir, '.pi-okf-memory/usage.jsonl'), /^\{"k":"snap"/);
});

test('search stems, weights titles above bodies, returns the matching section and degrades to partial matches', () => {
  assert.deepEqual(['runners', 'running', 'queued', 'policies', 'classes', 'pricing'].map(stem), ['runner', 'run', 'queu', 'policy', 'class', 'pric']);
  assert.deepEqual(tokenize('The Self-hosted runners: v2.1 of the cache!'), ['self-host', 'self', 'host', 'runner', 'v2.1', 'v2', 'cach']);
  assert.deepEqual(sections('intro\n\n## One\n\na\n\n```\n## not a heading\n```\n\n## Two\n\nb').map(s => s.heading), ['', 'One', 'Two']);
  const dir = bundle();
  add(dir, 'runner-fleet', { title: 'GitHub runner fleet', description: 'Cache locality and starvation.', body: '## Background\n\nGeneral notes.\n\n## Starvation incident\n\nScale-up lambdas timed out after GitHub returned 429 responses.' });
  add(dir, 'pricing', { title: 'Hosted database pricing', description: 'Bounded resource economics.', body: 'A runner is mentioned once here in passing.' });
  add(dir, 'unrelated', { body: 'Nothing relevant.' });
  const { concepts } = store.loadConcepts(dir);
  const hits = search(concepts, 'runners starvation 429');
  assert.equal(hits[0].concept, 'runner-fleet');
  assert.equal(hits[0].section, 'Starvation incident');
  assert.match(hits[0].snippet, /429 responses/);
  assert.deepEqual(hits.map(h => h.concept), ['runner-fleet', 'pricing']);   // body-only partial match ranks below, unrelated is absent
  assert.ok(hits[0].score > hits[1].score * 3);
  assert.equal(search(concepts, 'database prices')[0].concept, 'pricing');     // stemming: prices ~ pricing
  assert.deepEqual(search(concepts, 'the of and'), []);
  assert.equal(search(concepts, 'runner', 1).length, 1);
});

test('migration converts an OKF-CLI-era bundle in place: one generated index, a catalog, seeded usage, no model', () => {
  const cwd = join(work, `project-${++seq}`), dir = join(cwd, 'knowledge');
  mkdirSync(join(dir, 'decisions'), { recursive: true }); mkdirSync(join(dir, 'convention'));
  const concept = (title, description, at, body = 'Body.') => `---\ntype: Decision\ntitle: ${title}\ndescription: ${description}\ngenerated: { by: agent/cli, at: "${at}" }\n---\n\n${body}\n`;
  writeFileSync(join(dir, 'index.md'), '---\nokf_version: "0.2"\n---\n\n# Knowledge Base\n* [Root topic](root-topic.md) - Root description.\n* [Conventions](convention/index.md) - Rules.\n- [decisions](decisions/index.md) — Knowledge maintained from session evidence.\n');
  writeFileSync(join(dir, 'log.md'), '## 2026-10-01\n* **Creation**: Documented concept `root-topic.md` (Root topic).\n');
  writeFileSync(join(dir, 'root-topic.md'), concept('Root topic', 'Root description.', '2026-10-01T00:00:00Z', 'See the [decision list](decisions/index.md) and [used](decisions/used.md).'));
  writeFileSync(join(dir, 'decisions/index.md'), '# Decisions\n* [Used](used.md) - Used description.\n* [Unused](unused.md) - Unused description.\n');
  writeFileSync(join(dir, 'decisions/used.md'), concept('Used', 'Used description.', '2026-10-02T00:00:00Z'));
  writeFileSync(join(dir, 'decisions/unused.md'), concept('Unused', 'Unused description.', '2026-10-02T00:00:00Z'));
  writeFileSync(join(dir, 'convention/index.md'), '# Convention\n* [Ask first](ask-first.md) - Ask before contacting anyone.\n');
  writeFileSync(join(dir, 'convention/ask-first.md'), concept('Ask first', 'Ask before contacting anyone.', '2026-10-01T00:00:00Z'));
  // A ledger left by package 0.10.0 with the bundled OKF binary.
  mkdirSync(join(dir, '.pi-okf-memory'));
  writeFileSync(join(dir, '.pi-okf-memory/.gitignore'), 'lock.json\n.state-*.tmp\nfinalize-pending\n');
  writeFileSync(join(dir, '.pi-okf-memory/state.json'), JSON.stringify({ schema: 1, completed: [{ id: '001-validation-contract', at: '2026-09-26T15:18:49.545Z', packageVersion: '0.2.0', okfVersion: 'v0.4.3' }], application: { packageVersion: '0.10.0', okfVersion: 'v0.7.0' } }, null, 2) + '\n');
  git(dir, 'init', '--quiet'); git(dir, 'config', 'user.name', 'Store Tests'); git(dir, 'config', 'user.email', 'store@example.invalid'); git(dir, 'config', 'commit.gpgSign', 'false');
  git(dir, 'add', '-A'); git(dir, 'commit', '--quiet', '-m', 'okf era');
  // pi session logs for this workspace: 30 sessions; "used" was opened in the latest, "unused" never.
  const agent = join(work, `agent-${seq}`), sessions = join(agent, 'sessions', `--${cwd.slice(1).replace(/\//g, '-')}--`);
  mkdirSync(sessions, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agent;
  for (let i = 0; i < 30; i++) {
    const day = `2026-11-${String(i + 1).padStart(2, '0')}`;
    const lines = [{ type: 'custom_message', customType: 'okf-memory', timestamp: `${day}T10:00:00.000Z`, content: 'Index' }];
    if (i === 29) lines.push({ type: 'message', timestamp: `${day}T10:01:00.000Z`, message: { role: 'assistant', content: [{ type: 'toolCall', name: 'memory_show', arguments: { concept: 'decisions/used' } }] } },
      { type: 'message', timestamp: `${day}T10:02:00.000Z`, message: { role: 'toolResult', toolName: 'memory_search', content: [{ type: 'text', text: JSON.stringify([{ concept_id: 'root-topic' }]) }] } });
    writeFileSync(join(sessions, `${day}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  }
  try {
    const runner = new UpgradeRunner(dir, join(root, 'skills'), packageVersion);
    assert.deepEqual(runner.status().pending.map(s => s.id), ['002-native-store']);
    assert.equal(memory.validateBundle(dir).ok, false, 'the old layout is not valid native navigation until migrated');
    runner.acquire();
    assert.equal(runner.runAutomatic({ cwd }).pending.length, 0);
    const done = runner.finalize(); runner.release();
    assert.match(done.commit, /^[a-f0-9]{40}$/);
    assert.equal(done.finished, true);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.equal(existsSync(join(dir, 'decisions/index.md')), false);
    assert.equal(existsSync(join(dir, 'convention/index.md')), false);
    assert.match(read(dir, 'root-topic.md'), /\[decision list\]\(catalog\.md\) and \[used\]\(decisions\/used\.md\)/);
    const state = JSON.parse(read(dir, '.pi-okf-memory/state.json'));
    assert.deepEqual(state.completed.map(c => [c.id, c.okfVersion]), [['001-validation-contract', 'v0.4.3'], ['002-native-store', 'native']]);
    assert.deepEqual(state.application, { packageVersion, okfVersion: 'native' });
    // Usage came from history: the opened concept is Active; the one idle for 30 sessions is catalog-only.
    const index = read(dir, 'index.md');
    assert.match(index, /## Standing rules\n\* \[Ask first\]\(convention\/ask-first\.md\)/);
    // Opened or returned near the top of a search recently: Active. Idle for 30 sessions: catalog only.
    assert.deepEqual(view.parseActive(index), ['decisions/used', 'root-topic']);
    assert.match(index, /1 more concept \(decisions\/ 1\)/);
    assert.ok(read(dir, 'catalog.md').includes('`decisions/unused` (catalog)'));
    const stats = usage.readUsage(dir);
    assert.deepEqual([stats.sessions, stats.concepts['decisions/used'].opens, stats.concepts['root-topic'].hits], [30, 1, 1]);
    assert.doesNotMatch(git(dir, 'ls-files'), /usage\.jsonl/);   // local history is never committed
    assert.match(read(dir, '.pi-okf-memory/.gitignore'), /^usage\.jsonl$/m);
    // Idempotent: a second run changes nothing and a fresh runner sees nothing pending.
    migrateToNativeLayout(dir, { cwd });
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.equal(new UpgradeRunner(dir, join(root, 'skills'), packageVersion).status().finished, true);
    assert.equal(UPGRADE_STEPS.every(s => !s.instructions), true, 'shipped steps are deterministic');
  } finally { delete process.env.PI_CODING_AGENT_DIR; }
});
