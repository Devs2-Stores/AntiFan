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
  const targetDir = path.join(artifactsDir, 'AntiFan-Browser-Desktop-win32-x64');
  if (fs.existsSync(targetDir)) {
    console.log('[package] Cleaning existing target directory:', targetDir);
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

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
      unpack: '*.node',
      unpackDir: '{node_modules/node-pty,.compiled/src/main/native-messaging,.compiled/src/main/config,.compiled/src/main/security}',
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
  // Ensure node-pty native binaries are unpacked into app.asar.unpacked
  const unpackedNodePtyDir = path.join(outDir, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty');
  const srcNodePtyDir = path.join(ROOT, 'node_modules', 'node-pty');
  const unpackedWin32X64 = path.join(unpackedNodePtyDir, 'prebuilds', 'win32-x64');
  fs.mkdirSync(unpackedWin32X64, { recursive: true });

  const srcWin32X64 = path.join(srcNodePtyDir, 'prebuilds', 'win32-x64');
  if (fs.existsSync(srcWin32X64)) {
    fs.cpSync(srcWin32X64, unpackedWin32X64, { recursive: true });
  }
  const srcBuildRelease = path.join(srcNodePtyDir, 'build', 'Release');
  if (fs.existsSync(srcBuildRelease)) {
    const unpackedBuildRelease = path.join(unpackedNodePtyDir, 'build', 'Release');
    fs.mkdirSync(unpackedBuildRelease, { recursive: true });
    fs.cpSync(srcBuildRelease, unpackedBuildRelease, { recursive: true });
  }

  // Assert required native win32-x64 node-pty addons exist
  const requiredAddons = ['pty.node', 'conpty.node', 'conpty_console_list.node'];
  for (const addon of requiredAddons) {
    const addonPath = path.join(unpackedWin32X64, addon);
    if (!fs.existsSync(addonPath)) {
      throw new Error(`[package] Required native addon missing in packaged build: ${addonPath}`);
    }
    const addonStat = fs.statSync(addonPath);
    console.log(`[package] Verified native addon: ${addon} (${addonStat.size} bytes)`);
  }
  // Ensure native messaging runner and its required config files exist in app.asar.unpacked
  const unpackedCompiledDir = path.join(outDir, 'resources', 'app.asar.unpacked', '.compiled', 'src', 'main');
  const srcCompiledDir = path.join(ROOT, '.compiled', 'src', 'main');

  const dirsToUnpack = ['native-messaging', 'config', 'security'];
  for (const dirName of dirsToUnpack) {
    const srcDir = path.join(srcCompiledDir, dirName);
    const destDir = path.join(unpackedCompiledDir, dirName);
    if (fs.existsSync(srcDir)) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.cpSync(srcDir, destDir, { recursive: true });
      console.log(`[package] Copied unpacked main module: ${dirName} -> ${destDir}`);
    }
  }

  // Copy native host binary antifan-bridge-host.exe to package root
  const srcBridgeHostExe = path.join(ROOT, 'bin', 'antifan-bridge-host.exe');
  const destBridgeHostExe = path.join(outDir, 'antifan-bridge-host.exe');
  if (fs.existsSync(srcBridgeHostExe)) {
    fs.copyFileSync(srcBridgeHostExe, destBridgeHostExe);
    console.log(`[package] Copied native host binary to package root: ${destBridgeHostExe}`);
  } else {
    throw new Error(`[package] Missing required host binary: ${srcBridgeHostExe}. Build it first!`);
  }

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
