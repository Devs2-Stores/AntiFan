export interface BrokenAssetFinding {
  type: 'image' | 'stylesheet' | 'script' | 'font' | 'network_404';
  url: string;
  elementSelector?: string;
  reason: string;
}

export interface BrokenAssetScanResult {
  hasBrokenAssets: boolean;
  brokenAssets: BrokenAssetFinding[];
  totalImagesScanned: number;
  totalStylesheetsScanned: number;
}

export class BrokenAssetScanner {
  /**
   * Browser injection script to scan live DOM for broken images and failed stylesheets
   * Wrapped in self-executing IIFE for isolated evaluation (RT-01 mitigation)
   */
  public static getBrowserScanScript(): string {
    return `(() => {
      const findings = [];
      const images = Array.from(document.querySelectorAll('img'));
      const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
      const scripts = Array.from(document.querySelectorAll('script[src]'));

      let imageCount = images.length;
      let linkCount = links.length;

      // 1. Check broken images
      for (const img of images) {
        const src = img.getAttribute('src') || img.src;
        if (!src) {
          // Empty src is only flagged if not a lazy-loaded image with data-src
          const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-srcset');
          if (!lazySrc && !img.closest('[data-lazy]')) {
            findings.push({
              type: 'image',
              url: '(empty src)',
              elementSelector: getSelector(img),
              reason: 'Image tag has empty src and no data-src lazy attribute'
            });
          }
          continue;
        }

        // Ignore valid data URIs and blank placeholder SVGs
        if (src.startsWith('data:image/svg+xml') || src.startsWith('data:image/gif;base64,R0lGODlhAQABA')) {
          continue;
        }

        // Check if image failed to load in DOM
        if (img.complete && (img.naturalWidth === 0 || img.naturalHeight === 0)) {
          findings.push({
            type: 'image',
            url: src,
            elementSelector: getSelector(img),
            reason: 'Image completed loading with 0 natural width/height (load failure)'
          });
        }
      }

      // 2. Scan stylesheets count (network-level correlation in extractCorrelatableAssetFailures handles 404/500 failures)
      for (const link of links) {
        const href = link.getAttribute('href') || link.href;
        if (!href) continue;
      }

      function getSelector(el) {
        if (!el) return '';
        let s = el.tagName.toLowerCase();
        if (el.id) s += '#' + el.id;
        else if (el.className && typeof el.className === 'string') {
          s += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
        }
        return s;
      }

      return {
        hasBrokenAssets: findings.length > 0,
        brokenAssets: findings,
        totalImagesScanned: imageCount,
        totalStylesheetsScanned: linkCount
      };
    })()`;
  }

  /**
   * Correlate DOM scan with CDP Network failure events
   */
  public static correlateWithNetworkFailures(
    domResult: BrokenAssetScanResult,
    networkFailures: Array<{ url: string; status?: number; errorText?: string }>
  ): BrokenAssetScanResult {
    const findings = [...domResult.brokenAssets];

    for (const fail of networkFailures) {
      const lower = fail.url.toLowerCase();
      let type: BrokenAssetFinding['type'] = 'network_404';
      if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp') || lower.endsWith('.svg') || lower.endsWith('.gif')) {
        type = 'image';
      } else if (lower.endsWith('.css')) {
        type = 'stylesheet';
      } else if (lower.endsWith('.js')) {
        type = 'script';
      } else if (lower.endsWith('.woff') || lower.endsWith('.woff2') || lower.endsWith('.ttf')) {
        type = 'font';
      }

      // Avoid duplicates if already flagged by DOM scanner
      const exists = findings.some((f) => f.url === fail.url);
      if (!exists) {
        findings.push({
          type,
          url: fail.url,
          reason: `Network request failed with status ${fail.status || 'unknown'}: ${fail.errorText || 'HTTP Error'}`,
        });
      }
    }

    return {
      hasBrokenAssets: findings.length > 0,
      brokenAssets: findings,
      totalImagesScanned: domResult.totalImagesScanned,
      totalStylesheetsScanned: domResult.totalStylesheetsScanned,
    };
  }
}
