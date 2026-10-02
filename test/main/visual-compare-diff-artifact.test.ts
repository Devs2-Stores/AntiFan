import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, BrowserHostPort, BrowserArtifactSink, BrowserArtifactStageInput } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, ArtifactRef } from '../../src/shared/control-plane-contracts';
import type { VerificationCaptureEnvelope } from '../../src/main/verification/visual-capture';

// Minimal valid-PNG-shaped buffer carrying a marker byte at offset 32 so two
// rasters can differ at the same size.
function createTestPng(width: number, height: number, marker = 0): Buffer {
  const buf = Buffer.alloc(33);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; buf[25] = 2; buf[26] = 0; buf[27] = 0; buf[28] = 0;
  buf.writeUInt32BE(0, 29);
  buf[32] = marker;
  return buf;
}

const ROUTE_URL = 'https://store.example.com/product';
const DIMS = { width: 96, height: 64 };

interface StagedRow {
  id: string;
  kind: string;
  mime: string;
  byteLength: number;
  runId: string;
  attemptId: string;
  maxBytes?: number;
  data: Buffer;
}

interface RecordingSink {
  sink: BrowserArtifactSink;
  staged: StagedRow[];
}

function buildArtifactSink(): RecordingSink {
  const staged: StagedRow[] = [];
  let seq = 0;
  const sink: BrowserArtifactSink = {
    stage: (input: BrowserArtifactStageInput) => {
      seq += 1;
      const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(String(input.data), 'base64');
      staged.push({
        id: `art-${seq}`,
        kind: input.kind,
        mime: input.mime,
        byteLength: data.length,
        runId: input.runId,
        attemptId: input.attemptId,
        maxBytes: input.maxBytes,
        data,
      });
      const ref: ArtifactRef = {
        id: `art-${seq}`,
        kind: input.kind,
        mime: input.mime,
        byteLength: data.length,
        sha256: `sha256-${seq}`,
        runId: input.runId,
        attemptId: input.attemptId,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        path: '',
        truncated: false,
        redacted: false,
        createdAt: Date.now(),
      };
      return ref;
    },
  };
  return { sink, staged };
}

// The fake decoder derives a bitmap from the PNG buffer itself, so the diff
// below exercises the real per-pixel path rather than a canned verdict.
const bitmapByBuffer = new WeakMap<Buffer, Buffer>();
let createFromBitmapEnabled = true;
const DIFF_PNG_SENTINEL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x44, 0x49, 0x46, 0x46]);

const fakeNativeImageFactory = () => ({
  nativeImage: {
    createFromBuffer: (buf: Buffer) => {
      let width = DIMS.width;
      let height = DIMS.height;
      if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
        width = buf.readUInt32BE(16);
        height = buf.readUInt32BE(20);
      }
      return {
        getSize: () => (buf.length === 0 ? { width: 0, height: 0 } : { width, height }),
        isEmpty: () => buf.length === 0,
        getBitmap: () => {
          if (buf.length === 0) return null;
          const existing = bitmapByBuffer.get(buf);
          if (existing) return existing;
          const bitmap = Buffer.alloc(width * height * 4, 0xff);
          // The marker byte lands in the first pixel's channel so two PNGs
          // that differ there produce a real per-pixel mismatch.
          bitmap[0] = buf[32] ?? 0;
          bitmapByBuffer.set(buf, bitmap);
          return bitmap;
        },
      };
    },
    createFromBitmap: (bitmap: Buffer, _opts: { width: number; height: number }) => {
      if (!createFromBitmapEnabled) {
        return { isEmpty: () => true, toPNG: () => Buffer.alloc(0) };
      }
      return {
        isEmpty: () => bitmap.length === 0,
        // The encoder is stubbed, but the byte payload the caller receives is
        // the real overlay bitmap it was handed — length proves it ran.
        toPNG: () => Buffer.concat([DIFF_PNG_SENTINEL, Buffer.from(bitmap)]),
      };
    },
  },
});

const electronResolved = require.resolve('electron');
let electronEntry: NodeModule | undefined = require.cache[electronResolved];
let electronExportsBackup: unknown;

