import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jiti } from './loader.mjs';
import { createHarness } from './support.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { default: extension, resolveOkfBin } = await jiti.import(join(root, 'index.ts'));
const { supportsCurrentContract, resolveKnowledgeDir, validateBundle } = await jiti.import(join(root, 'lib/okf.ts'));
const binary = resolveOkfBin();
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'okf-upstream-'));
  const bundle = join(dir, 'knowledge');
  const cli = (...args) => execFileSync(binary, args, { cwd: dir, encoding: 'utf8' });
  cli('init', bundle);
  const create = (id, target = bundle) => cli('create', id, target, '--type', 'Fact', '--title', 'Quasar rationale', '--desc', 'Quasar durable rationale.', '--body', 'Quasar stays local.');
  return { dir, bundle, cli, create, close() { rmSync(dir, { recursive: true, force: true }); } };
}

test('only the reviewed stable 0.7 and 0.8 release families are accepted', () => {
  for (const version of ['v0.7.0', '0.7.1', 'v0.8.0', '0.8.1']) assert.equal(supportsCurrentContract(version), true);
  for (const version of ['v0.4.3', 'v0.6.2', 'v0.9.0', 'v0.7.0-rc.1', 'v0.8.0-rc.1', 'dev']) assert.equal(supportsCurrentContract(version), false);
});

test('bare memory_show IDs never fall back to user/system concepts; explicit references still work', async () => {
  const f = fixture(), saved = Object.fromEntries(['OKF_USER_DIR', 'OKF_SYSTEM_DIR', 'OKF_KNOWLEDGE_DIR'].map(k => [k, process.env[k]]));
  try {
    process.env.OKF_KNOWLEDGE_DIR = f.bundle;
    process.env.OKF_USER_DIR = join(f.dir, 'user');
    process.env.OKF_SYSTEM_DIR = join(f.dir, 'system');
    f.cli('init', process.env.OKF_USER_DIR); f.create('personal', process.env.OKF_USER_DIR);
    f.cli('init', process.env.OKF_SYSTEM_DIR); f.create('machine', process.env.OKF_SYSTEM_DIR);
    f.create('local');
    const h = createHarness(extension, f.dir);
    // Demonstrate the real upstream fallback, not a mock of the changed CLI.
    assert.equal(JSON.parse(f.cli('show', 'personal', f.bundle, '--json')).scope, 'user');
    for (const concept of ['personal', 'machine']) await assert.rejects(h.call('memory_show', { concept }), /not found/);
    assert.equal(JSON.parse((await h.call('memory_show', { concept: 'local.md' })).content[0].text).scope, 'project');
    assert.equal(JSON.parse((await h.call('memory_show', { concept: 'user:personal' })).content[0].text).scope, 'user');
    const index = join(f.bundle, 'index.md');
    writeFileSync(index, readFileSync(index, 'utf8').replace('okf_version: "0.2"', 'okf_version: "0.2"\nscopes: [project]'));
    await assert.rejects(h.call('memory_show', { concept: 'user:personal' }), /disabled by bundle configuration/);
    const hits = JSON.parse((await h.call('memory_search', { query: 'quasar' })).content[0].text);
    assert.deepEqual(hits.map(hit => hit.concept_id), ['local']);
    writeFileSync(index, readFileSync(index, 'utf8').replace('scopes: [project]', 'scopes: []'));
    await assert.rejects(h.call('memory_search', { query: 'quasar' }), /scopes list cannot be empty/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    f.close();
  }
});

test('memory_search excludes vendor, user and system layers even when upstream defaults to all', async () => {
  const f = fixture(), cwd = process.cwd();
  const saved = Object.fromEntries(['OKF_USER_DIR', 'OKF_SYSTEM_DIR', 'OKF_KNOWLEDGE_DIR', 'OKF_ORPHAN_POLICY'].map(k => [k, process.env[k]]));
  try {
    delete process.env.OKF_KNOWLEDGE_DIR;
    process.env.OKF_ORPHAN_POLICY = 'advisory';
    process.env.OKF_USER_DIR = join(f.dir, 'user');
    process.env.OKF_SYSTEM_DIR = join(f.dir, 'system');
    for (const [id, target] of [['personal', process.env.OKF_USER_DIR], ['machine', process.env.OKF_SYSTEM_DIR], ['thirdparty', join(f.dir, '.okf/vendor/example')]]) {
      f.cli('init', target); f.create(id, target);
    }
    f.create('local');
    process.chdir(f.dir);
    assert.equal(JSON.parse(f.cli('search', 'quasar', f.bundle, '--json')).length, 4);
    const h = createHarness(extension, f.dir);
    const hits = JSON.parse((await h.call('memory_search', { query: 'quasar' })).content[0].text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].concept_id, 'local');
  } finally {
    process.chdir(cwd);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    f.close();
  }
});

