import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jiti } from './loader.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { memoryDiagnostics, formatDiagnostics } = await jiti.import(join(root, 'lib/diagnostics.ts'));

test('diagnostics identify the loaded package, bundle, ownership and declarations without credentials', () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'okf-diagnostics-')));
  const env = Object.fromEntries(['OKF_KNOWLEDGE_DIR', 'PI_CODING_AGENT_DIR', 'PI_MEMORY_OWNERSHIP'].map(k => [k, process.env[k]]));
  const pkg = join(work, 'pkg'), cwd = join(work, 'project'), agent = join(work, 'agent'), entry = join(pkg, 'index.ts');
  try {
    mkdirSync(pkg); mkdirSync(join(cwd, '.pi'), { recursive: true }); mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent; delete process.env.OKF_KNOWLEDGE_DIR; delete process.env.PI_MEMORY_OWNERSHIP;
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [pkg], secret: 'DO_NOT_PRINT' }));
    writeFileSync(join(cwd, '.pi/settings.json'), JSON.stringify({ packages: ['../../pkg'], unrelated: 'DO_NOT_PRINT' }));
    const missing = memoryDiagnostics(entry, '1.2.3', cwd);
    assert.equal(missing.bundle, null); assert.equal(missing.extensionFile, entry); assert.equal(missing.packageDir, pkg);
    assert.equal(missing.ownership, 'limited');
    assert.equal(missing.settings[0].matches[0], `packages: ${pkg}`); assert.equal(missing.settings[1].matches[0], `packages: ${pkg}`);
    assert.doesNotMatch(JSON.stringify(missing), /DO_NOT_PRINT/);
    assert.match(formatDiagnostics(missing), /Knowledge bundle: \(none found\)/);
    mkdirSync(join(cwd, 'knowledge')); writeFileSync(join(cwd, 'knowledge/index.md'), '# Knowledge\n');
    process.env.PI_MEMORY_OWNERSHIP = 'full';
    const found = memoryDiagnostics(entry, '1.2.3', cwd);
    assert.equal(found.bundle, join(cwd, 'knowledge')); assert.equal(found.ownership, 'full');
    const text = formatDiagnostics(found);
    assert.match(text, /no external binary/); assert.match(text, /\(1\.2\.3\)/); assert.doesNotMatch(text, /OKF_BIN/);
    process.env.PI_MEMORY_OWNERSHIP = 'everything';
    assert.match(memoryDiagnostics(entry, '1.2.3', cwd).ownership, /^invalid/);
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(work, { recursive: true, force: true });
  }
});
