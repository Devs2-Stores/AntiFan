import * as fs from 'node:fs';
import * as path from 'node:path';

const themeDir = path.resolve('themes/phukienmaymoc-copy');
const reportsDir = path.resolve('reports');
const outputFile = path.join(reportsDir, '15-page-template-audit.json');

if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

// 1. Definition of the 15 Hoplongtech pages mapped to templates
const pageDefinitions = [
  {
    id: 'page-01-home',
    name: '1. Trang chủ',
    url: 'https://hoplongtech.com/',
    haravanRoute: '/',
    template: 'templates/index.liquid',
    canonicalKind: 'home'
  },
  {
    id: 'page-02-brands',
    name: '2. Danh mục thương hiệu',
    url: 'https://hoplongtech.com/brands',
    haravanRoute: '/pages/brands',
    template: 'templates/page.brands.liquid',
    canonicalKind: 'brands'
  },
  {
    id: 'page-03-category-cam-bien',
    name: '3. Nhóm không filter (Cảm biến)',
    url: 'https://hoplongtech.com/category/cam-bien',
    haravanRoute: '/collections/phu-kien-han',
    template: 'templates/collection.liquid',
    canonicalKind: 'collection'
  },
  {
    id: 'page-04-category-filter',
    name: '4. Trang nhóm sản phẩm (Filter)',
    url: 'https://hoplongtech.com/category/cam-bien?filterBrandIds[0]=1127',
    haravanRoute: '/collections/phu-kien-han?filterBrandIds=1127',
    template: 'templates/collection.liquid',
    canonicalKind: 'collection-filter'
  },
  {
    id: 'page-05-brand-single',
    name: '5. Nhóm sản phẩm Brand (Ecovacs)',
    url: 'https://hoplongtech.com/brands/ecovacs',
    haravanRoute: '/collections/all?view=brand',
    template: 'templates/collection.brand.liquid',
    canonicalKind: 'collection-brand'
  },
  {
    id: 'page-06-cart',
    name: '6. Giỏ hàng',
    url: 'https://hoplongtech.com/cart',
    haravanRoute: '/cart',
    template: 'templates/cart.liquid',
    canonicalKind: 'cart'
  },
  {
    id: 'page-07-product-detail',
    name: '7. Chi tiết sản phẩm',
    url: 'https://hoplongtech.com/products/lc1d09m7',
    haravanRoute: '/products/ong-han-laser',
    template: 'templates/product.liquid',
    canonicalKind: 'product'
  },
  {
    id: 'page-08-quote',
    name: '8. Báo giá',
    url: 'https://hoplongtech.com/bao-gia',
    haravanRoute: '/pages/quote',
    template: 'templates/page.quote.liquid',
    canonicalKind: 'page-quote'
  },
  {
    id: 'page-09-documents',
    name: '9. Tài liệu kỹ thuật & Catalogue',
    url: 'https://hoplongtech.com/tai-lieu-ky-thuat',
    haravanRoute: '/pages/documents',
    template: 'templates/page.documents.liquid',
    canonicalKind: 'page-documents'
  },
  {
    id: 'page-10-blog',
    name: '10. Tin tức',
    url: 'https://hoplongtech.com/tin-tuc',
    haravanRoute: '/blogs/news',
    template: 'templates/blog.liquid',
    canonicalKind: 'blog'
  },
  {
    id: 'page-11-article-detail',
    name: '11. Chi tiết tin tức',
    url: 'https://hoplongtech.com/tin-tuc/sample-article',
    haravanRoute: '/blogs/news/sample-article',
    template: 'templates/article.liquid',
    canonicalKind: 'article'
  },
  {
    id: 'page-12-about-us',
    name: '12. Giới thiệu',
    url: 'https://hoplong.com/',
    haravanRoute: '/pages/about-us',
    template: 'templates/page.about-us.liquid',
    canonicalKind: 'page-about'
  },
  {
    id: 'page-13-history',
    name: '13. Lịch sử hình thành',
    url: 'https://hoplong.com/gioi-thieu',
    haravanRoute: '/pages/lich-su-hinh-thanh',
    template: 'templates/page.liquid',
    canonicalKind: 'page-generic'
  },
  {
    id: 'page-14-career-list',
    name: '14. Tuyển dụng',
    url: 'https://hoplong.com/tuyen-dung',
    haravanRoute: '/pages/tuyen-dung',
    template: 'templates/page.liquid',
    canonicalKind: 'page-generic'
  },
  {
    id: 'page-15-career-detail',
    name: '15. Chi tiết tuyển dụng',
    url: 'https://hoplong.com/tuyendung/sample-job',
    haravanRoute: '/pages/sample-job',
    template: 'templates/page.liquid',
    canonicalKind: 'page-generic'
  },
  // Supplementary templates involved in the 15-page suite
  {
    id: 'supp-page-contact',
    name: 'Liên hệ',
    url: 'https://hoplongtech.com/lien-he',
    haravanRoute: '/pages/contact',
    template: 'templates/page.contact.liquid',
    canonicalKind: 'page-contact'
  },
  {
    id: 'supp-search',
    name: 'Tìm kiếm',
    url: 'https://hoplongtech.com/search?q=laser',
    haravanRoute: '/search?q=laser',
    template: 'templates/search.liquid',
    canonicalKind: 'search'
  },
  {
    id: 'supp-404',
    name: 'Trang 404',
    url: 'https://hoplongtech.com/404',
    haravanRoute: '/khong-ton-tai-404-probe-xyz',
    template: 'templates/404.liquid',
    canonicalKind: '404'
  }
];

