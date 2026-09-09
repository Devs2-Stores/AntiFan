import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import {
  CAPTURE_MAX_DIMENSION,
  MaskLedger,
  MaskResolutionError,
  MultiKeyLock,
  NormalizationTransaction,
  TwoSourceCoherenceGuard,
  checkCaptureStateCompatibility,
  classifyCoherence,
  classifyIdentity,
  classifyMutation,
  coherencePairReceipt,
  maskEntryReceipt,
  materializeRasterMasks,
  rasterMatchesCss,
  resolveCaptureMode,
  transformMaskBoxToRaster,
  validateJpegBuffer,
  validatePngBuffer,
  visualCaptureSpaceFromMeasured,
  visualCaptureSpaceFromMetrics,
  type CaptureIdentitySnapshot,
  type VerificationCaptureReceipt,
} from '../../src/main/verification/visual-capture';

/**
 * Structurally complete PNG with real zlib-compressed IDAT data. CRC fields are
 * left zero because the integrity gate validates structure, not CRCs.
 */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface EvalCall {
  script: string;
  tabId?: string;
}

// Mock eval host: returns the recorded payload for mask queries; logs calls.
function maskHost(payloadPerCall: unknown[]): { host: { evalJs: (script: string, tabId?: string) => Promise<unknown> }; calls: EvalCall[] } {
  const calls: EvalCall[] = [];
  const host = {
    evalJs: async (script: string, tabId?: string): Promise<unknown> => {
      calls.push({ script, tabId });
      return payloadPerCall.length === 1 ? payloadPerCall[0] : payloadPerCall.shift();
    },
  };
  return { host, calls };
}

function resolvedEntry(selector: string, boxes: Array<{ x: number; y: number; width: number; height: number }>): unknown {
  return { selector, error: null, boxes };
}

function emptyEntry(selector: string): unknown {
  return { selector, error: null, boxes: [] };
}

function errorEntry(selector: string, message: string): unknown {
  return { selector, error: message, boxes: [] };
}

