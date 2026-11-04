import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Pure helpers only: `invoke` would dispatch to whatever bridge the ambient environment names.
const { normalizeParameterAliases, attachAliasApplied } = require(path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs'));

test('terminal.write accepts text for input and reports the alias', () => {
  const given = { sessionId: 'terminal-9', text: 'git status\r' };
  const { params, aliasApplied } = normalizeParameterAliases('terminal.write', given);
  assert.deepEqual(params, { sessionId: 'terminal-9', input: 'git status\r' });
  assert.deepEqual(aliasApplied, [{ from: 'text', to: 'input' }]);
  assert.deepEqual(given, { sessionId: 'terminal-9', text: 'git status\r' }, 'the caller object is not mutated');
});

test('an alias never overrides a field the caller supplied', () => {
  const { params, aliasApplied } = normalizeParameterAliases('terminal.write', { sessionId: 's', input: 'real', text: 'other' });
  assert.equal(params.input, 'real');
  assert.equal(params.text, 'other', 'the unused alias field is left for the capability to refuse');
  assert.deepEqual(aliasApplied, []);
});

test('an empty or non-string value is not promoted into the target field', () => {
  assert.deepEqual(normalizeParameterAliases('terminal.write', { sessionId: 's', text: '' }).aliasApplied, []);
  assert.deepEqual(normalizeParameterAliases('terminal.write', { sessionId: 's', text: 42 }).aliasApplied, []);
});

test('file_upload and drop accept files, selector and ref for filePaths and refOrSelector', () => {
  for (const name of ['anti.agent.file_upload', 'anti.agent.drop']) {
    const bySelector = normalizeParameterAliases(name, { selector: '#file', files: ['a.txt'] });
    assert.deepEqual(bySelector.params, { refOrSelector: '#file', filePaths: ['a.txt'] }, name);
    assert.deepEqual(bySelector.aliasApplied, [{ from: 'files', to: 'filePaths' }, { from: 'selector', to: 'refOrSelector' }], name);

    const byRef = normalizeParameterAliases(name, { ref: '@e12', filePaths: ['a.txt'] });
    assert.deepEqual(byRef.params, { refOrSelector: '@e12', filePaths: ['a.txt'] }, name);
  }
});

test('a tool without a declared alias is passed through untouched', () => {
  const given = { tabId: 't', text: 'x', selector: '#a' };
  const { params, aliasApplied } = normalizeParameterAliases('anti.agent.cursor.click', given);
  assert.deepEqual(params, given);
  assert.deepEqual(aliasApplied, []);
});

test('aliasApplied is attached to an object result and never invented for other results', () => {
  const applied = [{ from: 'text', to: 'input' }];
  assert.deepEqual(attachAliasApplied({ woke: false }, applied), { woke: false, aliasApplied: applied });
  assert.deepEqual(attachAliasApplied({ woke: false }, []), { woke: false });
  assert.equal(attachAliasApplied('plain', applied), 'plain');
  assert.deepEqual(attachAliasApplied([1, 2], applied), [1, 2]);
});