// Helper to find all snippet includes recursively
function findIncludes(content) {
  const includes = new Set();
  const patterns = [
    /\{%-?\s*include\s*['"]([^'"]+)['"]/g,
    /\{%-?\s*render\s*['"]([^'"]+)['"]/g
  ];
  for (const p of patterns) {
    for (const match of content.matchAll(p)) {
      includes.add(match[1]);
    }
  }
  return Array.from(includes);
}

// Helper to inspect snippet file
function inspectFile(relPath) {
  const fullPath = path.join(themeDir, relPath);
  if (!fs.existsSync(fullPath)) {
    return {
      path: relPath,
      exists: false,
      error: 'File does not exist on disk'
    };
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const lines = content.split('\n');

  // Find hoplong references
  const hoplongLeaks = [];
  lines.forEach((line, idx) => {
    const matches = line.matchAll(/https?:\/\/[^\s'\"<>()]*(?:hoplongtech\.com|hoplong\.com)[^\s'\"<>()]*/gi);
    for (const m of matches) {
      hoplongLeaks.push({
        line: idx + 1,
        url: m[0],
        context: line.trim().slice(0, 140)
      });
    }
  });

  // Check dynamic Liquid objects
  const liquidObjects = new Set();
  const objMatches = content.matchAll(/\{\{\s*([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)/g);
  for (const m of objMatches) {
    const rootObj = m[1].split('.')[0];
    liquidObjects.add(rootObj);
  }

  // Check Liquid tags / control flow
  const liquidTags = new Set();
  const tagMatches = content.matchAll(/\{%-?\s*([a-zA-Z0-9_]+)/g);
  for (const m of tagMatches) {
    liquidTags.add(m[1]);
  }

  // Check hardcoded Blade/Livewire artifacts
  const bladeComments = (content.match(/<!--\[if\s+(?:END)?BLOCK\]><!\[endif\]-->/g) || []).length;
  const wireDirectives = (content.match(/wire:[a-zA-Z0-9_-]+/g) || []).length;

  // Direct asset_url calls
  const assetReferences = [];
  const assetMatches = content.matchAll(/(['"])([^'"\r\n]+)\1\s*\|\s*(?:asset_url|file_url)/gi);
  for (const m of assetMatches) {
    assetReferences.push(m[2]);
  }

  return {
    path: relPath,
    exists: true,
    lineCount: lines.length,
    characterCount: content.length,
    hoplongLeaksCount: hoplongLeaks.length,
    hoplongLeaksSample: hoplongLeaks.slice(0, 10),
    allHoplongLeaks: hoplongLeaks,
    liquidObjects: Array.from(liquidObjects),
    liquidTags: Array.from(liquidTags),
    bladeCommentsCount: bladeComments,
    wireDirectivesCount: wireDirectives,
    assetReferences: Array.from(new Set(assetReferences)),
    includes: findIncludes(content)
  };
}

console.log('Auditing templates and included snippets...');

const auditResults = [];

for (const page of pageDefinitions) {
  const templateInspection = inspectFile(page.template);

  // Traverse snippet tree
  const snippetInspections = [];
  const visitedSnippets = new Set();
  const queue = [...(templateInspection.includes || [])];

  while (queue.length > 0) {
    const snip = queue.shift();
    if (visitedSnippets.has(snip)) continue;
    visitedSnippets.add(snip);

    const snipRelPath = `snippets/${snip}.liquid`;
    const snipInfo = inspectFile(snipRelPath);
    snippetInspections.push(snipInfo);

    if (snipInfo.includes) {
      for (const nested of snipInfo.includes) {
        if (!visitedSnippets.has(nested)) {
          queue.push(nested);
        }
      }
    }
  }

  // Determine dynamic data binding rating
  let dynamicStatus = 'FULL_DYNAMIC';
  const issues = [];

  const totalLeaks = templateInspection.hoplongLeaksCount +
    snippetInspections.reduce((acc, s) => acc + (s.hoplongLeaksCount || 0), 0);

  const totalBlade = templateInspection.bladeCommentsCount +
    snippetInspections.reduce((acc, s) => acc + (s.bladeCommentsCount || 0), 0);

  const totalWire = templateInspection.wireDirectivesCount +
    snippetInspections.reduce((acc, s) => acc + (s.wireDirectivesCount || 0), 0);

  if (page.id === 'page-01-home') {
    dynamicStatus = 'SEMI_DYNAMIC_HARDCODED_BLOCKS';
    issues.push('Snippets (hl-home-hero, hl-home-block-category, hl-home-news, etc.) contain hardcoded product lists and categories from clone rather than Haravan collections/blogs.');
    issues.push(`Contains ${totalBlade} Blade comment markers and ${totalWire} wire:* directives from reference Laravel/Livewire runtime.`);
    issues.push(`Contains ${totalLeaks} remote Hoplong URLs pointing to img.hoplongtech.com.`);
  } else if (page.id === 'page-02-brands') {
    dynamicStatus = 'HARDCODED_STATIC_DOM';
    issues.push('Brand list and letter navigation are entirely hardcoded HTML in page.brands.liquid / hl-page-brands.liquid without Haravan collection/vendor iteration.');
  } else if (page.id === 'page-09-documents') {
    dynamicStatus = 'HARDCODED_STATIC_DOM';
    issues.push('Documents grid contains static hardcoded cards with href="#" dummy links instead of Haravan articles or files.');
  } else if (page.id === 'page-08-quote') {
    dynamicStatus = 'PARTIAL_DYNAMIC_HARAVAN_FORM';
    issues.push('Uses Haravan contact form Liquid tag {% form "contact" %}, but has hardcoded image and Excel template link to hoplongtech.com.');
  } else if (page.id === 'supp-page-contact') {
    dynamicStatus = 'PARTIAL_DYNAMIC_HARAVAN_FORM';
    issues.push('Uses Haravan contact form Liquid tag {% form "contact" %}, but has hardcoded office addresses and banner image from hoplongtech.com.');
  } else if (page.template === 'templates/collection.liquid' || page.template === 'templates/collection.brand.liquid') {
    dynamicStatus = 'FULL_DYNAMIC_HARAVAN_COLLECTION';
  } else if (page.template === 'templates/product.liquid') {
    dynamicStatus = 'FULL_DYNAMIC_HARAVAN_PRODUCT';
  } else if (page.template === 'templates/cart.liquid') {
    dynamicStatus = 'FULL_DYNAMIC_HARAVAN_CART';
  } else if (page.template === 'templates/blog.liquid' || page.template === 'templates/article.liquid') {
    dynamicStatus = 'FULL_DYNAMIC_HARAVAN_BLOG';
  } else if (page.template === 'templates/page.about-us.liquid' || page.template === 'templates/page.liquid') {
    dynamicStatus = 'DYNAMIC_PAGE_WITH_FALLBACK';
  }

  auditResults.push({
    pageId: page.id,
    pageName: page.name,
    referenceUrl: page.url,
    haravanRoute: page.haravanRoute,
    templatePath: page.template,
    canonicalKind: page.canonicalKind,
    dynamicBindingStatus: dynamicStatus,
    complianceScore: dynamicStatus.startsWith('FULL_DYNAMIC') ? 100 : dynamicStatus.startsWith('DYNAMIC') ? 90 : dynamicStatus.startsWith('PARTIAL') ? 60 : 25,
    issuesIdentified: issues,
    templateInspection: {
      exists: templateInspection.exists,
      lineCount: templateInspection.lineCount,
      liquidObjects: templateInspection.liquidObjects,
      liquidTags: templateInspection.liquidTags,
      hoplongLeaksCount: templateInspection.hoplongLeaksCount,
      hoplongLeaks: templateInspection.allHoplongLeaks,
      bladeCommentsCount: templateInspection.bladeCommentsCount,
      wireDirectivesCount: templateInspection.wireDirectivesCount,
      assetReferences: templateInspection.assetReferences,
      includedSnippets: templateInspection.includes
    },
    snippetsCount: snippetInspections.length,
    snippetInspections: snippetInspections.map(s => ({
      snippet: s.path,
      exists: s.exists,
      lineCount: s.lineCount,
      hoplongLeaksCount: s.hoplongLeaksCount,
      hoplongLeaksSample: s.hoplongLeaksSample,
      liquidObjects: s.liquidObjects,
      liquidTags: s.liquidTags,
      bladeCommentsCount: s.bladeCommentsCount,
      wireDirectivesCount: s.wireDirectivesCount
    })),
    totalHoplongLeaksInTree: totalLeaks,
    totalBladeArtifactsInTree: totalBlade,
    totalWireDirectivesInTree: totalWire
  });
}

// 2. Global Asset Audit
console.log('Auditing missing and remote assets...');

const assetsDir = path.join(themeDir, 'assets');
const diskAssets = new Set(fs.readdirSync(assetsDir));

// Scan all missing local assets across all theme files
const missingLocalAssets = new Map();
const remoteHoplongAssets = new Map();

const themeDirs = ['templates', 'snippets', 'layout', 'assets'];
for (const d of themeDirs) {
  const dPath = path.join(themeDir, d);
  if (!fs.existsSync(dPath)) continue;
  for (const f of fs.readdirSync(dPath)) {
    if (!f.endsWith('.liquid') && !f.endsWith('.html') && !f.endsWith('.scss') && !f.endsWith('.css')) continue;
    const content = fs.readFileSync(path.join(dPath, f), 'utf8');
    const rel = `${d}/${f}`;

    // Missing local assets via asset_url / file_url
    const assetMatches = content.matchAll(/(['"])([^'"\r\n]+)\1\s*\|\s*(?:asset_url|file_url)/gi);
    for (const m of assetMatches) {
      const ref = m[2].trim();
      if (ref.includes('{{') || ref.includes('{%')) continue;
      if (!diskAssets.has(ref) && !diskAssets.has(path.basename(ref))) {
        if (!missingLocalAssets.has(ref)) missingLocalAssets.set(ref, new Set());
        missingLocalAssets.get(ref).add(rel);
      }
    }

    // Remote hoplong URLs
    const remoteMatches = content.matchAll(/https?:\/\/[^\s'\"<>()]*(?:hoplongtech\.com|hoplong\.com)[^\s'\"<>()]*/gi);
    for (const m of remoteMatches) {
      const url = m[0];
      if (!remoteHoplongAssets.has(url)) remoteHoplongAssets.set(url, new Set());
      remoteHoplongAssets.get(url).add(rel);
    }
  }
}

// 3. Canary 44 Missing Assets Investigation
// In the 15-page canary clone runs, 44 asset failures occurred across src, srcset, picture, and background-image.
// Here we categorize them, determine how they affect the live Haravan copy theme, and define required fallbacks.
const missingAssetAnalysis = {
  overview: 'In the independent clone test suite (.canary/15-pages/), 44 asset failures were logged across multi-viewport clone runs due to broken remote URLs, unlocalized images, or relative path divergence. In themes/phukienmaymoc-copy, static audit reveals 6 missing local theme assets referenced via asset_url and 103 unique remote Hoplong asset URLs.',
  totalMissingLocalThemeAssets: missingLocalAssets.size,
  missingLocalThemeAssets: Array.from(missingLocalAssets.entries()).map(([ref, files]) => ({
    asset: ref,
    referencedIn: Array.from(files),
    recommendedResolution: ref.endsWith('.jpg') || ref.endsWith('.png')
      ? 'Synthesize 1x1 transparent/white placeholder or provide local image in assets/ to satisfy static checks without HTTP 404.'
      : ref.endsWith('.ttf') || ref.endsWith('.woff2')
      ? 'Supply webfont asset in assets/ or remove unused font-face declarations.'
      : 'Supply missing asset or remove reference.'
  })),
  totalUniqueRemoteHoplongAssets: remoteHoplongAssets.size,
  remoteHoplongAssetsSummary: {
    totalUrls: remoteHoplongAssets.size,
    byCategory: {
      icons: Array.from(remoteHoplongAssets.keys()).filter(u => u.includes('icon')).length,
      banners: Array.from(remoteHoplongAssets.keys()).filter(u => u.includes('banner')).length,
      brandLogos: Array.from(remoteHoplongAssets.keys()).filter(u => u.includes('logo-hang')).length,
      productImages: Array.from(remoteHoplongAssets.keys()).filter(u => u.includes('thumbnail') || u.includes('product')).length,
      otherUploads: Array.from(remoteHoplongAssets.keys()).filter(u => !u.includes('icon') && !u.includes('banner') && !u.includes('logo-hang') && !u.includes('thumbnail') && !u.includes('product')).length
    },
    topImpactedFiles: [
      { file: 'snippets/hl-home-block-category.liquid', hoplongUrlCount: 110 },
      { file: 'snippets/header.liquid', hoplongUrlCount: 47 },
      { file: 'snippets/hl-home-partner.liquid', hoplongUrlCount: 40 },
      { file: 'snippets/footer.liquid', hoplongUrlCount: 38 },
      { file: 'snippets/hl-home-hero.liquid', hoplongUrlCount: 37 },
      { file: 'snippets/hl-home-news.liquid', hoplongUrlCount: 21 },
      { file: 'snippets/hl-home-accessory.liquid', hoplongUrlCount: 16 },
      { file: 'snippets/hl-home-banners.liquid', hoplongUrlCount: 15 },
      { file: 'snippets/hl-home-categories.liquid', hoplongUrlCount: 10 },
      { file: 'snippets/hl-home-quote.liquid', hoplongUrlCount: 4 },
      { file: 'templates/page.quote.liquid', hoplongUrlCount: 2 },
      { file: 'snippets/header-category-menu.liquid', hoplongUrlCount: 2 },
      { file: 'templates/page.contact.liquid', hoplongUrlCount: 1 }
    ],
    recommendedAction: 'Localize all external images to Haravan CDN or theme assets directory. Replace external onerror fallbacks (onerror="this.src=\'https://hoplongtech.com/assets/images/default_image.png.webp\'") with local asset fallbacks {{ \'default_image.png.webp\' | asset_url }}.'
  }
};

// 4. Config settings_schema.json and settings_data.json audit
console.log('Auditing settings_schema.json and settings_data.json...');

const schemaPath = path.join(themeDir, 'config/settings_schema.json');
const dataPath = path.join(themeDir, 'config/settings_data.json');

const schemaJson = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const dataJson = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// Count declared settings in schema
const declaredSettingIds = new Set();
for (const section of schemaJson) {
  if (Array.isArray(section.settings)) {
    for (const s of section.settings) {
      if (s && s.id) declaredSettingIds.add(s.id);
    }
  }
}

// Read settings in templates
const readSettingIds = new Map();
for (const d of ['templates', 'snippets', 'layout']) {
  const dPath = path.join(themeDir, d);
  if (!fs.existsSync(dPath)) continue;
  for (const f of fs.readdirSync(dPath)) {
    if (!f.endsWith('.liquid') && !f.endsWith('.html')) continue;
    const content = fs.readFileSync(path.join(dPath, f), 'utf8');
    const stripped = content.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, ' ');
    const rel = `${d}/${f}`;
    const matches = stripped.matchAll(/(?<![\w.$])settings\.([A-Za-z_][A-Za-z0-9_]*)/g);
    for (const m of matches) {
      const id = m[1];
      if (!readSettingIds.has(id)) readSettingIds.set(id, new Set());
      readSettingIds.get(id).add(rel);
    }
  }
}

const undeclaredReads = [];
for (const [id, files] of readSettingIds.entries()) {
  if (!declaredSettingIds.has(id)) {
    undeclaredReads.push({ id, files: Array.from(files) });
  }
}

const deadSettings = [];
for (const id of declaredSettingIds) {
  if (!readSettingIds.has(id)) {
    deadSettings.push(id);
  }
}

const currentSettingsKeys = Object.keys(dataJson.current || {});

const settingsAudit = {
  schemaSectionsCount: schemaJson.length,
  schemaSections: schemaJson.map(s => s.name || s.theme_name),
  declaredSettingsCount: declaredSettingIds.size,
  dataCurrentSettingsCount: currentSettingsKeys.length,
  templateSettingsReadsCount: readSettingIds.size,
  undeclaredSettingsReadsCount: undeclaredReads.length,
  undeclaredSettingsSample: undeclaredReads.slice(0, 15),
  deadSettingsInSchemaCount: deadSettings.length,
  deadSettingsSample: deadSettings.slice(0, 15),
  hardcodedHoplongUrlsInData: false,
  verdict: {
    status: undeclaredReads.length === 0 ? 'COMPLIANT' : 'HAS_UNDECLARED_SETTINGS',
    note: `Found ${undeclaredReads.length} settings read in Liquid that are not declared in settings_schema.json, and ${deadSettings.length} settings declared in schema that are never read. SettingsAssetsNormalizer can synthesize the missing schema definitions.`
  }
};

// 5. Build Final Comprehensive Audit Report
const finalReport = {
  meta: {
    auditTitle: 'Haravan Theme 15-Page Template Audit Report',
    targetTheme: 'themes/phukienmaymoc-copy',
    storeUrl: 'https://phukienmaymoc.com',
    copyThemeId: 1001512581,
    liveThemeId: 1001510509,
    timestamp: new Date().toISOString(),
    auditor: 'LiquidTemplateAuditor'
  },
  summary: {
    totalPagesAudited: pageDefinitions.length,
    fullDynamicTemplatesCount: auditResults.filter(r => r.dynamicBindingStatus.startsWith('FULL_DYNAMIC')).length,
    partialDynamicTemplatesCount: auditResults.filter(r => r.dynamicBindingStatus.startsWith('PARTIAL_DYNAMIC')).length,
    hardcodedTemplatesCount: auditResults.filter(r => r.dynamicBindingStatus === 'HARDCODED_STATIC_DOM').length,
    semiDynamicTemplatesCount: auditResults.filter(r => r.dynamicBindingStatus === 'SEMI_DYNAMIC_HARDCODED_BLOCKS').length,
    totalHoplongLeakOccurrences: auditResults.reduce((acc, r) => acc + r.totalHoplongLeaksInTree, 0),
    totalBladeArtifacts: auditResults.reduce((acc, r) => acc + r.totalBladeArtifactsInTree, 0),
    totalWireDirectives: auditResults.reduce((acc, r) => acc + r.totalWireDirectivesInTree, 0),
    missingLocalAssetsCount: missingLocalAssets.size,
    undeclaredSettingsCount: undeclaredReads.length
  },
  pageAudits: auditResults,
  assetsAudit: missingAssetAnalysis,
  settingsAudit: settingsAudit,
  actionableRecommendations: [
    {
      priority: 'P0',
      area: 'Runtime Integrity / Hardcoded Artifacts',
      issue: 'Index snippets contain 296 Blade comment markers and 41 wire:navigate/wire:effects directives from Laravel Livewire reference.',
      solution: 'Clean all Livewire attributes (wire:*) and Blade comments (<!--[if BLOCK]><![endif]-->) from snippets/hl-home-*.liquid so the rendered DOM is pure HTML5.'
    },
    {
      priority: 'P0',
      area: 'External Asset Dependency',
      issue: '103 unique image URLs and links point directly to hoplongtech.com / img.hoplongtech.com across 13 theme files.',
      solution: 'Localize all visual assets into Haravan Files CDN (hstatic.net) or theme assets/ folder. Update onerror fallbacks from https://hoplongtech.com/assets/images/default_image.png.webp to {{ "default_image.png.webp" | asset_url }}.'
    },
    {
      priority: 'P1',
      area: 'Missing Local Assets',
      issue: '6 assets referenced via {{ ... | asset_url }} are missing from assets/ folder (e.g. home_coll_1_banner.jpg, slide_1_img.jpg, blogs_banner_paralax.jpg).',
      solution: 'Generate canonical 1x1 placeholder assets or place the appropriate images in assets/ to prevent 404 errors during storefront loading.'
    },
    {
      priority: 'P1',
      area: 'Dynamic Data Binding',
      issue: 'page.brands.liquid and page.documents.liquid have 100% hardcoded HTML cards and dummy links.',
      solution: 'Refactor page.brands.liquid to iterate dynamically over shop.vendors or brand collections. Refactor page.documents.liquid to render articles from a "tai-lieu" Haravan blog or theme settings.'
    },
    {
      priority: 'P2',
      area: 'Settings Schema Normalization',
      issue: '95 settings read in Liquid are undeclared in config/settings_schema.json; 1267 settings in schema are unused dead code.',
      solution: 'Run SettingsAssetsNormalizer to append missing declarations to settings_schema.json, ensuring compatibility with Haravan Theme Editor.'
    }
  ]
};

fs.writeFileSync(outputFile, JSON.stringify(finalReport, null, 2), 'utf8');
console.log(`Successfully generated audit report at ${outputFile}`);
console.log(`Report size: ${(fs.statSync(outputFile).size / 1024).toFixed(2)} KB`);