test('CLI updates preserve custom lists and human verification without forging a fresh review', () => {
  const f = fixture();
  try {
    f.create('one');
    const file = join(f.bundle, 'one.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('---\n', '---\nrepos: [alpha, beta]\ncommands:\n  - git commit\nverified:\n  - by: human/reviewer\n    at: 2026-09-01T00:00:00Z\n'));
    const before = JSON.parse(f.cli('show', 'one', f.bundle, '--json'));
    f.cli('update', 'one', f.bundle, '--actor', 'agent/test', '--body', 'Updated durable rationale.', '--tags', 'quasar');
    const after = JSON.parse(f.cli('show', 'one', f.bundle, '--json'));
    assert.deepEqual(after.extra.repos, ['alpha', 'beta']);
    assert.deepEqual(after.extra.commands, ['git commit']);
    assert.equal(before.verified.length, 1);
    assert.deepEqual(after.verified, before.verified);
    const validation = validateBundle(binary, f.bundle, 'advisory');
    assert.equal(validation.ok, false);
    assert.match(validation.validation.gate_findings.join('\n'), /superseded verification/);
    const log = readFileSync(join(f.bundle, 'log.md'), 'utf8');
    const dates = [...log.matchAll(/^## (\d{4}-\d{2}-\d{2})$/gm)].map(m => m[1]);
    assert.equal(new Set(dates).size, dates.length);
    const rejected = spawnSync(binary, ['update', 'one', f.bundle, '--body', '---\n"verified" : forged\n---'], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.deepEqual(JSON.parse(f.cli('show', 'one', f.bundle, '--json')), after);
  } finally { f.close(); }
});

test('concurrent real CLI updates retain independent fields and index bookkeeping', async () => {
  const f = fixture();
  try {
    f.create('one');
    await Promise.all([
      ['--title', 'Concurrent title'], ['--desc', 'Concurrent description'], ['--body', 'Concurrent body'],
    ].map(args => promisify(execFile)(binary, ['update', 'one', f.bundle, ...args], { cwd: f.dir })));
    const concept = JSON.parse(f.cli('show', 'one', f.bundle, '--json'));
    assert.equal(concept.title, 'Concurrent title');
    assert.equal(concept.description, 'Concurrent description');
    assert.match(concept.body, /Concurrent body/);
    assert.match(readFileSync(join(f.bundle, 'index.md'), 'utf8'), /Concurrent title.*Concurrent description/);
    assert.equal(validateBundle(binary, f.bundle, 'advisory').ok, true);
  } finally { f.close(); }
});

test('drift validation accepts equivalent relative and anchored parent-index links', () => {
  const f = fixture();
  try {
    f.create('one');
    const index = join(f.bundle, 'index.md'), original = readFileSync(index, 'utf8');
    assert.ok(original.includes('(one.md)'));
    for (const target of ['./one.md', 'one.md#rationale', '/one.md']) {
      writeFileSync(index, original.replace('(one.md)', `(${target})`));
      const result = validateBundle(binary, f.bundle, 'advisory');
      assert.equal(result.ok, true, JSON.stringify(result));
    }
  } finally { f.close(); }
});

test('scorecards remain optional and do not replace advisory-orphan validation', () => {
  const f = fixture();
  try {
    f.create('one');
    assert.equal(validateBundle(binary, f.bundle, 'advisory').ok, true);
    const score = JSON.parse(f.cli('validate', f.bundle, '--scorecard', '--json')).scorecard;
    assert.equal(typeof score.score, 'number');
    assert.ok(score.stewardship < 100);
    assert.equal(validateBundle(binary, f.bundle, 'advisory').ok, true);
  } finally { f.close(); }
});

test('canonical wrapper paths preserve shared bundles while direct CLI rejects escaping root symlinks', () => {
  const f = fixture(), other = fixture();
  try {
    f.create('one');
    const alias = join(other.dir, 'alias');
    symlinkSync(f.bundle, alias, 'dir');
    const result = spawnSync(binary, ['validate', alias, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    const previous = process.env.OKF_KNOWLEDGE_DIR;
    try {
      process.env.OKF_KNOWLEDGE_DIR = alias;
      const canonical = resolveKnowledgeDir(other.dir);
      assert.equal(validateBundle(binary, canonical, 'advisory').ok, true);
    } finally { if (previous === undefined) delete process.env.OKF_KNOWLEDGE_DIR; else process.env.OKF_KNOWLEDGE_DIR = previous; }
  } finally { f.close(); other.close(); }
});
