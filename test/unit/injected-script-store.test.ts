import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { InjectedScriptStore } from '../../src/main/browser/scripts/injected-script-store';

describe('InjectedScriptStore', () => {
  it('registers exactly 3 default built-in scripts and returns them', () => {
    const store = new InjectedScriptStore({ overrideDir: null });
    const scripts = store.listScripts();
    const ids = scripts.map((s) => s.id).sort();

    assert.deepStrictEqual(ids, ['media.freeze', 'settle.fonts', 'settle.images']);

    // Default: normalizeSliders is false (sliders/carousels preserved)
    const freezeScript = store.getScript('media.freeze', { freeze: true });
    assert.ok(typeof freezeScript === 'string' && freezeScript.length > 0);
    assert.ok(freezeScript.includes('requestAnimationFrame'), 'media.freeze should intercept RAF');
    assert.ok(freezeScript.includes('const normalizeSliders = false;'), 'media.freeze default must set normalizeSliders = false');
    assert.ok(freezeScript.includes('restoreSliderNormalization'), 'restore logic is always emitted');

    // Explicit opt-in: normalizeSliders is true
    const optInScript = store.getScript('media.freeze', { freeze: true, normalizeSliders: true });
    assert.ok(optInScript.includes('const normalizeSliders = true;'), 'media.freeze explicit opt-in must set normalizeSliders = true');
    assert.ok(optInScript.includes('restoreSliderNormalization'), 'restore logic is always emitted');
  });
  it('fails closed on unknown script ID', () => {
    const store = new InjectedScriptStore({ overrideDir: null });
    assert.throws(
      () => store.getScript('non.existent.id'),
      /not found in InjectedScriptStore/
    );
  });

  it('safely handles non-executable template disk overrides', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-test-override-'));
    try {
      const store = new InjectedScriptStore({ overrideDir: tempDir });
      // 1. Valid template with __ANTIFAN_PARAMS_JSON__
      const overrideFile = path.join(tempDir, 'test-template.source.js');
      fs.writeFileSync(overrideFile, 'const config = __ANTIFAN_PARAMS_JSON__;\nreturn config.foo;', 'utf8');

      store.register('test.template', 'Test script with parameters', (params) => `default: ${JSON.stringify(params)}`);

      const result = store.getScript('test.template', { foo: 'bar_from_params' });
      assert.ok(result.includes('bar_from_params'), 'Should inject JSON params into template');
      assert.ok(!result.includes('__ANTIFAN_PARAMS_JSON__'), 'Should replace parameter token');

      // Verify special regex patterns like $&, $`, $' are not corrupted
      const dollarResult = store.getScript('test.template', { foo: '$199.99', special: '$& $` $\'' });
      assert.ok(dollarResult.includes('"$199.99"'), 'Must preserve $ literally without regex pattern corruption');
      assert.ok(dollarResult.includes('"$& $` $\'"'), 'Must preserve $&, $`, $\' literally');
      // 2. Reject template with duplicate tokens
      const duplicateFile = path.join(tempDir, 'test-duplicate.source.js');
      fs.writeFileSync(duplicateFile, 'const a = __ANTIFAN_PARAMS_JSON__;\nconst b = __ANTIFAN_PARAMS_JSON__;', 'utf8');
      store.register('test.duplicate', 'Test duplicate token', () => 'default');

      assert.throws(
        () => store.getScript('test.duplicate', { x: 1 }),
        /duplicate __ANTIFAN_PARAMS_JSON__ token/
      );

      // 3. Reject template missing token when params are provided
      const missingTokenFile = path.join(tempDir, 'test-static.source.js');
      fs.writeFileSync(missingTokenFile, 'const staticVal = 42;\nreturn staticVal;', 'utf8');
      store.register('test.static', 'Test static override', () => 'default');

      assert.throws(
        () => store.getScript('test.static', { paramPassed: true }),
        /does not support parameterization/
      );

      // 4. Static template without params works fine
      const staticResult = store.getScript('test.static');
      assert.ok(staticResult.includes('const staticVal = 42;'));

      // 5. clearOverrides invalidates cache
      store.clearOverrides();
      assert.strictEqual(store.listScripts().find((s) => s.id === 'test.static')?.hasDiskOverride, false);
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('strictly respects explicit null overrideDir and never auto-discovers disk overrides', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-explicit-null-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'media-freeze.source.js'), '/* disk override */', 'utf8');

      const store = new InjectedScriptStore({ overrideDir: null, overrideCandidates: [tempDir] });
      const script = store.getScript('media.freeze');
      assert.ok(!script.includes('/* disk override */'), 'Should ignore disk override when overrideDir is explicitly null');
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('dynamically auto-discovers override directory created after store instantiation', () => {
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-late-parent-'));
    const lateDir = path.join(tempParent, 'cdp');
    try {
      // Pass candidate path that does NOT exist yet
      const store = new InjectedScriptStore({ overrideCandidates: [lateDir] });
      assert.strictEqual(store.listScripts().find((s) => s.id === 'media.freeze')?.hasDiskOverride, false);

      // Create late directory and write override file after store instantiation
      fs.mkdirSync(lateDir, { recursive: true });
      fs.writeFileSync(path.join(lateDir, 'media-freeze.source.js'), '/* late disk override */', 'utf8');

      // getScript auto-discovers the newly created directory
      const script = store.getScript('media.freeze');
      assert.ok(script.includes('/* late disk override */'), 'Should auto-discover directory created after instantiation');
    } finally {
      try { fs.rmSync(tempParent, { recursive: true, force: true }); } catch {}
    }
  });

  it('emits proper width restoration in media.freeze script', () => {
    const store = new InjectedScriptStore({ overrideDir: null });
    const freezeScript = store.getScript('media.freeze', { freeze: true, normalizeSliders: true });

    assert.ok(freezeScript.includes("'transform', 'transition', 'left', 'margin-left', 'width'"), 'Must restore width along with transform/transition/left/margin-left');
  });
});
