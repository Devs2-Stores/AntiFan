import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { IndependentHtmlCloneGenerator } from '../packages/site-clone/dist/generators/independent-html-clone-generator.js';
import { AssetHarvester } from '../packages/site-clone/dist/models/asset-harvester.js';
import { AssetLocalizer } from '../packages/site-clone/dist/models/asset-localizer.js';

const outDir = path.resolve('clone/hoplongtech');
const cssDir = path.join(outDir, 'css');
const jsDir = path.join(outDir, 'js');
const assetsDir = path.join(outDir, 'assets');
const mobileDir = path.join(outDir, 'mobile');

fs.mkdirSync(cssDir, { recursive: true });
fs.mkdirSync(jsDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(mobileDir, { recursive: true });

function normalizeUrl(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
}

function verifyCaptureReceipt(rawPath, expected) {
  const receiptPath = `${rawPath}.capture.json`;
  if (!fs.existsSync(rawPath)) {
    return { valid: false, reason: `Raw file missing: ${rawPath}` };
  }
  if (!fs.existsSync(receiptPath)) {
    return { valid: false, reason: `Capture receipt missing: ${receiptPath}` };
  }

  let receipt;
  try {
    const rawJson = fs.readFileSync(receiptPath, 'utf8');
    receipt = JSON.parse(rawJson);
  } catch (err) {
    return { valid: false, reason: `Failed to parse capture receipt: ${err.message}` };
  }

  if (receipt.schemaVersion !== 1) {
    return { valid: false, reason: `Unsupported schemaVersion: ${receipt.schemaVersion}` };
  }
  if (normalizeUrl(receipt.url) !== normalizeUrl(expected.url)) {
    return { valid: false, reason: `URL mismatch: receipt has "${receipt.url}", expected "${expected.url}"` };
  }
  if (receipt.device !== expected.device) {
    return { valid: false, reason: `Device mismatch: receipt has "${receipt.device}", expected "${expected.device}"` };
  }
  if (receipt.width !== expected.width) {
    return { valid: false, reason: `Width mismatch: receipt has ${receipt.width}, expected ${expected.width}` };
  }
  if (receipt.height !== expected.height) {
    return { valid: false, reason: `Height mismatch: receipt has ${receipt.height}, expected ${expected.height}` };
  }
  if (!receipt.capturedAt || isNaN(Date.parse(receipt.capturedAt))) {
    return { valid: false, reason: `Invalid or missing capturedAt timestamp in receipt: ${receipt.capturedAt}` };
  }
  if (!receipt.metrics || typeof receipt.metrics !== 'object' || typeof receipt.metrics.totalHeight !== 'number' || receipt.metrics.totalHeight <= 0) {
    return { valid: false, reason: 'Invalid or missing metrics.totalHeight in capture receipt' };
  }
  if (!receipt.settlement || receipt.settlement.passed !== true) {
    return { valid: false, reason: `Settlement not passed: ${receipt.settlement?.reason || 'unspecified'}` };
  }

  const content = fs.readFileSync(rawPath, 'utf8');
  const actualSha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  if (actualSha256 !== receipt.sha256) {
    return { valid: false, reason: `SHA256 checksum mismatch: actual ${actualSha256} vs receipt ${receipt.sha256}` };
  }

  return { valid: true, receipt, content };
}

function loadOrMaterializeSurface({
  targetUrl,
  rawPath,
  device,
  expectedWidth,
  expectedHeight,
  forceRefresh = false
}) {
  const expected = {
    url: targetUrl,
    device,
    width: expectedWidth,
    height: expectedHeight
  };

  let verification = forceRefresh
    ? { valid: false, reason: 'Explicit --refresh requested' }
    : verifyCaptureReceipt(rawPath, expected);

  if (!verification.valid) {
    console.log(`  Cache invalid or missing (${verification.reason}). Executing Core headless ${device} materialization worker...`);
    const result = spawnSync(process.execPath, [
      'scripts/run-electron.cjs',
      'scripts/materialize-surface.cjs'
    ], {
      stdio: 'inherit',
      env: {
        ...process.env,
        MATERIALIZE_TARGET_URL: targetUrl,
        MATERIALIZE_OUTPUT_PATH: rawPath,
        MATERIALIZE_DEVICE: device
      }
    });

    if (result.error) {
      throw new Error(`[Asset Core] Materialization worker failed to launch: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`[Asset Core] Materialization worker exited with failure status ${result.status} (signal: ${result.signal || 'none'})`);
    }

    // Read receipt again and verify freshness
    verification = verifyCaptureReceipt(rawPath, expected);
    if (!verification.valid) {
      throw new Error(`[Asset Core] Materialization completed but receipt verification failed: ${verification.reason}`);
    }
  } else {
    console.log(`  ✓ Valid capture receipt verified for ${device} (sha256: ${verification.receipt.sha256.slice(0, 8)}..., captured: ${verification.receipt.capturedAt})`);
  }

  return {
    content: verification.content,
    receipt: verification.receipt
  };
}

async function run() {
  console.log('===========================================================');
  console.log('[AntiFan Asset Core] Initializing Dual-Surface Localization Pipeline...');
  console.log('===========================================================');

  // 1. Download and localize all 4 required CSS stylesheets
  console.log('[Asset Core] 1/5: Downloading and localizing CSS stylesheets...');
  const stylesheetMap = {
    'app.css': 'https://hoplongtech.com/build/assets/app-DCc2d3nB.css',
    'home.css': 'https://hoplongtech.com/build/assets/home-CW7DK4JA.css',
    'mobile.css': 'https://hoplongtech.com/build/assets/app-5WA_Jy_a.css',
    'mobile-home.css': 'https://hoplongtech.com/build/assets/home-1Bp5Y6OY.css',
    'slick.css': 'https://hoplongtech.com/build/assets/slick-DLkP75TQ.css'
  };

  for (const [filename, url] of Object.entries(stylesheetMap)) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        let cssText = await res.text();
        cssText = cssText.replace(/url\(["']?(?:\/build\/assets\/|\/assets\/|https:\/\/hoplongtech\.com\/build\/assets\/)/g, 'url(../assets/');
        fs.writeFileSync(path.join(cssDir, filename), cssText, 'utf8');
        fs.writeFileSync(path.join(assetsDir, filename), cssText, 'utf8');
        console.log(`  ✓ Saved ${filename} to css/ and assets/ (${cssText.length} bytes)`);
      }
    } catch (e) {
      console.warn(`  ⚠ Warning: Could not fetch ${url}:`, e.message);
    }
  }

  const scriptMap = {
    'slide.js': 'https://hoplongtech.com/build/assets/slide-B2PwPmCC.js'
  };
  for (const [filename, url] of Object.entries(scriptMap)) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const jsText = await res.text();
        fs.writeFileSync(path.join(assetsDir, filename), jsText, 'utf8');
        const jsDir = path.join(outDir, 'js');
        if (!fs.existsSync(jsDir)) fs.mkdirSync(jsDir, { recursive: true });
        fs.writeFileSync(path.join(jsDir, filename), jsText, 'utf8');
        console.log(`  ✓ Saved ${filename} to assets/ and js/ (${jsText.length} bytes)`);
      }
    } catch (e) {
      console.warn(`  ⚠ Warning: Could not fetch ${url}:`, e.message);
    }
  }

  const isRefresh = process.argv.includes('--refresh') || process.env.REFRESH === '1';
  if (isRefresh) {
    console.log('[Asset Core] --refresh flag detected: forcing recapture of all surfaces.');
  }
  const targetUrl = 'https://hoplongtech.com/';

  // 2. Load & Materialize Desktop Surface (via Core Dual-Surface Materializer)
  console.log('\n[Asset Core] 2/5: Loading Materialized Desktop Surface DOM...');
  const rawDesktopPath = path.join(outDir, 'raw-desktop.html');
  const desktopCapture = loadOrMaterializeSurface({
    targetUrl,
    rawPath: rawDesktopPath,
    device: 'desktop',
    expectedWidth: 1440,
    expectedHeight: 900,
    forceRefresh: isRefresh
  });
  let desktopHtml = desktopCapture.content;
  console.log(`  ✓ Loaded materialized desktop DOM (${desktopHtml.length} bytes, sha256: ${desktopCapture.receipt.sha256.slice(0, 8)}..., ${desktopCapture.receipt.metrics?.skeletonsRemaining ?? 0} skeletons remaining)`);

  // 3. Load & Materialize Mobile Surface (via Core Dual-Surface Materializer)
  console.log('\n[Asset Core] 3/5: Loading Materialized Mobile Surface DOM...');
  const rawMobilePath = path.join(outDir, 'raw-mobile.html');
  const mobileCapture = loadOrMaterializeSurface({
    targetUrl,
    rawPath: rawMobilePath,
    device: 'mobile',
    expectedWidth: 390,
    expectedHeight: 844,
    forceRefresh: isRefresh
  });
  let mobileHtml = mobileCapture.content;
  console.log(`  ✓ Loaded materialized mobile DOM (${mobileHtml.length} bytes, sha256: ${mobileCapture.receipt.sha256.slice(0, 8)}..., ${mobileCapture.receipt.metrics?.skeletonsRemaining ?? 0} skeletons remaining)`);
  // Link local CSS in Desktop
  desktopHtml = desktopHtml.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, '');
  const desktopHeadLink = `
    <link rel="stylesheet" href="/css/app.css">
    <link rel="stylesheet" href="/css/home.css">
  `;
  desktopHtml = desktopHtml.replace(/<\/head>/i, `${desktopHeadLink}\n</head>`);
  desktopHtml = desktopHtml.replace(/(<div class="s-content"[^>]*style=")[^"]*"/gi, '$1transform: translateX(0px);"');
  if (!desktopHtml.includes('slide.js')) {
    desktopHtml = desktopHtml.replace(/<\/body>/i, '<script defer src="/assets/slide.js"></script>\n</body>');
  }

  // Link local CSS in Mobile (base, mobile, mobile-home, slick)
  mobileHtml = mobileHtml.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, '');
  const mobileHeadLink = `
    <link rel="stylesheet" href="/css/app.css">
    <link rel="stylesheet" href="/css/mobile.css">
    <link rel="stylesheet" href="/css/mobile-home.css">
    <link rel="stylesheet" href="/css/slick.css">
  `;
  mobileHtml = mobileHtml.replace(/<\/head>/i, `${mobileHeadLink}\n</head>`);
  if (!mobileHtml.includes('slide.js')) {
    mobileHtml = mobileHtml.replace(/<\/body>/i, '<script defer src="/assets/slide.js"></script>\n</body>');
  }
  // 4. Run Asset Core Localization (AssetHarvester + AssetLocalizer)
  console.log('\n[Asset Core] 4/5: Harvesting & Localizing All Remote Subresources (Images/Fonts)...');
  const harvester = new AssetHarvester();
  const dManifest = harvester.harvestFromHtml(desktopHtml, assetsDir);
  const mManifest = harvester.harvestFromHtml(mobileHtml, assetsDir);

  const combinedImages = [...dManifest.images];
  for (const img of mManifest.images) {
    if (!combinedImages.some(i => i.sourceUrl === img.sourceUrl)) {
      combinedImages.push(img);
    }
  }
  console.log(`  Harvested ${combinedImages.length} unique images across Desktop and Mobile surfaces.`);

  const localizer = new AssetLocalizer();
  console.log('  Executing hardened download with SSRF guard and 10 workers...');
  const downloadResult = await localizer.downloadAssets(combinedImages, {
    assetsDir,
    concurrency: 10,
    timeoutMs: 15000
  });
  console.log(`  ✓ Asset Download complete: ${downloadResult.downloaded.length} assets (${(downloadResult.totalBytes / (1024 * 1024)).toFixed(2)} MB), ${downloadResult.failedCount} failures.`);

  // Rewrite all image URLs in Desktop HTML
  console.log('  Rewriting Desktop HTML image references to local assets/...');
  const dRewriteResult = localizer.rewriteFiles([{ path: 'index.html', content: desktopHtml }], dManifest, { mode: 'relative' });
  desktopHtml = dRewriteResult.files[0].rewrittenContent;
  console.log(`  ✓ Desktop: ${dRewriteResult.totalReplacements} image references rewritten.`);

  // Rewrite all image URLs in Mobile HTML
  console.log('  Rewriting Mobile HTML image references to local /assets/...');
  const mRewriteResult = localizer.rewriteFiles([{ path: 'mobile/index.html', content: mobileHtml }], mManifest, { mode: 'relative' });
  // For mobile served at /mobile or root, ensure /assets/... prefix
  mobileHtml = mRewriteResult.files[0].rewrittenContent.replace(/(src|data-src|srcset)=["']assets\//g, '$1="/assets/');
  console.log(`  ✓ Mobile: ${mRewriteResult.totalReplacements} image references rewritten.`);

  // 5. Clean Livewire/SSR debris and inject Parity CSS + Interactivity via Core Generator
  console.log('\n[Asset Core] 5/5: Running IndependentHtmlCloneGenerator (Sanitization & Parity Injections)...');
  const generator = new IndependentHtmlCloneGenerator();

  const desktopResult = generator.generateFromMaterializedHtml(desktopHtml, {
    outputDir: outDir,
    entryFilename: 'index.html',
    device: 'web',
    sourceBaseUrl: targetUrl
  });
  console.log('  ✓ Desktop Surface finalized:', {
    path: desktopResult.outputPath,
    size: desktopResult.html.length
  });

  const mobileResult = generator.generateFromMaterializedHtml(mobileHtml, {
    outputDir: outDir,
    entryFilename: 'mobile/index.html',
    device: 'mobile',
    sourceBaseUrl: targetUrl
  });
  console.log('  ✓ Mobile Surface finalized:', {
    path: mobileResult.outputPath,
    size: mobileResult.html.length
  });

  console.log('\n===========================================================');
  console.log('[AntiFan Asset Core] Pipeline Complete! Standalone & Offline Ready.');
  console.log('===========================================================');
}

run().catch(err => {
  console.error('[Asset Core] Pipeline failed:', err);
  process.exit(1);
});
