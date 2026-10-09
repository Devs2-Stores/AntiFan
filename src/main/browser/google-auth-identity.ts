import { WebContents, Session } from 'electron';
import * as os from 'node:os';
import { IPHONE_USER_AGENT } from './device-presets';

const GOOGLE_AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
]);
export function getChromeVersion(): string {
  return process.versions.chrome || '150.0.7871.224';
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

interface ChromeBrandVersion {
  brand: string;
  version: string;
}

/**
 * CDP `Emulation.UserAgentMetadata`. An `Emulation.setUserAgentOverride` sent without it makes
 * Chromium drop User-Agent Client Hints entirely (`navigator.userAgentData.brands` is empty, its
 * platform is '', and no `sec-ch-ua*` request header is sent). A Chrome UA string with no hints
 * is the signature of CDP automation, which anti-bot walls such as Shopee's traffic verification
 * reject.
 */
export interface ChromeUserAgentMetadata {
  brands: ChromeBrandVersion[];
  fullVersionList: ChromeBrandVersion[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
}

const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];
const BRAND_ORDERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

/**
 * Chromium's brand list (components/embedder_support/user_agent_utils.cc GenerateBrandVersionList):
 * the GREASE brand's punctuation and version and the order of all three entries are derived from
 * the major version, so a fixed GREASE entry is itself a tell. Measured on this host: Chrome 154
 * reports Chromium, Google Chrome, "Not A(Brand"/99; Electron 150 reports "Not;A=Brand"/8.
 */
function chromeBrandLists(ua: string): Pick<ChromeUserAgentMetadata, 'brands' | 'fullVersionList' | 'fullVersion'> | null {
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
  const seed = Number(majorVersion) || 0;
  const greaseBrand = `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`;
  const greaseVersion = GREASE_VERSIONS[seed % GREASE_VERSIONS.length] ?? '8';
  const order = BRAND_ORDERS[seed % BRAND_ORDERS.length] ?? BRAND_ORDERS[0]!;
  const place = (grease: ChromeBrandVersion, chromium: ChromeBrandVersion, named: ChromeBrandVersion): ChromeBrandVersion[] => {
    const list: ChromeBrandVersion[] = [];
    list[order[0]] = grease;
    list[order[1]] = chromium;
    list[order[2]] = named;
    return list;
  };
  return {
    brands: place({ brand: greaseBrand, version: greaseVersion }, { brand: 'Chromium', version: majorVersion }, { brand, version: brandMajor }),
    fullVersionList: place({ brand: greaseBrand, version: `${greaseVersion}.0.0.0` }, { brand: 'Chromium', version: fullChromeVersion }, { brand, version: brandFullVersion }),
    fullVersion: fullChromeVersion,
  };
}

function formatBrandList(list: ChromeBrandVersion[]): string {
  return list.map((entry) => `"${entry.brand}";v="${entry.version}"`).join(', ');
}

function buildChromeClientHints(ua: string): { secChUa: string; secChUaFull: string } | null {
  const lists = chromeBrandLists(ua);
  if (!lists) return null;
  return { secChUa: formatBrandList(lists.brands), secChUaFull: formatBrandList(lists.fullVersionList) };
}

/**
 * Chromium reports Windows' platformVersion as the Windows.Foundation.UniversalApiContract
 * version (HKLM\SOFTWARE\Microsoft\WindowsRuntime\WellKnownContracts), not the NT version.
 * Each row is the first OS build shipping that contract major; newer builds get the highest row.
 */
const WINDOWS_API_CONTRACT_BY_BUILD: ReadonlyArray<readonly [number, number]> = [
  [26100, 19], [22621, 15], [22000, 14], [19041, 10], [18362, 8], [17763, 7],
  [17134, 6], [16299, 5], [15063, 4], [14393, 3], [10586, 2],
];

export function windowsPlatformVersion(build: number): string {
  const row = WINDOWS_API_CONTRACT_BY_BUILD.find(([firstBuild]) => build >= firstBuild);
  return `${row ? row[1] : 1}.0.0`;
}

function threePartVersion(raw: string): string {
  const match = raw.match(/\d+(?:[._]\d+)*/);
  if (!match) return '';
  const parts = match[0].split(/[._]/).slice(0, 3);
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

function hostPlatformVersion(): string {
  if (process.platform === 'win32') return windowsPlatformVersion(Number(os.release().split('.')[2]) || 0);
  // Electron's getSystemVersion is the macOS product version; os.release() there is the Darwin kernel.
  const raw = process.platform === 'darwin' && typeof process.getSystemVersion === 'function'
    ? process.getSystemVersion()
    : os.release();
  return threePartVersion(raw);
}

function hostArchitecture(): { architecture: string; bitness: string } {
  if (process.arch === 'arm64') return { architecture: 'arm', bitness: '64' };
  if (process.arch === 'arm') return { architecture: 'arm', bitness: '32' };
  if (process.arch === 'ia32') return { architecture: 'x86', bitness: '32' };
  return { architecture: 'x86', bitness: '64' };
}

/**
 * Client Hints matching a Chromium-family UA string, with the same brand list the session's
 * `sec-ch-ua` rewrite sends, so headers and `navigator.userAgentData` agree. A UA for the host's
 * own OS reports the host's real platform version and architecture, as Chrome would. Returns
 * null for UAs without a `Chrome/` token (Safari identities): Safari exposes no Client Hints.
 */
export function chromeUserAgentMetadata(ua: string): ChromeUserAgentMetadata | null {
  const lists = chromeBrandLists(ua);
  if (!lists) return null;
  const android = ua.match(/Android ([\d.]+)/);
  if (android && android[1]) {
    return { ...lists, platform: 'Android', platformVersion: threePartVersion(android[1]), architecture: '', model: '', mobile: /\bMobile\b/.test(ua), bitness: '', wow64: false };
  }
  const platform = /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'macOS' : 'Linux';
  const hostPlatform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  if (platform === hostPlatform) {
    return { ...lists, platform, platformVersion: hostPlatformVersion(), ...hostArchitecture(), model: '', mobile: false, wow64: false };
  }
  const uaVersion = platform === 'Windows'
    ? ua.match(/Windows NT ([\d.]+)/)?.[1]
    : platform === 'macOS' ? ua.match(/Mac OS X ([\d_]+)/)?.[1] : undefined;
  return { ...lists, platform, platformVersion: threePartVersion(uaVersion || ''), architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false };
}

/**
 * Electron's own `sec-ch-ua` names only "Chromium" plus GREASE. A list that already names a
 * browser came from a CDP userAgentMetadata override and matches the page's
 * navigator.userAgentData, so the session rewrite must leave it alone.
 */
const BROWSER_BRAND_PATTERN = /"(?:Google Chrome|Microsoft Edge)"/;

export function setChromeClientHints(headers: Record<string, string>): void {
  const hints = buildChromeClientHints(chromeSessionUserAgent());
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  if (hints) headers['sec-ch-ua'] = hints.secChUa;
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

/**
 * Electron sends no Client Hints on frame navigations: measured on browser- and renderer-initiated
 * document requests, with and without a CDP override, while `fetch` from the same page carries
 * them. Chrome sends the three low-entropy hints on every HTTPS navigation, so a login page's
 * document request without them stands out. They are derived from the request's own User-Agent,
 * which already carries any per-tab CDP override, so they agree with the tab's
 * navigator.userAgentData; a Safari UA gets none, as Safari sends none.
 */
function addNavigationClientHints(headers: Record<string, string>): void {
  let userAgent: string | undefined;
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('sec-ch-ua')) return;
    if (lower === 'user-agent') userAgent = headers[key];
  }
  const metadata = userAgent ? chromeUserAgentMetadata(userAgent) : null;
  if (!metadata) return;
  headers['sec-ch-ua'] = formatBrandList(metadata.brands);
  headers['sec-ch-ua-mobile'] = metadata.mobile ? '?1' : '?0';
  headers['sec-ch-ua-platform'] = `"${metadata.platform}"`;
}

/**
 * Google sign-in rejects Electron at the identifier step ("This browser or app may not be secure",
 * /v3/signin/rejected) whenever the requests to accounts.google.com claim Chrome: measured with no
 * CDP, with the per-tab CDP override with and without userAgentMetadata, and with a Firefox UA. The
 * same tab, CDP override included and navigator.userAgent still Chrome, passes to the account's
 * next challenge when only those requests claim Safari. Safari sends no Client Hints, so they go too.
 * A Safari UA (an iPhone preset) is already accepted and stays as it is; other hosts keep the tab's
 * identity.
 */
const SAFARI_DESKTOP_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

function isGoogleAuthHostUrl(rawUrl: string): boolean {
  try {
    return GOOGLE_AUTH_HOSTS.has(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function presentGoogleSignInAsSafari(headers: Record<string, string>): void {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === 'user-agent');
  const metadata = key ? chromeUserAgentMetadata(headers[key]!) : null;
  if (!metadata) return;
  stripClientHints(headers);
  setUserAgentHeader(headers, metadata.mobile ? IPHONE_USER_AGENT : SAFARI_DESKTOP_USER_AGENT);
}

export function setupClientHintsOverride(sess: Session, ua?: string): void {
  const defaultUa = ua || chromeSessionUserAgent();
  const chromeHints = buildChromeClientHints(defaultUa);

  sess.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    const headers = details.requestHeaders;
    if (isGoogleAuthHostUrl(details.url)) {
      presentGoogleSignInAsSafari(headers);
      callback({ requestHeaders: headers });
      return;
    }
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      addNavigationClientHints(headers);
    }

    if (chromeHints) {
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower !== 'sec-ch-ua' && lower !== 'sec-ch-ua-full-version-list') continue;
        const value = headers[key];
        if (value === undefined || BROWSER_BRAND_PATTERN.test(value)) continue;
        headers[key] = lower === 'sec-ch-ua' ? chromeHints.secChUa : chromeHints.secChUaFull;
      }
    }
    callback({ requestHeaders: headers });
  });
}
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
