/**
 * The tab preload reports `antifan:dom-mutation` when the page changes its own DOM; that
 * report advances the mutation revision the visual compare guard reads to decide whether a
 * raster was taken over a still document. AntiFan's own instrumentation (the screenshot guard
 * style injected for every raster, the agent overlay) and attribute writes that leave the
 * value unchanged are not the page changing, so they must not be reported — otherwise every
 * compare on a live storefront resamples itself into INCONCLUSIVE.
 *
 * The compiled preload runs unmodified inside a JSDOM window with `electron` replaced by a
 * recorder and the window's timers replaced by a queue the rows drain, so these rows observe
 * the real observer, filter and debounce without waiting on the clock.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
// @ts-ignore jsdom ships no type declarations (same as theme-qa-automation-stack.test.ts)
import { JSDOM } from 'jsdom';
import { DEFAULT_DOM_QUIET_IGNORE } from '../../src/main/verification/capture-settle';
import { DEFAULT_STOREFRONT_WIDGETS } from '../../src/main/tools/browser-control-port';

const PRELOAD = path.join(__dirname, '..', '..', 'src', 'preload', 'tab-preload.js');

let dom: { window: any; getInternalVMContext(): vm.Context };
let sent: string[];
let samples: Array<{ sample?: string }>;
let timers: Map<number, () => void>;

/** Deliver pending MutationObserver records, then run every queued timer until none remain. */
async function drain(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));
    if (timers.size === 0) return;
    const due = Array.from(timers.values());
    timers.clear();
    for (const fn of due) fn();
  }
}
const mutationReports = () => sent.filter((c) => c === 'antifan:dom-mutation').length;

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html class="js"><head></head><body class="page"><header class="site-header"></header></body></html>', {
    url: 'https://shop.example/',
    runScripts: 'outside-only',
  });
  sent = [];
  samples = [];
  timers = new Map();
  let nextTimer = 1;
  dom.window.setTimeout = (fn: () => void) => {
    const id = nextTimer++;
    timers.set(id, fn);
    return id;
  };
  dom.window.clearTimeout = (id: number) => {
    timers.delete(id);
  };
  const electron = {
    ipcRenderer: {
      send: (channel: string, payload?: { sample?: string }) => {
        sent.push(channel);
        if (channel === 'antifan:dom-mutation') samples.push(payload ?? {});
      },
      invoke: async () => undefined,
      on: () => undefined,
    },
  };
  const wrapped = vm.runInContext(`(function (require, exports, module) {\n${fs.readFileSync(PRELOAD, 'utf8')}\n})`, dom.getInternalVMContext());
  const mod = { exports: {} };
  wrapped((name: string) => {
    if (name === 'electron') return electron;
    throw new Error(`unexpected require: ${name}`);
  }, mod.exports, mod);
  await drain();
  sent.length = 0;
  samples.length = 0;
});

afterEach(async () => {
  await drain();
  timers.clear();
});

