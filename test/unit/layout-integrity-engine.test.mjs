/**
 * LayoutIntegrityEngine — unit test suite.
 *
 * The in-page detectors are verified in real Chromium by `npm run test:visual-qa`
 * (fixture corpus with known defects and healthy controls). This file covers the
 * reader contract, the unmeasured marker and viewport-name injection.
 *
 * Run with:
 *   node --test --test-force-exit test/unit/layout-integrity-engine.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import * as vm from 'node:vm';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE_PATH = path.join(REPO_ROOT, 'src', 'main', 'qa', 'scanners', 'layout-integrity-engine.ts');

// Always bundle src/: .compiled/ belongs to the running app and may be stale.
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-integrity-test-'));
const outFile = path.join(outDir, 'layout-integrity-engine.mjs');
esbuild.buildSync({ entryPoints: [SOURCE_PATH], bundle: true, format: 'esm', platform: 'node', outfile: outFile, logLevel: 'error' });
const { LayoutIntegrityEngine } = await import(pathToFileURL(outFile).href);
fs.rmSync(outDir, { recursive: true, force: true });

describe('LayoutIntegrityEngine', () => {
  it('defines standard device breakpoints (mobile, tablet, desktop)', () => {
    const bps = LayoutIntegrityEngine.BREAKPOINTS;
    assert.strictEqual(bps.length, 3);
    assert.strictEqual(bps[0]?.name, 'mobile');
    assert.strictEqual(bps[0]?.width, 393);
    assert.strictEqual(bps[1]?.name, 'tablet');
    assert.strictEqual(bps[1]?.width, 820);
    assert.strictEqual(bps[2]?.name, 'desktop');
    assert.strictEqual(bps[2]?.width, 1440);
  });

  describe('readUnmeasuredReason', () => {
    it('returns undefined for non-objects or invalid payloads', () => {
      assert.strictEqual(LayoutIntegrityEngine.readUnmeasuredReason(null), undefined);
      assert.strictEqual(LayoutIntegrityEngine.readUnmeasuredReason(undefined), undefined);
      assert.strictEqual(LayoutIntegrityEngine.readUnmeasuredReason('string'), undefined);
      assert.strictEqual(LayoutIntegrityEngine.readUnmeasuredReason(123), undefined);
      assert.strictEqual(LayoutIntegrityEngine.readUnmeasuredReason([]), undefined);
    });

    it('returns undefined when measured is true', () => {
      assert.strictEqual(LayoutIntegrityEngine.readUnmeasuredReason({ measured: true }), undefined);
      assert.strictEqual(LayoutIntegrityEngine.readUnmeasuredReason({ measured: true, unmeasuredReason: 'ignore me' }), undefined);
    });

    it('returns specified unmeasuredReason when measured is false', () => {
      const reason = 'tab has no laid-out CSS viewport';
      assert.strictEqual(LayoutIntegrityEngine.readUnmeasuredReason({ measured: false, unmeasuredReason: reason }), reason);
    });

    it('returns fallback reason when measured is false but unmeasuredReason is empty', () => {
      assert.strictEqual(
        LayoutIntegrityEngine.readUnmeasuredReason({ measured: false }),
        'the scanned tab reported no measurable CSS viewport'
      );
      assert.strictEqual(
        LayoutIntegrityEngine.readUnmeasuredReason({ measured: false, unmeasuredReason: '   ' }),
        'the scanned tab reported no measurable CSS viewport'
      );
    });
  });

  describe('sandbox in-page evaluation', () => {
    it('returns measured:false when documentElement.clientWidth is 0', () => {
      const scriptText = LayoutIntegrityEngine.getBrowserScanScript("a'$&b");
      const script = new vm.Script(scriptText);
      const sandbox = {
        document: {
          documentElement: {
            clientWidth: 0,
            clientHeight: 0,
          },
          body: null,
          querySelectorAll: () => [],
        },
        window: {
          innerWidth: 0,
          innerHeight: 0,
        },
      };
      vm.createContext(sandbox);
      const result = script.runInContext(sandbox);

      assert.strictEqual(result.measured, false);
      assert.ok(typeof result.unmeasuredReason === 'string');
      assert.ok(result.unmeasuredReason.includes('layout integrity was not measured'));
      assert.strictEqual(result.findings.length, 0);
      assert.strictEqual(result.viewport.name, "a'$&b");
    });

    it('substitutes the layout-shift switch from the scan options and leaves no placeholder behind', () => {
      const withShift = LayoutIntegrityEngine.getBrowserScanScript('active');
      const withoutShift = LayoutIntegrityEngine.getBrowserScanScript('sweep', { skipLayoutShift: true });
      for (const text of [withShift, withoutShift]) {
        assert.ok(!text.includes('__SKIP_LAYOUT_SHIFT__') && !text.includes('__VIEWPORT_NAME__'));
        new vm.Script(text); // still parses
      }
      assert.ok(withShift.includes('const SKIP_LAYOUT_SHIFT = "false" === \'true\''));
      assert.ok(withoutShift.includes('const SKIP_LAYOUT_SHIFT = "true" === \'true\''));
    });

    it('isolates warning caps by ruleId so edge-text warnings do not silence sibling-gap or wrap-quality warnings', () => {
      const scriptText = LayoutIntegrityEngine.getBrowserScanScript('active');
      assert.ok(
        scriptText.includes("const capKey = f.ruleId ? f.kind + ':' + f.ruleId : f.kind;"),
        'warning cap must key by kind:ruleId when ruleId is present'
      );
      assert.ok(
        scriptText.includes("ruleId: 'sibling-gap'") && scriptText.includes("ruleId: 'wrap-quality'"),
        'browser scan script must include sibling-gap and wrap-quality rules'
      );
    });

    it('excludes the Haravan and Sapo/Bizweb preview chrome from the scan (behaviour: visual-qa fixtures 71-72)', () => {
      const scriptText = LayoutIntegrityEngine.getBrowserScanScript('active');
      const line = scriptText.split('\n').find((l) => l.includes('const PLATFORM_PREVIEW_CHROME'));
      assert.ok(line, 'PLATFORM_PREVIEW_CHROME must be declared');
      for (const sel of ['#haravan-notification', '#preview-bar-iframe', '#bizweb-theme-previewer']) {
        assert.ok(line.includes(sel), `PLATFORM_PREVIEW_CHROME must contain ${sel}`);
      }
    });

    it('wires the inner overflow-x clipping, scrolled-header and fixed-vs-sticky collision passes into the scan (behaviour: visual-qa fixtures 51-55)', () => {
      const scriptText = LayoutIntegrityEngine.getBrowserScanScript('active');
      assert.ok(
        scriptText.includes('checkInnerClippedInOverflowAncestor') &&
          scriptText.includes("ancOvX !== 'hidden' && ancOvX !== 'clip'"),
        'browser scan script must include inner overflow-x:hidden|clip clipping detector'
      );
      assert.ok(
        scriptText.includes('checkScrolledStateHeaderAndSticky') &&
          scriptText.includes("classList.add('is-scrolled')") &&
          scriptText.includes("classList.remove('is-scrolled')"),
        'browser scan script must include scrolled-state (scrollY=600 / .is-scrolled) pass with cleanup'
      );
      assert.ok(
        scriptText.includes('checkFixedStickyLayerCollisions'),
        'browser scan script must include fixed-vs-fixed and fixed-vs-sticky layer collision pass'
      );
    });
  });
});
