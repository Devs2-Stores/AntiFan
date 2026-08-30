import { WebContents, Session } from 'electron';

const GOOGLE_AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
]);
export function getChromeVersion(): string {
  return process.versions.chrome || '150.0.7871.224';
}

export function getChromeMajorVersion(): string {
  return getChromeVersion().split('.')[0] || '150';
}

export function isGoogleAuthUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();

    // 1. Direct Google Auth hostnames
    if (GOOGLE_AUTH_HOSTS.has(hostname)) return true;

    // 2. Google domain authentication flows (Gmail, Drive, Docs, Workspace, etc.)
    if (isGoogleDomain(hostname)) {
      if (
        pathname.includes('/signin') ||
        pathname.includes('/servicelogin') ||
        pathname.includes('/accountchooser') ||
        pathname.includes('/identifier') ||
        pathname.includes('/v3/signin') ||
        pathname.includes('/o/oauth2') ||
        search.includes('flowname=glifwebsignin') ||
        search.includes('flowname=weblitesignin') ||
        search.includes('flowentry=') ||
        search.includes('service=mail') ||
        search.includes('service=accountsettings') ||
        search.includes('continue=https%3a%2f%2fmail.google.com') ||
        search.includes('continue=https://mail.google.com')
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

export function chromeSessionUserAgent(): string {
  const version = getChromeVersion();
  const platform = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

export function googleAuthUserAgent(): string {
  return chromeSessionUserAgent();
}

export function buildChromeClientHints(ua: string): { secChUa: string; secChUaFull: string } | null {
  const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
  if (!chromeMatch || !chromeMatch[1]) return null;
  const fullChromeVersion = chromeMatch[1];
  const majorVersion = fullChromeVersion.split('.')[0] || '150';
  let brand = 'Google Chrome';
  let brandFullVersion = fullChromeVersion;
  const edgeMatch = ua.match(/Edg\/([\d.]+)/);
  if (edgeMatch && edgeMatch[1]) {
    brand = 'Microsoft Edge';
    brandFullVersion = edgeMatch[1];
  }
  const brandMajor = brandFullVersion.split('.')[0] || majorVersion;
  return {
    secChUa: `"${brand}";v="${brandMajor}", "Chromium";v="${majorVersion}", "Not/A)Brand";v="24"`,
    secChUaFull: `"${brand}";v="${brandFullVersion}", "Chromium";v="${fullChromeVersion}", "Not/A)Brand";v="24.0.0.0"`
  };
}

export function setChromeClientHints(headers: Record<string, string>): void {
  const major = getChromeMajorVersion();
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  headers['sec-ch-ua'] = `"Chromium";v="${major}", "Not=A?Brand";v="24", "Google Chrome";v="${major}"`;
  headers['sec-ch-ua-mobile'] = '?0';
  headers['sec-ch-ua-platform'] = `"${platform}"`;
}

export function setGoogleAuthClientHints(headers: Record<string, string>): void {
  setChromeClientHints(headers);
}

export function stripClientHints(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith('sec-ch-')) {
      delete headers[key];
    }
  }
}

export function setUserAgentHeader(headers: Record<string, string>, value: string): void {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === 'user-agent') || 'User-Agent';
  headers[key] = value;
}

export function setupClientHintsOverride(sess: Session, ua?: string): void {
  const defaultUa = ua || chromeSessionUserAgent();
  const chromeHints = buildChromeClientHints(defaultUa);

  sess.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    const headers = details.requestHeaders;

    if (chromeHints) {
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === 'sec-ch-ua') headers[key] = chromeHints.secChUa;
        else if (lower === 'sec-ch-ua-full-version-list') headers[key] = chromeHints.secChUaFull;
      }
    }
    callback({ requestHeaders: headers });
  });
}

export const ANTI_DETECTION_SCRIPT = `(function() {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  } catch {}
})();`;

export function applyGoogleAuthIdentity(contents: WebContents | null | undefined, _url: string, baseUserAgent?: string): void {
  if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return;
  const targetUa = baseUserAgent || chromeSessionUserAgent();
  try {
    if (typeof contents.setUserAgent === 'function') {
      const currentUa = typeof contents.getUserAgent === 'function' ? contents.getUserAgent() : undefined;
      if (currentUa !== targetUa) {
        contents.setUserAgent(targetUa);
      }
    }
  } catch (err) {
    console.warn('[google-auth-identity] Failed to set user agent:', err);
  }
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
