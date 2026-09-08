/**
 * Production Network Policy & URL Security Classifier
 * Defines strict boundary rules for local vs external network resources,
 * preventing host-prefix bypasses (e.g. localhost.evil.com) and SSRF risks.
 */

export interface NetworkClassificationResult {
  action: 'allow' | 'block';
  isLocal: boolean;
  hostname?: string;
  port?: string;
  protocol?: string;
  reason?: string;
}

const ALLOWED_LOCAL_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]'
]);

/**
 * Classifies a URL against the strict zero-external-network policy.
 * Uses WHATWG URL parsing with strict hostname boundary checking.
 * Strings like `http://localhost.evil.com` or `http://127.0.0.1.evil.com`
 * are strictly blocked as external domains.
 */
export function classifyNetworkUrl(inputUrl: string): NetworkClassificationResult {
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { action: 'block', isLocal: false, reason: 'EMPTY_OR_INVALID_INPUT' };
  }

  const trimmed = inputUrl.trim();

  // Permitted data and local-memory pseudo protocols
  if (trimmed.startsWith('data:')) {
    return { action: 'allow', isLocal: true, protocol: 'data:', reason: 'DATA_URI' };
  }
  if (trimmed.startsWith('blob:')) {
    return { action: 'allow', isLocal: true, protocol: 'blob:', reason: 'BLOB_URI' };
  }
  if (trimmed.startsWith('about:blank')) {
    return { action: 'allow', isLocal: true, protocol: 'about:', reason: 'ABOUT_BLANK' };
  }

  // Handle file:// protocol (local file access only)
  if (trimmed.startsWith('file://')) {
    try {
      const parsed = new URL(trimmed);
      if (!parsed.hostname || parsed.hostname === 'localhost') {
        return { action: 'allow', isLocal: true, protocol: 'file:', reason: 'LOCAL_FILE' };
      }
      return { action: 'block', isLocal: false, protocol: 'file:', hostname: parsed.hostname, reason: 'REMOTE_FILE_SHARE' };
    } catch {
      return { action: 'block', isLocal: false, protocol: 'file:', reason: 'INVALID_FILE_URL' };
    }
  }

  // Parse HTTP/HTTPS protocols with exact host boundary validation
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();

    if (protocol !== 'http:' && protocol !== 'https:') {
      return { action: 'block', isLocal: false, protocol, reason: 'UNSUPPORTED_PROTOCOL' };
    }

    const rawHostname = parsed.hostname.toLowerCase();
    // Strip trailing dot if present (FQDN)
    const hostname = rawHostname.endsWith('.') ? rawHostname.slice(0, -1) : rawHostname;

    if (ALLOWED_LOCAL_HOSTNAMES.has(hostname)) {
      return {
        action: 'allow',
        isLocal: true,
        protocol,
        hostname,
        port: parsed.port || (protocol === 'http:' ? '80' : '443'),
        reason: 'VERIFIED_LOCAL_HOST'
      };
    }

    return {
      action: 'block',
      isLocal: false,
      protocol,
      hostname,
      port: parsed.port || (protocol === 'http:' ? '80' : '443'),
      reason: 'EXTERNAL_NETWORK_PROHIBITED'
    };
  } catch {
    return { action: 'block', isLocal: false, reason: 'MALFORMED_URL' };
  }
}
