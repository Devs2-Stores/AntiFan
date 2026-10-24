import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { rankProducts, runPickProduct, type ProductSummary } from '../../src/main/qa/probes/pick-product';
import { makeDomDeps, openPage, readProbeFixture, STOREFRONT_ORIGIN, type FetchRoute } from './pdp-probe-harness';

interface FakeProduct {
  handle: string;
  title: string;
  variants: Array<{ id: number; available: boolean; featured_image: unknown }>;
  images: string[];
  available: boolean;
}

function product(handle: string, over: Partial<FakeProduct> = {}): FakeProduct {
  return {
    handle,
    title: `Sản phẩm ${handle}`,
    variants: [{ id: 1, available: true, featured_image: { src: `//cdn.example/${handle}.jpg` } }],
    images: [`//cdn.example/${handle}.jpg`],
    available: true,
    ...over,
  };
}

function listing(handles: string[]): FetchRoute {
  return { html: `<html><body>${handles.map((h) => `<a href="/collections/all/products/${h}">${h}</a><a href="/products/${h}?x=1">${h}</a>`).join('')}</body></html>` };
}

function storefront(pages: string[][], products: FakeProduct[]) {
  const routes: Record<string, FetchRoute> = {};
  pages.forEach((handles, i) => {
    routes[`/collections/all?page=${i + 1}`] = listing(handles);
  });
  for (const p of products) routes[`/products/${p.handle}.js`] = { json: p };
  const dom = openPage(readProbeFixture('pdp-not-product.html'), { url: `${STOREFRONT_ORIGIN}/`, routes });
  return makeDomDeps(dom).deps;
}

function variants(n: number): FakeProduct['variants'] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, available: true, featured_image: { src: '//cdn.example/x.jpg' } }));
}

describe('runPickProduct', () => {
  it('ranks by variant count, ties by handle, across paginated listings', async () => {
    const deps = storefront(
      [['zeta', 'alpha'], ['beta', 'gamma']],
      [
        product('zeta', { variants: variants(5) }),
        product('alpha', { variants: variants(2) }),
        product('beta', { variants: variants(5) }),
        product('gamma', { variants: variants(1) }),
      ],
    );

    const result = await runPickProduct(deps, { strategy: 'max-variants' });

    assert.strictEqual(result.measured, true, result.error);
    assert.strictEqual(result.passed, true);
    assert.deepStrictEqual(result.data.ranked, [
      { handle: 'beta', score: 5 },
      { handle: 'zeta', score: 5 },
      { handle: 'alpha', score: 2 },
      { handle: 'gamma', score: 1 },
    ]);
    assert.deepStrictEqual(result.data.handles, ['beta', 'zeta', 'alpha', 'gamma']);
  });

  it('picks the longest title for long-title', async () => {
    const deps = storefront([['a', 'b']], [product('a', { title: 'Ngắn' }), product('b', { title: 'Áo sơ mi nam tay dài cổ đức form rộng màu be' })]);

    const result = await runPickProduct(deps, { strategy: 'long-title' });

    assert.strictEqual(result.data.handles[0], 'b');
  });

  it('returns only products with a sold-out signal for sold-out', async () => {
    const deps = storefront(
      [['in-stock', 'gone', 'partial']],
      [
        product('in-stock'),
        product('gone', { available: false, variants: [{ id: 1, available: false, featured_image: null }] }),
        product('partial', { variants: [{ id: 1, available: true, featured_image: null }, { id: 2, available: false, featured_image: null }] }),
      ],
    );

    const result = await runPickProduct(deps, { strategy: 'sold-out' });

    assert.deepStrictEqual(result.data.handles, ['gone', 'partial']);
  });

  it('puts a product without images first for no-image', async () => {
    const deps = storefront([['has', 'bare']], [product('has'), product('bare', { images: [], variants: [{ id: 1, available: true, featured_image: null }] })]);

    const result = await runPickProduct(deps, { strategy: 'no-image' });

    assert.deepStrictEqual(result.data.handles, ['bare']);
  });

  it('stops at sampleLimit and reports no match as an info finding with passed null', async () => {
    const deps = storefront([['a', 'b', 'c', 'd', 'e']], ['a', 'b', 'c', 'd', 'e'].map((h) => product(h)));

    const result = await runPickProduct(deps, { strategy: 'sold-out', sampleLimit: 3 });

    assert.strictEqual(result.data.ranked.length, 3);
    assert.deepStrictEqual(result.data.handles, []);
    assert.strictEqual(result.passed, null);
    assert.strictEqual(result.findings[0]?.ruleId, 'pick-product-no-match');
  });

  it('falls back to /products.json aliases on a Sapo storefront whose cards link bare aliases', async () => {
    const routes: Record<string, FetchRoute> = {
      '/collections/all?page=1': { html: '<html><body><a href="/alpha">alpha</a><a href="/beta">beta</a><a href="/giay-nam">Nam</a></body></html>' },
      '/products.json?page=1': { json: { products: [{ alias: 'alpha' }, { alias: 'beta' }] } },
      '/products.json?page=2': { json: { products: [] } },
      '/products/alpha.js': { json: product('alpha', { variants: variants(2) }) },
      '/products/beta.js': { json: product('beta', { variants: variants(6) }) },
    };
    const deps = makeDomDeps(openPage(readProbeFixture('pdp-not-product.html'), { url: `${STOREFRONT_ORIGIN}/`, routes })).deps;

    const result = await runPickProduct(deps, { strategy: 'max-variants' });

    assert.strictEqual(result.measured, true, result.error);
    assert.deepStrictEqual(result.data.handles, ['beta', 'alpha']);
  });

  it('is not measured when the listing exposes no product link', async () => {
    const deps = storefront([[]], []);

    const result = await runPickProduct(deps, { strategy: 'max-variants' });

    assert.strictEqual(result.measured, false);
    assert.strictEqual(result.passed, null);
    assert.match(result.error ?? '', /no product links/);
  });

  it('rejects an unknown strategy without touching the page', async () => {
    const deps = storefront([['a']], [product('a')]);

    const result = await runPickProduct(deps, { strategy: 'cheapest' as never });

    assert.strictEqual(result.measured, false);
    assert.match(result.error ?? '', /unknown strategy/);
  });
});

describe('rankProducts', () => {
  it('is deterministic regardless of input order', () => {
    const base: ProductSummary = { handle: '', title: '', variants: 3, unavailableVariants: 0, available: true, images: 1, variantsWithoutImage: 0 };
    const items = ['m', 'a', 'z'].map((handle) => ({ ...base, handle }));
    const forward = rankProducts('max-variants', items);
    const reversed = rankProducts('max-variants', [...items].reverse());
    assert.deepStrictEqual(forward, reversed);
    assert.deepStrictEqual(forward.map((r) => r.handle), ['a', 'm', 'z']);
  });
});
