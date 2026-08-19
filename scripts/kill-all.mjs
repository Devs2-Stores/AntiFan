import { execSync } from 'node:child_process';

try {
  if (process.platform === 'win32') {
    execSync('taskkill /F /IM electron.exe', { stdio: 'ignore' });
  }
} catch {}

console.log('Cleaned all electron processes.');
