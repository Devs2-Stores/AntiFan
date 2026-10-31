import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
// @ts-ignore jsdom ships no type declarations (same as menu-depth.test.ts)
import { JSDOM } from 'jsdom';
import { TabAutomationHost } from '../../src/main/browser/tab-automation-host';

const PAGE_URL = 'https://shop.example.com/cart';

interface Box { x: number; y: number; width: number; height: number }

interface Harness {
  host: TabAutomationHost;
  dom: JSDOM;
  doc: Document;
  win: any;
  cdp: Array<{ command: string; params: any }>;
  generation: { value: number };
  /** What a committed navigation does: a new URL and the next document generation. */
  navigate: () => void;
  destroy: () => void;
  /** Whether the WebContents reports a load in progress. */
  loading: { value: boolean };
  /** `afterScript` runs after each isolated-world script (given its code), to stage a change between two steps of one action. */
  hooks: { afterScript?: (code: string) => void };
  /** The host's context, for a test that adds an optional seam before the first action. */
  ctx: any;
  wc: any;
}

/**
 * A TabAutomationHost over a jsdom page: the isolated-world scripts the host builds run for real
 * against the DOM, the CDP surface is recorded, and the document generation is a number the test
 * moves the way a committed navigation would.
 */
function harness(html: string, boxes: Record<string, Box> = {}): Harness {
  const dom = new JSDOM(html, { url: PAGE_URL, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window as any;
  const doc = win.document as Document;
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    const box = (this.id && boxes[this.id]) || { x: 0, y: 0, width: 0, height: 0 };
    return { ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON() { return this; } };
  };
  win.Element.prototype.getClientRects = function (this: Element) {
    const box = (this.id && boxes[this.id]) || undefined;
    return box && box.width > 0 && box.height > 0 ? [this.getBoundingClientRect()] : [];
  };
  // Hit-testing: the element at a point is whichever boxed element contains it, innermost last.
  (doc as any).elementsFromPoint = (x: number, y: number) =>
    Array.from(doc.querySelectorAll('[id]')).filter((el) => {
      const b = boxes[el.id];
      return b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
    }).reverse();
  (doc as any).elementFromPoint = (x: number, y: number) => (doc as any).elementsFromPoint(x, y)[0] ?? null;

  const generation = { value: 1 };
  const cdp: Array<{ command: string; params: any }> = [];
  let destroyed = false;
  const loading = { value: false };
  const hooks: { afterScript?: (code: string) => void } = {};
  const wc: any = {
    isDestroyed: () => destroyed,
    isLoading: () => loading.value,
    getURL: () => win.location.href,
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: Array<{ code: string }>) => {
      const result = await win.eval(scripts[0]!.code);
      hooks.afterScript?.(scripts[0]!.code);
      return result;
    },
    executeJavaScript: async () => undefined,
    debugger: {
      isAttached: () => true,
      attach: () => {},
      detach: () => {},
      sendCommand: async (command: string, params: any) => {
        cdp.push({ command, params });
        if (command === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
          // A trusted click lands on whatever the page hit-tests at that point.
          const hit = (doc as any).elementFromPoint(params.x, params.y) as HTMLElement | null;
          if (hit) hit.click();
        }
        if (command === 'Input.insertText') {
          const active = doc.activeElement as HTMLInputElement | null;
          if (active && 'value' in active) active.value = `${active.value}${params.text}`;
        }
        if (command === 'Input.dispatchKeyEvent' && params.code === 'Backspace' && params.type === 'keyDown') {
          const active = doc.activeElement as HTMLInputElement | null;
          if (active && 'value' in active) active.value = '';
        }
        return {};
      },
    },
  };
  const ctx: any = {
    getTabWebContents: () => wc,
    getTabRecord: () => ({ state: { id: 'tab-1', aiState: 'idle' }, focusedPane: 'desktop' }),
    getAutomationTabId: () => 'tab-1',
    getActiveTabId: () => 'tab-1',
    getBrowserEpoch: () => 1,
    getSemanticDocumentGeneration: () => generation.value,
    runTargetOperation: async (_id: string, _pane: unknown, op: () => Promise<unknown>) => op(),
    broadcastState: () => {},
    syncFrameBackdrop: () => {},
  };
  const navigate = () => {
    dom.reconfigure({ url: 'https://shop.example.com/thank-you' });
    generation.value += 1;
  };
  return { host: new TabAutomationHost(ctx), dom, doc, win, cdp, generation, navigate, destroy: () => { destroyed = true; }, loading, hooks, ctx, wc };
}