describe('VisualCaptureSpace & MaskLedger', () => {
  it('V-01: required mask selector with zero matches fails closed (MASK_RESOLUTION_FAILED)', async () => {
    const { host } = maskHost([[emptyEntry('.must-exist')]]);
    await assert.rejects(
      () => MaskLedger.resolve(host, 'tab-1', 'desktop', ['.must-exist'], []),
      (err: unknown) => {
        assert.ok(err instanceof MaskResolutionError);
        assert.strictEqual(err.status, 'MASK_RESOLUTION_FAILED');
        assert.strictEqual(err.entries.length, 1);
        assert.strictEqual(err.entries[0]!.status, 'missing-required');
        return true;
      }
    );
  });

  it('V-02: syntax-error payload for a required selector fails explicitly', async () => {
    const { host } = maskHost([[errorEntry('div[', 'Unexpected token [')]]);
    await assert.rejects(
      () => MaskLedger.resolve(host, 'tab-1', 'desktop', ['div['], []),
      (err: unknown) => {
        assert.ok(err instanceof MaskResolutionError);
        assert.strictEqual(err.status, 'MASK_RESOLUTION_FAILED');
        assert.strictEqual(err.entries[0]!.status, 'syntax-error');
        assert.ok(err.message.includes('div['));
        return true;
      }
    );
  });

  it('evalJs failure marks every entry eval-failed and fails closed', async () => {
    const host = {
      evalJs: async (): Promise<unknown> => {
        throw new Error('script crashed');
      },
    };
    await assert.rejects(
      () => MaskLedger.resolve(host, 'tab-1', 'desktop', ['.a', '.b'], []),
      (err: unknown) => {
        assert.ok(err instanceof MaskResolutionError);
        assert.strictEqual(err.entries.length, 2);
        assert.ok(err.entries.every((e) => e.status === 'eval-failed'));
        assert.ok(err.message.includes('script crashed'));
        return true;
      }
    );
  });

  it('optional zero-match is recorded, never fails (receipt optionalUnmatched)', async () => {
    const { host } = maskHost([
      [
        resolvedEntry('.ads', [{ x: 0, y: 0, width: 10, height: 10 }]),
        emptyEntry('.maybe-missing'),
      ],
    ]);
    const entries = await MaskLedger.resolve(host, 'tab-1', 'desktop', ['.ads'], ['.maybe-missing']);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0]!.status, 'resolved');
    assert.strictEqual(entries[1]!.status, 'missing-optional');

    const result = materializeRasterMasks(entries, visualCaptureSpaceFromMetrics({ dpr: 1 }), 100, 100);
    assert.deepEqual(result.optionalUnmatched, ['.maybe-missing']);
    assert.strictEqual(result.maskBoxes.length, 1);
    assert.strictEqual(result.maskedAreaRatio, 100 / 10000);
  });

  it('V-03: crop selector origin != 0 transforms to correct raster pixels', () => {
    const space = visualCaptureSpaceFromMeasured({
      pngWidth: 800,
      pngHeight: 400,
      cssViewportWidth: 1000,
      cssViewportHeight: 500,
      crop: { x: 100, y: 50, width: 400, height: 200 },
    });
    // scaleX = 800/400 = 2 ; scaleY = 400/200 = 2
    const atOrigin = transformMaskBoxToRaster({ x: 100, y: 50, width: 50, height: 25 }, space);
    assert.deepEqual(atOrigin, { x: 0, y: 0, width: 100, height: 50 });
    const shifted = transformMaskBoxToRaster({ x: 200, y: 100, width: 50, height: 25 }, space);
    assert.deepEqual(shifted, { x: 200, y: 100, width: 100, height: 50 });
  });

  it('V-04: clipRect offset origin maps to correct raster pixels', () => {
    const space = visualCaptureSpaceFromMeasured({
      pngWidth: 640,
      pngHeight: 480,
      cssViewportWidth: 800,
      cssViewportHeight: 600,
      crop: { x: 40, y: 60, width: 320, height: 240 },
    });
    // scaleX = 640/320 = 2 ; scaleY = 480/240 = 2
    const box = transformMaskBoxToRaster({ x: 80, y: 100, width: 10, height: 10 }, space);
    assert.deepEqual(box, { x: 80, y: 80, width: 20, height: 20 });
  });

  it('V-05: fullPage + scrollY > 0 makes mask boxes document-relative', () => {
    const space = visualCaptureSpaceFromMeasured({
      pngWidth: 1600,
      pngHeight: 4000,
      cssViewportWidth: 1600,
      cssViewportHeight: 900,
      cssDocumentHeight: 4000,
      scrollX: 10,
      scrollY: 300,
      fullPage: true,
    });
    // scaleX = 1600/1600 = 1 ; scaleY = 4000/4000 = 1
    const box = transformMaskBoxToRaster({ x: 10, y: 20, width: 100, height: 50 }, space);
    assert.deepEqual(box, { x: 20, y: 320, width: 100, height: 50 });
  });

  it('V-06/V-07: DPR 2 x zoom 1.25 transforms deterministically', () => {
    const space = visualCaptureSpaceFromMetrics({ dpr: 2, zoom: 1.25 });
    assert.strictEqual(space.scaleX, 2.5);
    assert.strictEqual(space.scaleY, 2.5);
    const box = transformMaskBoxToRaster({ x: 4, y: 8, width: 10, height: 10 }, space);
    assert.deepEqual(box, { x: 10, y: 20, width: 25, height: 25 });
  });

  it('V-08: same selector with different coordinates per side normalizes independently', async () => {
    const sideA = await MaskLedger.resolve(
      { evalJs: async () => [resolvedEntry('.badge', [{ x: 0, y: 0, width: 10, height: 10 }])] },
      'tab-a',
      'desktop',
      ['.badge'],
      []
    );
    const sideB = await MaskLedger.resolve(
      { evalJs: async () => [resolvedEntry('.badge', [{ x: 100, y: 50, width: 10, height: 10 }])] },
      'tab-b',
      'desktop',
      ['.badge'],
      []
    );
    const space = visualCaptureSpaceFromMetrics({ dpr: 2 });
    const rasterA = transformMaskBoxToRaster(sideA[0]!.cssBoxes[0]!, space);
    const rasterB = transformMaskBoxToRaster(sideB[0]!.cssBoxes[0]!, space);
    assert.deepEqual(rasterA, { x: 0, y: 0, width: 20, height: 20 });
    assert.deepEqual(rasterB, { x: 200, y: 100, width: 20, height: 20 });
  });

  it('V-23: masked area ratio above 0.70 policy ceiling is rejected', async () => {
    const { host } = maskHost([
      [resolvedEntry('.overlay', [{ x: 0, y: 0, width: 80, height: 60 }])],
    ]);
    const entries = await MaskLedger.resolve(host, 'tab-1', 'desktop', ['.overlay'], []);
    assert.throws(
      () => materializeRasterMasks(entries, visualCaptureSpaceFromMetrics({ dpr: 1 }), 100, 60),
      (err: unknown) => {
        assert.ok(err instanceof MaskResolutionError);
        assert.strictEqual(err.status, 'MASK_RATIO_POLICY_VIOLATION');
        assert.ok(Math.abs(err.maskedAreaRatio - 0.8) < 1e-9);
        return true;
      }
    );
  });

  it('masked area exactly at the 0.70 ceiling is allowed', async () => {
    const { host } = maskHost([
      [resolvedEntry('.overlay', [{ x: 0, y: 0, width: 70, height: 60 }])],
    ]);
    const entries = await MaskLedger.resolve(host, 'tab-1', 'desktop', ['.overlay'], []);
    const result = materializeRasterMasks(entries, visualCaptureSpaceFromMetrics({ dpr: 1 }), 100, 60);
    assert.ok(Math.abs(result.maskedAreaRatio - 0.7) < 1e-9);
  });


  it('mask partially off the capture edge clips instead of shifting (pixel-grid)', () => {
    const space = visualCaptureSpaceFromMetrics({ dpr: 1 });
    const box = transformMaskBoxToRaster({ x: -5, y: -2, width: 10, height: 8 }, space);
    assert.deepEqual(box, { x: 0, y: 0, width: 5, height: 6 });
  });

  it('mask edges round independently (half-open pixel grid)', () => {
    const space = visualCaptureSpaceFromMetrics({ dpr: 1 });
    const box = transformMaskBoxToRaster({ x: 10.6, y: 0, width: 4.8, height: 10 }, space);
    assert.deepEqual(box, { x: 11, y: 0, width: 4, height: 10 });
  });

  it('overlapping masks count union area, not the sum', async () => {
    const { host } = maskHost([
      [
        resolvedEntry('.m1', [{ x: 0, y: 0, width: 60, height: 60 }]),
        resolvedEntry('.m2', [{ x: 30, y: 0, width: 60, height: 60 }]),
      ],
    ]);
    const entries = await MaskLedger.resolve(host, 'tab-1', 'desktop', ['.m1', '.m2'], []);
    const result = materializeRasterMasks(entries, visualCaptureSpaceFromMetrics({ dpr: 1 }), 100, 100);
    assert.ok(Math.abs(result.maskedAreaRatio - 0.54) < 1e-9, 'union 90x60, not 120x60');
  });

  it('mask portions beyond the capture bounds are clipped from coverage', async () => {
    const { host } = maskHost([
      [resolvedEntry('.wide', [{ x: 80, y: 0, width: 40, height: 100 }])],
    ]);
    const entries = await MaskLedger.resolve(host, 'tab-1', 'desktop', ['.wide'], []);
    const result = materializeRasterMasks(entries, visualCaptureSpaceFromMetrics({ dpr: 1 }), 100, 100);
    assert.ok(Math.abs(result.maskedAreaRatio - 0.2) < 1e-9, 'clipped to 20x100');
  });

  it('fully out-of-bounds mask contributes zero coverage without throwing', async () => {
    const { host } = maskHost([
      [resolvedEntry('.off', [{ x: 150, y: 0, width: 10, height: 10 }])],
    ]);
    const entries = await MaskLedger.resolve(host, 'tab-1', 'desktop', ['.off'], []);
    const result = materializeRasterMasks(entries, visualCaptureSpaceFromMetrics({ dpr: 1 }), 100, 100);
    assert.strictEqual(result.maskedAreaRatio, 0);
  });

  it('materialize with entries but no positive scale fails closed', async () => {
    const { host } = maskHost([
      [resolvedEntry('.a', [{ x: 0, y: 0, width: 10, height: 10 }])],
    ]);
    const entries = await MaskLedger.resolve(host, 'tab-1', 'desktop', ['.a'], []);
    assert.throws(
      () => materializeRasterMasks(entries, null, 10, 10),
      (err: unknown) => {
        assert.ok(err instanceof MaskResolutionError);
        assert.strictEqual(err.status, 'MASK_RESOLUTION_FAILED');
        return true;
      }
    );
  });

  it('materialize with zero resolved entries is safe even with null space', () => {
    const { host } = maskHost([[emptyEntry('.optional-thing')]]);
    return MaskLedger.resolve(host, 'tab-1', 'desktop', [], ['.optional-thing']).then((entries) => {
      const result = materializeRasterMasks(entries, null, 0, 0);
      assert.strictEqual(result.maskBoxes.length, 0);
      assert.strictEqual(result.maskedAreaRatio, 0);
      assert.deepEqual(result.optionalUnmatched, ['.optional-thing']);
    });
  });

  it('maskEntryReceipt projects the stable receipt shape', () => {
    const { host } = maskHost([
      [resolvedEntry('.ads', [{ x: 0, y: 0, width: 4, height: 4 }])],
    ]);
    return MaskLedger.resolve(host, 'tab-1', 'desktop', ['.ads'], []).then((entries) => {
      const receipt = maskEntryReceipt(entries[0]!);
      assert.deepEqual(receipt, { selector: '.ads', required: true, status: 'resolved' });
      assert.ok(!('cssBoxes' in receipt), 'receipt must not leak geometry');
    });
  });
});

