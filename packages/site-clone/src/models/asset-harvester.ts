/**
 * Model 2: Asset Harvester
 * Collects, categorizes, and manages remote stylesheets, scripts, images, and font subsets
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isInternalFragmentRef } from './asset-localizer.js';
function parseTagAttributes(tagHtml: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const tagOpenMatch = tagHtml.match(/^<([a-zA-Z0-9_-]+)/);
  if (!tagOpenMatch) return attrs;
  const attrSlice = tagHtml.slice(tagOpenMatch[0].length);
  const attrRegex = /([a-zA-Z0-9_:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(attrSlice)) !== null) {
    const name = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs.set(name, val);
  }
  return attrs;
}
function hashUrl(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 8);
}
const ALLOWED_HEADER_REGEX = /^(?:user-agent|accept|accept-language|sec-ch-ua(?:-(?:mobile|platform|platform-version|model|arch|bitness|full-version-list))?)$/i;

export function sanitizeRequestHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const clean: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(headers)) {
    if (typeof rawKey !== 'string' || typeof rawVal !== 'string') continue;
    const key = rawKey.trim().toLowerCase();
    if (!ALLOWED_HEADER_REGEX.test(key)) continue;

    const val = rawVal.trim();
    if (!val || val.length > 1024 || /[\r\n\0]/.test(val)) continue;

    clean[rawKey.trim()] = val;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

export function computeHeaderFingerprint(headers?: Record<string, string>): string | undefined {
  const clean = sanitizeRequestHeaders(headers);
  if (!clean || Object.keys(clean).length === 0) return undefined;
  const sortedEntries = Object.entries(clean)
    .map(([k, v]) => [k.toLowerCase().trim(), String(v).trim()])
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(sortedEntries)).digest('hex').slice(0, 8);
}
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

function sanitizeStem(str: string, fallback: string): string {
  let clean = str
    .replace(/[^a-zA-Z0-9_@.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
  if (WINDOWS_RESERVED_NAMES.has(clean.toUpperCase())) {
    clean = `asset-${clean}`;
  }
  if (clean.length > 64) {
    clean = clean.slice(0, 64).replace(/-+$/, '');
  }
  return clean;
}

/**
 * Repairs a scheme-relative typo that appears in upstream markup as an absolute
 * URL with a single slash (`https:/wp-content/uploads/x.png`).
 *
 * Under URL parsing that reference denotes host `wp-content`, which cannot
 * resolve, so the asset is never fetched and the rewrite leaves a dangling local
 * reference behind. The intended reference is same-origin: the first segment is a
 * path segment, not a host. Only a first segment that cannot be a hostname (no
 * dot, not localhost) is repaired, so a genuine one-slash absolute URL keeps its
 * meaning.
 */
