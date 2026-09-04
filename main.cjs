/**
 * AntiFan Browser Desktop — Main Entry Launcher
 * Bridges directly to the compiled TypeScript bundle. If missing in development,
 * triggers auto-compilation to prevent "Cannot find module" launch failures.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');

const compiledMain = path.join(__dirname, '.compiled', 'src', 'main', 'index.js');

if (!fs.existsSync(compiledMain)) {
  if (app && app.isPackaged) {
    dialog.showErrorBox(
      'AntiFan Browser Error',
      `Corrupted installation: cannot find compiled runtime bundle at:\n${compiledMain}`
    );
    app.quit();
    process.exit(1);
  }

  console.log('[antifan] Compiled bundle missing (.compiled/src/main/index.js). Auto-compiling project before launch...');
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
