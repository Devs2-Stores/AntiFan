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

  it('7. Prioritizes semantic section classes over generic carousel structure', () => {
    const newsHtml = `<section class="section-news"><div class="s-wrap"><div class="s-content"><div class="item">Article 1</div></div></div></section>`;
    const accessoryHtml = `<section class="section-accessory"><div class="s-wrap"><div class="s-content"><div class="item">Accessory 1</div></div></div></section>`;
    const partnerHtml = `<section class="section-partner"><div class="s-wrap"><div class="s-content"><div class="item">Partner 1</div></div></div></section>`;

    const newsSec = extractor.extractSections(newsHtml)[0];
    const accSec = extractor.extractSections(accessoryHtml)[0];
    const partSec = extractor.extractSections(partnerHtml)[0];

    assert.strictEqual(newsSec.type, 'news');
    assert.strictEqual(accSec.type, 'accessory-showcase');
    assert.strictEqual(partSec.type, 'partner-carousel');
  });

  it('8. Walks top-level document order: layout containers are descended, class-based footers and non-section blocks are kept', () => {
    const html = `
      <body>
        <header class="site-header"><h1>Header</h1></header>
        <main>
          <div class="page-wrapper">
            <h1 class="home-title">Storefront Title</h1>
            <section class="slide"><h2>Hero</h2></section>
            <div class="grid-wrapper"><section class="block-category"><h3>Products</h3></section></div>
          </div>
        </main>
        <div class="site-footer w-100"><p>Footer content</p></div>
        <div class="notice-cart"><p>Cart drawer</p></div>
      </body>`;

    const sections = extractor.extractSections(html);

    assert.deepStrictEqual(
      sections.map((s) => `${s.type}:${s.className}`),
      [
        'header:site-header',
        'custom-content:home-title',
        'hero-slider:slide',
        'featured-products:block-category',
        'footer:site-footer w-100',
        'custom-content:notice-cart'
      ],
      'Must keep every top-level block in document order, including the class-based footer'
    );
    assert.ok(sections[4].rawHtml.includes('Footer content'), 'Class-based footer markup must be preserved');
    assert.ok(!sections.some((s) => s.tagName === 'main'), 'Layout containers must not become opaque blocks');
  });

  it('9. Classifies a top-level wrapper that only carries page chrome as that chrome', () => {
    const html = `
      <body>
        <main>
          <section class="news"><h2>News</h2></section>
        </main>
        <div wire:id="abc123"><footer class="site-footer"><p>Footer content</p></footer></div>
      </body>`;

    const sections = extractor.extractSections(html);

    // A wrapper whose only structural child is the site footer IS the footer. Left
    // as content it is emitted inside <main> by the clone generator, and the page
    // chrome ends up nested in the content column.
    assert.deepStrictEqual(sections.map((s) => s.type), ['news', 'footer']);
    const footer = sections[1];
    assert.ok(footer.rawHtml.includes('wire:id="abc123"'), 'Wrapper attributes must survive verbatim');
    assert.ok(footer.rawHtml.includes('<footer class="site-footer">'), 'Footer element must stay inside its wrapper');
  });

  it('10. Keeps a layout wrapper that carries framework bindings instead of descending into it', () => {
    const wrapper = (attrs: string) => `
      <body>
        <main>
          <div${attrs}>
            <section class="block-category"><h3>Motors</h3></section>
            <section class="block-category"><h3>Drives</h3></section>
          </div>
        </main>
      </body>`;

    const bound = extractor.extractSections(wrapper(' wire:id="abc123" wire:snapshot="{&quot;data&quot;:{}}" wire:effects="{&quot;xjs&quot;:[{&quot;expression&quot;:&quot;$(\'.block-category__list\').slick({slidesToShow: 1.8})&quot;}]}"'));
    const boundHtml = bound.map((s) => s.rawHtml).join('');
    const boundSections = bound.filter((s) => s.className.includes('block-category'));

    // Descending into the wrapper drops the binding, and the initializer it carries is
    // what lays these sections out: the live mobile page renders each at 76px, the
    // clone that lost the binding rendered each at 341px.
    assert.ok(boundHtml.includes('wire:effects'), 'A binding that lives on the wrapper must survive extraction');
    assert.ok(boundHtml.includes('slick({slidesToShow: 1.8})'), 'The initializer inside that binding must survive');
    assert.strictEqual(boundSections.length, 0, 'The wrapper is one section, not a set of siblings once its binding is kept');
    assert.strictEqual(bound.length, 1, 'The wrapper is emitted as a single section');

    const plain = extractor.extractSections(wrapper(' class="grid-wrapper"'));
    assert.strictEqual(plain.length, 2, 'A wrapper with no binding is still a layout container and is descended into');
    assert.deepStrictEqual(plain.map((s) => s.className), ['block-category', 'block-category']);
  });
});
