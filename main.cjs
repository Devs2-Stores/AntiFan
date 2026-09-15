/**
 * AntiFan Browser Desktop — Main Entry Launcher
 * Bridges directly to the compiled TypeScript bundle. If the bundle is missing or stale in
 * development, triggers auto-compilation to prevent launch failures and silently running old code.
 */
const path = require('node:path');
// V8 compile cache: persists compiled bytecode for the .compiled bundle across
// launches, cutting main-process module load roughly in half on cold start.
// No-ops on runtimes without support.
try { require('node:module').enableCompileCache?.(); } catch {}
const { app, dialog } = require('electron');
const { inspectCompiledBundle } = require('./scripts/launch-guard.cjs');

const compiledMain = path.join(__dirname, '.compiled', 'src', 'main', 'index.js');
const buildInfoPath = path.join(__dirname, '.compiled', '.tsbuildinfo');

// A stale bundle behaves like old code, not like a missing module: decide before launching.
// Kept in one object because the verdict is re-checked after a rebuild below.
const guardInput = {
  bundlePath: compiledMain,
  buildInfoPath,
  sourceRoots: [path.join(__dirname, 'src')],
  configFiles: [path.join(__dirname, 'tsconfig.json')],
};
const bundleState = inspectCompiledBundle(guardInput);

if (bundleState.state === 'fresh') {
  console.log(`[antifan] Compiled bundle fresh (${bundleState.reason}).`);
} else {
  if (app && app.isPackaged) {
    dialog.showErrorBox(
      'AntiFan Browser Error',
      `Corrupted installation: the compiled runtime bundle is ${bundleState.state} at:\n${compiledMain}\n(${bundleState.reason})`
    );
    app.quit();
    process.exit(1);
  }

  console.log(`[antifan] Compiling before launch: ${bundleState.reason}.`);
  try {
    const { execSync } = require('node:child_process');
    execSync('npm run compile', { cwd: __dirname, stdio: 'inherit' });
  } catch (err) {
    if (dialog && dialog.showErrorBox) {
      dialog.showErrorBox(
        'AntiFan Browser Build Error',
        `Failed to compile project before launch:\n${err && err.message ? err.message : String(err)}`
      );
    }
    if (app && app.quit) {
      app.quit();
    }
    process.exit(1);
  }

  // A `npm run compile` that exits 0 while the tree still looks stale would otherwise launch the
  // old code silently — the exact failure this guard exists to stop. This does not refuse to
  // start (a false-positive verdict must not brick every launch); it makes the surprise loud.
  const afterRebuild = inspectCompiledBundle(guardInput);
  if (afterRebuild.state !== 'fresh') {
    console.error(
      `[antifan] WARNING: the compiled bundle still looks ${afterRebuild.state} after a rebuild ` +
      `(${afterRebuild.reason}).\n` +
      `[antifan] Launching anyway — the code this process runs may NOT match src/**. Most likely a ` +
      `concurrent writer (tsc --watch, another npm run compile) is rewriting .compiled right now.`
    );
  }
}

require(compiledMain);
