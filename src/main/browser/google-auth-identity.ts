import { WebContents } from 'electron';

const GOOGLE_AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'oauth2.googleapis.com',
]);

export function getChromeVersion(): string {
  return process.versions.chrome || '150.0.7871.224';
}

export function getChromeMajorVersion(): string {
  return getChromeVersion().split('.')[0] || '150';
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
  
  // Set Chromium Client Hints aligned with real Google Chrome desktop policy
  headers['sec-ch-ua'] = `"Chromium";v="${major}", "Not=A?Brand";v="24", "Google Chrome";v="${major}"`;
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

export function isGoogleDomain(domain?: string): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase().replace(/^\./, '');
  if (
    d === 'google.com' || d.endsWith('.google.com') ||
    d === 'google.com.vn' || d.endsWith('.google.com.vn') ||
    d === 'google.vn' || d.endsWith('.google.vn') ||
    d === 'googleadservices.com' || d.endsWith('.googleadservices.com') ||
    d === 'doubleclick.net' || d.endsWith('.doubleclick.net') ||
    d === 'youtube.com' || d.endsWith('.youtube.com') ||
    d === 'gstatic.com' || d.endsWith('.gstatic.com') ||
    d === 'googleapis.com' || d.endsWith('.googleapis.com') ||
    d === 'googleusercontent.com' || d.endsWith('.googleusercontent.com') ||
    d === '1e100.net' || d.endsWith('.1e100.net') ||
    d === 'gvt1.com' || d.endsWith('.gvt1.com') ||
    d === 'googlevideo.com' || d.endsWith('.googlevideo.com')
  ) {
    return true;
  }
  // Check international Google domains (e.g. google.co.uk, google.de, google.fr, google.com.sg, etc.)
  return /(^|\.)google\.(com?(\.[a-z]{2})?|[a-z]{2})$/i.test(d);
}

export function isGoogleUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return isGoogleDomain(hostname);
  } catch {
    return false;
  }
}
