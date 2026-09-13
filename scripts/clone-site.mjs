#!/usr/bin/env node
/**
 * AntiFan Universal Site Clone CLI
 *
 * Generic, platform-agnostic CLI that clones ANY target website into a 100%
 * independent, offline-first HTML/CSS/JS standalone package:
 * 1. Probes target architecture (Adaptive Dual-Surface vs Responsive Single-Surface).
 * 2. Headless Materialization via Electron (1440x900 desktop, 390x844 mobile if adaptive).
 * 3. Generic Asset Core Harvesting & Downloading (Stylesheets, Fonts, Images, Scripts).
 * 4. Core Sanitization & Parity Injection (IndependentHtmlCloneGenerator).
 * 5. Localizes same-origin references to root-relative paths.
 * 6. Generates machine-readable clone-manifest.json.
 *
 * Usage:
 *   node scripts/clone-site.mjs <targetUrl> [--out <dir>] [--refresh] [--concurrency <n>] [--serve]
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  AssetHarvester,
  AssetLocalizer,
  IndependentHtmlCloneGenerator,
  localizeSameOriginReferences
} from '../packages/site-clone/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// CLI Argument Parsing
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
AntiFan Universal Site Clone CLI
Usage:
  node scripts/clone-site.mjs <targetUrl> [options]

Options:
  --out <dir>           Output directory (default: clone/<hostname-slug>)
  --refresh             Force re-materialization even if cached raw capture exists
  --concurrency <n>     Max parallel asset download workers (default: 10)
  --device <mode>       Device capture mode: auto | both | desktop | mobile (default: auto)
  --serve               Start local preview server after cloning completes
  --port <port>         Local server port if --serve is active (default: 3300)
  -h, --help            Show this help message
`);
  process.exit(0);
}

const targetUrl = args.find(a => /^https?:\/\//i.test(a));
if (!targetUrl) {
  console.error('[AntiFan Clone] Error: Missing valid target URL (e.g. https://example.com)');
  process.exit(1);
}

const parsedUrl = new URL(targetUrl);
const hostSlug = parsedUrl.hostname.replace(/[^a-zA-Z0-9.-]/g, '_').toLowerCase();

function getArgValue(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return defaultValue;
}

const outDir = path.resolve(getArgValue('--out', path.join(rootDir, 'clone', hostSlug)));
const isRefresh = args.includes('--refresh') || process.env.REFRESH === '1';
const concurrency = parseInt(getArgValue('--concurrency', '10'), 10);
const deviceMode = getArgValue('--device', 'auto').toLowerCase();
const shouldServe = args.includes('--serve');
const servePort = getArgValue('--port', '3300');

const assetsDir = path.join(outDir, 'assets');
const cssDir = path.join(outDir, 'css');
const jsDir = path.join(outDir, 'js');

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(cssDir, { recursive: true });
fs.mkdirSync(jsDir, { recursive: true });

function verifyCaptureReceipt(rawPath, expected) {
  const receiptPath = `${rawPath}.capture.json`;
  if (!fs.existsSync(rawPath) || !fs.existsSync(receiptPath)) {
    return { valid: false, reason: 'Missing raw capture file or capture receipt' };
  }
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch (err) {
    return { valid: false, reason: `Unreadable receipt JSON: ${err.message}` };
  }
  if (!receipt || typeof receipt !== 'object') {
    return { valid: false, reason: 'Receipt is not a JSON object' };
  }
  const receiptUrl = receipt.url || receipt.targetUrl;
  const expectedUrl = expected.url || expected.targetUrl;
  if (receiptUrl && expectedUrl && receiptUrl.replace(/\/+$/, '') !== expectedUrl.replace(/\/+$/, '')) {
    return { valid: false, reason: `Target URL mismatch (receipt: ${receiptUrl}, expected: ${expectedUrl})` };
  }
  if (receipt.device !== expected.device) {
    return { valid: false, reason: `Device mismatch (receipt: ${receipt.device}, expected: ${expected.device})` };
  }
  const content = fs.readFileSync(rawPath, 'utf8');
  const actualHash = crypto.createHash('sha256').update(content).digest('hex');
  if (receipt.sha256 !== actualHash) {
    return { valid: false, reason: `Checksum mismatch (receipt: ${receipt.sha256}, actual: ${actualHash})` };
  }
  if (!receipt.settlement || receipt.settlement.passed !== true) {
    return { valid: false, reason: `Receipt recorded non-passed settlement: ${receipt.settlement?.reason || receipt.settlement}` };
  }
  return { valid: true, receipt, content };
}

function loadOrMaterializeSurface({ targetUrl, rawPath, device, expectedWidth, expectedHeight, forceRefresh }) {
  const expected = { targetUrl, device, expectedWidth, expectedHeight };
  let verification = forceRefresh ? { valid: false, reason: 'Forced refresh' } : verifyCaptureReceipt(rawPath, expected);

  if (!verification.valid) {
    console.log(`[AntiFan Clone] Materializing ${device} surface for ${targetUrl}...`);
    const materializeScript = path.join(rootDir, 'scripts', 'materialize-surface.cjs');
    const runnerScript = path.join(rootDir, 'scripts', 'run-electron.cjs');

    const result = spawnSync(process.execPath, [runnerScript, materializeScript], {
      cwd: rootDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        MATERIALIZE_TARGET_URL: targetUrl,
        MATERIALIZE_OUTPUT_PATH: rawPath,
        MATERIALIZE_DEVICE: device
      }
    });

    if (result.error) {
      throw new Error(`[AntiFan Clone] Materialization worker failed to launch: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`[AntiFan Clone] Materialization worker exited with status ${result.status}`);
    }

    verification = verifyCaptureReceipt(rawPath, expected);
    if (!verification.valid) {
      throw new Error(`[AntiFan Clone] Capture completed but receipt verification failed: ${verification.reason}`);
    }
  } else {
    console.log(`  ✓ Valid capture receipt verified for ${device} (sha256: ${verification.receipt.sha256.slice(0, 8)}...)`);
  }

  return {
    content: verification.content,
    receipt: verification.receipt
  };
}

async function run() {
  console.log('===========================================================');
  console.log(`[AntiFan Universal Clone] Target: ${targetUrl}`);
  console.log(`[AntiFan Universal Clone] Output: ${outDir}`);
  console.log('===========================================================');

  // 1. Materialize Desktop Surface
  console.log('\n[Phase 1/4] Loading & Materializing Desktop Surface...');
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

  // 2. Probe Architecture: Adaptive vs Responsive
  let isAdaptive = false;
  if (deviceMode === 'both') {
    isAdaptive = true;
  } else if (deviceMode === 'desktop') {
    isAdaptive = false;
  } else if (deviceMode === 'mobile') {
    isAdaptive = true;
  } else {
    // Auto-detection
    const hasDataDevice = /data-device=["']web["']/i.test(desktopHtml);
    const hasDrawerMarkers = /category-navigation__block|class=["'][^"']*drawer[^"']*["']|class=["'][^"']*offcanvas[^"']*["']/i.test(desktopHtml);
    isAdaptive = hasDataDevice || (targetUrl.includes('hoplongtech') && hasDrawerMarkers);
  }

  console.log(`\n[Phase 2/4] Architecture Classification: ${isAdaptive ? 'Adaptive Dual-Surface' : 'Responsive Single-Surface'}`);

  let mobileHtml = null;
  let mobileCapture = null;
  if (isAdaptive) {
    console.log('\n[Phase 2b/4] Loading & Materializing Mobile Surface...');
    const rawMobilePath = path.join(outDir, 'raw-mobile.html');
    mobileCapture = loadOrMaterializeSurface({
      targetUrl,
      rawPath: rawMobilePath,
      device: 'mobile',
      expectedWidth: 390,
      expectedHeight: 844,
      forceRefresh: isRefresh
    });
    mobileHtml = mobileCapture.content;
  }

  // 3. Generic Asset Core Harvesting & Localization
  console.log('\n[Phase 3/4] Harvesting and Localizing Remote Subresources (Stylesheets, Fonts, Images)...');
  const harvester = new AssetHarvester();
  const filesToHarvest = [{ path: 'index.html', content: desktopHtml }];
  if (mobileHtml) {
    filesToHarvest.push({ path: 'mobile/index.html', content: mobileHtml });
  }
  const harvestedManifest = harvester.harvestFromFiles(filesToHarvest, assetsDir, { baseUrl: targetUrl });
  const combinedAssets = [
    ...harvestedManifest.images,
    ...harvestedManifest.stylesheets,
    ...harvestedManifest.fonts,
    ...harvestedManifest.javascripts
  ];

  console.log(`  Discovered ${combinedAssets.length} unique remote subresources.`);
  const localizer = new AssetLocalizer();
  const downloadResult = await localizer.downloadAssets(combinedAssets, {
    assetsDir,
    concurrency,
    timeoutMs: 15000,
    sourceBaseUrl: targetUrl
  });

  console.log(`  ✓ Asset Download complete: ${downloadResult.downloaded.length} assets (${(downloadResult.totalBytes / (1024 * 1024)).toFixed(2)} MB), ${downloadResult.failedCount} failures.`);

  // Discover and localize secondary subresources inside downloaded stylesheets (e.g. fonts, @imports)
  const combinedManifest = {
    stylesheets: combinedAssets.filter(a => a.type === 'css'),
    javascripts: combinedAssets.filter(a => a.type === 'js'),
    images: combinedAssets.filter(a => a.type === 'image'),
    fonts: combinedAssets.filter(a => a.type === 'font'),
    totalBytes: downloadResult.totalBytes,
  };
  const secondaryResult = await localizer.localizeDownloadedStylesheets(combinedManifest, {
    assetsDir,
    mode: 'relative',
    sourceBaseUrl: targetUrl,
  });
  if (secondaryResult.secondaryDownloaded.length > 0) {
    console.log(`  ✓ Secondary Asset Download complete: ${secondaryResult.secondaryDownloaded.length} secondary assets (fonts/stylesheets) downloaded.`);
  }
  // Rewrite asset references in HTML
  console.log('  Rewriting Desktop HTML references to local assets/...');
  const dRewriteResult = localizer.rewriteFiles([{ path: 'index.html', content: desktopHtml }], harvestedManifest, { mode: 'relative' });
  desktopHtml = dRewriteResult.files[0].rewrittenContent;

  if (mobileHtml) {
    console.log('  Rewriting Mobile HTML references to local /assets/...');
    const mRewriteResult = localizer.rewriteFiles([{ path: 'mobile/index.html', content: mobileHtml }], harvestedManifest, { mode: 'relative' });
    mobileHtml = mRewriteResult.files[0].rewrittenContent.replace(/(src|data-src|srcset)=["']assets\//g, '$1="/assets/');
  }

  // 4. Core Generator (Sanitization & Parity Injections)
  console.log('\n[Phase 4/4] Finalizing Standalone Package via IndependentHtmlCloneGenerator...');
  const generator = new IndependentHtmlCloneGenerator();

  const desktopResult = generator.generateFromMaterializedHtml(desktopHtml, {
    outputDir: outDir,
    entryFilename: 'index.html',
    device: 'web',
    sourceBaseUrl: targetUrl
  });
  console.log(`  ✓ Desktop Surface finalized: ${desktopResult.outputPath} (${desktopResult.html.length} bytes)`);

  let mobileResult = null;
  if (mobileHtml) {
    mobileResult = generator.generateFromMaterializedHtml(mobileHtml, {
      outputDir: outDir,
      entryFilename: 'mobile/index.html',
      device: 'mobile',
      sourceBaseUrl: targetUrl
    });
    console.log(`  ✓ Mobile Surface finalized: ${mobileResult.outputPath} (${mobileResult.html.length} bytes)`);
  }
    // Ensure mobile sub-directory has direct access to root assets/css/js
    const mobileDir = path.join(outDir, 'mobile');
    const mobileAssetsDir = path.join(mobileDir, 'assets');
    const mobileCssDir = path.join(mobileDir, 'css');
    const mobileJsDir = path.join(mobileDir, 'js');
    try {
      if (!fs.existsSync(mobileAssetsDir)) fs.symlinkSync(assetsDir, mobileAssetsDir, 'junction');
      if (!fs.existsSync(mobileCssDir)) fs.symlinkSync(cssDir, mobileCssDir, 'junction');
      if (!fs.existsSync(mobileJsDir)) fs.symlinkSync(jsDir, mobileJsDir, 'junction');
    } catch (e) {
      // Fallback: non-fatal if junctions cannot be created
    }

  // Generate Manifest
  const manifestPath = path.join(outDir, 'clone-manifest.json');
  const manifestData = {
    schemaVersion: 1,
    targetUrl,
    clonedAt: new Date().toISOString(),
    architecture: isAdaptive ? 'adaptive' : 'responsive',
    offlineReady: true,
    surfaces: {
      desktop: {
        entry: 'index.html',
        size: desktopResult.html.length,
        rawSha256: desktopCapture.receipt.sha256,
        scrollHeight: desktopCapture.receipt.metrics?.finalHeight ?? null
      },
      ...(mobileResult ? {
        mobile: {
          entry: 'mobile/index.html',
          size: mobileResult.html.length,
          rawSha256: mobileCapture.receipt.sha256,
          scrollHeight: mobileCapture.receipt.metrics?.finalHeight ?? null
        }
      } : {})
    },
    assets: {
      totalDiscovered: combinedAssets.length,
      downloaded: downloadResult.downloaded.length,
      failed: downloadResult.failedCount,
      totalBytes: downloadResult.totalBytes
    }
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), 'utf8');
  console.log(`  ✓ Saved clone manifest to ${manifestPath}`);

  console.log('\n===========================================================');
  console.log('[AntiFan Universal Clone] COMPLETE! 100% Offline & Standalone.');
  console.log(`Preview command: node scripts/serve-clone.mjs "${outDir}"`);
  console.log('===========================================================');

  if (shouldServe) {
    console.log(`\nStarting local preview server on port ${servePort}...`);
    const serveProc = spawn(process.execPath, [path.join(rootDir, 'scripts', 'serve-clone.mjs'), outDir], {
      cwd: rootDir,
      stdio: 'inherit',
      env: { ...process.env, PORT: String(servePort), CLONE_DIR: outDir }
    });
  }
}

run().catch(err => {
  console.error('[AntiFan Universal Clone] Failed:', err);
  process.exit(1);
});
