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
 * a global read, the clean theme would report an undeclared setting. The upload
 * fixture proves that an upload setting must be referenced via 'logo.png' | asset_url
 * rather than settings['logo.png'], that the `item` cart loop is accepted while
 * the documented `cart_item` alias is refused, and that `product.media` needs a
 * `product.images` fallback in the same file; the inert fixture proves that
 * control names inside an HTML comment declare nothing.
 *
 * Run with:
 *   node --test --test-force-exit test/unit/theme-checks.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanRenderFailures,
  validateThemeSchemas,
  checkSettingsBinding,
  checkF1genzSettingsSchema,
  checkAssetReferences,
  checkHaravanLiquidContracts,
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

test('scanRenderFailures pins the fixture document verdict', () => {
  const result = scanRenderFailures(readFixture(path.join('render', 'unrendered-text.html')));
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.failures.map(({ rule, count }) => ({ rule, count })),
    [
      { rule: 'UNRENDERED_OUTPUT', count: 1 },
      { rule: 'UNRENDERED_TAG', count: 2 },
    ],
  );
  assert.match(result.failures[0].example, /^line 8: /);
  assert.match(result.failures[1].example, /^line 9: /);
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

test('validateThemeSchemas accepts a schema-less section on Shopify but still names broken schema blocks', () => {
  const result = validateThemeSchemas(fixtureTheme('theme-broken'), { platform: 'shopify' });
  assert.deepEqual(
    result.failures.map((failure) => ({ rule: failure.rule, path: failure.path })),
    [
      { rule: 'SECTION_SCHEMA_JSON_INVALID', path: 'sections/bad-schema.html' },
      { rule: 'SECTION_SCHEMA_UNTERMINATED', path: 'sections/truncated.html' },
    ],
    'Section Rendering API sections carry no schema; a present-but-broken block is still a failure',
  );
  const promo = result.sections.find((section) => section.path === 'sections/promo.html');
  assert.deepEqual(promo, { path: 'sections/promo.html', ok: true, error: null });
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

test('validateThemeSchemas accepts a legacy Haravan theme that declares settings in settings.html', () => {
  const theme = fixtureTheme('theme-haravan-legacy');
  const result = validateThemeSchemas(theme, { platform: 'haravan', schemaRequired: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.schemaFiles, [], 'an absent visual-editor schema is not a failure in legacy mode');
  assert.deepEqual(result.failures, []);

  const defaulted = validateThemeSchemas(theme, { platform: 'haravan' });
  assert.deepEqual(
    rulesOf(defaulted),
    ['SETTINGS_SCHEMA_MISSING'],
    'callers that do not name a settings mode keep the schema-expected contract',
  );
});

test('validateThemeSchemas still validates a present schema when it is not required', () => {
  const result = validateThemeSchemas(fixtureTheme('theme-clean'), {
    platform: 'haravan',
    schemaRequired: false,
  });
  assert.equal(result.schemaFiles.length, 1);
  assert.equal(result.schemaFiles[0].ok, true, 'the present schema is still parsed and reported');
  assert.ok(
    !rulesOf(result).includes('SETTINGS_SCHEMA_MISSING'),
    'an unrequired schema is never reported missing',
  );
});

test('validateThemeSchemas refuses a directory that does not exist without throwing', () => {
  const result = validateThemeSchemas(fixtureTheme('theme-absent'));
  assert.equal(result.ok, false);
  assert.deepEqual(rulesOf(result), ['SETTINGS_SCHEMA_MISSING']);
  assert.deepEqual(result.sections, []);
});

test('validateThemeSchemas pins the broken theme verdict', () => {
  const result = validateThemeSchemas(fixtureTheme('theme-broken'));
  assert.equal(result.ok, false);
  assert.deepEqual(result.schemaFiles, [{ path: 'config/settings_schema.json', ok: true, error: null }]);
  assert.deepEqual(
    result.sections.map((section) => ({ path: section.path, ok: section.ok })),
    [
      { path: 'sections/bad-schema.html', ok: false },
      { path: 'sections/hero.html', ok: true },
      { path: 'sections/promo.html', ok: false },
      { path: 'sections/truncated.html', ok: false },
    ],
  );
  assert.ok(
    result.sections.every((section) => (section.ok ? section.error === null : section.error !== null)),
    'a failed section must explain itself and a passing one must carry no error',
  );
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
  assert.equal(result.failures[0].file, 'layout/theme.liquid');
  assert.deepEqual(result.failures[0].files, ['layout/theme.liquid']);
  assert.equal(result.failures[0].message, result.failures[0].detail);
  assert.match(result.failures[0].detail, /settings\.undeclared_setting is read in layout\/theme\.liquid/);
});

test('checkSettingsBinding reports every read as undeclared when the schema is missing', () => {
  const result = checkSettingsBinding(fixtureTheme('theme-noschema'));
  assert.equal(result.ok, false);
  assert.deepEqual(result.undeclared, [{ id: 'orphan_setting', files: ['layout/theme.liquid'] }]);
  assert.deepEqual(result.dead, []);
});

test('checkSettingsBinding resolves bracket reads against the settings.html control names', () => {
  const result = checkSettingsBinding(fixtureTheme('theme-haravan-upload'));
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.deepEqual(result.undeclared, [], 'a bracket-read id is declared by the control name');
});

test('checkSettingsBinding ignores control names inside an HTML comment', () => {
  const result = checkSettingsBinding(fixtureTheme('theme-haravan-inert'));
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.undeclared,
    [{ id: 'header_logo_text', files: ['snippets/hero.liquid'] }],
    'a commented-out control declares nothing, so its read is unbacked',
  );
});

test('checkHaravanLiquidContracts refuses only the prohibited cart item aliases', () => {
  const result = checkHaravanLiquidContracts(fixtureTheme('theme-haravan-upload'));
  const naming = result.failures.filter((failure) => failure.rule === 'HARAVAN_CART_ITEM_NAMING');
  assert.deepEqual(
    naming.map((failure) => [failure.file, failure.line]),
    [['templates/cart-alias.liquid', 1]],
    'the `item` loop is the corpus-correct form and the `cart_item` alias is the documented prohibition',
  );
});

test('checkHaravanLiquidContracts requires a product.images fallback beside product.media', () => {
  const result = checkHaravanLiquidContracts(fixtureTheme('theme-haravan-upload'));
  const byRule = new Map(result.failures.map((failure) => [failure.rule, failure]));
  assert.equal(byRule.get('HARAVAN_MEDIA_NO_FALLBACK').file, 'templates/product-bare.liquid');
  assert.equal(byRule.get('HARAVAN_MEDIA_TAG_FORBIDDEN').file, 'templates/product-tag.liquid');
  assert.equal(
    result.failures.filter((failure) => failure.file === 'templates/product.liquid').length,
    0,
    'a gallery that also reaches product.images is accepted',
  );
});

test('checkHaravanLiquidContracts flags a displayed articles.size and spares an emptiness test', () => {
  const result = checkHaravanLiquidContracts(fixtureTheme('theme-haravan-upload'));
  const flagged = result.failures.filter((failure) => failure.rule === 'HARAVAN_BLOG_ARTICLES_COUNT');
  assert.deepEqual(
    flagged.map((failure) => [failure.file, failure.line]),
    [['templates/blog.liquid', 5]],
    'only the printed page-local size is a total claim; `articles.size > 0` is an emptiness test',
  );
});

test('checkHaravanLiquidContracts scopes the f1genz settings.html refusal to a live schema', () => {
  const inertSchema = checkHaravanLiquidContracts(fixtureTheme('theme-haravan-f1genz'), {
    settingsMode: 'f1genz',
  });
  assert.deepEqual(
    rulesOf(inertSchema),
    [],
    'a schema without a control leaves settings.html as the declaration surface of the branch',
  );

  const liveSchema = checkHaravanLiquidContracts(fixtureTheme('theme-haravan-schema-live'), {
    settingsMode: 'f1genz',
  });
  assert.deepEqual(
    rulesOf(liveSchema),
    ['HARAVAN_SETTINGS_HTML_FORBIDDEN'],
    'a schema that declares a control owns the declaration, so the legacy form duplicates it',
  );
});

test('checkHaravanLiquidContracts names a theme whose schema and form declare no live setting', () => {
  const result = checkHaravanLiquidContracts(fixtureTheme('theme-haravan-declares-nothing'), {
    settingsMode: 'auto',
  });
  assert.deepEqual(rulesOf(result), ['HARAVAN_SETTINGS_DECLARATIONS_ABSENT']);
});

test('checkHaravanLiquidContracts resolves a hyphenated setting id from its form control name', () => {
  const result = checkHaravanLiquidContracts(fixtureTheme('theme-haravan-f1genz'), {
    settingsMode: 'auto',
  });
  assert.deepEqual(
    result.failures.filter((failure) => failure.rule === 'HARAVAN_SETTING_UNRESOLVED'),
    [],
    'settings.footer-top-check-1 is declared as name="footer-top-check-1", not as settings.footer',
  );
});

test('checkHaravanLiquidContracts does not absorb a whitespace trim marker into a setting id', () => {
  const result = checkHaravanLiquidContracts(fixtureTheme('theme-haravan-trim-marker'), {
    settingsMode: 'auto',
  });
  assert.deepEqual(
    result.failures.filter((failure) => failure.rule === 'HARAVAN_SETTING_UNRESOLVED'),
    [],
    'settings.addthis_live_show-%} declares addthis_live_show; the trailing hyphen belongs to the Liquid tag',
  );
});

test('checkHaravanLiquidContracts refuses themes with dual-surface wrappers (HARAVAN_NO_DUAL_SURFACE)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-dual-surface-'));
  try {
    fs.mkdirSync(path.join(tempDir, 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'templates', 'index.liquid'),
      '<div class="theme-surface-desktop">Desktop</div>\n<div class="theme-surface-mobile">Mobile</div>',
      'utf8'
    );
    const result = checkHaravanLiquidContracts(tempDir);
    const dualFailures = result.failures.filter((f) => f.rule === 'HARAVAN_NO_DUAL_SURFACE');
    assert.equal(dualFailures.length, 2);
    assert.equal(dualFailures[0].file, 'templates/index.liquid');
    assert.equal(dualFailures[0].line, 1);
    assert.equal(dualFailures[1].file, 'templates/index.liquid');
    assert.equal(dualFailures[1].line, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('checkHaravanLiquidContracts refuses duplicate chrome (HARAVAN_SINGLE_CHROME)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-single-chrome-'));
  try {
    fs.mkdirSync(path.join(tempDir, 'snippets'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'layout'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'snippets', 'header.liquid'),
      '<header class="desktop-header">Desktop</header>\n<header class="mobile-header">Mobile</header>',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tempDir, 'snippets', 'footer.liquid'),
      '<footer class="desktop-footer">Desktop</footer>\n<footer class="mobile-footer">Mobile</footer>',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tempDir, 'layout', 'theme.liquid'),
      "{% include 'header' %}\n{% include 'header-mobile' %}",
      'utf8'
    );
    const result = checkHaravanLiquidContracts(tempDir);
    const chromeFailures = result.failures.filter((f) => f.rule === 'HARAVAN_SINGLE_CHROME');
    assert.equal(chromeFailures.length, 3);
    const files = chromeFailures.map((f) => f.file);
    assert.ok(files.includes('snippets/header.liquid'));
    assert.ok(files.includes('snippets/footer.liquid'));
    assert.ok(files.includes('layout/theme.liquid'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('checkHaravanLiquidContracts refuses duplicate paginate blocks (HARAVAN_DUPLICATE_PAGINATE)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-duplicate-paginate-'));
  try {
    fs.mkdirSync(path.join(tempDir, 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'templates', 'collection.liquid'),
      '{% paginate collection.products by 12 %}\n{% endpaginate %}\n{% paginate collection.products by 24 %}\n{% endpaginate %}',
      'utf8'
    );
    const result = checkHaravanLiquidContracts(tempDir);
    const paginateFailures = result.failures.filter((f) => f.rule === 'HARAVAN_DUPLICATE_PAGINATE');
    assert.equal(paginateFailures.length, 1);
    assert.equal(paginateFailures[0].file, 'templates/collection.liquid');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('checkSettingsBinding pins the clean theme result shape', () => {
  assert.deepEqual(checkSettingsBinding(fixtureTheme('theme-clean')), {
    ok: true,
    undeclared: [],
    dead: [],
    failures: [],
  });
});

test('checkSettingsBinding tolerates a theme directory that does not exist', () => {
  assert.deepEqual(checkSettingsBinding(fixtureTheme('theme-absent')), {
    ok: true,
    undeclared: [],
    dead: [],
    failures: [],
  });
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

test('checkAssetReferences pins the broken theme verdict', () => {
  assert.deepEqual(checkAssetReferences(fixtureTheme('theme-broken')), {
    ok: false,
    localMissing: [
      { ref: 'also-missing.png', files: ['layout/theme.liquid'] },
      { ref: 'missing.css', files: ['snippets/broken.liquid'] },
    ],
    remote: [
      { ref: '//cdn.example.com/legacy/analytics.js', origin: '//cdn.example.com', files: ['snippets/broken.liquid'] },
      { ref: 'https://cdn.example.com/lib/remote.js', origin: 'https://cdn.example.com', files: ['snippets/broken.liquid'] },
    ],
    counts: { localPresent: 1, localMissing: 2, remote: 2 },
  });
});

test('HARAVAN_SETTINGS_UPLOAD_READ refuses settings[\'logo.png\'] when logo.png is a file input', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-upload-read-'));
  try {
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'snippets'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'config', 'settings.html'),
      '<fieldset><input type="file" name="logo.png" /></fieldset>',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'snippets', 'hero.liquid'),
      '<img src="{{ settings[\'logo.png\'] }}">',
      'utf8',
    );
    const result = checkHaravanLiquidContracts(tempDir);
    assert.equal(result.ok, false);
    const uploadReads = result.failures.filter((f) => f.rule === 'HARAVAN_SETTINGS_UPLOAD_READ');
    assert.equal(uploadReads.length, 1);
    assert.equal(uploadReads[0].id, 'logo.png');
    assert.equal(uploadReads[0].file, 'snippets/hero.liquid');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('HARAVAN_SETTINGS_UPLOAD_READ flags dynamic bracket reads from capture ending in image extension', () => {
  const result = checkHaravanLiquidContracts(fixtureTheme('theme-dynamic-upload-read'));
  assert.equal(result.ok, false);
  const uploadReads = result.failures.filter((f) => f.rule === 'HARAVAN_SETTINGS_UPLOAD_READ');
  assert.equal(uploadReads.length, 1);
  assert.equal(uploadReads[0].id, 'fleet-vessel-{{ m }}-img.jpg');
  assert.equal(uploadReads[0].file, 'snippets/fleet.liquid');
});

test('HARAVAN_SETTINGS_DUPLICATE_NAME ignores radio groups but flags duplicate text inputs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-dup-name-'));
  try {
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'snippets'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'config', 'settings.html'),
      `<fieldset>
        <!-- Radio group with same name is allowed -->
        <input type="radio" name="layout_mode" value="grid" />
        <input type="radio" name="layout_mode" value="list" />
        <!-- Duplicate text inputs are forbidden -->
        <input type="text" name="dup_title" value="1" />
        <input type="text" name="dup_title" value="2" />
      </fieldset>`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'snippets', 'test.liquid'),
      '{{ settings.dup_title }}',
      'utf8',
    );
    const result = checkHaravanLiquidContracts(tempDir);
    assert.equal(result.ok, false);
    const dups = result.failures.filter((f) => f.rule === 'HARAVAN_SETTINGS_DUPLICATE_NAME');
    assert.equal(dups.length, 1);
    assert.equal(dups[0].id, 'dup_title');
    assert.equal(dups[0].line, 7);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('HARAVAN_SETTING_UNRESOLVED flags keys present in settings_data.json but missing from settings.html', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-unresolved-'));
  try {
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'snippets'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'config', 'settings.html'),
      '<fieldset><input type="text" name="declared_key" value="ok" /></fieldset>',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'config', 'settings_data.json'),
      JSON.stringify({ current: { declared_key: 'ok', orphan_key: 'orphan' } }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'snippets', 'test.liquid'),
      '{{ settings.declared_key }} {{ settings.orphan_key }}',
      'utf8',
    );
    const result = checkHaravanLiquidContracts(tempDir);
    assert.equal(result.ok, false);
    const unresolved = result.failures.filter((f) => f.rule === 'HARAVAN_SETTING_UNRESOLVED');
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].id, 'orphan_key');
    assert.match(unresolved[0].message, /config\/settings_schema\.json or config\/settings\.html/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('HARAVAN_SETTINGS_DATA_INVALID flags corrupt or non-object config/settings_data.json', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-settings-data-invalid-'));
  try {
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'snippets'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'config', 'settings.html'),
      '<fieldset><input type="text" name="declared_key" value="ok" /></fieldset>',
      'utf8',
    );
    fs.writeFileSync(path.join(tempDir, 'config', 'settings_data.json'), '{ invalid json', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'snippets', 'test.liquid'), '{{ settings.declared_key }}', 'utf8');

    const corruptResult = checkHaravanLiquidContracts(tempDir);
    assert.equal(corruptResult.ok, false);
    const corruptFailures = corruptResult.failures.filter((f) => f.rule === 'HARAVAN_SETTINGS_DATA_INVALID');
    assert.equal(corruptFailures.length, 1);
    assert.equal(corruptFailures[0].file, 'config/settings_data.json');
    assert.equal(corruptFailures[0].line, 1);

    fs.writeFileSync(path.join(tempDir, 'config', 'settings_data.json'), '["not-an-object"]', 'utf8');
    const arrayResult = checkHaravanLiquidContracts(tempDir);
    assert.equal(arrayResult.ok, false);
    assert.equal(arrayResult.failures.filter((f) => f.rule === 'HARAVAN_SETTINGS_DATA_INVALID').length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Sapo .bwt templates and snippets are scanned for settings bindings, assets, and schema-less sections', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-sapo-bwt-'));
  try {
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'layout'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'sections'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'snippets'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'assets'), { recursive: true });

    fs.writeFileSync(
      path.join(tempDir, 'config', 'settings_schema.json'),
      JSON.stringify([
        {
          name: 'General',
          settings: [{ type: 'text', id: 'declared_title' }],
        },
      ]),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'layout', 'theme.bwt'),
      "{{ 'main.scss.css' | asset_url }} {{ 'missing.js' | asset_url }} {{ settings.declared_title }} {{ settings.missing_banner_text }}",
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'snippets', 'card.bwt'),
      '<div class="card">{{ settings.missing_banner_text }}</div>',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'sections', 'section_hero.bwt'),
      '<section class="hero">{{ settings.declared_title }}</section>',
      'utf8',
    );
    fs.writeFileSync(path.join(tempDir, 'assets', 'main.scss.bwt'), 'body { margin: 0; }', 'utf8');

    const schemaResult = validateThemeSchemas(tempDir);
    assert.equal(schemaResult.ok, true, 'a .bwt section without {% schema %} must not fail schema validation');
    assert.deepEqual(schemaResult.sections, [{ path: 'sections/section_hero.bwt', ok: true, error: null }]);
    assert.deepEqual(schemaResult.failures, []);

    const sapoSchemaResult = validateThemeSchemas(tempDir, { platform: 'sapo' });
    assert.equal(sapoSchemaResult.ok, true);
    assert.deepEqual(sapoSchemaResult.failures, []);

    const bindingResult = checkSettingsBinding(tempDir);
    assert.equal(bindingResult.ok, false);
    assert.deepEqual(bindingResult.undeclared, [
      { id: 'missing_banner_text', files: ['layout/theme.bwt', 'snippets/card.bwt'] },
    ]);
    assert.deepEqual(bindingResult.dead, []);
    assert.equal(bindingResult.failures.length, 1);
    assert.equal(bindingResult.failures[0].rule, 'SETTING_UNDECLARED');
    assert.equal(bindingResult.failures[0].id, 'missing_banner_text');
    assert.equal(bindingResult.failures[0].file, 'layout/theme.bwt');
    assert.deepEqual(bindingResult.failures[0].files, ['layout/theme.bwt', 'snippets/card.bwt']);
    assert.equal(bindingResult.failures[0].message, bindingResult.failures[0].detail);
    assert.match(bindingResult.failures[0].message, /layout\/theme\.bwt, snippets\/card\.bwt/);

    const assetResult = checkAssetReferences(tempDir);
    assert.equal(assetResult.ok, false);
    assert.deepEqual(assetResult.localMissing, [{ ref: 'missing.js', files: ['layout/theme.bwt'] }]);
    assert.equal(assetResult.counts.localPresent, 1, 'main.scss.css resolves to assets/main.scss.bwt');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('checkF1genzSettingsSchema treats non-hstatic https image_picker and literal | default: fallbacks as ERROR while allowing store object variable fallbacks', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1genz-schema-severity-'));
  try {
    fs.writeFileSync(path.join(tempDir, '.workspace-context.json'), JSON.stringify({ kind: 'theme', platform: 'haravan', branch: 'f1genz' }), 'utf8');
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'layout'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'snippets'), { recursive: true });

    fs.writeFileSync(
      path.join(tempDir, 'config', 'settings_schema.json'),
      JSON.stringify([
        {
          name: 'General',
          settings: [
            {
              type: 'image_picker',
              id: 'hero_banner_ext_def',
              label: 'Banner Ext Default',
              default: 'https://images.unsplash.com/photo-123.jpg',
            },
            {
              type: 'image_picker',
              id: 'hero_banner_ext_val',
              label: 'Banner Ext Value',
              default: 'https://file.hstatic.net/1000/file/ok-default.jpg',
            },
            { type: 'text', id: 'hero_heading', label: 'Heading', default: 'Luxury Timepieces' },
            { type: 'text', id: 'hero_gap', label: 'Gap', default: '24px' },
            { type: 'text', id: 'hero_limit', label: 'Limit', default: '8' },
            { type: 'text', id: 'brand_name', label: 'Brand', default: 'Timer Watch' },
          ],
        },
      ]),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tempDir, 'config', 'settings_data.json'),
      JSON.stringify({
        current: {
          hero_banner_ext_def: 'https://file.hstatic.net/1000/file/ok-val.jpg',
          hero_banner_ext_val: 'https://images.unsplash.com/photo-456.jpg',
          hero_heading: 'Luxury Timepieces',
          hero_gap: '24px',
          hero_limit: '8',
          brand_name: 'Timer Watch',
        },
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tempDir, 'layout', 'theme.liquid'),
      '<!doctype html><html><head>{{ content_for_header }}</head><body>{% include "hero" %}{{ content_for_layout }}</body></html>',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tempDir, 'snippets', 'hero.liquid'),
      [
        '<img setting-id="hero_banner_ext_def" setting-type="image" src="{{ settings.hero_banner_ext_def }}" width="100" height="100" alt="">',
        '<img setting-id="hero_banner_ext_val" setting-type="image" src="{{ settings.hero_banner_ext_val }}" width="100" height="100" alt="">',
        '<h1 setting-id="hero_heading" setting-type="text">{{ settings.hero_heading | default: "Welcome" }}</h1>',
        '<div style="gap: {{ settings.hero_gap | default: \'16px\' }}" data-limit="{{ settings.hero_limit | default: 8 }}"></div>',
        '{% if settings.brand_name != blank %}<span setting-id="brand_name" setting-type="text">{{ settings.brand_name | default: shop.name | default: "" }}</span>{% endif %}',
      ].join('\n'),
      'utf8'
    );

    const res = checkF1genzSettingsSchema(tempDir);
    assert.equal(res.ok, false);
    assert.ok(
      res.errors.some((e) => e.rule === 'image-picker-bare-default' && e.id === 'hero_banner_ext_def'),
      'non-hstatic https in image_picker default must be an ERROR (image-picker-bare-default)'
    );
    assert.ok(
      res.errors.some((e) => e.rule === 'image-picker-bare-value' && e.id === 'hero_banner_ext_val'),
      'non-hstatic https in image_picker data must be an ERROR (image-picker-bare-value)'
    );
    const fallbackErrors = res.errors.filter((e) => e.rule === 'liquid-hardcoded-fallback');
    assert.deepEqual(
      fallbackErrors.map((e) => e.id).sort(),
      ['hero_gap', 'hero_heading', 'hero_limit'],
      'quoted literal, unit literal, and numeric literal | default: on settings must all be ERROR'
    );
    assert.ok(
      !res.errors.some((e) => e.id === 'brand_name') && !res.warnings.some((w) => w.id === 'brand_name'),
      'store object variable fallback (| default: shop.name) and empty string fallback must stay allowed'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// A small Haravan theme whose schema declares two settings read only inside multi-line tags, and a
// handle the F1genz rules ban (linklists.<handle>).
function writeBranchTheme(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-branch-gate-'));
  if (branch) {
    fs.writeFileSync(path.join(dir, '.workspace-context.json'), JSON.stringify({ kind: 'theme', platform: 'haravan', branch }), 'utf8');
  }
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'snippets'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config', 'settings_schema.json'),
    JSON.stringify([{ name: 'Footer', settings: [
      { type: 'text', id: 'footer_text', label: 'Footer text', default: 'Hello' },
      { type: 'text', id: 'footer_note', label: 'Footer note', default: 'Note' },
    ] }]),
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'config', 'settings_data.json'), JSON.stringify({ current: { footer_text: 'Hello', footer_note: 'Note' } }), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'snippets', 'footer.liquid'),
    [
      '<p setting-id="footer_text" setting-type="text">{{',
      '  settings.footer_text',
      '}}</p>',
      '{%- liquid',
      '  assign note = settings.footer_note',
      '-%}',
      '<span setting-id="footer_note" setting-type="text">{{ note }}</span>',
      '{% for link in linklists.main-menu.links %}<a href="{{ link.url }}">{{ link.title }}</a>{% endfor %}',
    ].join('\n'),
    'utf8'
  );
  return dir;
}