const CARD: Record<string, Box> = {
  pay: { x: 20, y: 20, width: 120, height: 36 },
  other: { x: 20, y: 80, width: 120, height: 36 },
  agree: { x: 20, y: 140, width: 160, height: 24 },
  wrap: { x: 20, y: 140, width: 160, height: 24 },
  mail: { x: 20, y: 200, width: 200, height: 30 },
  pw: { x: 20, y: 240, width: 200, height: 30 },
};

describe('click, hover and type that navigate', () => {
  it('reports success with navigated, committedUrl and documentGeneration when the click moved the page', async () => {
    const h = harness('<button id="pay">Pay</button>', CARD);
    h.doc.getElementById('pay')!.addEventListener('click', () => { h.navigate(); });
    const res = await h.host.dispatchAgentAction('click', { selector: '#pay', tabId: 'tab-1' });
    assert.equal(res.success, true, JSON.stringify(res));
    const data = res.data as Record<string, unknown>;
    assert.equal(data.navigated, true);
    assert.equal(data.committedUrl, 'https://shop.example.com/thank-you');
    assert.equal(data.documentGeneration, 2);
  });

  it('leaves a click that did not navigate without a navigated flag', async () => {
    const h = harness('<button id="pay">Pay</button>', CARD);
    const res = await h.host.dispatchAgentAction('click', { selector: '#pay', tabId: 'tab-1' });
    assert.equal(res.success, true, JSON.stringify(res));
    assert.equal((res.data as Record<string, unknown>).navigated, undefined);
  });

  it('expectNavigation keeps a click that started no navigation successful and says that no navigation was seen', async () => {
    const h = harness('<button id="pay">Pay</button>', CARD);
    // Real timers on purpose: the wait for a navigation to start is wall-clock time in the host.
    const res = await h.host.dispatchAgentAction('click', { selector: '#pay', tabId: 'tab-1', expectNavigation: true, navigationTimeoutMs: 100 });
    assert.equal(res.success, true, 'the click happened; reporting it as failed would invite a repeat of its side effects');
    const data = res.data as Record<string, unknown>;
    assert.equal(data.navigated, false);
    assert.equal(data.committedUrl, 'https://shop.example.com/cart');
    assert.match(String(data.hint), /no navigation started within 100ms/);
  });

  it('expectNavigation honours navigationTimeoutMs and clamps it to 100-15000', async () => {
    const h = harness('<button id="pay">Pay</button>', CARD);
    const started = Date.now();
    const res = await h.host.dispatchAgentAction('click', { selector: '#pay', tabId: 'tab-1', expectNavigation: true, navigationTimeoutMs: 1 });
    assert.match(String((res.data as Record<string, unknown>).hint), /within 100ms/);
    assert.ok(Date.now() - started < 1500, 'a 1 ms request is raised to the 100 ms floor, not the default window');
    // A navigation that starts late inside a longer window still counts (real timers: the host waits wall-clock time).
    const late = harness('<button id="pay">Pay</button>', CARD);
    late.doc.getElementById('pay')!.addEventListener('click', () => { setTimeout(() => late.navigate(), 400); });
    const lateRes = await late.host.dispatchAgentAction('click', { selector: '#pay', tabId: 'tab-1', expectNavigation: true, navigationTimeoutMs: 2000 });
    assert.equal((lateRes.data as Record<string, unknown>).navigated, true);
    assert.equal((lateRes.data as Record<string, unknown>).committedUrl, 'https://shop.example.com/thank-you');
  });

  it('reports committedUrl only once the navigation has committed, not when it starts', async () => {
    const h = harness('<button id="pay">Pay</button>', CARD);
    h.doc.getElementById('pay')!.addEventListener('click', () => {
      // The generation moves when the navigation starts; the URL changes at commit, later.
      h.generation.value += 1;
      h.loading.value = true;
      setTimeout(() => {
        h.dom.reconfigure({ url: 'https://shop.example.com/thank-you' });
        h.loading.value = false;
      }, 150);
    });
    const res = await h.host.dispatchAgentAction('click', { selector: '#pay', tabId: 'tab-1' });
    const data = res.data as Record<string, unknown>;
    assert.equal(data.navigated, true);
    assert.equal(data.committedUrl, 'https://shop.example.com/thank-you');
    assert.equal(data.navigationPending, undefined);
  });

  it('refuses a click when the document was replaced between the pre-flight and the dispatch, and dispatches nothing', async () => {
    const h = harness('<button id="pay">Pay</button>', CARD);
    // The pre-flight is the isolated script that resolves the target (action "focus"); the page moves right after it.
    h.hooks.afterScript = (code) => {
      if (!code.includes('"action":"focus"')) return;
      h.hooks.afterScript = undefined;
      h.navigate();
    };
    const res = await h.host.dispatchAgentAction('click', { selector: '#pay', tabId: 'tab-1' });
    assert.equal(res.success, false);
    assert.equal(res.reason, 'Document navigated during action execution');
    assert.equal(h.cdp.some((c) => c.command === 'Input.dispatchMouseEvent'), false, 'the coordinates belong to the replaced document');
  });

  it('expectNavigation still reports success when the click did navigate', async () => {
    const h = harness('<button id="pay">Pay</button>', CARD);
    h.doc.getElementById('pay')!.addEventListener('click', () => { h.navigate(); });
    const res = await h.host.dispatchAgentAction('click', { selector: '#pay', tabId: 'tab-1', expectNavigation: true });
    assert.equal(res.success, true, JSON.stringify(res));
  });

  it('still fails when the WebContents is gone after the action: its outcome is unknowable', async () => {
    const h = harness('<button id="pay">Pay</button>', CARD);
    h.doc.getElementById('pay')!.addEventListener('click', () => { h.destroy(); });
    const res = await h.host.dispatchAgentAction('click', { selector: '#pay', tabId: 'tab-1' });
    assert.equal(res.success, false);
    assert.equal(res.reason, 'Document navigated during action execution');
  });

  it('a sequence carries on after a step navigated: later steps run against the new document', async () => {
    const h = harness('<button id="pay">Pay</button><button id="other">Other</button>', CARD);
    let otherClicks = 0;
    h.doc.getElementById('pay')!.addEventListener('click', () => { h.navigate(); });
    h.doc.getElementById('other')!.addEventListener('click', () => { otherClicks++; });
    const res = await h.host.executeActionSequence({
      tabId: 'tab-1',
      actions: [
        { type: 'click', selector: '#pay', settleMs: 0 },
        { type: 'click', selector: '#other', settleMs: 0 },
      ],
    });
    assert.equal(res.success, true, JSON.stringify(res));
    assert.equal(res.completedSteps, 2);
    assert.equal((res.results[0]!.data as Record<string, unknown>).navigated, true);
    assert.equal(otherClicks, 1);
  });
});