export function normalizeMalformedAbsoluteRef(rawUrl: string, baseUrl?: string): string {
  const raw = (rawUrl || '').trim();
  const m = /^(https?):\/(?!\/)(.+)$/i.exec(raw);
  if (!m || !baseUrl) return raw;
  const firstSegment = m[2].split(/[/?#]/)[0];
  if (!firstSegment || firstSegment.includes('.') || firstSegment.toLowerCase() === 'localhost') return raw;
  try {
    const base = new URL(baseUrl);
    return `${base.protocol}//${base.host}/${m[2].replace(/^\/+/, '')}`;
  } catch {
    return raw;
  }
}

export interface AssetProvenanceOccurrence {
  filePath?: string;
  tag: string;
  attribute: string;
  surface?: 'desktop' | 'mobile';
  requestHeaders?: Record<string, string>;
  requestIdentity?: string;
}

export interface HarvestedAssetItem {
  type: 'css' | 'js' | 'image' | 'font';
  sourceUrl: string;
  /**
   * The reference exactly as it appeared upstream when it differs from
   * `sourceUrl`. The rewriter registers it as an alias so the repaired URL is
   * written back over the original text instead of leaving the typo in place.
   */
  rawSourceUrl?: string;
  /**
   * The raw filename/basename extracted from the source URL before any cleaning or collision allocation.
   * Used by downstream compiler tools to migrate merchant asset references in settings_data.json.
   */
  originalFilename?: string;
  filename: string;
  localPath: string;
  byteCount?: number;
  occurrences?: AssetProvenanceOccurrence[];
  defer?: boolean;
  requestHeaders?: Record<string, string>;
  requestIdentity?: string;
  sha256?: string;
}

export interface HarvestFileContext {
  surface?: 'desktop' | 'mobile';
  observedUrl?: string;
  userAgent?: string;
  requestHeaders?: Record<string, string>;
  devicePixelRatio?: number;
  requestIdentity?: string;
}

export interface HarvestFileInput {
  path: string;
  content: string;
  context?: HarvestFileContext;
}

export interface HarvestContextOptions {
  baseUrl?: string;
  partitionBySurface?: boolean;
  requestIdentity?: string;
  requestHeaders?: Record<string, string>;
}

export interface HarvestedAssetManifest {
  stylesheets: HarvestedAssetItem[];
  javascripts: HarvestedAssetItem[];
  images: HarvestedAssetItem[];
  fonts: HarvestedAssetItem[];
  totalBytes: number;
  /**
   * Map of original references (sourceUrl, rawSourceUrl, original basename, and relative paths)
   * directly to the allocated destination filename (`item.filename`).
   */
  assetMap?: Record<string, string>;
}
export class AssetHarvester {
  public harvestFromHtml(html: string, assetsDir: string, context?: HarvestContextOptions | string): HarvestedAssetManifest {
    const normContext = typeof context === 'string' ? { baseUrl: context } : context;
    return this.harvestFromFiles([{ path: 'inline.html', content: html }], assetsDir, normContext);
  }

  public harvestFromFiles(
    files: Array<HarvestFileInput>,
    assetsDir: string,
    context?: HarvestContextOptions | string
  ): HarvestedAssetManifest {
    fs.mkdirSync(assetsDir, { recursive: true });
    const manifest: HarvestedAssetManifest = {
      stylesheets: [],
      javascripts: [],
      images: [],
      fonts: [],
      totalBytes: 0
    };
    const normContext = typeof context === 'string' ? { baseUrl: context } : context;
    const baseUrl = normContext?.baseUrl;
    const normalizeRef = (raw: string): string => {
      const trimmed = (raw || '').trim();
      if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('#')) return trimmed;
      if (baseUrl && trimmed.startsWith('/') && !trimmed.startsWith('//')) {
        try {
          return new URL(trimmed, baseUrl).href;
        } catch {}
      }
      return normalizeMalformedAbsoluteRef(trimmed, baseUrl);
    };

    interface CollectedAssetEntry {
      type: 'css' | 'js' | 'image' | 'font';
      sourceUrl: string;
      rawSourceUrl?: string;
      originalFilename?: string;
      occurrences: AssetProvenanceOccurrence[];
      defer?: boolean;
      requestIdentity?: string;
      requestHeaders?: Record<string, string>;
    }

    const collectedMap = new Map<string, CollectedAssetEntry>();

    const recordAsset = (
      type: 'css' | 'js' | 'image' | 'font',
      rawUrl: string,
      provenance?: AssetProvenanceOccurrence,
      defer?: boolean
    ) => {
      const raw = (rawUrl || '').trim();
      if (!raw || raw.startsWith('data:') || raw.startsWith('#')) return;
      if (type === 'js' && /(?:livewire|tawk|twk-|googletagmanager|google-analytics|analytics\.js|gtag|clarity|connect\.facebook\.net|fbq|subiz|vchat|zalo|hotjar|criteo)/i.test(raw)) return;

      const trimmed = normalizeRef(raw);
      if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('#')) return;

      const fileHeaders = activeFileContext?.requestHeaders
        ? { ...(activeFileContext.userAgent ? { 'User-Agent': activeFileContext.userAgent } : {}), ...activeFileContext.requestHeaders }
        : (activeFileContext?.userAgent ? { 'User-Agent': activeFileContext.userAgent } : undefined);
      const effectiveHeaders = sanitizeRequestHeaders(provenance?.requestHeaders || fileHeaders || normContext?.requestHeaders);
      const headerFp = computeHeaderFingerprint(effectiveHeaders);

      const explicitReqId = provenance?.requestIdentity || activeFileContext?.requestIdentity || normContext?.requestIdentity;
      const explicitSurface = provenance?.surface || activeFileContext?.surface;
      const pathSurface = provenance?.filePath
        ? (provenance.filePath.startsWith('mobile/') ? 'mobile' : 'desktop')
        : undefined;

      let reqId: string | undefined = explicitReqId;
      if (!reqId) {
        if (explicitSurface) {
          reqId = explicitSurface;
        } else if (normContext?.partitionBySurface && pathSurface) {
          reqId = pathSurface;
        } else if (headerFp) {
          reqId = `hdr-${headerFp}`;
        }
      }

      if (reqId && headerFp) {
        const candidateKey = `${type}::${trimmed}::${reqId}`;
        const existing = collectedMap.get(candidateKey);
        if (existing && existing.requestHeaders && computeHeaderFingerprint(existing.requestHeaders) !== headerFp) {
          reqId = `${reqId}-${headerFp}`;
        }
      }
      const key = reqId ? `${type}::${trimmed}::${reqId}` : `${type}::${trimmed}`;
      const cleanPath = trimmed.split('?')[0].split('#')[0];
      const rawOriginalFilename = path.basename(cleanPath) || undefined;

      const existing = collectedMap.get(key);
      if (existing) {
        if (trimmed !== raw && !existing.rawSourceUrl) {
          existing.rawSourceUrl = raw;
        }
        if (provenance) {
          existing.occurrences.push(provenance);
        }
        if (defer) existing.defer = true;
      } else {
        const defaultHeaders = effectiveHeaders || (
          reqId?.startsWith('mobile')
            ? { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'sec-ch-ua-mobile': '?1' }
            : (reqId?.startsWith('desktop') ? { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'sec-ch-ua-mobile': '?0' } : undefined)
        );
        collectedMap.set(key, {
          type,
          sourceUrl: trimmed,
          rawSourceUrl: trimmed !== raw ? raw : undefined,
          originalFilename: rawOriginalFilename,
          occurrences: provenance ? [provenance] : [],
          defer: defer ? true : undefined,
          requestIdentity: reqId,
          requestHeaders: defaultHeaders
        });
      }
    };

    const addStylesheet = (rawUrl: string, provenance?: AssetProvenanceOccurrence) => recordAsset('css', rawUrl, provenance);
    const addScript = (rawUrl: string, provenance?: AssetProvenanceOccurrence, defer?: boolean) => recordAsset('js', rawUrl, provenance, defer);
    const addImage = (rawUrl: string, provenance?: AssetProvenanceOccurrence) => recordAsset('image', rawUrl, provenance);
    const addFont = (rawUrl: string, provenance?: AssetProvenanceOccurrence) => recordAsset('font', rawUrl, provenance);

    const parseSrcset = (srcsetValue: string, provenance?: AssetProvenanceOccurrence) => {
      if (!srcsetValue) return;
      const candidates = srcsetValue.split(',');
      for (const cand of candidates) {
        const urlPart = cand.trim().split(/\s+/)[0];
        if (urlPart) addImage(urlPart, provenance);
      }
    };
    let activeFileContext: HarvestFileContext | undefined;
    for (const file of files) {
      const { path: filePath, content, context: fileContext } = file;
      activeFileContext = fileContext;

      // 1. Extract CSS stylesheets (<link rel="stylesheet">)
      const linkTagRegex = /<link\b([^>]*)>/gi;
      let match: RegExpExecArray | null;
      while ((match = linkTagRegex.exec(content)) !== null) {
        const attrs = parseTagAttributes(match[0]);
        if (attrs.get('rel')?.toLowerCase() !== 'stylesheet') continue;
        const href = attrs.get('href');
        if (href) addStylesheet(href, { filePath, tag: 'link', attribute: 'href' });
      }

      // 1b. Extract icon links (<link rel="icon|shortcut icon|apple-touch-icon">).
      //     These are document subresources like any stylesheet, and a bundle that
      //     leaves them pointing at the source host is not offline.
      const iconLinkRegex = /<link\b([^>]*)>/gi;
      let iconMatch: RegExpExecArray | null;
      while ((iconMatch = iconLinkRegex.exec(content)) !== null) {
        const attrs = parseTagAttributes(iconMatch[0]);
        const rel = (attrs.get('rel') || '').toLowerCase();
        const isIcon = /(?:^|\s)(?:shortcut\s+icon|apple-touch-icon(?:-precomposed)?|mask-icon|icon)(?:\s|$)/.test(rel);
        if (!isIcon) continue;
        const href = attrs.get('href');
        if (href) addImage(href, { filePath, tag: 'link', attribute: 'href' });
      }

      // 2. Extract Javascript assets (<script src="...">)
      const scriptTagRegex = /<script\b([^>]*)>/gi;
      while ((match = scriptTagRegex.exec(content)) !== null) {
        const attrs = parseTagAttributes(match[0]);
        const src = attrs.get('src');
        if (src) addScript(src, { filePath, tag: 'script', attribute: 'src' }, attrs.has('defer'));
      }

      // 3. Extract remote images (<img> tags)
      const imgTagRegex = /<img\b([^>]*)>/gi;
      while ((match = imgTagRegex.exec(content)) !== null) {
        const attrs = parseTagAttributes(match[0]);

        if (attrs.has('src')) {
          addImage(attrs.get('src')!, { filePath, tag: 'img', attribute: 'src' });
        }
        if (attrs.has('data-src')) {
          addImage(attrs.get('data-src')!, { filePath, tag: 'img', attribute: 'data-src' });
        }
        if (attrs.has('srcset')) {
          parseSrcset(attrs.get('srcset')!, { filePath, tag: 'img', attribute: 'srcset' });
        }
        if (attrs.has('data-srcset')) {
          parseSrcset(attrs.get('data-srcset')!, { filePath, tag: 'img', attribute: 'data-srcset' });
        }

        // Extract fallback inside onerror attribute safely
        if (attrs.has('onerror')) {
          const onerrorVal = attrs.get('onerror')!;
          const fallbackMatch = onerrorVal.match(/(?:this\.)?src\s*=\s*['"]([^'"]+)['"]/i);
          if (fallbackMatch && fallbackMatch[1]) {
            addImage(fallbackMatch[1], { filePath, tag: 'img', attribute: 'onerror_fallback' });
          }
        }
      }

      // 4. Extract <source> tags in <picture> / <video>
      const sourceTagRegex = /<source\b([^>]*)>/gi;
      while ((match = sourceTagRegex.exec(content)) !== null) {
        const attrs = parseTagAttributes(match[0]);
        if (attrs.has('srcset')) {
          parseSrcset(attrs.get('srcset')!, { filePath, tag: 'source', attribute: 'srcset' });
        }
        if (attrs.has('data-srcset')) {
          parseSrcset(attrs.get('data-srcset')!, { filePath, tag: 'source', attribute: 'data-srcset' });
        }
        if (attrs.has('src')) {
          const srcVal = attrs.get('src')!;
          if (/\.(?:png|jpe?g|webp|gif|svg|avif)(?:[?#]|$)/i.test(srcVal)) {
            addImage(srcVal, { filePath, tag: 'source', attribute: 'src' });
          }
        }
      }

      // 5. Extract <video> poster
      const videoTagRegex = /<video\b([^>]*)>/gi;
      while ((match = videoTagRegex.exec(content)) !== null) {
        const attrs = parseTagAttributes(match[0]);
        if (attrs.has('poster')) {
          addImage(attrs.get('poster')!, { filePath, tag: 'video', attribute: 'poster' });
        }
      }
      // 5. CSS @import declarations (gather exact ranges to prevent double-counting in url() matching)
      const importSpans: Array<{ start: number; end: number }> = [];
      const importRegex = /@import\s+(?:url\(['"]?|['"])([^'")]+)['"]?\)?(?:[^;]*;)?/gi;
      while ((match = importRegex.exec(content)) !== null) {
        importSpans.push({ start: match.index, end: match.index + match[0].length });
        const importUrl = match[1].trim();
        if (!importUrl) continue;
        if (/\.(?:woff2?|ttf|eot|otf)(?:[?#]|$)/i.test(importUrl)) {
          addFont(importUrl, { filePath, tag: 'css', attribute: '@import' });
        } else {
          addStylesheet(importUrl, { filePath, tag: 'css', attribute: '@import' });
        }
      }

      // 6. CSS url(...) declarations (skip matches whose start index falls inside an @import range).
      // The quoted alternative uses a lazy any-character body so an embedded SVG data URI
      // (which itself contains `url(...)` and `"`) is captured whole and skipped, instead of
      // exposing an inner paint-server fragment token as a downloadable asset.
      const bgUrlRegex = /url\(\s*(?:(['"])([\s\S]*?)\1|([^)'"]*?))\s*\)/gi;
      while ((match = bgUrlRegex.exec(content)) !== null) {
        const matchIdx = match.index;
        const isInsideImport = importSpans.some(span => matchIdx >= span.start && matchIdx < span.end);
        if (isInsideImport) continue;

        const urlCandidate = (match[2] || match[3] || '').trim();
        if (!urlCandidate || urlCandidate.startsWith('data:') || isInternalFragmentRef(urlCandidate)) continue;
        if (/\.(?:png|jpe?g|webp|gif|svg|avif)(?:[?#]|$)/i.test(urlCandidate)) {
          addImage(urlCandidate, { filePath, tag: 'css', attribute: 'url()' });
        } else if (/\.(?:woff2?|ttf|eot|otf)(?:[?#]|$)/i.test(urlCandidate)) {
          addFont(urlCandidate, { filePath, tag: 'css', attribute: 'url()' });
        }
      }
    }

    // 7. Deterministic Allocation of Asset Filenames across all collected assets
    // Sort deterministically by type then sourceUrl to eliminate traversal-order dependencies
    const sortedEntries = Array.from(collectedMap.values()).sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.sourceUrl.localeCompare(b.sourceUrl);
    });

    interface AnalyzedAsset {
      entry: CollectedAssetEntry;
      cleanBase: string;
      ext: string;
      surface: 'desktop' | 'mobile' | 'shared' | 'unknown';
      density?: string;
      dimension?: string;
      queryQualifier?: string;
      buildHash?: string;
      assignedFilename?: string;
      /**
       * Real filename already present in assetsDir that this reference names. A clone writes
       * localized references, so re-harvesting that output (theme compilation) must keep the
       * file that is on disk instead of re-deriving a normalized name that does not exist.
       */
      onDiskFilename?: string;
    }

    const onDiskNames = new Set<string>(fs.readdirSync(assetsDir));

    const analyzedAssets: AnalyzedAsset[] = sortedEntries.map(entry => {
      let pathname = '';
      let search = '';
      try {
        const parsed = new URL(entry.sourceUrl.startsWith('//') ? 'https:' + entry.sourceUrl : entry.sourceUrl);
        pathname = parsed.pathname;
        search = parsed.search;
      } catch {
        const qIdx = entry.sourceUrl.indexOf('?');
        const hIdx = entry.sourceUrl.indexOf('#');
        const cutIdx = qIdx !== -1 && hIdx !== -1 ? Math.min(qIdx, hIdx) : qIdx !== -1 ? qIdx : hIdx;
        pathname = cutIdx !== -1 ? entry.sourceUrl.slice(0, cutIdx) : entry.sourceUrl;
        search = qIdx !== -1 ? entry.sourceUrl.slice(qIdx, hIdx !== -1 ? hIdx : undefined) : '';
      }

      const defaultPrefix = entry.type === 'css' ? 'style' : entry.type === 'js' ? 'script' : entry.type === 'font' ? 'font' : 'image';
      const fallbackExt = entry.type === 'css' ? '.css' : entry.type === 'js' ? '.js' : entry.type === 'font' ? '.woff2' : '.png';

      const rawExt = path.extname(pathname);
      const ext = rawExt && rawExt.length <= 6 && /^\.[a-zA-Z0-9]+$/.test(rawExt) ? rawExt.toLowerCase() : fallbackExt;
      let base = path.basename(pathname, rawExt) || defaultPrefix;

      let buildHash: string | undefined;
      if (ext === '.css' || ext === '.js') {
        const hashMatch = base.match(/[-_.]([a-zA-Z0-9_-]{8,12})$/);
        if (hashMatch) {
          buildHash = hashMatch[1].toLowerCase();
          base = base.slice(0, -hashMatch[0].length);
        }
      }

      let density: string | undefined;
      let dimension: string | undefined;
      if (/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(ext)) {
        const densityMatch = base.match(/(?:@|[-_]at[-_]|[-_])(\d+(?:\.\d+)?x)$/i);
        if (densityMatch) {
          density = densityMatch[1].toLowerCase();
          base = base.slice(0, -densityMatch[0].length);
        }
        const dimMatch = base.match(/[-_](\d{2,5}x\d{2,5})$/i);
        if (dimMatch) {
          dimension = dimMatch[1].toLowerCase();
          base = base.slice(0, -dimMatch[0].length);
        }
        base = base.replace(/^\d{2,3}[-_]/, '').replace(/^\d+([a-zA-Z])/, '$1');
      }

      let queryQualifier: string | undefined;
      if (search && search.length > 1) {
        try {
          const sp = new URLSearchParams(search);
          const width = sp.get('width') || sp.get('w');
          const height = sp.get('height') || sp.get('h');
          const qDensity = sp.get('density') || sp.get('dpr') || sp.get('scale');
          const variant = sp.get('variant') || sp.get('color') || sp.get('theme');

          if (width && height) {
            queryQualifier = `${width}x${height}`;
          } else if (width) {
            queryQualifier = `w${width}`;
          } else if (qDensity && !density) {
            density = `${qDensity}x`;
          } else if (variant) {
            queryQualifier = variant.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 16);
          } else {
            queryQualifier = `q${hashUrl(search).slice(0, 6)}`;
          }
        } catch {}
      }

      const cleanBase = sanitizeStem(base, defaultPrefix);

      let hasMobile = false;
      let hasDesktop = false;
      if (entry.requestIdentity === 'mobile') {
        hasMobile = true;
      } else if (entry.requestIdentity === 'desktop') {
        hasDesktop = true;
      }
      for (const occ of entry.occurrences) {
        if (occ.surface === 'mobile' || occ.requestIdentity === 'mobile') {
          hasMobile = true;
        } else if (occ.surface === 'desktop' || occ.requestIdentity === 'desktop') {
          hasDesktop = true;
        }
        const fp = (occ.filePath || '').toLowerCase();
        if (/(?:^|[/\-_])mobile(?:[/\-_.]|$)/.test(fp)) {
          hasMobile = true;
        } else if (/(?:^|[/\-_])desktop(?:[/\-_.]|$)/.test(fp) || fp === 'index.html' || fp === 'inline.html') {
          hasDesktop = true;
        }
      }
      const surface = (hasMobile && hasDesktop) ? 'shared' : hasMobile ? 'mobile' : hasDesktop ? 'desktop' : 'unknown';

      const referencedBasename = path.basename(pathname);
      return {
        entry,
        cleanBase,
        ext,
        surface,
        density,
        dimension,
        queryQualifier,
        buildHash,
        onDiskFilename: referencedBasename && onDiskNames.has(referencedBasename) ? referencedBasename : undefined
      };
    });

    const baseGroups = new Map<string, AnalyzedAsset[]>();
    for (const asset of analyzedAssets) {
      const groupKey = `${asset.cleanBase}${asset.ext}`.toLowerCase();
      const list = baseGroups.get(groupKey) || [];
      list.push(asset);
      baseGroups.set(groupKey, list);
    }

    const allocatedFilenames = new Map<string, string>(); // lowerFilename -> entityKey (type::sourceUrl::requestIdentity)
    const getEntityKey = (entry: CollectedAssetEntry): string => `${entry.type}::${entry.sourceUrl}::${entry.requestIdentity || ''}`;

    const allocateUniqueFilename = (a: AnalyzedAsset, preferredBase: string): string => {
      const entityKey = getEntityKey(a.entry);
      let filename = `${preferredBase}${a.ext}`;
      const candLower = filename.toLowerCase();

      if (!allocatedFilenames.has(candLower) || allocatedFilenames.get(candLower) === entityKey) {
        allocatedFilenames.set(candLower, entityKey);
        return filename;
      }

      // Collision detected! Deterministically extend hash of entityKey until unique.
      const fullHash = createHash('sha256').update(entityKey).digest('hex');
      let hashSliceLen = 8;
      while (hashSliceLen <= 32) {
        filename = `${preferredBase}-${fullHash.slice(0, hashSliceLen)}${a.ext}`;
        const lower = filename.toLowerCase();
        if (!allocatedFilenames.has(lower) || allocatedFilenames.get(lower) === entityKey) {
          allocatedFilenames.set(lower, entityKey);
          return filename;
        }
        hashSliceLen += 4;
      }

      let counter = 2;
      while (counter <= 1000) {
        filename = `${preferredBase}-${fullHash.slice(0, 16)}-${counter}${a.ext}`;
        const lower = filename.toLowerCase();
        if (!allocatedFilenames.has(lower) || allocatedFilenames.get(lower) === entityKey) {
          allocatedFilenames.set(lower, entityKey);
          return filename;
        }
        counter++;
      }

      throw new Error(`FATAL_FILENAME_COLLISION_EXHAUSTION: Unable to allocate unique filename for ${entityKey}`);
    };

    // A reference that already names a file on disk is that file: reuse the real name so a
    // re-harvest of localized output references the bytes that exist instead of a derived name.
    for (const a of analyzedAssets) {
      if (!a.onDiskFilename) continue;
      const lower = a.onDiskFilename.toLowerCase();
      const entityKey = getEntityKey(a.entry);
      if (!allocatedFilenames.has(lower) || allocatedFilenames.get(lower) === entityKey) {
        a.assignedFilename = a.onDiskFilename;
        allocatedFilenames.set(lower, entityKey);
      }
    }

    for (const [, group] of baseGroups) {
      const pending = group.filter(a => !a.assignedFilename);
      if (pending.length === 0) continue;
      if (pending.length === 1) {
        const a = pending[0];
        let candidate = a.cleanBase;
        if (a.dimension) {
          candidate = `${candidate}-${a.dimension}`;
        }
        if (a.density && /@\d+(?:\.\d+)?x/i.test(a.entry.sourceUrl)) {
          candidate = `${candidate}@${a.density}`;
        }
        a.assignedFilename = allocateUniqueFilename(a, candidate);
      } else {
        const surfacesInGroup = new Set(pending.map(x => x.surface));
        const queryQualifiers = new Set(pending.map(x => x.queryQualifier).filter(Boolean));
        const buildHashes = new Set(pending.map(x => x.buildHash).filter(Boolean));
        const densities = new Set(pending.map(x => x.density).filter(Boolean));
        const dimensions = new Set(pending.map(x => x.dimension).filter(Boolean));

        const candidateMap = new Map<AnalyzedAsset, string>();
        const candidateCounts = new Map<string, number>();

        for (const a of pending) {
          let candidate = a.cleanBase;
          if (a.density && (densities.size > 1 || /@\d+(?:\.\d+)?x/i.test(a.entry.sourceUrl))) {
            const prefix = /@\d+(?:\.\d+)?x/i.test(a.entry.sourceUrl) ? '@' : '-';
            candidate = `${candidate}${prefix}${a.density}`;
          }
          if (a.dimension && dimensions.size > 1) {
            candidate = `${candidate}-${a.dimension}`;
          }
          if (surfacesInGroup.has('desktop') && surfacesInGroup.has('mobile') && (a.surface === 'desktop' || a.surface === 'mobile')) {
            candidate = `${candidate}-${a.surface}`;
          }
          if (a.queryQualifier && queryQualifiers.size > 1) {
            candidate = `${candidate}-${a.queryQualifier}`;
          }
          if (a.buildHash && buildHashes.size > 1) {
            candidate = `${candidate}-${a.buildHash}`;
          }

          candidateMap.set(a, candidate);
          const candKey = `${candidate}${a.ext}`.toLowerCase();
          candidateCounts.set(candKey, (candidateCounts.get(candKey) || 0) + 1);
        }

        for (const a of pending) {
          let candidate = candidateMap.get(a)!;
          const candKey = `${candidate}${a.ext}`.toLowerCase();
          if ((candidateCounts.get(candKey) || 0) > 1) {
            candidate = `${candidate}-${hashUrl(a.entry.sourceUrl).slice(0, 8)}`;
          }

          a.assignedFilename = allocateUniqueFilename(a, candidate);
        }
      }
    }
    const aliasCandidates = new Map<string, Set<string>>();
    const recordAlias = (alias: string | undefined, filename: string) => {
      if (!alias) return;
      const set = aliasCandidates.get(alias) || new Set<string>();
      set.add(filename);
      aliasCandidates.set(alias, set);
    };

    const analyzedByEntry = new Map<CollectedAssetEntry, AnalyzedAsset>();
    for (const a of analyzedAssets) {
      analyzedByEntry.set(a.entry, a);
    }

    for (const entry of collectedMap.values()) {
      const a = analyzedByEntry.get(entry);
      if (!a) continue;
      const filename = a.assignedFilename || `${a.cleanBase}${a.ext}`;
      const item: HarvestedAssetItem = {
        type: a.entry.type,
        sourceUrl: a.entry.sourceUrl,
        originalFilename: a.entry.originalFilename,
        filename,
        localPath: path.join(assetsDir, filename),
        occurrences: a.entry.occurrences,
        defer: a.entry.defer,
        requestIdentity: a.entry.requestIdentity,
        requestHeaders: a.entry.requestHeaders
      };
      if (a.entry.rawSourceUrl) {
        item.rawSourceUrl = a.entry.rawSourceUrl;
      }
      if (item.type === 'css') manifest.stylesheets.push(item);
      else if (item.type === 'js') manifest.javascripts.push(item);
      else if (item.type === 'image') manifest.images.push(item);
      else if (item.type === 'font') manifest.fonts.push(item);

      recordAlias(item.sourceUrl, filename);
      if (item.rawSourceUrl) {
        recordAlias(item.rawSourceUrl, filename);
      }
      if (item.originalFilename) {
        recordAlias(item.originalFilename, filename);
        recordAlias(`assets/${item.originalFilename}`, filename);
        recordAlias(`/assets/${item.originalFilename}`, filename);
      }
      if (item.requestIdentity) {
        recordAlias(`${item.sourceUrl}#${item.requestIdentity}`, filename);
        if (item.originalFilename) {
          recordAlias(`${item.originalFilename}#${item.requestIdentity}`, filename);
        }
      }
    }

    manifest.assetMap = {};
    for (const [alias, targets] of aliasCandidates) {
      if (targets.size === 1) {
        manifest.assetMap[alias] = Array.from(targets)[0];
      }
    }

    return manifest;
  }
}
