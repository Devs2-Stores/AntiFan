/**
 * LayoutIntegrityEngine — unit test suite.
 *
 * Verifies the layout integrity scanner script generation, defensive unmeasured-reason
 * reader contract, detector syntax, and marker assertions without Node runtime leakage
 * into the in-page script string.
 *
 * Run with:
 *   node --test --test-force-exit test/unit/layout-integrity-engine.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import * as vm from 'node:vm';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE_PATH = path.join(REPO_ROOT, 'src', 'main', 'qa', 'scanners', 'layout-integrity-engine.ts');
const COMPILED_PATH = path.join(REPO_ROOT, '.compiled', 'src', 'main', 'qa', 'scanners', 'layout-integrity-engine.js');
const TMP_PATH = path.join(REPO_ROOT, 'node_modules', '.tmp-integrity.mjs');

let LayoutIntegrityEngine;

// Resolve engine: load pre-compiled module if available, otherwise compile single file with esbuild
if (fs.existsSync(COMPILED_PATH)) {
  const mod = await import(pathToFileURL(COMPILED_PATH).href);
  LayoutIntegrityEngine = mod.LayoutIntegrityEngine;
} else {
  esbuild.buildSync({
    entryPoints: [SOURCE_PATH],
    format: 'esm',
    outfile: TMP_PATH,
  });
  const mod = await import(pathToFileURL(TMP_PATH).href);
  LayoutIntegrityEngine = mod.LayoutIntegrityEngine;
}

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

  it('generates self-contained IIFE browser scan script with viewport name binding', () => {
    const script = LayoutIntegrityEngine.getBrowserScanScript('mobile-test');
    assert.ok(typeof script === 'string' && script.length > 500);
    assert.ok(script.trimStart().startsWith('(() => {'));
    assert.ok(script.trimEnd().endsWith('})()'));
    assert.ok(script.includes("name: 'mobile-test'"));
  });

  it('contains elementFromPoint detector references for occlusion and sticky-obstruction probes', () => {
    const script = LayoutIntegrityEngine.getBrowserScanScript();
    assert.ok(script.includes('document.elementFromPoint'), 'Script must include document.elementFromPoint calls');
    assert.ok(script.includes('occlusion'), 'Script must identify occlusion kind');
    assert.ok(script.includes('sticky-obstruction'), 'Script must identify sticky-obstruction kind');
  });

  it('contains scrollWidth > clientWidth text clipping detector', () => {
    const script = LayoutIntegrityEngine.getBrowserScanScript();
    assert.ok(script.includes('el.scrollWidth > el.clientWidth + 2'), 'Script must check horizontal clipping with +2 deadband');
    assert.ok(script.includes('el.scrollHeight > el.clientHeight + 2'), 'Script must check vertical clipping with +2 deadband');
    assert.ok(script.includes('clipping'), 'Script must identify clipping kind');
  });

  it('contains sticky and fixed position probe for header/nav obstruction', () => {
    const script = LayoutIntegrityEngine.getBrowserScanScript();
    assert.ok(script.includes("style.position === 'sticky' || style.position === 'fixed'"), 'Script must probe sticky and fixed elements');
    assert.ok(script.includes('viewportHeight * 0.25'), 'Script must check top 25% viewport intersection');
    assert.ok(script.includes('viewportWidth * 0.30'), 'Script must check width covering > 30% viewport');
  });

  it('contains layout-shift witness using PerformanceObserver and buffered entries', () => {
    const script = LayoutIntegrityEngine.getBrowserScanScript();
    assert.ok(script.includes('PerformanceObserver'), 'Script must query PerformanceObserver');
    assert.ok(script.includes("'layout-shift'"), 'Script must inspect layout-shift entry types');
    assert.ok(script.includes('clsScore > 0.1'), 'Script must check cumulative layout shift score against 0.1 threshold');
    assert.ok(script.includes('layout-shift'), 'Script must emit layout-shift findings');
  });

  it('contains zero-size and offscreen detector for actionable controls', () => {
    const script = LayoutIntegrityEngine.getBrowserScanScript();
    assert.ok(script.includes('zero-size'), 'Script must identify zero-size controls');
    assert.ok(script.includes('offscreen'), 'Script must identify offscreen controls');
    assert.ok(script.includes('rect.width <= 0 || rect.height <= 0'), 'Script must check zero dimensions');
  });

  it('contains pairwise overlap detector with overlay suppression', () => {
    const script = LayoutIntegrityEngine.getBrowserScanScript();
    assert.ok(script.includes('overlap'), 'Script must identify overlap kind');
    assert.ok(script.includes('intersectionArea'), 'Script must compute intersection area');
    assert.ok(script.includes('(intersectionArea / minArea) > 0.6'), 'Script must check 60% overlap threshold');
  });

  it('contains measured:false unmeasuredReason marker path', () => {
    const script = LayoutIntegrityEngine.getBrowserScanScript();
    assert.ok(script.includes('measured: false'), 'Script must emit measured: false on unmeasured tabs');
    assert.ok(script.includes('unmeasuredReason'), 'Script must provide unmeasuredReason');
    assert.ok(script.includes('layout integrity scan threw:'), 'Script must guard whole-script failure');
  });

  it('contains findings capping logic at 50, prioritizing critical severity', () => {
    const script = LayoutIntegrityEngine.getBrowserScanScript();
    assert.ok(script.includes('findings.length > 50'), 'Script must check findings length > 50');
    assert.ok(script.includes("f.severity === 'critical'"), 'Script must prioritize critical findings');
    assert.ok(script.includes('.slice(0, 50)'), 'Script must slice findings at 50');
  });

  it('parses valid JavaScript syntax via new Function smoke test', () => {
    const script = LayoutIntegrityEngine.getBrowserScanScript('desktop');
    assert.doesNotThrow(() => {
      // Validates IIFE syntax without executing DOM operations
      new Function(script);
    });
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
      const scriptText = LayoutIntegrityEngine.getBrowserScanScript('active');
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
    });

    it('returns measured:true on laid-out document with empty clean findings', () => {
      const scriptText = LayoutIntegrityEngine.getBrowserScanScript('desktop');
      const script = new vm.Script(scriptText);
      const sandbox = {
        document: {
          documentElement: {
            clientWidth: 1440,
            clientHeight: 900,
          },
          body: {
            clientWidth: 1440,
            clientHeight: 900,
          },
          querySelectorAll: () => [],
          elementFromPoint: () => null,
          elementsFromPoint: () => [],
        },
        window: {
          innerWidth: 1440,
          innerHeight: 900,
          getComputedStyle: () => ({
            display: 'block',
            visibility: 'visible',
            opacity: '1',
            pointerEvents: 'auto',
            position: 'static',
            zIndex: '0',
          }),
        },
      };
      vm.createContext(sandbox);
      const result = script.runInContext(sandbox);

      assert.strictEqual(result.measured, true);
      assert.strictEqual(result.unmeasuredReason, undefined);
      assert.strictEqual(result.viewport.name, 'desktop');
      assert.strictEqual(result.viewport.width, 1440);
      assert.strictEqual(result.viewport.height, 900);
      assert.strictEqual(result.findings.length, 0);
    });
  });
});
