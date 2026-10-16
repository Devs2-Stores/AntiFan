import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CapabilityError } from '../../src/shared/control-plane-contracts';
import {
  WORKSPACE_NOT_THEME_CODE,
  assertThemeWorkspaceRoot,
  assessWorkspaceRoot,
} from '../../src/main/qa/workspace-markers';

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-markers-'));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

describe('workspace-markers', () => {
  it('refuses an empty string root as empty', () => {
    const assessment = assessWorkspaceRoot('');
    assert.strictEqual(assessment.ok, false);
    assert.strictEqual(assessment.empty, true);
  });

  it('treats a directory holding only .antifan as empty, not as a theme', () => {
    const root = scratchDir();
    try {
      fs.mkdirSync(path.join(root, '.antifan', 'qa-receipts'), { recursive: true });
      const assessment = assessWorkspaceRoot(root);
      assert.strictEqual(assessment.ok, false);
      assert.strictEqual(assessment.empty, true);
      assert.match(assessment.reason ?? '', /is empty/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a legacy root that carries only config/settings.html', () => {
    const root = scratchDir();
    try {
      write(path.join(root, 'config', 'settings.html'), '<fieldset></fieldset>');
      const assessment = assessWorkspaceRoot(root);
      assert.strictEqual(assessment.ok, true);
      assert.strictEqual(assessment.hasMarkers, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a root with layout/theme.liquid or config/settings_schema.json', () => {
    const layoutRoot = scratchDir();
    const schemaRoot = scratchDir();
    try {
      write(path.join(layoutRoot, 'layout', 'theme.liquid'), '{{ content_for_layout }}');
      write(path.join(schemaRoot, 'config', 'settings_schema.json'), '[]');
      assert.strictEqual(assessWorkspaceRoot(layoutRoot).ok, true);
      assert.strictEqual(assessWorkspaceRoot(schemaRoot).ok, true);
    } finally {
      fs.rmSync(layoutRoot, { recursive: true, force: true });
      fs.rmSync(schemaRoot, { recursive: true, force: true });
    }
  });

  it('refuses a populated folder without markers and names no suggestion when no sibling matches', () => {
    const root = scratchDir();
    try {
      write(path.join(root, 'notes.txt'), 'plain folder');
      const assessment = assessWorkspaceRoot(root);
      assert.strictEqual(assessment.ok, false);
      assert.strictEqual(assessment.empty, false);
      assert.strictEqual(assessment.suggestion, undefined);
      assert.match(assessment.reason ?? '', /has none of the theme markers/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('suggests the diacritic-named sibling theme when the root is its ASCII-folded stray', () => {
    const parent = scratchDir();
    try {
      const theme = path.join(parent, 'Giao Hàng Nặng');
      const stray = path.join(parent, 'Giao Hang Nang');
      write(path.join(theme, 'layout', 'theme.liquid'), '{{ content_for_layout }}');
      fs.mkdirSync(path.join(stray, '.antifan'), { recursive: true });
      const assessment = assessWorkspaceRoot(stray);
      assert.strictEqual(assessment.ok, false);
      assert.strictEqual(assessment.suggestion, theme);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('does not suggest a sibling that has the same folded name but no theme markers', () => {
    const parent = scratchDir();
    try {
      fs.mkdirSync(path.join(parent, 'Giao Hàng Nặng'), { recursive: true });
      fs.mkdirSync(path.join(parent, 'Giao Hang Nang'), { recursive: true });
      const assessment = assessWorkspaceRoot(path.join(parent, 'Giao Hang Nang'));
      assert.strictEqual(assessment.ok, false);
      assert.strictEqual(assessment.suggestion, undefined);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('assertThemeWorkspaceRoot throws WORKSPACE_NOT_THEME carrying the suggestion', () => {
    const parent = scratchDir();
    try {
      const theme = path.join(parent, 'Giao Hàng Nặng');
      const stray = path.join(parent, 'Giao Hang Nang');
      write(path.join(theme, 'config', 'settings_schema.json'), '[]');
      fs.mkdirSync(stray, { recursive: true });
      assert.throws(
        () => assertThemeWorkspaceRoot(stray, 'theme.qa_validate'),
        (err: unknown) =>
          err instanceof CapabilityError
          && err.code === WORKSPACE_NOT_THEME_CODE
          && err.details?.suggestion === theme
          && /theme\.qa_validate refused workspace root/.test(err.message)
          && /no receipt was written/.test(err.message)
      );
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('assertThemeWorkspaceRoot lets a provisional empty-string root through and accepts a real theme', () => {
    const root = scratchDir();
    try {
      assert.doesNotThrow(() => assertThemeWorkspaceRoot('', 'theme.qa_validate'));
      write(path.join(root, 'layout', 'theme.liquid'), '');
      assert.doesNotThrow(() => assertThemeWorkspaceRoot(root, 'theme.qa_validate'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
