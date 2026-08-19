/**
 * Antigravity Browser Desktop — Windows Shortcut Installer
 * Creates Desktop & Start Menu shortcuts with high-res icon and clean background execution.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const iconIco = path.join(ROOT, 'assets', 'icon.ico');
const userHome = os.homedir();
const desktopDir = path.join(userHome, 'Desktop');
const startMenuDir = path.join(userHome, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs');

console.log('[installer] Verifying prerequisites...');

if (!fs.existsSync(electronExe)) {
  console.error('[installer] Error: electron.exe not found at', electronExe);
  process.exit(1);
}

if (!fs.existsSync(iconIco)) {
  console.log('[installer] Generating icons...');
  try {
    execSync('python scripts/generate-icon.py', { cwd: ROOT, stdio: 'inherit' });
  } catch (err) {
    console.error('[installer] Failed to generate icon:', err);
  }
}

// Compile latest code
console.log('[installer] Compiling project...');
execSync('npm run compile', { cwd: ROOT, stdio: 'inherit' });

function createWindowsShortcut(shortcutPath, targetPath, args, workingDir, iconPath, description) {
  const psScript = `
$WshShell = New-Object -comObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
$Shortcut.TargetPath = '${targetPath.replace(/'/g, "''")}'
$Shortcut.Arguments = '${args.replace(/'/g, "''")}'
$Shortcut.WorkingDirectory = '${workingDir.replace(/'/g, "''")}'
$Shortcut.IconLocation = '${iconPath.replace(/'/g, "''")}, 0'
$Shortcut.Description = '${description.replace(/'/g, "''")}'
$Shortcut.Save()
`;
  const tempPs1 = path.join(ROOT, 'scripts', '_temp_create_shortcut.ps1');
  fs.writeFileSync(tempPs1, psScript, 'utf8');
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempPs1}"`, { stdio: 'inherit' });
    console.log(`[installer] Created shortcut: ${shortcutPath}`);
  } finally {
    if (fs.existsSync(tempPs1)) {
      fs.unlinkSync(tempPs1);
    }
  }
}

// 1. Create Desktop Shortcut
const desktopShortcut = path.join(desktopDir, 'Antigravity Browser.lnk');
createWindowsShortcut(
  desktopShortcut,
  electronExe,
  `"${ROOT}" --production`,
  ROOT,
  iconIco,
  'Antigravity Browser Desktop'
);

// 2. Create Start Menu Shortcut
if (fs.existsSync(startMenuDir)) {
  const startMenuShortcut = path.join(startMenuDir, 'Antigravity Browser.lnk');
  createWindowsShortcut(
    startMenuShortcut,
    electronExe,
    `"${ROOT}" --production`,
    ROOT,
    iconIco,
    'Antigravity Browser Desktop'
  );
}

// 3. Create a silent runner script in project root for quick access
const silentVbs = path.join(ROOT, 'run-antigravity.vbs');
const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.CurrentDirectory = "${ROOT.replace(/\\/g, '\\\\')}"\nWshShell.Run """${electronExe.replace(/\\/g, '\\\\')}"" """${ROOT.replace(/\\/g, '\\\\')}""" --production", 0, False\n`;
fs.writeFileSync(silentVbs, vbsContent, 'utf8');
console.log(`[installer] Created root launcher: ${silentVbs}`);

console.log('\n[installer] SUCCESS! Antigravity Browser is now installed on Windows.');
console.log('You can now double-click the "Antigravity Browser" icon on your Desktop or Start Menu to open the App!');