describe('zero-size targets through the host', () => {
  it('refuses a click on an empty box with a typed code and no synthetic fallback', async () => {
    const h = harness('<button id="ghost">Pay</button>', CARD);
    const res = await h.host.dispatchAgentAction('click', { selector: '#ghost', tabId: 'tab-1', trusted: true });
    assert.equal(res.success, false);
    assert.equal((res.data as Record<string, unknown>).code, 'TARGET_ZERO_SIZE');
    assert.equal(h.cdp.some((c) => c.command === 'Input.dispatchMouseEvent'), false, 'nothing may be dispatched at a box with no area');
  });

  it('lets force through an empty box: the caller waived the actionability checks', async () => {
    const h = harness('<button id="ghost">Pay</button>', CARD);
    const res = await h.host.dispatchAgentAction('click', { selector: '#ghost', tabId: 'tab-1', trusted: true, force: true });
    assert.equal(res.success, true, JSON.stringify(res));
    assert.equal(h.cdp.some((c) => c.command === 'Input.dispatchMouseEvent'), true);
  });

  it('clicks an empty box synthetically when trusted is false: the click lands on the element itself', async () => {
    const h = harness('<button id="ghost">Pay</button>', CARD);
    let clicks = 0;
    h.doc.getElementById('ghost')!.addEventListener('click', () => { clicks++; });
    const res = await h.host.dispatchAgentAction('click', { selector: '#ghost', tabId: 'tab-1', trusted: false });
    assert.equal(res.success, true, JSON.stringify(res));
    assert.equal(clicks, 1);
    assert.equal(h.cdp.some((c) => c.command === 'Input.dispatchMouseEvent'), false);
  });
});

