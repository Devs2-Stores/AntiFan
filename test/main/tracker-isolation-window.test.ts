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

  it('retries a partial release without re-removing an identifier that is already gone', async () => {
    // The realistic failure: the registration comes off, clearing the blocklist
    // fails. Chromium errors "Script not found" if the identifier is removed
    // twice, so a retry that repeats the removal would fail forever and the tab
    // would stay blocked with no leak to describe. The partial path is therefore
    // asserted, not just the all-or-nothing one.
    const h = createHarness();
    const removals: unknown[] = [];
    let blocklistClearFails = true;
    (h.devTools as unknown as { sendCdpCommand: (w: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand =
      async (_w, method, params) => {
        h.commands.push({ method, params });
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'stub-1' };
        if (method === 'Page.removeScriptToEvaluateOnNewDocument') {
          const identifier = (params as { identifier?: unknown } | undefined)?.identifier;
          removals.push(identifier);
          return {};
        }
        if (method === 'Network.setBlockedURLs') {
          const urls = (params as { urls?: unknown[] } | undefined)?.urls;
          if (Array.isArray(urls) && urls.length === 0 && blocklistClearFails) throw new Error('CDP session gone');
        }
        return {};
      };

    await h.devTools.beginTrackerIsolation('tab-1', 'desktop');
    const first = await h.devTools.endTrackerIsolation('tab-1', 'desktop');
    assert.strictEqual(first.released, false);
    assert.match(String(first.reason), /clearing Network\.setBlockedURLs failed/);
    assert.deepStrictEqual(removals, ['stub-1'], 'the registration must come off on the first attempt');

    blocklistClearFails = false;
    const retry = await h.devTools.endTrackerIsolation('tab-1', 'desktop');
    assert.strictEqual(retry.released, true);
    assert.deepStrictEqual(
      removals,
      ['stub-1'],
      'the retry must not re-remove an identifier Chromium already forgot'
    );
    assert.strictEqual(h.devTools.isTrackerIsolationActive('tab-1'), false);
  });

  it('refuses to reopen a window whose previous release left the blocklist applied', async () => {
    // The half-released state is the dangerous one: registration gone, blocklist
    // still on. Reopening must not answer `active: true`, because the caller would
    // then reload into blocked vendor tags with no stub while believing the window
    // is installed.
    const h = createHarness();
    const registrations = () => h.commands.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument').length;
    h.setReleaseFails(true);

    await h.devTools.beginTrackerIsolation('tab-1', 'desktop');
    const partial = await h.devTools.endTrackerIsolation('tab-1', 'desktop');
    assert.strictEqual(partial.released, false);
    assert.strictEqual(registrations(), 1);

    const reopened = await h.devTools.beginTrackerIsolation('tab-1', 'desktop');
    assert.strictEqual(reopened.active, false, 'a half-released window must never be reported as active');
    assert.strictEqual(reopened.preDocumentScriptIdentifier, null);
    assert.match(String(reopened.degradedReason), /not fully released/);
    assert.strictEqual(
      registrations(),
      1,
      'no pre-document registration may be added while the previous blocklist is still applied'
    );
    assert.strictEqual(h.devTools.isTrackerIsolationActive('tab-1'), true, 'the leftover blocklist stays tracked and retryable');
  });

  it('re-establishes the window from scratch once the leftover blocklist clears', async () => {
    const h = createHarness();
    const registrations = () => h.commands.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument').length;
    h.setReleaseFails(true);

    await h.devTools.beginTrackerIsolation('tab-1', 'desktop');
    await h.devTools.endTrackerIsolation('tab-1', 'desktop');

    h.setReleaseFails(false);
    const reopened = await h.devTools.beginTrackerIsolation('tab-1', 'desktop');

    assert.strictEqual(reopened.active, true);
    assert.strictEqual(reopened.preDocumentScriptIdentifier, 'stub-1', 'the reopened window installs a fresh registration');
    assert.strictEqual(registrations(), 2);
    assert.deepStrictEqual(
      h.blockedCalls().at(-1)?.params,
      { urls: reopened.blockedPatterns },
      'the reopened window must re-apply its blocklist after the leftover one is cleared'
    );
  });

  it('refuses to reopen when the release failed to remove the registration', async () => {
    // The mirror of the blocklist-only failure: here the *registration* half
    // fails and the blocklist is lifted, so the entry survives with a non-null
    // identifier over a window that is no longer blocking anything. Keying the
    // reopen check on the identifier alone would report that as installed and
    // claim blocking that is not applied.
    const h = createHarness();
    const registrations = () => h.commands.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument').length;
    let removalFails = true;
    (h.devTools as unknown as { sendCdpCommand: (w: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand =
      async (_w, method, params) => {
        h.commands.push({ method, params });
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'stub-1' };
        if (method === 'Page.removeScriptToEvaluateOnNewDocument' && removalFails) {
          throw new Error('Script not found');
        }
        return {};
      };

    await h.devTools.beginTrackerIsolation('tab-1', 'desktop');
    const partial = await h.devTools.endTrackerIsolation('tab-1', 'desktop');
    assert.strictEqual(partial.released, false);
    assert.match(String(partial.reason), /removeScriptToEvaluateOnNewDocument failed/);
    assert.deepStrictEqual(
      h.blockedCalls().at(-1)?.params,
      { urls: [] },
      'the blocklist half must have completed, leaving the registration as the only outstanding half'
    );
    assert.strictEqual(registrations(), 1);

    const blocked = await h.devTools.beginTrackerIsolation('tab-1', 'desktop');
    assert.strictEqual(
      blocked.active,
      false,
      'a window whose registration could not be removed must not be reported as installed'
    );
    assert.match(String(blocked.degradedReason), /not fully released/);
    assert.strictEqual(
      registrations(),
      1,
      'no fresh registration may be added while the previous one is still installed'
    );

    removalFails = false;
    const reopened = await h.devTools.beginTrackerIsolation('tab-1', 'desktop');
    assert.strictEqual(reopened.active, true);
    assert.strictEqual(reopened.preDocumentScriptIdentifier, 'stub-1');
    assert.strictEqual(registrations(), 2);
    assert.deepStrictEqual(
      h.blockedCalls().at(-1)?.params,
      { urls: reopened.blockedPatterns },
      'the reopened window must re-apply the blocklist the failed release had already lifted'
    );
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
