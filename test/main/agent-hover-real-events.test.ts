import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { TabAutomationHost } from '../../src/main/browser/tab-automation-host';
import { BrowserActionRegistry } from '../../src/main/browser/browser-action-registry';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { SemanticRefRegistry } from '../../src/main/browser/semantic-ref-registry';

interface HoverResult {
  success: boolean;
  fallbackNeeded?: boolean;
  reason?: string;
  data?: { code?: string; hoverActive?: boolean; recovery?: string; x?: number; y?: number };
}

/**
 * Host whose isolated world answers the :hover reading from `readings` (one per read) and the
 * scroll-into-view script with a re-measured centre, recording every real mouse movement.
 */
function hoverHarness(readings: Array<boolean | 'unreadable'>) {
  const moves: Array<{ x: number; y: number }> = [];
  const isolated: string[] = [];
  let reads = 0;
  const wc = {
    id: 3,
    isDestroyed: () => false,
    debugger: { isAttached: () => true, attach: () => {} },
    executeJavaScript: async () => undefined,
  };
  const host = new TabAutomationHost({
    getActiveTabId: () => 'tab-1',
    getBrowserEpoch: () => 1,
    getSemanticDocumentGeneration: () => 1,
    semanticRefRegistry: new SemanticRefRegistry(),
    broadcastState: () => {},
    syncFrameBackdrop: () => {},
    tabDevToolsHost: {
      sendCdpCommand: async (_wc: unknown, method: string, params: { type?: string; x?: number; y?: number }) => {
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') moves.push({ x: params.x ?? NaN, y: params.y ?? NaN });
        return {};
      },
    },
  } as never);
  (host as unknown as { executeInIsolatedWorld: (w: unknown, script: string) => Promise<unknown> }).executeInIsolatedWorld = async (_wc, script) => {
    isolated.push(script);
    if (script.includes('scrollIntoView')) return { x: 300, y: 420, w: 100, h: 40 };
    const reading = readings[Math.min(reads, readings.length - 1)];
    reads += 1;
    if (reading === 'unreadable') throw new Error('isolated world unavailable');
    return reading;
  };
  const hover = (x: number, y: number, selector?: string): Promise<HoverResult> =>
    (host as unknown as { executeTrustedHover: (w: unknown, f?: string, x?: number, y?: number, s?: string) => Promise<HoverResult> })
      .executeTrustedHover(wc, undefined, x, y, selector);
  return { hover, moves, isolated };
}

describe('trusted hover uses real mouse movement until :hover is verified', () => {
  it('stops after one move when :hover is already active', async () => {
    const { hover, moves, isolated } = hoverHarness([true]);

    const result = await hover(140, 170, '#menu');

    assert.equal(result.success, true);
    assert.equal(result.data?.hoverActive, true);
    assert.equal(result.data?.recovery, undefined);
    assert.deepEqual(moves, [{ x: 140, y: 170 }]);
    assert.equal(isolated.some((s) => s.includes('scrollIntoView')), false);
  });

  it('scrolls the target into view and approaches its centre from a corner when the first move did not hover', async () => {
    const { hover, moves, isolated } = hoverHarness([false, true]);

    const result = await hover(140, 170, '#menu');

    assert.equal(result.success, true);
    assert.equal(result.data?.hoverActive, true);
    assert.equal(result.data?.recovery, 'scroll-into-view-and-approach');
    assert.equal(isolated.some((s) => s.includes('scrollIntoView')), true);
    assert.equal(moves.length, 4, 'the original move plus a corner, midpoint and centre approach');
    assert.deepEqual(moves[1], { x: 251, y: 401 }, 'the approach starts at the target corner re-measured after the scroll');
    assert.deepEqual(moves[3], { x: 300, y: 420 });
    assert.deepEqual({ x: result.data?.x, y: result.data?.y }, { x: 300, y: 420 });
  });

  it('fails with HOVER_NOT_ACTIVE and no synthetic fallback when the page never reports :hover', async () => {
    const { hover, moves } = hoverHarness([false]);

    const result = await hover(140, 170, '#menu');

    assert.equal(result.success, false);
    assert.equal(result.fallbackNeeded, false, 'a failed real hover must not be papered over by a synthetic one');
    assert.equal(result.data?.code, 'HOVER_NOT_ACTIVE');
    assert.equal(result.data?.hoverActive, false);
    assert.match(result.reason ?? '', /HOVER_NOT_ACTIVE/);
    assert.equal(moves.length, 4);
  });

  it('does not claim a verified hover when the reading itself is unavailable', async () => {
    const { hover, moves } = hoverHarness(['unreadable']);

    const result = await hover(140, 170);

    assert.equal(result.success, true);
    assert.equal(result.data?.hoverActive, false);
    assert.equal(result.data?.code, undefined);
    assert.equal(moves.length, 1, 'an unreadable verification is not evidence of a failed hover, so no retry choreography runs');
  });
});

describe('agentHover action', () => {
  it('surfaces HOVER_NOT_ACTIVE as a typed capability error', async () => {
    const registry = new BrowserActionRegistry({
      dispatchAgentAction: async () => ({
        success: false,
        reason: 'HOVER_NOT_ACTIVE: CSS :hover is still inactive',
        data: { code: 'HOVER_NOT_ACTIVE', x: 12, y: 34, recovery: 'scroll-into-view-and-approach', executionTier: 'cdp_trusted' },
      }),
    } as never);

    await assert.rejects(
      () => registry.execute('agentHover', { selector: '#menu' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'HOVER_NOT_ACTIVE' && /still inactive/.test(err.message)
    );
  });
});
