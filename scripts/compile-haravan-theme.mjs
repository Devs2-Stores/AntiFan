/**
 * Runner: Compile Hop Long Tech into Haravan OS 2.0 Theme
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const htmlPath = path.join(rootDir, 'clone', 'hoplongtech', 'index.html');
  const rawHtml = fs.readFileSync(htmlPath, 'utf-8');
  const outputDir = path.join(rootDir, 'dist', 'haravan-theme');

  console.log('[Theme Compiler] Compiling Haravan OS 2.0 Theme to:', outputDir);

  // Dynamic import of compiled site-clone package or direct execution
  const { ThemeCompiler } = await import('../packages/site-clone/dist/index.js').catch(async () => {
    // If not built to dist, run with dynamic module loader
    return import('../packages/site-clone/dist/generators/theme-compiler.js');
  });

  const compiler = new ThemeCompiler();
  compiler.compileTheme(outputDir, rawHtml);

  // Copy CSS assets
  const srcCss = path.join(rootDir, 'clone', 'hoplongtech', 'css');
  const destAssets = path.join(outputDir, 'assets');
  if (fs.existsSync(srcCss)) {
    const files = fs.readdirSync(srcCss);
    for (const f of files) {
      fs.copyFileSync(path.join(srcCss, f), path.join(destAssets, f));
    }
  }

  console.log('[Theme Compiler] Successfully compiled Haravan Theme OS 2.0 structure!');
  const generatedFiles = fs.readdirSync(outputDir, { recursive: true });
  console.log('[Theme Compiler] Generated files count:', generatedFiles.length);
}

main().catch(err => {
  console.error('[Theme Compiler Error]:', err);
  process.exit(1);
});
