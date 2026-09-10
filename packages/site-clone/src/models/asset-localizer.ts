/**
 * Model 2b: Asset Localizer & Pipeline (A1 Downloader, A2 Rewriter, A3 Verifier)
 * 
 * Hardened Security & Correctness Invariants:
 * - Fail-Closed SSRF & DNS Rebinding Protection:
 *     Custom lookup pins validated IP address directly on HTTP/HTTPS agent.
 *     Socket connect hook verifies remoteAddress before sending bytes.
 *     Rejects loopback, link-local, private networks, CGNAT, decimal/hex IP bypasses.
 * - Manual Redirect Policy:
 *     HTTP 3xx redirects are caught and re-evaluated through full SSRF & DNS verification.
 * - Backpressure & Bounded Streaming:
 *     Uses `node:stream/promises` pipeline with custom byte-limiting Transform stream.
 * - Atomic File Transactions:
 *     Writes to unique `.tmp` files and renames only upon complete sha256 verification.
 * - Content-Type & HTML Error Page Guard:
 *     Inspects HTTP header and first buffer chunk; rejects HTML error pages masquerading as images/fonts.
 * - Syntax-Aware Rewriting (A2):
 *     Parses HTML attributes (src, href, data-src, srcset, data-srcset, poster, onerror, inline style).
 *     Parses CSS declarations (url(...), @import) with per-stylesheet raw reference mapping.
 * - Bounded Recursive Stylesheet Dependency Queue:
 *     Carries { localCssPath, sourceUrl, depth } and resolves relative dependencies against each stylesheet's URL.
 *     Enforces max depth cutoff (fails closed if exceeded).
 * - Direct Token Audit Ledger (A3):
 *     Parses all CSS `@import` and `url(...)` tokens directly: every token must match a known localized asset.
 *     Any residual relative traversal (`../`), root-relative (`/`), or remote URL is a hard error.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as dns from 'node:dns';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import type { HarvestedAssetManifest, HarvestedAssetItem } from './asset-harvester.js';

export interface LocalizeAssetOptions {
  assetsDir: string;
  sourceBaseUrl?: string;
  mode?: 'liquid' | 'relative'; // default: 'liquid'
  concurrency?: number; // default: 5
  timeoutMs?: number; // default: 15000
  maxAssetBytes?: number; // default: 50MB (52,428,800 bytes)
  allowedHostnames?: string[];
  skipDownload?: boolean; // if true, bypasses network downloads (useful for offline/pre-cached runs)
}

export interface DownloadTransport {
  request?: (options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) => http.ClientRequest;
  lookup?: (hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }> | any) => void) => void;
}

export interface DownloadedAssetResult {
  sourceUrl: string;
  filename: string;
  localPath: string;
  status: 'downloaded' | 'skipped_cached' | 'skipped_offline' | 'failed';
  byteCount: number;
  sha256?: string;
  mimeType?: string;
  error?: string;
}

export interface RewrittenFileResult {
  path: string;
  replacementCount: number;
  originalContent: string;
  rewrittenContent: string;
}

export interface AssetVerificationItem {
  filename: string;
  localPath: string;
  exists: boolean;
  byteCount: number;
  sha256?: string;
  status: 'valid' | 'missing' | 'zero_byte';
}

export interface AssetAuditFinding {
  severity: 'error' | 'warning';
  code: 'UNLOCALIZED_REMOTE_URL' | 'UNRESOLVED_CSS_DEPENDENCY' | 'MISSING_LOCAL_FILE' | 'ZERO_BYTE_ASSET' | 'DOWNLOAD_FAILED' | 'DEPTH_CUTOFF_EXCEEDED' | 'LINGERING_REMOTE_NETWORK_URL';
  message: string;
  details?: Record<string, unknown>;
}

export interface AssetLocalizationPipelineResult {
  a1_download: {
    downloaded: DownloadedAssetResult[];
    totalBytes: number;
    failedCount: number;
  };
  a2_rewrite: {
    files: RewrittenFileResult[];
    totalReplacements: number;
  };
  a3_audit: {
    verifiedAssets: AssetVerificationItem[];
    findings: AssetAuditFinding[];
    passed: boolean;
    unlocalizedUrls: string[];
  };
}

/**
 * A reference that targets a document-internal fragment rather than a network
 * subresource (SVG paint servers, anchors). Paint-server targets inside embedded
 * SVG data URIs arrive percent-encoded as `url(%23paint0_linear_1)`, so a bare
 * `#` prefix check is not sufficient — such tokens must never be localized.
 */
export function isInternalFragmentRef(ref: string): boolean {
  return ref.startsWith('#') || ref.startsWith('%23');
}

/**
 * Validates whether a target file path strictly resides within the parent directory.
 */
export function isPathContained(targetPath: string, parentDir: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedParent = path.resolve(parentDir);
  const parentPrefix = resolvedParent.endsWith(path.sep) ? resolvedParent : resolvedParent + path.sep;
  return resolvedTarget.startsWith(parentPrefix) || resolvedTarget === resolvedParent;
}

/**
 * Parses integer or hex IP representations into standard dotted IPv4 notation.
 */
export function normalizeIp(hostname: string): string {
  if (/^\d+$/.test(hostname)) {
    const num = parseInt(hostname, 10);
    if (num >= 0 && num <= 0xffffffff) {
      return [
        (num >>> 24) & 255,
        (num >>> 16) & 255,
        (num >>> 8) & 255,
        num & 255
      ].join('.');
    }
  }
  if (/^0x[0-9a-fA-F]+$/i.test(hostname)) {
    const num = parseInt(hostname, 16);
    if (num >= 0 && num <= 0xffffffff) {
      return [
        (num >>> 24) & 255,
        (num >>> 16) & 255,
        (num >>> 8) & 255,
        num & 255
      ].join('.');
    }
  }
  return hostname.toLowerCase();
}

/**
 * Checks if an IP address falls into private, loopback, link-local, or reserved ranges.
 */
export function isPrivateOrReservedIp(ip: string): { blocked: boolean; reason?: string } {
  const clean = ip.trim();

  // IPv4 check
  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
      return { blocked: true, reason: 'INVALID_IPV4' };
    }
    const [a, b] = parts;

    // 0.0.0.0/8 (Current network)
    if (a === 0) return { blocked: true, reason: 'CURRENT_NETWORK_0' };
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return { blocked: true, reason: 'LOOPBACK_127' };
    // 10.0.0.0/8 (Private)
    if (a === 10) return { blocked: true, reason: 'PRIVATE_10' };
    // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return { blocked: true, reason: 'PRIVATE_172' };
    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) return { blocked: true, reason: 'PRIVATE_192' };
    // 169.254.0.0/16 (Link-local & cloud metadata 169.254.169.254)
    if (a === 169 && b === 254) return { blocked: true, reason: 'LINK_LOCAL_METADATA_169_254' };
    // 100.64.0.0/10 (Carrier-Grade NAT: 100.64.0.0 - 100.127.255.255)
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return { blocked: true, reason: 'CGNAT_100' };
    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    if (a !== undefined && a >= 224) return { blocked: true, reason: 'MULTICAST_OR_RESERVED' };

    return { blocked: false };
  }

  // IPv6 check
  if (net.isIPv6(clean)) {
    const lower = clean.toLowerCase();
    if (lower === '::1' || lower === '::') return { blocked: true, reason: 'IPV6_LOOPBACK' };
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return { blocked: true, reason: 'IPV6_LINK_LOCAL' };
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) {
      return { blocked: true, reason: 'IPV6_UNIQUE_LOCAL' };
    }
    if (lower.includes('::ffff:')) {
      const v4part = lower.split('::ffff:')[1];
      if (v4part && net.isIPv4(v4part)) {
        return isPrivateOrReservedIp(v4part);
      }
    }
    return { blocked: false };
  }

  return { blocked: true, reason: 'NOT_VALID_IP' };
}

