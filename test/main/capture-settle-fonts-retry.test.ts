import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildFontSettleScript, evaluatePreCaptureQuiescence } from '../../src/main/verification/capture-settle';

interface Sample {
  readyState: string;
  fontsSettled: boolean;
  fontsStatus: string;
  imageCount: number;
  pendingImages: number;
  brokenImages: string[];
  imageSetHash: string;
  imageStructureHash: string;
  imageStructureCount: number;
  imageParts: string[];
  imageContentParts: string[];
  imageStructureParts: string[];
  docHeight: number;
  scrollWidth: number;
}

const sampleOf = (over: Partial<Sample> = {}): Sample => ({
  readyState: 'complete',
  fontsSettled: true,
  fontsStatus: 'loaded',
  imageCount: 1,
  pendingImages: 0,
  brokenImages: [],
  imageSetHash: 'aaaa0000',
  imageStructureHash: 'bbbb1111',
  imageStructureCount: 1,
  imageParts: ['https://ex.com/hero.png|1200x600|0,0,1200,600|c'],
  imageContentParts: ['https://ex.com/hero.png|1200x600'],
  imageStructureParts: ['1200x600'],
  docHeight: 1000,
  scrollWidth: 1000,
  ...over,
});

const RETRY_WAIT_MS = 25;

/** Host whose fonts load only once the retry's document.fonts.ready wait has run. */
function slowFontHost(settlesAfterWait: boolean, over: Partial<Sample> = {}) {
  const waitScript = buildFontSettleScript(RETRY_WAIT_MS);
  let waited = false;
  let samples = 0;
  return {
    host: {
      evalJs: async (script: string): Promise<Sample | unknown> => {
        if (script === waitScript) {
          waited = true;
          return true;
        }
        samples += 1;
        const loaded = waited && settlesAfterWait;
        return sampleOf({ fontsSettled: loaded, fontsStatus: loaded ? 'loaded' : 'loading', ...over });
      },
    },
    stats: () => ({ waited, samples }),
  };
}

describe('pre-capture quiescence: fonts-only retry', () => {
  it('re-samples once after waiting on document.fonts.ready and admits a font that finished loading', async () => {
    const { host, stats } = slowFontHost(true);
    const result = await evaluatePreCaptureQuiescence(host, 'tab-1', 'desktop', { dwellMs: 0, fontsRetryWaitMs: RETRY_WAIT_MS });

    assert.equal(result.ready, true, 'a font that loads during the retry window must not refuse the raster');
    assert.equal(result.predicates.fontsSettled, true);
    assert.equal(result.measurements.fontsRetried, true);
    assert.equal(stats().waited, true);
  });

  it('returns the fonts refusal when the font is still loading after the one retry', async () => {
    const { host, stats } = slowFontHost(false);
    const first = await evaluatePreCaptureQuiescence(host, 'tab-1', 'desktop', { dwellMs: 0, fontsRetryWaitMs: 0 });
    const samplesWithoutRetry = stats().samples;
    const { host: retryHost, stats: retryStats } = slowFontHost(false);
    const result = await evaluatePreCaptureQuiescence(retryHost, 'tab-1', 'desktop', { dwellMs: 0, fontsRetryWaitMs: RETRY_WAIT_MS });

    assert.equal(first.ready, false);
    assert.equal(first.measurements.fontsRetried, undefined, 'a zero wait disables the retry');
    assert.equal(result.ready, false);
    assert.equal(result.failingPredicate, 'fontsSettled');
    assert.equal(result.measurements.fontsRetried, true);
    assert.ok(retryStats().samples > samplesWithoutRetry, 'the retry re-samples the page after the font wait');
  });

  it('does not retry when fonts are not the only failing predicate', async () => {
    const { host, stats } = slowFontHost(true, { pendingImages: 3, imageCount: 3 });
    const result = await evaluatePreCaptureQuiescence(host, 'tab-1', 'desktop', { dwellMs: 0, fontsRetryWaitMs: RETRY_WAIT_MS });

    assert.equal(result.ready, false);
    assert.equal(stats().waited, false, 'an images refusal is not a fonts problem; no font wait may run');
    assert.equal(result.measurements.fontsRetried, undefined);
  });
});
