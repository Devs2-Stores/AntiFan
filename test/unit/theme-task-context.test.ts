import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ThemeTaskContext,
  isThemeTaskContext,
  assertValidThemeTaskContext,
} from '../../src/shared/theme-task-context';

describe('Phase 2: Context Lineage & Proving Harness', () => {
  it('validates a complete and correct ThemeTaskContext', () => {
    const validContext: ThemeTaskContext = {
      taskId: 'task-e2e-card-fix',
      url: 'http://localhost:3000/collections/featured',
      targetRef: '@e1',
      workspaceRoot: 'E:/Work/theme-test',
      timestamp: Date.now(),
    };

    assert.strictEqual(isThemeTaskContext(validContext), true);
    assert.doesNotThrow(() => assertValidThemeTaskContext(validContext));
  });

  it('allows ThemeTaskContext without optional targetRef', () => {
    const contextWithoutRef: ThemeTaskContext = {
      taskId: 'task-e2e-card-fix-2',
      url: 'http://localhost:3000/collections/featured',
      workspaceRoot: 'E:/Work/theme-test',
      timestamp: Date.now(),
    };

    assert.strictEqual(isThemeTaskContext(contextWithoutRef), true);
    assert.doesNotThrow(() => assertValidThemeTaskContext(contextWithoutRef));
  });

  it('rejects invalid ThemeTaskContext shapes', () => {
    assert.strictEqual(isThemeTaskContext(null), false);
    assert.strictEqual(isThemeTaskContext({}), false);
    assert.strictEqual(isThemeTaskContext({ taskId: '', url: 'http://a.com', workspaceRoot: '/app', timestamp: 1 }), false);
    assert.strictEqual(isThemeTaskContext({ taskId: '1', url: '', workspaceRoot: '/app', timestamp: 1 }), false);
    assert.strictEqual(isThemeTaskContext({ taskId: '1', url: 'http://a.com', workspaceRoot: '', timestamp: 1 }), false);
    assert.strictEqual(isThemeTaskContext({ taskId: '1', url: 'http://a.com', workspaceRoot: '/app', timestamp: 0 }), false);
    assert.strictEqual(isThemeTaskContext({ taskId: '1', url: 'http://a.com', workspaceRoot: '/app', timestamp: -10 }), false);

    assert.throws(
      () => assertValidThemeTaskContext({ taskId: '' }),
      /Invalid ThemeTaskContext/
    );
  });

  it('verifies that the isolated Product Card proving fixture exists and is structurally sound', () => {
    const fixtureRoot = path.resolve(process.cwd(), 'test/fixtures/golden-workflow/product-card');
    assert.strictEqual(fs.existsSync(fixtureRoot), true, 'Fixture root must exist');

    const storefrontHtmlPath = path.join(fixtureRoot, 'storefront/index.html');
    assert.strictEqual(fs.existsSync(storefrontHtmlPath), true, 'Storefront HTML must exist');
    const htmlContent = fs.readFileSync(storefrontHtmlPath, 'utf8');
    assert.ok(htmlContent.includes('class="card product-card"'));
    assert.ok(htmlContent.includes('data-card-id="card-101"'));
    assert.ok(htmlContent.includes('badge--sale'));

    const liquidSnippetPath = path.join(fixtureRoot, 'theme/snippets/card-product.liquid');
    assert.strictEqual(fs.existsSync(liquidSnippetPath), true, 'card-product.liquid must exist');
    const snippetContent = fs.readFileSync(liquidSnippetPath, 'utf8');
    assert.ok(snippetContent.includes('BEGIN snippets/card-product.liquid'));
    assert.ok(snippetContent.includes('product-card'));

    const liquidSectionPath = path.join(fixtureRoot, 'theme/sections/main-collection.liquid');
    assert.strictEqual(fs.existsSync(liquidSectionPath), true, 'main-collection.liquid must exist');
    const sectionContent = fs.readFileSync(liquidSectionPath, 'utf8');
    assert.ok(sectionContent.includes("render 'card-product'"));

    const cssPath = path.join(fixtureRoot, 'theme/assets/component-card.css');
    assert.strictEqual(fs.existsSync(cssPath), true, 'component-card.css must exist');
    const cssContent = fs.readFileSync(cssPath, 'utf8');
    assert.ok(cssContent.includes('.card {'));
    assert.ok(cssContent.includes('.product-card {'));
    assert.ok(cssContent.includes('--card-badge-bg'));
    assert.ok(cssContent.includes('@media (max-width: 768px)'));
  });

  it('enforces Invariant 3: Core runtime src/main/ must contain zero product-specific fixture selectors', () => {
    const mainDir = path.resolve(process.cwd(), 'src/main');
    const bannedSelectors = ['.product-card', '.card__badge', '.card__price', '.button--add-to-cart'];

    function scanDir(dir: string): string[] {
      const files: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...scanDir(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const mainFiles = scanDir(mainDir);
    assert.ok(mainFiles.length > 20, 'Should find TypeScript files in src/main');

    for (const file of mainFiles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const selector of bannedSelectors) {
        assert.strictEqual(
          content.includes(selector),
          false,
          `Invariant violation: ${file} must not contain product-specific selector "${selector}"`
        );
      }
    }
  });
});