before(() => {
  if (!electronEntry) {
    require(electronResolved);
    electronEntry = require.cache[electronResolved];
  }
  if (electronEntry) {
    electronExportsBackup = electronEntry.exports;
    electronEntry.exports = fakeNativeImageFactory();
  }
});

after(() => {
  if (electronEntry && electronExportsBackup !== undefined) {
    electronEntry.exports = electronExportsBackup;
  }
});

const target: BrowserTarget = {
  tabId: 'tab-a',
  documentGeneration: 1,
  projectId: 'test-proj',
  workspaceId: 'test-ws',
  runtimeId: 'test-rt',
  browserEpoch: 1,
};

function buildHost(pngByTab: Record<string, Buffer>): BrowserHostPort {
  const envelope = async (tabId: string | undefined): Promise<VerificationCaptureEnvelope> => {
    const png = pngByTab[tabId || 'tab-a'] || pngByTab['tab-a']!;
    return {
      data: png.toString('base64'),
      backend: 'cdp',
      dpr: 1,
      zoom: 1,
      cssViewport: DIMS,
      cssCaptureSize: DIMS,
      rasterSize: DIMS,
      captureMode: 'viewport',
      timestamp: Date.now(),
    };
  };
  return {
    hasTab: () => true,
    getTabList: () => [{ id: 'tab-a' }, { id: 'tab-b' }],
    getTabUrl: () => ROUTE_URL,
    navigate: async () => true,
    reload: async () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async (_rect: unknown, tabId?: string) => (await envelope(tabId)).data,
    evalJs: async (script: string): Promise<unknown> => {
      if (script.includes('__antifan_compare_txn__')) {
        return script.includes('alreadyRestored')
          ? { restored: true, alreadyRestored: true, failed: 0 }
          : { applied: true, alreadyApplied: true, recorded: 0 };
      }
      if (script.includes('document.fonts.ready')) return true;
      if (script.includes('img.decode')) return { settled: true, brokenImages: [] };
      if (script.includes('requestAnimationFrame')) return true;
      if (script.includes('innerWidth')) return { vw: DIMS.width, vh: DIMS.height, dh: DIMS.height, sx: 0, sy: 0 };
      if (script.includes('r.width <= 0')) return { x: 0, y: 0, width: DIMS.width, height: DIMS.height };
      if (script.includes('root.children')) return [];
      if (script.includes('const selectors =')) return [];
      return null;
    },
    captureVerificationScreenshot: async (_rect: unknown, tabId?: string) => envelope(tabId),
    getBrowserEpoch: () => 1,
    getDocumentGeneration: () => 1,
    getMutationRevision: () => 1,
    isTargetDraining: () => false,
    drainTarget: async () => ({ ok: false, drained: false, resetPerformed: false, elapsedMs: 0 }),
    getNetworkTracker: () => ({
      isAttached: () => true,
      awaitQuiescence: async () => ({ settled: true, durationMs: 10, timedOut: false }),
    }),
  };
}

// visual_compare asserts route identity: an undeclared route settles
// INCONCLUSIVE instead of diffing, so every comparison declares the URL the
// mock tabs report — an assertion can only pass when the diff actually ran.
function createRoutePort(host: BrowserHostPort, sink?: BrowserArtifactSink): BrowserControlPort {
  const port = new BrowserControlPort(host, sink);
  const baseVisualCompare = port.visualCompare.bind(port);
  port.visualCompare = ((t: BrowserTarget, runId: string, attemptId: string, params: Record<string, unknown> = {}) =>
    baseVisualCompare(t, runId, attemptId, {
      expectedTargetUrl: ROUTE_URL,
      expectedBaselineUrl: ROUTE_URL,
      ...params,
    })) as typeof port.visualCompare;
  return port;
}

