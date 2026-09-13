#!/usr/bin/env node
/**
 * AntiFan Universal Site Clone CLI
 *
 * Platform-agnostic capture and localization CLI. Generated output requires
 * separate offline, interaction, and visual parity verification.
 * 1. Captures both device contexts by default without guessing site architecture.
 * 2. Headless Materialization via Electron (1440x900 desktop, 390x844 mobile).
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
  IndependentHtmlCloneGenerator
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
if (!['auto', 'both', 'desktop', 'mobile'].includes(deviceMode)) {
  throw new Error(`Unsupported device mode: ${deviceMode}`);
}
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error('--concurrency must be a positive integer');
}

const assetsDir = path.join(outDir, 'assets');
const cssDir = path.join(outDir, 'css');
const jsDir = path.join(outDir, 'js');

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(cssDir, { recursive: true });
fs.mkdirSync(jsDir, { recursive: true });

function classifyArchitecture(desktopHtml, mobileHtml) {
  const combined = `${desktopHtml}\n${mobileHtml ?? ''}`;
  const signals = [];
  if (/livewire\.(?:min\.)?js|wire:snapshot|wire:effects/i.test(combined)) signals.push('livewire');
  if (/\bx-data\s*=|\bx-on:click\s*=|\b@click\s*=/.test(combined)) signals.push('alpine');
  if (/__NEXT_DATA__/.test(combined)) signals.push('next');
  if (/data-turbo(?:-|=")/i.test(combined)) signals.push('turbo');
  return signals.length > 0 ? signals.join('+') : 'static-materialized';
}

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
  if (!receiptUrl || !expectedUrl || receiptUrl !== expectedUrl) {
    return { valid: false, reason: `Target URL mismatch (receipt: ${receiptUrl}, expected: ${expectedUrl})` };
  }
  if (receipt.device !== expected.device) {
    return { valid: false, reason: `Device mismatch (receipt: ${receipt.device}, expected: ${expected.device})` };
  }
  if (receipt.width !== expected.expectedWidth || receipt.height !== expected.expectedHeight) {
    return { valid: false, reason: `Viewport mismatch (${receipt.width}x${receipt.height}, expected ${expected.expectedWidth}x${expected.expectedHeight})` };
  }
  if (typeof receipt.userAgent !== 'string' || !receipt.userAgent ||
      receipt.requestHeaders?.['sec-ch-ua-mobile'] !== (expected.device === 'mobile' ? '?1' : '?0')) {
    return { valid: false, reason: 'Capture receipt is missing the device request context' };
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

  // A desktop capture cannot prove the absence of a server-selected mobile DOM.
  // Auto captures both; capture count is not an architecture classification.
  const isAdaptive = deviceMode !== 'desktop';

  console.log(`\n[Phase 2/4] Capture mode: ${isAdaptive ? 'Desktop and mobile' : 'Desktop only'}`);

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
  const desktopContext = { ...desktopCapture.receipt, surface: 'desktop' };
  const mobileContext = mobileCapture ? { ...mobileCapture.receipt, surface: 'mobile' } : undefined;
  const filesToHarvest = [{ path: 'index.html', content: desktopHtml, context: desktopContext }];
  if (mobileHtml) {
    filesToHarvest.push({ path: 'mobile/index.html', content: mobileHtml, context: mobileContext });
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
  const failedAssetUrls = downloadResult.downloaded
    .filter(item => item.status === 'failed')
    .map(item => ({ sourceUrl: item.sourceUrl, error: item.error ?? 'unknown failure' }));
  if (failedAssetUrls.length > 0) {
    console.warn(`  ! ${failedAssetUrls.length} remote subresource(s) could not be localized; the package is not offline-complete.`);
    for (const failure of failedAssetUrls.slice(0, 20)) {
      console.warn(`    - ${failure.sourceUrl} (${failure.error})`);
    }
  }

  // Discover and localize secondary subresources inside downloaded stylesheets (e.g. fonts, @imports).
  // One manifest object flows through the whole pipeline: stylesheet localization registers the
  // assets it discovers into it, so consolidation, HTML rewriting, and the integrity audit all
  // resolve names against the same registry.
  const secondaryResult = await localizer.localizeDownloadedStylesheets(harvestedManifest, {
    assetsDir,
    mode: 'relative',
    sourceBaseUrl: targetUrl,
  });
  if (secondaryResult.failedCount > 0 || secondaryResult.depthExceededUrls.length > 0) {
    console.warn(`  ! Stylesheet dependency localization incomplete: ${secondaryResult.failedCount} failures, ${secondaryResult.depthExceededUrls.length} import depth refusals.`);
    for (const url of secondaryResult.depthExceededUrls.slice(0, 20)) {
      console.warn(`    - depth cutoff: ${url}`);
    }
  }
  if (secondaryResult.secondaryDownloaded.length > 0) {
    console.log(`  ✓ Secondary Asset Download complete: ${secondaryResult.secondaryDownloaded.length} secondary assets (fonts/stylesheets) downloaded.`);
  }
  // Same URL requested from two device contexts usually returns identical bytes; keep one
  // file for those and only keep per-context copies where the served content really differs.
  const consolidation = localizer.consolidateIdenticalContent(
    [...downloadResult.downloaded, ...secondaryResult.secondaryDownloaded],
    harvestedManifest,
    assetsDir
  );
  if (consolidation.consolidated > 0) {
    console.log(`  ✓ Consolidated ${consolidation.consolidated} byte-identical duplicates (${(consolidation.freedBytes / (1024 * 1024)).toFixed(2)} MB); ${consolidation.groups.length} asset(s) share a single file across surfaces.`);
  }
  // Rewrite asset references in HTML
  console.log('  Rewriting Desktop HTML references to local assets/...');
  const dRewriteResult = localizer.rewriteFiles([{ path: 'index.html', content: desktopHtml, context: desktopContext }], harvestedManifest, { mode: 'relative' });
  desktopHtml = dRewriteResult.files[0].rewrittenContent;

  let mRewriteResult = null;
  if (mobileHtml) {
    console.log('  Rewriting Mobile HTML references to local ../assets/...');
    mRewriteResult = localizer.rewriteFiles([{ path: 'mobile/index.html', content: mobileHtml, context: mobileContext }], harvestedManifest, { mode: 'relative' });
    mobileHtml = mRewriteResult.files[0].rewrittenContent;
  }

  const allDownloaded = [...downloadResult.downloaded, ...secondaryResult.secondaryDownloaded];

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

  // Fail-closed integrity audit of the package that actually ships: every harvested asset on
  // disk, the emitted surface documents (third-party widgets the sanitizer removed are
  // intentionally not present, so auditing the pre-sanitization HTML would report references
  // no shipped file contains), and every on-disk stylesheet are checked for references the
  // browser would follow into a dead end. A download that never arrived is reported and
  // leaves the package incomplete; any other finding is a broken reference and stops
  // generation instead of shipping a package that only looks finished.
  const emittedFiles = [
    { path: 'index.html', originalContent: desktopResult.html, rewrittenContent: desktopResult.html, replacementCount: dRewriteResult.files[0].replacementCount }
  ];
  if (mobileResult) {
    emittedFiles.push({
      path: 'mobile/index.html',
      originalContent: mobileResult.html,
      rewrittenContent: mobileResult.html,
      replacementCount: mRewriteResult ? mRewriteResult.files[0].replacementCount : 0
    });
  }
  const audit = localizer.verifyAndAudit(harvestedManifest, {
    assetsDir,
    rewrittenFiles: emittedFiles,
    downloadResults: allDownloaded,
    depthExceededUrls: secondaryResult.depthExceededUrls
  });
  const blockingFindings = audit.findings.filter(finding => finding.code !== 'DOWNLOAD_FAILED');
  console.log(`  Integrity audit: ${audit.findings.length} finding(s), ${blockingFindings.length} blocking, ${audit.verifiedAssets.length} asset(s) verified on disk.`);
  for (const finding of blockingFindings.slice(0, 20)) {
    console.error(`    ! ${finding.code}: ${finding.message}`);
  }

  // Documents embedded from another origin (video players, chat widgets, maps) cannot be stored
  // in a static package. Record every one the sanitizer dropped so the package does not claim
  // parity it cannot deliver: the manifest states what the clone will not load.
  const emitSurface = mobileResult
    ? [{ path: 'index.html', html: desktopResult.html }, { path: 'mobile/index.html', html: mobileResult.html }]
    : [{ path: 'index.html', html: desktopResult.html }];
  const remoteEmbeds = [];
  const seenEmbeds = new Set();
  for (const surface of emitSurface) {
    const sourceHtml = surface.path === 'index.html' ? dRewriteResult.files[0].rewrittenContent : mRewriteResult.files[0].rewrittenContent;
    for (const match of sourceHtml.matchAll(/<(iframe|embed|object)\b[^>]*?(?:data-)?src\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi)) {
      const url = match[2];
      const key = `${surface.path}::${url}`;
      if (seenEmbeds.has(key) || surface.html.includes(url)) continue;
      seenEmbeds.add(key);
      remoteEmbeds.push({ surface: surface.path, element: match[1].toLowerCase(), url });
    }
  }
  if (remoteEmbeds.length > 0) {
    console.log(`  ! ${remoteEmbeds.length} remote embed(s) cannot be stored offline and were dropped from the emitted surfaces.`);
  }

  // Generate Manifest
  const manifestPath = path.join(outDir, 'clone-manifest.json');
  const assetMap = {};
  const assetProvenance = [];
  const absorbedRequests = [];
  const hashToFirstFilename = new Map();
  const seenFilenames = new Set();
  const packageFilenames = new Set();
  for (const item of allDownloaded) {
    let sha256 = item.sha256 || null;
    if (!sha256 && item.localPath && fs.existsSync(item.localPath)) {
      sha256 = crypto.createHash('sha256').update(fs.readFileSync(item.localPath)).digest('hex');
    }
    if (item.sourceUrl) {
      if (!(item.sourceUrl in assetMap)) {
        assetMap[item.sourceUrl] = item.filename;
      }
      if (item.requestIdentity) {
        assetMap[`${item.sourceUrl}#${item.requestIdentity}`] = item.filename;
      }
    }
    // Consolidation rewrites an absorbed request's filename in place, so the file a request now
    // names is the file its bytes live in. The first request naming a file owns that file's
    // provenance row; every later request naming the same file was consolidated into it and is
    // recorded as absorbed. Without this the receipt lists one file twice and claims the file
    // duplicates itself.
    if (seenFilenames.has(item.filename)) {
      absorbedRequests.push({
        filename: item.filename,
        sourceUrl: item.sourceUrl,
        requestIdentity: item.requestIdentity || null,
        status: item.status,
        byteCount: item.byteCount
      });
      continue;
    }
    seenFilenames.add(item.filename);
    if (item.status !== 'failed') {
      packageFilenames.add(item.filename);
    }
    const duplicateOf = sha256 ? hashToFirstFilename.get(sha256) || null : null;
    if (sha256 && !duplicateOf) {
      hashToFirstFilename.set(sha256, item.filename);
    }
    assetProvenance.push({
      filename: item.filename,
      sourceUrl: item.sourceUrl,
      requestIdentity: item.requestIdentity || null,
      status: item.status,
      byteCount: item.byteCount,
      sha256,
      duplicateContentOf: duplicateOf && duplicateOf !== item.filename ? duplicateOf : null
    });
  }
  const manifestData = {
    schemaVersion: 1,
    targetUrl,
    clonedAt: new Date().toISOString(),
    architecture: classifyArchitecture(desktopHtml, mobileHtml),
    offlineReady: audit.findings.length === 0,
    verificationStatus: audit.passed ? 'asset-verified' : 'integrity-failed',
    surfaces: {
      desktop: {
        entry: 'index.html',
        size: Buffer.byteLength(desktopResult.html),
        sha256: crypto.createHash('sha256').update(desktopResult.html).digest('hex'),
        rawSha256: desktopCapture.receipt.sha256,
        scrollHeight: desktopCapture.receipt.metrics?.totalHeight ?? null
      },
      ...(mobileResult ? {
        mobile: {
          entry: 'mobile/index.html',
          size: Buffer.byteLength(mobileResult.html),
          sha256: crypto.createHash('sha256').update(mobileResult.html).digest('hex'),
          rawSha256: mobileCapture.receipt.sha256,
          scrollHeight: mobileCapture.receipt.metrics?.totalHeight ?? null
        }
      } : {})
    },
    assets: {
      // Request-level counts (what was asked for) and file-level counts (what the package holds)
      // are reported separately: a URL requested from two device contexts is two requests but one
      // file, and a failed request is not a downloaded asset.
      totalDiscovered: combinedAssets.length + secondaryResult.secondaryDownloaded.length + secondaryResult.depthExceededUrls.length,
      requestsAttempted: allDownloaded.length,
      downloaded: allDownloaded.filter(item => item.status !== 'failed').length,
      failed: downloadResult.failedCount + secondaryResult.failedCount,
      filesInPackage: packageFilenames.size,
      totalBytes: downloadResult.totalBytes + secondaryResult.totalBytes,
      unresolvedPrimary: failedAssetUrls,
      unresolvedSecondary: [
        ...secondaryResult.depthExceededUrls,
        ...secondaryResult.secondaryDownloaded
          .filter(item => item.status === 'failed')
          .map(item => ({ sourceUrl: item.sourceUrl, error: item.error ?? 'unknown failure' }))
      ],
      remoteEmbeds,
      audit: {
        passed: audit.passed,
        verifiedAssetCount: audit.verifiedAssets.length,
        findingCount: audit.findings.length,
        blockingFindingCount: blockingFindings.length,
        findings: audit.findings,
        unlocalizedUrls: audit.unlocalizedUrls
      },
      consolidatedSharedFiles: consolidation.groups.map(group => ({
        sha256: group.sha256,
        canonical: group.canonical,
        removed: group.removed,
        renamedFrom: group.renamedFrom ?? null,
        aliases: group.aliases ?? []
      })),
      consolidation: {
        physicalDeletions: consolidation.consolidated,
        freedBytes: consolidation.freedBytes
      },
      assetMap,
      provenance: assetProvenance,
      absorbedRequests
    }
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), 'utf8');
  console.log(`  ✓ Saved clone manifest to ${manifestPath}`);

  if (blockingFindings.length > 0) {
    throw new Error(
      `Integrity audit failed with ${blockingFindings.length} blocking finding(s); ` +
      `the package has broken references and is not shippable. See ${manifestPath} (assets.audit.findings).`
    );
  }
  if (!audit.passed) {
    console.warn(
      `  ! Integrity audit reported ${audit.findings.length} non-blocking finding(s) ` +
      `(downloads that never arrived); the package was written but is not offline-complete.`
    );
  }

  console.log('\n===========================================================');
  console.log('[AntiFan Universal Clone] Generated. Offline and visual parity verification still required.');
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
