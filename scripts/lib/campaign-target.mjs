/**
 * Campaign target resolution — the storefront the clone-fidelity campaign measures.
 *
 * The target is a parameter, not a constant: `ANTIFAN_CAMPAIGN_BASE_URL` or the
 * runner's `--base-url` flag re-points the whole page set, and the flag wins over
 * the environment because an explicit invocation argument is the narrower scope.
 * Every page URL, every per-page `domain`, the clone builder's base and the
 * network audit's reference-host allowlist derive from the resolved base, so a
 * re-targeted run cannot silently keep measuring the previous store.
 */

export const CAMPAIGN_BASE_URL_ENV = 'ANTIFAN_CAMPAIGN_BASE_URL';
export const CAMPAIGN_BASE_URL_FLAG = '--base-url';
export const DEFAULT_CAMPAIGN_BASE_URL = 'https://hangquoctai.myharavan.com';

/**
 * Hosts whose assets belong to the reference storefront and must never be
 * requested by a served clone bundle: the target host itself plus the Haravan
 * platform asset hosts the store actually loads from (`*.hstatic.net`,
 * `*.dktcdn.net`, `*.myharavan.com`, `*.haravan.com`). The audit matches with
 * `hostname === h || hostname.endsWith('.' + h)`, so each entry covers its
 * subdomains. Platform hosts are unconditional: a clone that hotlinks a Haravan
 * CDN is contaminated regardless of which store is under measurement.
 */
const PLATFORM_REFERENCE_HOSTS = ['hstatic.net', 'dktcdn.net', 'myharavan.com', 'haravan.com'];

/**
 * Resolve the campaign base URL.
 *
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv }} [sources]
 *   `argv` — the flag-bearing argument vector (already sliced, or full
 *   `process.argv`; only the flag's value is read). `env` — defaults to
 *   `process.env`.
 * @returns {{ baseUrl: string, host: string, source: 'flag' | 'env' | 'default' }}
 * @throws {Error} `INVALID_CAMPAIGN_BASE_URL` when the chosen value is missing or
 *   not an absolute http(s) URL — a malformed target must fail the run before it
 *   produces evidence against the wrong subject.
 */
export function resolveCampaignBaseUrl({ argv = [], env = process.env } = {}) {
  const flagIdx = argv.indexOf(CAMPAIGN_BASE_URL_FLAG);
  const flagValue = flagIdx !== -1 ? argv[flagIdx + 1] : undefined;
  const envValue = env[CAMPAIGN_BASE_URL_ENV];
  const chosen = flagValue ?? (envValue && envValue.trim() !== '' ? envValue : undefined);
  const source = flagValue !== undefined ? 'flag' : (chosen !== undefined ? 'env' : 'default');
  const raw = chosen ?? DEFAULT_CAMPAIGN_BASE_URL;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw Object.assign(
      new Error(`invalid campaign base URL ${JSON.stringify(raw)} from ${source}: not a URL`),
      { code: 'INVALID_CAMPAIGN_BASE_URL' }
    );
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
    throw Object.assign(
      new Error(`invalid campaign base URL ${JSON.stringify(raw)} from ${source}: expected absolute http(s) URL`),
      { code: 'INVALID_CAMPAIGN_BASE_URL' }
    );
  }
  return { baseUrl: parsed.origin, host: parsed.hostname, source };
}

/**
 * The network audit's reference-host allowlist for a resolved target: the target
 * host first, then the platform asset hosts, de-duplicated.
 */
export function campaignReferenceHosts(targetHost) {
  return [...new Set([targetHost, ...PLATFORM_REFERENCE_HOSTS])];
}

/**
 * The 15 locked routes of the campaign, as path+query specs. Paths are
 * store-relative so the same set applies to any base URL; every route was
 * verified live on the default store (200, except `/account` which is the
 * deliberate guest-redirect refusal case).
 */
