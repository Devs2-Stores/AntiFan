import type { ProbeDeps, ProbeFinding, ProbeResult } from './probe-deps';

export type PickProductStrategy = 'max-variants' | 'long-title' | 'sold-out' | 'no-image';

export interface PickProductParams {
  strategy: PickProductStrategy;
  sampleLimit?: number;
}

export interface PickProductData {
  handles: string[];
  ranked: Array<{ handle: string; score: number }>;
}

export interface ProductSummary {
  handle: string;
  title: string;
  variants: number;
  unavailableVariants: number;
  available: boolean;
  images: number;
  variantsWithoutImage: number;
}

interface PickProductPageResult {
  ok: boolean;
  error?: string;
  products: ProductSummary[];
  scannedPages: number;
}

const DEFAULT_SAMPLE_LIMIT = 40;
const SAMPLE_LIMIT_CEILING = 200;
const MAX_RETURNED_HANDLES = 10;
const STRATEGIES: readonly PickProductStrategy[] = ['max-variants', 'long-title', 'sold-out', 'no-image'];

/** Page-side crawl: lists product handles from /collections/all and summarises each `/products/<handle>.js`. */
export function buildPickProductScript(params: { sampleLimit: number }): string {
  return `(async () => {
var limit = ${JSON.stringify(params.sampleLimit)};
var MAX_PAGES = 8;
var handles = [];
var scannedPages = 0;
for (var page = 1; page <= MAX_PAGES && handles.length < limit; page++) {
  var res;
  try { res = await fetch('/collections/all?page=' + page, { credentials: 'same-origin' }); } catch (e) { break; }
  if (!res || !res.ok) break;
  var html = await res.text();
  scannedPages++;
  var doc = new DOMParser().parseFromString(html, 'text/html');
  var before = handles.length;
  Array.prototype.forEach.call(doc.querySelectorAll('a[href*="/products/"]'), function (a) {
    var m = (a.getAttribute('href') || '').match(/\\/products\\/([^\\/?#]+)/);
    if (!m) return;
    var h;
    try { h = decodeURIComponent(m[1]); } catch (e) { h = m[1]; }
    if (handles.indexOf(h) < 0 && handles.length < limit) handles.push(h);
  });
  if (handles.length === before) break;
}
// Sapo links a product at its bare alias ("/giay-derby-nam"), so the listing above finds nothing;
// its storefront /products.json names every product by alias.
var fromJson = handles.length === 0;
for (var jp = 1; fromJson && jp <= MAX_PAGES && handles.length < limit; jp++) {
  var jr;
  try { jr = await fetch('/products.json?page=' + jp, { credentials: 'same-origin' }); } catch (e) { break; }
  if (!jr || !jr.ok) break;
  var list;
  try { list = (await jr.json()).products; } catch (e) { break; }
  if (!Array.isArray(list) || list.length === 0) break;
  list.forEach(function (p) {
    var h = p && (p.alias || p.handle);
    if (h && handles.indexOf(h) < 0 && handles.length < limit) handles.push(String(h));
  });
  scannedPages++;
}
if (handles.length === 0) return { ok: false, error: 'no product links found on /collections/all or /products.json', products: [], scannedPages: scannedPages };
function imgUrl(v) {
  var f = v && v.featured_image;
  if (!f) return null;
  return typeof f === 'string' ? f : (f.src || f.url || null);
}
async function summarise(handle) {
  try {
    var r = await fetch('/products/' + encodeURIComponent(handle) + '.js', { credentials: 'same-origin' });
    if (!r || !r.ok) return null;
    var p = await r.json();
    var variants = Array.isArray(p.variants) ? p.variants : [];
    var images = Array.isArray(p.images) ? p.images.length : (p.featured_image ? 1 : 0);
    return {
      handle: handle,
      title: String(p.title || p.name || ''),
      variants: variants.length,
      unavailableVariants: variants.filter(function (v) { return v.available === false; }).length,
      available: p.available !== false,
      images: images,
      variantsWithoutImage: variants.filter(function (v) { return !imgUrl(v); }).length
    };
  } catch (e) { return null; }
}
var products = [];
for (var i = 0; i < handles.length; i += 6) {
  var batch = await Promise.all(handles.slice(i, i + 6).map(summarise));
  batch.forEach(function (s) { if (s) products.push(s); });
}
if (products.length === 0) return { ok: false, error: 'no product could be resolved through /products/<handle>.js', products: [], scannedPages: scannedPages };
return { ok: true, products: products, scannedPages: scannedPages };
})()`;
}

export function scoreProduct(strategy: PickProductStrategy, p: ProductSummary): number {
  switch (strategy) {
    case 'max-variants':
      return p.variants;
    case 'long-title':
      return p.title.length;
    case 'sold-out':
      return (p.available ? 0 : 1000) + p.unavailableVariants;
    case 'no-image':
      return (p.images === 0 ? 1000 : 0) + p.variantsWithoutImage;
  }
}

/** Highest score first; equal scores order by handle so repeated crawls pick the same product. */
export function rankProducts(strategy: PickProductStrategy, products: ProductSummary[]): Array<{ handle: string; score: number }> {
  return products
    .map((p) => ({ handle: p.handle, score: scoreProduct(strategy, p) }))
    .sort((a, b) => b.score - a.score || (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
}

export async function runPickProduct(deps: ProbeDeps, p: PickProductParams): Promise<ProbeResult<PickProductData>> {
  const empty: PickProductData = { handles: [], ranked: [] };
  if (!STRATEGIES.includes(p.strategy)) {
    return { measured: false, passed: null, findings: [], data: empty, error: `unknown strategy "${String(p.strategy)}"` };
  }
  const requested = typeof p.sampleLimit === 'number' && Number.isFinite(p.sampleLimit) ? Math.floor(p.sampleLimit) : DEFAULT_SAMPLE_LIMIT;
  const sampleLimit = Math.min(SAMPLE_LIMIT_CEILING, Math.max(1, requested));
  let page: PickProductPageResult;
  try {
    page = (await deps.evalJs(buildPickProductScript({ sampleLimit }))) as PickProductPageResult;
  } catch (err) {
    return { measured: false, passed: null, findings: [], data: empty, error: err instanceof Error ? err.message : String(err) };
  }
  if (!page || !page.ok) {
    return { measured: false, passed: null, findings: [], data: empty, error: page?.error ?? 'product crawl returned no result' };
  }
  const ranked = rankProducts(p.strategy, page.products);
  const handles = ranked.filter((r) => r.score > 0).slice(0, MAX_RETURNED_HANDLES).map((r) => r.handle);
  const findings: ProbeFinding[] = [];
  if (handles.length === 0) {
    findings.push({
      ruleId: 'pick-product-no-match',
      severity: 'info',
      message: `None of the ${ranked.length} sampled products matches strategy "${p.strategy}"`,
      measured: { sampled: ranked.length, strategy: p.strategy },
    });
  }
  return { measured: true, passed: handles.length > 0 ? true : null, findings, data: { handles, ranked } };
}
