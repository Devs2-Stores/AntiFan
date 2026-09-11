/**
 * AntiFan Browser Desktop — Main Entry Launcher
 * Bridges directly to the compiled TypeScript bundle. If the bundle is missing or stale in
 * development, triggers auto-compilation to prevent launch failures and silently running old code.
 */
const path = require('node:path');
const { app, dialog } = require('electron');
const { inspectCompiledBundle } = require('./scripts/launch-guard.cjs');

const compiledMain = path.join(__dirname, '.compiled', 'src', 'main', 'index.js');

// A stale bundle behaves like old code, not like a missing module: decide before launching.
const bundleState = inspectCompiledBundle({
  bundlePath: compiledMain,
  sourceRoots: [path.join(__dirname, 'src')],
  configFiles: [path.join(__dirname, 'tsconfig.json')],
});

if (bundleState.state !== 'fresh') {
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
}

require(compiledMain);
