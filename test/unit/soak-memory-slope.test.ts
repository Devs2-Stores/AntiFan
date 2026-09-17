/**
 * Soak memory-slope math — the linear regression the real soak grades with.
 *
 * `scripts/smoke-real-soak.cjs` (npm run smoke:soak) computes its verdict through
 * `evaluateRunReport` -> `calculateSlope` in `scripts/freeze-certification-core.cjs`
 * (freeze-certification-core.cjs:44,235-236). This file tests that production
 * function directly: a copy of the formula living in a test would certify nothing.
 *
 * Contract under test: slope is returned in the selector's own units per minute
 * (MB/min when the selector yields MB), sign is preserved, and degenerate input
 * (fewer than 3 samples, zero timestamp variance) throws instead of silently
 * reporting a clean slope.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';

const { calculateSlope } = require(path.resolve(process.cwd(), 'scripts', 'freeze-certification-core.cjs')) as {
  calculateSlope: (samples: Array<{ timestamp: number; rssBytes: number }>, selector: (sample: { rssBytes: number }) => number) => number;
};
const MB = 1024 * 1024;

function rssSample(timestamp: number, rssMb: number) {
  return { timestamp, rssBytes: rssMb * MB };
}

const rssMb = (sample: { rssBytes: number }) => sample.rssBytes / MB;

describe('soak memory slope (production calculateSlope)', () => {
  it('reports ~0 MB/min for steady memory', () => {
    const samples = [rssSample(0, 400), rssSample(60_000, 400), rssSample(120_000, 400)];
    const slope = calculateSlope(samples, rssMb);
    assert.ok(Math.abs(slope) < 1e-9, `steady RSS must yield ~0 slope, got ${slope}`);
  });

  it('reports the exact leak rate for linear growth', () => {
    // +2 MB every minute: any implementation that returns the mean, the total
    // delta, or a per-second rate fails this.
    const samples = [rssSample(0, 400), rssSample(60_000, 402), rssSample(120_000, 404)];
    const slope = calculateSlope(samples, rssMb);
    assert.ok(Math.abs(slope - 2) < 1e-9, `+2 MB/min leak must yield slope 2, got ${slope}`);
  });

  it('preserves a negative slope instead of clamping to zero', () => {
    const samples = [rssSample(0, 400), rssSample(60_000, 398), rssSample(120_000, 396)];
    const slope = calculateSlope(samples, rssMb);
    assert.ok(Math.abs(slope + 2) < 1e-9, `shrinking RSS must yield slope -2, got ${slope}`);
  });

  it('rejects fewer than three samples', () => {
    assert.throws(() => calculateSlope([], rssMb), /three samples/);
    assert.throws(() => calculateSlope([rssSample(0, 400)], rssMb), /three samples/);
    assert.throws(() => calculateSlope([rssSample(0, 400), rssSample(60_000, 402)], rssMb), /three samples/);
  });

  it('rejects zero-duration samples instead of dividing by zero variance', () => {
    const samples = [rssSample(1_000, 400), rssSample(1_000, 402), rssSample(1_000, 404)];
    assert.throws(() => calculateSlope(samples, rssMb), /zero timestamp variance/);
  });
});