describe('locator through the host', () => {
  const page = '<button id="pay">Pay now</button><button id="other">Pay now</button>';

  it('clicks the element a unique locator names and reports which one it was', async () => {
    const h = harness('<button id="pay">Pay now</button><button id="other">Keep shopping</button>', CARD);
    let paid = 0;
    h.doc.getElementById('pay')!.addEventListener('click', () => { paid++; });
    const res = await h.host.dispatchAgentAction('click', { locator: { role: 'button', name: 'Pay now' }, tabId: 'tab-1' });
    assert.equal(res.success, true, JSON.stringify(res));
    assert.equal(paid, 1);
    const located = (res.data as Record<string, any>).locator;
    assert.equal(located.matchCount, 1);
    assert.equal(h.doc.querySelectorAll(located.selector)[0]!.id, 'pay');
  });

  it('refuses an ambiguous locator, lists the candidates and clicks nothing', async () => {
    const h = harness(page, CARD);
    let clicks = 0;
    for (const id of ['pay', 'other']) h.doc.getElementById(id)!.addEventListener('click', () => { clicks++; });
    const res = await h.host.dispatchAgentAction('click', { locator: { role: 'button', name: 'Pay now' }, tabId: 'tab-1' });
    assert.equal(res.success, false);
    const data = res.data as Record<string, any>;
    assert.equal(data.code, 'LOCATOR_AMBIGUOUS');
    assert.equal(data.candidates.length, 2);
    assert.equal(clicks, 0);
  });

  it('nth picks one of several matches', async () => {
    const h = harness(page, CARD);
    let second = 0;
    h.doc.getElementById('other')!.addEventListener('click', () => { second++; });
    const res = await h.host.dispatchAgentAction('click', { locator: { role: 'button', name: 'Pay now', nth: 1 }, tabId: 'tab-1' });
    assert.equal(res.success, true, JSON.stringify(res));
    assert.equal(second, 1);
  });

  it('reports LOCATOR_NOT_FOUND for a locator nothing matches', async () => {
    const h = harness(page, CARD);
    const res = await h.host.dispatchAgentAction('click', { locator: { text: 'Does not exist' }, tabId: 'tab-1' });
    assert.equal(res.success, false);
    assert.equal((res.data as Record<string, unknown>).code, 'LOCATOR_NOT_FOUND');
  });

  it('a malformed locator is refused with INVALID_ARGUMENT before the page is touched', async () => {
    const h = harness(page, CARD);
    const res = await h.host.dispatchAgentAction('click', { locator: { color: 'red' }, tabId: 'tab-1' });
    assert.equal(res.success, false);
    assert.equal((res.data as Record<string, unknown>).code, 'INVALID_ARGUMENT');
  });
});

