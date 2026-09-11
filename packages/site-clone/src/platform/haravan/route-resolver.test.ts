import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouteResolver } from './route-resolver.js';

describe('RouteResolver - Haravan Route Mapping & Identity Engine (Audit §10 - §11, P0.3)', () => {
  const resolver = new RouteResolver();

  describe('resolveReferenceUrl', () => {
    it('resolves home routes with various formats', () => {
      const cases = ['/', '', '   ', 'https://example.com', 'https://example.com/', 'https://example.com/?ref=ads'];
      for (const input of cases) {
        const res = resolver.resolveReferenceUrl(input);
        assert.equal(res.inferredKind, 'home', `Expected 'home' for ${input}`);
        assert.equal(res.pathname, '/');
        assert.equal(res.extractedHandle, undefined);
      }
    });

    it('resolves standard product routes', () => {
      const res = resolver.resolveReferenceUrl('/products/running-shoes');
      assert.equal(res.inferredKind, 'product');
      assert.equal(res.extractedHandle, 'running-shoes');
      assert.equal(res.pathname, '/products/running-shoes');
    });

    it('handles product route edge cases (trailing slash, query params, hash, .html)', () => {
      const url = 'https://myshop.com/products/running-shoes/?variant=1002&utm_source=fb#details';
      const res = resolver.resolveReferenceUrl(url);
      assert.equal(res.inferredKind, 'product');
      assert.equal(res.extractedHandle, 'running-shoes');
      assert.equal(res.pathname, '/products/running-shoes');

      const htmlRes = resolver.resolveReferenceUrl('/products/running-shoes.html');
      assert.equal(htmlRes.inferredKind, 'product');
      assert.equal(htmlRes.extractedHandle, 'running-shoes');
      assert.equal(htmlRes.pathname, '/products/running-shoes');
    });

    it('resolves nested collection-product URLs to product kind', () => {
      const url = '/collections/summer-sale/products/sunglasses-polarized';
      const res = resolver.resolveReferenceUrl(url);
      assert.equal(res.inferredKind, 'product');
      assert.equal(res.extractedHandle, 'sunglasses-polarized');
      assert.equal(res.pathname, '/collections/summer-sale/products/sunglasses-polarized');
    });

    it('resolves Vietnamese product alias routes', () => {
      const res = resolver.resolveReferenceUrl('/san-pham/ao-thun-cotton-unisex');
      assert.equal(res.inferredKind, 'product');
      assert.equal(res.extractedHandle, 'ao-thun-cotton-unisex');
    });

    it('resolves standard collection routes', () => {
      const res = resolver.resolveReferenceUrl('/collections/footwear');
      assert.equal(res.inferredKind, 'collection');
      assert.equal(res.extractedHandle, 'footwear');
      assert.equal(res.pathname, '/collections/footwear');
    });

    it('defaults bare /collections to all', () => {
      const res = resolver.resolveReferenceUrl('/collections');
      assert.equal(res.inferredKind, 'collection');
      assert.equal(res.extractedHandle, 'all');
    });

    it('handles collection pagination via query param and path segment', () => {
      // Query param pagination
      const qRes = resolver.resolveReferenceUrl('/collections/footwear?page=2');
      assert.equal(qRes.inferredKind, 'collection');
      assert.equal(qRes.extractedHandle, 'footwear');

      // Path-based pagination
      const pRes = resolver.resolveReferenceUrl('/collections/footwear/page/3/');
      assert.equal(pRes.inferredKind, 'collection');
      assert.equal(pRes.extractedHandle, 'footwear');
      assert.equal(pRes.pathname, '/collections/footwear/page/3');
    });

    it('resolves nested collection routes', () => {
      const res = resolver.resolveReferenceUrl('/collections/men/shoes');
      assert.equal(res.inferredKind, 'collection');
      assert.equal(res.extractedHandle, 'men/shoes');

      const pRes = resolver.resolveReferenceUrl('/collections/men/shoes/page/2');
      assert.equal(pRes.inferredKind, 'collection');
      assert.equal(pRes.extractedHandle, 'men/shoes');
    });

    it('resolves Vietnamese collection alias routes', () => {
      const res = resolver.resolveReferenceUrl('/danh-muc/phu-kien-thoi-trang');
      assert.equal(res.inferredKind, 'collection');
      assert.equal(res.extractedHandle, 'phu-kien-thoi-trang');
    });

    it('resolves blog listing routes and pagination', () => {
      const res = resolver.resolveReferenceUrl('/blogs/tech-news');
      assert.equal(res.inferredKind, 'blog');
      assert.equal(res.extractedHandle, 'tech-news');

      const pageRes = resolver.resolveReferenceUrl('/blogs/tech-news/page/2');
      assert.equal(pageRes.inferredKind, 'blog');
      assert.equal(pageRes.extractedHandle, 'tech-news');
    });

    it('resolves standard blog article routes', () => {
      const res = resolver.resolveReferenceUrl('/blogs/news/spring-collection-launch');
      assert.equal(res.inferredKind, 'article');
      assert.equal(res.extractedHandle, 'news/spring-collection-launch');
      assert.equal(res.pathname, '/blogs/news/spring-collection-launch');
    });

    it('resolves Shopify-style /blogs/:blog/articles/:article routes', () => {
      const res = resolver.resolveReferenceUrl('/blogs/updates/articles/new-feature-announcement');
      assert.equal(res.inferredKind, 'article');
      assert.equal(res.extractedHandle, 'updates/new-feature-announcement');
    });

    it('resolves Vietnamese article alias routes', () => {
      const res = resolver.resolveReferenceUrl('/bai-viet/huong-dan-mua-hang');
      assert.equal(res.inferredKind, 'article');
      assert.equal(res.extractedHandle, 'huong-dan-mua-hang');
    });

    it('resolves page routes', () => {
      const res = resolver.resolveReferenceUrl('/pages/about-us');
      assert.equal(res.inferredKind, 'page');
      assert.equal(res.extractedHandle, 'about-us');
      assert.equal(res.pathname, '/pages/about-us');

      const vnRes = resolver.resolveReferenceUrl('/trang/chinh-sach-bao-hanh');
      assert.equal(vnRes.inferredKind, 'page');
      assert.equal(vnRes.extractedHandle, 'chinh-sach-bao-hanh');
    });

    it('resolves cart routes', () => {
      const res = resolver.resolveReferenceUrl('/cart');
      assert.equal(res.inferredKind, 'cart');
      assert.equal(res.pathname, '/cart');

      const vnRes = resolver.resolveReferenceUrl('/gio-hang');
      assert.equal(vnRes.inferredKind, 'cart');
    });

    it('resolves search routes with query params', () => {
      const res = resolver.resolveReferenceUrl('/search?q=running+shoes&type=product');
      assert.equal(res.inferredKind, 'search');
      assert.equal(res.pathname, '/search');

      const vnRes = resolver.resolveReferenceUrl('/tim-kiem?q=vay');
      assert.equal(vnRes.inferredKind, 'search');
    });

    it('resolves 404 routes', () => {
      const res = resolver.resolveReferenceUrl('/404');
      assert.equal(res.inferredKind, '404');

      const htmlRes = resolver.resolveReferenceUrl('/404.html');
      assert.equal(htmlRes.inferredKind, '404');
    });

    it('resolves custom fallback routes', () => {
      const res = resolver.resolveReferenceUrl('/lookbook-2026/summer');
      assert.equal(res.inferredKind, 'custom');
      assert.equal(res.extractedHandle, 'lookbook-2026/summer');
      assert.equal(res.pathname, '/lookbook-2026/summer');
    });
  });

  describe('mapToHaravanRoute', () => {
    it('maps home route to HaravanRouteIdentity', () => {
      const ref = resolver.resolveReferenceUrl('/');
      const target = resolver.mapToHaravanRoute(ref);
      assert.deepEqual(target, {
        kind: 'home',
        pattern: '/',
        template: 'index.liquid',
        objectType: 'root',
        canonicalUrl: '/',
      });
    });

    it('maps product route to HaravanRouteIdentity', () => {
      const ref = resolver.resolveReferenceUrl('/products/nike-air-max');
      const target = resolver.mapToHaravanRoute(ref);
      assert.deepEqual(target, {
        kind: 'product',
        pattern: '/products/:handle',
        template: 'product.liquid',
        objectType: 'product',
        handle: 'nike-air-max',
        canonicalUrl: '/products/nike-air-max',
      });
    });

    it('maps collection route to HaravanRouteIdentity', () => {
      const ref = resolver.resolveReferenceUrl('/collections/shoes');
      const target = resolver.mapToHaravanRoute(ref);
      assert.deepEqual(target, {
        kind: 'collection',
        pattern: '/collections/:handle',
        template: 'collection.liquid',
        objectType: 'collection',
        handle: 'shoes',
        canonicalUrl: '/collections/shoes',
      });
    });

    it('maps blog article route to HaravanRouteIdentity', () => {
      const ref = resolver.resolveReferenceUrl('/blogs/news/product-launch');
      const target = resolver.mapToHaravanRoute(ref);
      assert.deepEqual(target, {
        kind: 'article',
        pattern: '/blogs/:blog/:article',
        template: 'article.liquid',
        objectType: 'article',
        handle: 'news/product-launch',
        canonicalUrl: '/blogs/news/product-launch',
      });
    });

    it('maps blog listing route to HaravanRouteIdentity', () => {
      const ref = resolver.resolveReferenceUrl('/blogs/news');
      const target = resolver.mapToHaravanRoute(ref);
      assert.deepEqual(target, {
        kind: 'blog',
        pattern: '/blogs/:handle',
        template: 'blog.liquid',
        objectType: 'blog',
        handle: 'news',
        canonicalUrl: '/blogs/news',
      });
    });

    it('maps page route to HaravanRouteIdentity', () => {
      const ref = resolver.resolveReferenceUrl('/pages/faq');
      const target = resolver.mapToHaravanRoute(ref);
      assert.deepEqual(target, {
        kind: 'page',
        pattern: '/pages/:handle',
        template: 'page.liquid',
        objectType: 'page',
        handle: 'faq',
        canonicalUrl: '/pages/faq',
      });
    });

    it('maps cart route to HaravanRouteIdentity', () => {
      const ref = resolver.resolveReferenceUrl('/cart');
      const target = resolver.mapToHaravanRoute(ref);
      assert.deepEqual(target, {
        kind: 'cart',
        pattern: '/cart',
        template: 'cart.liquid',
        objectType: 'cart',
        canonicalUrl: '/cart',
      });
    });

    it('maps search route to HaravanRouteIdentity', () => {
      const ref = resolver.resolveReferenceUrl('/search?q=jacket');
      const target = resolver.mapToHaravanRoute(ref);
      assert.deepEqual(target, {
        kind: 'search',
        pattern: '/search',
        template: 'search.liquid',
        objectType: 'search',
        canonicalUrl: '/search',
      });
    });

    it('maps 404 route to HaravanRouteIdentity', () => {
      const ref = resolver.resolveReferenceUrl('/404');
      const target = resolver.mapToHaravanRoute(ref);
      assert.deepEqual(target, {
        kind: '404',
        pattern: '/404',
        template: '404.liquid',
        objectType: null,
        canonicalUrl: '/404',
      });
    });

    it('maps custom route to HaravanRouteIdentity', () => {
      const ref = resolver.resolveReferenceUrl('/promotions/flash-sale');
      const target = resolver.mapToHaravanRoute(ref);
      assert.deepEqual(target, {
        kind: 'custom',
        pattern: '/promotions/flash-sale',
        template: 'page.liquid',
        objectType: null,
        handle: 'promotions/flash-sale',
        canonicalUrl: '/promotions/flash-sale',
      });
    });
  });

  describe('verifyRouteMatch', () => {
    it('verifies matching product routes across different URL structures', () => {
      // Direct vs Direct
      assert.deepEqual(resolver.verifyRouteMatch('/products/sneaker', '/products/sneaker'), { matches: true });

      // Absolute URL vs relative
      assert.deepEqual(
        resolver.verifyRouteMatch('https://shop.com/products/sneaker?variant=123', '/products/sneaker'),
        { matches: true }
      );

      // Nested collection-product URL vs Haravan product URL
      assert.deepEqual(
        resolver.verifyRouteMatch('/collections/featured/products/sneaker', '/products/sneaker'),
        { matches: true }
      );

      // Vietnamese alias vs Haravan product URL
      assert.deepEqual(
        resolver.verifyRouteMatch('/san-pham/sneaker', '/products/sneaker'),
        { matches: true }
      );
    });

    it('verifies matching collection routes with pagination', () => {
      assert.deepEqual(
        resolver.verifyRouteMatch('/collections/shoes?page=2', '/collections/shoes'),
        { matches: true }
      );

      assert.deepEqual(
        resolver.verifyRouteMatch('/collections/shoes/page/3/', '/collections/shoes'),
        { matches: true }
      );
    });

    it('verifies matching nested collections to leaf collection', () => {
      assert.deepEqual(
        resolver.verifyRouteMatch('/collections/men/shoes', '/collections/shoes'),
        { matches: true }
      );

      assert.deepEqual(
        resolver.verifyRouteMatch('/collections/men/shoes', '/collections/men/shoes'),
        { matches: true }
      );
    });

    it('verifies matching blog articles across format variations', () => {
      assert.deepEqual(
        resolver.verifyRouteMatch('/blogs/news/first-post', '/blogs/news/first-post'),
        { matches: true }
      );

      assert.deepEqual(
        resolver.verifyRouteMatch('/blogs/news/articles/first-post', '/blogs/news/first-post'),
        { matches: true }
      );
    });

    it('verifies matching home, cart, search, 404 routes', () => {
      assert.deepEqual(resolver.verifyRouteMatch('https://myshop.com/', '/'), { matches: true });
      assert.deepEqual(resolver.verifyRouteMatch('/gio-hang', '/cart'), { matches: true });
      assert.deepEqual(resolver.verifyRouteMatch('/search?q=hat', '/search'), { matches: true });
      assert.deepEqual(resolver.verifyRouteMatch('/404.html', '/404'), { matches: true });
    });

    it('detects route kind mismatch', () => {
      const res = resolver.verifyRouteMatch('/products/sneaker', '/collections/sneaker');
      assert.equal(res.matches, false);
      assert.ok(res.reason?.includes('Route kind mismatch'));
      assert.ok(res.reason?.includes('"product" does not match haravan "collection"'));
    });

    it('detects handle mismatch', () => {
      const res = resolver.verifyRouteMatch('/products/sneaker-a', '/products/sneaker-b');
      assert.equal(res.matches, false);
      assert.ok(res.reason?.includes('Handle mismatch'));
      assert.ok(res.reason?.includes('"sneaker-a" does not match haravan handle "sneaker-b"'));
    });

    it('detects handle vs no-handle mismatch', () => {
      const res = resolver.verifyRouteMatch('/products/sneaker', '/cart');
      assert.equal(res.matches, false);
    });
  });
});