describe('NormalizationTransaction', () => {
  it('inject reports ownership when it creates the style element', async () => {
    const calls: EvalCall[] = [];
    const host = {
      evalJs: async (script: string, tabId?: string): Promise<unknown> => {
        calls.push({ script, tabId });
        return true;
      },
    };
    const outcome = await NormalizationTransaction.inject(host, 'tab-1', 'desktop');
    assert.deepEqual(outcome, { ok: true, owned: true, present: true });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0]!.script.includes('__antifan_normalize_scroll'));
    assert.strictEqual(calls[0]!.tabId, 'tab-1');
  });

  it('inject does not claim ownership of a pre-existing style element', async () => {
    const host = { evalJs: async (): Promise<unknown> => ({ owned: false, present: true }) };
    const outcome = await NormalizationTransaction.inject(host, 'tab-1', 'desktop');
    assert.deepEqual(outcome, { ok: true, owned: false, present: true });
  });

  it('inject surfaces eval failure without throwing', async () => {
    const host = {
      evalJs: async (): Promise<unknown> => {
        throw new Error('inject boom');
      },
    };
    const outcome = await NormalizationTransaction.inject(host, 'tab-1', 'desktop');
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.owned, false);
    assert.ok(outcome.error && outcome.error.includes('inject boom'));
  });

  it('restore returns ok:true only when the owned style is verified removed', async () => {
    const calls: EvalCall[] = [];
    const host = {
      evalJs: async (script: string, tabId?: string): Promise<unknown> => {
        calls.push({ script, tabId });
        return true;
      },
    };
    const outcome = await NormalizationTransaction.restore(host, 'tab-1', 'desktop', true);
    assert.deepEqual(outcome, { ok: true, owned: true });
    assert.ok(calls[0]!.script.includes('el.remove'));
  });

  it('restore reports failure when the style element is still present', async () => {
    const host = { evalJs: async (): Promise<unknown> => false };
    const outcome = await NormalizationTransaction.restore(host, 'tab-1', 'desktop', true);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.owned, true);
    assert.ok(outcome.error && outcome.error.includes('still present'));
  });

  it('restore for an unowned element is a no-op (no evalJs call)', async () => {
    let calls = 0;
    const host = { evalJs: async (): Promise<unknown> => { calls += 1; return true; } };
    const outcome = await NormalizationTransaction.restore(host, 'tab-1', 'desktop', false);
    assert.deepEqual(outcome, { ok: true, owned: false });
    assert.strictEqual(calls, 0);
  });
});

