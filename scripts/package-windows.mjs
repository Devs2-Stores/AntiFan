import { packager } from '@electron/packager';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function build() {
  console.log('[package] Packaging AntiFan Browser Desktop for win32-x64...');
  
  const artifactsDir = path.join(ROOT, 'plans', '260827-1345-production-cutover-release-hardening', 'reports', 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const appPaths = await packager({
    dir: ROOT,
    out: artifactsDir,
    name: 'AntiFan-Browser-Desktop',
    executableName: 'antifan-browser-desktop',
    platform: 'win32',
    arch: 'x64',
    overwrite: true,
    asar: {
      unpack: '**/node_modules/node-pty/**/*',
    },
    icon: fs.existsSync(path.join(ROOT, 'assets', 'icon.ico')) ? path.join(ROOT, 'assets', 'icon.ico') : undefined,
    ignore: [
      /^\/\.git/,
      /^\/src/,
      /^\/test/,
      /^\/docs/,
      /^\/plans/,
      /^\/\.cursor/,
      /^\/\.vscode/,
      /^\/appdata/,
      /^\/dist/,
      /^\/\.antigravity/,
      /^\/\.compiled\/test/,
      /^\/\.compiled\/scripts/,
      /^\/out/,
      /^\/node_modules\/node-pty\/prebuilds\/darwin-arm64/,
      /^\/node_modules\/node-pty\/prebuilds\/darwin-x64/,
      /^\/node_modules\/node-pty\/prebuilds\/win32-arm64/,
      /\.pdb$/,
      /\.md$/,
      /\.ts$/,
      /\.map$/,
    ],
    prune: true,
    appVersion: pkgJson.version || '1.0.0',
    appCopyright: 'Copyright (C) 2026 AntiFan Team',
  });

  console.log('[package] Successfully packaged to:', appPaths);
  const outDir = appPaths[0];
  const exePath = path.join(outDir, 'antifan-browser-desktop.exe');
  
  if (!fs.existsSync(exePath)) {
    throw new Error(`Expected executable not found at: ${exePath}`);
  }

  const stat = fs.statSync(exePath);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex');

  console.log('[package] Executable details:');
  console.log('  Path:   ', exePath);
  console.log('  Size:   ', stat.size, 'bytes');
  console.log('  SHA-256:', hash);

  let gitRevision = 'unknown';
  try {
    gitRevision = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {}

  // Write artifact manifest
  const manifest = {
    packageName: 'AntiFan-Browser-Desktop-win32-x64',
    outDir,
    exePath,
    appVersion: pkgJson.version || '1.0.0',
    executableSize: stat.size,
    sha256: hash,
    gitRevision,
    builtAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  fs.writeFileSync(path.join(artifactsDir, 'windows-x64-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log('[package] Manifest saved to:', path.join(artifactsDir, 'windows-x64-manifest.json'));

  return manifest;
}

build().catch((err) => {
  console.error('[package] Packaging failed:', err);
  process.exit(1);
});
