import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  sanitizeSectionMarkup,
  decodeHtmlEntities,
  extractEmbeddedEffects,
  localizeSameOriginReferences,
  stripCaptureTimeSliderGeometry,
  IndependentHtmlCloneGenerator
} from './independent-html-clone-generator.js';
import { createDefaultComponentContractIR, type ComponentContractIR } from '../models/clone-ir.js';

describe('IndependentHtmlCloneGenerator - section sanitation', () => {
  it('drops inert <noscript> fallbacks that point at live third-party services', () => {
    const section = [
      '<div class="cf-col-12">',
      '<span class="wpcf7-recaptcha g-recaptcha"></span>',
      '<noscript><div class="grecaptcha-noscript">',
      '<iframe src="https://www.google.com/recaptcha/api/fallback?k=6LdpDYgnAAAAAKHiOkefq1qdV8oSqzQShVa9yMRH" width="310" height="430"></iframe>',
      '<textarea name="g-recaptcha-response" rows="3"></textarea>',
      '</div></noscript>',
      '</div>'
    ].join('');

    const sanitized = sanitizeSectionMarkup(section);

    assert.ok(!/<noscript/i.test(sanitized), 'noscript markup must not survive into the bundle');
    assert.ok(!sanitized.includes('recaptcha/api/fallback'), 'the live captcha endpoint must not survive');
    assert.ok(sanitized.includes('wpcf7-recaptcha'), 'the rendered element stays byte-identical');
  });

  it('keeps ordinary markup untouched', () => {
    const section = '<section class="hero"><img src="assets/hero.png" alt="Hero"></section>';
    assert.strictEqual(sanitizeSectionMarkup(section), section);
  });

  it('promotes lazy placeholders to their real targets so the bundle needs no lazy runtime', () => {
    const placeholder = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';
    const section = `<div class="img-inner"><img class="lazy" src="${placeholder}" width="1920" height="500" data-src="assets/hero.jpg" data-srcset="assets/hero.jpg 1920w, assets/hero-420.jpg 420w"></div>`;

    const sanitized = sanitizeSectionMarkup(section);

    assert.ok(sanitized.includes('src="assets/hero.jpg"'), 'the deferred source becomes the rendered source');
    assert.ok(
      sanitized.includes('srcset="assets/hero.jpg 1920w, assets/hero-420.jpg 420w"'),
      'the deferred srcset becomes the rendered srcset'
    );
    assert.ok(!/\ssrc="data:/.test(sanitized), 'no base64 placeholder survives as the rendered source');
  });

  it('never replaces an image source that already points at a real file', () => {
    const section = '<img src="assets/real.jpg" data-src="assets/other.jpg" alt="">';

    const sanitized = sanitizeSectionMarkup(section);

    assert.ok(/\ssrc="assets\/real\.jpg"/.test(sanitized), 'a real rendered source wins over the deferred attribute');
    assert.ok(!/\ssrc="assets\/other\.jpg"/.test(sanitized), 'the deferred attribute must not overwrite it');
  });

  it('is stable when already-promoted markup is sanitized again', () => {
    const promoted = '<img src="assets/hero.jpg" srcset="assets/hero.jpg 1920w">';
    assert.strictEqual(sanitizeSectionMarkup(sanitizeSectionMarkup(promoted)), promoted);
  });

  it('strips inert wire:* attributes and Livewire comments while preserving content', () => {
    const section = [
      '<!--[if BLOCK]><![endif]-->',
      '<div wire:snapshot="{&quot;data&quot;:{}}" wire:effects="[]" wire:id="abc123xyz" class="product-card">',
      '<a href="/product/1" wire:navigate="" class="product-link">Product 1</a>',
      '<button wire:click="addToCart" class="btn">Add</button>',
      '</div>',
      '<!--[if ENDBLOCK]><![endif]-->'
    ].join('');

    const sanitized = sanitizeSectionMarkup(section);

    assert.ok(!/wire:/i.test(sanitized), 'no wire: attributes should survive');
    assert.ok(!/<!--\[if/i.test(sanitized), 'no Livewire block comments should survive');
    assert.ok(sanitized.includes('class="product-card"'), 'element classes remain intact');
    assert.ok(sanitized.includes('Product 1'), 'element content remains intact');
  });

  it('strips data-update-uri and livewire script tags', () => {
    const section = [
      '<div data-update-uri="/livewire/update" data-navigate-once="true">',
      '<script src="/livewire/livewire.min.js?id=40a765a4"></script>',
      '<p>Store content</p>',
      '</div>'
    ].join('');

    const sanitized = sanitizeSectionMarkup(section);

    assert.ok(!sanitized.includes('data-update-uri'), 'data-update-uri must not survive');
    assert.ok(!sanitized.includes('livewire.min.js'), 'livewire script must not survive');
    assert.ok(sanitized.includes('<p>Store content</p>'), 'pure content remains');
  });

  it('strips Alpine x-data, x-bind, x-on, @click, and block comments', () => {
    const sample = [
      '<li x-data="{ open: false }" :class="{ \'show\': open }" @click="open = true">',
      '<!--[if BLOCK]><![endif]-->',
      '<span x-on:click="open = !open">Click</span>',
      '<!--[if ENDBLOCK]><![endif]-->',
      '</li>'
    ].join('');
    const sanitized = sanitizeSectionMarkup(sample);
    assert.ok(!sanitized.includes('x-data'));
    assert.ok(!sanitized.includes('x-on:click'));
    assert.ok(!sanitized.includes('@click'));
    assert.ok(!sanitized.includes('<!--[if'));
  });

  it('strips third-party trackers, analytics, and iframes', () => {
    const sample = [
      '<div>',
      '<script src="https://www.googletagmanager.com/gtag/js?id=G-123"></script>',
      '<script>gtag("event", "page_view");</script>',
      '<script src="https://embed.tawk.to/xyz"></script>',
      '<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-123"></iframe>',
      '<p>Clean content</p>',
      '</div>'
    ].join('');
    const sanitized = sanitizeSectionMarkup(sample);
    assert.ok(!sanitized.includes('googletagmanager'));
    assert.ok(!sanitized.includes('gtag'));
    assert.ok(!sanitized.includes('tawk.to'));
    assert.ok(sanitized.includes('<p>Clean content</p>'));
  });

  it('converts loading="lazy" to loading="eager" on images', () => {
    const sample = '<img loading="lazy" src="assets/image.png" alt="Test">';
    const sanitized = sanitizeSectionMarkup(sample);
    assert.ok(sanitized.includes('loading="eager"'));
    assert.ok(!sanitized.includes('loading="lazy"'));
  });

  it('preserves flexbox utility classes like flex-center-between and flex-inline-center', () => {
    const sample = '<div class="w-100 flex-center-between"><ul class="menu-list flex-inline-center"><li><a class="menu-link flex" href="/">Home</a></li></ul></div>';
    const sanitized = sanitizeSectionMarkup(sample);
    assert.ok(sanitized.includes('class="w-100 flex-center-between"'));
    assert.ok(sanitized.includes('class="menu-list flex-inline-center"'));
    assert.ok(sanitized.includes('class="menu-link flex"'));
    assert.ok(!sanitized.includes('fle"'));
  });
});

describe('IndependentHtmlCloneGenerator - HTML Entity Decoding & Embedded Effects', () => {
  it('decodes HTML entities in the correct order without premature unescaping', () => {
    const input = '&quot;hello&quot; &lt;tag&gt; &amp; &amp;quot;inner&amp;quot;';
    const decoded = decodeHtmlEntities(input);
    assert.strictEqual(decoded, '"hello" <tag> & &quot;inner&quot;');
  });

  it('extracts embedded xjs expressions from wire:effects and ensures safe slick re-initialization', () => {
    const sampleHtml = [
      '<div wire:snapshot="{}" wire:effects="{&quot;returns&quot;:[null],&quot;xjs&quot;:[{&quot;expression&quot;:&quot;\\n                setTimeout(() =&gt; {\\n                    $(\x27.block-category__list\x27).slick({\\n                        slidesToShow: 1.8,\\n                        slidesToScroll: 1,\\n                        responsive: [{\\n                            breakpoint: 480,\\n                            settings: {\\n                                slidesToShow: 2.3\\n                            }\\n                        }]\\n                    });\\n                }, 200)\\n            &quot;}]}">',
      '<div class="block-category__list"></div>',
      '</div>'
    ].join('');

    const effects = extractEmbeddedEffects(sampleHtml);
    assert.strictEqual(effects.length, 1);
    assert.ok(effects[0].includes('setTimeout('), 'preserves setTimeout wrapper');
    assert.ok(effects[0].includes('slidesToShow: 2.3'), 'preserves the exact responsive config');
    assert.ok(effects[0].includes('slick-initialized'), 'wraps with slick-initialized unslick guard');
  });

  it('extracts multiple effects including footer navigation scroll handlers', () => {
    const sampleHtml = [
      '<div wire:effects="{&quot;xjs&quot;:[{&quot;expression&quot;:&quot;let nav = document.getElementById(\x27bottom-nav\x27); window.addEventListener(\x27scroll\x27, () =&gt; {});&quot;}]}"></div>'
    ].join('');

    const effects = extractEmbeddedEffects(sampleHtml);
    assert.strictEqual(effects.length, 1);
    assert.ok(effects[0].includes('bottom-nav'));
    assert.ok(effects[0].includes('addEventListener'));
  });
});

describe('IndependentHtmlCloneGenerator - generateFromMaterializedHtml', () => {
  it('injects parity styles, interactivity script, and data-device attribute', () => {
    const generator = new IndependentHtmlCloneGenerator();
    const sampleHtml = `<!DOCTYPE html><html><head><title>Test</title></head><body><div class="menu-mobile"></div></body></html>`;
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gen-mat-'));
    try {
      const res = generator.generateFromMaterializedHtml(sampleHtml, {
        outputDir: tmpDir,
        entryFilename: 'index.html',
        device: 'web'
      });
      assert.ok(res.html.includes('id="antifan-clone-parity"'), 'must include parity CSS');
      assert.ok(res.html.includes('id="antifan-clone-interactivity"'), 'must include interactivity JS');
      const scriptMatch = res.html.match(/<script id="antifan-clone-interactivity">([\s\S]*?)<\/script>/);
      assert.ok(scriptMatch && scriptMatch[1].trim().length > 0, 'must contain non-empty interactivity script');
      const vm = require('node:vm');
      assert.doesNotThrow(() => {
        new vm.Script(scriptMatch[1], { filename: 'test-antifan-interactivity-web.js' });
      }, 'Interactivity script in web mode must be 100% valid JS syntax without parse errors');
      assert.ok(res.html.includes('data-device="web"'), 'must set data-device="web"');
      assert.ok(fs.existsSync(res.outputPath));

      // Also test mobile device generation with category-navigation markup to cover the dynamic script branches
      const mobileSample = `<!DOCTYPE html><html><head></head><body data-device="mobile"><div class="category-navigation"><div class="category-navigation__list"><li class="menu-item-1">Item 1</li></div><div id="category-navigation__sub"><div class="sub-menu">Sub 1</div></div></div><div class="slick-slider"><div class="slick-track"><div>Slide 1</div><div>Slide 2</div></div><ul class="slick-dots"><li>1</li><li>2</li></ul></div></body></html>`;
      const mobileRes = generator.generateFromMaterializedHtml(mobileSample, {
        outputDir: tmpDir,
        entryFilename: 'mobile/index.html',
        device: 'mobile'
      });
      const mobileScriptMatch = mobileRes.html.match(/<script id="antifan-clone-interactivity">([\s\S]*?)<\/script>/);
      assert.ok(mobileScriptMatch && mobileScriptMatch[1].trim().length > 0, 'mobile must contain non-empty interactivity script');
      assert.doesNotThrow(() => {
        new vm.Script(mobileScriptMatch[1], { filename: 'test-antifan-interactivity-mobile.js' });
      }, 'Interactivity script in mobile mode with category navigation must be 100% valid JS syntax');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('IndependentHtmlCloneGenerator - localizeSameOriginReferences', () => {
  it('rewrites absolute same-origin anchors to root-relative paths while preserving third-party URLs', () => {
    const sample = [
      '<a href="https://hoplongtech.com/collections/all">All Products</a>',
      '<a href="https://hoplongtech.com">Home</a>',
      '<a href="https://other.com/login">External</a>',
      '<form action="https://hoplongtech.com/search"></form>',
      '<img src="https://hoplongtech.com/assets/img.png">',
      '<img srcset="https://hoplongtech.com/assets/a.jpg 1x, https://hoplongtech.com/assets/b.jpg 2x">'
    ].join('\n');

    const localized = localizeSameOriginReferences(sample, 'https://hoplongtech.com/');

    assert.ok(localized.includes('href="/collections/all"'), 'rewrites path with segment');
    assert.ok(localized.includes('href="/"'), 'rewrites bare domain to root');
    assert.ok(localized.includes('href="https://other.com/login"'), 'preserves third party');
    assert.ok(localized.includes('action="/search"'), 'rewrites action attribute');
    assert.ok(localized.includes('src="/assets/img.png"'), 'rewrites src');
    assert.ok(localized.includes('srcset="/assets/a.jpg 1x, /assets/b.jpg 2x"'), 'rewrites srcset');
  });

  it('leaves html untouched when sourceBaseUrl is missing or invalid', () => {
    const sample = '<a href="https://hoplongtech.com/about">About</a>';
    assert.strictEqual(localizeSameOriginReferences(sample, undefined), sample);
    assert.strictEqual(localizeSameOriginReferences(sample, 'not-a-url'), sample);
  });
});

describe('IndependentHtmlCloneGenerator - Parity Styles & State Overrides', () => {
  it('removes global overflow masking, scrollbar hiding, layout !important, and invented aspect ratio 775/385 from materialized generator', () => {
    const generator = new IndependentHtmlCloneGenerator();
    const sampleHtml = `<!DOCTYPE html><html><head><title>Test</title></head><body><div class="category-navigation"></div><div class="popup-video"></div></body></html>`;
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-parity-styles-'));
    try {
      const res = generator.generateFromMaterializedHtml(sampleHtml, {
        outputDir: tmpDir,
        entryFilename: 'index.html'
      });

      const parityMatch = res.html.match(/<style id="antifan-clone-parity">([\s\S]*?)<\/style>/);
      assert.ok(parityMatch, 'parity style tag must exist');
      const parityCss = parityMatch[1];

      // Must NOT contain global overflow masking
      assert.ok(!parityCss.includes('overflow-x: hidden'), 'must not contain overflow-x: hidden');
      assert.ok(!parityCss.includes('max-width: 100vw'), 'must not contain max-width: 100vw');

      // Must NOT contain scrollbar hiding
      assert.ok(!parityCss.includes('scrollbar-width'), 'must not contain scrollbar-width');
      assert.ok(!parityCss.includes('::-webkit-scrollbar'), 'must not contain ::-webkit-scrollbar');

      // Must NOT contain invented aspect ratio 775/385 or layout !important
      assert.ok(!parityCss.includes('775'), 'must not contain invented 775 aspect ratio');
      assert.ok(!parityCss.includes('385'), 'must not contain invented 385 aspect ratio');
      assert.ok(!parityCss.includes('!important'), 'must not contain unnecessary !important on layout or state');

      // Drawer scoping must not match all inner elements
      assert.ok(!parityCss.includes('[class*="drawer"]:not(.active):not(.show)'), 'must not broadly hide any element with drawer in class');
      assert.ok(parityCss.includes('.drawer:not(.active):not(.show)'), 'must scope to container .drawer');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('removes global overflow masking, scrollbar hiding, and invented aspect ratios from generateCloneBundle', async () => {
    const generator = new IndependentHtmlCloneGenerator();
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bundle-styles-'));
    try {
      const fakeIR = createDefaultComponentContractIR();
      fakeIR.sections = [
        {
          id: 'sec1',
          name: 'Category Navigation',
          archetype: 'header',
          layoutType: 'flex',
          settings: {},
          blocks: [],
          rawHtml: '<header class="category-navigation"><div class="menu-mobile"></div></header>'
        },
        {
          id: 'sec2',
          name: 'Hero Slider',
          archetype: 'product_grid',
          layoutType: 'grid',
          settings: {},
          blocks: [],
          rawHtml: '<section><div class="s-wrap"><div class="s-content"><div class="item"><img src="test.jpg"></div></div></div></section>'
        }
      ];
      const res = await generator.generateCloneBundle(fakeIR, {
        outputDir: tmpDir
      });

      const content = fs.readFileSync(res.entryHtmlPath, 'utf-8');
      const parityMatch = content.match(/<style id="antifan-clone-parity">([\s\S]*?)<\/style>/);
      assert.ok(parityMatch, 'parity style tag must exist in bundle');
      const parityCss = parityMatch[1];

      assert.ok(!parityCss.includes('overflow-x: hidden'), 'bundle must not contain overflow-x: hidden');
      assert.ok(!parityCss.includes('max-width: 100vw'), 'bundle must not contain max-width: 100vw');
      assert.ok(!parityCss.includes('scrollbar-width'), 'bundle must not contain scrollbar-width');
      assert.ok(!parityCss.includes('::-webkit-scrollbar'), 'bundle must not contain ::-webkit-scrollbar');
      assert.ok(!parityCss.includes('775'), 'bundle must not contain invented 775 aspect ratio');
      assert.ok(!parityCss.includes('385'), 'bundle must not contain invented 385 aspect ratio');
      assert.ok(!parityCss.includes('!important'), 'bundle must not contain layout !important');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('IndependentHtmlCloneGenerator - Slider Geometry Normalization', () => {
  it('strips capture-time pixel geometry from tracks and slides but preserves non-slider inline styles', () => {
    const sampleHtml = [
      '<div class="s-wrap">',
      '  <div class="s-content" style="width: 5450px; transform: translateX(0px);">',
      '    <div class="item" style="width: 545px; flex: 0 0 545px; margin-right: 15px; color: red;">Slide 1</div>',
      '  </div>',
      '</div>',
      '<div class="product-item item" style="width: 250px; margin-right: 20px; background: blue;">Ordinary Item</div>'
    ].join('\n');

    const stripped = stripCaptureTimeSliderGeometry(sampleHtml);

    // Slider track and slide inline pixel widths stripped
    assert.ok(!stripped.includes('width: 5450px'), 'track width should be stripped');
    assert.ok(!stripped.includes('width: 545px'), 'slide width should be stripped');
    assert.ok(!stripped.includes('flex: 0 0 545px'), 'slide flex should be stripped');
    assert.ok(stripped.includes('color: red'), 'slide non-geometry style preserved');

    // Non-slider item outside slider track MUST keep its inline width and margin
    assert.ok(stripped.includes('width: 250px'), 'non-slider item width preserved');
    assert.ok(stripped.includes('margin-right: 20px'), 'non-slider item margin preserved');
    assert.ok(stripped.includes('background: blue'), 'non-slider item background preserved');
  });

  it('neutralizes in-flight transforms to zero offset in sanitizeSectionMarkup', () => {
    const sample = '<div class="slick-track" style="transform: translateX(-1090px); transition: 0.3s;">Content</div>';
    const sanitized = sanitizeSectionMarkup(sample);
    assert.ok(sanitized.includes('transform: translateX(0px);'), 'neutralizes translateX');

    const sample3d = '<div class="s-content" style="transform: translate3d(-545px, 0px, 0px);">Content</div>';
    const sanitized3d = sanitizeSectionMarkup(sample3d);
    assert.ok(sanitized3d.includes('transform: translate3d(0px, 0px, 0px);'), 'neutralizes translate3d');
  });
});

describe('IndependentHtmlCloneGenerator - CSRF & Livewire Sanitation', () => {
  it('strips CSRF input tokens and meta tags', () => {
    const html = [
      '<form action="/cart">',
      '  <input type="hidden" name="_token" value="abc123csrf">',
      '  <input type="hidden" name="csrf-token" value="xyz456">',
      '  <input type="text" name="quantity" value="1">',
      '</form>',
      '<meta name="csrf-token" content="secret-token">',
      '<meta property="csrf-param" content="_token">'
    ].join('\n');

    const sanitized = sanitizeSectionMarkup(html);
    assert.ok(!sanitized.includes('abc123csrf'), 'strips _token input');
    assert.ok(!sanitized.includes('xyz456'), 'strips csrf-token input');
    assert.ok(!sanitized.includes('secret-token'), 'strips csrf-token meta');
    assert.ok(sanitized.includes('name="quantity"'), 'preserves form fields');
  });

  it('strips livewire scripts with single quotes and data attributes', () => {
    const html = [
      "<script src='/livewire/livewire.js?id=123'></script>",
      '<script data-csrf="token123" data-update-uri="/livewire/update"></script>',
      '<div data-livewire="component1" data-navigate-once>Content</div>',
      '<script>window.livewire_token = "abc";</script>'
    ].join('\n');

    const sanitized = sanitizeSectionMarkup(html);
    assert.ok(!sanitized.includes('livewire.js'), 'strips single-quoted livewire script');
    assert.ok(!sanitized.includes('data-csrf'), 'strips data-csrf');
    assert.ok(!sanitized.includes('data-livewire'), 'strips data-livewire');
    assert.ok(!sanitized.includes('livewire_token'), 'strips livewire_token inline script');
  });
});

describe('IndependentHtmlCloneGenerator - Interactivity Script Behavioral Execution', () => {
  it('executes in DOM sandbox and verifies observable state transitions for drawer, modal, and escape key', () => {
    const generator = new IndependentHtmlCloneGenerator();
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-interactivity-'));
    try {
      const sampleHtml = `<!DOCTYPE html><html><head></head><body><div class="category-navigation"></div><div id="popup-video" class="popup"><div class="popup-content"><iframe data-src="https://www.youtube.com/embed/test"></iframe><div class="popup-close"></div></div></div></body></html>`;
      const res = generator.generateFromMaterializedHtml(sampleHtml, {
        outputDir: tmpDir,
        entryFilename: 'index.html'
      });

      const match = res.html.match(/<script id="antifan-clone-interactivity">([\s\S]*?)<\/script>/);
      assert.ok(match, 'interactivity script must be present');
      const scriptCode = match[1];

      // Compile check
      const script = new vm.Script(scriptCode, { filename: 'interactivity.js' });

      // Create DOM Mock to verify behavioral transitions
      class MockClassList {
        private set = new Set<string>();
        constructor(init: string[] = []) { init.forEach(c => this.set.add(c)); }
        add(...names: string[]) { names.forEach(n => this.set.add(n)); }
        remove(...names: string[]) { names.forEach(n => this.set.delete(n)); }
        contains(n: string) { return this.set.has(n); }
        toggle(n: string) {
          if (this.set.has(n)) { this.set.delete(n); return false; }
          this.set.add(n); return true;
        }
      }

      class MockNode {
        id = '';
        tagName = 'DIV';
        nodeType = 1;
        classList = new MockClassList();
        style: Record<string, string> = {};
        attrs: Record<string, string> = {};
        children: MockNode[] = [];
        parentElement: MockNode | null = null;
        listeners: Record<string, ((e: { target: unknown; key?: string; preventDefault: () => void; stopPropagation: () => void }) => void)[]> = {};

        constructor(tag: string = 'div', classes: string[] = []) {
          this.tagName = tag.toUpperCase();
          this.classList = new MockClassList(classes);
        }

        getAttribute(name: string): string | null {
          return this.attrs[name] ?? null;
        }
        setAttribute(name: string, val: string) {
          this.attrs[name] = val;
        }
        get src(): string {
          return this.attrs.src || '';
        }
        set src(val: string) {
          this.attrs.src = val;
        }
        addEventListener(type: string, fn: (e: { target: unknown; key?: string; preventDefault: () => void; stopPropagation: () => void }) => void) {
          if (!this.listeners[type]) this.listeners[type] = [];
          this.listeners[type].push(fn);
        }
        dispatchEvent(e: { type: string; key?: string; target?: unknown; preventDefault?: () => void; stopPropagation?: () => void }) {
          const ev = {
            target: e.target || this,
            key: e.key,
            preventDefault: e.preventDefault || (() => {}),
            stopPropagation: e.stopPropagation || (() => {})
          };
          const list = this.listeners[e.type] || [];
          for (const fn of list) fn(ev);
        }
        closest(sel: string): MockNode | null {
          if (this.matches(sel)) return this;
          return this.parentElement ? this.parentElement.closest(sel) : null;
        }
        matches(sel: string): boolean {
          const parts = sel.split(',').map(s => s.trim());
          return parts.some(p => {
            if (p.startsWith('#')) return this.id === p.slice(1);
            if (p.startsWith('.')) return this.classList.contains(p.slice(1));
            if (p.includes('.')) {
              const classParts = p.split('.');
              return this.classList.contains(classParts[1]);
            }
            return this.tagName.toLowerCase() === p.toLowerCase();
          });
        }
        querySelector(sel: string): MockNode | null {
          const all = this.querySelectorAll(sel);
          return all.length > 0 ? all[0] : null;
        }
        querySelectorAll(sel: string): MockNode[] {
          const res: MockNode[] = [];
          for (const child of this.children) {
            if (child.matches(sel)) res.push(child);
            res.push(...child.querySelectorAll(sel));
          }
          return res;
        }
      }

      const menuBtn = new MockNode('button', ['menu-mobile']);
      const drawer = new MockNode('div', ['category-navigation__block']);
      const drawerClose = new MockNode('span', ['close']);
      drawer.children.push(drawerClose);
      drawerClose.parentElement = drawer;

      const videoBtn = new MockNode('a', ['video-content__button']);
      const videoPopup = new MockNode('div', ['popup']);
      videoPopup.id = 'popup-video';
      const videoContent = new MockNode('div', ['popup-content']);
      const iframe = new MockNode('iframe');
      iframe.setAttribute('data-src', 'https://www.youtube.com/embed/test');
      const videoClose = new MockNode('span', ['popup-close']);
      videoContent.children.push(iframe, videoClose);
      iframe.parentElement = videoContent;
      videoClose.parentElement = videoContent;
      videoPopup.children.push(videoContent);
      videoContent.parentElement = videoPopup;

      const body = new MockNode('body');
      body.children.push(menuBtn, drawer, videoBtn, videoPopup);
      menuBtn.parentElement = body;
      drawer.parentElement = body;
      videoBtn.parentElement = body;
      videoPopup.parentElement = body;

      const docListeners: Record<string, ((e: unknown) => void)[]> = {};
      const mockDoc = {
        body,
        readyState: 'complete',
        addEventListener: (type: string, fn: (e: unknown) => void) => {
          if (!docListeners[type]) docListeners[type] = [];
          docListeners[type].push(fn);
        },
        dispatchEvent: (e: { type: string; key?: string }) => {
          const list = docListeners[e.type] || [];
          for (const fn of list) fn(e);
        },
        getElementById: (id: string): MockNode | null => {
          if (videoPopup.id === id) return videoPopup;
          return null;
        },
        querySelector: (sel: string): MockNode | null => {
          const list = mockDoc.querySelectorAll(sel);
          return list.length > 0 ? list[0] : null;
        },
        querySelectorAll: (sel: string): MockNode[] => {
          if (sel.includes('category-navigation__block.show') || sel.includes('.drawer.show') || sel.includes('[data-antifan-drawer].show')) {
            return drawer.classList.contains('show') ? [drawer] : [];
          }
          if (sel.includes('#popup-video.active') || sel.includes('.popup.active')) {
            return videoPopup.classList.contains('active') ? [videoPopup] : [];
          }
          if (sel.includes('.menu-mobile')) return [menuBtn];
          if (sel.includes('.video-content__button')) return [videoBtn];
          if (sel.includes('.category-navigation__block') || sel.includes('[class*="drawer"]')) return [drawer];
          return body.querySelectorAll(sel);
        }
      };

      const sandbox = {
        window: {
          addEventListener: () => {},
          getComputedStyle: () => ({ transform: 'none' }),
          location: { search: '', pathname: '/index.html', replace: () => {} }
        },
        document: mockDoc,
        navigator: { userAgent: 'Mozilla/5.0' },
        setInterval: () => 1,
        clearInterval: () => {}
      };

      const ctx = vm.createContext(sandbox);
      script.runInContext(ctx);

      // Behavioral Check 1: Trigger menu button -> drawer opens and body scroll locks
      menuBtn.dispatchEvent({ type: 'click' });
      assert.strictEqual(drawer.classList.contains('show'), true, 'clicking menu button must add .show to drawer');
      assert.strictEqual(body.style.overflow, 'hidden', 'opening drawer must lock body scroll with overflow: hidden');

      // Behavioral Check 2: Press Escape -> drawer closes and body scroll lock releases
      mockDoc.dispatchEvent({ type: 'keydown', key: 'Escape' });
      assert.strictEqual(drawer.classList.contains('show'), false, 'Escape key must close open drawer');
      assert.strictEqual(body.style.overflow, '', 'Escape key must restore body overflow');

      // Behavioral Check 3: Trigger video button -> video popup activates with autoplay URL
      videoBtn.dispatchEvent({ type: 'click' });
      assert.strictEqual(videoPopup.classList.contains('active'), true, 'video button click must add .active to popup');
      assert.ok(iframe.attrs.src?.includes('autoplay=1'), 'video iframe src must load with autoplay=1');

      // Behavioral Check 4: Press Escape -> video popup closes and iframe resets to about:blank
      mockDoc.dispatchEvent({ type: 'keydown', key: 'Escape' });
      assert.strictEqual(videoPopup.classList.contains('active'), false, 'Escape key must close video popup');
      assert.strictEqual(iframe.attrs.src, 'about:blank', 'closing video popup must reset iframe src to about:blank');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('IndependentHtmlCloneGenerator - Subdirectory Relative Links (mobile/index.html)', () => {
  it('generateFromMaterializedHtml rewrites relative asset paths for mobile subdirectory without double rewriting', () => {
    const generator = new IndependentHtmlCloneGenerator();
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-mobile-links-'));
    try {
      const sampleHtml = [
        '<!DOCTYPE html><html><head>',
        '<link rel="stylesheet" href="assets/theme.css">',
        '<link rel="stylesheet" href="css/vendor.css">',
        '<link rel="stylesheet" href="../assets/already-relative.css">',
        '</head><body>',
        '<script src="js/bundle.js"></script>',
        '<img src="assets/hero.jpg" srcset="assets/hero-1x.jpg 1x, assets/hero-2x.jpg 2x">',
        '<div style="background-image: url(\'assets/bg.png\');"></div>',
        '</body></html>'
      ].join('\n');

      const res = generator.generateFromMaterializedHtml(sampleHtml, {
        outputDir: tmpDir,
        entryFilename: 'mobile/index.html',
        device: 'mobile'
      });

      assert.ok(res.html.includes('href="../assets/theme.css"'), 'href="assets/..." must rewrite to "../assets/..."');
      assert.ok(res.html.includes('href="../css/vendor.css"'), 'href="css/..." must rewrite to "../css/..."');
      assert.ok(res.html.includes('src="../js/bundle.js"'), 'src="js/..." must rewrite to "../js/..."');
      assert.ok(res.html.includes('src="../assets/hero.jpg"'), 'src="assets/..." must rewrite to "../assets/..."');
      assert.ok(res.html.includes('srcset="../assets/hero-1x.jpg 1x, ../assets/hero-2x.jpg 2x"'), 'srcset must rewrite URLs to "../assets/..."');
      assert.ok(res.html.includes("url('../assets/bg.png')"), 'CSS url() must rewrite to "../assets/..."');

      // Must NOT double rewrite an already-relative path
      assert.ok(res.html.includes('href="../assets/already-relative.css"'), 'must not double rewrite ../assets/ to ../../assets/');
      assert.ok(!res.html.includes('../../assets/already-relative.css'), 'no ../../assets/ double rewrite');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('generateCloneBundle writes to mobile/index.html with ../assets/ relative prefixes', async () => {
    const generator = new IndependentHtmlCloneGenerator();
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bundle-mobile-'));
    try {
      const fixtureAssetsDir = path.join(tmpDir, 'source-assets');
      fs.mkdirSync(fixtureAssetsDir, { recursive: true });
      const stylePath = path.join(fixtureAssetsDir, 'style.css');
      const appJsPath = path.join(fixtureAssetsDir, 'app.js');
      fs.writeFileSync(stylePath, 'body { color: red; }', 'utf-8');
      fs.writeFileSync(appJsPath, 'console.log("app");', 'utf-8');

      const fakeIR = createDefaultComponentContractIR();
      fakeIR.sections = [
        {
          id: 'sec1',
          name: 'Header',
          archetype: 'header',
          layoutType: 'flex',
          settings: {},
          blocks: [],
          rawHtml: '<header>Mobile Header</header>'
        }
      ];
      fakeIR.assets = {
        stylesheets: [
          {
            type: 'css',
            filename: 'style.css',
            sourceUrl: 'https://example.com/style.css',
            localPath: stylePath,
            byteCount: 100
          }
        ],
        javascripts: [
          {
            type: 'js',
            filename: 'app.js',
            sourceUrl: 'https://example.com/app.js',
            localPath: appJsPath,
            byteCount: 100
          }
        ],
        images: [],
        fonts: [],
        totalBytes: 200
      };

      const res = await generator.generateCloneBundle(fakeIR, {
        outputDir: tmpDir,
        entryFilename: 'mobile/index.html',
        skipDownload: true
      });

      assert.ok(res.entryHtmlPath.endsWith(path.join('mobile', 'index.html')), 'entryHtmlPath must end with mobile/index.html');
      assert.ok(fs.existsSync(res.entryHtmlPath), 'mobile/index.html must exist on disk');

      const content = fs.readFileSync(res.entryHtmlPath, 'utf-8');
      assert.ok(content.includes('href="../assets/style.css"'), 'must reference stylesheet as ../assets/style.css');
      assert.ok(content.includes('src="../assets/app.js"'), 'must reference script as ../assets/app.js');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
