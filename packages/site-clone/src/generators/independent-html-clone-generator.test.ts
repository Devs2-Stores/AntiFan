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
});
