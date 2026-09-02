import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BlueprintExtractor } from './blueprint-extractor.js';

describe('BlueprintExtractor - AST DOM Parsing & Safety Invariants', () => {
  const extractor = new BlueprintExtractor();

  it('1. Sanitizes path traversal sequences in section IDs and asserts strict invariant', () => {
    const maliciousHtml = `
      <section id="../../../etc/passwd" class="block-category">
        <h2>Contactor Schneider</h2>
      </section>
    `;

    const sections = extractor.extractSections(maliciousHtml);
    assert.strictEqual(sections.length, 1);
    const sec = sections[0];
    assert.ok(!sec.id.includes('..'), 'Must strip traversal ..');
    assert.ok(!sec.id.includes('/'), 'Must strip forward slash');
    assert.ok(!sec.id.includes('\\'), 'Must strip backslash');
    assert.match(sec.id, /^[a-zA-Z0-9_-]+$/, 'ID must match valid safe identifier charset');
  });

  it('2. Disambiguates duplicate section IDs and duplicate class names', () => {
    const dupHtml = `
      <section id="featured_block" class="block-category">
        <h2>Contactor</h2>
      </section>
      <section id="featured_block" class="block-category">
        <h2>Biến Tần</h2>
      </section>
      <section class="block-category">
        <h2>Cảm Biến</h2>
      </section>
    `;

    const sections = extractor.extractSections(dupHtml);
    assert.strictEqual(sections.length, 3);
    const ids = sections.map(s => s.id);
    const uniqueIds = new Set(ids);
    assert.strictEqual(uniqueIds.size, 3, 'All extracted section IDs must be unique');
    for (const id of ids) {
      assert.match(id, /^[a-zA-Z0-9_-]+$/);
    }
  });

  it('3. Extracts child banner blocks from hero slider HTML', () => {
    const sliderHtml = `
      <section class="slide">
        <div class="slide-content">
          <div class="slide-content__detail">
            <div class="s-content">
              <div class="s-content__item">
                <a href="/promo-1"><img src="https://img.hoplongtech.com/banner1.jpg" alt="Banner 1"></a>
              </div>
              <div class="s-content__item">
                <a href="/promo-2"><img src="https://img.hoplongtech.com/banner2.jpg" alt="Banner 2"></a>
              </div>
            </div>
          </div>
        </div>
      </section>
    `;

    const sections = extractor.extractSections(sliderHtml);
    assert.strictEqual(sections.length, 1);
    const slider = sections[0];
    assert.strictEqual(slider.type, 'hero-slider');
    assert.strictEqual(slider.blockDefinitions.length, 1);
    assert.strictEqual(slider.blockDefinitions[0].type, 'slide_item');
    assert.strictEqual(slider.blockInstances.length, 2);
    assert.strictEqual(slider.blockInstances[0].settings.image_url, 'https://img.hoplongtech.com/banner1.jpg');
    assert.strictEqual(slider.blockInstances[0].settings.link, '/promo-1');
    assert.strictEqual(slider.blockInstances[1].settings.image_url, 'https://img.hoplongtech.com/banner2.jpg');
    assert.strictEqual(slider.blockInstances[1].settings.link, '/promo-2');
  });

  it('4. Asserts strict ID and className safety invariants against hostile inputs', () => {
    const rawClass = 'custom-sec" onclick="alert(2)" {{ settings.injected }}';
    const sanitizedClass = extractor.sanitizeClassName(rawClass);

    assert.ok(!sanitizedClass.includes('"'), 'ClassName must not contain double quotes');
    assert.ok(!sanitizedClass.includes("'"), 'ClassName must not contain single quotes');
    assert.ok(!sanitizedClass.includes('{{'), 'ClassName must not contain Liquid brackets');
    assert.ok(!sanitizedClass.includes('}}'), 'ClassName must not contain Liquid brackets');
    assert.match(sanitizedClass, /^(?:[A-Za-z0-9_-]+)(?: [A-Za-z0-9_-]+)*$/, 'ClassName must be space-separated valid tokens');

    const cleanId = extractor.sanitizeAndDedupeId('  <script>alert(1)</script> \0 ', 'section_fallback');
    assert.match(cleanId, /^[a-zA-Z0-9_-]+$/, 'ID must be safe alphanumeric');
    assert.ok(!cleanId.includes('<'));
    assert.ok(!cleanId.includes('>'));
    assert.ok(!cleanId.includes('\0'));
  });

  it('5. Extracts nested sections hierarchy without dropping inner sections', () => {
    const nestedHtml = `
      <section id="parent_wrapper" class="outer-section">
        <h2>Parent Section</h2>
        <div class="nested-container">
          <section id="inner_child_1" class="block-category">
            <h3>Nested Child 1</h3>
          </section>
          <section id="inner_child_2" class="block-category">
            <h3>Nested Child 2</h3>
          </section>
        </div>
      </section>
    `;

    const sections = extractor.extractSections(nestedHtml);
    assert.strictEqual(sections.length, 3, 'Must extract both parent and nested child sections');
    assert.strictEqual(sections[0].id, 'parent_wrapper');
    assert.strictEqual(sections[1].id, 'inner_child_1');
    assert.strictEqual(sections[2].id, 'inner_child_2');
    assert.strictEqual(sections[1].heading, 'Nested Child 1');
    assert.strictEqual(sections[2].heading, 'Nested Child 2');
  });

  it('6. Correctly parses raw text in script and style tags containing angle brackets without splitting markup', () => {
    const htmlWithScripts = `
      <section id="script_sec" class="custom-section">
        <h2>Script Section</h2>
        <script>
          if (a < b && c > d) {
            console.log("<div>not a tag</div>");
          }
        </script>
        <div class="item">
          <span>Real Item</span>
        </div>
      </section>
    `;

    const sections = extractor.extractSections(htmlWithScripts);
    assert.strictEqual(sections.length, 1);
    assert.strictEqual(sections[0].id, 'script_sec');
    assert.strictEqual(sections[0].heading, 'Script Section');
  });
});
