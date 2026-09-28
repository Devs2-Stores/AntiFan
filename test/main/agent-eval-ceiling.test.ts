import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { TabAutomationHost, type TabAutomationContext } from '../../src/main/browser/tab-automation-host';
import { withEvalCeiling } from '../../src/main/browser/eval-ceiling';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

/**
 * Every synthetic action and every inspection script in the agent pipeline round-trips through the
 * page's renderer. Measured on this platform, an evaluation on a WebContents whose renderer never
 * came up (`pid = 0`, an un-navigated view) or has since died is answered with NOTHING: the promise
 * neither resolves nor rejects, ever. Because actions are serialized per target, one silent script
 * also stops every later action from answering.
 *
 * These rows prove the shipped entry points refuse with the typed `EVAL_HARD_TIMEOUT` at their
 * ceiling instead of waiting forever, and that a real answer still comes back untouched — the bound
 * must end silence, never turn a slow page into a failure.
 *
 * The soft budget is overridden through the injected context so a row proves the refusal without
 * waiting the production budget out (the ceiling derives to ~3.1s at 100ms).
 */
const TEST_SOFT_BUDGET_MS = 100;
/** Generous headroom above the derived ceiling (~3.1s) without accepting a hang. */
const REFUSAL_CEILING_WITH_HEADROOM_MS = 10_000;

interface Harness {
  host: TabAutomationHost;
  /** The mock WebContents the host is pointed at, for direct `executeInIsolatedWorld` calls. */
  wc: Electron.WebContents;
  /** Every script the host asked the page to run, in order. */
  scripts: string[];
}

function makeHarness(evalImpl: (script: string) => Promise<unknown>): Harness {
  const scripts: string[] = [];
  const wc = {
    isDestroyed: () => false,
    executeJavaScript: (script: string) => {
      scripts.push(script);
      return evalImpl(script);
    },
    executeJavaScriptInIsolatedWorld: (_worldId: number, injected: Array<{ code: string }>) => {
      const code = injected[0]?.code ?? '';
      scripts.push(code);
      return evalImpl(code);
    },
    getURL: () => 'https://store.example.com/',
  } as unknown as Electron.WebContents;

  const ctx = {
    getTabWebContents: () => wc,
    getTabRecord: () => ({ state: { id: 'tab-1', aiState: 'idle' }, focusedPane: 'desktop' }),
    getAutomationTabId: () => 'tab-1',
    getActiveTabId: () => 'tab-1',
    getBrowserEpoch: () => 1,
    getSemanticDocumentGeneration: () => 1,
    runTargetOperation: async (_tabId: string, _pane: unknown, op: () => Promise<unknown>) => op(),
    broadcastState: () => {},
    syncFrameBackdrop: () => {},
    agentEvalSoftBudgetMs: TEST_SOFT_BUDGET_MS,
  } as unknown as TabAutomationContext;

  return { host: new TabAutomationHost(ctx), wc, scripts };
}

function never(): Promise<unknown> {
  return new Promise<unknown>(() => {
    /* the renderer is gone: nothing will ever settle this */
  });
}

describe('TabAutomationHost — an agent script the renderer never answers', () => {
  it('refuses isolated-world execution with EVAL_HARD_TIMEOUT instead of waiting forever', async () => {
    const { host, wc } = makeHarness(() => never());
    const startedAt = Date.now();
    await assert.rejects(
      host.executeInIsolatedWorld(wc, 'return 1'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'EVAL_HARD_TIMEOUT',
      'a silent renderer must surface as the typed hard-timeout refusal'
    );
    assert.ok(
      Date.now() - startedAt < REFUSAL_CEILING_WITH_HEADROOM_MS,
      'the refusal must arrive at the ceiling rather than hanging'
    );
  });

  it('reports agent browser injection as failed when the page never answers', async () => {
    const { host, scripts } = makeHarness(() => never());
    const startedAt = Date.now();
    assert.equal(await host.ensureAgentBrowserInjected('tab-1'), false);
    assert.ok(scripts.length > 0, 'the injection attempt must actually have been made');
    assert.ok(Date.now() - startedAt < REFUSAL_CEILING_WITH_HEADROOM_MS);
  });

  it('refuses page-global inspection with a typed error instead of returning an empty result', async () => {
    const { host } = makeHarness(() => never());
    await assert.rejects(
      host.inspectPageGlobal({ propertyChain: 'navigator.userAgent', tabId: 'tab-1' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'EVAL_HARD_TIMEOUT'
    );
  });

  it('returns a real answer untouched and does not wait for the ceiling', async () => {
    const { host, wc } = makeHarness(async () => ({ ok: true, value: 42 }));
    const startedAt = Date.now();
    assert.deepEqual(await host.executeInIsolatedWorld(wc, 'return {ok:true}'), { ok: true, value: 42 });
    assert.ok(Date.now() - startedAt < TEST_SOFT_BUDGET_MS + 1_500, 'a real answer must not wait out the ceiling');
  });

  it('surfaces a script error unchanged instead of replacing it with a timeout', async () => {
    const { host, wc } = makeHarness(async () => {
      throw new Error('page refused: element detached');
    });
    await assert.rejects(
      host.executeInIsolatedWorld(wc, 'throw new Error()'),
      (err: Error) => err.message === 'page refused: element detached'
    );
  });

  it('fails loudly on a non-finite budget instead of refusing the page instantly', async () => {
    let ran = false;
    await assert.rejects(
      withEvalCeiling({
        wc: undefined,
        label: 'probe',
        softBudgetMs: Number.NaN,
        work: async () => {
          ran = true;
          return 1;
        },
      }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
    assert.equal(ran, false, 'a bad budget must not run the work at all');
  });

  it('refuses at its ceiling when the terminate call itself is never answered', async () => {
    let terminateCalls = 0;
    const startedAt = Date.now();
    await assert.rejects(
      withEvalCeiling({
        wc: { isDestroyed: () => false } as unknown as Electron.WebContents,
        label: 'probe',
        softBudgetMs: TEST_SOFT_BUDGET_MS,
        terminate: () => {
          terminateCalls += 1;
          return never() as Promise<unknown>;
        },
        work: () => never(),
      }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'EVAL_HARD_TIMEOUT',
      'a terminate that never answers must not hold the refusal back'
    );
    assert.ok(
      Date.now() - startedAt < REFUSAL_CEILING_WITH_HEADROOM_MS,
      'the bound exists to end an unanswered call, so it cannot depend on a second call answering'
    );
    assert.equal(terminateCalls, 1, 'the overrunning script must still be asked to terminate');
  });
});
