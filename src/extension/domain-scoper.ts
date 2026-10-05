import { getDomain } from 'tldts';
import { isIdentityCookieName } from '../shared/identity-cookie-patterns';

export const SCOPE_PROFILES: Record<string, RegExp[]> = {
  google: [
    /(^|\.)google\.com$/,
    /(^|\.)youtube\.com$/,
    /(^|\.)googleusercontent\.com$/,
    /(^|\.)accounts\.google\.com$/,
    /(^|\.)gstatic\.com$/,
    /(^|\.)google\.com\.vn$/,
  ],
  ecommerce: [
    /(^|\.)haravan\.com$/,
    /(^|\.)myharavan\.com$/,
    /(^|\.)myshopify\.com$/,
    /(^|\.)shopify\.com$/,
    /(^|\.)shopifycloud\.com$/,
    /(^|\.)sapo\.vn$/,
    /(^|\.)mysapo\.net$/,
    /(^|\.)bizweb\.vn$/,
  ],
};

export function extractEtldPlusOne(hostname: string | null | undefined): string | null {
  if (!hostname) return null;
  let cleanHost = hostname.trim().toLowerCase();
  if (cleanHost.startsWith('http://') || cleanHost.startsWith('https://')) {
    try {
      cleanHost = new URL(cleanHost).hostname;
    } catch {
      cleanHost = cleanHost.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    }
  }
  if (cleanHost.startsWith('[')) {
    cleanHost = cleanHost.replace(/^\[/, '').replace(/\](?::\d+)?$/, '');
  } else if (!cleanHost.includes('::') && (cleanHost.match(/:/g) || []).length === 1) {
    cleanHost = cleanHost.replace(/:\d+$/, '');
  }
  // Special case: localhost & loopback IP addresses
  if (cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === '::1') {
    return cleanHost;
  }
  // Check IPv4 address
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(cleanHost)) {
    return cleanHost;
  }
  // Check IPv6 address
  if (cleanHost.includes(':')) {
    return cleanHost;
  }

  // Standard Public Suffix List matching (handles .co.uk, .gov.vn, .myshopify.com, Punycode IDN)
  const rootDomain = getDomain(cleanHost, { allowPrivateDomains: true });
  return rootDomain || cleanHost;
}

export const GOOGLE_AUTH_COOKIE_PATTERNS: readonly RegExp[] = [
  /^(SAPISID|APISID|SSID|HSID|SID|LOGIN_INFO|OSID|SIDCC|ACCOUNT_CHOOSER)$/i,
  /^__Secure-[0-9]?(P?APISID|P?SID|OSID|PSIDCC)$/i,
];

export function isGoogleAuthCookieName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  for (const pattern of GOOGLE_AUTH_COOKIE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

export function isGoogleOrYouTubeDomain(domain?: string | null): boolean {
  if (!domain) return false;
  const clean = domain.replace(/^\./, '').trim().toLowerCase();
  const patterns = SCOPE_PROFILES.google;
  return patterns ? patterns.some((p) => p.test(clean)) : false;
}

export interface CookieScopeOptions {
  allowGoogleAuth?: boolean;
}

export function isCookieInScope(
  cookie: { domain?: string | null; name?: string; path?: string },
  enabledProfiles: string[] = ['google', 'ecommerce'],
  activeTabHostname: string | null = null,
  customDomains: string[] = [],
  options?: CookieScopeOptions
): boolean {
  const rawDomain = (cookie.domain || '').replace(/^\./, '').trim().toLowerCase();
  if (!rawDomain) return false;
  // 0. Identity cookies stay out of scope however the rest of the scope is
  // configured: no profile, wildcard, active-tab match or custom domain may
  // pull an auth cookie into a sync payload.
  if (isIdentityCookieName(cookie.name)) {
    return false;
  }
  // 0.1. Google/YouTube session auth tokens are single-owner per browser instance.
  // Pushing them in the background (periodic auto-hydration, onChanged delta sync)
  // clobbers active SPAs in AntiFan (e.g. YouTube Music "Tài khoản Google đã thay đổi").
  // They are only admitted on deliberate user-initiated actions (popup SYNC_ACTIVE_TAB).
  // Crucially, this check requires the domain to be Google/YouTube so unrelated sites with
  // generic cookie names like 'SID' or 'SSID' are never inadvertently suppressed.
  if (!options?.allowGoogleAuth && isGoogleOrYouTubeDomain(rawDomain) && isGoogleAuthCookieName(cookie.name)) {
    return false;
  }

  // 1. Wildcard or all profiles enabled
  if (enabledProfiles.includes('all') || enabledProfiles.includes('*')) {
    return true;
  }

  // 2. Active Tab eTLD+1 Isolation
  if (activeTabHostname) {
    const activeRoot = extractEtldPlusOne(activeTabHostname);
    const cookieRoot = extractEtldPlusOne(rawDomain);
    if (activeRoot && (activeRoot === cookieRoot || rawDomain === activeRoot || rawDomain.endsWith('.' + activeRoot))) {
      return true;
    }
  }

  // 3. Pre-configured Domain Profiles (Google, E-Commerce platforms)
  for (const profile of enabledProfiles) {
    const patterns = SCOPE_PROFILES[profile];
    if (patterns && patterns.some(pattern => pattern.test(rawDomain))) {
      return true;
    }
  }

  // 4. Custom user-defined domains
  for (const custom of customDomains) {
    const cleanCustom = custom.replace(/^\./, '').trim().toLowerCase();
    if (cleanCustom && (rawDomain === cleanCustom || rawDomain.endsWith('.' + cleanCustom))) {
      return true;
    }
  }

  return false;
}
