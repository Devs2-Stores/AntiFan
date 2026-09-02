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

    // 1. Extract CSS stylesheets
    const cssRegex = /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']*)["'][^>]*>/gi;
    let match: RegExpExecArray | null;
    let cssIdx = 1;

    while ((match = cssRegex.exec(html)) !== null) {
      const href = match[1];
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

    // 3. Extract remote images
    const imgRegex = /<img\b[^>]*src=["']([^"']*)["'][^>]*>/gi;
    let imgIdx = 1;

    while ((match = imgRegex.exec(html)) !== null) {
      const src = match[1];
      const cleanUrl = src.split('?')[0];
      const filename = path.basename(cleanUrl) || `image_${imgIdx}.png`;
      manifest.images.push({
        type: 'image',
        sourceUrl: src,
        filename,
        localPath: path.join(assetsDir, filename)
      });
      imgIdx++;
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