describe('MultiKeyLock', () => {
  it('serializes acquisitions on the same key (FIFO)', async () => {
    const lock = new MultiKeyLock();
    const order: string[] = [];
    const release1 = await lock.acquire(['a']);
    order.push('first-held');
    const second = lock.acquire(['a']).then((release) => {
      order.push('second-held');
      return release;
    });
    await Promise.resolve();
    assert.deepEqual(order, ['first-held']);
    await release1();
    const release2 = await second;
    await release2();
    assert.deepEqual(order, ['first-held', 'second-held']);
  });

  it('acquires different keys in parallel without blocking', async () => {
    const lock = new MultiKeyLock();
    const release1 = await lock.acquire(['a']);
    const release2 = await lock.acquire(['b']);
    await release1();
    await release2();
  });

  it('multi-key acquisition sorts keys deterministically (reverse order serializes)', async () => {
    const lock = new MultiKeyLock();
    const order: string[] = [];
    const releaseAB = await lock.acquire(['a', 'b']);
    order.push('ab');
    const second = lock.acquire(['b', 'a']).then((release) => {
      order.push('ba');
      return release;
    });
    await Promise.resolve();
    assert.deepEqual(order, ['ab']);
    await releaseAB();
    const releaseBA = await second;
    await releaseBA();
    assert.deepEqual(order, ['ab', 'ba']);
  });

  it('holds every requested key until release (single-key waiter blocks on held pair)', async () => {
    const lock = new MultiKeyLock();
    const releasePair = await lock.acquire(['a', 'b']);
    let bFree = false;
    const waiter = lock.acquire(['b']).then((release) => {
      bFree = true;
      return release;
    });
    await Promise.resolve();
    assert.strictEqual(bFree, false);
    await releasePair();
    const releaseB = await waiter;
    assert.strictEqual(bFree, true);
    await releaseB();
  });

  it('release is idempotent', async () => {
    const lock = new MultiKeyLock();
    const release = await lock.acquire(['a']);
    await release();
    await release();
    // The queue must be drained — a fresh acquisition resolves immediately.
    const release2 = await lock.acquire(['a']);
    await release2();
  });

  it('empty key list acquires and releases immediately', async () => {
    const lock = new MultiKeyLock();
    const release = await lock.acquire([]);
    await release();
  });
});

