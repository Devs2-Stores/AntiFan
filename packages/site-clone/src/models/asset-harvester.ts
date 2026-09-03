/**
 * Model 2: Asset Harvester
 * Collects, categorizes, and manages remote stylesheets, scripts, images, and font subsets
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HarvestedAssetItem {
  type: 'css' | 'js' | 'image' | 'font';
  sourceUrl: string;
  filename: string;
  localPath: string;
  byteCount?: number;
}

export interface HarvestedAssetManifest {
  stylesheets: HarvestedAssetItem[];
  javascripts: HarvestedAssetItem[];
  images: HarvestedAssetItem[];
  fonts: HarvestedAssetItem[];
  totalBytes: number;
}

export class AssetHarvester {
  public harvestFromHtml(html: string, assetsDir: string): HarvestedAssetManifest {
    fs.mkdirSync(assetsDir, { recursive: true });

    const manifest: HarvestedAssetManifest = {
      stylesheets: [],
      javascripts: [],
      images: [],
      fonts: [],
      totalBytes: 0
    };

    // 1. Extract CSS stylesheets (matches regardless of attribute order: rel before href or href before rel)
    const linkTagRegex = /<link\b([^>]*)>/gi;
    let match: RegExpExecArray | null;
    let cssIdx = 1;

    while ((match = linkTagRegex.exec(html)) !== null) {
      const attrs = match[1];
      if (!/rel=["']stylesheet["']/i.test(attrs)) continue;
      const hrefMatch = attrs.match(/href=["']([^"']*)["']/i);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];
      const cleanUrl = href.split('?')[0];
      const filename = path.basename(cleanUrl) || `style_${cssIdx}.css`;
      manifest.stylesheets.push({
        type: 'css',
        sourceUrl: href,
        filename,
        localPath: path.join(assetsDir, filename)
      });
      cssIdx++;
    }

    // 2. Extract Javascript assets
    const scriptRegex = /<script\b[^>]*src=["']([^"']*)["'][^>]*>/gi;
    let jsIdx = 1;

    while ((match = scriptRegex.exec(html)) !== null) {
      const src = match[1];
      const cleanUrl = src.split('?')[0];
      const filename = path.basename(cleanUrl) || `script_${jsIdx}.js`;
      manifest.javascripts.push({
        type: 'js',
        sourceUrl: src,
        filename,
        localPath: path.join(assetsDir, filename)
      });
      jsIdx++;
    }

    // 3. Extract remote images (src, data-src, srcset, data-srcset, source tags, and inline background-image URLs)
    const seenImageUrls = new Set<string>();
    let imgIdx = 1;

    const addImage = (rawUrl: string) => {
      const trimmed = (rawUrl || '').trim();
      if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('#') || seenImageUrls.has(trimmed)) return;
      seenImageUrls.add(trimmed);
      const cleanUrl = trimmed.split('?')[0].split('#')[0];
      const rawExt = path.extname(cleanUrl);
      const ext = rawExt && rawExt.length <= 5 ? rawExt : '.png';
      const base = path.basename(cleanUrl, rawExt) || `image_${imgIdx}`;
      const filename = `${base}${ext}`;
      manifest.images.push({
        type: 'image',
        sourceUrl: trimmed,
        filename,
        localPath: path.join(assetsDir, filename)
      });
      imgIdx++;
    };

    const parseSrcset = (srcsetValue: string) => {
      if (!srcsetValue) return;
      const candidates = srcsetValue.split(',');
      for (const cand of candidates) {
        const urlPart = cand.trim().split(/\s+/)[0];
        if (urlPart) addImage(urlPart);
      }
    };

    // 3a. <img> tags
    const imgTagRegex = /<img\b([^>]*)>/gi;
    while ((match = imgTagRegex.exec(html)) !== null) {
      const attrs = match[1];
      const srcMatch = attrs.match(/\bsrc=["']([^"']*)["']/i);
      if (srcMatch) addImage(srcMatch[1]);
      const dataSrcMatch = attrs.match(/\bdata-src=["']([^"']*)["']/i);
      if (dataSrcMatch) addImage(dataSrcMatch[1]);
      const srcsetMatch = attrs.match(/\bsrcset=["']([^"']*)["']/i);
      if (srcsetMatch) parseSrcset(srcsetMatch[1]);
      const dataSrcsetMatch = attrs.match(/\bdata-srcset=["']([^"']*)["']/i);
      if (dataSrcsetMatch) parseSrcset(dataSrcsetMatch[1]);
    }

    // 3b. <source> tags in <picture>
    const sourceTagRegex = /<source\b([^>]*)>/gi;
    while ((match = sourceTagRegex.exec(html)) !== null) {
      const attrs = match[1];
      const srcsetMatch = attrs.match(/\bsrcset=["']([^"']*)["']/i);
      if (srcsetMatch) parseSrcset(srcsetMatch[1]);
      const dataSrcsetMatch = attrs.match(/\bdata-srcset=["']([^"']*)["']/i);
      if (dataSrcsetMatch) parseSrcset(dataSrcsetMatch[1]);
    }

    // 3c. CSS url(...) declarations (e.g. background-image)
    const bgUrlRegex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
    while ((match = bgUrlRegex.exec(html)) !== null) {
      const urlCandidate = match[1];
      if (/\.(?:png|jpe?g|webp|gif|svg|avif)(?:[?#]|$)/i.test(urlCandidate)) {
        addImage(urlCandidate);
      }
    }
    // 4. Default Vietnamese font subsets (Roboto 400, 500, 700)
    const fontSubsets = [
      { name: 'roboto-regular.woff2', weight: '400' },
      { name: 'roboto-medium.woff2', weight: '500' },
      { name: 'roboto-bold.woff2', weight: '700' }
    ];

    for (const font of fontSubsets) {
      manifest.fonts.push({
        type: 'font',
        sourceUrl: `https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Mu7WxKOzY.woff2`,
        filename: font.name,
        localPath: path.join(assetsDir, font.name)
      });
    }

    return manifest;
  }
}
