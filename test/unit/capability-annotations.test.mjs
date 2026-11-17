// Annotations, execute tier, hierarchical grant, tool profiles and alias dedupe.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { annotationsFromPolicy, needsExecuteTier, EFFECT_FLAGS } = require('../../.compiled/src/main/tools/capability-annotations.js');
const { CapabilityCatalogue } = require('../../.compiled/src/main/tools/capability-catalogue.js');

test('annotations: read is readOnly, rollback is destructive, idempotent write is flagged', () => {
  assert.deepEqual(annotationsFromPolicy('anti.inspect.dom', { effect: 'read' }), { readOnlyHint: true });
  assert.deepEqual(annotationsFromPolicy('theme.qa_rollback', { effect: 'destructive-mutation' }), {});
  assert.deepEqual(annotationsFromPolicy('anti.theme.something', { effect: 'idempotent-write' }), { destructiveHint: false, idempotentHint: true });
  assert.deepEqual(annotationsFromPolicy('terminal.write', { effect: 'interactive-effect' }), {}, 'shell input is destructive by default');
});

test('execute tier: flagged capabilities are exactly the process/foreign-code ones', () => {
  assert.equal(needsExecuteTier('terminal.write'), true);
  assert.equal(needsExecuteTier('terminal.create'), true);
  assert.equal(needsExecuteTier('file.write'), false);
  assert.ok(Object.keys(EFFECT_FLAGS).length > 5);
});

test('exclusive grants: each grant sees only its own tier (execute does not inherit write)', () => {
  const cat = new CapabilityCatalogue({ allowEval: true });
  cat.runtime = { mode: 'standalone', lifecycle: 'live' };
  const def = (risk) => ({ name: `t.${risk}`, risk });
  assert.equal(cat.isVisible(def('execute'), 'write'), false, 'a write grant must not reach shell input');
  assert.equal(cat.isVisible(def('write'), 'execute'), false, 'an execute grant must not inherit write-tier tools');
  assert.equal(cat.isVisible(def('execute'), 'execute'), true);
  assert.equal(cat.isVisible(def('write'), 'write'), true);
  assert.equal(cat.isVisible(def('execute'), 'eval'), false, 'eval does not inherit the execute tier');
  assert.equal(cat.isVisible(def('write'), 'eval'), true);
  assert.equal(cat.isVisible(def('eval'), 'execute'), false);
  assert.equal(cat.isVisible(def('read'), undefined), true);
});

function listWith(env) {
  const r = spawnSync(process.execPath, ['-e', "require('./scripts/antifan-omp-mcp.cjs').listTools().then((l)=>process.stdout.write(JSON.stringify(l)))"], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ANTIFAN_TOOL_PROFILE: '', ANTIFAN_ALLOWED_CAPABILITIES: '', ANTIFAN_FORBIDDEN_CAPABILITIES: '', ...env },
  });
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
}

test('tool profile qa is a strict, smaller subset; an unknown profile allows nothing', () => {
  const full = listWith({});
  const qa = listWith({ ANTIFAN_TOOL_PROFILE: 'qa' });
  assert.ok(qa.tools.length > 0 && qa.tools.length < full.tools.length);
  assert.ok(!qa.tools.some((t) => t.name.startsWith('terminal.') || t.name.startsWith('core.')));
  assert.equal(listWith({ ANTIFAN_TOOL_PROFILE: 'no-such-profile' }).tools.length, 0);
});

test('published list carries annotations and the base descriptions stay on aliases', () => {
  const full = listWith({});
  const byName = new Map(full.tools.map((t) => [t.name, t]));
  assert.deepEqual(byName.get('anti.inspect.dom').annotations, { readOnlyHint: true });
  assert.ok(byName.get('anti.theme.qa_validate').description.startsWith('Alias of theme.qa_validate: '));
});

test('the budget gate passes on the real tree', () => {
  const r = spawnSync(process.execPath, ['scripts/check-mcp-budget-dominance.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
