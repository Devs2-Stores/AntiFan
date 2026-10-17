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

const PRELOAD = path.join(__dirname, '..', '..', 'src', 'preload', 'tab-preload.js');

let dom: { window: any; getInternalVMContext(): vm.Context };
let sent: string[];
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
  const electron = { ipcRenderer: { send: (channel: string) => sent.push(channel), invoke: async () => undefined, on: () => undefined } };
  const wrapped = vm.runInContext(`(function (require, exports, module) {\n${fs.readFileSync(PRELOAD, 'utf8')}\n})`, dom.getInternalVMContext());
  const mod = { exports: {} };
  wrapped((name: string) => {
    if (name === 'electron') return electron;
    throw new Error(`unexpected require: ${name}`);
  }, mod.exports, mod);
  await drain();
  sent.length = 0;
});

afterEach(async () => {
  await drain();
  timers.clear();
  dom.window.close();
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
});
