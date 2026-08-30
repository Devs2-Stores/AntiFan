import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const shimSrcC = path.join(rootDir, 'scripts', 'native-host-shim', 'main.c');
const shimSrcCs = path.join(rootDir, 'scripts', 'native-host-shim', 'Program.cs');
const binDir = path.join(rootDir, 'bin');
const outExe = path.join(binDir, 'antifan-bridge-host.exe');

if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

export function buildNativeHostShim() {
  console.log('[NativeHostShim] Checking build requirements for antifan-bridge-host.exe...');
  try { if (fs.existsSync(outExe)) fs.unlinkSync(outExe); } catch {}

  // 1. Check for MSVC (cl.exe)
  try {
    execFileSync('cl.exe', ['/help'], { stdio: 'ignore' });
    console.log('[NativeHostShim] Compiling main.c using MSVC cl.exe...');
    execFileSync('cl.exe', [
      '/O2',
      '/Fe:' + outExe,
      shimSrcC,
      '/link',
      '/SUBSYSTEM:WINDOWS',
      'user32.lib',
      'kernel32.lib',
      'advapi32.lib'
    ], { cwd: binDir, stdio: 'inherit' });
    if (fs.existsSync(outExe)) {
      console.log(`[NativeHostShim] Successfully built via MSVC: ${outExe}`);
      return true;
    }
  } catch {}

  // 2. Check for MinGW/GCC (gcc.exe)
  try {
    execFileSync('gcc.exe', ['--version'], { stdio: 'ignore' });
    execFileSync('gcc.exe', [
      '-O2',
      '-mwindows',
      '-o', outExe,
      shimSrcC
    ], { cwd: binDir, stdio: 'inherit' });
    if (fs.existsSync(outExe)) {
      console.log(`[NativeHostShim] Successfully built via GCC: ${outExe}`);
      return true;
    }
  } catch {}

  // 3. Check for Clang (clang.exe)
  try {
    execFileSync('clang.exe', ['--version'], { stdio: 'ignore' });
    execFileSync('clang.exe', [
      '-O2',
      '-mwindows',
      '-o', outExe,
      shimSrcC
    ], { cwd: binDir, stdio: 'inherit' });
    if (fs.existsSync(outExe)) {
      console.log(`[NativeHostShim] Successfully built via Clang: ${outExe}`);
      return true;
    }
  } catch {}
  // 4. Check for Windows built-in C# Compiler (csc.exe)
  const cscCandidates = [
    'csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];

  for (const cscPath of cscCandidates) {
    try {
      if (cscPath.includes('\\') && !fs.existsSync(cscPath)) continue;
      console.log(`[NativeHostShim] Compiling Program.cs using Windows .NET compiler (${cscPath})...`);
      execFileSync(cscPath, [
        '/target:exe',
        '/optimize+',
        '/platform:anycpu',
        `/out:${outExe}`,
        shimSrcCs,
      ], { cwd: binDir, stdio: 'inherit' });

      if (fs.existsSync(outExe)) {
        console.log(`[NativeHostShim] Successfully built native PE binary: ${outExe}`);
        return true;
      }
    } catch (err) {
      console.warn(`[NativeHostShim] csc build failed with ${cscPath}:`, err.message);
    }
  }

  console.error('[NativeHostShim] Error: No C/C# compiler found in PATH or Windows .NET Framework.');
  return false;
}

if (process.argv[1] === __filename) {
  const ok = buildNativeHostShim();
  if (!ok) {
    process.exit(1);
  }
}
