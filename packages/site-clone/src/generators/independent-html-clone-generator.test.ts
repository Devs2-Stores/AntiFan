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
  it('preserves remote iframe destinations as inert data-src metadata', () => {
    const sample = '<div class="video-frame"><iframe src="https://video.example.test/film.mp4" data-src="stale" allow="autoplay"></iframe></div>';
    const sanitized = sanitizeSectionMarkup(sample);
    assert.ok(sanitized.includes('data-src="https://video.example.test/film.mp4"'), 'remote iframe destination must be preserved in data-src');
    assert.ok(sanitized.includes('src="about:blank"'), 'remote iframe must not load during offline capture');
    assert.strictEqual((sanitized.match(/\ssrc=/gi) || []).length, 1, 'iframe must have exactly one src attribute');
    assert.ok(!sanitized.includes('data-src="stale"'), 'stale data-src must be replaced');
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

  it('synthesizes data-antifan-state, open, close, and unwrap capture-time slick DOM', () => {
    const input = [
      '<div class="menu-mobile" @click="categoryNavigationVisible = true">Open</div>',
      '<div class="close" x-on:click="categoryNavigationVisible = false">Close</div>',
      '<div class="category-navigation__block" :class="{ \'show\': categoryNavigationVisible }">',
      '  <div class="block-category__list w-100 slick-initialized slick-slider slick-dotted">',
      '    <div class="slick-list draggable">',
      '      <div class="slick-track" style="width: 785px; transform: translate3d(0px, 0px, 0px);">',
      '        <div class="item slick-slide slick-active" data-slick-index="0" aria-describedby="slick-slide01">Slide 1</div>',
      '        <div class="item slick-slide" data-slick-index="1">Slide 2</div>',
      '      </div>',
      '    </div>',
      '    <ul class="slick-dots"><li class="slick-active"><button>1</button></li></ul>',
      '  </div>',
      '</div>'
    ].join('\n');

    const sanitized = sanitizeSectionMarkup(input);
    assert.ok(sanitized.includes('data-antifan-open="categoryNavigationVisible"'), 'must produce data-antifan-open');
    assert.ok(sanitized.includes('data-antifan-close="categoryNavigationVisible"'), 'must produce data-antifan-close');
    assert.ok(sanitized.includes('data-antifan-state="categoryNavigationVisible"'), 'must produce data-antifan-state');
    assert.ok(sanitized.includes('data-antifan-class="show"'), 'must produce data-antifan-class="show"');
    assert.ok(!sanitized.includes('slick-initialized'), 'must strip slick-initialized class');
    assert.ok(!sanitized.includes('slick-slider'), 'must strip slick-slider class');
    assert.ok(!sanitized.includes('slick-dots'), 'must remove slick-dots DOM');
    assert.ok(!sanitized.includes('slick-list'), 'must unwrap slick-list');
    assert.ok(!sanitized.includes('slick-track'), 'must unwrap slick-track');
    assert.ok(sanitized.includes('Slide 1') && sanitized.includes('Slide 2'), 'slide contents must be preserved cleanly');
  });
  it('unwraps capture-time slick DOM with deeply nested <div> elements inside slides', () => {
    const input = [
      '<div class="slider slick-initialized slick-slider">',
      '  <div class="slick-list">',
      '    <div class="slick-track">',
      '      <div class="slide slick-slide">',
      '        <div class="product-card">',
      '          <div class="thumb"><img src="item1.jpg"></div>',
      '          <div class="info"><h3 class="title">Product A</h3></div>',
      '        </div>',
      '      </div>',
      '      <div class="slide slick-slide">',
      '        <div class="product-card">',
      '          <div class="thumb"><img src="item2.jpg"></div>',
      '          <div class="info"><h3 class="title">Product B</h3></div>',
      '        </div>',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('\n');
    const sanitized = sanitizeSectionMarkup(input);
    assert.ok(!sanitized.includes('slick-list'), 'must unwrap slick-list');
    assert.ok(!sanitized.includes('slick-track'), 'must unwrap slick-track');
    assert.ok(sanitized.includes('Product A') && sanitized.includes('Product B'), 'nested slide contents must be preserved');
    assert.ok(sanitized.includes('<div class="product-card">'), 'nested wrapper divs must not be truncated');
    assert.ok(sanitized.includes('<div class="thumb">'), 'nested inner divs must survive');
  });

  it('strips bound attributes with quoted string literals without leaving expression fragments or duplicate src', () => {
    const sample = '<iframe width="1280" height="536" :data-src="openVideo ? \'\' : \'https://www.youtube.com/embed/Nt2J6ZXPuw0\'" :src="openVideo ? \'https://www.youtube.com/embed/Nt2J6ZXPuw0\' : \'\'" frameborder="0" allowfullscreen="" data-src="https://www.youtube.com/embed/Nt2J6ZXPuw0" src=""></iframe>';
    const sanitized = sanitizeSectionMarkup(sample);
    assert.ok(!sanitized.includes('openVideo'), 'Expression variable openVideo must be stripped');
    assert.ok(!sanitized.includes('Nt2J6ZXPuw0'), 'Lingering YouTube remote embed URL must be stripped');
    assert.ok(!sanitized.includes('"" : \'\'"'), 'Malformed expression fragment must not exist');
    assert.ok(!sanitized.includes(':src'), ':src bound attribute must be stripped');
    assert.ok(!sanitized.includes(':data-src'), ':data-src bound attribute must be stripped');
    const srcMatches = sanitized.match(/\ssrc=/gi) || [];
    assert.strictEqual(srcMatches.length, 1, 'Exactly one src attribute must remain on the iframe');
    assert.ok(sanitized.includes('src="about:blank"'), 'Iframe src must be safely normalized to about:blank');
  });

  it('strips dead third-party chat widget shells with fixed positioning and inline !important styles', () => {
    const sample = '<body><main>Content</main><div id="zdcuurvpe1d1789321628886" style="display: block !important;"><iframe src="about:blank" frameborder="0" scrolling="no" width="64px" height="60px" style="outline:none !important; visibility:visible !important; resize:none !important; box-shadow:none !important; overflow:visible !important; background:none !important; opacity:1 !important; filter:alpha(opacity=100) !important; -ms-filter:progid:DXImageTransform.Microsoft.Alpha(Opacity 1}) !important; -mz-opacity:1 !important; -khtml-opacity:1 !important; top:auto !important; right:20px !important; bottom:20px !important; left:auto !important; position:fixed !important; border:0 !important; min-height:60px !important; min-width:64px !important; max-height:60px !important; max-width:64px !important; padding:0 !important; margin:0 !important; -moz-transition-property:none !important; -webkit-transition-property:none !important; -o-transition-property:none !important; transition-property:none !important; transform:none !important; -webkit-transform:none !important; -ms-transform:none !important; width:64px !important; height:60px !important; display:block !important; z-index:1000003 !important; background-color:transparent !important; cursor:none !important; float:none !important; border-radius:unset !important; pointer-events:auto !important; clip:auto !important; color-scheme:light !important;" id="ddbjpcjt6qq41789321629013" class="" referrerpolicy="no-referrer-when-downgrade"></iframe><iframe srcdoc="&lt;html&gt;&lt;/html&gt;" frameborder="0" scrolling="no" width="350px" height="720px" style="outline:none !important; visibility:visible !important; resize:none !important; box-shadow:none !important; overflow:visible !important; background:none !important; opacity:1 !important; filter:alpha(opacity=100) !important; -ms-filter:progid:DXImageTransform.Microsoft.Alpha(Opacity 1}) !important; -mz-opacity:1 !important; -khtml-opacity:1 !important; top:auto !important; right:20px !important; bottom:98px !important; left:auto !important; position:fixed !important; border:0 !important; min-height:720px !important; min-width:350px !important; max-height:720px !important; max-width:350px !important; padding:0 !important; margin:0 !important; -moz-transition-property:none !important; -webkit-transition-property:none !important; -o-transition-property:none !important; transition-property:none !important; transform:none !important; -webkit-transform:none !important; -ms-transform:none !important; width:350px !important; height:720px !important; display:none !important; z-index:auto !important; background-color:transparent !important; cursor:none !important; float:none !important; border-radius:unset !important; pointer-events:auto !important; clip:auto !important; color-scheme:light !important;" id="31a2vsm804ms1789321629043" class="" referrerpolicy="no-referrer-when-downgrade"></iframe></div></body>';
    const sanitized = sanitizeSectionMarkup(sample);
    assert.ok(!sanitized.includes('zdcuurvpe1d1789321628886'), 'Dead widget shell container div must be stripped');
    assert.ok(!sanitized.includes('Microsoft.Alpha'), 'Third-party vendor Alpha filter styles must be stripped');
    assert.ok(!sanitized.includes('srcdoc="&lt;html&gt;&lt;/html&gt;"'), 'Dead empty srcdoc widget iframes must be stripped');
    assert.ok(sanitized.includes('<main>Content</main>'), 'Authentic page content must be preserved');
  });

  it('preserves a footer/newsletter block and an interactive script following a tracker shell with an iframe', () => {
    const sample = [
      '<body>',
      '<main>Content</main>',
      '<div style="z-index: 999999; display: block !important;">',
      '  <iframe src="https://example.com/widget" width="100" height="100"></iframe>',
      '</div>',
      '<footer class="site-footer">',
      '  <div class="newsletter-block">',
      '    <h3>Newsletter</h3>',
      '    <p>Subscribe to our newsletter</p>',
      '  </div>',
      '</footer>',
      '<script>initAntifanInteractivity();</script>',
      '</body>'
    ].join('\n');

    const sanitized = sanitizeSectionMarkup(sample);
    assert.ok(!sanitized.includes('z-index: 999999'), 'tracker shell with z-index: 999999 must be stripped');
    assert.ok(!sanitized.includes('example.com/widget'), 'tracker iframe must be stripped');
    assert.ok(sanitized.includes('site-footer'), 'footer following tracker shell must survive');
    assert.ok(sanitized.includes('newsletter-block'), 'newsletter content must survive');
    assert.ok(sanitized.includes('Subscribe to our newsletter'), 'newsletter text must survive');
    assert.ok(sanitized.includes('initAntifanInteractivity();'), 'subsequent script must survive');
  });

  it('does not strip layout content that wraps nested divs even if an iframe is present', () => {
    const layoutMarkup = [
      '<div class="main-layout" style="z-index: 99999; display: block !important;">',
      '  <div class="inner-container">',
      '    <p>Valuable content</p>',
      '    <iframe src="about:blank"></iframe>',
      '  </div>',
      '</div>'
    ].join('\n');

    const sanitized = sanitizeSectionMarkup(layoutMarkup);
    assert.ok(sanitized.includes('Valuable content'), 'layout content wrapping nested divs must survive');
    assert.ok(sanitized.includes('inner-container'), 'inner container must survive');
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

  it('releases the scroll lock a capture bakes into <body> and <html> while a modal was open', () => {
    const generator = new IndependentHtmlCloneGenerator();
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-scroll-lock-'));
    try {
      const sampleHtml = '<!DOCTYPE html><html lang="vi" style="overflow: hidden;">'
        + '<head><title>Locked capture</title></head>'
        + '<body class="antialiased" style="overflow: hidden;">'
        + '<div class="page">Content</div>'
        + '<div class="tail" style="overflow: hidden; background: rgb(1, 2, 3);">Nested lock must survive</div>'
        + '</body></html>';
      const res = generator.generateFromMaterializedHtml(sampleHtml, {
        outputDir: tmpDir,
        entryFilename: 'index.html',
        device: 'web'
      });

      const bodyTag = res.html.match(/<body[^>]*>/i)?.[0] ?? '';
      const htmlTag = res.html.match(/<html[^>]*>/i)?.[0] ?? '';
      assert.ok(!/overflow/i.test(bodyTag), `body must not keep the capture scroll lock: ${bodyTag}`);
      assert.ok(!/overflow/i.test(htmlTag), `html must not keep the capture scroll lock: ${htmlTag}`);
      assert.ok(bodyTag.includes('class="antialiased"'), 'unrelated body attributes must survive the unlock');
      assert.ok(htmlTag.includes('lang="vi"'), 'unrelated html attributes must survive the unlock');
      assert.ok(
        res.html.includes('style="overflow: hidden; background: rgb(1, 2, 3);"'),
        'a scroll lock on a nested element is page content and must be left alone'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it('emits a standards-mode document so percentage heights use their containing block', () => {
    const generator = new IndependentHtmlCloneGenerator();
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-doctype-'));
    try {
      // A materialized capture is serialized from the document root and therefore carries no doctype.
      const capturedHtml = '<html lang="vi"><head><title>Captured</title></head>'
        + '<body><div class="page">Content</div></body></html>';
      const res = generator.generateFromMaterializedHtml(capturedHtml, {
        outputDir: tmpDir,
        entryFilename: 'index.html',
        device: 'web'
      });

      assert.match(res.html.trimStart(), /^<!DOCTYPE html>/i, 'the bundle must declare the HTML doctype');
      assert.strictEqual(
        new JSDOM(res.html).window.document.compatMode,
        'CSS1Compat',
        'the bundle must not render in quirks mode'
      );

      const alreadyDeclared = '<!DOCTYPE html>\n<html lang="vi"><head></head><body><div>Content</div></body></html>';
      const second = generator.generateFromMaterializedHtml(alreadyDeclared, {
        outputDir: tmpDir,
        entryFilename: 'second.html',
        device: 'web'
      });
      assert.strictEqual(
        second.html.match(/<!DOCTYPE html>/gi)?.length,
        1,
        'a document that already declares the doctype must not gain a second one'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('IndependentHtmlCloneGenerator - fullscreen capture overlay retirement', () => {
  it('retires a capture-time fullscreen overlay with no dismiss control and keeps interactive overlays', async () => {
    const generator = new IndependentHtmlCloneGenerator();
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-overlay-'));
    const fullscreen = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 50;';
    try {
      const sampleHtml = '<!DOCTYPE html><html><head><title>Overlays</title></head><body>'
        + `<div id="announcement" style="${fullscreen}"><a href="/blogs/notice"><img src="assets/notice.png" alt=""></a></div>`
        + `<div id="dialog" style="${fullscreen}"><button class="close">Dong</button></div>`
        + `<div id="state-popup" class="modal" style="${fullscreen}"></div>`
        + `<aside id="cookie" style="${fullscreen}"><a href="/privacy">Chi tiet</a></aside>`
        + '<main>Content</main></body></html>';
      const res = generator.generateFromMaterializedHtml(sampleHtml, {
        outputDir: tmpDir,
        entryFilename: 'index.html',
        device: 'web'
      });

      const dom = new JSDOM(res.html, { runScripts: 'outside-only', pretendToBeVisual: true });
      const win = dom.window;
      win.innerWidth = 1440;
      win.innerHeight = 900;
      win.Element.prototype.getBoundingClientRect = function () {
        const id = this.getAttribute ? this.getAttribute('id') : null;
        // Only the first fullscreen overlay laid out covers the viewport; the cookie notice is small.
        return id === 'cookie'
          ? { x: 0, y: 500, top: 500, left: 0, right: 320, bottom: 600, width: 320, height: 100 }
          : { x: 0, y: 0, top: 0, left: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
      };
      const script = res.html.match(/<script id="antifan-clone-interactivity">([\s\S]*?)<\/script>/)?.[1] ?? '';
      assert.ok(script.length > 0, 'generated document must carry the interactivity script');
      win.eval(script);
      // The bundle bootstraps on DOMContentLoaded, so the retirement runs after this document settles.
      await new Promise<void>(resolve => {
        if (win.document.readyState === 'loading') {
          win.document.addEventListener('DOMContentLoaded', () => resolve());
        } else {
          resolve();
        }
      });

      const isRetired = (id: string) => win.document.getElementById(id)?.hasAttribute('data-antifan-unhydrated-overlay');
      assert.strictEqual(isRetired('announcement'), true, 'a capture-time overlay with no dismiss control must be retired');
      assert.strictEqual(isRetired('dialog'), false, 'an overlay owning a dismiss button must stay interactive');
      assert.strictEqual(isRetired('state-popup'), false, 'a state-machine popup must stay under its own control');
      assert.strictEqual(isRetired('cookie'), false, 'a partial-size overlay must not be treated as a fullscreen backdrop');
      assert.strictEqual(
        win.getComputedStyle(win.document.getElementById('announcement')).display,
        'none',
        'the retired overlay must not block the page'
      );
      assert.notStrictEqual(
        win.getComputedStyle(win.document.querySelector('main')).display,
        'none',
        'page content must stay visible'
      );
      dom.window.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('retires the overlay once a surface that loaded without layout is measured', async () => {
    const generator = new IndependentHtmlCloneGenerator();
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-overlay-deferred-'));
    const fullscreen = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 50;';
    try {
      const sampleHtml = '<!DOCTYPE html><html><head><title>Deferred</title></head><body>'
        + `<div id="announcement" style="${fullscreen}"><a href="/blogs/notice">Notice</a></div>`
        + '<main>Content</main></body></html>';
      const res = generator.generateFromMaterializedHtml(sampleHtml, {
        outputDir: tmpDir,
        entryFilename: 'index.html',
        device: 'web'
      });

      const dom = new JSDOM(res.html, { runScripts: 'outside-only', pretendToBeVisual: true });
      const win = dom.window;
      win.Element.prototype.getBoundingClientRect = () => ({
        x: 0, y: 0, top: 0, left: 0, right: 1440, bottom: 900, width: 1440, height: 900
      });
      win.innerWidth = 0;
      win.innerHeight = 0;
      const script = res.html.match(/<script id="antifan-clone-interactivity">([\s\S]*?)<\/script>/)?.[1] ?? '';
      win.eval(script);
      await new Promise<void>(resolve => {
        if (win.document.readyState === 'loading') {
          win.document.addEventListener('DOMContentLoaded', () => resolve());
        } else {
          resolve();
        }
      });

      const overlay = win.document.getElementById('announcement');
      assert.strictEqual(overlay?.hasAttribute('data-antifan-unhydrated-overlay'), false, 'nothing to measure without layout');

      win.innerWidth = 1440;
      win.innerHeight = 900;
      win.dispatchEvent(new win.Event('resize'));
      assert.strictEqual(overlay?.hasAttribute('data-antifan-unhydrated-overlay'), true, 'the overlay must retire once measured');
      dom.window.close();
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
        removeAttribute(name: string) {
          delete this.attrs[name];
        }
        hasAttribute(name: string): boolean {
          return this.attrs[name] !== undefined;
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
          const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
          return parts.some(p => {
            const tokens = p.split(/\s+/).filter(Boolean);
            if (tokens.length === 1) return this.matchesSingle(tokens[0]);
            if (!this.matchesSingle(tokens[tokens.length - 1])) return false;
            let curr: MockNode | null = this.parentElement;
            for (let i = tokens.length - 2; i >= 0; i--) {
              const token = tokens[i];
              while (curr && !curr.matchesSingle(token)) {
                curr = curr.parentElement;
              }
              if (!curr) return false;
              curr = curr.parentElement;
            }
            return true;
          });
        }
        private matchesSingle(p: string): boolean {
          if (!p) return false;
          let remaining = p;
          const attrMatches = Array.from(p.matchAll(/\[([a-zA-Z0-9_\-]+)(?:="([^"]*)")?\]/g));
          for (const m of attrMatches) {
            const name = m[1];
            const val = m[2];
            if (val !== undefined) {
              if (this.getAttribute(name) !== val) return false;
            } else {
              if (this.getAttribute(name) === null) return false;
            }
            remaining = remaining.replace(m[0], '');
          }
          const idMatches = Array.from(remaining.matchAll(/#([a-zA-Z0-9_\-]+)/g));
          for (const im of idMatches) {
            if (this.id !== im[1]) return false;
            remaining = remaining.replace(im[0], '');
          }
          const classMatches = Array.from(remaining.matchAll(/\.([a-zA-Z0-9_\-]+)/g));
          for (const cm of classMatches) {
            if (!this.classList.contains(cm[1])) return false;
            remaining = remaining.replace(cm[0], '');
          }
          remaining = remaining.trim();
          if (remaining && remaining !== '*') {
            if (this.tagName.toLowerCase() !== remaining.toLowerCase()) return false;
          }
          return true;
        }
        querySelector(sel: string): MockNode | null {
          const all = this.querySelectorAll(sel);
          return all.length > 0 ? all[0] : null;
        }
        querySelectorAll(sel: string): MockNode[] {
          if (sel.includes(',')) {
            const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
            const seen = new Set<MockNode>();
            const res: MockNode[] = [];
            for (const part of parts) {
              for (const node of this.querySelectorAll(part)) {
                if (!seen.has(node)) {
                  seen.add(node);
                  res.push(node);
                }
              }
            }
            return res;
          }
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
      const declarativeOpenBtn = new MockNode('div');
      declarativeOpenBtn.setAttribute('data-antifan-open', 'drawerState');
      const declarativeCloseBtn = new MockNode('div');
      declarativeCloseBtn.setAttribute('data-antifan-close', 'drawerState');
      const stateDrawer = new MockNode('div');
      stateDrawer.setAttribute('data-antifan-state', 'drawerState');
      stateDrawer.setAttribute('data-antifan-class', 'show');

      // Static non-overlay tab and panel that remain permanently active/show on load
      const staticAccessoryTab = new MockNode('li', ['active']);
      staticAccessoryTab.setAttribute('data-antifan-state', 'accessoryTab');
      staticAccessoryTab.setAttribute('data-antifan-class', 'active');
      const staticAccessoryPanel = new MockNode('div', ['accessory-content__block', 'show']);
      staticAccessoryPanel.setAttribute('data-antifan-state', 'accessoryTab');
      staticAccessoryPanel.setAttribute('data-antifan-class', 'show');

      body.children.push(menuBtn, drawer, videoBtn, videoPopup, declarativeOpenBtn, declarativeCloseBtn, stateDrawer, staticAccessoryTab, staticAccessoryPanel);
      menuBtn.parentElement = body;
      drawer.parentElement = body;
      videoBtn.parentElement = body;
      videoPopup.parentElement = body;
      declarativeOpenBtn.parentElement = body;
      declarativeCloseBtn.parentElement = body;
      stateDrawer.parentElement = body;
      staticAccessoryTab.parentElement = body;
      staticAccessoryPanel.parentElement = body;
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

      // Behavioral Check 1: Trigger menu button -> drawer opens, marker is set, and body scroll locks
      menuBtn.dispatchEvent({ type: 'click' });
      assert.strictEqual(drawer.classList.contains('show'), true, 'clicking menu button must add .show to drawer');
      assert.strictEqual(drawer.getAttribute('data-antifan-opened'), 'true', 'opening drawer must mark element with data-antifan-opened=true');
      assert.strictEqual(body.style.overflow, 'hidden', 'opening drawer must lock body scroll with overflow: hidden');

      // Behavioral Check 2: Press Escape -> drawer closes, marker is cleared, and body scroll lock releases even with static active tabs present
      mockDoc.dispatchEvent({ type: 'keydown', key: 'Escape' });
      assert.strictEqual(drawer.classList.contains('show'), false, 'Escape key must close open drawer');
      assert.strictEqual(drawer.getAttribute('data-antifan-opened'), null, 'closing drawer must clear data-antifan-opened marker');
      assert.strictEqual(staticAccessoryTab.classList.contains('active'), true, 'static tab remains active');
      assert.strictEqual(staticAccessoryPanel.classList.contains('show'), true, 'static tab panel remains show');
      assert.strictEqual(body.style.overflow, '', 'closing drawer must restore body overflow despite static active state-tabs');
      // Behavioral Check 3: Trigger video button -> video popup activates with autoplay URL
      videoBtn.dispatchEvent({ type: 'click' });
      assert.strictEqual(videoPopup.classList.contains('active'), true, 'video button click must add .active to popup');
      assert.ok(iframe.attrs.src?.includes('autoplay=1'), 'video iframe src must load with autoplay=1');

      // Behavioral Check 4: Press Escape -> video popup closes and iframe resets to about:blank
      mockDoc.dispatchEvent({ type: 'keydown', key: 'Escape' });
      assert.strictEqual(videoPopup.classList.contains('active'), false, 'Escape key must close video popup');
      assert.strictEqual(iframe.attrs.src, 'about:blank', 'closing video popup must reset iframe src to about:blank');
      // Behavioral Check 5: Declarative data-antifan-open and data-antifan-close trigger state transitions
      declarativeOpenBtn.dispatchEvent({ type: 'click' });
      assert.strictEqual(stateDrawer.classList.contains('show'), true, 'clicking data-antifan-open must open state drawer');
      assert.strictEqual(stateDrawer.getAttribute('data-antifan-opened'), 'true', 'data-antifan-open must mark target with data-antifan-opened');
      assert.strictEqual(body.style.overflow, 'hidden', 'opening state drawer must lock body scroll');

      declarativeCloseBtn.dispatchEvent({ type: 'click' });
      assert.strictEqual(stateDrawer.classList.contains('show'), false, 'clicking data-antifan-close must close state drawer');
      assert.strictEqual(stateDrawer.getAttribute('data-antifan-opened'), null, 'data-antifan-close must clear data-antifan-opened marker');
      assert.strictEqual(body.style.overflow, '', 'closing state drawer must release body scroll');
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

describe('IndependentHtmlCloneGenerator - parity overlay hiding scope', () => {
  /**
   * The capture binds hidden/shown state on ordinary elements too (menu items, tabs), not only
   * on overlays: Alpine markup such as `:class="{ 'show': varName }"` appears on list items.
   * A parity rule that hides everything carrying that binding leaves the emitted menu items
   * permanently invisible, because nothing ever opens them. Overlay hiding must therefore key
   * off overlay markers, which is what the vendor stylesheet already does for the real drawer.
   */
  const hiddenSelectors = (html: string): string[] => {
    const styleMatch = html.match(/<style id="antifan-clone-parity">([\s\S]*?)<\/style>/);
    assert.ok(styleMatch, 'parity stylesheet must be present');
    const rules = styleMatch[1].match(/[^{}]+\{[^}]*\}/g) || [];
    const selectors: string[] = [];
    for (const rule of rules) {
      const [rawSelector, rawBody] = rule.split('{');
      if (!/visibility\s*:\s*hidden/.test(rawBody)) continue;
      for (const part of rawSelector.split(',')) selectors.push(part.replace(/\/\*[\s\S]*?\*\//g, '').trim());
    }
    return selectors;
  };

  it('keeps state-bound non-overlay elements visible and still hides real overlays', () => {
    const generator = new IndependentHtmlCloneGenerator();
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-parity-scope-'));
    try {
      const sampleHtml = [
        '<!DOCTYPE html><html><head></head><body>',
        '<div class="menu-mobile" @click="categoryNavigationVisible = true"></div>',
        '<ul class="category-navigation__list">',
        '<li class="menu-item" :class="{ \'show\': categoryNavigationVisible }"><a href="/category/cam-bien">Cảm biến</a></li>',
        '</ul>',
        '<div class="category-navigation__block" :class="{ \'show\': categoryNavigationVisible }"><div class="close">x</div></div>',
        '</body></html>'
      ].join('\n');

      const res = generator.generateFromMaterializedHtml(sampleHtml, { outputDir: tmpDir, entryFilename: 'index.html' });

      // The binding is emitted for both the list item and the drawer.
      assert.ok(res.html.includes('data-antifan-state="categoryNavigationVisible"'), 'state binding must be emitted');
      const boundElements = res.html.match(/data-antifan-state="categoryNavigationVisible"/g) || [];
      assert.strictEqual(boundElements.length, 2, 'both the list item and the drawer carry the binding');

      const hideSelectors = hiddenSelectors(res.html);
      const stateOnlySelector = hideSelectors.find((sel) => /^\[data-antifan-state\]/.test(sel) && !/drawer|category-navigation|overlay|offcanvas|modal/i.test(sel));
      assert.strictEqual(
        stateOnlySelector,
        undefined,
        `a bare state binding must not hide an element by parity CSS (found ${stateOnlySelector})`
      );
      assert.ok(
        hideSelectors.some((sel) => /\.category-navigation__block:not\(\.show\)/.test(sel)),
        'the real drawer must still be hidden by parity CSS'
      );
      assert.ok(
        hideSelectors.some((sel) => /\[data-antifan-drawer\]/.test(sel)),
        'overlay markers must still be hidden by parity CSS'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('IndependentHtmlCloneGenerator - Mobile Drilldown and Overlay Controls', () => {
  it('resolves level-2 toggle triggers relative to the clicked row and leaves sibling rows untouched', () => {
    const generator = new IndependentHtmlCloneGenerator();
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-drilldown-'));
    try {
      const sampleHtml = `<!DOCTYPE html><html><head></head><body><div class="category-navigation"></div></body></html>`;
      const res = generator.generateFromMaterializedHtml(sampleHtml, {
        outputDir: tmpDir,
        entryFilename: 'index.html',
        device: 'mobile'
      });

      const match = res.html.match(/<script id="antifan-clone-interactivity">([\s\S]*?)<\/script>/);
      assert.ok(match, 'interactivity script must be present');
      const script = new vm.Script(match[1], { filename: 'interactivity.js' });

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
        tagName = 'DIV';
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

        getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
        setAttribute(name: string, val: string) { this.attrs[name] = val; }
        hasAttribute(name: string): boolean { return this.attrs[name] !== undefined; }
        addEventListener(type: string, fn: (e: { target: unknown; key?: string; preventDefault: () => void; stopPropagation: () => void }) => void) {
          if (!this.listeners[type]) this.listeners[type] = [];
          this.listeners[type].push(fn);
        }
        dispatchEvent(e: { type: string; key?: string; target?: unknown; preventDefault?: () => void; stopPropagation?: () => void }) {
          const ev = { target: e.target || this, key: e.key, preventDefault: e.preventDefault || (() => {}), stopPropagation: e.stopPropagation || (() => {}) };
          for (const fn of this.listeners[e.type] || []) fn(ev);
        }
        closest(sel: string): MockNode | null {
          if (this.matches(sel)) return this;
          return this.parentElement ? this.parentElement.closest(sel) : null;
        }
        matches(sel: string): boolean {
          const groups = sel.split(',').map(s => s.trim()).filter(Boolean);
          return groups.some(g => this.matchSingleSelector(g));
        }
        private matchCompound(compound: string): boolean {
          if (!compound || compound === '*') return true;
          let target = compound;
          const notMatches = target.match(/:not\(([^)]+)\)/g);
          if (notMatches) {
            for (const notSel of notMatches) {
              const inner = notSel.slice(5, -1);
              if (this.matchCompound(inner)) return false;
              target = target.replace(notSel, '');
            }
          }
          if (!target) return true;
          const re = /([.#\[]?[a-zA-Z0-9_\-]+(?:="[^"]*")?\]?)/g;
          let part: RegExpExecArray | null;
          while ((part = re.exec(target)) !== null) {
            const p = part[0];
            if (p.startsWith('.')) {
              if (!this.classList.contains(p.slice(1))) return false;
            } else if (p.startsWith('#')) {
              if (this.attrs.id !== p.slice(1)) return false;
            } else if (p.startsWith('[')) {
              const m = p.match(/^\[([a-zA-Z0-9_\-]+)(?:="([^"]*)")?\]$/);
              if (m) {
                const [, name, val] = m;
                if (val !== undefined) {
                  if (this.getAttribute(name) !== val) return false;
                } else {
                  if (!this.hasAttribute(name)) return false;
                }
              }
            } else {
              if (this.tagName.toLowerCase() !== p.toLowerCase()) return false;
            }
          }
          return true;
        }
        private matchSingleSelector(sel: string): boolean {
          const parts = sel.split(/\s*(>|\s)\s*/).filter(Boolean);
          if (parts.length === 1) return this.matchCompound(parts[0]);
          let cur: MockNode | null = this;
          for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i];
            if (part === '>') {
              i--;
              const parentSel = parts[i];
              cur = cur ? cur.parentElement : null;
              if (!cur || !cur.matchCompound(parentSel)) return false;
            } else if (part === ' ') {
              i--;
              const ancestorSel = parts[i];
              cur = cur ? cur.parentElement : null;
              let matched = false;
              while (cur) {
                if (cur.matchCompound(ancestorSel)) { matched = true; break; }
                cur = cur.parentElement;
              }
              if (!matched) return false;
            } else {
              if (!cur || !cur.matchCompound(part)) return false;
            }
          }
          return true;
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

      const body = new MockNode('body');

      // Setup 3 rows with the exact category-navigation structure:
      // Row 1: Drilldown-only (NO data-antifan-toggle attribute, tests drilldown listener)
      const row1 = new MockNode('li');
      const row1P = new MockNode('p');
      const row1Span = new MockNode('span');
      const row1Child = new MockNode('ul', ['child-lv2']);
      row1P.children.push(row1Span);
      row1Span.parentElement = row1P;
      row1.children.push(row1P, row1Child);
      row1P.parentElement = row1;
      row1Child.parentElement = row1;

      // Row 2: Scoped toggle (WITH data-antifan-toggle, tests relative toggle listener)
      const row2 = new MockNode('li');
      row2.setAttribute('data-antifan-state', 'isOpen');
      row2.setAttribute('data-antifan-class', 'show');
      const row2P = new MockNode('p');
      const row2Span = new MockNode('span');
      row2Span.setAttribute('data-antifan-toggle', 'isOpen');
      const row2Child = new MockNode('ul', ['child-lv2']);
      row2P.children.push(row2Span);
      row2Span.parentElement = row2P;
      row2.children.push(row2P, row2Child);
      row2P.parentElement = row2;
      row2Child.parentElement = row2;

      // Row 3: Sibling drilldown
      const row3 = new MockNode('li');
      const row3P = new MockNode('p');
      const row3Span = new MockNode('span');
      row3P.children.push(row3Span);
      row3Span.parentElement = row3P;
      row3.children.push(row3P);
      row3P.parentElement = row3;

      const list = new MockNode('ul', ['child-lv1']);
      list.children.push(row1, row2, row3);
      row1.parentElement = list;
      row2.parentElement = list;
      row3.parentElement = list;

      body.children.push(list);
      list.parentElement = body;

      const mockDoc = {
        body,
        readyState: 'complete',
        addEventListener: () => {},
        getElementById: (id: string) => body.querySelector('#' + id),
        querySelector: (sel: string) => body.querySelector(sel),
        querySelectorAll: (sel: string) => body.querySelectorAll(sel)
      };

      const ctx = vm.createContext({
        window: {
          addEventListener: () => {},
          innerWidth: 390,
          location: { search: '' },
          document: mockDoc
        },
        document: mockDoc,
        navigator: { userAgent: 'Mozilla/5.0' },
        setInterval: () => 1,
        clearInterval: () => {}
      });

      script.runInContext(ctx);

      // Verify Initial State: all rows closed
      assert.strictEqual(row1.classList.contains('show'), false);
      assert.strictEqual(row2.classList.contains('show'), false);
      assert.strictEqual(row3.classList.contains('show'), false);

      // Part A: Exercise pure drilldown listener on Row 1 (.child-lv1 > li > p > span:not([data-antifan-toggle]))
      row1Span.dispatchEvent({ type: 'click' });
      assert.strictEqual(row1.classList.contains('show'), true, 'Row 1 must open via drilldown listener');
      assert.strictEqual(row2.classList.contains('show'), false, 'Row 2 remains closed');
      assert.strictEqual(row3.classList.contains('show'), false, 'Row 3 remains closed');

      row1Span.dispatchEvent({ type: 'click' });
      assert.strictEqual(row1.classList.contains('show'), false, 'Row 1 must close on second drilldown click');

      // Part B: Exercise relative scoped toggle on Row 2 ([data-antifan-toggle])
      row2Span.dispatchEvent({ type: 'click' });
      assert.strictEqual(row2.classList.contains('show'), true, 'Row 2 must gain .show class on scoped toggle');
      assert.strictEqual(row2.classList.contains('active'), true, 'Row 2 must gain .active class on scoped toggle');
      assert.strictEqual(row1.classList.contains('show'), false, 'Row 1 remains untouched');
      assert.strictEqual(row3.classList.contains('show'), false, 'Row 3 remains untouched');

      row2Span.dispatchEvent({ type: 'click' });
      assert.strictEqual(row2.classList.contains('show'), false, 'Row 2 must close on second toggle');
      assert.strictEqual(row2.classList.contains('active'), false, 'Row 2 must lose .active on second toggle');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('narrows unmatched data-antifan-open trigger fallback to a single best target rather than mass-opening every overlay', () => {
    const generator = new IndependentHtmlCloneGenerator();
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-unmatched-'));
    try {
      const sampleHtml = `<!DOCTYPE html><html><head></head><body><div class="category-navigation"></div></body></html>`;
      const res = generator.generateFromMaterializedHtml(sampleHtml, {
        outputDir: tmpDir,
        entryFilename: 'index.html',
        device: 'mobile'
      });

      const match = res.html.match(/<script id="antifan-clone-interactivity">([\s\S]*?)<\/script>/);
      assert.ok(match, 'interactivity script must be present');
      const script = new vm.Script(match[1], { filename: 'interactivity.js' });

      class MockClassList {
        private set = new Set<string>();
        constructor(init: string[] = []) { init.forEach(c => this.set.add(c)); }
        add(...names: string[]) { names.forEach(n => this.set.add(n)); }
        remove(...names: string[]) { names.forEach(n => this.set.delete(n)); }
        contains(n: string) { return this.set.has(n); }
      }

      class MockNode {
        tagName = 'DIV';
        classList = new MockClassList();
        style: Record<string, string> = {};
        attrs: Record<string, string> = {};
        children: MockNode[] = [];
        parentElement: MockNode | null = null;
        listeners: Record<string, ((e: { target: unknown; preventDefault: () => void; stopPropagation: () => void }) => void)[]> = {};

        constructor(tag: string = 'div', classes: string[] = []) {
          this.tagName = tag.toUpperCase();
          this.classList = new MockClassList(classes);
        }

        getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
        setAttribute(name: string, val: string) { this.attrs[name] = val; }
        hasAttribute(name: string): boolean { return this.attrs[name] !== undefined; }
        addEventListener(type: string, fn: (e: { target: unknown; preventDefault: () => void; stopPropagation: () => void }) => void) {
          if (!this.listeners[type]) this.listeners[type] = [];
          this.listeners[type].push(fn);
        }
        dispatchEvent(e: { type: string; target?: unknown; preventDefault?: () => void; stopPropagation?: () => void }) {
          const ev = { target: e.target || this, preventDefault: e.preventDefault || (() => {}), stopPropagation: e.stopPropagation || (() => {}) };
          for (const fn of this.listeners[e.type] || []) fn(ev);
        }
        closest(sel: string): MockNode | null {
          if (this.matches(sel)) return this;
          return this.parentElement ? this.parentElement.closest(sel) : null;
        }
        matches(sel: string): boolean {
          const parts = sel.split(',').map(s => s.trim());
          return parts.some(p => {
            if (p.startsWith('[')) {
              const attrMatch = p.match(/^\[([a-zA-Z0-9_\-]+)(?:="([^"]*)")?\]$/);
              if (attrMatch) {
                const name = attrMatch[1];
                const val = attrMatch[2];
                if (val !== undefined) return this.getAttribute(name) === val;
                return this.getAttribute(name) !== null;
              }
            }
            if (p.startsWith('.')) return this.classList.contains(p.slice(1));
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

      const body = new MockNode('body');

      const triggerBtn = new MockNode('button');
      triggerBtn.setAttribute('data-antifan-open', 'nonExistentTarget');

      const overlay1 = new MockNode('div', ['category-navigation__block']);
      const overlay2 = new MockNode('div', ['drawer']);
      const overlay3 = new MockNode('div', ['offcanvas']);

      const nestedBtn = new MockNode('button');
      nestedBtn.setAttribute('data-antifan-open', 'anotherNonExistent');
      overlay2.children.push(nestedBtn);
      nestedBtn.parentElement = overlay2;

      body.children.push(triggerBtn, overlay1, overlay2, overlay3);
      triggerBtn.parentElement = body;
      overlay1.parentElement = body;
      overlay2.parentElement = body;
      overlay3.parentElement = body;

      const mockDoc = {
        body,
        readyState: 'complete',
        addEventListener: () => {},
        getElementById: (id: string) => body.querySelector('#' + id),
        querySelector: (sel: string) => body.querySelector(sel),
        querySelectorAll: (sel: string) => body.querySelectorAll(sel)
      };

      const ctx = vm.createContext({
        window: {
          addEventListener: () => {},
          innerWidth: 390,
          location: { search: '' },
          document: mockDoc
        },
        document: mockDoc,
        navigator: { userAgent: 'Mozilla/5.0' },
        setInterval: () => 1,
        clearInterval: () => {}
      });

      script.runInContext(ctx);

      // Trigger the unmatched open
      triggerBtn.dispatchEvent({ type: 'click' });

      // Exactly ONE overlay should open (the first fallback candidate), NOT all 3
      const openOverlays = [overlay1, overlay2, overlay3].filter(o => o.classList.contains('show') || o.classList.contains('active'));
      assert.strictEqual(openOverlays.length, 1, 'unmatched trigger must open at most one fallback overlay');
      assert.strictEqual(overlay1.classList.contains('show'), true, 'first fallback candidate opens');
      assert.strictEqual(overlay2.classList.contains('show'), false, 'subsequent overlays must not mass-open');
      assert.strictEqual(overlay3.classList.contains('show'), false, 'subsequent overlays must not mass-open');

      // Now test with a button nested inside an overlay: closest overlay ancestor wins
      nestedBtn.dispatchEvent({ type: 'click' });
      assert.strictEqual(overlay2.classList.contains('show'), true, 'closest overlay ancestor is prioritized over document order');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
