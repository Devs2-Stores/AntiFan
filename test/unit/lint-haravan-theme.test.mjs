/**
 * The Haravan linter is the phase-06 acceptance gate, so its exit code and the
 * violations it names are the contract. The fixtures prove the distinctions a
 * refusal depends on: a legacy theme whose settings live only in
 * `config/settings.html` is clean (no unconditional schema requirement), while
 * a theme carrying Shopify constructs, an unresolved include or a
 * Shopify-only filter fails with each offending file named.
 *
 * Run with:
 *   node --test --test-force-exit test/unit/lint-haravan-theme.test.mjs
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const scriptPath = path.resolve('scripts/lint-haravan-theme.mjs');
const baseTheme = path.resolve('themes/universal-haravan-base');

function runLinter(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
}

function copyDir(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

function writeTheme(dir, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf8');
  }
}

describe('Haravan theme linter', () => {
  it('accepts the shipped universal base theme with zero violations', () => {
    const result = runLinter(['--theme', baseTheme]);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /clean: 0 violations/);
  });

  it('accepts a legacy theme whose settings exist only in config/settings.html', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-legacy-'));
    try {
      copyDir(baseTheme, path.join(root, 'theme'));
      fs.rmSync(path.join(root, 'theme', 'config', 'settings_schema.json'));

      const result = runLinter(['--theme', path.join(root, 'theme'), '--settings-mode', 'legacy']);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /clean: 0 violations/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses Shopify constructs, an unresolved include and a forbidden filter by file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-violations-'));
    try {
      const theme = path.join(root, 'theme');
      writeTheme(theme, {
        'layout/theme.liquid': '{{ content_for_layout }}\n',
        'templates/index.liquid': [
          '{% schema %}{"name":"x"}{% endschema %}',
          "{% render 'card' %}",
          "{% include 'missing-snippet' %}",
          "{{ collections.all.products | where: 'available', true }}",
          '{{ settings.color_primary }}',
        ].join('\n'),
        'sections/hero.liquid': '<h1>hero</h1>\n',
        'config/settings.html': '<input type="text" name="color_primary" value="#000000" />\n',
        'config/settings_data.json': '{"current":{"color_primary":"#000000"}}\n',
      });

      const result = runLinter(['--theme', theme, '--settings-mode', 'legacy']);
      assert.strictEqual(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /sections\/hero\.liquid:1 HARAVAN_FORBIDDEN_SECTION/);
      assert.match(result.stderr, /templates\/index\.liquid:1 HARAVAN_FORBIDDEN_SCHEMA/);
      assert.match(result.stderr, /templates\/index\.liquid:2 HARAVAN_FORBIDDEN_RENDER/);
      assert.match(result.stderr, /templates\/index\.liquid:3 HARAVAN_INCLUDE_TARGET_MISSING/);
      assert.match(result.stderr, /templates\/index\.liquid:4 HARAVAN_FORBIDDEN_FILTER/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a setting read that no declaration resolves', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-unresolved-'));
    try {
      const theme = path.join(root, 'theme');
      writeTheme(theme, {
        'layout/theme.liquid': '{{ content_for_layout }}\n',
        'templates/index.liquid': '{{ settings.never_declared }}\n',
        'config/settings.html': '<input type="text" name="color_primary" value="#000000" />\n',
        'config/settings_data.json': '{"current":{"color_primary":"#000000"}}\n',
      });

      const result = runLinter(['--theme', theme, '--settings-mode', 'legacy']);
      assert.strictEqual(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /HARAVAN_SETTING_UNRESOLVED/);
      assert.match(result.stderr, /never_declared/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a Liquid block tag that is never closed or that closes nothing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-balance-'));
    try {
      const theme = path.join(root, 'theme');
      writeTheme(theme, {
        'layout/theme.liquid': '{{ content_for_layout }}\n',
        'templates/index.liquid': [
          '{% for product in collections.all.products %}',
          '<p>{{ product.title }}</p>',
        ].join('\n'),
        'snippets/stray.liquid': '<p>ok</p>\n{% endfor %}\n',
        'config/settings.html': '<input type="text" name="color_primary" value="#000000" />\n',
        'config/settings_data.json': '{"current":{"color_primary":"#000000"}}\n',
      });

      const result = runLinter(['--theme', theme, '--settings-mode', 'legacy']);
      assert.strictEqual(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /templates\/index\.liquid:1 HARAVAN_LIQUID_TAG_UNBALANCED/);
      assert.match(result.stderr, /snippets\/stray\.liquid:2 HARAVAN_LIQUID_TAG_UNBALANCED/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not count tags written inside comment or raw blocks, including nested comments', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-balance-comments-'));
    try {
      const theme = path.join(root, 'theme');
      writeTheme(theme, {
        'layout/theme.liquid': '{{ content_for_layout }}\n',
        'templates/index.liquid': [
          '{% comment %}',
          '{% comment %}nested documentation{% endcomment %}',
          '{% if settings.color_primary %}',
          '{% endcomment %}',
          '{% raw %}{% endfor %}{% endraw %}',
          '{% for i in (1..2) %}<p>{{ i }}</p>{% endfor %}',
        ].join('\n'),
        'config/settings.html': '<input type="text" name="color_primary" value="#000000" />\n',
        'config/settings_data.json': '{"current":{"color_primary":"#000000"}}\n',
      });

      const result = runLinter(['--theme', theme, '--settings-mode', 'legacy']);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stderr, /HARAVAN_LIQUID_TAG_UNBALANCED/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps config/settings.html legal in f1genz mode while the paired schema declares no control', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-f1genz-'));
    try {
      copyDir(baseTheme, path.join(root, 'theme'));
      const theme = path.join(root, 'theme');
      fs.writeFileSync(path.join(theme, 'config', 'settings_schema.json'), '[{}]\n');

      const result = runLinter(['--theme', theme, '--settings-mode', 'f1genz']);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /clean: 0 violations/);
      assert.doesNotMatch(result.stderr, /HARAVAN_SETTINGS_HTML_FORBIDDEN/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a theme whose schema and form declare no live setting at all', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-declares-nothing-'));
    try {
      copyDir(baseTheme, path.join(root, 'theme'));
      const theme = path.join(root, 'theme');
      fs.writeFileSync(path.join(theme, 'config', 'settings_schema.json'), '[]\n');
      fs.writeFileSync(
        path.join(theme, 'config', 'settings.html'),
        '<!-- <input type="text" name="color_primary" /> -->\n'
      );

      const result = runLinter(['--theme', theme, '--settings-mode', 'auto']);
      assert.strictEqual(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /config\/settings_schema\.json:1 HARAVAN_SETTINGS_DECLARATIONS_ABSENT/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an unknown --settings-mode instead of silently linting in auto mode', () => {
    const result = runLinter(['--theme', baseTheme, '--settings-mode', 'f1gnez']);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--settings-mode must be one of auto\|legacy\|f1genz/);
  });

  it('refuses a directory that does not exist with the unreadable exit code', () => {
    const result = runLinter(['--theme', path.join(os.tmpdir(), 'antifan-theme-that-does-not-exist')]);
    assert.strictEqual(result.status, 2);
  });
});
