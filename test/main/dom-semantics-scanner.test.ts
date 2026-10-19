import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { DomSemanticsScanner, type DomSemanticsScanResult } from '../../src/main/qa/scanners/dom-semantics-scanner';

type JsdomCtor = new (html: string, options?: Record<string, unknown>) => {
  window: Window & typeof globalThis & { eval: (src: string) => unknown };
};

function loadJsdom(): JsdomCtor {
  const req = createRequire(__filename);
  const searchPaths = process.env.ANTIFAN_JSDOM
    ? [process.env.ANTIFAN_JSDOM, path.dirname(__filename)]
    : [path.dirname(__filename)];
  const resolved = req.resolve('jsdom', { paths: searchPaths });
  // jsdom ships no bundled types; the module is asserted to its documented export shape.
  const jsdomModule = req(resolved) as { JSDOM: JsdomCtor };
  return jsdomModule.JSDOM;
}

const PAGE = `<!doctype html><html lang="vi"><head><title>Lux</title>
<meta name="description" content="Rượu vang nhập khẩu chính hãng, quà tặng doanh nghiệp và tư vấn chọn rượu cho mọi dịp.">
</head><body>
<h1>Một</h1><h1>Hai</h1>
<img src="a.png"><img src="b.png" alt="Chai vang">
<label for='q"x'>Email</label><input id='q"x' type="email">
<input id="bare" type="text">
<textarea id="g-recaptcha-response" style="display: none;"></textarea>
<div hidden><input id="in-hidden-parent" type="text"></div>
<input id="invisible" type="text" style="visibility: hidden">
<button type="button"></button>
<button type="button" style="display:none"></button>
</body></html>`;

describe('DomSemanticsScanner browser script', () => {
  it('runs in a real page and agrees with evaluateDom, including the label lookup without CSS.escape', () => {
    const JSDOM = loadJsdom();
    const dom = new JSDOM(PAGE, { runScripts: 'outside-only' });
    // Force the fallback id escaping that the injected script uses on engines without CSS.escape.
    Reflect.set(dom.window, 'CSS', undefined);
    const injected = dom.window.eval(DomSemanticsScanner.getBrowserScanScript()) as DomSemanticsScanResult;
    const direct = DomSemanticsScanner.evaluateDom(dom.window.document, 1024);

    assert.strictEqual(injected.measured, true);
    assert.strictEqual(injected.summary.h1Count, 2);
    assert.strictEqual(injected.summary.imgMissingAltCount, 1);
    assert.strictEqual(injected.summary.formControlsMissingLabelCount, 1, 'only #bare is unlabeled; the quoted id resolves its label and unrendered controls are not in the accessibility tree');
    assert.strictEqual(injected.summary.controlsMissingNameCount, 1, 'the display:none button is not in the accessibility tree');
    for (const key of ['h1Count', 'imgMissingAltCount', 'controlsMissingNameCount', 'formControlsMissingLabelCount', 'duplicateIdCount', 'jsonLdInvalidCount'] as const) {
      assert.strictEqual(injected.summary[key], direct.summary[key], `${key} must match evaluateDom`);
    }
  });

  it('reads the id attribute of an add-to-cart form whose <input name="id"> clobbers form.id', () => {
    const JSDOM = loadJsdom();
    const pdp = `<!doctype html><html lang="vi"><head><title>PDP</title></head><body><h1>Áo</h1>
<form id="add-to-cart-form" action="/cart/add"><input type="hidden" name="id" value="101"><button type="submit">Mua</button></form>
<form id="add-to-cart-form" action="/cart/add"><input type="hidden" name="id" value="102"><button type="submit">Mua</button></form>
</body></html>`;
    const dom = new JSDOM(pdp, { runScripts: 'outside-only' });
    // jsdom does not implement HTMLFormElement's [LegacyOverrideBuiltIns] named getter; Chromium does,
    // so form.id is the <input name="id"> element there. Reproduce that shape on each form.
    for (const form of Array.from(dom.window.document.querySelectorAll('form'))) {
      Object.defineProperty(form, 'id', { configurable: true, get: () => form.querySelector('input[name="id"]') });
    }
    const injected = dom.window.eval(DomSemanticsScanner.getBrowserScanScript()) as DomSemanticsScanResult;
    const direct = DomSemanticsScanner.evaluateDom(dom.window.document, 1024);

    assert.strictEqual(injected.measured, true);
    assert.strictEqual(injected.summary.duplicateIdCount, 1);
    assert.strictEqual(direct.summary.duplicateIdCount, 1);
  });
});
