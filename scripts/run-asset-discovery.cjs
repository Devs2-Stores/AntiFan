/**
 * AntiFan Core CLI Runner: A0 Asset Discovery & Manifest Extractor
 *
 * Strict Fail-Closed & Path-Safe Contract:
 * - Usage: node scripts/run-asset-discovery.cjs --root <dir> --files <rel1,rel2,...> [--output <path>]
 * - Requires both --root and --files
 * - Validates core package build (actionable error if dist is missing)
 * - Validates all files reside within --root (prevents path escape)
 * - Strictly verifies each target is an existing regular file
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function printUsageAndExit(message) {
  if (message) console.error(`ERROR [FAIL_CLOSED]: ${message}\n`);
  console.error('Usage: node scripts/run-asset-discovery.cjs --root <dir> --files <rel1,rel2,...> [--output <path>]');
  console.error('  --root    Absolute or relative path to the target storefront root (required)');
  console.error('  --files   Comma-separated list of relative file paths to scan (required)');
  console.error('  --output  Optional path for the generated manifest (default: <root>/assets-manifest-a0.json)');
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let root = '';
  let filesArg = '';
  let output = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) {
      root = args[i + 1];
      i++;
    } else if (args[i] === '--files' && args[i + 1]) {
      filesArg = args[i + 1];
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[i + 1];
      i++;
    }
  }

  if (!root) {
    printUsageAndExit('Missing required argument: --root <dir>');
  }
  if (!filesArg) {
    printUsageAndExit('Missing required argument: --files <rel1,rel2,...>');
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

  const rawFiles = filesArg.split(',').map(s => s.trim()).filter(Boolean);
  if (rawFiles.length === 0) {
    printUsageAndExit('--files must contain at least one relative file path');
  }

  const resolvedOutput = output ? path.resolve(output) : path.join(realRoot, 'assets-manifest-a0.json');
  const realRootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

  // 1. Unconditional lexical containment check
  if (!resolvedOutput.startsWith(realRootPrefix)) {
    printUsageAndExit(`Output path escapes root directory: ${resolvedOutput}`);
  }

  // 2. Check output path with lstatSync to detect dangling symlinks as well as existing files
  let outputLstat = null;
  try {
    outputLstat = fs.lstatSync(resolvedOutput);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      outputLstat = null;
    } else {
      printUsageAndExit(`Failed to inspect output path due to filesystem error: ${err && err.message}`);
    }
  }

  if (outputLstat) {
    if (outputLstat.isSymbolicLink()) {
      let realTarget;
      try {
        realTarget = fs.realpathSync(resolvedOutput);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          // Dangling symlink: target does not exist yet. Read the link and resolve against dirname.
          const rawLink = fs.readlinkSync(resolvedOutput);
          const resolvedLink = path.resolve(path.dirname(resolvedOutput), rawLink);
          let anc = path.dirname(resolvedLink);
          while (anc && !fs.existsSync(anc)) {
            const parent = path.dirname(anc);
            if (parent === anc) break;
            anc = parent;
          }
          if (fs.existsSync(anc)) {
            const realAnc = fs.realpathSync(anc);
            const rel = path.relative(anc, resolvedLink);
            realTarget = path.resolve(realAnc, rel);
          } else {
            realTarget = resolvedLink;
          }
        } else {
          printUsageAndExit(`Failed to resolve output symlink target: ${err && err.message}`);
        }
      }
      if (!realTarget.startsWith(realRootPrefix)) {
        printUsageAndExit(`Output symlink escapes root directory: ${resolvedOutput}`);
      }
    } else {
      const realExistingOutput = fs.realpathSync(resolvedOutput);
      if (!realExistingOutput.startsWith(realRootPrefix)) {
        printUsageAndExit(`Output file escapes root directory: ${resolvedOutput}`);
      }
    }
  }
  // 3. Nearest existing ancestor canonicalization (guards against in-path directory symlinks)
  let cur = path.dirname(resolvedOutput);
  while (cur && !fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (fs.existsSync(cur)) {
    const realAncestor = fs.realpathSync(cur);
    if (!realAncestor.startsWith(realRootPrefix) && realAncestor !== realRoot) {
      printUsageAndExit(`Output path traverses symlink outside root directory: ${resolvedOutput}`);
    }
  }
  return { root: realRoot, rawFiles, output: resolvedOutput };
}

function main() {
  const { root, rawFiles, output } = parseArgs();

  // 1. Check core site-clone package build
  const siteCloneDist = path.resolve(__dirname, '../packages/site-clone/dist/index.js');
  if (!fs.existsSync(siteCloneDist)) {
    console.error(`ERROR [FAIL_CLOSED]: Core package @antifan/site-clone is not built.`);
    console.error(`Action required: Run 'npm run build:site-clone' before executing this runner.`);
    process.exit(1);
  }

  const { AssetHarvester } = require(siteCloneDist);

  // 2. Validate and load files with strict containment checks
  console.log(`[A0 Asset Discovery] Root: ${root}`);
  console.log(`[A0 Asset Discovery] Validating ${rawFiles.length} requested file(s)...`);

  const loadedFiles = [];
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;

  for (const relPath of rawFiles) {
    const resolvedPath = path.resolve(root, relPath);

    // Lexical path escape prevention
    if (!resolvedPath.startsWith(rootPrefix)) {
      console.error(`ERROR [FAIL_CLOSED]: Path traversal detected. File escapes root directory: ${relPath}`);
      process.exit(1);
    }

    if (!fs.existsSync(resolvedPath)) {
      console.error(`ERROR [FAIL_CLOSED]: Target file does not exist: ${resolvedPath}`);
      process.exit(1);
    }

    // Canonical symlink escape prevention
    const realTarget = fs.realpathSync(resolvedPath);
    if (!realTarget.startsWith(rootPrefix)) {
      console.error(`ERROR [FAIL_CLOSED]: Symlink escape detected. File resolves outside root directory: ${relPath}`);
      process.exit(1);
    }

    const stat = fs.statSync(realTarget);
    if (!stat.isFile()) {
      console.error(`ERROR [FAIL_CLOSED]: Target is not a regular file: ${resolvedPath}`);
      process.exit(1);
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    loadedFiles.push({ path: relPath.replace(/\\/g, '/'), content });
  }

  console.log(`  ✔ Successfully validated and loaded ${loadedFiles.length} file(s).`);

  // 3. Execute AssetHarvester
  const outputAssetsDir = path.join(root, 'assets');
  const harvester = new AssetHarvester();
  const manifest = harvester.harvestFromFiles(loadedFiles, outputAssetsDir);

  // 4. Write manifest
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`\n[A0 Asset Discovery] Manifest written to: ${output}`);
  console.log('--- Summary Ledger ---');
  console.log(`  Stylesheets: ${manifest.stylesheets.length}`);
  console.log(`  Javascripts: ${manifest.javascripts.length}`);
  console.log(`  Images:      ${manifest.images.length}`);
  console.log(`  Fonts:       ${manifest.fonts.length}`);
  console.log(`  Input Files: ${loadedFiles.length}`);

  // Provenance trace
  console.log('\n--- Sample Provenance Trace (first 5 images) ---');
  for (const img of manifest.images.slice(0, 5)) {
    console.log(`  - [${img.filename}] <- ${img.sourceUrl}`);
    for (const occ of (img.occurrences || []).slice(0, 2)) {
      console.log(`    ↳ ${occ.filePath || 'unknown'}:${occ.tag}[${occ.attribute}]`);
    }
  }
}

main();
