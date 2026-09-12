// Read-only Haravan corpus prevalence sweep.
// Counts Liquid tags / filters / objects / CDN hosts across every theme root found
// under E:/Work/customizes and E:/Work/themes, reporting both total occurrences and
// how many themes use each construct at least once.
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['E:/Work/customizes', 'E:/Work/themes'];
const EXCLUDED = [
  { match: /f1genz[\\/]Sapo[\\/]GENZ/, kind: 'NON_HARAVAN_SAPO' },
  { match: /_archive[\\/]/, kind: 'ARCHIVED_DUPLICATE' },
];

function findThemes(root, out, depth, maxDepth) {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const dir = path.join(root, e.name);
    const isTheme = fs.existsSync(path.join(dir, 'layout'))
      || fs.existsSync(path.join(dir, 'layouts'))
      || fs.existsSync(path.join(dir, 'config', 'settings.html'));
    if (isTheme) { out.push(dir); continue; }
    if (depth < maxDepth) findThemes(dir, out, depth + 1, maxDepth);
  }
}

const PROBES = {
  tags: {
    include: /\{%-?\s*include\b/g, render: /\{%-?\s*render\b/g, section: /\{%-?\s*section\b/g,
    schema: /\{%-?\s*schema\b/g, form: /\{%-?\s*form\b/g, paginate: /\{%-?\s*paginate\b/g,
    tablerow: /\{%-?\s*tablerow\b/g, liquid: /\{%-?\s*liquid\b/g, layout: /\{%-?\s*layout\b/g,
    raw: /\{%-?\s*raw\s*-?%\}/g, comment: /\{%-?\s*comment\s*-?%\}/g, assign: /\{%-?\s*assign\b/g,
    capture: /\{%-?\s*capture\b/g, cycle: /\{%-?\s*cycle\b/g, increment: /\{%-?\s*increment\b/g,
    echo: /\{%-?\s*echo\b/g,
  },
  filters: {
    asset_url: /\|\s*asset_url\b/g, img_url: /\|\s*img_url\b/g, image_url: /\|\s*image_url\b/g,
    product_img_url: /\|\s*product_img_url\b/g, file_url: /\|\s*file_url\b/g,
    stylesheet_tag: /\|\s*stylesheet_tag\b/g, script_tag: /\|\s*script_tag\b/g, link_to: /\|\s*link_to\b/g,
    money: /\|\s*money\b/g, money_with_currency: /\|\s*money_with_currency\b/g, json: /\|\s*json\b/g,
    t: /\|\s*t\b/g, handleize: /\|\s*handleize\b/g, url_escape: /\|\s*url_escape\b/g,
    default_errors: /\|\s*default_errors\b/g, where: /\|\s*where\b/g, reject: /\|\s*reject\b/g,
    map: /\|\s*map\b/g, concat: /\|\s*concat\b/g, sort: /\|\s*sort\b/g, date: /\|\s*date\b/g,
    strip_html: /\|\s*strip_html\b/g, truncate: /\|\s*truncate\b/g, escape: /\|\s*escape\b/g,
    newline_to_br: /\|\s*newline_to_br\b/g, split: /\|\s*split\b/g, join: /\|\s*join\b/g,
    uniq: /\|\s*uniq\b/g, reverse: /\|\s*reverse\b/g, slice: /\|\s*slice\b/g,
    append: /\|\s*append\b/g, prepend: /\|\s*prepend\b/g, weight_with_unit: /\|\s*weight_with_unit\b/g,
    link_to_vendor: /\|\s*link_to_vendor\b/g, link_to_type: /\|\s*link_to_type\b/g,
    highlight: /\|\s*highlight\b/g, placeholder_svg_tag: /\|\s*placeholder_svg_tag\b/g,
    default_pagination: /\|\s*default_pagination\b/g,
  },
  objects: {
    first_available_variant: /first_available_variant\b/g,
    selected_or_first_available_variant: /selected_or_first_available_variant\b/g,
    product_media: /\bproduct\.media\b/g, product_images: /\bproduct\.images\b/g,
    product_featured_image: /\bproduct\.featured_image\b/g, product_variants: /\bproduct\.variants\b/g,
    product_price: /\bproduct\.price\b/g, product_compare_at_price: /\bproduct\.compare_at_price\b/g,
    product_available: /\bproduct\.available\b/g, product_vendor: /\bproduct\.vendor\b/g,
    product_description: /\bproduct\.description\b/g, product_tags: /\bproduct\.tags\b/g,
    collection_products: /\bcollection\.products\b/g, collection_all_products: /\bcollection\.all_products\b/g,
    collections_global: /\bcollections\.\w/g, all_products_global: /\ball_products\b/g,
    linklists: /\blinklists\./g, blog_articles: /\bblog\.articles\b/g, blogs_global: /\bblogs\.\w/g,
    article_excerpt: /\barticle\.excerpt\b/g, cart_items: /\bcart\.items\b/g,
    cart_total_price: /\bcart\.total_price\b/g, line_item: /\bline_item\./g,
    customer_global: /\bcustomer\.\w/g, shop_global: /\bshop\.\w/g, settings_global: /\bsettings\.\w/g,
    content_for_header: /content_for_header/g, content_for_index: /content_for_index/g,
    canonical_url: /canonical_url/g, current_tags: /current_tags/g, current_page: /current_page/g,
    template_global: /\btemplate\.\w/g, paginate_global: /\bpaginate\.\w/g, form_global: /\bform\.\w/g,
    images_global: /\bimages\.\w/g, pages_global: /\bpages\.\w/g, articles_global: /\barticles\.\w/g,
    forloop: /\bforloop\.\w/g, routes_global: /\broutes\.\w/g, localization: /\blocalization\.\w/g,
    checkout_global: /\bcheckout\.\w/g, discount_global: /\bdiscount\.\w/g,
  },
  hosts: {
    hstatic_net: /hstatic\.net/g, theme_hstatic: /theme\.hstatic\.net/g,
    product_hstatic: /product\.hstatic\.net/g, file_hstatic: /file\.hstatic\.net/g,
    haravan_com: /haravan\.com/g,
  },
};

const LIQUID_FILES = /\.(liquid|html)$/i;
const roots = [];
for (const root of ROOTS) findThemes(root, roots, 1, 4);
const themes = roots.map((dir) => {
  const rel = path.relative('E:/Work', dir).replace(/\\/g, '/');
  const excluded = EXCLUDED.find((x) => x.match.test(dir));
  return { dir, rel, kind: excluded ? excluded.kind : 'HARAVAN', reason: excluded?.kind ?? '' };
});

const rows = new Map();
for (const key of Object.keys(PROBES)) for (const name of Object.keys(PROBES[key])) rows.set(`${key}.${name}`, { total: 0, themes: 0 });

const themeRows = [];
const perTheme = {};
for (const theme of themes) {
  if (theme.kind !== 'HARAVAN') { themeRows.push({ theme: theme.rel, kind: theme.kind, skipped: true }); continue; }
  const local = new Map();
  let scanned = 0;
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p); continue; }
      if (!LIQUID_FILES.test(e.name)) continue;
      let text = '';
      try { if (fs.statSync(p).size > 3_000_000) continue; text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      scanned += 1;
      for (const key of Object.keys(PROBES)) {
        for (const [name, re] of Object.entries(PROBES[key])) {
          const hits = text.match(re);
          if (!hits) continue;
          const id = `${key}.${name}`;
          local.set(id, (local.get(id) ?? 0) + hits.length);
        }
      }
    }
  };
  walk(theme.dir);
  for (const [id, count] of local) { const row = rows.get(id); row.total += count; row.themes += 1; }
  perTheme[theme.rel] = { scanned, tags: {}, filters: {}, objects: {}, hosts: {} };
  for (const [id, count] of local) { const [kind, name] = id.split('.'); perTheme[theme.rel][kind][name] = count; }
  themeRows.push({ theme: theme.rel, kind: 'HARAVAN', scanned, distinctProbes: local.size });
}

const haravanThemes = themes.filter((t) => t.kind === 'HARAVAN').length;
const out = {
  generatedBy: 'plans/reports/_corpus-prevalence.mjs — Main read-only sweep, regex counts over *.liquid + *.html',
  roots: ROOTS,
  haravanThemes,
  themeRootCount: themes.length,
  excluded: themes.filter((t) => t.kind !== 'HARAVAN').map((t) => ({ theme: t.rel, kind: t.kind })),
  prevalence: Object.fromEntries([...rows.entries()].sort((a, b) => b[1].themes - a[1].themes || b[1].total - a[1].total)),
  themeRows,
  perTheme,
};
fs.writeFileSync('plans/reports/_corpus-prevalence-raw.json', `${JSON.stringify(out, null, 1)}\n`, 'utf8');
console.log(`haravanThemes=${haravanThemes} themeRoots=${themes.length} excluded=${out.excluded.length} scannedFiles=${themeRows.reduce((a, b) => a + (b.scanned || 0), 0)}`);
console.log('--- tags');
for (const [id, r] of Object.entries(out.prevalence)) if (id.startsWith('tags.') && r.themes >= 2) console.log(`${id.padEnd(34)} themes=${String(r.themes).padStart(2)} total=${r.total}`);
console.log('--- filters');
for (const [id, r] of Object.entries(out.prevalence)) if (id.startsWith('filters.') && r.themes >= 2) console.log(`${id.padEnd(34)} themes=${String(r.themes).padStart(2)} total=${r.total}`);