describe('TwoSourceCoherenceGuard (identity and mutation spans)', () => {
  const snap = (over: Partial<CaptureIdentitySnapshot> = {}): CaptureIdentitySnapshot => ({
    browserEpoch: 1,
    documentGeneration: 1,
    mutationRevision: 1,
    ...over,
  });

  it('identity span: documentGeneration advance settles TARGET_STALE', () => {
    const guard = new TwoSourceCoherenceGuard();
    guard.recordPreInject('target', snap());
    guard.openMutationWindow('target', snap());
    const check = guard.check('target', snap({ documentGeneration: 2 }));
    assert.strictEqual(check.identity, 'TARGET_STALE');
    assert.strictEqual(check.mutation, 'COHERENT');
  });

  it('mutation window: revision bump settles RESAMPLE with coherent identity', () => {
    const guard = new TwoSourceCoherenceGuard();
    guard.recordPreInject('target', snap({ mutationRevision: 5 }));
    guard.openMutationWindow('target', snap({ mutationRevision: 5 }));
    const check = guard.check('target', snap({ mutationRevision: 6 }));
    assert.strictEqual(check.mutation, 'RESAMPLE');
    assert.strictEqual(check.identity, 'COHERENT');
  });

  it('browserEpoch bump settles TARGET_STALE on identity span', () => {
    const guard = new TwoSourceCoherenceGuard();
    guard.recordPreInject('baseline', snap());
    guard.openMutationWindow('baseline', snap());
    const check = guard.check('baseline', snap({ browserEpoch: 2 }));
    assert.strictEqual(check.identity, 'TARGET_STALE');
    assert.strictEqual(check.mutation, 'COHERENT');
  });

  it('stable snapshots settle COHERENT on both spans', () => {
    const guard = new TwoSourceCoherenceGuard();
    guard.recordPreInject('target', snap());
    guard.openMutationWindow('target', snap());
    const check = guard.check('target', snap());
    assert.strictEqual(check.identity, 'COHERENT');
    assert.strictEqual(check.mutation, 'COHERENT');
  });

  it('openMutationWindow without recordPreInject throws', () => {
    const guard = new TwoSourceCoherenceGuard();
    assert.throws(() => guard.openMutationWindow('target', snap()), /recordPreInject/);
  });

  it('check without an open mutation window throws', () => {
    const guard = new TwoSourceCoherenceGuard();
    guard.recordPreInject('target', snap());
    assert.throws(() => guard.check('target', snap()), /window not open/);
  });

  it('classifyIdentity ignores mutationRevision but catches documentGeneration', () => {
    assert.strictEqual(classifyIdentity(snap(), snap({ mutationRevision: 9 })), 'COHERENT');
    assert.strictEqual(classifyIdentity(snap(), snap({ documentGeneration: 3 })), 'TARGET_STALE');
    assert.strictEqual(classifyCoherence(snap(), snap({ mutationRevision: 9 })), 'RESAMPLE');
    assert.strictEqual(classifyMutation(snap(), snap({ mutationRevision: 9 })), 'RESAMPLE');
    assert.strictEqual(classifyMutation(snap(), snap({ documentGeneration: 3 })), 'COHERENT');
  });

  it('coherencePairReceipt projects the stable receipt shape', () => {
    const check = { preInject: snap(), postInject: snap(), afterCapture: snap({ mutationRevision: 2 }), identity: 'COHERENT' as const, mutation: 'RESAMPLE' as const };
    const receipt = coherencePairReceipt(check);
    assert.deepStrictEqual(receipt, check);
  });
});

describe('normalizationSymmetric (presence and ownership consistency)', () => {
  const receipt = (over: Record<string, unknown> = {}) => ({
    requested: true,
    injected: true,
    owned: true,
    restored: false,
    ...over,
  });

  it('symmetric owned+present pair is comparable', () => {
    assert.strictEqual(TwoSourceCoherenceGuard.normalizationSymmetric(receipt(), receipt()), true);
  });

  it('either-side inject failure is asymmetric', () => {
    assert.strictEqual(TwoSourceCoherenceGuard.normalizationSymmetric(receipt({ injectError: 'denied' }), receipt()), false);
    assert.strictEqual(TwoSourceCoherenceGuard.normalizationSymmetric(receipt(), receipt({ injectError: 'denied' })), false);
  });

  it('presence asymmetry (absent vs present) is asymmetric', () => {
    assert.strictEqual(TwoSourceCoherenceGuard.normalizationSymmetric(receipt({ injected: false }), receipt()), false);
  });

  it('both verified absent is comparable (unnormalized layout, symmetric)', () => {
    assert.strictEqual(TwoSourceCoherenceGuard.normalizationSymmetric(receipt({ injected: false, owned: false }), receipt({ injected: false, owned: false })), true);
  });

  it('present-but-unowned on one side stays fail-closed (unverified CSS content)', () => {
    assert.strictEqual(TwoSourceCoherenceGuard.normalizationSymmetric(receipt(), receipt({ owned: false })), false);
  });

  it('not-requested normalization is not symmetric for a requested compare', () => {
    assert.strictEqual(TwoSourceCoherenceGuard.normalizationSymmetric(receipt({ requested: false }), receipt()), false);
  });
});

describe('MultiKeyLock release discipline', () => {
  it('release in finally after an action throw unblocks the next waiter', async () => {
    const lock = new MultiKeyLock();
    const releaseFirst = await lock.acquire(['a']);
    let waiterResolved = false;
    const waiter = lock.acquire(['a']).then((release) => {
      waiterResolved = true;
      return release;
    });
    await Promise.resolve();
    assert.strictEqual(waiterResolved, false);
    await assert.rejects(async () => {
      try {
        throw new Error('boom');
      } finally {
        await releaseFirst();
      }
    }, /boom/);
    const releaseWaiter = await waiter;
    assert.strictEqual(waiterResolved, true);
    await releaseWaiter();
  });
});