export const CAMPAIGN_PAGE_SPECS = [
  {
    id: 1,
    name: 'TRANG CHỦ',
    path: '/',
    slug: 'page-01-home',
    specialNote: 'Hero, banner, collection, product, brand, news, footer, responsive.'
  },
  {
    id: 2,
    name: 'TẤT CẢ SẢN PHẨM',
    path: '/collections/all',
    slug: 'page-02-collections-all',
    specialNote: 'Full product listing, grid, pagination, sorting controls.'
  },
  {
    id: 3,
    name: 'NHÓM SẢN PHẨM',
    path: '/collections/hot-products',
    slug: 'page-03-collection-hot-products',
    specialNote: 'Named collection listing, product cards, collection banner/description.'
  },
  {
    id: 4,
    name: 'DANH MỤC CÓ SORT',
    path: '/collections/all?sort=price-ascending',
    slug: 'page-04-collection-sorted',
    specialNote: 'Sorted/filtered listing state preserved in query, product results, cardinality.'
  },
  {
    id: 5,
    name: 'CHI TIẾT SẢN PHẨM',
    path: '/products/miracle-shampoo-plus-keratin',
    slug: 'page-05-product-detail',
    specialNote: 'Product info, gallery, price, CTA, description, related products, reviews.'
  },
  {
    id: 6,
    name: 'GIỎ HÀNG',
    path: '/cart',
    slug: 'page-06-cart',
    specialNote: 'Cart layout, product rows, totals. Public cart on this store (no guest redirect).'
  },
  {
    id: 7,
    name: 'TÀI KHOẢN',
    path: '/account',
    slug: 'page-07-account',
    specialNote: 'Guest request redirects to /account/login — must produce a route refusal, never a PASS.'
  },
  {
    id: 8,
    name: 'ĐĂNG NHẬP',
    path: '/account/login',
    slug: 'page-08-account-login',
    specialNote: 'Login/register form, inputs, submit behavior — the form page of the set.'
  },
  {
    id: 9,
    name: 'WISHLIST',
    path: '/pages/wishlist',
    slug: 'page-09-wishlist',
    specialNote: 'Wishlist feature page, product grid or empty state.'
  },
  {
    id: 10,
    name: 'TIN TỨC',
    path: '/blogs/news',
    slug: 'page-10-blog-index',
    specialNote: 'Article list, thumbnail images, title, metadata, pagination.'
  },
  {
    id: 11,
    name: 'CHI TIẾT TIN TỨC',
    path: '/blogs/news/gia-ban-iphone-12-pro-max-bang-ca-gia-tai-nho-o-mot-so-quoc-gia',
    slug: 'page-11-article-detail',
    specialNote: 'Article body, images, inline media, related articles.'
  },
  {
    id: 12,
    name: 'GIỚI THIỆU',
    path: '/pages/about-us',
    slug: 'page-12-about-us',
    specialNote: 'Static content page, headings, blocks, images.'
  },
  {
    id: 13,
    name: 'CHÍNH SÁCH ĐỔI TRẢ',
    path: '/pages/chinh-sach-doi-tra',
    slug: 'page-13-chinh-sach-doi-tra',
    specialNote: 'Policy page, long-form content structure.'
  },
  {
    id: 14,
    name: 'CHÍNH SÁCH BẢO MẬT',
    path: '/pages/chinh-sach-bao-mat',
    slug: 'page-14-chinh-sach-bao-mat',
    specialNote: 'Policy page, long-form content structure.'
  },
  {
    id: 15,
    name: 'TÌM KIẾM',
    path: '/search?q=a',
    slug: 'page-15-search',
    specialNote: 'Search results, query state, product cards, empty-result handling.'
  }
];

/**
 * Materialize the page set for a resolved base URL: each entry's `url` joins the
 * spec path onto the base origin and `domain` is the target host — never a
 * per-page literal, so a re-targeted run cannot carry a stale domain.
 */
export function buildCampaignTargetPages(baseUrl) {
  const base = new URL(baseUrl);
  return CAMPAIGN_PAGE_SPECS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    url: new URL(spec.path, base).href,
    slug: spec.slug,
    domain: base.hostname,
    specialNote: spec.specialNote
  }));
}
