import { getDomain } from 'tldts';

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

export function isCookieInScope(
  cookie: { domain?: string | null; name?: string; path?: string },
  enabledProfiles: string[] = ['google', 'ecommerce'],
  activeTabHostname: string | null = null,
  customDomains: string[] = []
): boolean {
  const rawDomain = (cookie.domain || '').replace(/^\./, '').trim().toLowerCase();
  if (!rawDomain) return false;
  // 0. Wildcard or all profiles enabled
  if (enabledProfiles.includes('all') || enabledProfiles.includes('*')) {
    return true;
  }

  // 1. Active Tab eTLD+1 Isolation
  if (activeTabHostname) {
    const activeRoot = extractEtldPlusOne(activeTabHostname);
    const cookieRoot = extractEtldPlusOne(rawDomain);
    if (activeRoot && (activeRoot === cookieRoot || rawDomain === activeRoot || rawDomain.endsWith('.' + activeRoot))) {
      return true;
    }
  }

  // 2. Pre-configured Domain Profiles (Google, E-Commerce platforms)
  for (const profile of enabledProfiles) {
    const patterns = SCOPE_PROFILES[profile];
    if (patterns && patterns.some(pattern => pattern.test(rawDomain))) {
      return true;
    }
  }

  // 3. Custom user-defined domains
  for (const custom of customDomains) {
    const cleanCustom = custom.replace(/^\./, '').trim().toLowerCase();
    if (cleanCustom && (rawDomain === cleanCustom || rawDomain.endsWith('.' + cleanCustom))) {
      return true;
    }
  }

  return false;
}