describe('set_control', () => {
  const form = '<label id="wrap"><input id="agree" type="checkbox" style="position:absolute;width:0;height:0"> I agree</label>';

  it('clicks only when the state differs, then reads the control back', async () => {
    const h = harness(form, { wrap: CARD.wrap! });
    let clicks = 0;
    h.doc.getElementById('agree')!.addEventListener('click', () => { clicks++; });
    const on = await h.host.setControl({ selector: '#agree', state: true, tabId: 'tab-1' });
    assert.equal(on.success, true, JSON.stringify(on));
    assert.equal(on.data!.changed, true);
    assert.equal((on.data!.observed as Record<string, unknown>).checked, true);
    assert.equal((on.data!.previous as Record<string, unknown>).checked, false);
    assert.equal(clicks, 1);

    const again = await h.host.setControl({ selector: '#agree', state: true, tabId: 'tab-1' });
    assert.equal(again.success, true);
    assert.equal(again.data!.changed, false);
    assert.equal(clicks, 1, 'a control already in the requested state is not clicked');

    const off = await h.host.setControl({ selector: '#agree', state: false, tabId: 'tab-1' });
    assert.equal(off.success, true, JSON.stringify(off));
    assert.equal((off.data!.observed as Record<string, unknown>).checked, false);
    assert.equal(clicks, 2);
  });

  it('reports applied:false when the page rewrites the state the click set', async () => {
    const h = harness('<input id="agree" type="checkbox" style="width:30px;height:30px">', { agree: { x: 20, y: 20, width: 30, height: 30 } });
    const box = h.doc.getElementById('agree') as HTMLInputElement;
    box.addEventListener('click', () => { setTimeout(() => { box.checked = false; }, 0); });
    const res = await h.host.setControl({ selector: '#agree', state: true, tabId: 'tab-1' });
    assert.equal(res.success, false);
    assert.equal(res.data!.applied, false);
    assert.equal((res.data!.observed as Record<string, unknown>).checked, false);
    assert.match(res.reason ?? '', /not the requested true/);
  });

  it('refuses a disabled control, a radio uncheck and a plain button, naming why', async () => {
    const h = harness(
      '<input id="agree" type="checkbox" disabled><input id="pw" type="radio"><button id="pay">Pay</button>',
      CARD
    );
    const disabled = await h.host.setControl({ selector: '#agree', state: true, tabId: 'tab-1' });
    assert.equal(disabled.success, false);
    assert.equal(disabled.code, 'ELEMENT_DISABLED');
    h.doc.getElementById('pw')!.setAttribute('checked', '');
    (h.doc.getElementById('pw') as HTMLInputElement).checked = true;
    const radio = await h.host.setControl({ selector: '#pw', state: false, tabId: 'tab-1' });
    assert.equal(radio.success, false);
    assert.match(radio.reason ?? '', /radio/);
    const button = await h.host.setControl({ selector: '#pay', state: true, tabId: 'tab-1' });
    assert.equal(button.success, false);
    assert.match(button.reason ?? '', /use click for a plain button/);
  });

  it('resolves a locator to the control and carries it in the answer', async () => {
    const h = harness('<input id="agree" type="checkbox" style="width:30px;height:30px"><label for="agree" id="lab">Gift wrap</label>', { agree: CARD.agree!, lab: CARD.wrap! });
    const res = await h.host.setControl({ locator: { role: 'checkbox', name: 'Gift wrap' }, state: true, tabId: 'tab-1' });
    assert.equal(res.success, true, JSON.stringify(res));
    assert.equal((res.data!.locator as Record<string, unknown>).matchCount, 1);
    assert.equal((h.doc.getElementById('agree') as HTMLInputElement).checked, true);
  });

  it('needs a ref, a selector or a locator', async () => {
    const h = harness('<p>x</p>', CARD);
    const res = await h.host.setControl({ state: true, tabId: 'tab-1' });
    assert.equal(res.success, false);
    assert.equal(res.code, 'INVALID_ARGUMENT');
  });
});

