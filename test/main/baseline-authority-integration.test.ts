import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BrowserControlPort, computePixelDiff } from '../../src/main/tools/browser-control-port';
import {
  BrowserTarget,
  CapabilityError,
  CapabilityRequestContext,
  RuntimeLease,
  issueRuntimeLease,
  makeControlPlaneId,
} from '../../src/shared/control-plane-contracts';
import { ArtifactStore } from '../../src/main/tools/artifact-store';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { VisualBaselineRef } from '../../src/main/verification/baseline-authority';

function createTestPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  buf[4] = 0x0d;
  buf[5] = 0x0a;
  buf[6] = 0x1a;
  buf[7] = 0x0a;
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 2;
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  buf.writeUInt32BE(0, 29);
  return buf;
}

const defaultProjectId = makeControlPlaneId('project');
const defaultWorkspaceId = makeControlPlaneId('workspace');
const defaultLease = issueRuntimeLease(defaultProjectId, defaultWorkspaceId, 60_000, 1);

// visual_compare asserts route identity: without an expected URL a comparison settles
// INCONCLUSIVE (URL_EXPECTATION_MISSING) instead of diffing, so tests that assert a diff must
// declare the route their fixture tabs report.
const ROUTE_URL = 'https://store.example.com/product';

function createTestContext(opts: {
  workspaceId?: string;
  projectId?: string;
  runId?: string;
  attemptId?: string;
  target?: BrowserTarget;
  lease?: RuntimeLease;
} = {}): CapabilityRequestContext {
  const workspaceId = opts.workspaceId !== undefined ? opts.workspaceId : defaultWorkspaceId;
  const projectId = opts.projectId !== undefined ? opts.projectId : defaultProjectId;
  const lease = opts.lease || defaultLease;
  const target: BrowserTarget = opts.target || {
    tabId: 'tab-a',
    workspaceId,
    projectId,
    runtimeId: lease.runtimeId,
    browserEpoch: 1,
    documentGeneration: 1,
  };
  return {
    lease,
    leaseToken: lease.token,
    projectId,
    workspaceId,
    runId: opts.runId || 'test-run',
    attemptId: opts.attemptId || 'test-att',
    browserTarget: target,
    grant: 'write',
  };
}

