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
// Same override the Electron probes and e2e drivers honor, so an isolated build tree
// (`tsc --outDir <dir>`) can be completed with its static assets.
const COMPILED_ROOT = process.env.ANTIFAN_COMPILED_ROOT
  ? path.resolve(process.env.ANTIFAN_COMPILED_ROOT)
  : path.join(ROOT, '.compiled');
const rendererSrcDir = path.join(ROOT, 'src', 'renderer');
const rendererOutDir = path.join(COMPILED_ROOT, 'src', 'renderer');

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
  // A listed source that is missing must fail the compile: silently skipping it is
  // how the standalone renderer assets vanished from packaged builds unnoticed.
  if (!fs.existsSync(src)) {
    throw new Error(`copy-static: filesToCopy source is missing: ${src}`);
  }
  safeCopyFile(src, dst);
}

// The toolbar renderer is a classic script with no `require`, so a value
// `import` in toolbar.ts can never resolve at runtime. Inline the compiled
// shared checklist module into toolbar.js instead: it runs before the toolbar
// body and binds its exports to `ThemeChecklistShared`, the ambient name
// toolbar.ts reads through `themeShared()`. The eval-based jsdom harnesses
// inherit the binding for free — no extra script tag or require shim needed.
const themeChecklistPrelude = (() => {
  const sharedSrc = path.join(COMPILED_ROOT, 'src', 'shared', 'theme-checklist.js');
  if (!fs.existsSync(sharedSrc)) return '';
  const sharedRaw = fs.readFileSync(sharedSrc, 'utf8');
  return '(function() {\n' +
    'var module = { exports: {} };\n' +
    'var exports = module.exports;\n' +
    sharedRaw + '\n' +
    'window.ThemeChecklistShared = module.exports;\n' +
    '})();\n';
})();

// Prepend exports fallback to compiled renderer JS files to avoid inline script requirement
const jsFiles = ['toolbar.js', 'frame-backdrop.js'];
for (const jsFile of jsFiles) {
  const dst = path.join(rendererOutDir, jsFile);
  if (fs.existsSync(dst)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const original = fs.readFileSync(dst, 'utf8');
        const prelude = jsFile === 'toolbar.js' ? themeChecklistPrelude : '';
        if (!original.startsWith('var exports = exports || {};')) {
          fs.writeFileSync(dst, 'var exports = exports || {};\n' + prelude + original, 'utf8');
        } else if (prelude && !original.includes('window.ThemeChecklistShared = module.exports;')) {
          // Already-guarded emit from before this rule existed: splice the
          // prelude in directly under the guard line.
          const guard = 'var exports = exports || {};\n';
          fs.writeFileSync(dst, guard + prelude + original.slice(guard.length), 'utf8');
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

// Ship shared modules to the standalone renderer as classic-script globals
// (standalone.html loads classic scripts; it cannot `import` the compiled CJS module).
const sharedSrcDir = path.join(COMPILED_ROOT, 'src', 'shared');
for (const spec of [
  { file: 'terminal-write-dispatcher.js', globals: ['TerminalWriteDispatcher', 'globalTerminalWriteDispatcher'] },
  { file: 'session-activity.js', globals: ['SessionActivityTracker', 'sessionActivityLevel'] },
]) {
  const sharedDst = path.join(rendererOutDir, spec.file);
  const sharedSrc = path.join(sharedSrcDir, spec.file);
  if (!fs.existsSync(sharedSrc)) continue;
  const sharedRaw = fs.readFileSync(sharedSrc, 'utf8');
  const sharedWrapped =
    'var exports = exports || {};\nvar module = { exports: exports };\n' +
    sharedRaw +
    spec.globals.map((name) => `\nwindow.${name} = exports.${name};`).join('') + '\n';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(sharedDst, sharedWrapped, 'utf8');
      break;
    } catch (err) {
      // A running Electron window holds files under .compiled/ open, so a lock here is transient.
      if (attempt === 2) {
        throw new Error(`copy-static: could not write the shared module to ${sharedDst}: ${err.message}`);
      }
    }
  }
  // The source-tree copy is a developer convenience for the default `.compiled` loop; an
  // isolated build (ANTIFAN_COMPILED_ROOT set) must not mutate the source tree at all.
  if (!process.env.ANTIFAN_COMPILED_ROOT) {
    const srcDst = path.join(rendererSrcDir, spec.file);
    try {
      fs.writeFileSync(srcDst, sharedWrapped, 'utf8');
    } catch (err) {
      console.warn(`[antifan] copy-static: skipped the source-tree shared-module copy (${srcDst}): ${err.message}`);
    }
  }
}
// Copy scripts to .compiled/scripts for standalone deployment
const scriptsSrcDir = path.join(ROOT, 'scripts');
const scriptsOutDir = path.join(COMPILED_ROOT, 'scripts');
const scriptsToCopy = ['antifan-agent.cjs', 'antifan-agent.cmd', 'antifan-omp-mcp.cjs', 'dev-watcher-helpers.mjs'];
for (const scriptFile of scriptsToCopy) {
  const src = path.join(scriptsSrcDir, scriptFile);
  const dst = path.join(scriptsOutDir, scriptFile);
  if (!fs.existsSync(src)) {
    throw new Error(`copy-static: scriptsToCopy source is missing: ${src}`);
  }
  safeCopyFile(src, dst);
}
console.log('[antifan] Copied static renderer assets.');

