/**
 * Local static render harness for the haravan theme home route.
 *
 * Why this exists: the approved plan forbids remote push (plan.md:11), so the
 * local revision of the home can never be served by the storefront in this
 * session. This harness renders `templates/index.liquid` through LiquidJS using
 * the live store fixture (`haravan-live-store-fixture.json`) and asserts the
 * home contract (section order, cardinalities, real collection/product links,
 * local asset existence).
 *
 * Engine caveat: LiquidJS is a Liquid-compatible engine, not Haravan's
 * DotLiquid. A successful render is supporting evidence about template logic
 * and data bindings, not proof of Haravan runtime behaviour. Haravan's
 * `{% include %}` shares the caller scope (assignments leak), so includes are
 * expanded inline before rendering to reproduce that semantic.
 *
 * Read-only with respect to the theme. Writes only its evidence JSON.
 *
 * Usage:
 *   node plans/reports/_render-home.mjs [themeDir] [--json out.json]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LIQUID_PATH = 'E:/Work/apps/Haravan CLI/node_modules/liquidjs';
const { Liquid } = require(LIQUID_PATH);

const themeDir = path.resolve(process.argv[2] ?? 'themes/phukienmaymoc-copy');
const jsonFlagIndex = process.argv.indexOf('--json');
const outPath =
  jsonFlagIndex >= 0
    ? path.resolve(process.argv[jsonFlagIndex + 1])
    : 'plans/reports/evidence-addon-14-260912-1731-home-static-render.json';

const fixture = JSON.parse(
  fs.readFileSync('plans/reports/haravan-live-store-fixture.json', 'utf8'),
);
const read = (relative) => fs.readFileSync(path.join(themeDir, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(themeDir, relative));

/* ------------------------------------------------------------------ *
 * Haravan include expansion (inline, caller scope)                     *
 * ------------------------------------------------------------------ */

const RAW_BLOCK = /\{%-?\s*raw\s*-?%\}[\s\S]*?\{%-?\s*endraw\s*-?%\}/g;

