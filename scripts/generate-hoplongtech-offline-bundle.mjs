import * as fs from 'node:fs';
import * as path from 'node:path';
import { BlueprintExtractor } from '../packages/site-clone/dist/models/blueprint-extractor.js';
import { AssetHarvester } from '../packages/site-clone/dist/models/asset-harvester.js';
import { IndependentHtmlCloneGenerator } from '../packages/site-clone/dist/generators/independent-html-clone-generator.js';

function mapBlueprintTypeToArchetype(type) {
  switch (type) {
    case 'header':
      return 'header';
    case 'footer':
      return 'footer';
    case 'hero-slider':
    case 'hero_slider':
    case 'slider':
      return 'hero_slider';
    case 'featured-products':
    case 'product_grid':
    case 'products':
      return 'product_grid';
    case 'category-grid':
    case 'collection_list':
    case 'categories':
      return 'collection_list';
    case 'partner-carousel':
    case 'banner_grid':
    case 'banners':
      return 'banner_grid';
    case 'news':
    case 'article':
    case 'rich_text':
      return 'rich_text';
    case 'quote-form':
    case 'accessory-showcase':
    case 'custom-content':
    default:
      return 'custom_section';
  }
}

async function main() {
  const hoplongRawHtml = fs.readFileSync('clone/hoplongtech/index.html', 'utf-8');
  const extractor = new BlueprintExtractor();
  const blueprints = extractor.extractSections(hoplongRawHtml);

  console.log(`[Canary] Extracted ${blueprints.length} section blueprints from clone/hoplongtech/index.html`);

  const harvester = new AssetHarvester();
  const tempAssetsDir = path.resolve('clone/hoplongtech-offline/assets');
  const harvestedManifest = harvester.harvestFromHtml(hoplongRawHtml, tempAssetsDir);

  // Preserve original absolute source URLs for stylesheets so recursive font URL resolution succeeds
  const appCssItem = harvestedManifest.stylesheets.find(s => s.filename.includes('app.css'));
  if (appCssItem) {
    appCssItem.sourceUrl = 'https://hoplongtech.com/build/assets/app.css';
    appCssItem.localPath = path.resolve('clone/hoplongtech/css/app.css');
  }
  const homeCssItem = harvestedManifest.stylesheets.find(s => s.filename.includes('home.css'));
  if (homeCssItem) {
    homeCssItem.sourceUrl = 'https://hoplongtech.com/css/home.css';
    homeCssItem.localPath = path.resolve('clone/hoplongtech/css/home.css');
  }

  // Handle local synthetic js/main.js explicitly: retain single local script item
  const mainJsItem = harvestedManifest.javascripts.find(s => s.sourceUrl === 'js/main.js' || s.filename === 'main.js');
  if (mainJsItem) {
    mainJsItem.sourceUrl = 'js/main.js';
    mainJsItem.filename = 'main.js';
    mainJsItem.localPath = path.resolve('clone/hoplongtech/js/main.js');
    harvestedManifest.javascripts = [mainJsItem];
  } else {
    harvestedManifest.javascripts = [{
      type: 'javascript',
      sourceUrl: 'js/main.js',
      filename: 'main.js',
      localPath: path.resolve('clone/hoplongtech/js/main.js')
    }];
  }

  // Map blueprints accurately into ComponentContractIR sections using blueprint type
  const irSections = blueprints.map(b => {
    const archetype = mapBlueprintTypeToArchetype(b.type);
    const settings = {};
    if (Array.isArray(b.schemaSettings)) {
      for (const s of b.schemaSettings) {
        if (s.id) settings[s.id] = s.default ?? '';
      }
    }
    return {
      id: b.id,
      name: b.name || b.id,
      archetype,
      layoutType: b.type === 'product_grid' ? 'grid' : (b.type === 'slider' ? 'scroll_snap_carousel' : 'flow'),
      heading: b.heading,
      className: b.className,
      settings,
      blocks: (b.blockInstances || []).map(bi => ({
        id: bi.id,
        type: bi.type,
        settings: bi.settings || {}
      })),
      rawHtml: b.rawHtml,
      liquidTemplate: b.liquidTemplate || b.rawHtml
    };
  });

  // Extract authentic normalized data via EcommerceDataModeler
  const { EcommerceDataModeler } = await import('../packages/site-clone/dist/models/ecommerce-data-modeler.js');
  const modeler = new EcommerceDataModeler();
  const extractedData = modeler.extractStorefrontData(hoplongRawHtml);
  const authenticProducts = extractedData.products.slice(0, 12);
  const authenticArticles = extractedData.articles.slice(0, 6);
  const mockIR = {
    version: '1.2.0',
    metadata: {
      sourceUrl: 'https://hoplongtech.com',
      extractedAt: new Date().toISOString(),
      engineVersion: '1.0.0-recon'
    },
    layout: {
      containerMaxWidth: 1440,
      containerPaddingPx: 15,
      gridGapPx: 20,
      breakpoints: { mobileMax: 767, tabletMin: 768, tabletMax: 1024, desktopMin: 1025 }
    },
    storefrontRuntime: { controllers: [] },
    sections: irSections,
    normalizedData: {
      products: authenticProducts,
      articles: authenticArticles,
      siteSettings: {
        title: 'Hoplongtech.com | Công ty Cổ phần Công nghệ Hợp Long'
      }
    },
    assets: harvestedManifest
  };

  const generator = new IndependentHtmlCloneGenerator();
  const outDir = path.resolve('clone/hoplongtech-offline');
  const res = await generator.generateCloneBundle(mockIR, {
    outputDir: outDir,
    sourceBaseUrl: 'https://hoplongtech.com',
    maxProducts: 12,
    maxArticles: 6,
    skipDownload: false
  });

  console.log('[Canary] Bundle generated successfully:', {
    success: res.success,
    productCount: res.productCount,
    articleCount: res.articleCount,
    filesCount: res.filesWritten.length
  });

  // Verify manifest representative data and section archetypes
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf-8'));
  console.log('[Canary] Manifest Verification:', {
    representativeData: manifest.representativeData,
    sections: manifest.sections
  });
}

main().catch(err => {
  console.error('[Canary] Pipeline error:', err);
  process.exit(1);
});
