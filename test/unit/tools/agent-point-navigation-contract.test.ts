import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
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

interface NavCall {
  tabId: string;
  url: string;
  wait: unknown;
}

function makePort(overrides: Partial<BrowserHostPort> = {}): { port: BrowserControlPort; nav: NavCall[] } {
  const nav: NavCall[] = [];
  const host = {
    hasTab: (id: string) => id === 'tab-1',
    getTabList: () => [{ id: 'tab-1', url: 'https://shop.test/' }],
    getDocumentGeneration: () => 1,
    navigate: () => true,
    navigateAndWait: async (tabId: string, url: string, wait?: unknown) => {
      nav.push({ tabId, url, wait });
      return true;
    },
    ...overrides,
  } as unknown as BrowserHostPort;
  return { port: new BrowserControlPort(host), nav };
}

function refusal(promise: Promise<unknown>): Promise<CapabilityError> {
  return promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (err: unknown) => {
      if (!(err instanceof CapabilityError)) throw err;
      return err;
    }
  );
}

function scratchWorkspace(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-local-file-'));
  const file = path.join(root, 'page.html');
  fs.writeFileSync(file, '<!doctype html><title>local</title><p>hi');
  return { root, file };
}

describe('file: navigation admission', () => {
  it('navigates to a regular file inside the workspace root and admits its canonical path', async () => {
    const { root, file } = scratchWorkspace();
    const { port, nav } = makePort();
    try {
      const result = await port.navigate(target, pathToFileURL(file).href, undefined, { localFileRoot: root });
      assert.equal(result.navigated, true);
      assert.equal(nav.length, 1);
      assert.equal(nav[0]?.url, pathToFileURL(fs.realpathSync.native(file)).href);
      const wait = nav[0]?.wait as { admittedLocalFilePath?: string };
      assert.equal(wait.admittedLocalFilePath, path.resolve(fs.realpathSync.native(file)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a file outside the workspace root and names the loopback alternative', async () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-outside-'));
    const { root } = scratchWorkspace();
    const outside = path.join(outer, 'outside.html');
    fs.writeFileSync(outside, '<!doctype html>');
    const { port, nav } = makePort();
    try {
      const err = await refusal(port.navigate(target, pathToFileURL(outside).href, undefined, { localFileRoot: root }));
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /http:\/\/127\.0\.0\.1/);
      assert.equal(nav.length, 0, 'a refused local file never reaches the host');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it('refuses a directory even inside the root', async () => {
    const { root } = scratchWorkspace();
    const { port, nav } = makePort();
    try {
      const err = await refusal(port.navigate(target, pathToFileURL(root).href, undefined, { localFileRoot: root }));
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /not a regular file/);
      assert.equal(nav.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a file: URL with no workspace root to confine it to', async () => {
    const { root, file } = scratchWorkspace();
    const { port, nav } = makePort();
    try {
      const err = await refusal(port.navigate(target, pathToFileURL(file).href));
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /workspace root/);
      assert.equal(nav.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a missing file and keeps javascript:/data: refused', async () => {
    const { root } = scratchWorkspace();
    const { port, nav } = makePort();
    try {
      const missing = await refusal(port.navigate(target, pathToFileURL(path.join(root, 'gone.html')).href, undefined, { localFileRoot: root }));
      assert.equal(missing.code, 'INVALID_ARGUMENT');
      for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd']) {
        const err = await refusal(port.navigate(target, url));
        assert.equal(err.code, 'INVALID_ARGUMENT', `${url} must stay refused`);
      }
      assert.equal(nav.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('evaluate timeout clamp', () => {
  it('clamps an over-ceiling budget, marks the result and runs with the ceiling', async () => {
    const budgets: Array<number | undefined> = [];
    const { port } = makePort({
      evalJs: async (_expression: string, _tabId?: string, _paneId?: string, _gesture?: boolean, timeoutMs?: number) => {
        budgets.push(timeoutMs);
        return 2;
      },
    } as Partial<BrowserHostPort>);
    const checked = await port.evalChecked(target, '1 + 1', undefined, undefined, { timeoutMs: 30_000 });
    assert.equal(checked.value, 2);
    assert.ok(checked.clampedTimeout, 'an over-ceiling ask is reported as clamped');
    assert.equal(checked.clampedTimeout?.requestedTimeoutMs, 30_000);
    assert.ok((checked.clampedTimeout?.appliedTimeoutMs ?? 0) < 30_000);
    assert.equal(budgets[0], checked.clampedTimeout?.appliedTimeoutMs);
  });

  it('leaves a budget under the ceiling untouched and reports no clamp', async () => {
    const budgets: Array<number | undefined> = [];
    const { port } = makePort({
      evalJs: async (_expression: string, _tabId?: string, _paneId?: string, _gesture?: boolean, timeoutMs?: number) => {
        budgets.push(timeoutMs);
        return 'ok';
      },
    } as Partial<BrowserHostPort>);
    const checked = await port.evalChecked(target, '1', undefined, undefined, { timeoutMs: 5_000 });
    assert.equal(checked.clampedTimeout, undefined);
    assert.equal(budgets[0], 5_000);
  });
});

describe('navigation soft timeout', () => {
  function timedOutHost(state: { url: string; readyState: string }): Partial<BrowserHostPort> {
    return {
      navigateAndWait: async () => false,
      getLastNavigationFailure: () => ({ cause: 'NAVIGATION_TIMEOUT', message: 'Navigation load completion timed out after 20000ms', timedOut: true }),
      evalJs: async () => ({ url: state.url, readyState: state.readyState, errorPage: false }),
      getSemanticDocumentGeneration: () => 4,
    };
  }

  it('answers a usable committed document instead of throwing, and says the wait timed out', async () => {
    const { port } = makePort(timedOutHost({ url: 'https://shop.test/collections/all', readyState: 'interactive' }));
    const result = await port.navigate(target, 'https://shop.test/collections/all', undefined, { softTimeout: true });
    assert.equal(result.navigated, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.readyState, 'interactive');
    assert.equal(result.loadState, 'timeout');
    assert.equal(result.committedUrl, 'https://shop.test/collections/all');
    assert.equal(result.target.documentGeneration, 4);
  });

  it('still throws when the document is not at least interactive', async () => {
    const { port } = makePort(timedOutHost({ url: 'https://shop.test/collections/all', readyState: 'loading' }));
    const err = await refusal(port.navigate(target, 'https://shop.test/collections/all', undefined, { softTimeout: true }));
    assert.equal(err.code, 'NAVIGATION_TIMEOUT');
  });

  it('still throws when the tab is on another URL', async () => {
    const { port } = makePort(timedOutHost({ url: 'https://shop.test/other', readyState: 'complete' }));
    const err = await refusal(port.navigate(target, 'https://shop.test/collections/all', undefined, { softTimeout: true }));
    assert.equal(err.code, 'NAVIGATION_TIMEOUT');
  });

  it('keeps throwing for internal callers that did not ask for the soft answer', async () => {
    const { port } = makePort(timedOutHost({ url: 'https://shop.test/collections/all', readyState: 'complete' }));
    const err = await refusal(port.navigate(target, 'https://shop.test/collections/all'));
    assert.equal(err.code, 'NAVIGATION_TIMEOUT');
  });

  it('answers a soft reload only for this reload\'s own timeout record', async () => {
    let polls = 0;
    const { port } = makePort({
      reloadAndWait: async () => false,
      getLastNavigationFailure: () => {
        polls += 1;
        // The pre-call read sees the earlier navigation's record; the post-call read sees the
        // record this reload wrote.
        return polls === 1
          ? { cause: 'NAVIGATION_TIMEOUT', message: 'earlier navigation', timedOut: true }
          : { cause: 'NAVIGATION_TIMEOUT', message: 'Navigation load completion timed out after 20000ms', timedOut: true };
      },
      // A reload can only answer softly for the document it reloaded: urlBefore comes from the tab row.
      evalJs: async () => ({ url: 'https://shop.test/', readyState: 'complete', errorPage: false }),
      getSemanticDocumentGeneration: () => 7,
    });
    const result = await port.reload(target, undefined, { softTimeout: true });
    assert.equal(result.reloaded, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.urlAfter, 'https://shop.test/');
  });
});

describe('typing at a point', () => {
  it('clicks the point, types into the field it focused, and accepts string coordinates', async () => {
    const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
    const { port } = makePort({
      dispatchAgentAction: async (action: 'click' | 'type', params: Record<string, unknown>) => {
        actions.push({ action, params });
        return action === 'type'
          ? { success: true, data: { ok: true, executed: true, verified: true, readBack: 'Notes' } }
          : { success: true, data: { ok: true, executed: true } };
      },
    });
    const result = await port.agentType({ x: '960' as unknown as number, y: '541' as unknown as number, text: 'Notes', clear: true }, target);
    assert.equal(result.typed, true);
    assert.equal(actions.length, 2);
    assert.equal(actions[0]?.action, 'click');
    assert.equal(actions[0]?.params.x, 960);
    assert.equal(actions[0]?.params.y, 541);
    assert.equal(actions[0]?.params.trusted, true);
    assert.equal(actions[1]?.action, 'type');
    assert.equal(actions[1]?.params.trusted, true);
    assert.equal(actions[1]?.params.x, 960);
  });

  it('names the working alternatives when no field is addressed', async () => {
    // A call that names no field is refused on its arguments: the host must never be asked.
    const { port } = makePort({
      dispatchAgentAction: async () => {
        throw new Error('the host must not be asked for an argument-only refusal');
      },
    });
    const err = await refusal(port.agentType({ text: 'x' }, target));
    assert.equal(err.code, 'INVALID_ARGUMENT');
    assert.match(err.message, /x and y/);
    assert.match(err.message, /ref, selector or locator/);
  });

  it('refuses half a point instead of typing into nothing', async () => {
    const { port } = makePort({
      dispatchAgentAction: async () => {
        throw new Error('the host must not be asked for an argument-only refusal');
      },
    });
    const err = await refusal(port.agentType({ x: 10, text: 'x' }, target));
    assert.equal(err.code, 'INVALID_ARGUMENT');
    assert.match(err.message, /both x and y/);
  });

  it('reports that nothing editable took focus when the executor says so', async () => {
    const { port } = makePort({
      dispatchAgentAction: async (action: 'click' | 'type') =>
        action === 'click'
          ? { success: true, data: { ok: true, executed: true } }
          : {
              success: false,
              reason: 'Nothing editable has focus at (10, 20): click an input, textarea or contenteditable element first, or name the field with ref, selector or locator',
              data: { ok: false, code: 'ELEMENT_NOT_ACTIONABLE' },
            },
    });
    const err = await refusal(port.agentType({ x: 10, y: 20, text: 'x' }, target));
    assert.equal(err.code, 'ELEMENT_NOT_ACTIONABLE');
    assert.match(err.message, /Nothing editable has focus/);
  });
});

describe('viewport refusal remedy', () => {
  it('names the measured size and the device preset that can be applied', async () => {
    const { port } = makePort({
      setViewportSize: async () => ({ success: true }),
      readRenderSurface: async () => ({
        vw: 414,
        vh: 700,
        layoutWidth: 414,
        layoutHeight: 700,
        readyState: 'complete',
        hidden: false,
        scrollX: 0,
        scrollY: 0,
        docH: 700,
        dpr: 2,
      }),
      getDevicePresets: () => [
        { id: 'responsive', name: 'Responsive' },
        { id: 'phone-iphonexr', name: 'iPhone XR', width: 414, height: 896, category: 'mobile' },
        { id: 'laptop-hd', name: 'Laptop', width: 1366, height: 768, category: 'desktop' },
      ],
    } as Partial<BrowserHostPort>);
    const err = await refusal(port.setViewport({ width: 360, height: 700 }, target));
    assert.equal(err.code, 'VIEWPORT_NOT_APPLIED');
    assert.equal(err.details?.observedWidth, 414);
    const remedy = err.details?.remedy as { tool?: string; args?: Record<string, unknown> } | undefined;
    assert.equal(remedy?.tool, 'anti.browser.set_device_preset');
    assert.equal(remedy?.args?.presetId, 'phone-iphonexr');
    assert.match(err.message, /anti\.browser\.set_device_preset/);
  });
});
