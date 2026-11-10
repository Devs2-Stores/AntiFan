import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { TabAutomationHost } from '../../src/main/browser/tab-automation-host';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget } from '../../src/shared/control-plane-contracts';
import { SemanticRefRegistry } from '../../src/main/browser/semantic-ref-registry';

interface ClickResult {
  success: boolean;
  fallbackNeeded?: boolean;
  reason?: string;
  executionTier?: string;
  data?: { code?: string; recovery?: string; x?: number; y?: number };
}

/** What the isolated world answers to the delivery probe: the arm script, then each read. */
type ProbeAnswers = { arm: unknown; reads: unknown[] };

function clickHarness({ arm, reads }: ProbeAnswers) {
  const mouse: string[] = [];
  const scripts: string[] = [];
  let readIndex = 0;
  const wc = {
    id: 7,
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
      sendCdpCommand: async (_wc: unknown, method: string, params: { type?: string }) => {
        if (method === 'Input.dispatchMouseEvent') mouse.push(params.type ?? '');
        return {};
      },
    },
  } as never);
  (host as unknown as { executeInIsolatedWorld: (w: unknown, script: string) => Promise<unknown> }).executeInIsolatedWorld = async (_wc, script) => {
    scripts.push(script);
    if (script.includes('addEventListener')) return arm;
    const answer = reads[Math.min(readIndex, reads.length - 1)];
    readIndex += 1;
    if (answer === 'unreadable') throw new Error('isolated world unavailable');
    return answer;
  };
  const click = (x: number, y: number): Promise<ClickResult> =>
    (host as unknown as { executeTrustedClick: (w: unknown, f?: string, x?: number, y?: number) => Promise<ClickResult> })
      .executeTrustedClick(wc, undefined, x, y);
  return { click, mouse, scripts };
}

describe('a trusted click is only reported when the page received it', () => {
  it('succeeds when the page saw a press, release or click', async () => {
    const { click, mouse } = clickHarness({ arm: true, reads: [3] });

    const result = await click(120, 80);

    assert.equal(result.success, true);
    assert.equal(result.executionTier, 'cdp_trusted');
    assert.deepEqual(mouse, ['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  it('fails with CLICK_NOT_DELIVERED, and no synthetic retry, when the page saw nothing', async () => {
    const { click, mouse } = clickHarness({ arm: true, reads: [0, 0] });

    const result = await click(120, 80);

    assert.equal(result.success, false);
    assert.equal(result.fallbackNeeded, false, 'a click the page never saw must not be papered over by a synthetic one');
    assert.equal(result.data?.code, 'CLICK_NOT_DELIVERED');
    assert.deepEqual({ x: result.data?.x, y: result.data?.y }, { x: 120, y: 80 });
    assert.match(result.reason ?? '', /CLICK_NOT_DELIVERED/);
    assert.match(result.reason ?? '', /trusted:false/);
    assert.deepEqual(mouse, ['mouseMoved', 'mousePressed', 'mouseReleased'], 'exactly one press and release was sent');
  });

  it('gives the page a moment: an event that lands on the second read still counts', async () => {
    const { click } = clickHarness({ arm: true, reads: [0, 1] });

    const result = await click(120, 80);

    assert.equal(result.success, true);
  });

  it('does not fail a click it could not observe', async () => {
    for (const probe of [
      { arm: false, reads: [0] },
      { arm: true, reads: [null] },
      { arm: true, reads: ['unreadable'] },
    ]) {
      const { click } = clickHarness(probe);
      assert.equal((await click(120, 80)).success, true, JSON.stringify(probe));
    }
  });

  it('arms the probe at the click point before the mouse is moved and reads it after the release', async () => {
    const { click, scripts } = clickHarness({ arm: true, reads: [1] });

    await click(120.5, 80);

    assert.match(scripts[0] ?? '', /elementFromPoint\(120\.5, 80\)/);
    assert.match(scripts[0] ?? '', /IFRAME/);
    assert.match(scripts[1] ?? '', /__antifanClickProbe/);
  });
});

describe('the port surfaces a click the page never received as an error', () => {
  const target: BrowserTarget = { projectId: 'proj', workspaceId: 'ws', runtimeId: 'rt', tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 };

  it('throws CLICK_NOT_DELIVERED from the host answer instead of returning clicked:false', async () => {
    const host = {
      hasTab: () => true,
      getTabList: () => [{ id: 'tab-1', url: 'https://shop.test/' }],
      getDocumentGeneration: () => 1,
      dispatchAgentAction: async () => ({
        success: false,
        reason: 'CLICK_NOT_DELIVERED: no event',
        data: { code: 'CLICK_NOT_DELIVERED', executionTier: 'cdp_trusted' },
      }),
    } as unknown as BrowserHostPort;
    const port = new BrowserControlPort(host);

    await assert.rejects(
      port.agentClick({ selector: '#send' }, target),
      (err: unknown) => err instanceof CapabilityError && err.code === 'CLICK_NOT_DELIVERED' && /no event/.test(err.message),
    );
  });
});
