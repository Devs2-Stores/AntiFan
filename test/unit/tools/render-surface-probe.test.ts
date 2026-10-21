import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget } from '../../../src/shared/control-plane-contracts';

const target: BrowserTarget = {
  projectId: 'proj',
  workspaceId: 'ws',
  runtimeId: 'rt',
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

const surface = { vw: 1280, vh: 720, dpr: 1, scrollX: 0, scrollY: 0, docH: 2000, readyState: 'complete', hidden: false };

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function makePort(probe: (call: number) => Promise<unknown>): { port: BrowserControlPort; probeCalls: () => number; evals: () => number } {
  let probeCalls = 0;
  let evals = 0;
  const host = {
    hasTab: (id: string) => id === 'tab-1',
    getTabList: () => [{ id: 'tab-1' }],
    getDocumentGeneration: () => 1,
    readRenderSurface: async () => probe(++probeCalls),
    evalJs: async () => {
      evals++;
      return 'ran';
    },
  } as unknown as BrowserHostPort;
  return { port: new BrowserControlPort(host), probeCalls: () => probeCalls, evals: () => evals };
}

describe('render surface probe failures say whether the surface is absent or the probe was slow', () => {
  it('retries a timed-out probe once and proceeds when the second answers', async () => {
    const { port, probeCalls, evals } = makePort(async (call) => {
      if (call === 1) throw codedError('CAPTURE_TIMEOUT', 'Render-surface probe on tab timed out after 3000ms');
      return surface;
    });
    const result = await port.eval(target, '1', undefined, undefined, { requireRenderSurface: true });
    assert.equal(result, 'ran');
    assert.equal(probeCalls(), 2);
    assert.equal(evals(), 1);
  });

  it('reports PROBE_TIMEOUT as retryable after the probe times out twice', async () => {
    const { port, probeCalls, evals } = makePort(async () => {
      throw codedError('CAPTURE_TIMEOUT', 'Render-surface probe on tab timed out after 3000ms');
    });
    await assert.rejects(
      port.eval(target, '1', undefined, undefined, { requireRenderSurface: true }),
      (err: unknown) => err instanceof CapabilityError
        && err.code === 'NO_RENDER_SURFACE'
        && err.details?.cause === 'PROBE_TIMEOUT'
        && err.details?.retryable === true
    );
    assert.equal(probeCalls(), 2, 'a timeout is retried exactly once');
    assert.equal(evals(), 0);
  });

  it('reports PROBE_TIMEOUT when the retry is refused because the first probe still drains', async () => {
    const { port, probeCalls, evals } = makePort(async (call) => {
      if (call === 1) throw codedError('CAPTURE_TIMEOUT', 'Render-surface probe on tab timed out after 3000ms');
      throw codedError('TARGET_BUSY_DRAINING', 'Cannot admit CDP command Runtime.evaluate; target 25 is draining timed-out command Runtime.evaluate');
    });
    await assert.rejects(
      port.eval(target, '1', undefined, undefined, { requireRenderSurface: true }),
      (err: unknown) => err instanceof CapabilityError
        && err.code === 'NO_RENDER_SURFACE'
        && err.details?.cause === 'PROBE_TIMEOUT'
        && err.details?.retryable === true
    );
    assert.equal(probeCalls(), 2);
    assert.equal(evals(), 0);
  });

  it('reports ABSENT_SURFACE as not retryable and does not retry a probe that answered', async () => {
    const { port, probeCalls } = makePort(async () => {
      throw codedError('NO_RENDER_SURFACE', 'Render-surface probe returned no geometry (undefined); the tab\'s layout surface cannot be measured');
    });
    await assert.rejects(
      port.eval(target, '1', undefined, undefined, { requireRenderSurface: true }),
      (err: unknown) => err instanceof CapabilityError
        && err.code === 'NO_RENDER_SURFACE'
        && err.details?.cause === 'ABSENT_SURFACE'
        && err.details?.retryable === false
    );
    assert.equal(probeCalls(), 1);
  });

  it('reports a probe that could not run at all as ABSENT_SURFACE', async () => {
    const { port } = makePort(async () => {
      throw codedError('TAB_NOT_ATTACHED', "Tab 'tab-1' has no attached WebContents to measure");
    });
    await assert.rejects(
      port.eval(target, '1', undefined, undefined, { requireRenderSurface: true }),
      (err: unknown) => err instanceof CapabilityError
        && err.code === 'NO_RENDER_SURFACE'
        && err.details?.cause === 'ABSENT_SURFACE'
    );
  });

  it('lets a draining target through unchanged', async () => {
    const { port } = makePort(async () => {
      throw codedError('TARGET_BUSY_DRAINING', 'target is draining');
    });
    await assert.rejects(
      port.eval(target, '1', undefined, undefined, { requireRenderSurface: true }),
      (err: unknown) => (err as { code?: string }).code === 'TARGET_BUSY_DRAINING'
    );
  });

  it('still runs a degraded-surface evaluation after the probe fails', async () => {
    const { port, evals } = makePort(async () => {
      throw codedError('CAPTURE_TIMEOUT', 'Render-surface probe on tab timed out after 3000ms');
    });
    const result = await port.eval(target, '1', undefined, undefined, { requireRenderSurface: true, allowDegradedSurface: true });
    assert.equal(result, 'ran');
    assert.equal(evals(), 1);
  });
});

describe('getViewport keeps the probe failure code the host classified', () => {
  it('reports TAB_NOT_ATTACHED for a tab with no attached web contents', async () => {
    const { port, probeCalls } = makePort(async () => {
      throw new CapabilityError('TAB_NOT_ATTACHED', "Tab 'tab-1' has no attached WebContents to measure", { tabId: 'tab-1' });
    });
    const viewport = await port.getViewport({}, target);
    assert.equal(viewport.width, 0);
    assert.equal(viewport.probeError?.code, 'TAB_NOT_ATTACHED');
    assert.equal(probeCalls(), 1, 'a probe that could not run is not retried');
  });

  it('falls back to PROBE_FAILED only when the failure carries no code', async () => {
    const { port } = makePort(async () => {
      throw 'boom';
    });
    const viewport = await port.getViewport({}, target);
    assert.equal(viewport.probeError?.code, 'PROBE_FAILED');
  });

  it('retries a timed-out probe once and reports the second answer', async () => {
    const { port, probeCalls } = makePort(async (call) => {
      if (call === 1) throw codedError('CAPTURE_TIMEOUT', 'Render-surface probe on tab timed out after 3000ms');
      return surface;
    });
    const viewport = await port.getViewport({}, target);
    assert.equal(viewport.width, 1280);
    assert.equal(probeCalls(), 2);
    assert.equal(viewport.probeError, undefined);
  });
});
