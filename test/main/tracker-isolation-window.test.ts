/**
 * Tracker-isolation window lifecycle.
 *
 * The window blocks third-party measurement origins and stubs their globals for
 * exactly the QA reload. Two properties matter more than the happy path, because
 * getting either wrong damages the user's own tab:
 *
 *  1. A release that fails must stay known. Dropping the bookkeeping on a failed
 *     rollback leaves `Network.setBlockedURLs` applied to the user's tab with no
 *     way to retry, detect or even describe the leak.
 *  2. Nothing may be blocked unless the pre-document stub is registered. The live
 *     -document injection only covers the page already loaded; blocking origins
 *     without it means the reloaded document gets blocked tag scripts and no
 *     stub, turning a benign `fbq()` no-op into a ReferenceError.
 *
 * Both are asserted here against the real host with the CDP transport stubbed,
 * so the assertions describe the bookkeeping contract rather than a script body.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TabDevToolsHost } from '../../src/main/browser/tab-devtools-host';
import { buildTrackerStubTeardownScript, TRACKER_STUB_MARKER } from '../../src/main/browser/tracker-isolation';

interface MockTabRecord {
  id: string;
  focusedPane: 'desktop' | 'mobile';
  webContents: unknown;
}

function createHarness() {
  const scriptsExecuted: string[] = [];
  const commands: Array<{ method: string; params?: unknown }> = [];
  let releaseFails = false;

  const wc = {
    id: 71,
    isDestroyed: () => false,
    executeJavaScript: async (script: string) => {
      scriptsExecuted.push(script);
      return { installed: ['fbq'] };
    },
  };
  const tab: MockTabRecord = { id: 'tab-1', focusedPane: 'desktop', webContents: wc };

  const ctx = {
    getActiveTabId: () => 'tab-1',
    getTabRecord: (id: string) => (id === 'tab-1' ? tab : undefined),
    getTabWebContents: (id: string) => (id === 'tab-1' ? wc : null),
  };

  const devTools = new TabDevToolsHost(ctx as unknown as ConstructorParameters<typeof TabDevToolsHost>[0]);
  (devTools as unknown as { sendCdpCommand: (w: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand =
    async (_w, method, params) => {
      commands.push({ method, params });
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'stub-1' };
      if (method === 'Network.setBlockedURLs') {
        const urls = (params as { urls?: unknown[] } | undefined)?.urls;
        if (Array.isArray(urls) && urls.length === 0 && releaseFails) throw new Error('CDP session gone');
      }
      return {};
    };

  return {
    devTools,
    commands,
    scriptsExecuted,
    blockedCalls: () => commands.filter((c) => c.method === 'Network.setBlockedURLs'),
    setReleaseFails: (value: boolean) => {
      releaseFails = value;
    },
  };
}

describe('Tracker isolation window', () => {
  it('keeps the window retryable when the release fails, then releases cleanly', async () => {
    const h = createHarness();
    h.setReleaseFails(true);

    const receipt = await h.devTools.beginTrackerIsolation('tab-1', 'desktop');
    assert.strictEqual(receipt.active, true);
    assert.strictEqual(receipt.preDocumentScriptIdentifier, 'stub-1');
    assert.ok(receipt.blockedPatterns.length > 0, 'an active window must record what it blocked');
    assert.strictEqual(h.devTools.isTrackerIsolationActive('tab-1'), true);

    const failed = await h.devTools.endTrackerIsolation('tab-1', 'desktop');
    assert.strictEqual(failed.released, false);
    assert.match(String(failed.reason), /clearing Network\.setBlockedURLs failed/);
    assert.strictEqual(
      h.devTools.isTrackerIsolationActive('tab-1'),
      true,
      'a failed release must keep the entry so the applied blocklist stays known and retryable'
    );

    h.setReleaseFails(false);
    const retried = await h.devTools.endTrackerIsolation('tab-1', 'desktop');
    assert.strictEqual(retried.released, true);
    assert.strictEqual(retried.reason, undefined);
    assert.strictEqual(h.devTools.isTrackerIsolationActive('tab-1'), false);
    assert.deepStrictEqual(
      h.blockedCalls().at(-1)?.params,
      { urls: [] },
      'a successful release must lift the blocklist'
    );
  });

  it('blocks nothing when the pre-document registration returns no identifier', async () => {
    const h = createHarness();
    (h.devTools as unknown as { sendCdpCommand: (w: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand =
      async (_w, method) => {
        h.commands.push({ method });
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return {};
        return {};
      };

    const receipt = await h.devTools.beginTrackerIsolation('tab-1', 'desktop');

    assert.strictEqual(receipt.active, false);
    assert.strictEqual(receipt.preDocumentScriptIdentifier, null);
    assert.match(String(receipt.degradedReason), /no identifier/);
    assert.strictEqual(
      h.commands.some((c) => c.method === 'Network.setBlockedURLs'),
      false,
      'nothing may be blocked without a pre-document stub, or the reloaded document loses both the tag and the stub'
    );
    assert.strictEqual(
      h.scriptsExecuted.includes(buildTrackerStubTeardownScript()),
      true,
      'the live-document stubs must be torn down when the window cannot be established'
    );
    assert.strictEqual(h.devTools.isTrackerIsolationActive('tab-1'), false);
  });

  it('reports the release failure reason instead of an opaque false', async () => {
    const h = createHarness();
    await h.devTools.beginTrackerIsolation('tab-1', 'desktop');
    h.setReleaseFails(true);

    const failed = await h.devTools.endTrackerIsolation('tab-1', 'desktop');
    assert.match(String(failed.reason), /CDP session gone/, 'the underlying CDP error must survive into the reason');
  });

  it('does not report an inactive window as released', async () => {
    const h = createHarness();
    const result = await h.devTools.endTrackerIsolation('tab-1', 'desktop');
    assert.strictEqual(result.released, false);
    assert.match(String(result.reason), /was not active/);
  });

  it('stub teardown targets exactly the globals this module installed', () => {
    const script = buildTrackerStubTeardownScript();
    assert.ok(script.includes(TRACKER_STUB_MARKER), 'teardown must key off the module marker, not a hardcoded name list');
  });
});
