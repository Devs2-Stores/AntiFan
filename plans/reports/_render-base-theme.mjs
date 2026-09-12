// Reproducible render harness: executes the real Liquid source of the base
// theme (swatch snippet, list-collections, footer, 404) through LiquidJS, the
// engine the session's render harness already uses, with Haravan-only tags
// (form, paginate) stubbed. It verifies Liquid structure and binding, not
// Haravan's renderer: the stubs supply the platform objects the templates
// consume, so a stub defect shows up as a harness defect, not a theme defect.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const LIQUID_PACKAGE = 'E:/Work/apps/Haravan CLI/package.json';
const require = createRequire(LIQUID_PACKAGE);
const { Liquid } = require('liquidjs');

const THEME = new URL('../../themes/universal-haravan-base', import.meta.url).pathname.replace(/^\//, '');

const readCtx = (ctx, name) => {
  if (!name) return undefined;
  try {
    return ctx.getSync([name]);
  } catch {
    return undefined;
  }
};

const platformCalls = [];

function buildEngine() {
  const engine = new Liquid({
    root: [path.join(THEME, 'snippets'), path.join(THEME, 'templates'), THEME],
    extname: '.liquid',
    strictFilters: false,
    strictVariables: false,
  });

  engine.registerFilter('img_url', (value, size) => (value ? `/cdn/${size}/${value}` : ''));
  engine.registerFilter('asset_url', (value) => `/assets/${value}`);
  engine.registerFilter('default_errors', (errors) => {
    if (!errors) return '';
    const messages = Object.values(errors.messages ?? {}).flat();
    return messages.length ? `<span class="form-error-item">${messages.join(' ')}</span>` : '';
  });

  engine.registerTag('form', {
    parse(token, remainTokens) {
      this.tagArgs = token.args;
      this.templates = [];
      const stream = this.liquid.parser.parseStream(remainTokens);
      stream.on('tag:endform', () => stream.stop()).on('template', (tpl) => this.templates.push(tpl)).on('end', () => {
        throw new Error('tag {% form %} not closed');
      });
      stream.start();
    },
    *render(ctx, emitter) {
      // The platform hands the template a `form` object; the fixture models the
      // success and error shapes the theme branches on.
      platformCalls.push(this.tagArgs ?? '');
      const fixture = readCtx(ctx, 'formFixture');
      ctx.push({ form: fixture ?? { 'posted_successfully?': false, errors: null } });
      yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
      ctx.pop();
    },
  });

  engine.registerTag('paginate', {
    parse(token, remainTokens) {
      this.args = token.args;
      this.templates = [];
      const stream = this.liquid.parser.parseStream(remainTokens);
      stream.on('tag:endpaginate', () => stream.stop()).on('template', (tpl) => this.templates.push(tpl)).on('end', () => {
        throw new Error('tag {% paginate %} not closed');
      });
      stream.start();
    },
    *render(ctx, emitter) {
      // Emulates `{% paginate <array> by <n> %}`: narrows the array to the
      // current page and exposes the paginate drop, so the pagination snippet's
      // multi-page branch is genuinely executed instead of short-circuited.
      const match = /^(.+?)\s+by\s+(.+)$/.exec((this.args ?? '').trim());
      const name = match ? match[1].trim() : '';
      const raw = match ? readCtx(ctx, name) : [];
      const items = Array.isArray(raw) ? raw : [];
      const sizeArg = match ? match[2].trim() : '';
      const perPage = /^\d+$/.test(sizeArg) ? Number(sizeArg) : (readCtx(ctx, sizeArg) ?? (items.length || 1));
      const page = Math.max(1, Number(readCtx(ctx, 'paginatePage') ?? 1));
      const total = items.length;
      const pages = Math.max(1, Math.ceil(total / perPage));
      const parts = [];
      for (let p = 1; p <= pages; p += 1) {
        parts.push({ is_link: p !== page, title: String(p), url: `/collections?page=${p}` });
      }
      const pushed = {
        paginate: {
          pages,
          page,
          items: total,
          parts,
          previous: page > 1 ? { url: `/collections?page=${page - 1}` } : null,
          next: page < pages ? { url: `/collections?page=${page + 1}` } : null,
        },
        current_page: page,
      };
      if (name) pushed[name] = items.slice((page - 1) * perPage, page * perPage);
      ctx.push(pushed);
      yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
      ctx.pop();
    },
  });

  return engine;
}

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` :: ${detail}` : ''}`);
};

const baseVariant = { id: 1, title: 'Đỏ / S', options: ['Đỏ', 'S'], available: true, url: '/products/p?variant=1' };
function makeProduct(overrides = {}) {
  const rows = [
    { id: 1, title: 'Đỏ / S', options: ['Đỏ', 'S'], available: true, url: '/products/p?variant=1' },
    { id: 2, title: 'Đỏ / M', options: ['Đỏ', 'M'], available: true, url: '/products/p?variant=2' },
    { id: 3, title: 'Xanh / S', options: ['Xanh', 'S'], available: true, url: '/products/p?variant=3' },
    { id: 4, title: 'Xanh / M', options: ['Xanh', 'M'], available: true, url: '/products/p?variant=4' },
    ...overrides.extraVariants ?? [],
  ];
  const variants = rows.filter((v) => !(overrides.removeVariants ?? []).includes(v.id));
  for (const [id, available] of Object.entries(overrides.availability ?? {})) {
    const v = variants.find((x) => x.id === Number(id));
    if (v) v.available = available;
  }
  const active = variants.find((v) => v.id === overrides.activeId) ?? variants[0];
  return {
    id: 99,
    title: 'Áo thun',
    url: '/products/ao-thun',
    options: ['Màu sắc', 'Kích thước'],
    variants,
    selected_or_first_available_variant: active,
  };
}

const settings = { footer_newsletter_enable: true };

function collectionStub(n, withImage = true) {
  return {
    id: n,
    title: `Danh mục ${n}`,
    url: `/collections/danh-muc-${n}`,
    handle: `danh-muc-${n}`,
    all_products_count: n * 3,
    image: withImage ? `cover-${n}.jpg` : null,
    products: [],
  };
}

async function renderSwatch(product, optionName) {
  const engine = buildEngine();
  const src = fs.readFileSync(path.join(THEME, 'snippets', 'swatch.liquid'), 'utf8');
  return engine.parseAndRender(src, { product, swatch: optionName, settings });
}

async function renderListCollections(collections, options = {}) {
  const engine = buildEngine();
  const src = fs.readFileSync(path.join(THEME, 'templates', 'list-collections.liquid'), 'utf8');
  return engine.parseAndRender(src, {
    collections,
    settings,
    paginatePage: options.page ?? 1,
  });
}

async function renderFooter(formFixture, settingsOverride) {
  const engine = buildEngine();
  const src = fs.readFileSync(path.join(THEME, 'snippets', 'footer.liquid'), 'utf8');
  return engine.parseAndRender(src, {
    settings: settingsOverride ? { ...settings, ...settingsOverride } : settings,
    formFixture,
    shop: { name: 'Cửa hàng thử nghiệm', email: 'shop@example.test' },
    linklists: {},
  });
}

async function render404() {
  const engine = buildEngine();
  const src = fs.readFileSync(path.join(THEME, 'templates', '404.liquid'), 'utf8');
  return engine.parseAndRender(src, { settings, shop: { name: 'Cửa hàng thử nghiệm' } });
}

async function main() {
  // 1. Swatch: from Xanh/S, the size group must target Xanh/M, not Đỏ/M.
  const sizeHtml = await renderSwatch(makeProduct({ activeId: 3 }), 'Kích thước');
  check('swatch_no_unrendered_liquid', !/\{\{|\{%/.test(sizeHtml), sizeHtml.match(/\{\{|\{%/g)?.join(',') ?? '');
  check('swatch_no_liquid_error', !/Liquid error/i.test(sizeHtml));
  const sizeGroup = sizeHtml.slice(sizeHtml.indexOf('aria-label="Kích thước"'));
  const sizeHrefs = [...sizeGroup.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  check('swatch_size_targets_keep_color', JSON.stringify(sizeHrefs) === JSON.stringify(['/products/ao-thun?variant=3', '/products/ao-thun?variant=4']), sizeHrefs.join(' | '));
  check('swatch_distinct_values_only', sizeHrefs.length === 2, String(sizeHrefs.length));

  // The template includes the snippet once per option, so render the colour group on its own.
  const colorHtml = await renderSwatch(makeProduct({ activeId: 3 }), 'Màu sắc');
  const colorHrefs = [...colorHtml.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  check('swatch_color_group_from_xanh_s', JSON.stringify(colorHrefs) === JSON.stringify(['/products/ao-thun?variant=1', '/products/ao-thun?variant=3']), colorHrefs.join(' | '));
  const colorFlat = colorHtml.replace(/\s+/g, ' ');
  check('swatch_active_marks_rendered_value', /is-active" href="\/products\/ao-thun\?variant=3" title="Xanh" aria-current="true"/.test(colorFlat), colorFlat.slice(colorFlat.indexOf('swatch-options'), colorFlat.length).slice(0, 220));

  // 2. Swatch: Xanh/M sold out but the combination exists -> the dimension is preserved,
  //    the value is linked to its own sold-out variant and labelled, instead of being
  //    silently redirected to Đỏ/M.
  const soldOut = await renderSwatch(makeProduct({ activeId: 3, availability: { 4: false } }), 'Kích thước');
  const soldOutFlat = soldOut.replace(/\s+/g, ' ');
  const soldOutHrefs = [...soldOut.slice(soldOut.indexOf('aria-label="Kích thước"')).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  check('swatch_sold_out_combination_preserves_dimension', soldOutHrefs[1] === '/products/ao-thun?variant=4', soldOutHrefs.join(' | '));
  check('swatch_sold_out_combination_labelled', /href="\/products\/ao-thun\?variant=4"\s+title="M \(Hết hàng\)"/.test(soldOutFlat) && /is-unavailable/.test(soldOutFlat), soldOutFlat.slice(soldOutFlat.indexOf('swatch-options'), soldOutFlat.length).slice(0, 240));

  // 2b. The combination does not exist at all -> an available variant with that value is
  //     the only reachable target, so the fallback is admitted there and only there.
  const missingCombination = await renderSwatch(makeProduct({ activeId: 3, removeVariants: [4] }), 'Kích thước');
  const missingHrefs = [...missingCombination.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  check('swatch_missing_combination_falls_back_to_available', missingHrefs[1] === '/products/ao-thun?variant=2' && !/\(Hết hàng\)/.test(missingCombination), missingHrefs.join(' | '));

  // 2c. No variant carrying the value is available and the combination with the
  //     rendered other option does not exist -> pass 3 is the only path left, and
  //     it must still link a real variant (id 2), labelled sold out.
  const allMOut = await renderSwatch(makeProduct({ activeId: 3, removeVariants: [4], availability: { 2: false } }), 'Kích thước');
  const allMOutFlat = allMOut.replace(/\s+/g, ' ');
  const allMOutHrefs = [...allMOut.slice(allMOut.indexOf('aria-label="Kích thước"')).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  check('swatch_all_unavailable_targets_real_variant', allMOutHrefs[1] === '/products/ao-thun?variant=2', allMOutHrefs.join(' | '));
  check('swatch_all_unavailable_labelled', /href="\/products\/ao-thun\?variant=2"\s+title="M \(Hết hàng\)"/.test(allMOutFlat) && /is-unavailable/.test(allMOutFlat), allMOutFlat.slice(allMOutFlat.indexOf('swatch-options'), allMOutFlat.length).slice(0, 240));

  // 4. Single-option product: pass 1 matches trivially, no other dimension needed.
  const single = {
    id: 7,
    title: 'Nến',
    url: '/products/nen',
    options: ['Mùi hương'],
    variants: [
      { id: 71, title: 'Cam', options: ['Cam'], available: true, url: '/products/nen?variant=71' },
      { id: 72, title: 'Bạc hà', options: ['Bạc hà'], available: true, url: '/products/nen?variant=72' },
    ],
    selected_or_first_available_variant: { id: 71, title: 'Cam', options: ['Cam'], available: true },
  };
  const singleHtml = await renderSwatch(single, 'Mùi hương');
  const singleHrefs = [...singleHtml.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  check('swatch_single_option', JSON.stringify(singleHrefs) === JSON.stringify(['/products/nen?variant=71', '/products/nen?variant=72']), singleHrefs.join(' | '));

  // 5. Unknown option name renders nothing (no stray group).
  const unknown = await renderSwatch(makeProduct({ activeId: 3 }), 'Chất liệu');
  check('swatch_unknown_option_renders_nothing', unknown.trim() === '', JSON.stringify(unknown.trim().slice(0, 60)));

  // 6. list-collections renders one tile per collection through collection-card.
  const listHtml = await renderListCollections([collectionStub(1), collectionStub(2), collectionStub(3, false)]);
  check('collections_no_unrendered_liquid', !/\{\{|\{%/.test(listHtml));
  check('collections_no_liquid_error', !/Liquid error/i.test(listHtml));
  const tiles = [...listHtml.matchAll(/<article class="product-card collection-card">/g)].length;
  check('collections_tile_count', tiles === 3, String(tiles));
  check('collections_titles_and_counts', /Danh mục 1/.test(listHtml) && /9 sản phẩm/.test(listHtml) && /Danh mục 3/.test(listHtml), '');
  check('collections_cover_and_fallback', /\/cdn\/large\/cover-1\.jpg/.test(listHtml) && /\/assets\/no-image\.png/.test(listHtml), '');
  check('collections_tile_links', ["/collections/danh-muc-1", "/collections/danh-muc-2", "/collections/danh-muc-3"].every((u) => listHtml.includes(`href="${u}"`)), '');

  // 7. Empty catalog renders the empty state and no grid.
  const emptyHtml = await renderListCollections([]);
  check('collections_empty_state', /Chưa có danh mục nào/.test(emptyHtml) && !/<article class="product-card collection-card">/.test(emptyHtml), '');

  // 8. A catalog longer than one page narrows to the page and renders the
  //    pagination snippet's multi-page branch (`paginate.pages > 1`).
  const many = Array.from({ length: 26 }, (_, i) => collectionStub(i + 1));
  const pageOne = await renderListCollections(many);
  const pageOneTiles = [...pageOne.matchAll(/<article class="product-card collection-card">/g)].length;
  check('collections_pagination_slices_page', pageOneTiles === 12, String(pageOneTiles));
  check('collections_pagination_nav_rendered', /pagination-nav/.test(pageOne) && /pagination-link/.test(pageOne) && pageOne.includes('href="/collections?page=2"') && pageOne.includes('href="/collections?page=3"'), '');
  check('collections_pagination_no_previous_on_first_page', !/aria-label="Trang trước"/.test(pageOne), '');
  const pageTwo = await renderListCollections(many, { page: 2 });
  const pageTwoTiles = [...pageTwo.matchAll(/<article class="product-card collection-card">/g)].length;
  check('collections_pagination_second_page', pageTwoTiles === 12 && /Danh mục 13/.test(pageTwo) && !/Danh mục 1</.test(pageTwo), String(pageTwoTiles));
  check('collections_pagination_previous_on_later_page', /aria-label="Trang trước"/.test(pageTwo) && pageTwo.includes('href="/collections?page=1"'), '');
  const pageThree = await renderListCollections(many, { page: 3 });
  const pageThreeTiles = [...pageThree.matchAll(/<article class="product-card collection-card">/g)].length;
  check('collections_pagination_last_page_remainder', pageThreeTiles === 2 && /Danh mục 26/.test(pageThree), String(pageThreeTiles));
  const singlePageList = await renderListCollections([collectionStub(1)]);
  check('collections_single_page_hides_nav', !/pagination-nav/.test(singlePageList), '');

  // 9. Footer newsletter: the customer form mechanism and its three states.
  const callsBeforeFooter = platformCalls.length;
  const footerDefault = await renderFooter({ 'posted_successfully?': false, errors: null });
  const customerFormCalls = platformCalls.slice(callsBeforeFooter).filter((args) => /customer/.test(args)).length;
  check('footer_no_liquid_error', !/Liquid error/i.test(footerDefault) && !/\{\{|\{%/.test(footerDefault));
  check('footer_newsletter_form_mechanism', customerFormCalls === 1 && /name="contact\[tags\]"\s+value="newsletter"/.test(footerDefault) && /name="contact\[email\]"/.test(footerDefault) && /type="submit"/.test(footerDefault), `customer form tags: ${customerFormCalls}`);
  const callsBeforeDisabled = platformCalls.length;
  const footerWithoutNewsletter = await renderFooter(undefined, { footer_newsletter_enable: false });
  check('footer_newsletter_disabled_skips_form', !/name="contact\[email\]"/.test(footerWithoutNewsletter) && platformCalls.slice(callsBeforeDisabled).filter((args) => /customer/.test(args)).length === 0, '');
  check('footer_newsletter_default_hides_states', !/alert-success/.test(footerDefault) && !/form-errors/.test(footerDefault), '');
  const footerSuccess = await renderFooter({ 'posted_successfully?': true, errors: null });
  check('footer_newsletter_success_state', /class="alert alert-success"[^>]*role="alert"/.test(footerSuccess) && /Cảm ơn bạn đã đăng ký nhận tin/.test(footerSuccess), '');
  const footerError = await renderFooter({
    'posted_successfully?': false,
    errors: { count: 1, messages: { email: ['Email không hợp lệ'] } },
  });
  check('footer_newsletter_error_state', /class="form-errors alert alert-danger" role="alert"/.test(footerError) && /form-error-item/.test(footerError) && /Email không hợp lệ/.test(footerError), '');
  const footerDisabled = await renderFooter(undefined);
  check('footer_newsletter_renders_without_fixture', /name="contact\[email\]"/.test(footerDisabled) && !/Liquid error/i.test(footerDisabled), '');

  // 10. 404: the search form targets /search with no pre-filled query value.
  const notFound = await render404();
  check('notfound_no_liquid_error', !/Liquid error/i.test(notFound) && !/\{\{|\{%/.test(notFound));
  check('notfound_search_form', /action="\/search"/.test(notFound) && /role="search"/.test(notFound) && /name="q"/.test(notFound), '');
  check('notfound_search_not_prefilled', !/name="q"[^>]*value=/.test(notFound) && !/value="\{\{/.test(notFound), '');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error('failing: ' + failed.map((f) => f.id).join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('HARNESS ERROR: ' + e.message);
  process.exit(1);
});