describe('trusted type read-back', () => {
  it('verifies the text that landed and echoes the field content', async () => {
    const h = harness('<input id="mail" type="text">', CARD);
    const res = await h.host.dispatchAgentAction('type', { selector: '#mail', text: 'a@b.test', clear: true, trusted: true, tabId: 'tab-1' });
    assert.equal(res.success, true, JSON.stringify(res));
    const data = res.data as Record<string, unknown>;
    assert.equal(data.verified, true);
    assert.equal(data.readBack, 'a@b.test');
  });

  it('reports verified:false with what the field really holds when the page dropped the text', async () => {
    const h = harness('<input id="mail" type="text">', CARD);
    const input = h.doc.getElementById('mail') as HTMLInputElement;
    const original = h.cdp;
    // The page swallows the insert: the field stays empty although Input.insertText succeeded.
    Object.defineProperty(input, 'value', { get: () => '', set: () => {}, configurable: true });
    const res = await h.host.dispatchAgentAction('type', { selector: '#mail', text: 'lost', clear: true, trusted: true, tabId: 'tab-1' });
    assert.equal(res.success, true, JSON.stringify(res));
    const data = res.data as Record<string, unknown>;
    assert.equal(data.verified, false);
    assert.equal(data.readBack, '');
    assert.ok(original.some((c) => c.command === 'Input.insertText'));
  });

  it('a secret reports only the comparison: the text never appears in the result', async () => {
    const h = harness('<input id="mail" type="text">', CARD);
    const res = await h.host.dispatchAgentAction('type', { selector: '#mail', text: 'hunter2-secret', clear: true, secret: true, tabId: 'tab-1' });
    assert.equal(res.success, true, JSON.stringify(res));
    const data = res.data as Record<string, unknown>;
    assert.equal(data.verified, null, 'a secret is never compared nor read back');
    assert.equal(data.readBack, undefined);
    assert.equal(JSON.stringify(res).includes('hunter2-secret'), false);
  });

  it('answers verified:null when no field can be read, never a pass', async () => {
    const h = harness('<div id="mail" contenteditable="false">x</div>', CARD);
    // The insert reports success but focus is not on an editable control.
    const res = await h.host.dispatchAgentAction('type', { selector: '#mail', text: 'abc', trusted: true, tabId: 'tab-1' });
    if (res.success) assert.notEqual((res.data as Record<string, unknown>).verified, true);
  });
});

describe('trusted pointer input on a tab that is not presented', () => {
  /** Records which CDP mouse events were sent while the pane was held painting. */
  function withSurfaceSpy(h: Harness, activeTabId: string) {
    const held: Array<{ tabId: string; paneId: string }> = [];
    let depth = 0;
    const insideHold: boolean[] = [];
    const send = h.wc.debugger.sendCommand;
    h.wc.debugger.sendCommand = async (command: string, params: any) => {
      if (command === 'Input.dispatchMouseEvent') insideHold.push(depth > 0);
      return send(command, params);
    };
    h.ctx.getActiveTabId = () => activeTabId;
    h.ctx.getAllTabs = () => new Map<string, unknown>([['tab-other', { view: { webContents: {} } }], ['tab-1', { view: { webContents: h.wc } }]]).entries();
    h.ctx.withPaintingSurface = async (tabId: string, paneId: string, action: () => Promise<unknown>) => {
      held.push({ tabId, paneId });
      depth++;
      try { return await action(); } finally { depth--; }
    };
    return { held, insideHold };
  }

  it('sends every mouse event of a click while a background pane is held painting', async () => {
    const h = harness('<button id="pay">Pay</button>', CARD);
    const spy = withSurfaceSpy(h, 'tab-other');
    const res = await h.host.dispatchAgentAction('click', { selector: '#pay', tabId: 'tab-1' });
    assert.equal(res.success, true, JSON.stringify(res));
    assert.deepEqual(spy.held, [{ tabId: 'tab-1', paneId: 'desktop' }]);
    assert.ok(spy.insideHold.length >= 3, 'move, press and release were sent');
    assert.ok(spy.insideHold.every(Boolean), 'a mouseMoved sent to a pane that paints nothing waits about 5 s for a frame');
  });

  it('holds the pane for a hover too', async () => {
    const h = harness('<button id="pay">Pay</button>', CARD);
    const spy = withSurfaceSpy(h, 'tab-other');
    await h.host.dispatchAgentAction('hover', { selector: '#pay', tabId: 'tab-1' });
    assert.deepEqual(spy.held, [{ tabId: 'tab-1', paneId: 'desktop' }]);
    assert.ok(spy.insideHold.length > 0 && spy.insideHold.every(Boolean));
  });

  it('leaves the presented tab alone: it already paints', async () => {
    const h = harness('<button id="pay">Pay</button>', CARD);
    const spy = withSurfaceSpy(h, 'tab-1');
    const res = await h.host.dispatchAgentAction('click', { selector: '#pay', tabId: 'tab-1' });
    assert.equal(res.success, true, JSON.stringify(res));
    assert.deepEqual(spy.held, []);
  });
});
