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

const filesToCopy = ['toolbar.html', 'toolbar.css', 'sidebar.html', 'sidebar.css', 'terminal.html', 'terminal.css'];
for (const file of filesToCopy) {
  const src = path.join(rendererSrcDir, file);
  const dst = path.join(rendererOutDir, file);
  if (fs.existsSync(src)) {
    safeCopyFile(src, dst);
  }
}

console.log('[antifan] Copied static renderer assets.');