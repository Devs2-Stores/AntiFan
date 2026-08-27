import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { LayoutOverflowEngine } from '../../src/main/qa/scanners/layout-overflow-engine';

describe('LayoutOverflowEngine', () => {
  it('defines standard e-commerce breakpoints (mobile, tablet, desktop)', () => {
    const bps = LayoutOverflowEngine.BREAKPOINTS;
    assert.strictEqual(bps.length, 3);
    assert.strictEqual(bps[0]?.name, 'mobile');
    assert.strictEqual(bps[0]?.width, 393);
    assert.strictEqual(bps[1]?.name, 'tablet');
    assert.strictEqual(bps[1]?.width, 820);
    assert.strictEqual(bps[2]?.name, 'desktop');
    assert.strictEqual(bps[2]?.width, 1440);
  });

  it('generates an isolated IIFE browser script with deadband threshold', () => {
    const script = LayoutOverflowEngine.getBrowserScanScript('mobile');
    assert.ok(script.startsWith('(() => {'));
    assert.ok(script.endsWith('})()'));
    assert.ok(script.includes('deadband'));
    assert.ok(script.includes('devicePixelRatio'));
    assert.ok(script.includes('culprits'));
    assert.ok(script.includes('outerHtmlSnippet'));
  });
});
