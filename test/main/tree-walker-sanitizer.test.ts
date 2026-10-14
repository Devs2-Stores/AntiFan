import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { buildTreeWalkerSanitizerScript } from '../../src/main/tools/adapters/tree-walker-sanitizer';

interface JsdomLike {
  window: Window & typeof globalThis & { eval: (src: string) => unknown };
}

type JsdomCtor = new (html: string, options?: Record<string, unknown>) => JsdomLike;

/**
 * jsdom is a transitive dep; when the shared node_modules copy is broken the
 * test honors ANTIFAN_JSDOM (a dir containing node_modules/jsdom) and skips
 * with the resolution error as the named blocker.
 */
function loadJsdom(): { JSDOM: JsdomCtor } {
  const req = createRequire(__filename);
  const searchPaths = process.env.ANTIFAN_JSDOM
    ? [process.env.ANTIFAN_JSDOM, path.dirname(__filename)]
    : [path.dirname(__filename)];
  try {
    const resolved = req.resolve('jsdom', { paths: searchPaths });
    // jsdom ships no bundled types; the parsed module is asserted to its documented export shape.
    const jsdomModule = req(resolved) as unknown as { JSDOM: JsdomCtor };
    return { JSDOM: jsdomModule.JSDOM };
  } catch (err) {
    throw new Error(`jsdom is a declared devDependency and a hard prerequisite of this suite; resolution failed (searched: ${searchPaths.join(', ')}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

describe('buildTreeWalkerSanitizerScript parity gating', () => {
  it('does not inject clone parity CSS, overflow-x hidden, or interactivity JS on a generic storefront document', () => {
    const html = `<!DOCTYPE html>
<html>
  <head><title>Generic Storefront</title></head>
  <body>
    <header class="site-header"><nav><a href="/collections/all">Shop</a></nav></header>
    <main wire:id="123" x-data="{ open: false }">
      <!-- SSR comment -->
      <section class="hero"><img src="https://cdn.example.com/banner.jpg" loading="lazy"></section>
    </main>
  </body>
</html>`;
    const { JSDOM } = loadJsdom();
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const script = buildTreeWalkerSanitizerScript();
    const cleaned = String(dom.window.eval(script));

    assert.ok(!cleaned.includes('antifan-clone-parity'), 'generic storefront must not receive #antifan-clone-parity');
    assert.ok(!cleaned.includes('overflow-x: hidden !important'), 'generic storefront must not mask horizontal overflow');
    assert.ok(
      !cleaned.includes('antifan-clone-interactivity'),
      'generic storefront must not receive #antifan-clone-interactivity'
    );
    assert.ok(!cleaned.includes('wire:id'), 'Livewire attributes must still be stripped');
    assert.ok(!cleaned.includes('x-data'), 'Alpine attributes must still be stripped');
    assert.ok(!cleaned.includes('SSR comment'), 'HTML comments must still be stripped');
  });

  it('injects both #antifan-clone-parity and #antifan-clone-interactivity when #category-navigation__sub is present', () => {
    const html = `<!DOCTYPE html>
<html>
  <head><title>Category Navigation Storefront</title></head>
  <body>
    <div class="category-navigation">
      <div class="category-navigation__list"><ul><li><p><a href="/cat">Cat</a></p></li></ul></div>
      <div id="category-navigation__sub"><div class="sub-menu">Sub</div></div>
    </div>
  </body>
</html>`;
    const { JSDOM } = loadJsdom();
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const script = buildTreeWalkerSanitizerScript();
    const cleaned = String(dom.window.eval(script));

    assert.ok(cleaned.includes('id="antifan-clone-parity"'), 'document with #category-navigation__sub must receive parity style');
    assert.ok(
      cleaned.includes('id="antifan-clone-interactivity"'),
      'document with #category-navigation__sub must receive interactivity script'
    );
  });
});