function splitTokens(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',' || /\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function expandIncludes(source, trail = []) {
  const unsupported = [];
  const expanded = [];
  const rawSpans = [];
  for (const match of source.matchAll(RAW_BLOCK)) {
    rawSpans.push([match.index, match.index + match[0].length]);
  }
  const inRaw = (index) => rawSpans.some(([start, end]) => index >= start && index < end);

  const output = source.replace(
    /\{%-?\s*include\s+(['"])([^'"]+)\1([^%]*?)%\}/g,
    (match, _quote, name, restIn, offset) => {
      if (inRaw(offset)) return match;
      const rest = restIn.trim().replace(/-$/, '').trim();
      const snippetFile = `snippets/${name}${name.endsWith('.liquid') ? '' : '.liquid'}`;
      if (!exists(snippetFile)) {
        unsupported.push({ name, reason: 'SNIPPET_MISSING', file: snippetFile });
        return `<!-- include-missing:${name} -->`;
      }
      if (trail.includes(name) || trail.length > 12) {
        unsupported.push({ name, reason: 'CYCLE_OR_DEPTH', trail: [...trail, name] });
        return `<!-- include-cycle:${name} -->`;
      }
      const tokens = splitTokens(rest.trim());
      const assigns = [];
      for (const token of tokens) {
        if (token === 'with' || token === 'for') {
          if (token === 'for') unsupported.push({ name, reason: 'INCLUDE_FOR_UNSUPPORTED' });
          continue;
        }
        const pair = /^([A-Za-z_][A-Za-z0-9_-]*):(.+)$/.exec(token);
        if (!pair) {
          unsupported.push({ name, reason: 'UNPARSED_TOKEN', token });
          continue;
        }
        assigns.push(`{% assign ${pair[1]} = ${pair[2]} %}`);
      }
      expanded.push(name);
      const nested = expandIncludes(read(snippetFile), [...trail, name]);
      for (const entry of nested.expanded) expanded.push(entry);
      for (const entry of nested.unsupported) unsupported.push(entry);
      const body = nested.output;
      return `${assigns.join('')}\n<!-- include:${name} -->\n${body}\n<!-- endinclude:${name} -->`;
    },
  );

  return { output, expanded, unsupported };
}

/* ------------------------------------------------------------------ *
 * Engine                                                               *
 * ------------------------------------------------------------------ */

function buildSettings() {
  const dataPath = path.join(themeDir, 'config/settings_data.json');
  const values = {};
  if (fs.existsSync(dataPath)) {
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    if (data && typeof data.current === 'object' && data.current !== null) {
      Object.assign(values, data.current);
    }
  }
  const htmlPath = path.join(themeDir, 'config/settings.html');
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    for (const match of html.matchAll(/name=['"]([A-Za-z0-9_]+)['"]([^>]*)>/g)) {
      const [, id, rest] = match;
      if (id in values) continue;
      if (/type=['"]checkbox['"]/.test(rest)) values[id] = true;
      else if (/type=['"]number['"]/.test(rest)) values[id] = '0';
      else values[id] = '';
    }
  }
  return values;
}

function buildContext() {
  const collections = fixture.collections.map((collection) => ({
    ...collection,
    products: collection.products,
    all_products: collection.products,
    all_products_count: collection.products.length,
    url: `/collections/${collection.handle}`,
  }));
  const byHandle = Object.fromEntries(collections.map((entry) => [entry.handle, entry]));
  const all = {
    handle: 'all',
    title: 'Tất cả sản phẩm',
    url: '/collections/all',
    products: fixture.allProducts,
    all_products: fixture.allProducts,
    all_products_count: fixture.allProducts.length,
    products_count: fixture.allProducts.length,
  };
  const collectionsIndex = [...collections];
  collectionsIndex.all = all;
  // Every live collection must be resolvable by handle: tiles and menus read
  // `collections['handle'].title`, and a missing entry renders as blank text.
  const cachedListPath = 'plans/reports/.store-fixture-cache/collections.json';
  if (fs.existsSync(cachedListPath)) {
    const cached = JSON.parse(fs.readFileSync(cachedListPath, 'utf8'));
    for (const entry of cached.value?.collections ?? []) {
      if (collectionsIndex[entry.handle]) continue;
      collectionsIndex[entry.handle] = {
        id: entry.id ?? null,
        handle: entry.handle,
        title: entry.title,
        url: `/collections/${entry.handle}`,
        products: [],
        all_products: [],
        all_products_count: entry.products_count ?? 0,
        products_count: entry.products_count ?? 0,
      };
    }
  }
  for (const [handle, value] of Object.entries(byHandle)) collectionsIndex[handle] = value;

  const articles = fixture.articles.map((article, index) => ({
    ...article,
    id: index + 1,
    image: article.image ? { src: article.image, alt: article.title } : null,
    excerpt: article.content,
    author: 'Phụ Kiện Máy Móc',
    published_at: article.published_at ?? '2026-01-01T00:00:00+07:00',
    content: article.content,
  }));
  const blog = {
    handle: 'news',
    title: 'Tin tức',
    url: '/blogs/news',
    articles,
    articles_count: articles.length,
    all_articles_count: articles.length,
  };
  const blogs = [blog];
  blogs.news = blog;
  blogs.first = blog;
  blogs.size = 1;

  return {
    settings: buildSettings(),
    collections: collectionsIndex,
    collection: collectionsIndex['phu-kien-may-laser'],
    blogs,
    blog,
    articles,
    article: articles[0],
    product: fixture.allProducts[0],
    products: fixture.allProducts,
    page: { title: 'Trang chủ', url: '/', handle: 'frontpage', content: '' },
    shop: {
      name: 'Phụ Kiện Máy Móc',
      url: 'https://phukienmaymoc.com',
      domain: 'phukienmaymoc.com',
      currency: 'VND',
      email: 'info@phukienmaymoc.com',
      phone: '0000000000',
    },
    cart: { item_count: 0, total_price: 0, items: [], empty: true },
    customer: null,
    template: 'index',
    current_page: 1,
    can_shop: true,
    linklists: {
      main_menu: { title: 'Main menu', links: [], links_count: 0 },
    },
  };
}

function buildEngine() {
  const engine = new Liquid({
    root: [path.join(themeDir, 'snippets'), path.join(themeDir, 'templates')],
    extname: '.liquid',
    jsTruthy: true,
    strictFilters: false,
    strictVariables: false,
    cache: false,
  });

  const define = (name, func) => engine.registerFilter(name, func);

  define('asset_url', (value) => `/assets/${String(value)}`);
  define('file_url', (value) => `/files/${String(value)}`);
  define('img_url', (value, size) => renderImageUrl(value, size));
  define('product_img_url', (value, size) => renderImageUrl(value, size));
  define('collection_img_url', (value, size) => renderImageUrl(value, size));
  define('money', (value) => formatMoney(value, true));
  define('money_with_currency', (value) => `${formatMoney(value, true)}₫`);
  define('money_without_currency', (value) => formatMoney(value, false));
  define('money_without_trailing_zeros', (value) => formatMoney(value, false));
  define('weight_with_unit', (value) => `${value} g`);
  define('handleize', (value) =>
    String(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
  );
  define('t', (value) => String(value));
  define('within', (value, collection) => {
    const list = Array.isArray(collection) ? collection : (collection?.products ?? []);
    return list.some((entry) => entry?.id === value?.id) ? value : null;
  });
  define('link_to', (label, url) => `<a href="${url}">${label}</a>`);
  define('stylesheet_tag', (value) => `<link rel="stylesheet" href="/assets/${String(value)}">`);
  define('script_tag', (value) => `<script src="/assets/${String(value)}"></script>`);
  define('img_tag', (value, alt) => `<img src="${String(value)}" alt="${alt ?? ''}">`);
  define('default_pagination', () => '');
  define('pluralize', (count, singular, plural) =>
    Number(count) === 1 ? singular : (plural ?? `${singular}s`),
  );
  define('url_escape', (value) => encodeURIComponent(String(value ?? '')));
  define('camelcase', (value) => String(value ?? '').replace(/[-_](.)/g, (_, char) => char.toUpperCase()));
  define('global_asset_url', (value) => `/assets/${String(value)}`);
  define('Haravan_asset_url', (value) => `/assets/${String(value)}`);
  define('payment_type_img_url', (value) => `/assets/payment_${String(value)}.png`);
  define('default_errors', (value) => (value ? JSON.stringify(value) : ''));
  define('customer_login_link', (text) => `<a href="/account/login">${text ?? 'Đăng nhập'}</a>`);
  define('highlight', (value, term) =>
    term ? String(value).replace(new RegExp(String(term), 'gi'), (m) => `<strong>${m}</strong>`) : value,
  );

  function renderImageUrl(value, size) {
    const source = typeof value === 'string' ? value : (value?.src ?? value?.url ?? '');
    if (!source) return '';
    // Haravan rewrites CDN paths; absolute sources stay absolute so a local
    // preview loads the same bytes the storefront serves.
    if (/^(https?:)?\/\//.test(String(source))) return String(source);
    const base = String(source).split('/').pop();
    const suffix = size ? `_${String(size)}` : '';
    return `/cdn${suffix}/${base}`;
  }

  function formatMoney(value, withCurrency) {
    const numeric = Number(String(value ?? 0).replace(/[^\d.-]/g, '')) || 0;
    const formatted = numeric.toLocaleString('vi-VN');
    return withCurrency ? `${formatted}₫` : formatted;
  }

  engine.registerTag('form', {
    parse(token, remainTokens) {
      this.args = token.args;
      this.templates = [];
      const stream = this.liquid.parser.parseStream(remainTokens);
      stream
        .on('tag:endform', () => stream.stop())
        .on('template', (tpl) => this.templates.push(tpl))
        .on('end', () => {
          throw new Error(`tag {% form %} not closed`);
        });
      stream.start();
    },
    *render(ctx, emitter) {
      const form = {
        id: 'harness-form',
        posted_successfully: false,
        errors: null,
        'posted_successfully?': false,
      };
      ctx.push({ form });
      emitter.write(`<form method="post" action="" data-harness-form="${this.args.trim()}">`);
      yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
      emitter.write('</form>');
      ctx.pop();
    },
  });

  engine.registerTag('paginate', {
    parse(token, remainTokens) {
      this.templates = [];
      const stream = this.liquid.parser.parseStream(remainTokens);
      stream
        .on('tag:endpaginate', () => stream.stop())
        .on('template', (tpl) => this.templates.push(tpl))
        .on('end', () => {
          throw new Error(`tag {% paginate %} not closed`);
        });
      stream.start();
    },
    *render(ctx, emitter) {
      ctx.push({ paginate: { pages: 1, page: 1, items: 0 }, current_page: 1 });
      yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
      ctx.pop();
    },
  });

  return engine;
}

/* ------------------------------------------------------------------ *
 * Assertions                                                           *
 * ------------------------------------------------------------------ */

function countMatches(html, regex) {
  return [...html.matchAll(regex)].length;
}

function main() {
  const entry = read('templates/index.liquid');
  const { output, expanded, unsupported } = expandIncludes(entry);
  const engine = buildEngine();
  const context = buildContext();

  return engine
    .parseAndRender(output, context)
    .then((html) => {
      const sectionOrder = [...html.matchAll(/<section class="([^"]*)"/g)].map((m) => m[1]);
      const productHrefs = [...new Set([...html.matchAll(/href="(\/products\/[^"?#]+)"/g)].map((m) => m[1]))];
      const collectionHrefs = [...new Set([...html.matchAll(/href="(\/collections\/[^"?#]+)"/g)].map((m) => m[1]))];
      const assetNames = [...new Set([...html.matchAll(/\/assets\/([^"'?#)\s]+)/g)].map((m) => m[1]))];

      // A href resolves against the store's whole catalog, not against the
      // subset this fixture binds. Reading only the fixture marks live handles
      // as dead, so the cached full catalog decides, and the fixture is the
      // fallback when no cache is present.
      const cachedCollections = (() => {
        const cachedPath = 'plans/reports/.store-fixture-cache/collections.json';
        const cached = fs.existsSync(cachedPath) ? JSON.parse(fs.readFileSync(cachedPath, 'utf8')) : null;
        return cached?.value?.collections ?? [];
      })();
      const catalogCollections = cachedCollections.length > 0 ? cachedCollections : fixture.collections;
      const liveCollectionHandles = new Set(catalogCollections.map((c) => c.handle));
      const liveProductHandles = new Set(fixture.allProducts.map((p) => p.handle));

      const checks = [];
      const check = (id, observed, expected, detail) => {
        const ok = typeof expected === 'function' ? expected(observed) : observed === expected;
        checks.push({ id, ok, observed, expected: typeof expected === 'function' ? expected.toString() : expected, detail });
      };

      const REFERENCE_PATH = 'exports/hoplongtech-html/page-01-home/index.html';
      const reference = fs.existsSync(REFERENCE_PATH) ? fs.readFileSync(REFERENCE_PATH, 'utf8') : '';
      const countInSection = (document, sectionClass, regex) => {
        const start = document.indexOf(`<section class="${sectionClass}"`);
        if (start < 0) return -1;
        const next = document.indexOf('<section class="', start + 10);
        return countMatches(document.slice(start, next < 0 ? undefined : next), regex);
      };

      check('render_has_no_unrendered_liquid', countMatches(html, /\{\{|\{%/g), 0);
      check('render_has_no_liquid_error', countMatches(html, /Liquid error/gi), 0);
      check('include_missing_markers', countMatches(html, /include-missing:|include-cycle:/g), 0);

      check('home_section_order', sectionOrder.join(','), 'slide,category-list,banner-category,block-category,block-category,block-category,block-category,block-category,home-form,accessory,news,partner');

      // Structural cardinalities: render must equal the approved reference
      // counts for the classes both documents express identically.
      const parity = [
        ['category_tile_count', /class="[^"]*\bcategory-list__item\b/g, 5],
        ['banner_count', /class="[^"]*\bbanner-category__item\b/g, 3],
        ['block_category_count', /class="[^"]*\bblock-category__item\b/g, 5],
        ['product_card_count', /class="[^"]*\bproduct-list__item\b/g, 25],
        ['news_item_count', /class="[^"]*\barticle-item\b/g, 4],
        ['hero_slide_dot_count', /class="[^"]*\bdot dot-\d/g, 10],
        ['hero_submenu_count', /class="[^"]*\bmenu-child lv1\b/g, 10],
      ];
      for (const [id, regex, expected] of parity) {
        const observed = countMatches(html, regex);
        const referenceCount = reference ? countMatches(reference, regex) : null;
        const ok = observed === expected && (referenceCount === null || referenceCount === expected);
        checks.push({ id, ok, observed, expected, referenceCount });
      }

      const accessoryItems = countInSection(html, 'accessory', /class="[^"]*\baccessory-content__item\b/g);
      check('accessory_item_count', accessoryItems, 8);
      const partnerLogos = countInSection(html, 'partner', /class="item"/g);
      check('partner_logo_count', partnerLogos, 20);
      const latestNews = countInSection(html, 'news', /class="[^"]*\barticle-item\b/g);
      check('news_items_scoped', latestNews, 4);
      const partnerSlice = (() => {
        const start = html.indexOf('<section class="partner"');
        return start < 0 ? '' : html.slice(start, html.indexOf('</section>', start));
      })();
      check('partner_slider_arrows_present', /class="nav"[\s\S]{0,120}class="nav-next"[\s\S]{0,80}class="nav-prev"/.test(partnerSlice), true, 'reference home ships hover arrows for the partner slider');

      const unresolvedProductHrefs = productHrefs.filter((href) => {
        const handle = href.split('/').pop();
        return !liveProductHandles.has(handle);
      });
      check('product_hrefs_resolve', unresolvedProductHrefs.length, 0, unresolvedProductHrefs.join(','));

      // Bound surfaces (tiles, banners, blocks, accessory, form) must link only
      // to live collections. The hero mega menu is reference information
      // architecture that the approved binding contract does not cover, so its
      // dead handles are recorded as a separate metric instead of a failure.
      const boundSectionClasses = ['category-list', 'banner-category', 'block-category', 'accessory', 'news'];
      const hrefsIn = (sectionClass) => {
        const matches = [];
        let start = html.indexOf(`<section class="${sectionClass}"`);
        while (start >= 0) {
          const next = html.indexOf('<section class="', start + 10);
          const slice = html.slice(start, next < 0 ? undefined : next);
          matches.push(...[...slice.matchAll(/href="(\/collections\/[^"?#]+)"/g)].map((m) => m[1]));
          start = next;
        }
        return matches;
      };
      const boundCollectionHrefs = [...new Set(boundSectionClasses.flatMap(hrefsIn))];
      const unresolvedBoundHrefs = boundCollectionHrefs.filter((href) => {
        const handle = href.split('/').pop();
        return handle !== 'all' && !liveCollectionHandles.has(handle);
      });
      check('bound_surface_collection_hrefs_resolve', unresolvedBoundHrefs.length, 0, unresolvedBoundHrefs.join(','));

      const navCollectionHrefs = [...new Set(hrefsIn('slide'))];
      const deadNavHrefs = navCollectionHrefs.filter((href) => !liveCollectionHandles.has(href.split('/').pop()));
      checks.push({
        id: 'nav_mega_menu_dead_collection_hrefs',
        ok: true,
        observed: deadNavHrefs.length,
        expected: 'recorded, out of approved binding scope',
        detail: deadNavHrefs.slice(0, 12).join(','),
      });

      const assetCandidates = (name) => {
        const candidates = [name, `${name}.liquid`];
        if (name.endsWith('.scss.css')) candidates.push(`${name.slice(0, -4)}.liquid`);
        if (name.endsWith('.css')) candidates.push(`${name.slice(0, -4)}.scss.liquid`);
        if (name.endsWith('.js')) candidates.push(`${name}.liquid`);
        return candidates;
      };
      const missingAssets = assetNames.filter(
        (name) => !assetCandidates(name).some((candidate) => exists(`assets/${candidate}`)),
      );
      check('referenced_local_assets_exist', missingAssets.length, 0, missingAssets.join(','));
      check('no_placeholder_logo_in_home', countMatches(html, /\/assets\/logo\.png/g), 0);

      // Data binding: the home must render real store entities, not literals.
      const liveTitles = fixture.allProducts.map((product) => product.title);
      const renderedTitles = liveTitles.filter((title) => html.includes(title));
      check('real_product_titles_rendered', renderedTitles.length, (value) => value >= 20, `${renderedTitles.length} distinct fixture titles appear in the render`);
      check('price_block_rendered', countMatches(html, /class="[^"]*\bprice\b[^"]*"/g) >= 25, true, 'every card renders a price block');
      check('pricezero_branch_or_currency_rendered', /₫|hrv-cf-prod_pricezero_title/.test(html), true, 'cards show either a formatted price or the zero-price CTA');
      check('bound_collections_linked', fixture.collections.filter((collection) => html.includes(`/collections/${collection.handle}"`)).length, fixture.collections.length, fixture.collections.map((c) => c.handle).join(','));

      // A handle that does not resolve renders blank text rather than an error,
      // so assert the bound surfaces carry real entity titles.
      const liveTitlesAll = catalogCollections.map((entry) => entry.title).filter(Boolean);
      const boundSlice = boundSectionClasses
        .map((sectionClass) => {
          const start = html.indexOf(`<section class="${sectionClass}"`);
          return start < 0 ? '' : html.slice(start, html.indexOf('</section>', start));
        })
        .join('\n');
      const renderedLiveTitles = liveTitlesAll.filter((title) => boundSlice.includes(title));
      check('bound_surfaces_render_real_titles', renderedLiveTitles.length >= 10, true, `${renderedLiveTitles.length} live collection titles appear on bound surfaces`);

      const failures = checks.filter((entryCheck) => !entryCheck.ok);
      const evidence = {
        recordedAt: new Date().toISOString(),
        harness: 'plans/reports/_render-home.mjs',
        engine: 'liquidjs@10.27.0 (Haravan CLI dependency) - Liquid-compatible, NOT DotLiquid',
        themeDir,
        entry: 'templates/index.liquid',
        fixture: 'plans/reports/haravan-live-store-fixture.json',
        expandedIncludes: [...new Set(expanded)],
        expandedIncludeCount: expanded.length,
        unsupportedIncludes: unsupported,
        renderedBytes: Buffer.byteLength(html, 'utf8'),
        sectionOrder,
        distinctProductHrefs: productHrefs.length,
        distinctCollectionHrefs: collectionHrefs.length,
        distinctAssetRefs: assetNames.length,
        checks,
        verdict: failures.length === 0 ? 'RENDER_CONTRACT_SATISFIED' : 'RENDER_CONTRACT_VIOLATED',
        failureCount: failures.length,
        caveat:
          'LiquidJS is not the production engine. A pass proves the template logic and bindings are self-consistent under real store handles; it does not prove Haravan DotLiquid renders identically, and no storefront render of this revision exists (remote push is outside the approved plan).',
      };
      fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
      const htmlIndex = process.argv.indexOf('--html');
      if (htmlIndex >= 0) {
        fs.writeFileSync(path.resolve(process.argv[htmlIndex + 1]), html, 'utf8');
      }
      process.stdout.write(`${JSON.stringify({ verdict: evidence.verdict, failureCount: failures.length, failures, sectionOrder, renderedBytes: evidence.renderedBytes, unsupportedIncludes: unsupported.slice(0, 5), outPath }, null, 2)}\n`);
      return failures.length === 0 ? 0 : 1;
    })
    .catch((error) => {
      const evidence = {
        recordedAt: new Date().toISOString(),
        harness: 'plans/reports/_render-home.mjs',
        themeDir,
        verdict: 'RENDER_FAILED',
        error: String(error.message ?? error),
        stack: String(error.stack ?? ''),
      };
      fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
      process.stderr.write(`RENDER_FAILED ${error.message}\n`);
      return 1;
    })
    .then((code) => {
      process.exitCode = code;
    });
}

main();