describe('BaselineAuthority (Integration & Capability Dispatch)', () => {
  let tmpDir: string;
  let artifactStore: ArtifactStore;
  let originalElectronEntry: unknown;
  const bitmapByBuffer = new WeakMap<Buffer, Buffer>();

  before(() => {
    // Stub electron nativeImage in node test environment
    const electronPath = require.resolve('electron');
    originalElectronEntry = require.cache[electronPath];
    require.cache[electronPath] = {
      id: electronPath,
      filename: electronPath,
      loaded: true,
      exports: {
        nativeImage: {
          createFromBuffer: (buf: Buffer) => ({
            getSize: () => {
              if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
                return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
              }
              return { width: 800, height: 600 };
            },
            isEmpty: () => false,
            getBitmap: () => bitmapByBuffer.get(buf) ?? Buffer.alloc(800 * 600 * 4),
          }),
        },
      },
    } as any;
  });

  after(() => {
    const electronPath = require.resolve('electron');
    if (originalElectronEntry) {
      require.cache[electronPath] = originalElectronEntry as any;
    } else {
      delete require.cache[electronPath];
    }
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-baseline-integ-'));
    artifactStore = new ArtifactStore({ root: path.join(tmpDir, 'artifacts') });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function buildMockHarness(opts: {
    dpr?: number;
    backend?: string;
    viewport?: { width: number; height: number };
    evalLog?: Array<{ script: string; tabId?: string }>;
  } = {}) {
    const evalLog = opts.evalLog || [];
    const testPng = createTestPng(800, 600);
    const host = {
      evalLog,
      hasTab: () => true,
      getTabList: () => [{ id: 'tab-a' }, { id: 'tab-b' }],
      getTabUrl: (_tabId?: string) => ROUTE_URL,
      getNetworkTracker: () => ({
        isAttached: () => true,
        isSettled: () => true,
        hasTimedOut: () => false,
        inflightCount: () => 0,
        unsettledUrls: () => [],
        awaitQuiescence: async () => ({ settled: true, timedOut: false, durationMs: 0 }),
      }),
      evalJs: async (script: string, tabId?: string) => {
        evalLog.push({ script, tabId });
        if (script.includes('__antifan_compare_txn__')) {
          // Reversible normalization transaction: a static fixture records no
          // mutations and restores cleanly.
          return script.includes('alreadyRestored')
            ? { restored: true, alreadyRestored: true, failed: 0 }
            : { applied: true, alreadyApplied: true, recorded: 0 };
        }
        if (script.includes('el.remove')) return true;
        if (script.includes('__antifan_normalize_scroll')) return true;
        if (script.includes('document.fonts.ready')) return true;
        if (script.includes('img.decode')) return { settled: true, brokenImages: [] };
        if (script.includes('requestAnimationFrame')) return true;
        if (script.includes('innerWidth')) return { vw: 800, vh: 600, dh: 600, sx: 0, sy: 0 };
        if (script.includes('querySelectorAll')) return [];
        return null;
      },
      getDocumentGeneration: () => 1,
      getMutationRevision: () => 1,
      captureVerificationScreenshot: async () => ({
        data: testPng.toString('base64'),
        backend: opts.backend || 'cdp',
        dpr: opts.dpr ?? 1,
        zoom: 1,
        cssViewport: opts.viewport || { width: 800, height: 600 },
        cssCaptureSize: opts.viewport || { width: 800, height: 600 },
        rasterSize: { width: 800, height: 600 },
        captureMode: 'viewport',
        timestamp: Date.now(),
      }),
    };

    const port = new BrowserControlPort(host as any, artifactStore as any);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId: defaultProjectId,
      workspaceId: defaultWorkspaceId,
      runtimeId: defaultLease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => defaultLease,
    });
    registerBrowserCapabilities(catalogue, port as any);
    return { host, port, catalogue, evalLog };
  }

  describe('Entry Gate Source Exclusivity (Advisory)', () => {
    it('rejects with INVALID_ARGUMENT when 0 baseline sources are provided', async () => {
      const { catalogue } = buildMockHarness();
      const ctx = createTestContext();

      await assert.rejects(
        async () => catalogue.dispatch('browser.visual_compare', {}, ctx),
        (err: any) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.message.includes('Exactly one baseline source')
      );
    });

    it('rejects with INVALID_ARGUMENT when conflicting baseline sources are provided', async () => {
      const { catalogue } = buildMockHarness();
      const ctx = createTestContext();

      // baselineRef + comparisonTabId
      await assert.rejects(
        async () => catalogue.dispatch('browser.visual_compare', { baselineRef: 'vbase_1', comparisonTabId: 'tab-b' }, ctx),
        (err: any) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.message.includes('Conflicting baseline sources')
      );

      // baselineRef + baselineScreenshotRef
      await assert.rejects(
        async () => catalogue.dispatch('browser.visual_compare', { baselineRef: 'vbase_1', baselineScreenshotRef: 'art-1' }, ctx),
        (err: any) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.message.includes('Conflicting baseline sources')
      );
      // baselineScreenshotRef + comparisonTabId
      await assert.rejects(
        async () => catalogue.dispatch('browser.visual_compare', { baselineScreenshotRef: 'art-1', comparisonTabId: 'tab-b' }, ctx),
        (err: any) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.message.includes('Conflicting baseline sources')
      );
    });

    it('fails closed with WORKSPACE_UNBOUND when baselineRef is provided without workspace context', async () => {
      const { port } = buildMockHarness();
      const ctx = createTestContext();
      (ctx.browserTarget as any).workspaceId = '';

      await assert.rejects(
        async () => port.visualCompare(ctx.browserTarget!, 'run-test', 'att-test', { baselineRef: 'vbase_1' }),
        (err: any) => err instanceof CapabilityError && err.code === 'WORKSPACE_UNBOUND'
      );
    });
  });

  describe('Production Promotion Capability Dispatch (V-22, R1, R2)', () => {
    it('canonically captures, stages, and promotes via browser.promote-baseline and compares successfully', async () => {
      const { catalogue } = buildMockHarness();
      const ctxAttemptA = createTestContext({
        runId: 'run-promote-a',
        attemptId: 'att-1',
      });

      // 1. Dispatch promotion capability through catalogue
      const baseRef = (await catalogue.dispatch('browser.promote-baseline', {
        tabId: 'tab-a',
      }, ctxAttemptA)) as VisualBaselineRef;

      assert.ok(baseRef.id.startsWith('vbase_'));
      assert.equal(baseRef.captureStateMini.backend, 'cdp');
      assert.equal(baseRef.captureStateMini.dpr, 1);
      assert.deepEqual(baseRef.captureStateMini.rasterSize, { width: 800, height: 600 });
      assert.ok(fs.existsSync(baseRef.path), 'Promoted PNG exists on disk');
      assert.equal(baseRef.workspaceId, defaultWorkspaceId);
      assert.equal(baseRef.projectId, defaultProjectId);
      const ctxAttemptB = createTestContext({
        runId: 'run-compare-b',
        attemptId: 'att-2',
      });

      const res = (await catalogue.dispatch('browser.visual_compare', {
        baselineRef: baseRef.id,
        expectedTargetUrl: ROUTE_URL,
        expectedBaselineUrl: ROUTE_URL,
      }, ctxAttemptB)) as any;

      assert.equal(res.match, true);
      assert.equal(res.diffPixels, 0);
      assert.equal(res.captureStateCompatible, true);
      assert.equal(res.receipt.match, true);
    });

    it('supports alias anti.visual.promote_baseline', async () => {
      const { catalogue } = buildMockHarness();
      const ctx = createTestContext({
        runId: 'run-alias',
        attemptId: 'att-1',
      });

      const baseRef = (await catalogue.dispatch('anti.visual.promote_baseline', {}, ctx)) as VisualBaselineRef;
      assert.ok(baseRef.id.startsWith('vbase_'));
      assert.equal(baseRef.workspaceId, defaultWorkspaceId);
    });

    it('fails closed with BASELINE_TAMPERED if promoted baseline image is modified on disk', async () => {
      const { catalogue } = buildMockHarness();
      const ctx = createTestContext({
        runId: 'run-tamper',
        attemptId: 'att-1',
      });

      const baseRef = (await catalogue.dispatch('browser.promote-baseline', {}, ctx)) as VisualBaselineRef;

      // Tamper with baseline file on disk
      const bytes = fs.readFileSync(baseRef.path);
      bytes[16] = ((bytes[16] ?? 0) + 1) % 256;
      fs.writeFileSync(baseRef.path, bytes);

      await assert.rejects(
        async () => catalogue.dispatch('browser.visual_compare', { baselineRef: baseRef.id }, ctx),
        (err: any) => err instanceof CapabilityError && err.code === 'BASELINE_TAMPERED'
      );
    });
  });

  describe('Capture State Compatibility with Promoted Baselines (R3)', () => {
    it('returns INCONCLUSIVE with metricSamples when DPR mismatches', async () => {
      // Step 1: Promote baseline under DPR=1
      const harnessA = buildMockHarness({ dpr: 1 });
      const ctxA = createTestContext({
        runId: 'run-compat-a',
        attemptId: 'att-1',
      });
      const baseRef = (await harnessA.catalogue.dispatch('browser.promote-baseline', {}, ctxA)) as VisualBaselineRef;

      // Step 2: Compare target with DPR=2 using the same authority storage root
      const harnessB = buildMockHarness({ dpr: 2 });
      // Point harnessB to the same baselines root so it can resolve the baseline
      (harnessB.port as any).baselineAuthority = harnessA.port.baselineAuthority;

      const ctxB = createTestContext({
        runId: 'run-compat-b',
        attemptId: 'att-2',
      });

      const res = (await harnessB.catalogue.dispatch('browser.visual_compare', {
        baselineRef: baseRef.id,
      }, ctxB)) as any;

      assert.equal(res.ok, false);
      assert.equal(res.status, 'INCONCLUSIVE');
      assert.match(res.reason as string, /Device pixel ratio mismatch/);
      assert.equal(res.captureStateCompatible, false);
      assert.ok(Array.isArray(res.metricSamples));
    });

    it('throws CAPTURE_BACKEND_SWITCH when capture backend changes between baseline and target', async () => {
      // Step 1: Promote baseline under CDP
      const harnessA = buildMockHarness({ backend: 'cdp' });
      const ctxA = createTestContext({
        runId: 'run-backend-a',
        attemptId: 'att-1',
      });
      const baseRef = (await harnessA.catalogue.dispatch('browser.promote-baseline', {}, ctxA)) as VisualBaselineRef;

      // Step 2: Compare target under legacy-screen
      const harnessB = buildMockHarness({ backend: 'legacy-screen' });
      (harnessB.port as any).baselineAuthority = harnessA.port.baselineAuthority;

      const ctxB = createTestContext({
        runId: 'run-backend-b',
        attemptId: 'att-2',
      });

      await assert.rejects(
        async () => harnessB.catalogue.dispatch('browser.visual_compare', { baselineRef: baseRef.id }, ctxB),
        (err: any) => err instanceof CapabilityError && err.code === 'CAPTURE_BACKEND_SWITCH'
      );
    });
  });

  describe('3-Run Static Fixture Determinism (V-24)', () => {
    it('produces identical receipts, identical verdicts, and zero leftover styles across 3 runs', async () => {
      const evalLog: Array<{ script: string; tabId?: string }> = [];
      const { catalogue } = buildMockHarness({ evalLog });
      const ctxInit = createTestContext({
        runId: 'run-det-init',
        attemptId: 'att-1',
      });

      const baseRef = (await catalogue.dispatch('browser.promote-baseline', {}, ctxInit)) as VisualBaselineRef;

      const results: any[] = [];
      for (let run = 1; run <= 3; run++) {
        const ctxRun = createTestContext({
          runId: `run-det-${run}`,
          attemptId: 'att-1',
        });
        const res = (await catalogue.dispatch('browser.visual_compare', {
          baselineRef: baseRef.id,
          expectedTargetUrl: ROUTE_URL,
          expectedBaselineUrl: ROUTE_URL,
          normalizeScroll: true,
        }, ctxRun)) as any;
        results.push(res);
      }

      // 1. Identical verdicts across all 3 runs
      for (const res of results) {
        assert.equal(res.match, true);
        assert.equal(res.diffPixels, 0);
        assert.equal(res.mismatchPercentage, 0);
        assert.equal(res.captureStateCompatible, true);
        assert.equal(res.receipt.match, true);
      }

      // 2. Receipt structural invariance
      assert.deepEqual(results[0].receipt.dimensionsMatch, results[1].receipt.dimensionsMatch);
      assert.deepEqual(results[1].receipt.dimensionsMatch, results[2].receipt.dimensionsMatch);
      assert.deepEqual(results[0].receipt.match, results[1].receipt.match);
      assert.deepEqual(results[1].receipt.match, results[2].receipt.match);

      // 3. Zero leftover styles: every normalization inject has a corresponding removal
      const removes = evalLog.filter(e => e.script.includes('__antifan_normalize_scroll') && e.script.includes('el.remove()'));
      const injects = evalLog.filter(e => e.script.includes('appendChild'));
      assert.equal(injects.length, 3, 'Exactly 3 normalization injections across 3 runs');
      assert.equal(removes.length, 3, 'Exactly 3 normalization removals across 3 runs (0 leftover styles)');
    });
  });
});
