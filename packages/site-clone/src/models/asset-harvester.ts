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
  filename: string;
  localPath: string;
  byteCount?: number;
  occurrences?: AssetProvenanceOccurrence[];
}

export interface HarvestedAssetManifest {
  stylesheets: HarvestedAssetItem[];
  javascripts: HarvestedAssetItem[];
  images: HarvestedAssetItem[];
  fonts: HarvestedAssetItem[];
  totalBytes: number;
}
export class AssetHarvester {
  public harvestFromHtml(html: string, assetsDir: string, context?: { baseUrl?: string }): HarvestedAssetManifest {
    return this.harvestFromFiles([{ path: 'inline.html', content: html }], assetsDir, context);
  }

  public harvestFromFiles(
    files: Array<{ path: string; content: string }>,
    assetsDir: string,
    context?: { baseUrl?: string }
  ): HarvestedAssetManifest {
    fs.mkdirSync(assetsDir, { recursive: true });
    const normalizeRef = (raw: string): string => normalizeMalformedAbsoluteRef(raw, context?.baseUrl);

    const manifest: HarvestedAssetManifest = {
      stylesheets: [],
      javascripts: [],
      images: [],
      fonts: [],
      totalBytes: 0
    };

    let cssIdx = 1;
    let jsIdx = 1;
    let imgIdx = 1;

    const allocatedFilenames = new Map<string, string>(); // filename -> sourceUrl

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

    const addStylesheet = (rawUrl: string, provenance?: AssetProvenanceOccurrence) => {
      const raw = (rawUrl || '').trim();
      if (!raw || raw.startsWith('data:') || raw.startsWith('#')) return;
      const trimmed = normalizeRef(raw);
      const existing = manifest.stylesheets.find(item => item.sourceUrl === trimmed);
      if (existing) {
        if (trimmed !== raw && !existing.rawSourceUrl) existing.rawSourceUrl = raw;
        if (provenance && existing.occurrences) existing.occurrences.push(provenance);
        return;
      }
      const cleanUrl = trimmed.split('?')[0].split('#')[0];
      const filename = allocateFilename(cleanUrl, trimmed, `style_${cssIdx}`, '.css');
      const item: HarvestedAssetItem = {
        type: 'css',
        sourceUrl: trimmed,
        filename,
        localPath: path.join(assetsDir, filename),
        occurrences: provenance ? [provenance] : []
      };
      if (trimmed !== raw) item.rawSourceUrl = raw;
      manifest.stylesheets.push(item);
      cssIdx++;
    };

    const addScript = (rawUrl: string, provenance?: AssetProvenanceOccurrence) => {
      const raw = (rawUrl || '').trim();
      if (!raw || raw.startsWith('data:') || raw.startsWith('#')) return;
      const trimmed = normalizeRef(raw);
      const existing = manifest.javascripts.find(item => item.sourceUrl === trimmed);
      if (existing) {
        if (trimmed !== raw && !existing.rawSourceUrl) existing.rawSourceUrl = raw;
        if (provenance && existing.occurrences) existing.occurrences.push(provenance);
        return;
      }
      const cleanUrl = trimmed.split('?')[0].split('#')[0];
      const filename = allocateFilename(cleanUrl, trimmed, `script_${jsIdx}`, '.js');
      const item: HarvestedAssetItem = {
        type: 'js',
        sourceUrl: trimmed,
        filename,
        localPath: path.join(assetsDir, filename),
        occurrences: provenance ? [provenance] : []
      };
      if (trimmed !== raw) item.rawSourceUrl = raw;
      manifest.javascripts.push(item);
      jsIdx++;
    };

    const addImage = (rawUrl: string, provenance?: AssetProvenanceOccurrence) => {
      const raw = (rawUrl || '').trim();
      if (!raw || raw.startsWith('data:') || raw.startsWith('#')) return;
      const trimmed = normalizeRef(raw);
      const existing = manifest.images.find(item => item.sourceUrl === trimmed);
      if (existing) {
        if (trimmed !== raw && !existing.rawSourceUrl) existing.rawSourceUrl = raw;
        if (provenance && existing.occurrences) existing.occurrences.push(provenance);
        return;
      }
      const cleanUrl = trimmed.split('?')[0].split('#')[0];
      const filename = allocateFilename(cleanUrl, trimmed, `image_${imgIdx}`, '.png');
      const item: HarvestedAssetItem = {
        type: 'image',
        sourceUrl: trimmed,
        filename,
        localPath: path.join(assetsDir, filename),
        occurrences: provenance ? [provenance] : []
      };
      if (trimmed !== raw) item.rawSourceUrl = raw;
      manifest.images.push(item);
      imgIdx++;
    };

    const addFont = (rawUrl: string, provenance?: AssetProvenanceOccurrence) => {
      const raw = (rawUrl || '').trim();
      if (!raw || raw.startsWith('data:') || raw.startsWith('#')) return;
      const trimmed = normalizeRef(raw);
      const existing = manifest.fonts.find(item => item.sourceUrl === trimmed);
      if (existing) {
        if (trimmed !== raw && !existing.rawSourceUrl) existing.rawSourceUrl = raw;
        if (provenance && existing.occurrences) existing.occurrences.push(provenance);
        return;
      }
      const cleanUrl = trimmed.split('?')[0].split('#')[0];
      const filename = allocateFilename(cleanUrl, trimmed, `font_${manifest.fonts.length + 1}`, '.woff2');
      const item: HarvestedAssetItem = {
        type: 'font',
        sourceUrl: trimmed,
        filename,
        localPath: path.join(assetsDir, filename),
        occurrences: provenance ? [provenance] : []
      };
      if (trimmed !== raw) item.rawSourceUrl = raw;
      manifest.fonts.push(item);
    };

    const parseSrcset = (srcsetValue: string, provenance?: AssetProvenanceOccurrence) => {
      if (!srcsetValue) return;
      const candidates = srcsetValue.split(',');
      for (const cand of candidates) {
        const urlPart = cand.trim().split(/\s+/)[0];
        if (urlPart) addImage(urlPart, provenance);
      }
    };
    for (const file of files) {
      const { path: filePath, content } = file;

      // 1. Extract CSS stylesheets (<link rel="stylesheet">)
      const linkTagRegex = /<link\b([^>]*)>/gi;
      let match: RegExpExecArray | null;
      while ((match = linkTagRegex.exec(content)) !== null) {
        const attrs = parseTagAttributes(match[0]);
        if (attrs.get('rel')?.toLowerCase() !== 'stylesheet') continue;
        const href = attrs.get('href');
        if (href) addStylesheet(href, { filePath, tag: 'link', attribute: 'href' });
      }

      // 2. Extract Javascript assets (<script src="...">)
      const scriptTagRegex = /<script\b([^>]*)>/gi;
      while ((match = scriptTagRegex.exec(content)) !== null) {
        const attrs = parseTagAttributes(match[0]);
        const src = attrs.get('src');
        if (src) addScript(src, { filePath, tag: 'script', attribute: 'src' });
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

    return manifest;
  }
}
