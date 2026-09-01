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

  // Also synchronize to the permanent %LOCALAPPDATA%\AntiFan\extension directory if on Windows
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const permanentExtDir = path.join(localAppData, 'AntiFan', 'extension');
    try {
      if (!fs.existsSync(permanentExtDir)) {
        fs.mkdirSync(permanentExtDir, { recursive: true });
      }
      const extSrcDir = path.join(rootDir, 'extension');
      const copyRecursive = (src, dest) => {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            copyRecursive(srcPath, destPath);
          } else if (entry.isFile()) {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      };
      copyRecursive(extSrcDir, permanentExtDir);
      console.log(`[build:extension] Synced extension bundle to permanent directory: ${permanentExtDir}`);
    } catch (copyErr) {
      console.warn('[build:extension] Notice: Could not sync to permanent AppData extension dir:', copyErr?.message || copyErr);
    }
  }
}

buildExtension().catch((err) => {
  console.error('[build:extension] Build failed:', err);
  process.exit(1);
});