describe('checkCaptureStateCompatibility (pure Tier 1 compatibility gate)', () => {
  const mkReceipt = (over: Partial<VerificationCaptureReceipt> = {}): VerificationCaptureReceipt => {
    const cssViewport = over.cssViewport ?? { width: 1200, height: 800 };
    return {
      backend: 'cdp',
      dpr: 2,
      zoom: 1.0,
      cssViewport,
      cssCaptureSize: { width: cssViewport.width, height: cssViewport.height },
      rasterSize: { width: 2400, height: 1600 },
      captureMode: 'viewport',
      timestamp: 1000,
      ...over,
    };
  };

  it('identical receipts are compatible', () => {
    const res = checkCaptureStateCompatibility(mkReceipt(), mkReceipt());
    assert.strictEqual(res.compatible, true);
    assert.strictEqual(res.reason, undefined);
  });

  it('null or missing receipt returns incompatible', () => {
    assert.strictEqual(checkCaptureStateCompatibility(null as any, mkReceipt()).compatible, false);
    assert.strictEqual(checkCaptureStateCompatibility(mkReceipt(), undefined as any).compatible, false);
  });

  it('backend mismatch returns incompatible', () => {
    const res = checkCaptureStateCompatibility(mkReceipt({ backend: 'cdp' }), mkReceipt({ backend: 'other' }));
    assert.strictEqual(res.compatible, false);
    assert.ok(res.reason?.includes('Capture backend mismatch'));
  });

  it('NaN, negative or non-finite DPR returns incompatible', () => {
    assert.strictEqual(checkCaptureStateCompatibility(mkReceipt({ dpr: NaN }), mkReceipt()).compatible, false);
    assert.strictEqual(checkCaptureStateCompatibility(mkReceipt({ dpr: -1 }), mkReceipt()).compatible, false);
    assert.strictEqual(checkCaptureStateCompatibility(mkReceipt({ dpr: Infinity }), mkReceipt()).compatible, false);
  });

  it('DPR mismatch > 0.01 returns incompatible', () => {
    const res = checkCaptureStateCompatibility(mkReceipt({ dpr: 2.0 }), mkReceipt({ dpr: 2.05 }));
    assert.strictEqual(res.compatible, false);
    assert.ok(res.reason?.includes('Device pixel ratio mismatch'));
  });

  it('NaN, negative or non-finite zoom returns incompatible', () => {
    assert.strictEqual(checkCaptureStateCompatibility(mkReceipt({ zoom: NaN }), mkReceipt()).compatible, false);
    assert.strictEqual(checkCaptureStateCompatibility(mkReceipt({ zoom: 0 }), mkReceipt()).compatible, false);
  });

  it('zoom mismatch > 0.01 returns incompatible', () => {
    const res = checkCaptureStateCompatibility(mkReceipt({ zoom: 1.0 }), mkReceipt({ zoom: 1.25 }));
    assert.strictEqual(res.compatible, false);
    assert.ok(res.reason?.includes('Zoom level mismatch'));
  });

  it('CSS viewport dimension mismatch returns incompatible', () => {
    const res = checkCaptureStateCompatibility(
      mkReceipt({ cssViewport: { width: 1200, height: 800 } }),
      mkReceipt({ cssViewport: { width: 1205, height: 800 } })
    );
    assert.strictEqual(res.compatible, false);
    assert.ok(res.reason?.includes('CSS viewport dimension mismatch'));
  });

  it('CSS viewport with NaN or zero dimensions returns incompatible', () => {
    assert.strictEqual(checkCaptureStateCompatibility(mkReceipt({ cssViewport: { width: NaN, height: 800 } }), mkReceipt()).compatible, false);
    assert.strictEqual(checkCaptureStateCompatibility(mkReceipt({ cssViewport: { width: 0, height: 800 } }), mkReceipt()).compatible, false);
  });

  it('capture mode mismatch returns incompatible', () => {
    const res = checkCaptureStateCompatibility(mkReceipt({ captureMode: 'viewport' }), mkReceipt({ captureMode: 'full-page' }));
    assert.strictEqual(res.compatible, false);
    assert.ok(res.reason?.includes('Capture mode mismatch'));
  });

  it('CSS capture size mismatch beyond one pixel returns incompatible', () => {
    const res = checkCaptureStateCompatibility(
      mkReceipt({ cssCaptureSize: { width: 1200, height: 800 } }),
      mkReceipt({ cssCaptureSize: { width: 1200, height: 803 } })
    );
    assert.strictEqual(res.compatible, false);
    assert.ok(res.reason?.includes('CSS capture size mismatch'));
  });

  it('CSS capture size within one pixel per axis stays compatible', () => {
    const res = checkCaptureStateCompatibility(
      mkReceipt({ cssCaptureSize: { width: 1200, height: 800 } }),
      mkReceipt({ cssCaptureSize: { width: 1201, height: 799 } })
    );
    assert.strictEqual(res.compatible, true);
  });

  it('missing or invalid CSS capture size returns incompatible', () => {
    assert.strictEqual(
      checkCaptureStateCompatibility(mkReceipt({ cssCaptureSize: undefined }), mkReceipt()).compatible,
      false
    );
    assert.strictEqual(
      checkCaptureStateCompatibility(mkReceipt({ cssCaptureSize: { width: NaN, height: 800 } }), mkReceipt()).compatible,
      false
    );
    assert.strictEqual(
      checkCaptureStateCompatibility(mkReceipt({ cssCaptureSize: { width: 1200, height: 0 } }), mkReceipt()).compatible,
      false
    );
  });
});

