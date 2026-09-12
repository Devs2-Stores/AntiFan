import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  sanitizeSectionMarkup,
  decodeHtmlEntities,
  extractEmbeddedEffects
} from './independent-html-clone-generator.js';

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