describe('tab preload DOM mutation report', () => {
  it('reports a node the page inserts', async () => {
    dom.window.document.body.appendChild(dom.window.document.createElement('div'));
    await drain();
    assert.strictEqual(mutationReports(), 1);
  });

  it('does not report the screenshot guard style injected and removed around a raster', async () => {
    const doc = dom.window.document;
    const style = doc.createElement('style');
    style.id = '__antifan_screenshot_guard__';
    style.textContent = '#haravan-notification { display: none !important; }';
    doc.head.appendChild(style);
    await drain();
    style.remove();
    await drain();
    assert.strictEqual(mutationReports(), 0);
  });

  it('does not report class changes on the AntiFan agent overlay', async () => {
    const doc = dom.window.document;
    const overlay = doc.createElement('div');
    overlay.id = '__antifan_agent_overlay__';
    doc.body.appendChild(overlay);
    await drain();
    overlay.classList.add('suppressed');
    overlay.classList.remove('suppressed');
    await drain();
    assert.strictEqual(mutationReports(), 0);
  });

  it('does not report a class write that leaves the token set unchanged', async () => {
    const doc = dom.window.document;
    doc.documentElement.classList.remove('modal-open');
    doc.body.classList.remove('layoutProduct_scroll');
    doc.querySelector('header').className = 'site-header';
    await drain();
    assert.strictEqual(mutationReports(), 0);
  });

  it('reports a class change the page makes', async () => {
    dom.window.document.querySelector('header').classList.add('is-scrolled');
    await drain();
    assert.strictEqual(mutationReports(), 1);
  });

  it('reports a page mutation that lands in the same batch as an AntiFan one', async () => {
    const doc = dom.window.document;
    const style = doc.createElement('style');
    style.id = '__antifan_screenshot_guard__';
    doc.head.appendChild(style);
    doc.body.setAttribute('aria-hidden', 'true');
    await drain();
    assert.strictEqual(mutationReports(), 1);
  });

  it('does not report a live countdown rewriting its digits', async () => {
    const doc = dom.window.document;
    const timer = doc.createElement('div');
    timer.setAttribute('role', 'timer');
    timer.innerHTML = '<span><strong>09</strong></span>';
    doc.body.appendChild(timer);
    await drain();
    sent.length = 0;
    timer.querySelector('strong').textContent = '08';
    timer.querySelector('strong').textContent = '07';
    await drain();
    assert.strictEqual(mutationReports(), 0);
  });

  it('still reports a class change next to a countdown', async () => {
    const doc = dom.window.document;
    const timer = doc.createElement('div');
    timer.setAttribute('role', 'timer');
    doc.body.appendChild(timer);
    await drain();
    sent.length = 0;
    timer.textContent = '00';
    doc.querySelector('header').classList.add('is-scrolled');
    await drain();
    assert.strictEqual(mutationReports(), 1);
  });

  it('does not report a toast, a social-proof pop-up or a masked storefront widget changing', async () => {
    const doc = dom.window.document;
    const fixtures: Array<[string, string]> = [
      ['div', 'toast'],
      ['div', 'sale pop-sale-card'],
      ['div', 'chat-widget'],
    ];
    for (const [tag, className] of fixtures) {
      const el = doc.createElement(tag);
      el.className = className;
      el.innerHTML = '<span>one</span>';
      doc.body.appendChild(el);
    }
    const popup = doc.createElement('div');
    popup.id = 'fake-order-popup';
    popup.innerHTML = '<b>a</b>';
    doc.body.appendChild(popup);
    const visitors = doc.createElement('span');
    visitors.setAttribute('data-live-visitor', '');
    visitors.textContent = '12';
    doc.body.appendChild(visitors);
    await drain();
    sent.length = 0;
    for (const el of Array.from(doc.body.querySelectorAll('span, b')) as Array<{ textContent: string | null }>) el.textContent = 'changed';
    doc.querySelector('#fake-order-popup')!.appendChild(doc.createElement('i'));
    await drain();
    assert.strictEqual(mutationReports(), 0);
  });

  it('reports the element that moved, bounded and without page-controlled control characters', async () => {
    const doc = dom.window.document;
    const el = doc.createElement('section');
    el.id = 'cart-drawer';
    el.className = 'drawer is-open';
    doc.body.appendChild(el);
    await drain();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(samples)), [{ sample: 'body.page + section#cart-drawer.drawer.is-open' }]);

    samples.length = 0;
    const long = doc.createElement('div');
    long.className = 'x'.repeat(400);
    doc.body.appendChild(long);
    await drain();
    assert.strictEqual(samples.length, 1);
    const sample = samples[0]!.sample ?? '';
    assert.ok(sample.length <= 120, `sample must be at most 120 chars, got ${sample.length}`);
    assert.ok(sample.startsWith('body.page + div.xxxx'));
  });

  it('keeps the first accepted mutation of a debounce window as the sample', async () => {
    const doc = dom.window.document;
    doc.querySelector('header').classList.add('is-scrolled');
    doc.body.appendChild(doc.createElement('footer'));
    await drain();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(samples)), [{ sample: 'header.site-header.is-scrolled @class' }]);
  });

  it('lists every DOM-quiet ignore selector and the masked storefront widgets as volatile regions', () => {
    const source = fs.readFileSync(PRELOAD, 'utf8');
    const literal = /const VOLATILE_REGION = \[([\s\S]*?)\]\.join/.exec(source);
    assert.ok(literal, 'the preload must declare VOLATILE_REGION as an array literal');
    const region = new Set(Array.from(literal[1]!.matchAll(/'((?:[^'\\]|\\.)*)'/g), (m) => m[1]));
    for (const selector of DEFAULT_DOM_QUIET_IGNORE) {
      assert.ok(region.has(selector), `DOM-quiet ignore selector ${selector} is missing from the preload's VOLATILE_REGION`);
    }
    const maskedWidgets = DEFAULT_STOREFRONT_WIDGETS.filter((selector) => /fake-order|notice-cart|haravan-notification|chat-widget|zalo-chat|toast-container/.test(selector));
    assert.ok(maskedWidgets.length >= 5, 'the default widget mask list lost the notification/chat widgets this parity covers');
    for (const selector of maskedWidgets) {
      assert.ok(region.has(selector), `masked widget selector ${selector} is missing from the preload's VOLATILE_REGION`);
    }
  });
});