describe('resolveCaptureMode (mode precedence)', () => {
  it('rect wins over fullPage and settles clip', () => {
    assert.strictEqual(resolveCaptureMode({ x: 0, y: 0, width: 10, height: 10 }, true), 'clip');
    assert.strictEqual(resolveCaptureMode({ x: 5, y: 5, width: 1, height: 1 }, false), 'clip');
  });

  it('fullPage without a rect settles full-page', () => {
    assert.strictEqual(resolveCaptureMode(undefined, true), 'full-page');
    assert.strictEqual(resolveCaptureMode(null, true), 'full-page');
  });

  it('no rect and no fullPage settles viewport', () => {
    assert.strictEqual(resolveCaptureMode(undefined, undefined), 'viewport');
    assert.strictEqual(resolveCaptureMode(undefined, false), 'viewport');
    assert.strictEqual(resolveCaptureMode(null, false), 'viewport');
  });
});

describe('validatePngBuffer (PNG integrity gate)', () => {
  it('accepts a structurally complete PNG and reports IHDR dimensions', () => {
    const res = validatePngBuffer(makePng(7, 5));
    assert.deepStrictEqual(res, { ok: true, width: 7, height: 5 });
  });

  it('rejects an empty payload with CAPTURE_EMPTY_PAYLOAD', () => {
    const res = validatePngBuffer(Buffer.alloc(0));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_EMPTY_PAYLOAD');
  });

  it('rejects a foreign payload with CAPTURE_PNG_SIGNATURE_INVALID', () => {
    const res = validatePngBuffer(Buffer.from('not a png at all'));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_PNG_SIGNATURE_INVALID');
  });

  it('rejects a missing IEND with CAPTURE_PNG_TRUNCATED', () => {
    const png = makePng(4, 4);
    const res = validatePngBuffer(png.subarray(0, png.length - 12));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_PNG_TRUNCATED');
    assert.strictEqual(res.width, 4);
    assert.strictEqual(res.height, 4);
  });

  it('rejects a chunk whose declared length runs past the buffer with CAPTURE_PNG_TRUNCATED', () => {
    const png = makePng(4, 4);
    const res = validatePngBuffer(png.subarray(0, png.length - 5));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_PNG_TRUNCATED');
  });

  it('rejects an undecodable IDAT payload with CAPTURE_PNG_UNDECODABLE', () => {
    const chunk = (type: string, data: Buffer): Buffer => {
      const out = Buffer.alloc(12 + data.length);
      out.writeUInt32BE(data.length, 0);
      out.write(type, 4, 'latin1');
      data.copy(out, 8);
      return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const corrupt = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', Buffer.from([0x00, 0x01, 0x02, 0x03])),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const res = validatePngBuffer(corrupt);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_PNG_UNDECODABLE');
  });

  it('rejects a first chunk that is not IHDR with CAPTURE_PNG_UNDECODABLE', () => {
    const chunk = (type: string, data: Buffer): Buffer => {
      const out = Buffer.alloc(12 + data.length);
      out.writeUInt32BE(data.length, 0);
      out.write(type, 4, 'latin1');
      data.copy(out, 8);
      return out;
    };
    const res = validatePngBuffer(
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
        chunk('IEND', Buffer.alloc(0)),
      ])
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_PNG_UNDECODABLE');
  });

  it('rejects trailing bytes after IEND with CAPTURE_PNG_UNDECODABLE', () => {
    const res = validatePngBuffer(Buffer.concat([makePng(3, 3), Buffer.from([0x00])]));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_PNG_UNDECODABLE');
  });

  it('exports a 16384 CSS-pixel compositing ceiling', () => {
    assert.strictEqual(CAPTURE_MAX_DIMENSION, 16384);
  });
});

/**
 * Structurally valid baseline JPEG: SOI, a SOF0 carrying the real dimensions,
 * an SOS marker and one scan byte, then EOI. Entropy data is irrelevant to the
 * integrity gate, which reports dimensions from the SOF segment.
 */
