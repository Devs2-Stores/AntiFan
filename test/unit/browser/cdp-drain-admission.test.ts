/**
 * A target that holds a timed-out CDP command refuses new commands. The refusal has to say
 * when the same call is admitted (the host resets the stuck command on the first admission
 * after its self-clean age), and the render-surface probe a degraded-surface caller runs
 * first has to surface that refusal with the same facts.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TabDevToolsHost, type TabDevToolsContext } from '../../../src/main/browser/tab-devtools-host';
import { CaptureError } from '../../../src/main/verification/visual-capture';
import {
  CDP_DRAIN_SELF_CLEAN_MS,
  buildDrainRefusalDetails,
  drainIsExpired,
  drainRecoveryGuidance,
  drainRetryAfterMs,
} from '../../../src/main/browser/cdp-drain-admission';

const WC_ID = 91;

function makeTab() {
  const dbg = new EventEmitter();
  let attached = false;
  const sent: string[] = [];
  Object.assign(dbg, {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    sendCommand: (method: string) => {
      sent.push(method);
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ result: { value: { vw: 1280, vh: 720, readyState: 'complete', hidden: false } } });
      }
      return Promise.resolve({});
    },
  });
  const wcEvents = new EventEmitter();
  const wc = {
    id: WC_ID,
    isDestroyed: () => false,
    debugger: dbg,
    on: wcEvents.on.bind(wcEvents),
    once: wcEvents.once.bind(wcEvents),
    removeListener: wcEvents.removeListener.bind(wcEvents),
  } as unknown as Electron.WebContents;
  const ctx = {
    getActiveTabId: () => 'tab-1',
    getTabRecord: (id: string) => (id === 'tab-1' ? { focusedPane: 'desktop' } : undefined),
    getTabWebContents: () => wc,
  } as unknown as TabDevToolsContext;
  const host = new TabDevToolsHost(ctx);
  const drainFor = (ageMs: number) => (host as unknown as {
    cdpDrainingTargets: Map<number, { method: string; token: symbol; startedAt: number }>;
  }).cdpDrainingTargets.set(WC_ID, { method: 'Emulation.setUserAgentOverride', token: Symbol('drain'), startedAt: Date.now() - ageMs });
  return { host, wc, sent, drainFor };
}

describe('cdp drain admission helpers', () => {
  it('retryAfterMs is the time left until the self-clean age is passed, and 0 once it is', () => {
    const now = 1_000_000;
    assert.equal(drainRetryAfterMs({ method: 'x', startedAt: now - 1000 }, now), CDP_DRAIN_SELF_CLEAN_MS - 1000 + 1);
    assert.equal(drainRetryAfterMs({ method: 'x', startedAt: now - CDP_DRAIN_SELF_CLEAN_MS }, now), 1);
    assert.equal(drainRetryAfterMs({ method: 'x', startedAt: now - CDP_DRAIN_SELF_CLEAN_MS - 1 }, now), 0);
    assert.equal(drainIsExpired({ method: 'x', startedAt: now - CDP_DRAIN_SELF_CLEAN_MS - 1 }, now), true);
    assert.equal(drainIsExpired({ method: 'x', startedAt: now - 10 }, now), false);
  });

  it('an entry whose start was never recorded counts as long expired', () => {
    assert.equal(drainIsExpired({ method: 'x' }, Date.now()), true);
    assert.equal(drainRetryAfterMs({ method: 'x' }, Date.now()), 0);
  });

  it('recovery names the wait and the CDP-free close, and never offers reload', () => {
    const text = drainRecoveryGuidance(3200);
    assert.match(text, /3200 ms/);
    assert.match(text, /anti\.browser\.tabs\.close/);
    assert.doesNotMatch(text, /reload/i);
  });

  it('refusal details carry the draining and refused methods and the wait', () => {
    const details = buildDrainRefusalDetails({ method: 'Runtime.evaluate', startedAt: 10_000 }, 12_000, { wcId: 5, refusedMethod: 'Page.captureScreenshot' });
    assert.deepEqual(
      { ...details, recovery: undefined },
      { wcId: 5, drainingMethod: 'Runtime.evaluate', refusedMethod: 'Page.captureScreenshot', drainingForMs: 2000, retryAfterMs: 3001, recovery: undefined }
    );
    assert.match(details.recovery, /3001 ms/);
  });
});

describe('TabDevToolsHost drain admission', () => {
  it('refuses a command on a draining target with retryAfterMs and recovery', async () => {
    const tab = makeTab();
    tab.drainFor(1000);
    await assert.rejects(
      () => tab.host.sendCdpCommand(tab.wc, 'Runtime.evaluate', {}),
      (err: unknown) => {
        assert.ok(err instanceof CaptureError);
        assert.equal(err.code, 'TARGET_BUSY_DRAINING');
        const details = err.details as Record<string, unknown>;
        assert.equal(details.drainingMethod, 'Emulation.setUserAgentOverride');
        assert.equal(details.refusedMethod, 'Runtime.evaluate');
        const retryAfterMs = details.retryAfterMs as number;
        assert.ok(retryAfterMs > 3900 && retryAfterMs <= CDP_DRAIN_SELF_CLEAN_MS, `retryAfterMs ${retryAfterMs} is the time left of the 5000 ms self-clean age`);
        assert.match(String(details.recovery), /anti\.browser\.tabs\.close/);
        assert.match(err.message, /retry in \d+ ms/);
        return true;
      }
    );
    assert.deepEqual(tab.sent, [], 'a refused command never reaches the debugger');
  });

  it('admits the next command once the drain is older than the self-clean age', async () => {
    const tab = makeTab();
    tab.drainFor(CDP_DRAIN_SELF_CLEAN_MS + 500);
    await tab.host.sendCdpCommand(tab.wc, 'Runtime.evaluate', {});
    assert.deepEqual(tab.sent, ['Runtime.evaluate']);
    assert.equal(tab.host.isTargetDraining('tab-1'), false);
  });

  it('the render-surface probe of a draining target throws the refusal with retryAfterMs, so a degraded-surface caller learns the wait', async () => {
    const tab = makeTab();
    tab.drainFor(2000);
    await assert.rejects(
      () => tab.host.readRenderSurface('tab-1'),
      (err: unknown) => {
        assert.ok(err instanceof CaptureError);
        assert.equal(err.code, 'TARGET_BUSY_DRAINING');
        const retryAfterMs = (err.details as Record<string, unknown>).retryAfterMs as number;
        assert.ok(retryAfterMs > 2900 && retryAfterMs <= 3001);
        return true;
      }
    );
  });

  it('a verification capture of a draining target is refused with the same facts', async () => {
    const tab = makeTab();
    tab.drainFor(500);
    await assert.rejects(
      () => tab.host.captureVerificationScreenshot(undefined, 'tab-1'),
      (err: unknown) => {
        assert.ok(err instanceof CaptureError);
        assert.equal(err.code, 'TARGET_BUSY_DRAINING');
        const details = err.details as Record<string, unknown>;
        assert.equal(details.tabId, 'tab-1');
        assert.ok(typeof details.retryAfterMs === 'number' && details.retryAfterMs > 0);
        return true;
      }
    );
  });
});
