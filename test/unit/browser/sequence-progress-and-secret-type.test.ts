/**
 * An action sequence that stops part-way reports which step failed and how many succeeded;
 * a typed secret masks its field before the first character lands and never shows up in a result.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { sequenceProgress } from '../../../src/main/browser/sequence-progress';
import { SemanticRefRegistry } from '../../../src/main/browser/semantic-ref-registry';
import { TabAutomationHost } from '../../../src/main/browser/tab-automation-host';
import { SECRET_FIELD_ATTRIBUTE } from '../../../src/main/browser/screenshot-guard-css';

describe('sequenceProgress', () => {
  it('counts successes and names the first failure', () => {
    assert.deepEqual(sequenceProgress([]), { completedSteps: 0 });
    assert.deepEqual(sequenceProgress([{ actionIndex: 0, success: true }, { actionIndex: 1, success: true }]), { completedSteps: 2 });
    assert.deepEqual(
      sequenceProgress([{ actionIndex: 0, success: true }, { actionIndex: 1, success: false }, { actionIndex: 2, success: true }, { actionIndex: 3, success: false }]),
      { completedSteps: 2, failedStepIndex: 1 }
    );
  });
});

interface HostHarness {
  host: TabAutomationHost;
  isolatedScripts: string[];
  cdp: Array<{ method: string; params: Record<string, unknown> }>;
}

function harness(extra: Record<string, unknown> = {}): HostHarness {
  const isolatedScripts: string[] = [];
  const cdp: Array<{ method: string; params: Record<string, unknown> }> = [];
  const wc = {
    id: 3,
    isDestroyed: () => false,
    getURL: () => 'https://shop.example/account/login',
    executeJavaScript: async () => undefined,
    debugger: { isAttached: () => true, attach: () => {} },
    mainFrame: {
      executeJavaScriptInIsolatedWorld: async (_world: number, scripts: Array<{ code: string }>) => {
        isolatedScripts.push(scripts[0]?.code ?? '');
        return { ok: true, executed: true };
      },
    },
  } as unknown as Electron.WebContents;
  const tabRecord = { state: { id: 'tab-1', url: 'https://shop.example/account/login' } };
  const host = new TabAutomationHost({
    getTabWebContents: () => wc,
    getTabRecord: () => tabRecord,
    getAutomationTabId: () => 'tab-1',
    getActiveTabId: () => 'tab-1',
    getBrowserEpoch: () => 1,
    getSemanticDocumentGeneration: () => 1,
    semanticRefRegistry: new SemanticRefRegistry(),
    runTargetOperation: async (_tab: unknown, _pane: unknown, op: () => Promise<unknown>) => op(),
    broadcastState: () => {},
    syncFrameBackdrop: () => {},
    getAllTabs: () => [][Symbol.iterator](),
    tabDevToolsHost: {
      sendCdpCommand: async (_wc: unknown, method: string, params: Record<string, unknown> = {}) => {
        cdp.push({ method, params });
        return {};
      },
    },
    ...extra,
  } as unknown as ConstructorParameters<typeof TabAutomationHost>[0]);
  return { host, isolatedScripts, cdp };
}

describe('executeActionSequence progress accounting', () => {
  it('a failing middle step stops the run: completedSteps counts successes, failedStepIndex names the failure', async () => {
    const { host } = harness();
    const res = await host.executeActionSequence({
      actions: [{ type: 'wait', waitMs: 1 }, { type: 'wait', waitMs: 1 }, { type: 'navigate' }, { type: 'wait', waitMs: 1 }],
    });
    assert.equal(res.success, false);
    assert.equal(res.executedCount, 3, 'the failing step was attempted');
    assert.equal(res.completedSteps, 2, 'but only two steps succeeded');
    assert.equal(res.failedStepIndex, 2);
    assert.equal(res.totalCount, 4);
  });

  it('with stopOnError off the run continues and still names the first failure', async () => {
    const { host } = harness();
    const res = await host.executeActionSequence({
      stopOnError: false,
      actions: [{ type: 'wait', waitMs: 1 }, { type: 'navigate' }, { type: 'wait', waitMs: 1 }],
    });
    assert.equal(res.executedCount, 3);
    assert.equal(res.completedSteps, 2);
    assert.equal(res.failedStepIndex, 1);
  });

  it('a clean run completes every step and has no failedStepIndex', async () => {
    const { host } = harness();
    const res = await host.executeActionSequence({ actions: [{ type: 'wait', waitMs: 1 }, { type: 'wait', waitMs: 1 }] });
    assert.equal(res.success, true);
    assert.equal(res.completedSteps, 2);
    assert.equal('failedStepIndex' in res, false);
  });

  it('a refused sequence reports zero completed steps', async () => {
    const { host } = harness();
    const res = await host.executeActionSequence({ actions: [] });
    assert.equal(res.success, false);
    assert.equal(res.completedSteps, 0);
  });
});

describe('sequence navigate loadState', () => {
  type NavData = { loadState?: string; navigatedUrl?: string };
  const navigateWith = async (navOk: boolean, failure: { cause: string; message: string; timedOut: boolean } | undefined) => {
    const { host } = harness({
      navigateAndWait: async () => navOk,
      getLastNavigationFailure: () => failure,
    });
    const res = await host.executeActionSequence({ actions: [{ type: 'navigate', url: 'https://shop.example/next' }] });
    return res.results[0]!.data as NavData;
  };

  it('reports loaded when the navigation reached the requested stage', async () => {
    assert.equal((await navigateWith(true, undefined)).loadState, 'loaded');
  });

  it('reports timeout only for a recorded timeout', async () => {
    const data = await navigateWith(false, { cause: 'NAVIGATION_TIMEOUT', message: 'timed out', timedOut: true });
    assert.equal(data.loadState, 'timeout');
  });

  it('omits loadState for a blocked or failed load instead of calling it a timeout', async () => {
    const blocked = await navigateWith(false, { cause: 'NAVIGATION_BLOCKED', message: 'blocked', timedOut: false });
    assert.equal('loadState' in blocked, false);
    const failed = await navigateWith(false, { cause: 'LOAD_FAILED', message: 'failed', timedOut: false });
    assert.equal('loadState' in failed, false);
  });

  it('omits loadState when the host kept no failure record', async () => {
    assert.equal('loadState' in await navigateWith(false, undefined), false);
  });
});

describe('secret typing', () => {
  type TrustedTyper = { executeTrustedType: (wc: unknown, focusScript: string, text: string, clear?: boolean, secret?: boolean) => Promise<{ success: boolean; data?: unknown }> };
  const typeWith = async (secret: boolean | undefined) => {
    const h = harness();
    const wc = { id: 3, debugger: { isAttached: () => true }, executeJavaScript: async () => undefined, mainFrame: { executeJavaScriptInIsolatedWorld: async (_w: number, scripts: Array<{ code: string }>) => { h.isolatedScripts.push(scripts[0]?.code ?? ''); return { ok: true, executed: true }; } } };
    const result = await (h.host as unknown as TrustedTyper).executeTrustedType(wc, 'FOCUS_SCRIPT', 'hunter2-secret', false, secret);
    return { ...h, result };
  };

  it('marks the focused field as secret after focusing and before the first character is inserted', async () => {
    const { isolatedScripts, cdp, result } = await typeWith(true);
    assert.equal(result.success, true);
    assert.equal(isolatedScripts[0], 'FOCUS_SCRIPT');
    assert.ok(isolatedScripts[1]?.includes(SECRET_FIELD_ATTRIBUTE), 'the second isolated script marks the field');
    assert.ok(cdp.some((c) => c.method === 'Input.insertText'));
    assert.equal(isolatedScripts.length, 2, 'the mark runs once, before the insert');
  });

  it('an ordinary type does not mark the field', async () => {
    const { isolatedScripts } = await typeWith(undefined);
    assert.deepEqual(isolatedScripts, ['FOCUS_SCRIPT']);
  });

  it('the secret text is never part of the result or of any script sent to the page', async () => {
    const { isolatedScripts, result } = await typeWith(true);
    assert.equal(JSON.stringify(result).includes('hunter2-secret'), false);
    assert.equal(isolatedScripts.some((s) => s.includes('hunter2-secret')), false);
  });
});