test('checkF1genzSettingsSchema runs only on a workspace on the f1genz branch', () => {
  for (const branch of ['devs2', null]) {
    const dir = writeBranchTheme(branch);
    try {
      const res = checkF1genzSettingsSchema(dir);
      assert.equal(res.ok, true);
      assert.deepEqual(res.errors, []);
      assert.ok(res.skipped, `branch ${branch} is skipped`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const f1genz = writeBranchTheme('f1genz');
  try {
    const res = checkF1genzSettingsSchema(f1genz);
    assert.equal(res.skipped, undefined);
    assert.ok(res.errors.some((e) => e.rule === 'liquid-hardcoded-handle'), 'the house rules run on an f1genz theme');
  } finally {
    fs.rmSync(f1genz, { recursive: true, force: true });
  }
});

test('checkF1genzSettingsSchema counts a setting read inside a multi-line tag as read', () => {
  const dir = writeBranchTheme('f1genz');
  try {
    const res = checkF1genzSettingsSchema(dir);
    const dead = res.errors.filter((e) => e.rule === 'dead-setting').map((e) => e.id);
    assert.deepEqual(dead, [], 'footer_text ({{ on its own line) and footer_note ({% liquid %} block) are both read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkF1genzSettingsSchema names a minified schema finding by JSON pointer and a formatted one by line', () => {
  const schema = [{ name: 'Footer', settings: [
    { type: 'text', id: 'footer_text', label: 'Footer text', default: 'Hello' },
    { type: 'text', id: 'footer_note', label: 'Footer note', default: 'Note' },
    { type: 'text', id: 'unused_banner', label: 'Unused banner', default: 'x' },
  ] }];
  const deadFinding = (serialized) => {
    const dir = writeBranchTheme('f1genz');
    try {
      fs.writeFileSync(path.join(dir, 'config', 'settings_schema.json'), serialized, 'utf8');
      return checkF1genzSettingsSchema(dir).errors.find((e) => e.rule === 'dead-setting' && e.id === 'unused_banner');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const minified = deadFinding(JSON.stringify(schema));
  assert.ok(minified, 'the unread setting is reported');
  assert.equal(minified.line, undefined, 'a one-line file has no line to name');
  assert.equal(minified.pointer, '/0/settings/2');
  const formatted = deadFinding(JSON.stringify(schema, null, 2));
  assert.ok(formatted, 'the unread setting is reported');
  assert.equal(formatted.pointer, undefined);
  assert.ok(formatted.line > 1, `a formatted file reports the real line, got ${formatted.line}`);
});

test('checkHaravanLiquidContracts places a duplicate header at its own line, not line 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-chrome-line-'));
  try {
    fs.mkdirSync(path.join(dir, 'snippets'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'snippets', 'header.liquid'),
      ['<header>one</header>', '', '', '<header>two</header>'].join('\n'),
      'utf8'
    );
    const failure = checkHaravanLiquidContracts(dir, { platform: 'haravan' }).failures.find(
      (f) => f.rule === 'HARAVAN_SINGLE_CHROME' && f.file === 'snippets/header.liquid'
    );
    assert.ok(failure, 'the duplicate header is reported');
    assert.equal(failure.line, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
