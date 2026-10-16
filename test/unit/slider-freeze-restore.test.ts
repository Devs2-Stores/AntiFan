// Slider motion stopped for a capture is put back afterwards: Swiper autoplay restarts only when the
// freeze stopped it, and inline animation/transition return to the page's own values.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
// @ts-ignore jsdom ships no type declarations (same as theme-qa-automation-stack.test.ts)
import { JSDOM } from 'jsdom';
import { InjectedScriptStore } from '../../src/main/browser/scripts/injected-script-store';
import { CAPTURE_SLIDER_HOLD_SCRIPT, CAPTURE_SLIDER_RELEASE_SCRIPT } from '../../src/main/browser/tab-devtools-host';

function page() {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body>' +
      '<div class="swiper" id="running" style="transition: opacity 1s"><div class="swiper-wrapper"></div></div>' +
      '<div class="swiper" id="stopped"><div class="swiper-wrapper"></div></div>' +
      '</body></html>',
    { runScripts: 'outside-only' }
  );
  const calls: string[] = [];
  const attach = (id: string, running: boolean) => {
    const autoplay = {
      running,
      stop() { calls.push(`${id}:stop`); autoplay.running = false; },
      start() { calls.push(`${id}:start`); autoplay.running = true; },
    };
    (dom.window.document.getElementById(id) as any).swiper = { autoplay };
    return autoplay;
  };
  return { dom, calls, running: attach('running', true), stopped: attach('stopped', false) };
}

describe('slider motion restore', () => {
  it('media.freeze with normalizeSliders restarts only the autoplay it stopped', () => {
    const { dom, calls, running, stopped } = page();
    const store = new InjectedScriptStore({ overrideDir: null });
    dom.window.eval(store.getScript('media.freeze', { freeze: true, normalizeSliders: true }));
    assert.strictEqual(running.running, false);
    dom.window.eval(store.getScript('media.freeze', { freeze: false }));
    assert.strictEqual(running.running, true, 'the autoplay the freeze stopped runs again');
    assert.strictEqual(stopped.running, false, 'an autoplay the page had stopped stays stopped');
    assert.deepStrictEqual(calls, ['running:stop', 'running:start']);
  });

  it('the capture hold puts inline styles and autoplay back on release', () => {
    const { dom, running, stopped } = page();
    const el = dom.window.document.getElementById('running') as HTMLElement;
    assert.strictEqual(dom.window.eval(CAPTURE_SLIDER_HOLD_SCRIPT) > 0, true);
    assert.strictEqual(el.style.getPropertyValue('transition'), 'none');
    assert.strictEqual(el.style.getPropertyPriority('transition'), 'important');
    assert.strictEqual(el.style.getPropertyValue('animation-play-state'), 'paused');
    assert.strictEqual(running.running, false);

    dom.window.eval(CAPTURE_SLIDER_RELEASE_SCRIPT);
    assert.strictEqual(el.style.getPropertyValue('transition'), 'opacity 1s');
    assert.strictEqual(el.style.getPropertyPriority('transition'), '');
    assert.strictEqual(el.style.getPropertyValue('animation-play-state'), '');
    assert.strictEqual(running.running, true);
    assert.strictEqual(stopped.running, false);
    assert.strictEqual(dom.window.eval(CAPTURE_SLIDER_RELEASE_SCRIPT), 0, 'a second release has nothing to undo');
  });
});
