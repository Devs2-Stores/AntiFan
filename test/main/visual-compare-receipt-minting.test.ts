// Both visual compare registrations record a verdict-bearing comparison in the host's compare
// ledger and return the receipt id beside the comparison's own result.
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import type { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { COMPARE_DEFAULT_TOLERANCE_PERCENT, readCompareReceipt } from '../../src/main/qa/compare-receipt-store';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';

const TARGET: BrowserTarget = {
  projectId: 'proj-mint',
  workspaceId: 'ws-mint',
  runtimeId: 'rt-mint',
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

let dataRoot = '';
let previousRoot: string | undefined;

before(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-compare-mint-'));
  previousRoot = process.env.ANTIFAN_DATA_ROOT;
  process.env.ANTIFAN_DATA_ROOT = dataRoot;
});

after(() => {
  if (previousRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
  else process.env.ANTIFAN_DATA_ROOT = previousRoot;
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

interface HarnessOptions {
  liveUrl?: string;
  captured?: { cssViewport: { width: number; height: number }; captureMode: string };
  observedUrl?: string;
  maskedAreaRatio?: number;
}

/** A compare result shaped like the one the control port returns for a completed pixel diff. */
function completed(extra: Record<string, unknown> = {}, opts: HarnessOptions = {}): Record<string, unknown> {
  return {
    status: 'PASS',
    match: true,
    mismatchPercentage: 0.4,
    receipt: { settleComplete: true, mismatchPercentage: 0.4 },
    captureReceipts: { target: opts.captured ?? { cssViewport: { width: 1440, height: 900 }, captureMode: 'viewport' } },
    routeAssertions: { target: { observedUrl: opts.observedUrl ?? 'https://shop.example.com/products/demo' } },
    maskResolution: { status: 'ok', maskedAreaRatio: opts.maskedAreaRatio ?? 0 },
    ...extra,
  };
}

function harness(compareResult: Record<string, unknown>, opts: HarnessOptions = {}) {
  const calls: { getViewport: number; getLiveTabUrl: number } = { getViewport: 0, getLiveTabUrl: 0 };
  const port = {
    visualCompare: async () => compareResult,
    getLiveTabUrl: async () => {
      calls.getLiveTabUrl += 1;
      return opts.liveUrl ?? 'https://elsewhere.example.com/moved-after-compare';
    },
    getViewport: async () => {
      calls.getViewport += 1;
      return { observedWidth: 375, width: 375, height: 667 };
    },
  } as unknown as BrowserControlPort;
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId: TARGET.projectId,
    workspaceId: TARGET.workspaceId,
    runtimeId: TARGET.runtimeId,
  });
  registerBrowserCapabilities(catalogue, port);
  const context = { browserTarget: TARGET, projectId: TARGET.projectId, workspaceId: TARGET.workspaceId } as never;
  const run = (name: string, params: Record<string, unknown>) =>
    catalogue.get(name)!.execute(params as never, context) as Promise<Record<string, unknown>>;
  return Object.assign(run, { calls });
}

describe('visual compare mints a compare receipt', () => {
  for (const name of ['browser.visual_compare', 'anti.visual.compare']) {
    it(`${name} returns a receipt id that resolves to the measured numbers and the compared scope`, async () => {
      const run = harness(completed());
      const res = await run(name, { baselineRef: 'vbase_123_abc', tolerance: 1 });
      assert.strictEqual(typeof res.compareReceiptId, 'string');
      assert.deepStrictEqual(res.compareViewport, { width: 1440, height: 900 });
      assert.strictEqual(res.status, 'PASS', 'the comparison result itself is untouched');
      const record = readCompareReceipt(res.compareReceiptId as string, { workspaceId: TARGET.workspaceId });
      assert.ok(record, 'the ledger holds the receipt');
      assert.strictEqual(record.mismatchPercentage, 0.4);
      assert.strictEqual(record.match, true);
      assert.strictEqual(record.origin, 'https://shop.example.com');
      assert.strictEqual(record.pathname, '/products/demo');
      assert.strictEqual(record.paneId, 'desktop');
      assert.strictEqual(record.fullPage, false);
      assert.strictEqual(record.clipped, false);
      assert.strictEqual(record.selector, null);
      assert.strictEqual(record.maskedAreaRatio, 0);
      assert.strictEqual(record.comparisonKind, 'baseline');
      assert.strictEqual(record.baselineRef, 'vbase_123_abc');
      assert.strictEqual(record.tolerancePercent, 1);
      assert.strictEqual(record.settleComplete, true);
    });

    it(`${name} takes the viewport and route from the compare's own capture, never from the tab afterwards`, async () => {
      const run = harness(completed());
      const res = await run(name, { baselineRef: 'vbase_123_abc' });
      assert.strictEqual(run.calls.getViewport, 0, 'the tab viewport is not read after the compare');
      assert.strictEqual(run.calls.getLiveTabUrl, 0, 'the tab URL is not read when the compare observed one');
      const record = readCompareReceipt(res.compareReceiptId as string, { workspaceId: TARGET.workspaceId });
      assert.deepStrictEqual(record?.viewport, { width: 1440, height: 900 });
      assert.strictEqual(record?.origin, 'https://shop.example.com');
    });

    it(`${name} records the default tolerance when the caller passes none`, async () => {
      const run = harness(completed());
      const res = await run(name, { baselineRef: 'vbase_123_abc' });
      const record = readCompareReceipt(res.compareReceiptId as string, { workspaceId: TARGET.workspaceId });
      assert.strictEqual(record?.tolerancePercent, COMPARE_DEFAULT_TOLERANCE_PERCENT);
    });

    it(`${name} records the pane, the capture scope and the mask share the compare used`, async () => {
      const run = harness(
        completed({}, { captured: { cssViewport: { width: 375, height: 667 }, captureMode: 'full-page' }, maskedAreaRatio: 0.25 })
      );
      const res = await run(name, { baselineRef: 'vbase_123_abc', paneId: 'mobile', selector: '.hero' });
      const record = readCompareReceipt(res.compareReceiptId as string, { workspaceId: TARGET.workspaceId });
      assert.strictEqual(record?.paneId, 'mobile');
      assert.strictEqual(record?.fullPage, true);
      assert.strictEqual(record?.selector, '.hero');
      assert.strictEqual(record?.maskedAreaRatio, 0.25);
      const clipped = harness(completed({}, { captured: { cssViewport: { width: 1440, height: 900 }, captureMode: 'clip' } }));
      const clippedRes = await clipped(name, { baselineRef: 'vbase_123_abc', clipRect: { x: 0, y: 0, width: 100, height: 100 } });
      assert.strictEqual(readCompareReceipt(clippedRes.compareReceiptId as string, { workspaceId: TARGET.workspaceId })?.clipped, true);
    });

    it(`${name} falls back to the live tab URL only when the compare observed none`, async () => {
      const result = completed();
      delete result.routeAssertions;
      const run = harness(result, { liveUrl: 'https://shop.example.com/collections/all' });
      const res = await run(name, { baselineRef: 'vbase_123_abc' });
      const record = readCompareReceipt(res.compareReceiptId as string, { workspaceId: TARGET.workspaceId });
      assert.strictEqual(record?.pathname, '/collections/all');
      assert.strictEqual(run.calls.getLiveTabUrl, 1);
    });

    it(`${name} records a FAIL verdict too, and a live-tab comparison as live-tab`, async () => {
      const run = harness(completed({ status: 'FAIL', match: false, mismatchPercentage: 7.5, receipt: { mismatchPercentage: 7.5 } }));
      const res = await run(name, { comparisonTabId: 'tab-2' });
      const record = readCompareReceipt(res.compareReceiptId as string, { workspaceId: TARGET.workspaceId });
      assert.ok(record);
      assert.strictEqual(record.match, false);
      assert.strictEqual(record.mismatchPercentage, 7.5);
      assert.strictEqual(record.comparisonKind, 'live-tab');
    });

    it(`${name} mints nothing for an inconclusive comparison`, async () => {
      const run = harness({ status: 'INCONCLUSIVE', match: false, mismatchPercentage: null });
      const res = await run(name, { baselineRef: 'vbase_123_abc' });
      assert.ok(!('compareReceiptId' in res));
    });

    it(`${name} mints nothing when the receipt carries no measured mismatch`, async () => {
      const run = harness({ status: 'FAIL', match: false, mismatchPercentage: 100, receipt: { mismatchPercentage: null } });
      const res = await run(name, { baselineRef: 'vbase_123_abc' });
      assert.ok(!('compareReceiptId' in res), 'a refused verdict publishes no number to certify');
    });
  }

  it('treats a non-finite mismatch as no verdict and leaves the comparison result unchanged', async () => {
    const run = harness({ status: 'PASS', match: true, mismatchPercentage: Number.POSITIVE_INFINITY });
    const res = await run('anti.visual.compare', { baselineRef: 'vbase_123_abc' });
    assert.strictEqual(res.status, 'PASS');
    assert.ok(!('compareReceiptId' in res), 'a non-finite mismatch is not verdict-bearing');
  });

  it('records a null viewport when the compare captured none', async () => {
    const run = harness(completed({}, { captured: { cssViewport: { width: 0, height: 0 }, captureMode: 'viewport' } }));
    const res = await run('anti.visual.compare', { baselineRef: 'vbase_123_abc' });
    assert.strictEqual(res.compareViewport, null);
    assert.strictEqual(readCompareReceipt(res.compareReceiptId as string, { workspaceId: TARGET.workspaceId })?.viewport, null);
  });
});
