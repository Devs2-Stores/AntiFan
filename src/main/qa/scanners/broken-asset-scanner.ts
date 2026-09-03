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

      let imageCount = images.length;
      let linkCount = links.length;

      // 1. Check broken images
      for (const img of images) {
        const rawAttrSrc = img.getAttribute('src');
        const isEmptyAttr = rawAttrSrc !== null && (rawAttrSrc.trim() === '' || rawAttrSrc.trim() === '#' || rawAttrSrc.trim() === 'about:blank');
        const isPageUrl = typeof window !== 'undefined' && window.location && typeof window.location.href === 'string' && img.src === window.location.href;
        const rawSrc = (isEmptyAttr || isPageUrl) ? '' : (rawAttrSrc || img.src || '');
        const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-srcset') || img.getAttribute('data-lazy-src') || img.getAttribute('srcset');

        const hasLazyClass = Boolean(
          (img.classList && typeof img.classList.contains === 'function' && (img.classList.contains('lazyload') || img.classList.contains('lazyloaded'))) ||
          (typeof img.className === 'string' && /lazyload/i.test(img.className))
        );

        // If empty src or placeholder src, check lazy attributes without evaluating img.src (which resolves to page URL)
        if (!rawSrc || rawSrc.trim() === '' || rawSrc.trim() === '#' || rawSrc.trim() === 'about:blank') {
          if (!lazySrc && (!img.closest || !img.closest('[data-lazy]')) && !hasLazyClass) {
            findings.push({
              type: 'image',
              url: '(empty src)',
              elementSelector: getSelector(img),
              reason: 'Image tag has empty src and no data-src lazy attribute'
            });
          }
          continue;
        }

        const src = rawSrc;
        // Ignore valid data URIs and blank placeholder SVGs
        if (src.startsWith('data:image/svg+xml') || src.startsWith('data:image/gif;base64,R0lGODlhAQABA') || src.startsWith('data:image/png;base64,iVBORw0KGgo')) {
          continue;
        }

        // If lazy loaded image that hasn't loaded yet, do not flag prematurely
        if (lazySrc && !img.complete && img.naturalWidth === 0) {
          continue;
        }

        // Check if image failed to load in DOM
        if (img.complete && (img.naturalWidth === 0 || img.naturalHeight === 0)) {
          if (lazySrc && hasLazyClass) {
            continue;
          }
          findings.push({
            type: 'image',
            url: rawSrc || src,
            elementSelector: getSelector(img),
            reason: 'Image completed loading with 0 natural width/height (load failure)'
          });
        }
      }

      function getSelector(el) {
        if (!el) return '';
        let s = el.tagName.toLowerCase();
        if (el.id) return s + '#' + el.id;
        if (el.className && typeof el.className === 'string' && el.className.trim().length > 0) {
          const parts = el.className.trim().split(/\\s+/).filter(Boolean);
          if (parts.length > 0) {
            s += '.' + parts.slice(0, 2).join('.');
          }
        }
        if (el.getAttribute('alt')) {
          s += '[alt="' + el.getAttribute('alt').slice(0, 25).replace(/"/g, '') + '"]';
        } else if (el.parentElement) {
          const parent = el.parentElement;
          const pSel = parent.id ? '#' + parent.id : (parent.className && typeof parent.className === 'string' && parent.className.trim() ? '.' + parent.className.trim().split(/\\s+/)[0] : parent.tagName.toLowerCase());
          s = pSel + ' > ' + s;
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
