import * as esbuild from 'esbuild';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function buildExtension() {
  const entryPoint = path.join(rootDir, 'src', 'extension', 'background.ts');
  const outfile = path.join(rootDir, 'extension', 'background.js');

  console.log(`[build:extension] Bundling ${entryPoint} -> ${outfile}...`);

  await esbuild.build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110'],
    treeShaking: true,
    sourcemap: false,
    minify: false,
  });

  const stats = fs.statSync(outfile);
  console.log(`[build:extension] Successfully generated extension/background.js (${stats.size} bytes).`);
}

buildExtension().catch((err) => {
  console.error('[build:extension] Build failed:', err);
  process.exit(1);
});
