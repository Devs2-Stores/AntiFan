import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { sanitizeSectionMarkup } from './independent-html-clone-generator.js';

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
});
