import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import type { BrowserTarget } from '../../src/shared/control-plane-contracts';

// The surface probe reads innerWidth/innerHeight (RENDER_SURFACE_PROBE_EXPRESSION), so a
// zero reading means the bound tab's view has no bounds. These cases pin both halves of the
// recovery contract: a tab whose geometry this session verified is re-applied once and
// re-measured, and a tab that cannot be laid out refuses with the reason and the tabs the
// session may activate instead — never a silent false.
const BOUND_TAB = 'tab-bound';
const OTHER_TAB = 'tab-other';
const OFFSCREEN_TAB = 'tab-agent-offscreen';

const TARGET: BrowserTarget = {
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  runtimeId: 'rt-1',
  tabId: BOUND_TAB,
  browserEpoch: 1,
  documentGeneration: 1,
};

interface SurfaceSnapshot {
  vw: number;
  vh: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
  docH: number;
  readyState: string;
  hidden: boolean;
}

const sized = (width: number, height: number): SurfaceSnapshot => ({
  vw: width,
  vh: height,
  dpr: 1,
  scrollX: 0,
  scrollY: 0,
  docH: 2000,
  readyState: 'complete',
  hidden: false,
});

const zeroBounds: SurfaceSnapshot = sized(0, 0);

function sequenceProbe(values: SurfaceSnapshot[]): () => SurfaceSnapshot {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value ?? zeroBounds;
  };
}

function makeHost(options: {
  probe: () => SurfaceSnapshot;
  applied: unknown[];
  isTabOffscreen?: (tabId?: string) => boolean;
  switchTab?: () => boolean;
}): BrowserHostPort {
  const host = {
    getTabList: () => [{ id: BOUND_TAB }, { id: OTHER_TAB }],
    getSessionTabList: () => [{ id: BOUND_TAB }, { id: OTHER_TAB }],
    hasTab: () => true,
    readRenderSurface: async () => options.probe(),
    setViewportSize: (viewport: unknown) => {
      options.applied.push(viewport);
      return { success: true };
    },
    evalJs: async () => ({ ok: true }),
    isTabOffscreen: options.isTabOffscreen ?? (() => false),
    switchTab: options.switchTab ?? (() => true),
  };
  // Only the seams under test are modeled here; the rest of the host surface is unused.
  return host as unknown as BrowserHostPort;
}

describe('Render surface geometry recovery', () => {
  it('re-applies the verified geometry when the tab measures zero, then runs the operation', async () => {
    const applied: unknown[] = [];
    const port = new BrowserControlPort(
      makeHost({ probe: sequenceProbe([sized(1440, 900), zeroBounds, sized(1440, 900)]), applied })
    );

    const viewport = await port.setViewport({ width: 1440, height: 900, tabId: BOUND_TAB });
    assert.strictEqual(viewport.verified, true, 'the first geometry write must be measured before it counts');
    applied.length = 0;

    const result = await port.eval(TARGET, '1 + 1', BOUND_TAB, 'desktop', { requireRenderSurface: true });
    assert.deepStrictEqual(result, { ok: true }, 'the operation must run once the surface measures again');
    assert.deepStrictEqual(
      applied,
      [{ width: 1440, height: 900, mobile: false, tabId: BOUND_TAB }],
      'the only restorable geometry is the one this session verified'
    );
  });

  it('re-applies geometry at most once per refusal', async () => {
    const applied: unknown[] = [];
    let probeCount = 0;
    const probe = (): SurfaceSnapshot => {
      probeCount += 1;
      return probeCount === 1 ? sized(1440, 900) : zeroBounds;
    };
    const port = new BrowserControlPort(makeHost({ probe, applied }));

    await port.setViewport({ width: 1440, height: 900, tabId: BOUND_TAB });
    applied.length = 0;
    await assert.rejects(
      () => port.eval(TARGET, '1 + 1', BOUND_TAB, 'desktop', { requireRenderSurface: true }),
      (error: unknown) => error instanceof CapabilityError && error.code === 'NO_RENDER_SURFACE'
    );
    assert.strictEqual(applied.length, 1, 'a tab that stays unmeasurable must not be retried in a loop');
  });

  it('refuses a zero-bounds tab with the cause it measured and the tabs it may activate', async () => {
    const applied: unknown[] = [];
    const port = new BrowserControlPort(
      makeHost({ probe: () => zeroBounds, applied, isTabOffscreen: () => true })
    );

    await assert.rejects(
      () => port.eval(TARGET, '1 + 1', BOUND_TAB, 'desktop', { requireRenderSurface: true }),
      (error: unknown) => {
        assert.ok(error instanceof CapabilityError);
        assert.strictEqual(error.code, 'NO_RENDER_SURFACE');
        assert.strictEqual(error.details?.cause, 'zero-viewport', 'the probe measures bounds, not compositing');
        assert.strictEqual(error.details?.observedWidth, 0);
        assert.strictEqual(error.details?.offscreen, true);
        assert.deepStrictEqual(error.details?.activationCandidates, [OTHER_TAB]);
        assert.match(error.message, /renders offscreen/);
        return true;
      }
    );
    assert.deepStrictEqual(applied, [], 'no geometry may be written for a tab this session never sized');
  });
});

describe('Tab activation refusals', () => {
  it('refuses a tab that cannot become active instead of reporting switched: false', () => {
    const port = new BrowserControlPort(
      makeHost({
        probe: () => zeroBounds,
        applied: [],
        isTabOffscreen: (tabId?: string) => tabId === OFFSCREEN_TAB,
        switchTab: () => false,
      })
    );

    assert.throws(
      () => port.switchTab(OFFSCREEN_TAB, { target: TARGET, isAgent: true, attachmentId: 'att-1' }),
      (error: unknown) => {
        assert.ok(error instanceof CapabilityError);
        assert.strictEqual(error.code, 'TARGET_NOT_ACTIVATABLE');
        assert.strictEqual(error.details?.tabId, OFFSCREEN_TAB);
        assert.strictEqual(error.details?.offscreen, true);
        assert.match(error.message, /never shown in the window/);
        return true;
      }
    );
  });

  it('returns the activated tab when the switch happens', () => {
    const port = new BrowserControlPort(makeHost({ probe: () => sized(1440, 900), applied: [], switchTab: () => true }));
    assert.deepStrictEqual(port.switchTab(OTHER_TAB, { target: TARGET, isAgent: true }), { switched: true, tabId: OTHER_TAB });
  });
});
