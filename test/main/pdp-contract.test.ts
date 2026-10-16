import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { runPdpContract } from '../../src/main/qa/probes/pdp-contract';
import { makeDomDeps, openPage, readProbeFixture, STOREFRONT_ORIGIN } from './pdp-probe-harness';

const ALL_TOKENS = ['add-to-cart', 'availability', 'breadcrumb', 'buy-now', 'compare-at', 'price', 'quantity', 'related', 'size-guide', 'sku', 'variant-selector'];

describe('runPdpContract', () => {
  it('passes a complete product page and lists every element as present', async () => {
    const { deps } = makeDomDeps(openPage(readProbeFixture('pdp-good.html')));

    const result = await runPdpContract(deps);

    assert.strictEqual(result.measured, true, result.error);
    assert.strictEqual(result.passed, true);
    assert.deepStrictEqual(result.data.missing, []);
    assert.deepStrictEqual([...result.data.present].sort(), ALL_TOKENS);
    assert.strictEqual(result.data.hasSizeOption, true);
    assert.deepStrictEqual(result.findings, []);
  });

  it('reports size-guide as the only missing element when a size option has no guide opener', async () => {
    const { deps } = makeDomDeps(openPage(readProbeFixture('pdp-no-size-guide.html')));

    const result = await runPdpContract(deps);

    assert.strictEqual(result.measured, true, result.error);
    assert.deepStrictEqual(result.data.missing, ['size-guide']);
    assert.strictEqual(result.data.hasSizeOption, true);
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.findings.map((f) => [f.ruleId, f.severity]), [['pdp-contract-missing-size-guide', 'critical']]);
    assert.ok(!result.data.present.includes('compare-at'), 'a product that is not on sale is not expected to show a compare-at price');
    assert.ok(!result.data.present.includes('sku') && !result.data.missing.includes('sku'), 'no variant carries a SKU, so none is expected');
  });

  it('does not require a size guide when the product has no size option', async () => {
    const html = readProbeFixture('pdp-no-size-guide.html')
      .replace('"options":["Màu sắc","Kích thước"]', '"options":["Màu sắc"]')
      .replace(/"option2":"[SM]",/g, '')
      .replace(/<div class="selector-wrapper"[\s\S]*?<\/select>\s*<\/div>/, '');
    const { deps } = makeDomDeps(openPage(html));

    const result = await runPdpContract(deps);

    assert.strictEqual(result.data.hasSizeOption, false);
    assert.ok(!result.data.missing.includes('size-guide'));
    assert.strictEqual(result.passed, true, JSON.stringify(result.findings));
  });

  it('fails when the add-to-cart button is removed', async () => {
    const html = readProbeFixture('pdp-good.html').replace('<button type="submit" name="add" class="add-to-cart">Thêm vào giỏ hàng</button>', '');
    const { deps } = makeDomDeps(openPage(html));

    const result = await runPdpContract(deps);

    assert.deepStrictEqual(result.data.missing, ['add-to-cart']);
    assert.strictEqual(result.passed, false);
  });

  it('names the options that have no selector when the variant selector is missing', async () => {
    const html = readProbeFixture('pdp-good.html').replace(/<div class="swatch"[\s\S]*?<label for="sw-den"[^>]*>Đen<\/label>\s*<\/div>/, '');
    const { deps } = makeDomDeps(openPage(html));

    const result = await runPdpContract(deps);

    assert.deepStrictEqual(result.data.missing, ['variant-selector']);
    const finding = result.findings.find((f) => f.ruleId === 'pdp-contract-missing-variant-selector');
    assert.ok(finding);
    assert.deepStrictEqual(finding.measured?.options, ['Màu sắc']);
  });

  it('flags a missing compare-at price only when the variant is actually on sale', async () => {
    const html = readProbeFixture('pdp-good.html').replace('<del class="price-compare">550.000₫</del>', '');
    const { deps } = makeDomDeps(openPage(html));

    const result = await runPdpContract(deps);

    assert.deepStrictEqual(result.data.missing, ['compare-at']);
    assert.strictEqual(result.findings[0]?.severity, 'warning');
    assert.strictEqual(result.passed, true, 'a warning does not fail the contract');
  });

  it('is not measured (and not failed) on a page that is not a product page', async () => {
    const { deps } = makeDomDeps(openPage(readProbeFixture('pdp-not-product.html'), { url: `${STOREFRONT_ORIGIN}/` }));

    const result = await runPdpContract(deps);

    assert.strictEqual(result.measured, false);
    assert.strictEqual(result.passed, null);
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(result.data, { missing: [], present: [], hasSizeOption: false });
  });
});