/**
 * Validates syntax of download URL.
 */
export function isSafeDownloadUrlSyntax(
  rawUrl: string,
  sourceBaseUrl?: string,
  allowedHostnames?: string[]
): { safe: boolean; reason?: string; parsedUrl?: URL } {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { safe: false, reason: 'EMPTY_OR_INVALID_URL' };
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;

  try {
    if (trimmed.startsWith('//')) {
      parsed = new URL(`https:${trimmed}`);
    } else if (sourceBaseUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
      parsed = new URL(trimmed, sourceBaseUrl);
    } else {
      parsed = new URL(trimmed);
    }
  } catch {
    return { safe: false, reason: 'URL_PARSE_FAILED' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `UNSUPPORTED_PROTOCOL: ${parsed.protocol}` };
  }

  const rawHost = parsed.hostname;
  if (!rawHost) {
    return { safe: false, reason: 'MISSING_HOSTNAME' };
  }

  const host = normalizeIp(rawHost);

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '::'
  ) {
    return { safe: false, reason: `LOOPBACK_FORBIDDEN: ${rawHost}` };
  }

  if (net.isIP(host)) {
    const ipCheck = isPrivateOrReservedIp(host);
    if (ipCheck.blocked) {
      return { safe: false, reason: `PRIVATE_IP_FORBIDDEN: ${ipCheck.reason}` };
    }
  }

  if (allowedHostnames && allowedHostnames.length > 0) {
    const isAllowed = allowedHostnames.some(allowed => {
      const cleanAllowed = allowed.toLowerCase().trim();
      return host === cleanAllowed || host.endsWith('.' + cleanAllowed);
    });
    if (!isAllowed) {
      return { safe: false, reason: `HOSTNAME_NOT_IN_ALLOWLIST: ${host}` };
    }
  }

  return { safe: true, parsedUrl: parsed };
}

/**
 * Downloads a URL over raw http/https with IP-pinned DNS lookup, socket connection verification,
 * bounded stream pipeline, and atomic disk writes.
 */