describe('visual.compare diff overlay evidence', () => {
  it('FAIL verdict stages a PNG diff overlay and names it diffArtifactId on the receipt', async () => {
    createFromBitmapEnabled = true;
    const host = buildHost({ 'tab-a': createTestPng(DIMS.width, DIMS.height, 0), 'tab-b': createTestPng(DIMS.width, DIMS.height, 255) });
    const { sink, staged } = buildArtifactSink();
    const port = createRoutePort(host, sink);

    const result = await port.visualCompare(target, 'run-diff-1', 'att-diff-1', {
      comparisonTabId: 'tab-b',
      tolerance: 0,
      useDefaultWidgetMasks: false,
    });

    assert.strictEqual(result.status, 'FAIL');
    assert.strictEqual(result.match, false);
    assert.strictEqual(typeof result.diffPixels === 'number' && result.diffPixels > 0, true, 'marker byte must produce a real pixel diff');
    assert.ok(result.diffArtifactId, 'FAIL must carry the staged overlay id');

    const overlay = staged.find((s) => s.id === result.diffArtifactId);
    assert.ok(overlay, 'overlay must be staged through the artifact sink');
    assert.strictEqual(overlay.kind, 'screenshot');
    assert.strictEqual(overlay.mime, 'image/png');
    assert.strictEqual(overlay.runId, 'run-diff-1');
    assert.strictEqual(overlay.attemptId, 'att-diff-1');
    // The payload is the encoder output: sentinel + overlay bitmap bytes.
    assert.ok(overlay.data.slice(0, DIFF_PNG_SENTINEL.length).equals(DIFF_PNG_SENTINEL), 'overlay payload must come from the bitmap encoder');
    assert.strictEqual(overlay.data.length, DIFF_PNG_SENTINEL.length + DIMS.width * DIMS.height * 4);

    // The receipt mirrors the id so consumers can resolve the evidence.
    const receipt = result.receipt;
    assert.ok(receipt !== null && typeof receipt === 'object' && 'diffArtifactId' in receipt);
    assert.strictEqual(receipt.diffArtifactId, result.diffArtifactId);
  });

  it('PASS verdict carries no diffArtifactId and stages no overlay', async () => {
    createFromBitmapEnabled = true;
    const identical = createTestPng(DIMS.width, DIMS.height, 7);
    const host = buildHost({ 'tab-a': identical, 'tab-b': identical });
    const { sink, staged } = buildArtifactSink();
    const port = createRoutePort(host, sink);

    const result = await port.visualCompare(target, 'run-ok-1', 'att-ok-1', {
      comparisonTabId: 'tab-b',
      tolerance: 0,
      useDefaultWidgetMasks: false,
    });

    assert.strictEqual(result.match, true);
    assert.strictEqual(result.diffArtifactId, undefined);
    const receipt = result.receipt;
    assert.ok(receipt === null || typeof receipt !== 'object' || !('diffArtifactId' in receipt), 'receipt must not name a diff artifact');
    // No overlay payload: nothing produced a diff raster to stage.
    const overlayRows = staged.filter((s) => s.data.slice(0, DIFF_PNG_SENTINEL.length).equals(DIFF_PNG_SENTINEL));
    assert.strictEqual(overlayRows.length, 0);
  });

  it('missing encoder never revokes a measured FAIL: verdict stands without diffArtifactId', async () => {
    createFromBitmapEnabled = false;
    try {
      const host = buildHost({ 'tab-a': createTestPng(DIMS.width, DIMS.height, 0), 'tab-b': createTestPng(DIMS.width, DIMS.height, 255) });
      const { sink, staged } = buildArtifactSink();
      const port = createRoutePort(host, sink);

      const result = await port.visualCompare(target, 'run-diff-2', 'att-diff-2', {
        comparisonTabId: 'tab-b',
        tolerance: 0,
        useDefaultWidgetMasks: false,
      });

      assert.strictEqual(result.status, 'FAIL');
      assert.strictEqual(result.match, false);
      assert.strictEqual(typeof result.diffPixels === 'number' && result.diffPixels > 0, true);
      assert.strictEqual(result.diffArtifactId, undefined);
      const receipt = result.receipt;
      assert.ok(receipt === null || typeof receipt !== 'object' || !('diffArtifactId' in receipt));
      const overlayRows = staged.filter((s) => s.data.slice(0, DIFF_PNG_SENTINEL.length).equals(DIFF_PNG_SENTINEL));
      assert.strictEqual(overlayRows.length, 0);
    } finally {
      createFromBitmapEnabled = true;
    }
  });
});