function makeJpeg(width: number, height: number, options?: { fillBytes?: boolean; sofMarker?: number }): Buffer {
  const segment = (marker: number, payload: Buffer): Buffer => {
    const out = Buffer.alloc(4 + payload.length);
    out[0] = 0xff;
    out[1] = marker;
    out.writeUInt16BE(payload.length + 2, 2);
    payload.copy(out, 4);
    return out;
  };
  const sof = Buffer.alloc(8);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1;
  sof[6] = 1;
  sof[7] = 0x11;
  const sos = Buffer.from([1, 1, 0, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...(options?.fillBytes ? [Buffer.from([0xff])] : []),
    segment(options?.sofMarker ?? 0xc0, sof),
    segment(0xda, sos),
    Buffer.from([0x00, 0xff, 0xd9]),
  ]);
}

describe('validateJpegBuffer (JPEG integrity gate)', () => {
  it('accepts a structurally complete JPEG and reports SOF dimensions', () => {
    assert.deepStrictEqual(validateJpegBuffer(makeJpeg(1280, 720)), { ok: true, width: 1280, height: 720 });
  });

  it('accepts a progressive SOF2 payload and skips 0xff fill bytes before the marker', () => {
    const res = validateJpegBuffer(makeJpeg(64, 48, { fillBytes: true, sofMarker: 0xc2 }));
    assert.deepStrictEqual(res, { ok: true, width: 64, height: 48 });
  });

  it('rejects an empty payload with CAPTURE_EMPTY_PAYLOAD', () => {
    const res = validateJpegBuffer(Buffer.alloc(0));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_EMPTY_PAYLOAD');
  });

  it('rejects a foreign payload with CAPTURE_JPEG_SIGNATURE_INVALID', () => {
    const res = validateJpegBuffer(Buffer.from('not a jpeg at all'));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_JPEG_SIGNATURE_INVALID');
  });

  it('rejects a missing EOI with CAPTURE_JPEG_TRUNCATED', () => {
    const jpeg = makeJpeg(4, 4);
    const res = validateJpegBuffer(jpeg.subarray(0, jpeg.length - 2));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_JPEG_TRUNCATED');
  });

  it('rejects a segment whose declared length runs past the buffer with CAPTURE_JPEG_TRUNCATED', () => {
    const jpeg = makeJpeg(4, 4);
    const truncated = jpeg.subarray(0, 8);
    const res = validateJpegBuffer(Buffer.concat([truncated, Buffer.from([0xff, 0xd9])]));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_JPEG_TRUNCATED');
  });

  it('rejects a scan before any SOF with CAPTURE_JPEG_UNDECODABLE', () => {
    const segment = (marker: number, payload: Buffer): Buffer => {
      const out = Buffer.alloc(4 + payload.length);
      out[0] = 0xff;
      out[1] = marker;
      out.writeUInt16BE(payload.length + 2, 2);
      payload.copy(out, 4);
      return out;
    };
    const res = validateJpegBuffer(
      Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
        Buffer.from([0x00, 0xff, 0xd9]),
      ])
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_JPEG_UNDECODABLE');
  });

  it('rejects a SOF declaring zero dimensions with CAPTURE_JPEG_UNDECODABLE', () => {
    const res = validateJpegBuffer(makeJpeg(0, 0));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'CAPTURE_JPEG_UNDECODABLE');
  });
});

describe('rasterMatchesCss (scale gate)', () => {
  it('accepts an exact DPR x zoom scale', () => {
    assert.strictEqual(rasterMatchesCss({ width: 2400, height: 1600 }, { width: 1200, height: 800 }, 2, 1), true);
    assert.strictEqual(rasterMatchesCss({ width: 3000, height: 2000 }, { width: 1200, height: 800 }, 2, 1.25), true);
  });

  it('accepts a one-pixel per-axis rounding delta', () => {
    assert.strictEqual(rasterMatchesCss({ width: 2401, height: 1599 }, { width: 1200, height: 800 }, 2, 1), true);
  });

  it('rejects a delta beyond one pixel on either axis', () => {
    assert.strictEqual(rasterMatchesCss({ width: 2402, height: 1600 }, { width: 1200, height: 800 }, 2, 1), false);
    assert.strictEqual(rasterMatchesCss({ width: 2400, height: 1602 }, { width: 1200, height: 800 }, 2, 1), false);
  });

  it('rejects non-positive or non-finite inputs', () => {
    assert.strictEqual(rasterMatchesCss({ width: 2400, height: 1600 }, { width: 1200, height: 800 }, 0, 1), false);
    assert.strictEqual(rasterMatchesCss({ width: 2400, height: 1600 }, { width: 1200, height: 800 }, 2, 0), false);
    assert.strictEqual(rasterMatchesCss({ width: NaN, height: 1600 }, { width: 1200, height: 800 }, 2, 1), false);
    assert.strictEqual(rasterMatchesCss({ width: 2400, height: 1600 }, { width: 0, height: 800 }, 2, 1), false);
  });
});