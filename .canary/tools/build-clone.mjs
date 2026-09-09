/**
 * Canary pipeline runner (production code path, no hacks):
 *   reference HTML
 *     -> BlueprintExtractor (section blueprints)
 *     -> EcommerceDataModeler (normalized storefront data)
 *     -> AssetHarvester (A0 discovery manifest)
 *     -> IndependentHtmlCloneGenerator (A1 download / A2 rewrite / A3 audit + bundle)
 *
 * Usage: node .canary/tools/build-clone.mjs <referenceHtml> <outDir> <telemetryJson> [maxProducts] [maxArticles]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { BlueprintExtractor } from '../../packages/site-clone/dist/models/blueprint-extractor.js';
import { EcommerceDataModeler } from '../../packages/site-clone/dist/models/ecommerce-data-modeler.js';
import { CloneIRBuilder } from '../../packages/site-clone/dist/models/clone-ir-builder.js';
import { IndependentHtmlCloneGenerator } from '../../packages/site-clone/dist/generators/independent-html-clone-generator.js';

const [, , refHtmlPath, outDirArg, telemetryPath, maxProductsArg, maxArticlesArg] = process.argv;
if (!refHtmlPath || !outDirArg || !telemetryPath) {
  console.error('usage: build-clone.mjs <referenceHtml> <outDir> <telemetryJson> [maxProducts] [maxArticles]');
  process.exit(2);
}
const outDir = path.resolve(outDirArg);
const maxProducts = maxProductsArg ? Number(maxProductsArg) : undefined;
const maxArticles = maxArticlesArg ? Number(maxArticlesArg) : undefined;

const html = fs.readFileSync(refHtmlPath, 'utf8');
const telemetry = { input: { path: path.resolve(refHtmlPath), bytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex') } };

// ── Section blueprints ────────────────────────────────────────────────────────
const extractor = new BlueprintExtractor();
const blueprints = extractor.extractSections(html);
telemetry.blueprints = blueprints.map((b) => ({
  id: b.id, type: b.type, name: b.name, className: b.className,
  rawHtmlBytes: Buffer.byteLength(b.rawHtml || ''),
  heading: b.heading || null,
}));

// ── Normalized ecommerce data ────────────────────────────────────────────────
const modeler = new EcommerceDataModeler();
const data = modeler.extractStorefrontData(html);
telemetry.normalizedData = {
  products: (data.products || []).length,
  categories: (data.categories || []).length,
  articles: (data.articles || []).length,
  siteTitle: data.siteSettings && data.siteSettings.title,
};

// ── A0 asset discovery + production IR (single composed path) ────────────────
const a0Dir = path.join(outDir, '..', 'a0-assets');
const ir = new CloneIRBuilder().buildFromHtml(html, 'https://hoplongtech.com', a0Dir);
const manifest = ir.assets;
telemetry.a0 = {
  assetsDir: a0Dir,
  stylesheets: manifest.stylesheets.length,
  javascripts: manifest.javascripts.length,
  images: manifest.images.length,
  fonts: manifest.fonts.length,
  total: manifest.stylesheets.length + manifest.javascripts.length + manifest.images.length + manifest.fonts.length,
  stylesheetUrls: manifest.stylesheets.map((s) => s.sourceUrl),
  fontUrls: manifest.fonts.map((s) => s.sourceUrl),
  scriptUrls: manifest.javascripts.map((s) => s.sourceUrl),
  imageSample: manifest.images.slice(0, 10).map((s) => s.sourceUrl),
  imageHosts: Object.entries(manifest.images.reduce((acc, i) => { try { const h = new URL(i.sourceUrl, 'https://hoplongtech.com').host; acc[h] = (acc[h] || 0) + 1; } catch {} return acc; }, {})),
  unresolvedRelative: manifest.images.filter((i) => !/^(https?:)?\/\//i.test(i.sourceUrl)).length,
  byArchetype: ir.sections.reduce((acc, s) => { acc[s.archetype] = (acc[s.archetype] || 0) + 1; return acc; }, {}),
};
telemetry.irSections = ir.sections.map((s) => ({
  id: s.id, name: s.name, archetype: s.archetype, layoutType: s.layoutType, className: s.className,
  rawHtmlBytes: Buffer.byteLength(s.rawHtml || ''), blockCount: (s.blocks || []).length,
}));


// ── Independent HTML clone bundle (runs A1 -> A2 -> A3 internally, fail-closed)
const generator = new IndependentHtmlCloneGenerator();
const t0 = Date.now();
let result = null;
let error = null;
try {
  result = await generator.generateCloneBundle(ir, {
    outputDir: outDir,
    sourceBaseUrl: 'https://hoplongtech.com',
    maxProducts,
    maxArticles,
    skipDownload: false,
  });
} catch (e) {
  error = { message: String(e && e.message), stack: String(e && e.stack).slice(0, 4000) };
}
telemetry.generation = {
  elapsedMs: Date.now() - t0,
  result,
  error,
};

if (result && result.success) {
  const entry = fs.readFileSync(result.entryHtmlPath, 'utf8');
  const assetsDir = path.join(outDir, 'assets');
  const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  telemetry.bundle = {
    entryHtmlPath: result.entryHtmlPath,
    entryBytes: Buffer.byteLength(entry),
    entrySha256: createHash('sha256').update(entry).digest('hex'),
    assetFiles: files.length,
    assetBytes: files.reduce((a, f) => a + fs.statSync(path.join(assetsDir, f)).size, 0),
    assetNames: files,
    productCount: result.productCount,
    articleCount: result.articleCount,
  };
  // Residual remote references in the generated entry HTML, split by role:
  // subresources (src/srcset/poster/data-src + <link href>) must be zero;
  // <a href> navigation is expected to point at the live site.
  const remoteSubresources = [];
  const remoteNavigation = [];
  const subRe = /\s(?:src|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const srcsetRe = /\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const linkRe = /<link[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const aRe = /<a[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const collect = (re, sink) => {
    let m;
    while ((m = re.exec(entry)) !== null) {
      const v = ((m[1] !== undefined ? m[1] : m[2]) || '').trim();
      if (/^(https?:)?\/\//i.test(v)) sink.push(v);
    }
  };
  collect(subRe, remoteSubresources);
  collect(linkRe, remoteSubresources);
  collect(aRe, remoteNavigation);
  let sm;
  while ((sm = srcsetRe.exec(entry)) !== null) {
    const v = (sm[1] !== undefined ? sm[1] : sm[2]) || '';
    v.split(',').forEach((part) => {
      const u = part.trim().split(/\s+/)[0];
      if (/^(https?:)?\/\//i.test(u)) remoteSubresources.push(u);
    });
  }
  telemetry.bundle.remoteSubresources = Array.from(new Set(remoteSubresources));
  telemetry.bundle.remoteNavigationCount = remoteNavigation.length;
  telemetry.bundle.remoteNavigationSample = Array.from(new Set(remoteNavigation)).slice(0, 10);
}

// ── On-disk asset integrity (sha256 / decode sanity / zero-byte) ─────────────
if (result && result.success) {
  const assetsDir = path.join(outDir, 'assets');
  if (fs.existsSync(assetsDir)) {
    telemetry.assetIntegrity = fs.readdirSync(assetsDir).map((f) => {
      const p = path.join(assetsDir, f);
      const buf = fs.readFileSync(p);
      const ext = path.extname(f).toLowerCase();
      const magic = buf.subarray(0, 12).toString('hex');
      let decoded = null;
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'].includes(ext)) {
        decoded = buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 ? { format: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
          : (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 ? { format: 'jpeg', w: null, h: null } : { format: 'other', w: null, h: null });
      }
      return { file: f, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), magic, decoded };
    });
  }
}

fs.mkdirSync(path.dirname(path.resolve(telemetryPath)), { recursive: true });
fs.writeFileSync(telemetryPath, JSON.stringify(telemetry, null, 2));
console.log(JSON.stringify({
  ok: !error,
  error,
  blueprints: telemetry.blueprints.length,
  a0: { stylesheets: telemetry.a0.stylesheets, javascripts: telemetry.a0.javascripts, images: telemetry.a0.images, fonts: telemetry.a0.fonts, total: telemetry.a0.total },
  normalized: telemetry.normalizedData,
  bundle: telemetry.bundle ? { assetFiles: telemetry.bundle.assetFiles, assetBytes: telemetry.bundle.assetBytes, productCount: telemetry.bundle.productCount, remoteSubresources: telemetry.bundle.remoteSubresources.length, remoteNavigation: telemetry.bundle.remoteNavigationCount } : null,
}, null, 2));
