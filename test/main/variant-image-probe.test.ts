import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { runVariantImageProbe, buildVariantCollectScript } from '../../src/main/qa/probes/variant-image-probe';
import { makeDomDeps, openPage, readProbeFixture, STOREFRONT_ORIGIN } from './pdp-probe-harness';

function checkedColour(doc: Document): string | undefined {
  return doc.querySelector<HTMLInputElement>('input[name="option-1"]:checked')?.value;
}

describe('runVariantImageProbe', () => {
  it('passes a PDP whose gallery follows every colour and size, clicks only option controls, and restores the initial selection', async () => {
    const dom = openPage(readProbeFixture('pdp-good.html'));
    const { deps, clicks, submitted } = makeDomDeps(dom);

    const result = await runVariantImageProbe(deps, {});

    assert.strictEqual(result.measured, true, result.error);
    assert.strictEqual(result.passed, true);
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(result.data.optionValuesCount, { 'Màu sắc': 3, 'Kích thước': 2 });
    const colours = result.data.perValue.filter((r) => r.option === 'Màu sắc');
    assert.deepStrictEqual(colours.map((r) => r.value), ['Đỏ', 'Xanh', 'Đen']);
    assert.deepStrictEqual(colours.map((r) => r.expectedImage), ['ao-do', 'ao-xanh', 'ao-den']);
    assert.deepStrictEqual(colours.map((r) => r.shownImage), ['ao-do', 'ao-xanh', 'ao-den']);
    assert.deepStrictEqual(colours.map((r) => r.changed), [false, true, true]);
    assert.ok(result.data.perValue.every((r) => !r.mismatch));
    assert.ok(clicks.every((s) => s.startsWith('[data-antifan-probe=')), `only probe-tagged option controls may be clicked, got ${clicks.join(' | ')}`);
    assert.strictEqual(submitted(), false, 'the add-to-cart form must never be submitted');
    assert.strictEqual(checkedColour(dom.window.document), 'Đỏ', 'the original colour is selected again');
    assert.strictEqual(dom.window.document.querySelector<HTMLInputElement>('input[name="id"]')?.value, '101');
  });

  it('reads the product gallery, not a related-products carousel that also marks a current slide', async () => {
    const related = '<section class="related"><div class="related__slide swiper-slide-active"><a href="/products/other"><img src="//cdn.example/products/other-shoe_1024x1024.jpg" alt=""></a></div></section>';
    const dom = openPage(readProbeFixture('pdp-good.html').replace('<body>', `<body>${related}`));
    const { deps } = makeDomDeps(dom);

    const result = await runVariantImageProbe(deps, {});

    assert.strictEqual(result.measured, true, result.error);
    const colours = result.data.perValue.filter((r) => r.option === 'Màu sắc');
    assert.deepStrictEqual(colours.map((r) => r.shownImage), ['ao-do', 'ao-xanh', 'ao-den']);
    assert.strictEqual(result.passed, true, JSON.stringify(result.findings));
  });

  it('fails with swatch-no-image-switch when different colours keep showing the same gallery image', async () => {
    const dom = openPage(readProbeFixture('pdp-swatch-no-switch.html'));
    const { deps } = makeDomDeps(dom);

    const result = await runVariantImageProbe(deps, {});

    assert.strictEqual(result.measured, true, result.error);
    assert.strictEqual(result.passed, false);
    const finding = result.findings.find((f) => f.ruleId === 'swatch-no-image-switch');
    assert.ok(finding, `expected swatch-no-image-switch in ${JSON.stringify(result.findings)}`);
    assert.strictEqual(finding.severity, 'critical');
    assert.strictEqual(finding.measured?.option, 'Màu sắc');
    assert.deepStrictEqual([...(finding.measured?.values as string[])].sort(), ['Xanh', 'Đen', 'Đỏ'].sort());
    const xanh = result.data.perValue.find((r) => r.value === 'Xanh');
    assert.strictEqual(xanh?.expectedImage, 'ao-xanh');
    assert.strictEqual(xanh?.shownImage, 'ao-do');
    assert.strictEqual(xanh?.mismatch, true);
    assert.strictEqual(xanh?.changed, false);
  });

  it('reports variant-missing-featured-image when a colour has no variant image', async () => {
    const html = readProbeFixture('pdp-good.html').replace(/"featured_image":\{"src":"\/\/cdn\.example\/products\/ao-den_master\.jpg"\}/g, '"featured_image":null');
    const dom = openPage(html);
    const { deps } = makeDomDeps(dom);

    const result = await runVariantImageProbe(deps, {});

    assert.strictEqual(result.passed, false);
    const finding = result.findings.find((f) => f.ruleId === 'variant-missing-featured-image');
    assert.ok(finding, JSON.stringify(result.findings));
    assert.deepStrictEqual(finding.measured?.values, ['Đen']);
  });

  it('flags option-values-excess as info for more than 8 colour controls and stays passing', async () => {
    const colours = Array.from({ length: 9 }, (_, i) => `Mau${i + 1}`);
    const variants = colours.map((c, i) => ({ id: 500 + i, option1: c, available: true, price: 1000, sku: `S${i}`, featured_image: { src: '//cdn.example/products/shared_master.jpg' } }));
    const swatches = colours.map((c, i) => `<input type="radio" id="c${i}" name="option-1" value="${c}"${i === 0 ? ' checked' : ''}><label for="c${i}" data-value="${c}">${c}</label>`).join('');
    const html = `<!doctype html><html><body><main>
      <div class="product-gallery"><div class="swiper-slide swiper-slide-active"><img src="//cdn.example/products/shared_1024x1024.jpg"></div></div>
      <form action="/cart/add"><input type="hidden" name="id" value="500"><div data-option-position="1"><div class="header">Màu sắc</div>${swatches}</div></form>
      <script type="application/json" data-product-json>${JSON.stringify({ handle: 'ao-so-mi', options: [{ name: 'Màu sắc', values: colours }], variants })}</script>
    </main></body></html>`;
    const dom = openPage(html);
    const { deps } = makeDomDeps(dom);

    const result = await runVariantImageProbe(deps, { maxValues: 4 });

    assert.strictEqual(result.passed, true, JSON.stringify(result.findings));
    assert.strictEqual(result.data.perValue.length, 4, 'maxValues caps the clicked values per option');
    const excess = result.findings.find((f) => f.ruleId === 'option-values-excess');
    assert.ok(excess);
    assert.strictEqual(excess.severity, 'info');
    assert.strictEqual(result.data.optionValuesCount['Màu sắc'], 9);
  });

  for (const [where, url] of [
    ['a /products/<handle> URL', `${STOREFRONT_ORIGIN}/products/ao-so-mi`],
    ['a Sapo bare-alias URL marked og:type=product', `${STOREFRONT_ORIGIN}/ao-so-mi`],
  ] as const) it(`resolves the product through /products/<handle>.js on ${where} when the page embeds no product JSON`, async () => {
    const html = readProbeFixture('pdp-good.html');
    const embedded = /<script type="application\/json" data-product-json>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(embedded);
    const product = JSON.parse(embedded[1] ?? 'null') as unknown;
    const dom = openPage(html.replace(embedded[0] ?? '', '').replace(/<script>[\s\S]*?<\/script>/, ''), { url, routes: { '/products/ao-so-mi.js': { json: product } } });
    // The fixture's page script reads the embedded block, so the swatch handler is re-created from the fetched product.
    dom.window.eval(`(function () {
      var product = ${JSON.stringify(product)};
      var slides = [].slice.call(document.querySelectorAll('.swiper-slide'));
      document.addEventListener('change', function () {
        var colour = document.querySelector('input[name="option-1"]:checked').value;
        var size = document.querySelector('select[name="option-2"]').value;
        var v = product.variants.filter(function (x) { return x.option1 === colour && x.option2 === size; })[0];
        document.querySelector('input[name="id"]').value = v.id;
        var key = v.featured_image.src.split('/').pop().replace('_master.jpg', '');
        slides.forEach(function (s) { s.classList.toggle('swiper-slide-active', s.getAttribute('data-key') === key); });
      });
    })()`);
    const { deps } = makeDomDeps(dom);

    const result = await runVariantImageProbe(deps, {});

    assert.strictEqual(result.measured, true, result.error);
    assert.strictEqual(result.passed, true, JSON.stringify(result.findings));
    assert.strictEqual(result.data.perValue.length, 5);
  });

  it('is not measured on a page without product metadata and clicks nothing', async () => {
    const dom = openPage(readProbeFixture('pdp-not-product.html'), { url: `${STOREFRONT_ORIGIN}/` });
    const { deps, clicks } = makeDomDeps(dom);

    const result = await runVariantImageProbe(deps, {});

    assert.strictEqual(result.measured, false);
    assert.strictEqual(result.passed, null);
    assert.deepStrictEqual(clicks, []);
  });

  it('navigates to the requested product when it differs from the current page, and refuses when navigation is unavailable', async () => {
    const withNav = makeDomDeps(openPage(readProbeFixture('pdp-good.html')), { navigate: true });
    await runVariantImageProbe(withNav.deps, { productHandle: 'other-product' });
    assert.deepStrictEqual(withNav.navigations, [`${STOREFRONT_ORIGIN}/products/other-product`]);

    const withoutNav = makeDomDeps(openPage(readProbeFixture('pdp-good.html')));
    const refused = await runVariantImageProbe(withoutNav.deps, { productHandle: 'other-product' });
    assert.strictEqual(refused.measured, false);
    assert.match(refused.error ?? '', /other-product/);
    assert.deepStrictEqual(withoutNav.clicks, []);
  });
});

describe('buildVariantCollectScript', () => {
  it('embeds the requested handle and value cap as JSON literals', () => {
    const script = buildVariantCollectScript({ handle: 'áo "đẹp"', maxValues: 7 });
    assert.ok(script.includes('var hint = "áo \\"đẹp\\"";'));
    assert.ok(script.includes('var maxValues = 7;'));
  });
});
