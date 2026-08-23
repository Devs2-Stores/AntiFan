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
  } catch (err) {
    try {
      fs.copyFileSync(from, to);
    } catch {}
  }
}

// Copy static renderer files
const rendererSrcDir = path.join(ROOT, 'src', 'renderer');
const rendererOutDir = path.join(ROOT, '.compiled', 'src', 'renderer');

const filesToCopy = [
  'toolbar.html', 'toolbar.css',
  'terminal.html', 'terminal.css',
  'standalone.html', 'standalone.css', 'standalone-overrides.css', 'standalone.js',
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
const jsFiles = ['toolbar.js', 'terminal.js'];
for (const jsFile of jsFiles) {
  const dst = path.join(rendererOutDir, jsFile);
  if (fs.existsSync(dst)) {
    const original = fs.readFileSync(dst, 'utf8');
    if (!original.startsWith('var exports = exports || {};')) {
      fs.writeFileSync(dst, 'var exports = exports || {};\n' + original, 'utf8');
    }
  }
}

console.log('[antifan] Copied static renderer assets.');

