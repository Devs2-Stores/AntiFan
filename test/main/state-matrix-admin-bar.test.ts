// The open-state measurement subtracts the platform admin/preview bar from a fixed panel's position:
// the bar's own measured height, for any bar in the shared preview-chrome list, not one script's 40px.
// jsdom has no layout, so each element's box is supplied through a data-rect attribute.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { createRequire } from 'node:module';
import { buildMeasureOpenScript, buildPrepareScript, smPanelSelector, smTriggerSelector } from '../../src/main/qa/state-matrix';
import { PLATFORM_PREVIEW_CHROME_SELECTORS } from '../../src/main/qa/platform-preview-chrome';

type Dom = { window: { eval(code: string): unknown } };

function openDom(html: string): Dom {
  const req = createRequire(__filename);
  const jsdomPath = req.resolve('jsdom', { paths: process.env.ANTIFAN_JSDOM ? [process.env.ANTIFAN_JSDOM, __dirname] : [__dirname] });
  const { JSDOM } = req(jsdomPath) as { JSDOM: new (html: string, opts: Record<string, unknown>) => Dom };
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'outside-only', url: 'https://shop.example.com/' });
  dom.window.eval(`
    Element.prototype.getBoundingClientRect = function () {
      const raw = this.getAttribute('data-rect');
      const [left, top, width, height] = raw ? raw.split(',').map(Number) : [0, 0, 0, 0];
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this; } };
    };
    document.elementFromPoint = function () { return null; };
  `);
  return dom;
}

// 1024x768 viewport; the drawer is pushed down by a 60px bar and so hangs 60px below the fold.
const PANEL = `<aside id="panel" ${smPanelSelector(0).slice(1, -1)} role="dialog" aria-modal="true" style="position:fixed;top:60px;right:0;width:300px;height:768px" data-rect="724,60,300,768"><h2>Giỏ hàng</h2></aside>`;

function measure(html: string): { opened: boolean; withinViewport: boolean } {
  const dom = openDom(html);
  return dom.window.eval(buildMeasureOpenScript(0, 'drawer', null)) as { opened: boolean; withinViewport: boolean };
}

describe('state matrix admin bar offset', () => {
  it('subtracts the measured height of a fixed preview bar from a drawer laid out below it', () => {
    const bar = '<div id="preview-bar-iframe" style="position:fixed;top:0;left:0;right:0;height:60px" data-rect="0,0,1024,60"></div>';
    const res = measure(bar + PANEL);
    assert.strictEqual(res.opened, true);
    assert.strictEqual(res.withinViewport, true, 'a 60px bar shifts the drawer by 60px, which shoppers never see');
  });

  it('measures the bar for every selector in the shared preview-chrome list that can be a plain element', () => {
    const plain = PLATFORM_PREVIEW_CHROME_SELECTORS.filter((s) => /^[#.][\w-]+$/.test(s));
    assert.ok(plain.length >= 5, 'the shared list carries id and class selectors');
    for (const selector of plain) {
      const attr = selector[0] === '#' ? `id="${selector.slice(1)}"` : `class="${selector.slice(1)}"`;
      const bar = `<div ${attr} style="position:fixed;top:0;left:0;right:0;height:60px" data-rect="0,0,1024,60"></div>`;
      assert.strictEqual(measure(bar + PANEL).withinViewport, true, `${selector} must be measured as a preview bar`);
    }
  });

  it('still reports a drawer pushed below the fold when no preview bar is on the page', () => {
    assert.strictEqual(measure(PANEL).withinViewport, false);
  });

  it('does not treat an ordinary fixed header as a preview bar', () => {
    const header = '<header id="site-header" style="position:fixed;top:0;left:0;right:0;height:60px" data-rect="0,0,1024,60"></header>';
    assert.strictEqual(measure(header + PANEL).withinViewport, false, 'theme chrome is part of the shopper view');
  });

  it('leaves a drawer that sits under the bar at the top of the viewport unshifted', () => {
    const bar = '<div id="preview-bar-iframe" style="position:fixed;top:0;left:0;right:0;height:60px" data-rect="0,0,1024,60"></div>';
    const under = PANEL.replace('top:60px', 'top:0').replace('data-rect="724,60,300,768"', 'data-rect="724,0,300,768"');
    const res = measure(bar + under);
    assert.strictEqual(res.withinViewport, true);
  });

  it('ignores a hidden or non-fixed bar', () => {
    const hidden = '<div id="preview-bar-iframe" style="position:fixed;display:none;top:0;left:0;right:0;height:60px" data-rect="0,0,1024,60"></div>';
    assert.strictEqual(measure(hidden + PANEL).withinViewport, false);
    const flow = '<div id="preview-bar-iframe" style="position:static;height:60px" data-rect="0,0,1024,60"></div>';
    assert.strictEqual(measure(flow + PANEL).withinViewport, false);
  });
});

describe('state matrix admin bar offset across prepare and measure', () => {
  const TRIGGER = `<button id="open" ${smTriggerSelector(0).slice(1, -1)}>Giỏ hàng</button>`;
  const BAR = '<div id="preview-bar-iframe" style="position:fixed;top:0;left:0;right:0;height:60px" data-rect="0,0,1024,60"></div>';

  function prepareThenMeasure(html: string): { withinViewport: boolean; barHidden: boolean } {
    const dom = openDom(html);
    dom.window.eval('Element.prototype.scrollIntoView = function () {};');
    const prepared = dom.window.eval(buildPrepareScript(0)) as { ok: boolean };
    assert.strictEqual(prepared.ok, true);
    const barHidden = dom.window.eval(`getComputedStyle(document.getElementById('preview-bar-iframe') || document.body).display`) === 'none';
    const res = dom.window.eval(buildMeasureOpenScript(0, 'drawer', null)) as { withinViewport: boolean };
    return { withinViewport: res.withinViewport, barHidden };
  }

  it('still subtracts the preview bar height after prepare has hidden the bar', () => {
    const res = prepareThenMeasure(BAR + TRIGGER + PANEL);
    assert.strictEqual(res.barHidden, true, 'prepare hides the preview chrome before the open measurement');
    assert.strictEqual(res.withinViewport, true, 'the bar was measured before it was hidden');
  });

  it('keeps the measured bar height when a later prepare runs with the bar already hidden', () => {
    const dom = openDom(BAR + TRIGGER + PANEL);
    dom.window.eval('Element.prototype.scrollIntoView = function () {};');
    dom.window.eval(buildPrepareScript(0));
    dom.window.eval(buildPrepareScript(0, false));
    const res = dom.window.eval(buildMeasureOpenScript(0, 'drawer', null)) as { withinViewport: boolean };
    assert.strictEqual(res.withinViewport, true);
  });

  it('does not forgive a drawer below the fold when the page has no preview bar', () => {
    assert.strictEqual(prepareThenMeasure(TRIGGER + PANEL).withinViewport, false);
  });
});
