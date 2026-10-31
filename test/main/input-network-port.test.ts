import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { EVAL_ELEMENT_HTML_MAX_CHARS, EVAL_MAX_DEPTH_MARKER } from '../../src/main/browser/eval-result-truncation';

type Host = Record<string, any>;

const TARGET = { tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1, projectId: 'project-1', workspaceId: 'workspace-1', runtimeId: 'runtime-1' } as never;

function port(host: Host): BrowserControlPort {
  const base: Host = {
    getTabList: () => [{ id: 'tab-1', url: 'https://shop.example.com/' }],
    hasTab: (id: string) => id === 'tab-1',
    ...host,
  };
  return new BrowserControlPort(base as never, { stage: async (a: unknown) => a } as never);
}

async function rejection(promise: Promise<unknown>): Promise<CapabilityError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof CapabilityError, `expected CapabilityError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected a rejection');
}

describe('port: click, hover and type report navigation and locator', () => {
  it('click that navigated reports clicked:true with navigated, committedUrl and documentGeneration', async () => {
    let received: any;
    const p = port({
      dispatchAgentAction: async (_action: string, params: any) => {
        received = params;
        return { success: true, data: { navigated: true, committedUrl: 'https://shop.example.com/done', documentGeneration: 4, locator: { selector: '#pay', matchCount: 1, index: 0 } } };
      },
    });
    const res = await p.agentClick({ locator: { role: 'button', name: 'Pay' }, expectNavigation: true, tabId: 'tab-1' });
    assert.equal(res.clicked, true);
    assert.equal(res.navigated, true);
    assert.equal(res.committedUrl, 'https://shop.example.com/done');
    assert.equal(res.documentGeneration, 4);
    assert.deepEqual(res.locator, { selector: '#pay', matchCount: 1, index: 0 });
    assert.deepEqual(received.locator, { role: 'button', name: 'Pay' });
    assert.equal(received.expectNavigation, true);
  });

  it('refuses naming a locator together with a ref or selector', async () => {
    const p = port({ dispatchAgentAction: async () => ({ success: true }) });
    const err = await rejection(p.agentClick({ locator: { text: 'Pay' }, selector: '#pay', tabId: 'tab-1' }));
    assert.equal(err.code, 'INVALID_ARGUMENT');
    const bad = await rejection(p.agentClick({ locator: { color: 'red' } as never, tabId: 'tab-1' }));
    assert.equal(bad.code, 'INVALID_ARGUMENT');
  });

  it('type reports verified and the field content when the page reverted the text', async () => {
    const p = port({
      dispatchAgentAction: async () => ({ success: true, data: { verified: false, readBack: 'reverted', executionTier: 'cdp_trusted' } }),
    });
    const res = await p.agentType({ selector: '#q', text: 'hello', tabId: 'tab-1' });
    assert.equal(res.typed, true);
    assert.equal(res.verified, false);
    assert.equal(res.readBack, 'reverted');
    assert.match(res.hint ?? '', /reverted or rewrote/);
  });

  it('type reports verified:true without echoing a value, and verified:null when the field cannot be read', async () => {
    const ok = port({ dispatchAgentAction: async () => ({ success: true, data: { verified: true, readBack: 'hello' } }) });
    const okRes = await ok.agentType({ selector: '#q', text: 'hello', tabId: 'tab-1' });
    assert.equal(okRes.verified, true);
    assert.equal(okRes.readBack, undefined);
    const unknown = port({ dispatchAgentAction: async () => ({ success: true, data: { verified: null } }) });
    assert.equal((await unknown.agentType({ selector: '#q', text: 'hello', tabId: 'tab-1' })).verified, null);
  });

  it('a secret never echoes its value, even when the host hands the field content back', async () => {
    const previous = process.env.ANTIFAN_SECRET_TEST_PW;
    process.env.ANTIFAN_SECRET_TEST_PW = 'hunter2-secret';
    try {
      let forwarded: any;
      const p = port({
        dispatchAgentAction: async (_action: string, params: any) => {
          forwarded = params;
          return { success: true, data: { verified: false, readBack: 'hunter2-secret', readBackTruncated: false } };
        },
      });
      const res = await p.agentType({ selector: '#pw', fromEnv: 'ANTIFAN_SECRET_TEST_PW', tabId: 'tab-1' });
      assert.equal(res.typed, true);
      assert.equal(res.verified, false);
      assert.equal(res.readBack, undefined);
      assert.equal(res.hint, undefined);
      assert.equal(JSON.stringify(res).includes('hunter2-secret'), false);
      assert.equal(forwarded.secret, true);
      assert.equal(forwarded.fromEnv, undefined, 'the variable name is not forwarded');
    } finally {
      if (previous === undefined) delete process.env.ANTIFAN_SECRET_TEST_PW;
      else process.env.ANTIFAN_SECRET_TEST_PW = previous;
    }
  });
});

describe('port: set_control', () => {
  const okHost = (data: Record<string, unknown>, success = true, extra: Record<string, unknown> = {}) =>
    port({ setControl: async () => ({ success, data, ...extra }) });

  it('reports the before and observed states of a change', async () => {
    const p = okHost({ applied: true, changed: true, previous: { checked: false }, observed: { checked: true } });
    const res = await p.setControl({ selector: '#agree', state: 'on', tabId: 'tab-1' });
    assert.equal(res.applied, true);
    assert.equal(res.changed, true);
    assert.equal(res.desired, true);
    assert.deepEqual(res.before, { checked: false });
    assert.deepEqual(res.observed, { checked: true });
  });

  it('returns applied:false with the observed state instead of throwing when the click did not take', async () => {
    const p = okHost({ applied: false, changed: true, previous: { checked: false }, observed: { checked: false } }, false, { reason: 'The control reads false after the click', code: 'ELEMENT_NOT_ACTIONABLE' });
    const res = await p.setControl({ selector: '#agree', state: true, tabId: 'tab-1' });
    assert.equal(res.applied, false);
    assert.deepEqual(res.observed, { checked: false });
    assert.match(res.reason ?? '', /after the click/);
  });

  it('throws the host refusal code for a control that cannot be set', async () => {
    const p = okHost({ requested: true }, false, { reason: 'The control is disabled', code: 'ELEMENT_DISABLED' });
    const err = await rejection(p.setControl({ selector: '#agree', state: true, tabId: 'tab-1' }));
    assert.equal(err.code, 'ELEMENT_DISABLED');
  });

  it('passes through the locator that was resolved', async () => {
    const p = okHost({ applied: true, changed: false, previous: { checked: true }, observed: { checked: true }, locator: { selector: '#x', matchCount: 1 } });
    const res = await p.setControl({ locator: { role: 'checkbox', name: 'Gift' }, state: true, tabId: 'tab-1' });
    assert.deepEqual(res.locator, { selector: '#x', matchCount: 1 });
  });

  it('validates its arguments before the page is touched', async () => {
    let called = 0;
    const p = port({ setControl: async () => { called++; return { success: true, data: {} }; } });
    assert.equal((await rejection(p.setControl({ selector: '#a', tabId: 'tab-1' }))).code, 'INVALID_ARGUMENT');
    assert.equal((await rejection(p.setControl({ selector: '#a', state: 'maybe', tabId: 'tab-1' }))).code, 'INVALID_ARGUMENT');
    assert.equal((await rejection(p.setControl({ state: true, tabId: 'tab-1' }))).code, 'INVALID_ARGUMENT');
    assert.equal((await rejection(p.setControl({ selector: '#a', ref: '@e1', state: true, tabId: 'tab-1' }))).code, 'INVALID_ARGUMENT');
    assert.equal(called, 0);
  });

  it('is not supported by a host without setControl', async () => {
    const err = await rejection(port({}).setControl({ selector: '#a', state: true, tabId: 'tab-1' }));
    assert.equal(err.code, 'CAPABILITY_NOT_FOUND');
  });
});

describe('port: network inspection', () => {
  it('delegates the filters to the host, keyed by tab and pane', async () => {
    let seen: any;
    const p = port({
      getNetworkLog: async (tabId: string, filters: any) => {
        seen = { tabId, filters };
        return { entries: [{ seq: 3, requestId: 'r', method: 'GET', url: 'https://shop.example.com/x', resourceType: 'xhr', startedAt: 1 }], totalMatched: 1, returned: 1, highestSeq: 3, nextSeq: 3, evictedCount: 0, bufferCapacity: 500, attachedAt: 10 };
      },
    });
    const res = await p.inspectNetwork({ tabId: 'tab-1', urlPattern: '/x', status: '4xx', sinceSeq: 2, limit: 10, includeHeaders: false });
    assert.equal(seen.tabId, 'tab-1');
    assert.deepEqual(seen.filters, { urlPattern: '/x', status: '4xx', sinceSeq: 2, limit: 10, includeHeaders: false, paneId: 'desktop' });
    assert.equal(res.tabId, 'tab-1');
    assert.equal(res.paneId, 'desktop');
    assert.equal(res.highestSeq, 3);
    assert.equal(res.note, undefined);
  });

  it('says so when recording only just started for the tab', async () => {
    const p = port({ getNetworkLog: async () => ({ entries: [], totalMatched: 0, returned: 0, highestSeq: 0, nextSeq: 0, evictedCount: 0, bufferCapacity: 500 }) });
    const res = await p.inspectNetwork({ tabId: 'tab-1' });
    assert.match(res.note ?? '', /earlier requests are not available/);
  });

  it('is not supported by a host without a network log', async () => {
    assert.equal((await rejection(port({}).inspectNetwork({ tabId: 'tab-1' }))).code, 'CAPABILITY_NOT_FOUND');
  });
});

describe('port: evaluate reports a cut result', () => {
  it('flags an element whose markup was capped and a value the serializer stopped walking', async () => {
    const element = { tagName: 'DIV', outerHTML: 'x'.repeat(EVAL_ELEMENT_HTML_MAX_CHARS) };
    const p = port({ evalJs: async () => ({ nodes: [element], deep: EVAL_MAX_DEPTH_MARKER }) });
    const res = await p.evalChecked(TARGET, '1', 'tab-1');
    assert.equal(res.truncated, true);
    assert.deepEqual([...res.truncatedReasons].sort(), ['element-html', 'max-depth']);
  });

  it('reports a whole value as not truncated', async () => {
    const p = port({ evalJs: async () => ({ total: 3, items: ['a', 'b'] }) });
    const res = await p.evalChecked(TARGET, '1', 'tab-1');
    assert.equal(res.truncated, false);
    assert.deepEqual(res.truncatedReasons, []);
    assert.deepEqual(res.value, { total: 3, items: ['a', 'b'] });
  });
});

describe('port: tabs.list field validation', () => {
  it('lists the valid fields in the message of an unknown field refusal', () => {
    const p = port({});
    try {
      p.listTabs({ fields: ['tabId'] });
      assert.fail('expected a refusal');
    } catch (err) {
      assert.ok(err instanceof CapabilityError);
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /"tabId"/);
      assert.match(err.message, /valid fields are .*\bid\b.*\burl\b/);
    }
  });
});

describe('port: render surface refusal explains the remedy', () => {
  const zero = { vw: 0, vh: 0, dpr: 1, readyState: 'complete', hidden: true };

  it('a hidden or minimized window points at tabs.activate restoreWindow, never at set_viewport', async () => {
    const p = port({
      readRenderSurface: async () => zero,
      getHostWindowPresentation: () => ({ visible: false, minimized: true, maximized: false, hostWindowHidden: true }),
      evalJs: async () => 1,
    });
    const err = await rejection(p.eval(TARGET, '1', 'tab-1', undefined, { requireRenderSurface: true }));
    assert.equal(err.code, 'NO_RENDER_SURFACE');
    const details = err.details as Record<string, unknown>;
    assert.equal(details.hostWindowHidden, true);
    assert.equal(details.retryable, true);
    assert.match(err.message, /restoreWindow:true/);
    assert.match(err.message, /allowDegradedSurface/);
    assert.match(err.message, /Do not use anti\.browser\.set_viewport/);
  });

  it('a background tab of a visible window says to activate it', async () => {
    const p = port({
      readRenderSurface: async () => zero,
      getHostWindowPresentation: () => ({ visible: true, minimized: false, maximized: false, hostWindowHidden: false }),
      evalJs: async () => 1,
    });
    const err = await rejection(p.eval(TARGET, '1', 'tab-1', undefined, { requireRenderSurface: true }));
    assert.equal(err.code, 'NO_RENDER_SURFACE');
    assert.equal((err.details as Record<string, unknown>).hostWindowHidden, false);
    assert.match(err.message, /tabs\.activate/);
  });

  it('get_viewport reports the window state and the remedy for a tab with no surface', async () => {
    const p = port({
      readRenderSurface: async () => zero,
      getHostWindowPresentation: () => ({ visible: false, minimized: true, maximized: false, hostWindowHidden: true }),
      getActiveTabId: () => 'tab-1',
    });
    const res = await p.getViewport({ tabId: 'tab-1' });
    assert.equal(res.width, 0);
    assert.equal(res.hostWindowHidden, true);
    assert.equal(res.windowPresentation?.minimized, true);
    assert.match(res.remedy ?? '', /restoreWindow:true/);
  });

  it('get_viewport of a rendered tab carries the window state without a remedy', async () => {
    const p = port({
      readRenderSurface: async () => ({ vw: 1280, vh: 800, dpr: 2, readyState: 'complete', hidden: false }),
      getHostWindowPresentation: () => ({ visible: true, minimized: false, maximized: true, hostWindowHidden: false }),
      getActiveTabId: () => 'tab-1',
    });
    const res = await p.getViewport({ tabId: 'tab-1' });
    assert.equal(res.width, 1280);
    assert.equal(res.hostWindowHidden, false);
    assert.equal(res.remedy, undefined);
  });
});
