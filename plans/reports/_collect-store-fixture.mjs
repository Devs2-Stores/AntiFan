/**
 * Builds a live store fixture for local static rendering of the Haravan theme.
 *
 * The approved plan forbids remote push, so the local revision of the home can
 * never be rendered by the storefront in this session. This script reads the
 * public storefront JSON endpoints (read-only) and writes a fixture the local
 * render harness feeds into LiquidJS, so template logic can be exercised
 * against real handles, titles, images and prices.
 *
 * Read-only: GET only. No writes, pushes or publishes.
 *
 * Usage: node plans/reports/_collect-store-fixture.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ORIGIN = 'https://phukienmaymoc.com';
const THEME_ID = '1001512581';
const OUT = 'plans/reports/haravan-live-store-fixture.json';
const CACHE_DIR = 'plans/reports/.store-fixture-cache';

const BOUND_COLLECTIONS = [
  'contactor',
  'cam-bien',
  'phu-kien-may-laser',
  'dau-cat-laser',
  'phu-tro',
  'nguon-laser-soi-quang',
  'vat-tu-tieu-hao-cho-laser',
  'phu-kien-laser-co2',
  'may-lam-lanh-nuoc',
  'phu-kien-dien-tu',
  'he-thong-dieu-khien-khi-phu-tro',
  'huong-dan-va-thanh-truot',
  'bo-giam-toc',
  'dong-co-servo-bo-dieu-khien-servo',
];

function cachePath(key) {
  return path.join(CACHE_DIR, `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

async function getJson(url, key) {
  const cached = cachePath(key);
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'));
  const response = await fetch(url, { headers: { 'user-agent': 'AntiFan-evidence/1.0' } });
  const text = await response.text();
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cached, JSON.stringify({ status: response.status, value }), 'utf8');
  return { status: response.status, value };
}

async function getText(url, key) {
  const cached = cachePath(key);
  if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  const response = await fetch(url, { headers: { 'user-agent': 'AntiFan-evidence/1.0' } });
  const text = await response.text();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cached, text, 'utf8');
  return text;
}

function normalizeProduct(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const first = variants[0] ?? {};
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    url: `/products/${product.handle}`,
    vendor: product.vendor,
    available: product.available !== false,
    price: Number(product.price ?? first.price ?? 0),
    compare_at_price: Number(product.compare_at_price ?? first.compare_at_price ?? 0),
    featured_image: product.featured_image ?? product.images?.[0] ?? null,
    images: product.images ?? [],
    variants: variants.map((variant) => ({
      id: variant.id,
      title: variant.title,
      price: Number(variant.price ?? 0),
      available: variant.available !== false,
    })),
    collections: BOUND_COLLECTIONS,
  };
}

function normalizeCollection(collection, products) {
  return {
    id: collection.id,
    handle: collection.handle,
    title: collection.title,
    url: `/collections/${collection.handle}`,
    all_products_count: products.length,
    products_count: products.length,
    products,
  };
}

async function main() {
  const collectionsList = await getJson(`${ORIGIN}/collections.json?limit=250`, 'collections');
  const rawCollections = collectionsList.value?.collections ?? [];

  const collections = [];
  const missing = [];
  for (const handle of BOUND_COLLECTIONS) {
    const response = await getJson(
      `${ORIGIN}/collections/${handle}/products.json?limit=250`,
      `collection-products-${handle}`,
    );
    const products = (response.value?.products ?? []).map(normalizeProduct);
    if (products.length === 0) missing.push(handle);
    const base = rawCollections.find((entry) => entry.handle === handle) ?? {
      id: null,
      handle,
      title: handle,
    };
    collections.push(normalizeCollection(base, products));
  }

  const allProducts = new Map();
  for (const collection of collections) {
    for (const product of collection.products) allProducts.set(product.handle, product);
  }

  const articlesIndex = await getJson(`${ORIGIN}/blogs/news.json?limit=250`, 'blog-news');
  const rawArticles = articlesIndex.value?.articles ?? [];
  let articles = [];
  if (rawArticles.length > 0) {
    articles = rawArticles.map((article) => ({
      handle: article.handle,
      title: article.title,
      url: `/blogs/news/${article.handle}`,
      image: article.image ?? null,
      content: article.content ?? '',
      published_at: article.published_at ?? null,
    }));
  } else {
    const sitemap = await getText(`${ORIGIN}/sitemap_blogs_1.xml`, 'sitemap-blogs');
    const handles = [...sitemap.matchAll(/<loc>([^<]*\/blogs\/news\/([^<]+))<\/loc>/g)].map(
      (match) => match[2],
    );
    for (const handle of handles) {
      const html = await getText(`${ORIGIN}/blogs/news/${handle}`, `article-${handle}`);
      const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? handle;
      const image = html.match(/<meta property="og:image" content="([^"]*)"/)?.[1] ?? null;
      const description =
        html.match(/<meta property="og:description" content="([^"]*)"/)?.[1] ?? '';
      articles.push({
        handle,
        title,
        url: `/blogs/news/${handle}`,
        image,
        content: description,
        published_at: null,
      });
    }
  }

  const fixture = {
    collectedAt: new Date().toISOString(),
    origin: ORIGIN,
    themeId: THEME_ID,
    collectionsSource: 'GET /collections.json?limit=250',
    productsSource: 'GET /collections/{handle}/products.json?limit=250',
    articlesSource: articlesIndex.value
      ? 'GET /blogs/news.json?limit=250'
      : 'GET /sitemap_blogs_1.xml + article og: tags',
    collections,
    articles,
    allProducts: [...allProducts.values()],
    emptyBoundCollections: missing,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  const summary = {
    output: OUT,
    collections: collections.length,
    productsPerCollection: Object.fromEntries(
      collections.map((collection) => [collection.handle, collection.products.length]),
    ),
    uniqueProducts: allProducts.size,
    articles: articles.length,
    emptyBoundCollections: missing,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`FIXTURE_COLLECTION_FAILED ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
