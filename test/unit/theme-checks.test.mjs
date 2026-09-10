/**
 * Theme checks: a captured document or a theme source tree must be refused by
 * name, not silently passed.
 *
 * The fixtures prove the distinctions that decide a refusal: a `{{ }}` in text
 * position is an unrendered template while the same marker in an attribute,
 * `<script>`, `<style>` or a comment is data; a section without a schema block
 * is named while a valid sibling is not; a setting read that was never declared
 * is a failure while a declared-but-unread setting is only dead; and an asset
 * that is absent locally is a failure while a remote one is recorded. The
 * binding fixtures also carry `section.settings.*`/`block.settings.*` reads and
 * a setting mentioned only inside `{% comment %}` — if either were mistaken for
 * a global read, the clean theme would report an undeclared setting.
 *
 * Run with:
 *   node --test --test-force-exit test/unit/theme-checks.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  scanRenderFailures,
  validateThemeSchemas,
  checkSettingsBinding,
  checkAssetReferences,
} from '../../scripts/lib/theme-checks.mjs';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'theme-checks');
const readFixture = (relativePath) => fs.readFileSync(path.join(FIXTURES, relativePath), 'utf8');
const fixtureTheme = (name) => path.join(FIXTURES, name);

function rulesOf(result) {
  return result.failures.map((failure) => failure.rule);
}

test('scanRenderFailures passes a surface whose markers are all in data position', () => {
  const result = scanRenderFailures(readFixture(path.join('render', 'clean.html')));
  assert.deepEqual(result, { ok: true, failures: [] });
});

test('scanRenderFailures ignores markers in attributes, script, style and comments', () => {
  const result = scanRenderFailures(readFixture(path.join('render', 'data-position.html')));
  assert.deepEqual(result, { ok: true, failures: [] });
});

test('scanRenderFailures names each Liquid failure phrase from text position', () => {
  const result = scanRenderFailures(readFixture(path.join('render', 'liquid-error.html')));
  assert.equal(result.ok, false);
  assert.deepEqual(rulesOf(result), ['LIQUID_ERROR', 'LIQUID_EXCEPTION', 'LIQUID_SYNTAX_ERROR']);

  const byRule = new Map(result.failures.map((failure) => [failure.rule, failure]));
  assert.equal(byRule.get('LIQUID_ERROR').count, 1, 'the quoted script-body occurrence is not a rendered failure');
  assert.match(byRule.get('LIQUID_ERROR').example, /Liquid error: undefined method/);
  assert.match(byRule.get('LIQUID_EXCEPTION').example, /Liquid Exception: invalid byte sequence/);
  assert.match(byRule.get('LIQUID_SYNTAX_ERROR').example, /Liquid syntax error: Expected endif/);
});

test('scanRenderFailures names unrendered output and tags in text position', () => {
  const result = scanRenderFailures(readFixture(path.join('render', 'unrendered-text.html')));
  assert.equal(result.ok, false);
  assert.deepEqual(rulesOf(result), ['UNRENDERED_OUTPUT', 'UNRENDERED_TAG']);

  const byRule = new Map(result.failures.map((failure) => [failure.rule, failure]));
  assert.equal(byRule.get('UNRENDERED_OUTPUT').count, 1);
  assert.equal(byRule.get('UNRENDERED_TAG').count, 2);
  assert.match(byRule.get('UNRENDERED_OUTPUT').example, /\{\{ product\.title \}\}/);
  assert.match(byRule.get('UNRENDERED_TAG').example, /\{% if collection\.products\.size > 0 %\}/);
  assert.match(byRule.get('UNRENDERED_TAG').example, /^line 9: /, 'the example carries the line of the first occurrence');
});

test('scanRenderFailures counts every occurrence of a rule', () => {
  const html = '<p>{{ a }}</p>\n<p data-x="{{ b }}">ok</p>\n<p>{{ c }}</p>\n';
  const result = scanRenderFailures(html);
  assert.deepEqual(rulesOf(result), ['UNRENDERED_OUTPUT']);
  assert.equal(result.failures[0].count, 2, 'the attribute occurrence is data, the two text occurrences are not');
});

test('scanRenderFailures resumes text position after a quoted attribute containing ">"', () => {
  const result = scanRenderFailures('<p title="a > b">text</p>{{ leaked }}{% tag %}');
  assert.deepEqual(rulesOf(result), ['UNRENDERED_OUTPUT', 'UNRENDERED_TAG']);
});

test('scanRenderFailures resumes text position after a script body containing ">"', () => {
  const result = scanRenderFailures('<script>if (a > b) { render(); }</script><p>{{ leaked }}</p>');
  assert.deepEqual(rulesOf(result), ['UNRENDERED_OUTPUT']);
  assert.equal(result.failures[0].count, 1);
});

test('scanRenderFailures flags a marker inside title text', () => {
  const result = scanRenderFailures('<title>{{ page.title }}</title>');
  assert.deepEqual(rulesOf(result), ['UNRENDERED_OUTPUT']);
});

test('scanRenderFailures is deterministic for the same document', () => {
  const html = readFixture(path.join('render', 'unrendered-text.html'));
  assert.deepEqual(scanRenderFailures(html), scanRenderFailures(html));
});

test('scanRenderFailures tolerates a non-string argument', () => {
  assert.deepEqual(scanRenderFailures(undefined), { ok: true, failures: [] });
});

test('validateThemeSchemas accepts a theme whose schema file and sections parse', () => {
  const result = validateThemeSchemas(fixtureTheme('theme-clean'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.schemaFiles, [{ path: 'config/settings_schema.json', ok: true, error: null }]);
  assert.deepEqual(result.sections, [{ path: 'sections/hero.html', ok: true, error: null }]);
  assert.deepEqual(result.failures, []);
});

test('validateThemeSchemas names an invalid schema block, a missing one and an unterminated one', () => {
  const result = validateThemeSchemas(fixtureTheme('theme-broken'));
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.failures.map((failure) => ({ rule: failure.rule, path: failure.path })),
    [
      { rule: 'SECTION_SCHEMA_JSON_INVALID', path: 'sections/bad-schema.html' },
      { rule: 'SECTION_SCHEMA_MISSING', path: 'sections/promo.html' },
      { rule: 'SECTION_SCHEMA_UNTERMINATED', path: 'sections/truncated.html' },
    ],
  );
  for (const failure of result.failures) assert.ok(failure.detail.length > 0, `${failure.rule} must explain itself`);

  const sectionsByPath = new Map(result.sections.map((section) => [section.path, section]));
  assert.equal(sectionsByPath.get('sections/hero.html').ok, true);
  assert.equal(sectionsByPath.get('sections/hero.html').error, null);
  assert.equal(sectionsByPath.get('sections/promo.html').ok, false);
  assert.equal(result.schemaFiles[0].ok, true, 'the settings schema itself is valid in this fixture');
});

test('validateThemeSchemas refuses a theme with no settings_schema.json', () => {
  const result = validateThemeSchemas(fixtureTheme('theme-noschema'));
  assert.equal(result.ok, false);
  assert.deepEqual(rulesOf(result), ['SETTINGS_SCHEMA_MISSING']);
  assert.equal(result.failures[0].path, 'config/settings_schema.json');
  assert.deepEqual(result.schemaFiles, [{ path: 'config/settings_schema.json', ok: false, error: 'file not found' }]);
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].ok, true, 'a section that does parse is still reported ok');
});

test('validateThemeSchemas refuses a directory that does not exist without throwing', () => {
  const result = validateThemeSchemas(fixtureTheme('theme-absent'));
  assert.equal(result.ok, false);
  assert.deepEqual(rulesOf(result), ['SETTINGS_SCHEMA_MISSING']);
  assert.deepEqual(result.sections, []);
});

test('validateThemeSchemas is deterministic for the same theme', () => {
  assert.deepEqual(validateThemeSchemas(fixtureTheme('theme-broken')), validateThemeSchemas(fixtureTheme('theme-broken')));
});

test('checkSettingsBinding accepts reads that resolve, including nested block settings', () => {
  const result = checkSettingsBinding(fixtureTheme('theme-clean'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.undeclared, []);
  assert.deepEqual(result.dead, []);
  assert.deepEqual(result.failures, []);
});

test('checkSettingsBinding names an undeclared read and reports a declared-but-unread setting as dead', () => {
  const result = checkSettingsBinding(fixtureTheme('theme-broken'));
  assert.equal(result.ok, false);
  assert.deepEqual(result.undeclared, [{ id: 'undeclared_setting', files: ['layout/theme.liquid'] }]);
  assert.deepEqual(result.dead, [{ id: 'dead_setting' }]);
  assert.deepEqual(rulesOf(result), ['SETTING_UNDECLARED']);
  assert.equal(result.failures[0].id, 'undeclared_setting');
  assert.match(result.failures[0].detail, /settings\.undeclared_setting is read in layout\/theme\.liquid/);
});

test('checkSettingsBinding reports every read as undeclared when the schema is missing', () => {
  const result = checkSettingsBinding(fixtureTheme('theme-noschema'));
  assert.equal(result.ok, false);
  assert.deepEqual(result.undeclared, [{ id: 'orphan_setting', files: ['layout/theme.liquid'] }]);
  assert.deepEqual(result.dead, []);
});

test('checkSettingsBinding tolerates a theme directory that does not exist', () => {
  assert.deepEqual(checkSettingsBinding(fixtureTheme('theme-absent')), {
    ok: true,
    undeclared: [],
    dead: [],
    failures: [],
  });
});

test('checkSettingsBinding is deterministic for the same theme', () => {
  assert.deepEqual(checkSettingsBinding(fixtureTheme('theme-clean')), checkSettingsBinding(fixtureTheme('theme-clean')));
});

test('checkAssetReferences resolves literals against assets/ and static/', () => {
  const result = checkAssetReferences(fixtureTheme('theme-clean'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.localMissing, []);
  assert.deepEqual(result.remote, []);
  assert.deepEqual(
    result.counts,
    { localPresent: 6, localMissing: 0, remote: 0 },
    'main.css, logo.png, hero.png, favicon.ico, and compiled.js/theme.scss.css through their .liquid sources',
  );
});

test('checkAssetReferences never resolves a reference that escapes the theme', () => {
  const result = checkAssetReferences(fixtureTheme('theme-traversal'));
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.localMissing.map((entry) => entry.ref),
    ['../assets/main.css'],
    'assets/main.css exists, but a reference that must escape the theme to reach it is missing',
  );
  assert.deepEqual(result.counts, { localPresent: 0, localMissing: 1, remote: 0 });
});

test('checkAssetReferences names a missing local asset and records a remote origin', () => {
  const result = checkAssetReferences(fixtureTheme('theme-broken'));
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.localMissing.map((entry) => entry.ref),
    ['also-missing.png', 'missing.css'],
  );
  assert.deepEqual(result.localMissing[1].files, ['snippets/broken.liquid']);
  assert.deepEqual(result.localMissing[0].files, ['layout/theme.liquid']);
  assert.deepEqual(
    result.remote.map((entry) => entry.origin),
    ['//cdn.example.com', 'https://cdn.example.com'],
  );
  assert.deepEqual(result.remote[1].files, ['snippets/broken.liquid']);
  assert.deepEqual(result.counts, { localPresent: 1, localMissing: 2, remote: 2 });
});

test('checkAssetReferences records a remote URL instead of resolving its /assets/ path locally', () => {
  const result = checkAssetReferences(fixtureTheme('theme-remote'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.localMissing, []);
  assert.deepEqual(
    result.remote.map((entry) => ({ ref: entry.ref, origin: entry.origin })),
    [{ ref: 'https://cdn.example.com/assets/lib.js', origin: 'https://cdn.example.com' }],
  );
  assert.deepEqual(result.remote[0].files, ['templates/index.liquid']);
  assert.deepEqual(result.counts, { localPresent: 0, localMissing: 0, remote: 1 });
});

test('checkAssetReferences tolerates a theme directory that does not exist', () => {
  assert.deepEqual(checkAssetReferences(fixtureTheme('theme-absent')), {
    ok: true,
    localMissing: [],
    remote: [],
    counts: { localPresent: 0, localMissing: 0, remote: 0 },
  });
});

test('checkAssetReferences is deterministic for the same theme', () => {
  assert.deepEqual(checkAssetReferences(fixtureTheme('theme-broken')), checkAssetReferences(fixtureTheme('theme-broken')));
});
