// Throwaway verification: executes the real Liquid source of the base theme's
// swatch snippet and list-collections template through LiquidJS (the engine the
// session's render harness already uses), with the platform-only tags stubbed.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const LIQUID_PACKAGE = 'E:/Work/apps/Haravan CLI/package.json';
const require = createRequire(LIQUID_PACKAGE);
const { Liquid } = require('liquidjs');

const THEME = new URL('../../themes/universal-haravan-base', import.meta.url).pathname.replace(/^\//, '');

function buildEngine() {
  const engine = new Liquid({
    root: [path.join(THEME, 'snippets'), path.join(THEME, 'templates'), THEME],
    extname: '.liquid',
    strictFilters: false,
    strictVariables: false,
  });

  engine.registerFilter('img_url', (value, size) => (value ? `/cdn/${size}/${value}` : ''));
  engine.registerFilter('asset_url', (value) => `/assets/${value}`);

  engine.registerTag('form', {
    parse(token, remainTokens) {
      this.templates = [];
      const stream = this.liquid.parser.parseStream(remainTokens);
      stream.on('tag:endform', () => stream.stop()).on('template', (tpl) => this.templates.push(tpl)).on('end', () => {
        throw new Error('tag {% form %} not closed');
      });
      stream.start();
    },
    *render(ctx, emitter) {
      yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
    },
  });

  engine.registerTag('paginate', {
    parse(token, remainTokens) {
      this.templates = [];
      const stream = this.liquid.parser.parseStream(remainTokens);
      stream.on('tag:endpaginate', () => stream.stop()).on('template', (tpl) => this.templates.push(tpl)).on('end', () => {
        throw new Error('tag {% paginate %} not closed');
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

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` :: ${detail}` : ''}`);
};

const baseVariant = { id: 1, title: 'Đỏ / S', options: ['Đỏ', 'S'], available: true, url: '/products/p?variant=1' };
function makeProduct(overrides = {}) {
  const variants = [
    { id: 1, title: 'Đỏ / S', options: ['Đỏ', 'S'], available: true, url: '/products/p?variant=1' },
    { id: 2, title: 'Đỏ / M', options: ['Đỏ', 'M'], available: true, url: '/products/p?variant=2' },
    { id: 3, title: 'Xanh / S', options: ['Xanh', 'S'], available: true, url: '/products/p?variant=3' },
    { id: 4, title: 'Xanh / M', options: ['Xanh', 'M'], available: true, url: '/products/p?variant=4' },
    ...overrides.extraVariants ?? [],
  ];
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

async function renderListCollections(collections) {
  const engine = buildEngine();
  const src = fs.readFileSync(path.join(THEME, 'templates', 'list-collections.liquid'), 'utf8');
  return engine.parseAndRender(src, { collections, settings, paginate: { pages: 1, page: 1, items: collections.length } });
}

const hrefs = (html, groupMarker) => {
  const start = html.indexOf(groupMarker);
  const slice = start < 0 ? html : html.slice(start, html.indexOf('swatch-group', start + 10));
  return [...slice.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
};

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

  // 2. Swatch: Xanh/M sold out -> size M falls back to an available variant with that size.
  const soldOut = await renderSwatch(makeProduct({ activeId: 3, availability: { 4: false } }), 'Kích thước');
  const soldOutHrefs = [...soldOut.slice(soldOut.indexOf('aria-label="Kích thước"')).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  check('swatch_unavailable_value_falls_back', soldOutHrefs[1] === '/products/ao-thun?variant=2', soldOutHrefs.join(' | '));

  // 3. Every variant of a value unavailable -> pass 3 links it and labels it sold out.
  const allMOut = await renderSwatch(makeProduct({ activeId: 3, availability: { 2: false, 4: false } }), 'Kích thước');
  check('swatch_all_unavailable_labelled', /\(Hết hàng\)/.test(allMOut) && /is-unavailable/.test(allMOut), allMOut.replace(/\s+/g, ' ').slice(0, 0) || 'label present');

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
