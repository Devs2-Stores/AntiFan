/**
 * Toolbar tab strip rendering and class assertions — real DOM proof.
 *
 * Asserts that tabs rendered in the tab strip are assigned their required CSS classes
 * (.tab, .tab.active, .tab.hibernated, etc.) and carry the tab-close affordance so
 * tabs do not collapse into bare classless flex items or lose their close buttons.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

interface ToolbarWindow extends Omit<Window, 'antifanToolbar'> {
  eval: (src: string) => unknown;
  antifanToolbar?: unknown;
  Event: typeof Event;
  KeyboardEvent: typeof KeyboardEvent;
}
interface JsdomLike { window: ToolbarWindow }
type JsdomCtor = new (html: string, options?: { runScripts?: string; url?: string }) => JsdomLike;

function loadJsdom(): { JSDOM: JsdomCtor } {
  const req = createRequire(__filename);
  const searchPaths = process.env.ANTIFAN_JSDOM
    ? [process.env.ANTIFAN_JSDOM, path.dirname(__filename)]
    : [path.dirname(__filename)];
  try {
    const resolved = req.resolve('jsdom', { paths: searchPaths });
    const jsdomModule: { JSDOM: JsdomCtor } = req(resolved);
    return { JSDOM: jsdomModule.JSDOM };
  } catch (err) {
    throw new Error(`jsdom resolution failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const RENDERER_DIR = (() => {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.compiled', 'src', 'renderer');
    if (fs.existsSync(path.join(candidate, 'toolbar.html'))) return candidate;
    const direct = path.join(dir, 'src', 'renderer');
    if (fs.existsSync(path.join(direct, 'toolbar.html'))) return direct;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..', '.compiled', 'src', 'renderer');
})();

interface BridgeStub {
  pushState: (state: Record<string, unknown>) => void;
  closedTabs: string[];
}

function makeApi(initialState: Record<string, unknown>, stub: BridgeStub) {
  const noop = () => () => undefined;
  const stateSubscribers: Array<(state: unknown) => void> = [];
  stub.pushState = (next) => {
    for (const subscriber of stateSubscribers) subscriber(next);
  };
  return {
    getInitialState: () => Promise.resolve(initialState),
    getWorkflowState: () => Promise.resolve({ workflows: [], tools: [] }),
    searchProjectTabs: () => Promise.resolve({ status: 'OK', rows: [] }),
    activateProjectTab: () => Promise.resolve({ status: 'ACTIVATED', tabId: '' }),
    closeTab: (tabId: string) => {
      stub.closedTabs.push(tabId);
      return Promise.resolve(true);
    },
    onStateUpdated: (callback: (state: unknown) => void) => {
      stateSubscribers.push(callback);
      return () => undefined;
    },
    onThemeQaState: noop,
    onCloseRefused: noop,
    onFocusFind: noop,
    onFocusOmnibox: noop,
    onShowShortcuts: noop,
    onFindResult: noop,
    onPhoneStatusChanged: noop,
    onWorkflowEvent: noop,
    getPhoneStatus: () => Promise.resolve({ state: 'unknown' }),
    setOverlay: () => Promise.resolve(),
  };
}

async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    queueMicrotask(resolve);
    await promise;
  }
}

async function loadToolbarWithTabs(tabs: unknown[], activeTabId: string) {
  const { JSDOM } = loadJsdom();
  const html = fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const win = dom.window;
  let frameSeq = 0;
  win.requestAnimationFrame = ((handler: (time: number) => void) => {
    frameSeq += 1;
    queueMicrotask(() => handler(0));
    return frameSeq;
  }) as unknown as typeof win.requestAnimationFrame;
  win.cancelAnimationFrame = (() => {}) as unknown as typeof win.cancelAnimationFrame;
  const stub: BridgeStub = { pushState: () => undefined, closedTabs: [] };
  const state: Record<string, unknown> = {
    tabs,
    activeTabId,
    bookmarks: [],
    projectWindow: {
      owner: { kind: 'project', projectId: 'p1' },
      title: 'Tổng hợp',
      pathLabel: 'E:\\Work\\projects\\tong-hop',
    },
  };
  win.antifanToolbar = makeApi(state, stub);
  win.eval(fs.readFileSync(path.join(RENDERER_DIR, 'exports-shim.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.js'), 'utf8'));
  await flush();
  return { dom, win, doc: win.document, stub };
}

describe('Toolbar tab strip class and element rendering', () => {
  test('single active tab receives .tab and .active class names and close button', async () => {
    const tabs = [
      { id: 'tab-1', title: 'Google', url: 'https://www.google.com/', favicon: '' },
    ];
    const { doc } = await loadToolbarWithTabs(tabs, 'tab-1');

    const tabList = doc.getElementById('tabList');
    assert.ok(tabList, 'tabList element exists');
    assert.strictEqual(tabList.children.length, 1, 'exactly one tab in the strip');

    const tabEl = tabList.firstElementChild as HTMLElement;
    assert.ok(tabEl, 'first tab element exists');

    // Invariant: The tab element MUST have class 'tab' and 'active'
    assert.ok(tabEl.classList.contains('tab'), 'tab element has "tab" class');
    assert.ok(tabEl.classList.contains('active'), 'active tab element has "active" class');

    // Invariant: The tab element MUST carry a close affordance
    const closeBtn = tabEl.querySelector('.tab-close');
    assert.ok(closeBtn, 'tab element contains .tab-close button');
  });

  test('multiple tabs assign active only to current activeTabId and tab class to all', async () => {
    const tabs = [
      { id: 'tab-1', title: 'Google', url: 'https://www.google.com/' },
      { id: 'tab-2', title: 'GitHub', url: 'https://github.com/' },
      { id: 'tab-3', title: 'Docs', url: 'https://docs.example.com/', hibernated: true },
    ];
    const { doc, stub } = await loadToolbarWithTabs(tabs, 'tab-2');

    const tabList = doc.getElementById('tabList')!;
    assert.strictEqual(tabList.children.length, 3);

    const tab1 = tabList.children[0] as HTMLElement | undefined;
    const tab2 = tabList.children[1] as HTMLElement | undefined;
    const tab3 = tabList.children[2] as HTMLElement | undefined;
    assert.ok(tab1 && tab2 && tab3, 'all 3 tab elements exist');

    // tab-1: inactive
    assert.ok(tab1.classList.contains('tab'));
    assert.strictEqual(tab1.classList.contains('active'), false);

    // tab-2: active
    assert.ok(tab2.classList.contains('tab'));
    assert.strictEqual(tab2.classList.contains('active'), true);

    // tab-3: hibernated
    assert.ok(tab3.classList.contains('tab'));
    assert.strictEqual(tab3.classList.contains('active'), false);
    assert.ok(tab3.classList.contains('hibernated'), 'hibernated tab carries .hibernated class');

    // Switch active tab via pushState
    stub.pushState({
      tabs,
      activeTabId: 'tab-1',
    });
    await flush();

    assert.ok(tab1.classList.contains('active'), 'tab-1 became active after pushState');
    assert.strictEqual(tab2.classList.contains('active'), false, 'tab-2 became inactive after pushState');

    // Close affordance click invokes bridge closeTab
    const closeBtn1 = tab1.querySelector<HTMLElement>('.tab-close');
    assert.ok(closeBtn1, 'tab-1 has .tab-close');
    closeBtn1.click();
    assert.deepStrictEqual(stub.closedTabs, ['tab-1'], 'closing tab-1 recorded');
  });

  test('tab element receives state-specific classes for agent-working and theme-error', async () => {
    const tabs = [
      { id: 'tab-agent', title: 'Agent Working', url: 'https://example.com/', isAgentControlled: true, aiState: 'agent_working' },
      { id: 'tab-err', title: 'Broken Page', url: 'https://example.com/err', themeError: 'Liquid syntax error' },
    ];
    const { doc } = await loadToolbarWithTabs(tabs, 'tab-agent');

    const tabList = doc.getElementById('tabList')!;
    const tabAgent = tabList.children[0] as HTMLElement | undefined;
    const tabErr = tabList.children[1] as HTMLElement | undefined;
    assert.ok(tabAgent && tabErr);

    assert.ok(tabAgent.classList.contains('tab'));
    assert.ok(tabAgent.classList.contains('agent-controlled'));
    assert.ok(tabAgent.classList.contains('agent-working'));

    assert.ok(tabErr.classList.contains('tab'));
    assert.ok(tabErr.classList.contains('tab-has-error'));
  });
});