export async function downloadUrlWithPinning(
  targetUrl: string,
  targetLocalPath: string,
  options: {
    sourceBaseUrl?: string;
    allowedHostnames?: string[];
    timeoutMs: number;
    maxAssetBytes: number;
    assetType: 'css' | 'js' | 'image' | 'font';
  },
  transport?: DownloadTransport
): Promise<{ byteCount: number; sha256: string; mimeType: string }> {
  let currentUrl = targetUrl;
  let redirectCount = 0;
  const maxRedirects = 5;

  const assetsDir = path.dirname(targetLocalPath);
  const tmpFilename = `.${path.basename(targetLocalPath)}.${randomBytes(6).toString('hex')}.tmp`;
  const tmpLocalPath = path.join(assetsDir, tmpFilename);

  try {
    while (redirectCount <= maxRedirects) {
      const syntaxCheck = isSafeDownloadUrlSyntax(currentUrl, options.sourceBaseUrl, options.allowedHostnames);
      if (!syntaxCheck.safe || !syntaxCheck.parsedUrl) {
        throw new Error(`SSRF_SYNTAX_REJECTED: ${syntaxCheck.reason}`);
      }

      const parsedUrl = syntaxCheck.parsedUrl;
      const isHttps = parsedUrl.protocol === 'https:';
      const requestFn = (transport?.request || (isHttps ? https.request : http.request)) as (
        reqOpts: http.RequestOptions,
        callback?: (res: http.IncomingMessage) => void
      ) => http.ClientRequest;
      const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (isHttps ? 443 : 80);
      const host = parsedUrl.hostname;

      const pinnedLookup = (
        hostname: string,
        optionsOrCallback: any,
        maybeCallback?: any
      ) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        const options = typeof optionsOrCallback === 'object' && optionsOrCallback !== null ? optionsOrCallback : {};
        const lookupFn = transport?.lookup || dns.lookup;
        lookupFn(hostname, { all: true } as any, (err: any, addresses: any) => {
          if (err) return callback(err, '', 4);
          if (!addresses || addresses.length === 0) {
            return callback(new Error(`DNS_RESOLUTION_EMPTY: ${hostname}`), '', 4);
          }

          for (const addr of addresses) {
            const ipCheck = isPrivateOrReservedIp(addr.address);
            if (ipCheck.blocked) {
              return callback(
                new Error(`SSRF_DNS_REBINDING_BLOCKED: ${hostname} resolved to ${addr.address} (${ipCheck.reason})`),
                '',
                4
              );
            }
          }

          if (options.all) {
            callback(null, addresses);
          } else {
            const selected = addresses[0];
            callback(null, selected.address, selected.family || 4);
          }
        });
      };

      const requestPromise = new Promise<{
        redirectUrl?: string;
        byteCount?: number;
        sha256?: string;
        mimeType?: string;
      }>((resolve, reject) => {
        let settled = false;
        const rejectOnce = (err: Error) => {
          if (settled) return;
          settled = true;
          req.destroy(err);
          reject(err);
        };

        const req = requestFn(
          {
            protocol: parsedUrl.protocol,
            hostname: host,
            port,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            lookup: pinnedLookup,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': '*/*',
              ...(options.sourceBaseUrl ? { 'Referer': options.sourceBaseUrl } : {})
            },
            timeout: options.timeoutMs
          },
          async (res: http.IncomingMessage) => {
            const remoteIp = res.socket?.remoteAddress;
            if (remoteIp) {
              const connectIpCheck = isPrivateOrReservedIp(remoteIp);
              if (connectIpCheck.blocked) {
                return rejectOnce(new Error(`SSRF_CONNECTED_IP_BLOCKED: ${remoteIp} (${connectIpCheck.reason})`));
              }
            }

            const statusCode = res.statusCode || 0;
            if (statusCode >= 300 && statusCode < 400) {
              const locationHeader = res.headers.location;
              if (!locationHeader) {
                return rejectOnce(new Error(`HTTP_REDIRECT_WITHOUT_LOCATION_${statusCode}`));
              }
              res.resume();
              settled = true;
              return resolve({ redirectUrl: new URL(locationHeader, currentUrl).toString() });
            }

            if (statusCode < 200 || statusCode >= 300) {
              res.resume();
              return rejectOnce(new Error(`HTTP_STATUS_${statusCode}`));
            }

            const contentLengthHeader = res.headers['content-length'];
            if (contentLengthHeader) {
              const len = parseInt(contentLengthHeader, 10);
              if (!isNaN(len) && len > options.maxAssetBytes) {
                res.resume();
                return rejectOnce(new Error(`ASSET_EXCEEDS_SIZE_LIMIT: ${len} > ${options.maxAssetBytes}`));
              }
            }

            const contentType = (res.headers['content-type'] || '').toString();
            const hasher = createHash('sha256');
            let byteCount = 0;
            let firstChunk: Buffer | null = null;

            const limiter = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                byteCount += chunk.length;
                if (byteCount > options.maxAssetBytes) {
                  return callback(new Error(`STREAM_EXCEEDED_SIZE_LIMIT: ${byteCount} > ${options.maxAssetBytes}`));
                }
                if (!firstChunk) {
                  firstChunk = Buffer.from(chunk).subarray(0, 128);
                }
                hasher.update(chunk);
                callback(null, chunk);
              }
            });

            const fileStream = fs.createWriteStream(tmpLocalPath);

            try {
              await pipeline(res, limiter, fileStream);

              if (options.assetType === 'image' || options.assetType === 'font') {
                const isHtmlHeader = contentType.toLowerCase().includes('text/html');
                const previewText = firstChunk ? (firstChunk as Buffer).toString('utf8').trim().toLowerCase() : '';
                const isHtmlBody = previewText.startsWith('<!doctype') || previewText.startsWith('<html') || previewText.startsWith('<head');

                if (isHtmlHeader || isHtmlBody) {
                  throw new Error('REJECTED_HTML_ERROR_PAGE');
                }
              }

              fs.renameSync(tmpLocalPath, targetLocalPath);
              const sha256 = hasher.digest('hex');

              settled = true;
              resolve({
                byteCount,
                sha256,
                mimeType: contentType
              });
            } catch (err: unknown) {
              rejectOnce(err instanceof Error ? err : new Error(String(err)));
            }
          }
        );

        req.on('timeout', () => {
          rejectOnce(new Error(`DOWNLOAD_TIMEOUT_${options.timeoutMs}MS`));
        });

        req.on('error', (err: Error) => {
          rejectOnce(err);
        });

        req.on('socket', (socket: net.Socket) => {
          socket.on('connect', () => {
            const remoteIp = socket.remoteAddress;
            if (remoteIp) {
              const ipCheck = isPrivateOrReservedIp(remoteIp);
              if (ipCheck.blocked) {
                rejectOnce(new Error(`SSRF_SOCKET_CONNECTED_IP_BLOCKED: ${remoteIp}`));
              }
            }
          });
        });

        req.end();
      });

      const outcome = await requestPromise;
      if (outcome.redirectUrl) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new Error('TOO_MANY_REDIRECTS');
        }
        currentUrl = outcome.redirectUrl;
        continue;
      }

      return {
        byteCount: outcome.byteCount || 0,
        sha256: outcome.sha256 || '',
        mimeType: outcome.mimeType || ''
      };
    }

    throw new Error('TOO_MANY_REDIRECTS');
  } finally {
    if (fs.existsSync(tmpLocalPath)) {
      try {
        fs.rmSync(tmpLocalPath, { force: true });
      } catch {}
    }
  }
}

/**
 * Syntax-Aware CSS Rewriter: Rewrites url(...) and @import declarations in CSS stylesheets.
 */
export function rewriteCssUrls(
  cssContent: string,
  urlMap: Map<string, string>,
  options: { mode: 'liquid' | 'relative' }
): { content: string; replacementCount: number } {
  let content = cssContent;
  let replacementCount = 0;

  // 1. Rewrite @import statements (handles @import url("..."), @import url('...'), @import "...", @import '...')
  // Preserves any trailing qualifiers such as media queries, layer(), or supports() conditions!
  const importRegex = /@import\s+(?:url\(\s*(?:(['"])([^'"]+)\1|([^)'"]+))\s*\)|(['"])([^'"]+)\4)([\s\S]*?;)/gi;
  content = content.replace(importRegex, (match, q1, url1, u1, q2, url2, suffix) => {
    const rawUrl = (url1 || u1 || url2 || '').trim();
    if (!rawUrl || rawUrl.startsWith('data:') || isInternalFragmentRef(rawUrl)) return match;
    const replacement = urlMap.get(rawUrl);
    if (replacement) {
      replacementCount++;
      const rawQualifier = (suffix || ';').replace(/;$/, '').trim();
      return rawQualifier
        ? `@import url("${replacement}") ${rawQualifier};`
        : `@import url("${replacement}");`;
    }
    return match;
  });

  // 2. Rewrite url(...) declarations (handles url("..."), url('...'), url(...))
  // Always wraps replacement in controlled outer double-quotes to prevent quote collisions with Liquid syntax
  const urlRegex = /url\(\s*(?:(['"])([^'"]+)\1|([^)'"]+))\s*\)/gi;
  content = content.replace(urlRegex, (match, _q, quotedUrl, unquotedUrl) => {
    const rawUrl = (quotedUrl || unquotedUrl || '').trim();
    if (!rawUrl || rawUrl.startsWith('data:') || isInternalFragmentRef(rawUrl)) return match;
    const replacement = urlMap.get(rawUrl);
    if (replacement) {
      replacementCount++;
      return `url("${replacement}")`;
    }
    return match;
  });

  return { content, replacementCount };
}

/**
 * Syntax-Aware HTML / Liquid Rewriter: Rewrites attributes and inline CSS while strictly preserving code/text nodes.
 */
export function rewriteHtmlContent(
  htmlContent: string,
  urlMap: Map<string, string>,
  options: { mode: 'liquid' | 'relative' }
): { content: string; replacementCount: number } {
  let content = htmlContent;
  let totalReplacements = 0;

  // 1. Rewrite tag attributes: src, href, data-src, data-srcset, poster, onerror
  const tagRegex = /<([a-zA-Z0-9_-]+)\b([^>]*)>/gi;
  content = content.replace(tagRegex, (fullTag, tagName, rawAttrs) => {
    let tagModified = false;
    let newAttrs = rawAttrs;

    // A. Single URL attributes: src, href, data-src, data-original, data-lazy, poster
    // Boundary anchored to start/whitespace so inner JS identifiers like 'this.src=' are not falsely captured!
    const singleAttrRegex = /(^|\s)(src|href|data-src|data-original|data-lazy|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    newAttrs = newAttrs.replace(singleAttrRegex, (attrMatch: string, prefix: string, attrName: string, doubleVal: string | undefined, singleVal: string | undefined) => {
      const val = (doubleVal !== undefined ? doubleVal : singleVal) ?? '';
      const trimmed = val.trim();
      if (!trimmed || trimmed.startsWith('data:') || isInternalFragmentRef(trimmed)) return attrMatch;

      const replacement = urlMap.get(trimmed);
      if (replacement) {
        tagModified = true;
        totalReplacements++;
        // Always normalize rewritten attributes to outer double-quotes to prevent nested single-quote collisions with Liquid
        const safeVal = replacement.replace(/"/g, '&quot;');
        return `${prefix}${attrName}="${safeVal}"`;
      }
      return attrMatch;
    });

    // B. Multiple candidate attributes: srcset, data-srcset
    const srcsetRegex = /(^|\s)(srcset|data-srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    newAttrs = newAttrs.replace(srcsetRegex, (attrMatch: string, prefix: string, attrName: string, doubleVal: string | undefined, singleVal: string | undefined) => {
      const val = (doubleVal !== undefined ? doubleVal : singleVal) ?? '';
      if (!val) return attrMatch;

      const candidates = val.split(',');
      let modifiedAny = false;
      const newCandidates = candidates.map((candidate: string) => {
        const parts = candidate.trim().split(/\s+/);
        const urlPart = parts[0];
        const descriptor = parts.slice(1).join(' ');
        if (!urlPart) return candidate;

        const replacement = urlMap.get(urlPart);
        if (replacement) {
          modifiedAny = true;
          totalReplacements++;
          return descriptor ? `${replacement} ${descriptor}` : replacement;
        }
        return candidate;
      });
      if (modifiedAny) {
        tagModified = true;
        // Always normalize srcset to outer double-quotes
        const safeVal = newCandidates.join(', ').replace(/"/g, '&quot;');
        return `${prefix}${attrName}="${safeVal}"`;
      }
      return attrMatch;
    });

    // C. onerror image fallback: e.g. onerror="this.src='...'"
    const onerrorRegex = /(^|\s)onerror\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    newAttrs = newAttrs.replace(onerrorRegex, (attrMatch: string, prefix: string, doubleVal: string | undefined, singleVal: string | undefined) => {
      const val = (doubleVal !== undefined ? doubleVal : singleVal) ?? '';
      const fallbackMatch = val.match(/((?:this\.)?src\s*=\s*)(['"])([^'"]+)\2/i);
      if (fallbackMatch && fallbackMatch[3]) {
        const srcPrefix = fallbackMatch[1];
        const innerUrl = fallbackMatch[3];
        const replacement = urlMap.get(innerUrl);
        if (replacement) {
          tagModified = true;
          totalReplacements++;
          // Always normalize onerror to outer double-quotes with internal &quot; for the JS string literal
          const safeJsReplacement = `${srcPrefix}&quot;${replacement}&quot;`;
          const replacedVal = val.replace(fallbackMatch[0], safeJsReplacement);
          return `${prefix}onerror="${replacedVal}"`;
        }
      }
      return attrMatch;
    });

    // D. inline style attribute: style="background-image: url(...)"
    const styleAttrRegex = /(^|\s)style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    newAttrs = newAttrs.replace(styleAttrRegex, (attrMatch: string, prefix: string, doubleVal: string | undefined, singleVal: string | undefined) => {
      const val = (doubleVal !== undefined ? doubleVal : singleVal) ?? '';
      const cssRes = rewriteCssUrls(val, urlMap, options);
      if (cssRes.replacementCount > 0) {
        tagModified = true;
        totalReplacements += cssRes.replacementCount;
        // Always normalize inline style to outer double-quotes, serializing internal double-quotes as &quot;
        const serializedCss = cssRes.content.replace(/"/g, '&quot;');
        return `${prefix}style="${serializedCss}"`;
      }
      return attrMatch;
    });
    return tagModified ? `<${tagName}${newAttrs}>` : fullTag;
  });

  // 2. Rewrite contents of <style>...</style> blocks
  const styleBlockRegex = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
  content = content.replace(styleBlockRegex, (_fullMatch, openTag, styleContent, closeTag) => {
    const cssRes = rewriteCssUrls(styleContent, urlMap, options);
    if (cssRes.replacementCount > 0) {
      totalReplacements += cssRes.replacementCount;
      return `${openTag}${cssRes.content}${closeTag}`;
    }
    return _fullMatch;
  });

  return { content, replacementCount: totalReplacements };
}

export class AssetLocalizer {
  /**
   * Phase A1: Downloads assets with SSRF protection, IP-pinned DNS lookup, connection verification,
   * manual redirect management, bounded streaming, content validation, and atomic file transactions.
   */
  public async downloadAssets(
    items: HarvestedAssetItem[],
    options: LocalizeAssetOptions
  ): Promise<{ downloaded: DownloadedAssetResult[]; totalBytes: number; failedCount: number }> {
    const assetsDir = path.resolve(options.assetsDir);
    fs.mkdirSync(assetsDir, { recursive: true });

    const timeoutMs = options.timeoutMs ?? 15000;
    const maxAssetBytes = options.maxAssetBytes ?? 50 * 1024 * 1024;
    const concurrency = Math.max(1, options.concurrency ?? 5);
    const results: DownloadedAssetResult[] = [];
    let totalBytes = 0;
    let failedCount = 0;

    const queue = [...items];
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;

        const targetLocalPath = path.resolve(assetsDir, item.filename);

        // Path containment check
        if (!isPathContained(targetLocalPath, assetsDir)) {
          failedCount++;
          results.push({
            sourceUrl: item.sourceUrl,
            filename: item.filename,
            localPath: targetLocalPath,
            status: 'failed',
            byteCount: 0,
            error: `PATH_CONTAINMENT_VIOLATION: ${item.filename}`
          });
          continue;
        }

        // Check if item has a valid localPath supplied or is already cached and non-empty on disk
        if (item.localPath && fs.existsSync(item.localPath) && !fs.existsSync(targetLocalPath)) {
          try {
            fs.copyFileSync(item.localPath, targetLocalPath);
          } catch {}
        }
        if (fs.existsSync(targetLocalPath)) {
          const stat = fs.statSync(targetLocalPath);
          if (stat.size > 0) {
            const buf = fs.readFileSync(targetLocalPath);
            const sha = createHash('sha256').update(buf).digest('hex');
            totalBytes += stat.size;
            results.push({
              sourceUrl: item.sourceUrl,
              filename: item.filename,
              localPath: targetLocalPath,
              status: 'skipped_cached',
              byteCount: stat.size,
              sha256: sha
            });
            continue;
          }
        }

        // If skipDownload requested and file does not exist, record skipped_offline (never fake skipped_cached)
        if (options.skipDownload) {
          results.push({
            sourceUrl: item.sourceUrl,
            filename: item.filename,
            localPath: targetLocalPath,
            status: 'skipped_offline',
            byteCount: 0
          });
          continue;
        }

        try {
          const dlRes = await downloadUrlWithPinning(item.sourceUrl, targetLocalPath, {
            sourceBaseUrl: options.sourceBaseUrl,
            allowedHostnames: options.allowedHostnames,
            timeoutMs,
            maxAssetBytes,
            assetType: item.type
          });

          totalBytes += dlRes.byteCount;
          results.push({
            sourceUrl: item.sourceUrl,
            filename: item.filename,
            localPath: targetLocalPath,
            status: 'downloaded',
            byteCount: dlRes.byteCount,
            sha256: dlRes.sha256,
            mimeType: dlRes.mimeType
          });
        } catch (err: unknown) {
          failedCount++;
          const message = err instanceof Error ? err.message : String(err);
          results.push({
            sourceUrl: item.sourceUrl,
            filename: item.filename,
            localPath: targetLocalPath,
            status: 'failed',
            byteCount: 0,
            error: message
          });
        }
      }
    });

    await Promise.all(workers);
    return { downloaded: results, totalBytes, failedCount };
  }

  /**
   * Phase A2: Rewrites remote URLs in HTML/Liquid/CSS source files into local asset references using syntax-aware rewriters.
   */
  public rewriteFiles(
    files: Array<{ path: string; content: string }>,
    manifest: HarvestedAssetManifest,
    options: { mode?: 'liquid' | 'relative' } = {}
  ): { files: RewrittenFileResult[]; totalReplacements: number } {
    const mode = options.mode ?? 'liquid';

    const allItems: HarvestedAssetItem[] = [
      ...manifest.stylesheets,
      ...manifest.javascripts,
      ...manifest.images,
      ...manifest.fonts
    ];

    const urlMap = new Map<string, string>();
    for (const item of allItems) {
      const replacement = mode === 'liquid'
        ? `{{ '${item.filename}' | asset_url }}`
        : `assets/${item.filename}`;

      urlMap.set(item.sourceUrl, replacement);
      // A reference that the harvester repaired from an upstream typo must still
      // match the text that is actually in the document, otherwise the repaired
      // URL is downloaded but the typo keeps pointing at a missing local file.
      if (item.rawSourceUrl && item.rawSourceUrl !== item.sourceUrl) {
        urlMap.set(item.rawSourceUrl, replacement);
      }

      if (item.sourceUrl.startsWith('https://')) {
        urlMap.set(item.sourceUrl.slice(6), replacement); // '//example.com/...'
      } else if (item.sourceUrl.startsWith('http://')) {
        urlMap.set(item.sourceUrl.slice(5), replacement); // '//example.com/...'
      }
    }

    let totalReplacements = 0;
    const fileResults: RewrittenFileResult[] = [];

    for (const file of files) {
      const isCss = file.path.endsWith('.css') || file.path.endsWith('.css.liquid');
      let res: { content: string; replacementCount: number };

      if (isCss) {
        res = rewriteCssUrls(file.content, urlMap, { mode });
      } else {
        res = rewriteHtmlContent(file.content, urlMap, { mode });
      }

      totalReplacements += res.replacementCount;
      fileResults.push({
        path: file.path,
        replacementCount: res.replacementCount,
        originalContent: file.content,
        rewrittenContent: res.content
      });
    }

    return { files: fileResults, totalReplacements };
  }

  /**
   * Recursively discovers and downloads secondary assets declared inside downloaded CSS files
   * (e.g. @import stylesheets, fonts, background images) using a bounded queue, resolving
   * relative URLs against each stylesheet's own URL, maintaining per-stylesheet mappings from raw
   * references to localized filenames, and rewriting all CSS files in-place on disk.
   */
  public async localizeDownloadedStylesheets(
    manifest: HarvestedAssetManifest,
    options: LocalizeAssetOptions,
    maxDepth: number = 5
  ): Promise<{
    secondaryDownloaded: DownloadedAssetResult[];
    totalBytes: number;
    failedCount: number;
    rewrittenCssCount: number;
    depthExceededUrls: string[];
  }> {
    const mode = options.mode ?? 'liquid';
    const assetsDir = path.resolve(options.assetsDir);
    const allocatedFilenames = new Map<string, string>();

    // Seed allocatedFilenames with all existing items in manifest
    const allManifestItems = [
      ...manifest.stylesheets,
      ...manifest.javascripts,
      ...manifest.images,
      ...manifest.fonts
    ];
    for (const item of allManifestItems) {
      allocatedFilenames.set(item.filename, item.sourceUrl);
    }

    const hashUrl = (str: string): string => {
      return createHash('sha256').update(str).digest('hex').slice(0, 8);
    };

    const allocateFilename = (cleanUrl: string, sourceUrl: string, defaultPrefix: string, fallbackExt: string): string => {
      const rawExt = path.extname(cleanUrl);
      const ext = rawExt && rawExt.length <= 6 ? rawExt.toLowerCase() : fallbackExt;
      const base = path.basename(cleanUrl, rawExt) || defaultPrefix;
      const cleanBase = base.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || defaultPrefix;

      let candidate = `${cleanBase}${ext}`;
      if (allocatedFilenames.has(candidate) && allocatedFilenames.get(candidate) !== sourceUrl) {
        const hash = hashUrl(sourceUrl);
        candidate = `${cleanBase}_${hash}${ext}`;
        let counter = 2;
        while (allocatedFilenames.has(candidate) && allocatedFilenames.get(candidate) !== sourceUrl) {
          candidate = `${cleanBase}_${hash}_${counter}${ext}`;
          counter++;
        }
      }
      allocatedFilenames.set(candidate, sourceUrl);
      return candidate;
    };

    const processedStylesheets = new Set<string>();
    interface StylesheetQueueItem {
      localCssPath: string;
      sourceUrl: string;
      depth: number;
    }

    const queue: StylesheetQueueItem[] = [];
    for (const sheet of manifest.stylesheets) {
      const localCssPath = path.resolve(assetsDir, sheet.filename);
      if (fs.existsSync(localCssPath)) {
        queue.push({
          localCssPath,
          sourceUrl: sheet.sourceUrl,
          depth: 0
        });
      }
    }

    const allSecondaryDownloaded: DownloadedAssetResult[] = [];
    let secondaryTotalBytes = 0;
    let secondaryFailedCount = 0;
    let rewrittenCssCount = 0;
    const allDownloadedCssPaths = new Set<string>(queue.map(q => q.localCssPath));
    const perSheetUrlMaps = new Map<string, Map<string, string>>();
    const depthExceededUrls: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) {
        depthExceededUrls.push(current.sourceUrl);
        continue;
      }
      if (processedStylesheets.has(current.sourceUrl)) {
        continue;
      }
      processedStylesheets.add(current.sourceUrl);

      if (!fs.existsSync(current.localCssPath)) {
        continue;
      }
      const cssContent = fs.readFileSync(current.localCssPath, 'utf8');
      const discoveredItems: HarvestedAssetItem[] = [];

      let sheetMap = perSheetUrlMaps.get(current.localCssPath);
      if (!sheetMap) {
        sheetMap = new Map<string, string>();
        perSheetUrlMaps.set(current.localCssPath, sheetMap);
      }
      // 1. Scan for @import declarations (CSS stylesheets or fonts)
      const importSpans: Array<{ start: number; end: number }> = [];
      const importRegex = /@import\s+(?:url\(['"]?|['"])([^'")]+)['"]?\)?(?:[^;]*;)?/gi;
      let match: RegExpExecArray | null;

      while ((match = importRegex.exec(cssContent)) !== null) {
        importSpans.push({ start: match.index, end: match.index + match[0].length });
        const importRef = match[1].trim();
        if (!importRef || importRef.startsWith('data:') || isInternalFragmentRef(importRef)) continue;

        let resolvedUrl: string;
        try {
          const base = current.sourceUrl.startsWith('//') ? 'https:' + current.sourceUrl : current.sourceUrl;
          resolvedUrl = new URL(importRef, base).toString();
        } catch {
          continue;
        }

        const isKnown = [
          ...manifest.stylesheets,
          ...manifest.javascripts,
          ...manifest.images,
          ...manifest.fonts,
          ...discoveredItems
        ].some(item => item.sourceUrl === resolvedUrl);

        let targetFilename = '';
        if (!isKnown) {
          const isFont = /\.(?:woff2?|ttf|eot|otf)(?:[?#]|$)/i.test(resolvedUrl);
          const cleanUrl = resolvedUrl.split('?')[0].split('#')[0];
          targetFilename = allocateFilename(
            cleanUrl,
            resolvedUrl,
            isFont ? 'font_dep' : 'style_dep',
            isFont ? '.woff2' : '.css'
          );

          const newItem: HarvestedAssetItem = {
            type: isFont ? 'font' : 'css',
            sourceUrl: resolvedUrl,
            filename: targetFilename,
            localPath: path.join(assetsDir, targetFilename),
            occurrences: [{ filePath: current.localCssPath, tag: 'css', attribute: '@import' }]
          };

          discoveredItems.push(newItem);
          if (isFont) manifest.fonts.push(newItem);
          else manifest.stylesheets.push(newItem);
        } else {
          const existing = [
            ...manifest.stylesheets,
            ...manifest.javascripts,
            ...manifest.images,
            ...manifest.fonts,
            ...discoveredItems
          ].find(item => item.sourceUrl === resolvedUrl);
          if (existing) targetFilename = existing.filename;
        }

        if (targetFilename) {
          const replacement = mode === 'liquid'
            ? `{{ '${targetFilename}' | asset_url }}`
            : targetFilename;
          sheetMap.set(importRef, replacement);
          sheetMap.set(resolvedUrl, replacement);
        }
      }

      // 2. Scan for url(...) declarations (images or fonts, excluding import spans).
      // The quoted alternative uses a lazy any-character body so an embedded SVG
      // data URI (which itself contains `url(...)` and `"`) is captured whole and
      // skipped as `data:`, instead of exposing its inner paint-server token.
      const urlRegex = /url\(\s*(?:(['"])([\s\S]*?)\1|([^)'"]*?))\s*\)/gi;
      while ((match = urlRegex.exec(cssContent)) !== null) {
        const matchIdx = match.index;
        const isInsideImport = importSpans.some(span => matchIdx >= span.start && matchIdx < span.end);
        if (isInsideImport) continue;
        const urlRef = (match[2] || match[3] || '').trim();
        if (!urlRef || urlRef.startsWith('data:') || isInternalFragmentRef(urlRef)) continue;

        let resolvedUrl: string;
        try {
          const base = current.sourceUrl.startsWith('//') ? 'https:' + current.sourceUrl : current.sourceUrl;
          resolvedUrl = new URL(urlRef, base).toString();
        } catch {
          continue;
        }
        const isKnown = [
          ...manifest.stylesheets,
          ...manifest.javascripts,
          ...manifest.images,
          ...manifest.fonts,
          ...discoveredItems
        ].some(item => item.sourceUrl === resolvedUrl);

        let targetFilename = '';
        if (!isKnown) {
          const isFont = /\.(?:woff2?|ttf|eot|otf)(?:[?#]|$)/i.test(resolvedUrl);
          const cleanUrl = resolvedUrl.split('?')[0].split('#')[0];
          targetFilename = allocateFilename(
            cleanUrl,
            resolvedUrl,
            isFont ? 'font_dep' : 'image_dep',
            isFont ? '.woff2' : '.png'
          );

          const newItem: HarvestedAssetItem = {
            type: isFont ? 'font' : 'image',
            sourceUrl: resolvedUrl,
            filename: targetFilename,
            localPath: path.join(assetsDir, targetFilename),
            occurrences: [{ filePath: current.localCssPath, tag: 'css', attribute: 'url()' }]
          };

          discoveredItems.push(newItem);
          if (isFont) manifest.fonts.push(newItem);
          else manifest.images.push(newItem);
        } else {
          const existing = [
            ...manifest.stylesheets,
            ...manifest.javascripts,
            ...manifest.images,
            ...manifest.fonts,
            ...discoveredItems
          ].find(item => item.sourceUrl === resolvedUrl);
          if (existing) targetFilename = existing.filename;
        }

        if (targetFilename) {
          const replacement = mode === 'liquid'
            ? `{{ '${targetFilename}' | asset_url }}`
            : targetFilename;
          sheetMap.set(urlRef, replacement);
          sheetMap.set(resolvedUrl, replacement);
          if (resolvedUrl.startsWith('https://')) {
            sheetMap.set(resolvedUrl.slice(6), replacement);
          } else if (resolvedUrl.startsWith('http://')) {
            sheetMap.set(resolvedUrl.slice(5), replacement);
          }
          if (urlRef.startsWith('//')) {
            sheetMap.set('https:' + urlRef, replacement);
            sheetMap.set('http:' + urlRef, replacement);
          }
        }
      }

      // Download newly discovered secondary assets
      if (discoveredItems.length > 0 && !options.skipDownload) {
        const dlRes = await this.downloadAssets(discoveredItems, options);
        allSecondaryDownloaded.push(...dlRes.downloaded);
        secondaryTotalBytes += dlRes.totalBytes;
        secondaryFailedCount += dlRes.failedCount;
        // Register successfully downloaded secondary assets in the manifest so audit sees them!
        for (const item of discoveredItems) {
          const dlRecord = dlRes.downloaded.find(d => d.sourceUrl === item.sourceUrl);
          if (dlRecord && dlRecord.status !== 'failed') {
            if (item.type === 'font') {
              if (!manifest.fonts.some(f => f.sourceUrl === item.sourceUrl)) manifest.fonts.push(item);
            } else if (item.type === 'image') {
              if (!manifest.images.some(i => i.sourceUrl === item.sourceUrl)) manifest.images.push(item);
            } else if (item.type === 'css') {
              if (!manifest.stylesheets.some(s => s.sourceUrl === item.sourceUrl)) manifest.stylesheets.push(item);
            }
          }
        }
      }

      // If any newly discovered item was a CSS stylesheet, enqueue it for transitive recursion!
      for (const item of discoveredItems) {
        if (item.type === 'css') {
          allDownloadedCssPaths.add(item.localPath);
          queue.push({
            localCssPath: item.localPath,
            sourceUrl: item.sourceUrl,
            depth: current.depth + 1
          });
        }
      }
    }

    // Now rewrite all downloaded CSS files in-place using per-sheet maps + global manifest fallback
    if (allDownloadedCssPaths.size > 0) {
      const globalMap = new Map<string, string>();
      const allManifest = [
        ...manifest.stylesheets,
        ...manifest.javascripts,
        ...manifest.images,
        ...manifest.fonts
      ];

      for (const item of allManifest) {
        const replacement = mode === 'liquid'
          ? `{{ '${item.filename}' | asset_url }}`
          : item.filename;
        globalMap.set(item.sourceUrl, replacement);
        globalMap.set(item.sourceUrl.split('?')[0].split('#')[0], replacement);
        if (item.sourceUrl.startsWith('https://')) {
          globalMap.set(item.sourceUrl.slice(6), replacement);
          globalMap.set(item.sourceUrl.slice(6).split('?')[0].split('#')[0], replacement);
        } else if (item.sourceUrl.startsWith('http://')) {
          globalMap.set(item.sourceUrl.slice(5), replacement);
          globalMap.set(item.sourceUrl.slice(5).split('?')[0].split('#')[0], replacement);
        }
      }

      for (const cssPath of allDownloadedCssPaths) {
        if (fs.existsSync(cssPath)) {
          const content = fs.readFileSync(cssPath, 'utf8');
          const sheetSpecificMap = perSheetUrlMaps.get(cssPath) || new Map<string, string>();
          const mergedMap = new Map<string, string>([...globalMap, ...sheetSpecificMap]);

          const res = rewriteCssUrls(content, mergedMap, { mode });
          if (res.replacementCount > 0) {
            fs.writeFileSync(cssPath, res.content, 'utf8');
            rewrittenCssCount += res.replacementCount;
          }
        }
      }
    }

    return {
      secondaryDownloaded: allSecondaryDownloaded,
      totalBytes: secondaryTotalBytes,
      failedCount: secondaryFailedCount,
      rewrittenCssCount,
      depthExceededUrls
    };
  }

  /**
   * Phase A3: Verifies integrity of downloaded assets on disk and audits rewritten files
   * (both HTML/Liquid files AND on-disk stylesheets) for residual remote URLs or unresolved relative references.
   */
  public verifyAndAudit(
    manifest: HarvestedAssetManifest,
    options: {
      assetsDir: string;
      rewrittenFiles: RewrittenFileResult[];
      downloadResults?: DownloadedAssetResult[];
      depthExceededUrls?: string[];
    }
  ): {
    verifiedAssets: AssetVerificationItem[];
    findings: AssetAuditFinding[];
    passed: boolean;
    unlocalizedUrls: string[];
  } {
    const resolvedAssetsDir = path.resolve(options.assetsDir);
    const findings: AssetAuditFinding[] = [];
    const verifiedAssets: AssetVerificationItem[] = [];

    const allItems: HarvestedAssetItem[] = [
      ...manifest.stylesheets,
      ...manifest.javascripts,
      ...manifest.images,
      ...manifest.fonts
    ];

    const knownFilenames = new Set<string>(allItems.map(i => i.filename));
    // An upstream asset that answers with an empty body (HTTP 200, zero bytes) is
    // reproduced faithfully as an empty local file. Only the download result can
    // prove that: without it, a zero-byte file stays an integrity failure. The key
    // carries the source URL as well as the filename, so a download that produced
    // an empty file under a colliding name cannot excuse a different asset that
    // failed or was never written.
    const emptyUpstreamKey = (sourceUrl: string, filename: string) => `${sourceUrl}\0${filename}`;
    const verifiedEmptyUpstream = new Set<string>(
      (options.downloadResults ?? [])
        .filter(dl => dl.status === 'downloaded' && dl.byteCount === 0)
        .map(dl => emptyUpstreamKey(dl.sourceUrl, dl.filename))
    );

    // 1. Audit local disk assets
    for (const item of allItems) {
      const localPath = path.resolve(resolvedAssetsDir, item.filename);

      if (!fs.existsSync(localPath)) {
        findings.push({
          severity: 'error',
          code: 'MISSING_LOCAL_FILE',
          message: `Asset file missing on disk: ${item.filename}`,
          details: { filename: item.filename, sourceUrl: item.sourceUrl, localPath }
        });
        verifiedAssets.push({
          filename: item.filename,
          localPath,
          exists: false,
          byteCount: 0,
          status: 'missing'
        });
        continue;
      }

      const stat = fs.statSync(localPath);
      if (stat.size === 0) {
        if (verifiedEmptyUpstream.has(emptyUpstreamKey(item.sourceUrl, item.filename))) {
          verifiedAssets.push({
            filename: item.filename,
            localPath,
            exists: true,
            byteCount: 0,
            status: 'zero_byte'
          });
          continue;
        }
        findings.push({
          severity: 'error',
          code: 'ZERO_BYTE_ASSET',
          message: `Asset file has zero bytes: ${item.filename}`,
          details: { filename: item.filename, sourceUrl: item.sourceUrl, localPath }
        });
        verifiedAssets.push({
          filename: item.filename,
          localPath,
          exists: true,
          byteCount: 0,
          status: 'zero_byte'
        });
        continue;
      }

      const buf = fs.readFileSync(localPath);
      const sha = createHash('sha256').update(buf).digest('hex');
      verifiedAssets.push({
        filename: item.filename,
        localPath,
        exists: true,
        byteCount: stat.size,
        sha256: sha,
        status: 'valid'
      });
    }

    // 2. Audit download failures from A1
    if (options.downloadResults) {
      for (const dl of options.downloadResults) {
        if (dl.status === 'failed') {
          findings.push({
            severity: 'error',
            code: 'DOWNLOAD_FAILED',
            message: `Asset download failed: ${dl.sourceUrl} (${dl.error || 'Unknown error'})`,
            details: { sourceUrl: dl.sourceUrl, filename: dl.filename, error: dl.error }
          });
        }
      }
    }

    // 2b. Audit depth limit exceeded errors
    if (options.depthExceededUrls && options.depthExceededUrls.length > 0) {
      for (const exceededUrl of options.depthExceededUrls) {
        findings.push({
          severity: 'error',
          code: 'DEPTH_CUTOFF_EXCEEDED',
          message: `Recursion depth limit exceeded for stylesheet: ${exceededUrl}`,
          details: { sourceUrl: exceededUrl }
        });
      }
    }

    // 3. Consolidated Remote Network Resource Audit across rewritten files
    // Eliminates narrower regex duplicate scan while deduplicating findings by (filePath + url)
    const unlocalizedSet = new Set<string>();
    const seenFileUrlPairs = new Set<string>();
    // Matches plain attributes as well as Alpine/Vue bound attributes (:src, :data-src, x-bind:src, v-bind:src)
    // Supports both double- and single-quoted values with opposite quotes nested inside
    const subResourceAttributeRegex = /(?:^|\s)(?:(?::|x-bind:|v-bind:)?(src|data-src|poster|data-lazy-src)|(href))\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    const inlineStyleUrlRegex = /url\(\s*['"]?((?:https?:)?\/\/[^'")]+)['"]?\s*\)/gi;

    for (const file of options.rewrittenFiles) {
      let contentToScan = file.rewrittenContent;
      if (file.path.endsWith('.html')) {
        // Strip inline <script>...</script> bodies to eliminate JS literal/base64 false positives
        // while still inspecting all HTML tags, link[rel="stylesheet"], script[src], iframe[src], img[src], video[poster], etc.
        contentToScan = contentToScan.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (match, body) => {
          const tagMatch = match.match(/^<script\b[^>]*>/i);
          return tagMatch ? `${tagMatch[0]}</script>` : '';
        });
      }

      // Check all explicit HTML sub-resource attributes (src, href for stylesheets/favicons, poster, data-src)
      let match: RegExpExecArray | null;
      while ((match = subResourceAttributeRegex.exec(contentToScan)) !== null) {
        const attrName = (match[1] || match[2] || '').toLowerCase();
        const rawVal = (match[3] !== undefined ? match[3] : match[4]) ?? '';
        // data: URIs and # fragments are inline payloads, never network sub-resources.
        // Without this guard, an inline SVG's XML namespace (xmlns="http://www.w3.org/2000/svg")
        // inside a data:image/svg+xml attribute is mis-flagged as a lingering remote URL,
        // failing the fail-closed audit on legitimate storefronts (asymmetry with the CSS
        // url() audit, which already skips data: tokens below).
        const trimmedVal = rawVal.trim();
        if (trimmedVal.startsWith('data:') || trimmedVal.startsWith('#')) continue;
        const urlMatch = rawVal.match(/(?:https?:)?\/\/[^\s"'<>]+/i);
        if (!urlMatch) continue;
        const matchedUrl = urlMatch[0].trim();
        // Plain navigating hyperlinks (<a href="https://...">) are not loaded as page sub-resources
        if (attrName === 'href') {
          const tagStart = Math.max(0, match.index - 100);
          const tagSlice = contentToScan.slice(tagStart, match.index).toLowerCase();
          const isLinkTag = /<link\b[^>]*$/i.test(tagSlice);
          if (!isLinkTag) continue;
        }

        const dedupKey = `${file.path}::${attrName}::${matchedUrl}`;
        if (seenFileUrlPairs.has(dedupKey)) continue;
        seenFileUrlPairs.add(dedupKey);

        unlocalizedSet.add(matchedUrl);
        findings.push({
          severity: 'error',
          code: 'LINGERING_REMOTE_NETWORK_URL',
          message: `Lingering remote network URL found in sub-resource attribute (${attrName}) of rewritten ${file.path}: ${matchedUrl}`,
          details: { file: file.path, url: matchedUrl, attribute: attrName }
        });
      }

      // Check inline CSS url(...) within HTML style attributes and style blocks
      while ((match = inlineStyleUrlRegex.exec(contentToScan)) !== null) {
        const matchedUrl = match[1].trim();
        const dedupKey = `${file.path}::${matchedUrl}`;
        if (seenFileUrlPairs.has(dedupKey)) continue;
        seenFileUrlPairs.add(dedupKey);

        unlocalizedSet.add(matchedUrl);
        findings.push({
          severity: 'error',
          code: 'LINGERING_REMOTE_NETWORK_URL',
          message: `Lingering remote network URL found in CSS url() of rewritten ${file.path}: ${matchedUrl}`,
          details: { file: file.path, url: matchedUrl }
        });
      }
    }

    // 4. Token-level Audit of on-disk rewritten CSS files:
    // Every non-data/non-fragment @import and url(...) must resolve to a known localized asset token!
    // Liquid-aware regex: inner quotes in {{ '...' }} must not break quote matching!
    const cssImportRegex = /@import\s+(?:url\(\s*(?:(['"])([\s\S]*?)\1|([^)]*?))\s*\)|(['"])([\s\S]*?)\4)\s*(?:[^;]*;)?/gi;
    const cssUrlRegex = /url\(\s*(?:(['"])([\s\S]*?)\1|([^)]*?))\s*\)/gi;

    for (const sheet of manifest.stylesheets) {
      const localPath = path.resolve(resolvedAssetsDir, sheet.filename);
      if (fs.existsSync(localPath)) {
        const content = fs.readFileSync(localPath, 'utf8');

        // 1. Check @import tokens (Liquid-aware) and record spans to prevent double-counting url(...) inside @import
        const importSpans: Array<{ start: number; end: number }> = [];
        let m: RegExpExecArray | null;
        while ((m = cssImportRegex.exec(content)) !== null) {
          importSpans.push({ start: m.index, end: m.index + m[0].length });
          const rawToken = (m[2] || m[3] || m[5] || '').trim();
          if (!rawToken || rawToken.startsWith('data:') || isInternalFragmentRef(rawToken)) continue;

          const token = rawToken.replace(/^['"]|['"]$/g, '').trim();
          const isLiquidToken = token.startsWith('{{') && token.endsWith('}}');
          const isKnownFilename = knownFilenames.has(token);

          if (!isLiquidToken && !isKnownFilename) {
            unlocalizedSet.add(token);
            findings.push({
              severity: 'error',
              code: 'UNRESOLVED_CSS_DEPENDENCY',
              message: `Unresolved CSS @import token in ${sheet.filename}: ${token}`,
              details: { stylesheet: sheet.filename, token }
            });
          }
        }

        // 2. Check url(...) tokens (excluding spans inside @import statements)
        while ((m = cssUrlRegex.exec(content)) !== null) {
          const matchIdx = m.index;
          if (importSpans.some(s => matchIdx >= s.start && matchIdx < s.end)) {
            continue;
          }
          const rawToken = (m[2] || m[3] || '').trim();
          if (!rawToken || rawToken.startsWith('data:') || isInternalFragmentRef(rawToken)) continue;

          const token = rawToken.replace(/^['"]|['"]$/g, '').trim();
          const isLiquidToken = token.startsWith('{{') && token.endsWith('}}');
          const isKnownFilename = knownFilenames.has(token);

          if (!isLiquidToken && !isKnownFilename) {
            unlocalizedSet.add(token);
            findings.push({
              severity: 'error',
              code: 'UNRESOLVED_CSS_DEPENDENCY',
              message: `Unresolved CSS url() token in ${sheet.filename}: ${token}`,
              details: { stylesheet: sheet.filename, token }
            });
          }
        }
      }
    }

    const unlocalizedUrls = Array.from(unlocalizedSet);
    const hasErrors = findings.some(f => f.severity === 'error');
    return {
      verifiedAssets,
      findings,
      passed: !hasErrors,
      unlocalizedUrls
    };
  }

  /**
   * Complete End-to-End Pipeline: A1 Download -> Bounded Recursive CSS Localization -> A2 Rewrite -> A3 Verification Ledger
   */
  public async localizePipeline(
    files: Array<{ path: string; content: string }>,
    manifest: HarvestedAssetManifest,
    options: LocalizeAssetOptions
  ): Promise<AssetLocalizationPipelineResult> {
    const allItems = [
      ...manifest.stylesheets,
      ...manifest.javascripts,
      ...manifest.images,
      ...manifest.fonts
    ];

    // Phase A1: Download primary assets
    const a1Result = await this.downloadAssets(allItems, options);

    // Phase A2: Bounded recursive secondary asset discovery, download, and in-place rewriting of CSS stylesheets
    const secondaryResult = await this.localizeDownloadedStylesheets(manifest, options);

    // Merge secondary downloads into A1 result
    a1Result.downloaded.push(...secondaryResult.secondaryDownloaded);
    a1Result.totalBytes += secondaryResult.totalBytes;
    a1Result.failedCount += secondaryResult.failedCount;

    // Phase A2: Syntax-aware rewriting of HTML/Liquid source files
    const a2Result = this.rewriteFiles(files, manifest, { mode: options.mode });

    // Phase A3: Direct token-level verification and audit ledger (covers HTML files, on-disk CSS, and depth limits)
    const a3Result = this.verifyAndAudit(manifest, {
      assetsDir: options.assetsDir,
      rewrittenFiles: a2Result.files,
      downloadResults: a1Result.downloaded,
      depthExceededUrls: secondaryResult.depthExceededUrls
    });

    return {
      a1_download: a1Result,
      a2_rewrite: a2Result,
      a3_audit: a3Result
    };
  }
}
