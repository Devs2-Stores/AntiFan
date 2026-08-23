import { WebContents } from 'electron';

const GOOGLE_AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'oauth2.googleapis.com',
]);

export function getChromeVersion(): string {
  return process.versions.chrome || '134.0.6998.35';
}

export function getChromeMajorVersion(): string {
  return getChromeVersion().split('.')[0] || '134';
}

export function isGoogleAuthUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return GOOGLE_AUTH_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

export function googleAuthUserAgent(): string {
  const version = getChromeVersion();
  const platform = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

export function setChromeClientHints(headers: Record<string, string>): void {
  const major = getChromeMajorVersion();
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  
  // Set genuine Google Chrome Sec-CH-UA headers matching real desktop Chrome
  headers['sec-ch-ua'] = `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not?A_Brand";v="24"`;
  headers['sec-ch-ua-mobile'] = '?0';
  headers['sec-ch-ua-platform'] = `"${platform}"`;
}

export function setGoogleAuthClientHints(headers: Record<string, string>): void {
  setChromeClientHints(headers);
}

export function stripClientHints(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith('sec-ch-ua')) {
      delete headers[key];
    }
  }
}

export function setUserAgentHeader(headers: Record<string, string>, value: string): void {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === 'user-agent') || 'User-Agent';
  headers[key] = value;
}

export async function applyGoogleAuthIdentity(contents: WebContents, url: string, baseUserAgent: string): Promise<void> {
  if (contents.isDestroyed()) return;
  if (!contents.debugger.isAttached()) return;
  await contents.debugger.sendCommand('Emulation.setUserAgentOverride', {
    userAgent: isGoogleAuthUrl(url) ? googleAuthUserAgent() : baseUserAgent,
  }).catch(() => {});
}

export async function cleanCorruptedGoogleCookies(_ses: Electron.Session): Promise<void> {
  // No-op to preserve active user Google login sessions
}
