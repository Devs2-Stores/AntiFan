/**
 * AntiFan Browser Desktop — Copy Static Assets Script
 * Copies HTML, CSS, and Markdown assets to .compiled output directory.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function safeCopyFile(from, to) {
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  } catch (firstErr) {
    try {
      // The first attempt can fail before creating the parent directory; retrying the copy
      // alone would then fail with ENOENT instead of recovering.
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    } catch (retryErr) {
      // A static asset that never lands leaves the build looking green while the app runs
      // without it (or without the exports shim the renderer needs), so fail the compile.
      throw new Error(
        `copy-static: failed to copy ${from} -> ${to}: ${retryErr.message} (first attempt: ${firstErr.message})`
      );
    }
  }
}

// Copy static renderer files
const rendererSrcDir = path.join(ROOT, 'src', 'renderer');
const rendererOutDir = path.join(ROOT, '.compiled', 'src', 'renderer');

const filesToCopy = [
  'exports-shim.js',
  'toolbar.html', 'toolbar.css',
  'standalone.html', 'standalone.css', 'standalone-overrides.css', 'standalone.js',
  'frame-backdrop.html', 'frame-backdrop.css',
  'antifan-logo.jpg'
];
for (const file of filesToCopy) {
  const src = path.join(rendererSrcDir, file);
  const dst = path.join(rendererOutDir, file);
  if (fs.existsSync(src)) {
    safeCopyFile(src, dst);
  }
}

// Prepend exports fallback to compiled renderer JS files to avoid inline script requirement
const jsFiles = ['toolbar.js', 'frame-backdrop.js'];
for (const jsFile of jsFiles) {
  const dst = path.join(rendererOutDir, jsFile);
  if (fs.existsSync(dst)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const original = fs.readFileSync(dst, 'utf8');
        if (!original.startsWith('var exports = exports || {};')) {
          fs.writeFileSync(dst, 'var exports = exports || {};\n' + original, 'utf8');
        }
        break;
      } catch (err) {
        // Giving up silently ships a renderer file without its exports fallback.
        if (attempt === 2) {
          throw new Error(`copy-static: could not prepend the exports fallback to ${dst}: ${err.message}`);
        }
      }
    }
  }
}
// Ship the shared TerminalWriteDispatcher to the standalone renderer as a classic-script
// global (standalone.html loads classic scripts; it cannot `import` the compiled CJS module).
const sharedSrcDir = path.join(ROOT, '.compiled', 'src', 'shared');
const dispatcherDst = path.join(rendererOutDir, 'terminal-write-dispatcher.js');
const dispatcherSrc = path.join(sharedSrcDir, 'terminal-write-dispatcher.js');
if (fs.existsSync(dispatcherSrc)) {
  const dispatcherRaw = fs.readFileSync(dispatcherSrc, 'utf8');
  const dispatcherWrapped =
    'var exports = exports || {};\nvar module = { exports: exports };\n' +
    dispatcherRaw +
    '\nwindow.TerminalWriteDispatcher = exports.TerminalWriteDispatcher;\nwindow.globalTerminalWriteDispatcher = exports.globalTerminalWriteDispatcher;\n';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(dispatcherDst, dispatcherWrapped, 'utf8');
      break;
    } catch (err) {
      // A running Electron window holds files under .compiled/ open, so a lock here is transient.
      if (attempt === 2) {
        throw new Error(`copy-static: could not write the shared dispatcher to ${dispatcherDst}: ${err.message}`);
      }
    }
  }
  // The source-tree copy is a developer convenience: the runtime loads the .compiled asset
  // written above, so a read-only src/ (container mount, locked checkout) must not fail the build.
  const srcDst = path.join(rendererSrcDir, 'terminal-write-dispatcher.js');
  try {
    fs.writeFileSync(srcDst, dispatcherWrapped, 'utf8');
  } catch (err) {
    console.warn(`[antifan] copy-static: skipped the source-tree dispatcher copy (${srcDst}): ${err.message}`);
  }
}
// Copy scripts to .compiled/scripts for standalone deployment
const scriptsSrcDir = path.join(ROOT, 'scripts');
const scriptsOutDir = path.join(ROOT, '.compiled', 'scripts');
const scriptsToCopy = ['antifan-agent.cjs', 'antifan-agent.cmd', 'antifan-omp-mcp.cjs', 'dev-watcher-helpers.mjs'];
for (const scriptFile of scriptsToCopy) {
  const src = path.join(scriptsSrcDir, scriptFile);
  const dst = path.join(scriptsOutDir, scriptFile);
  if (fs.existsSync(src)) {
    safeCopyFile(src, dst);
  }
}
console.log('[antifan] Copied static renderer assets.');

