/**
 * AntiFan Core CLI Runner: A1-A2-A3 Unified Asset Localization & Audit Pipeline
 *
 * Strict Fail-Closed & Path-Safe Contract:
 * - Usage: node scripts/run-asset-localization.cjs --root <dir> [--files <rel1,rel2,...>] [--manifest <path>] [--mode <liquid|relative>] [--write-files] [--output <path>]
 * - Requires --root and at least one of --files or --manifest
 * - Validates core package build (actionable error if dist is missing)
 * - Strict lexical & symlink path containment checks on all inputs and outputs
 * - Executes A1 (Download with SSRF/DNS protection) -> A2 (Rewrite) -> A3 (Verification & Audit Ledger)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function printUsageAndExit(message) {
  if (message) console.error(`ERROR [FAIL_CLOSED]: ${message}\n`);
  console.error('Usage: node scripts/run-asset-localization.cjs --root <dir> [options]');
  console.error('Options:');
  console.error('  --root         Absolute or relative path to the target storefront root (required)');
  console.error('  --files        Comma-separated list of relative file paths to scan/rewrite (required if no --manifest)');
  console.error('  --manifest     Optional path to pre-generated A0 manifest (default: <root>/assets-manifest-a0.json)');
  console.error('  --mode         Rewrite mode: "liquid" or "relative" (default: "liquid")');
  console.error('  --write-files  Actually overwrite source files on disk with rewritten content (default: dry-run)');
  console.error('  --skip-download Skip network download phase (rewrite and audit only)');
  console.error('  --concurrency  Max concurrent downloads (default: 5)');
  console.error('  --output       Path for generated localization ledger (default: <root>/assets-localization-a1-a3.json)');
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let root = '';
  let filesArg = '';
  let manifestPath = '';
  let mode = 'liquid';
  let writeFiles = false;
  let skipDownload = false;
  let concurrency = 5;
  let output = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root') {
      root = args[++i] || '';
    } else if (arg === '--files') {
      filesArg = args[++i] || '';
    } else if (arg === '--manifest') {
      manifestPath = args[++i] || '';
    } else if (arg === '--mode') {
      mode = args[++i] || 'liquid';
    } else if (arg === '--write-files') {
      writeFiles = true;
    } else if (arg === '--skip-download') {
      skipDownload = true;
    } else if (arg === '--concurrency') {
      concurrency = parseInt(args[++i], 10) || 5;
    } else if (arg === '--output') {
      output = args[++i] || '';
    } else if (arg === '--help' || arg === '-h') {
      printUsageAndExit();
    } else {
      printUsageAndExit(`Unknown argument: ${arg}`);
    }
  }

  if (!root) {
    printUsageAndExit('Missing required argument: --root <dir>');
  }

  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) {
    printUsageAndExit(`Target root directory does not exist: ${resolvedRoot}`);
  }
  const rootStat = fs.statSync(resolvedRoot);
  if (!rootStat.isDirectory()) {
    printUsageAndExit(`Target root is not a directory: ${resolvedRoot}`);
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const realRootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

  // Validate output path containment
  const resolvedOutput = output ? path.resolve(output) : path.join(realRoot, 'assets-localization-a1-a3.json');
  if (!resolvedOutput.startsWith(realRootPrefix) && resolvedOutput !== realRoot) {
    printUsageAndExit(`Output path escapes root directory: ${resolvedOutput}`);
  }

  // Parse files
  const rawFiles = filesArg ? filesArg.split(',').map(s => s.trim()).filter(Boolean) : [];

  if (rawFiles.length === 0 && !manifestPath) {
    // Check if default manifest exists
    const defaultManifest = path.join(realRoot, 'assets-manifest-a0.json');
    if (fs.existsSync(defaultManifest)) {
      manifestPath = defaultManifest;
    } else {
      printUsageAndExit('Must provide either --files or --manifest (or have assets-manifest-a0.json in root)');
    }
  }

  if (manifestPath) {
    const resolvedManifest = path.resolve(manifestPath);
    if (!resolvedManifest.startsWith(realRootPrefix) && resolvedManifest !== realRoot) {
      printUsageAndExit(`Manifest path escapes root directory: ${resolvedManifest}`);
    }
    if (!fs.existsSync(resolvedManifest)) {
      printUsageAndExit(`Manifest file does not exist: ${resolvedManifest}`);
    }
    manifestPath = resolvedManifest;
  }

  if (mode !== 'liquid' && mode !== 'relative') {
    printUsageAndExit(`Invalid mode: ${mode}. Must be "liquid" or "relative"`);
  }

  return {
    root: realRoot,
    rawFiles,
    manifestPath,
    mode,
    writeFiles,
    skipDownload,
    concurrency,
    output: resolvedOutput
  };
}

async function main() {
  const options = parseArgs();

  // 1. Check core site-clone package build
  const siteCloneDist = path.resolve(__dirname, '../packages/site-clone/dist/index.js');
  if (!fs.existsSync(siteCloneDist)) {
    console.error(`ERROR [FAIL_CLOSED]: Core package @antifan/site-clone is not built.`);
    console.error(`Action required: Run 'npm run build:site-clone' before executing this runner.`);
    process.exit(1);
  }

  const { AssetHarvester, AssetLocalizer } = require(siteCloneDist);

  console.log(`[A1-A3 Asset Localization] Root: ${options.root}`);
  console.log(`[A1-A3 Asset Localization] Mode: ${options.mode} | Write-Files: ${options.writeFiles ? 'YES' : 'NO (dry-run)'}`);

  const rootPrefix = options.root.endsWith(path.sep) ? options.root : options.root + path.sep;

  // 2. Load files
  const loadedFiles = [];
  for (const relPath of options.rawFiles) {
    const resolvedPath = path.resolve(options.root, relPath);
    if (!resolvedPath.startsWith(rootPrefix)) {
      console.error(`ERROR [FAIL_CLOSED]: Path traversal detected: ${relPath}`);
      process.exit(1);
    }
    if (!fs.existsSync(resolvedPath)) {
      console.error(`ERROR [FAIL_CLOSED]: Target file does not exist: ${resolvedPath}`);
      process.exit(1);
    }
    const realTarget = fs.realpathSync(resolvedPath);
    if (!realTarget.startsWith(rootPrefix)) {
      console.error(`ERROR [FAIL_CLOSED]: Symlink escape detected: ${relPath}`);
      process.exit(1);
    }
    const stat = fs.statSync(realTarget);
    if (!stat.isFile()) {
      console.error(`ERROR [FAIL_CLOSED]: Target is not a regular file: ${resolvedPath}`);
      process.exit(1);
    }
    const content = fs.readFileSync(realTarget, 'utf8');
    loadedFiles.push({ path: relPath.replace(/\\/g, '/'), content });
  }

  // 3. Obtain manifest (either from file or by running A0 discovery)
  let manifest;
  const assetsDir = path.join(options.root, 'assets');

  if (options.manifestPath) {
    console.log(`[A1-A3 Asset Localization] Loading manifest from: ${options.manifestPath}`);
    manifest = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'));
  } else {
    console.log(`[A1-A3 Asset Localization] Running A0 discovery on ${loadedFiles.length} file(s)...`);
    const harvester = new AssetHarvester();
    manifest = harvester.harvestFromFiles(loadedFiles, assetsDir);
  }

  const allManifestItems = [
    ...manifest.stylesheets,
    ...manifest.javascripts,
    ...manifest.images,
    ...manifest.fonts
  ];

  console.log(`[A1-A3 Asset Localization] Discovered ${allManifestItems.length} asset(s) to process:`);
  console.log(`  Stylesheets: ${manifest.stylesheets.length}`);
  console.log(`  Javascripts: ${manifest.javascripts.length}`);
  console.log(`  Images:      ${manifest.images.length}`);
  console.log(`  Fonts:       ${manifest.fonts.length}`);

  // 4. Run AssetLocalizer Pipeline
  const localizer = new AssetLocalizer();

  console.log(`\n>>> Phase A1: Downloading assets to ${assetsDir}...`);
  const pipelineResult = await localizer.localizePipeline(loadedFiles, manifest, {
    assetsDir,
    mode: options.mode,
    skipDownload: options.skipDownload,
    concurrency: options.concurrency
  });

  const a1 = pipelineResult.a1_download;
  const a2 = pipelineResult.a2_rewrite;
  const a3 = pipelineResult.a3_audit;

  console.log(`  ✔ Phase A1 Completed: ${a1.downloaded.filter(d => d.status === 'downloaded').length} downloaded, ${a1.downloaded.filter(d => d.status === 'skipped_cached').length} cached, ${a1.failedCount} failed (${(a1.totalBytes / 1024).toFixed(1)} KB)`);

  console.log(`\n>>> Phase A2: Rewriting source files (${options.mode} mode)...`);
  console.log(`  ✔ Phase A2 Completed: ${a2.totalReplacements} total URL replacements across ${a2.files.length} file(s)`);

  if (options.writeFiles) {
    console.log(`  Applying rewritten content to disk...`);
    for (const f of a2.files) {
      if (f.replacementCount > 0) {
        const absPath = path.resolve(options.root, f.path);
        fs.writeFileSync(absPath, f.rewrittenContent, 'utf8');
        console.log(`    ↳ Updated: ${f.path} (${f.replacementCount} replacements)`);
      }
    }
  }

  console.log(`\n>>> Phase A3: Verifying integrity and auditing ledger...`);
  console.log(`  Disk Assets Verified: ${a3.verifiedAssets.filter(v => v.status === 'valid').length}/${a3.verifiedAssets.length}`);
  console.log(`  Audit Findings: ${a3.findings.length} (${a3.findings.filter(f => f.severity === 'error').length} errors, ${a3.findings.filter(f => f.severity === 'warning').length} warnings)`);
  console.log(`  Audit Status: ${a3.passed ? 'PASSED (Zero Critical Errors)' : 'FAILED (Has Critical Errors)'}`);

  // 5. Write full localization ledger
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, JSON.stringify(pipelineResult, null, 2), 'utf8');
  console.log(`\n[A1-A3 Asset Localization] Complete ledger written to: ${options.output}`);

  if (!a3.passed) {
    console.error(`\nWARNING [AUDIT_FINDINGS]: Some asset checks failed. Inspect ${options.output} for details.`);
  }
}

main().catch(err => {
  console.error(`FATAL [FAIL_CLOSED]: ${err.message}`);
  process.exit(1);
});
