import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildFontSettleScript, evaluatePreCaptureQuiescence } from '../../src/main/verification/capture-settle';
import { verificationCaptureReceipt, type CapturePhaseTimings } from '../../src/main/verification/visual-capture';
import { createCaptureHarness } from './capture-host-harness';

const PHASES: ReadonlyArray<keyof CapturePhaseTimings> = [
  'probeMs', 'prewarmMs', 'settleMs', 'fontsRetryMs', 'activationMs', 'rasterMs', 'encodeMs', 'restoreMs', 'totalMs',
];

function assertFinitePhases(timings: CapturePhaseTimings | undefined): CapturePhaseTimings {
  assert.ok(timings, 'the capture envelope must carry its phase timings');
  for (const phase of PHASES) {
    assert.ok(Number.isFinite(timings[phase]) && timings[phase] >= 0, `${phase} must be a finite non-negative number, got ${timings[phase]}`);
  }
  return timings;
}

/**
 * Real delay on purpose: the phase clocks read the platform clock, so a lower bound on a phase can
 * only be asserted against a wait the platform clock actually elapsed. A fake timer would not move them.
 */
function realDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const PREWARM_WALK_MS = 30;

/** Answers the in-page materialization walk after a real delay so its phase has a lower bound to assert. */
const slowPrewarm = (script: string): unknown =>
  script.includes('MAX_STEPS')
    ? realDelay(PREWARM_WALK_MS).then(() => ({
        performed: true, steps: 3, startHeight: 3000, endHeight: 3000, stoppedReason: 'COMPLETE',
        infiniteScrollSuspected: false, totalImages: 0, pendingImages: 0, fontsReady: true, returnedToTop: true, elapsedMs: PREWARM_WALK_MS,
      }))
    : undefined;

describe('verification capture phase timings', () => {
  it('reports finite per-phase timings on a full-page capture, with the walk and the total bounded below', async () => {
    const harness = createCaptureHarness({ documentHeight: 3000, onScript: slowPrewarm });

    const envelope = await harness.devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { fullPage: true });

    const timings = assertFinitePhases(envelope.timings);
    assert.equal(envelope.captureMode, 'full-page');
    assert.ok(timings.prewarmMs >= PREWARM_WALK_MS - 5, `the walk waited ${PREWARM_WALK_MS}ms, the phase read ${timings.prewarmMs}ms`);
    assert.ok(timings.totalMs >= timings.prewarmMs + timings.settleMs, 'the total covers the walk and the settle gate it ran');
    assert.ok(timings.totalMs >= timings.rasterMs, 'the total covers the raster');
    assert.equal(timings.fontsRetryMs, 0, 'no fonts retry ran');
  });

  it('leaves the walk phase at zero for a viewport capture, which never walks the document', async () => {
    const harness = createCaptureHarness({ onScript: slowPrewarm });

    const envelope = await harness.devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop');

    const timings = assertFinitePhases(envelope.timings);
    assert.equal(timings.prewarmMs, 0);
    assert.ok(timings.totalMs >= timings.settleMs);
  });

  it('projects the timings into the receipt that travels with the evidence', async () => {
    const harness = createCaptureHarness({ documentHeight: 2000, onScript: slowPrewarm });

    const envelope = await harness.devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { fullPage: true });
    const receipt = verificationCaptureReceipt(envelope);

    assert.deepEqual(receipt.timings, envelope.timings);
  });

  it('omits timings from a receipt built from an envelope that has none', () => {
    const receipt = verificationCaptureReceipt({
      data: '', backend: 'cdp', dpr: 1, zoom: 1,
      cssViewport: { width: 1, height: 1 }, cssCaptureSize: { width: 1, height: 1 }, rasterSize: { width: 1, height: 1 },
      captureMode: 'viewport', timestamp: 0,
    });

    assert.equal('timings' in receipt, false);
  });
});

describe('settle gate fonts retry timing', () => {
  const RETRY_WAIT_MS = 20;
  const sample = (fontsLoaded: boolean) => ({
    readyState: 'complete', fontsSettled: fontsLoaded, fontsStatus: fontsLoaded ? 'loaded' : 'loading',
    imageCount: 1, pendingImages: 0, brokenImages: [], imageSetHash: 'aaaa0000', imageStructureHash: 'bbbb1111',
    imageStructureCount: 1, imageParts: ['https://ex.com/a.png|10x10|0,0,10,10|c'], imageContentParts: ['https://ex.com/a.png|10x10'],
    imageStructureParts: ['10x10'], docHeight: 1000, scrollWidth: 1000,
  });

  it('measures the retry wall time, covering the font wait it performed', async () => {
    const waitScript = buildFontSettleScript(RETRY_WAIT_MS);
    let waited = false;
    const host = {
      evalJs: async (script: string): Promise<unknown> => {
        if (script === waitScript) {
          await realDelay(RETRY_WAIT_MS);
          waited = true;
          return true;
        }
        return sample(waited);
      },
    };

    const result = await evaluatePreCaptureQuiescence(host, 'tab-1', 'desktop', { dwellMs: 0, fontsRetryWaitMs: RETRY_WAIT_MS });

    assert.equal(result.measurements.fontsRetried, true);
    assert.ok((result.measurements.fontsRetryMs ?? -1) >= RETRY_WAIT_MS - 5, `retry read ${result.measurements.fontsRetryMs}ms for a ${RETRY_WAIT_MS}ms wait`);
  });

  it('reports no retry duration when the retry did not run', async () => {
    const host = { evalJs: async (): Promise<unknown> => sample(true) };

    const result = await evaluatePreCaptureQuiescence(host, 'tab-1', 'desktop', { dwellMs: 0, fontsRetryWaitMs: RETRY_WAIT_MS });

    assert.equal(result.ready, true);
    assert.equal(result.measurements.fontsRetried, undefined);
    assert.equal(result.measurements.fontsRetryMs, undefined);
  });
});
