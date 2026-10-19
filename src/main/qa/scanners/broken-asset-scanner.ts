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

      const BROKEN_LAZY_URL_RE = /(?:Liquid error|translation missing|(?:^|[/])(?:undefined|null)(?:[/]|$|[?#\\s,]))/i;

      const isVisibleStuckLazyImage = (img) => {
        if (document.readyState !== 'complete' || img.complete !== true) return false;
        const currentSrc = typeof img.currentSrc === 'string' ? img.currentSrc.trim() : '';
        if (currentSrc !== '' && !currentSrc.toLowerCase().startsWith('data:') && typeof img.naturalWidth === 'number' && img.naturalWidth > 1) {
          return false;
        }
        const isLazyLoading = Boolean(
          (img.classList && typeof img.classList.contains === 'function' && img.classList.contains('lazyloading')) ||
          (typeof img.className === 'string' && /(?:^|\\s)lazyloading(?:\\s|$)/i.test(img.className))
        );
        if (isLazyLoading) return false;
        const getStyle = (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function')
          ? window.getComputedStyle.bind(window)
          : (typeof getComputedStyle === 'function' ? getComputedStyle : null);
        if (getStyle) {
          const style = getStyle(img);
          if (style && style.visibility === 'hidden') return false;
        }
        if (typeof img.getBoundingClientRect !== 'function') return false;
        const rect = img.getBoundingClientRect();
        if (!rect || !(rect.width > 1) || !(rect.height > 1)) return false;
        const vh = (typeof window !== 'undefined' && typeof window.innerHeight === 'number') ? window.innerHeight : 900;
        const vw = (typeof window !== 'undefined' && typeof window.innerWidth === 'number') ? window.innerWidth : 1440;
        const top = typeof rect.top === 'number' ? rect.top : 0;
        const bottom = typeof rect.bottom === 'number' ? rect.bottom : top + rect.height;
        const left = typeof rect.left === 'number' ? rect.left : 0;
        const right = typeof rect.right === 'number' ? rect.right : left + rect.width;
        return bottom > 0 && top < vh && right > 0 && left < vw;
      };

      // 1. Check broken images
      for (const img of images) {
        const rawAttrSrc = img.getAttribute('src');
        const rawAttrSrcset = (typeof img.getAttribute === 'function' ? img.getAttribute('srcset') : null) || (typeof img.srcset === 'string' ? img.srcset : null);
        const hasSrcset = typeof rawAttrSrcset === 'string' && rawAttrSrcset.trim() !== '';
        const isEmptyAttr = rawAttrSrc !== null && (rawAttrSrc.trim() === '' || rawAttrSrc.trim() === '#' || rawAttrSrc.trim() === 'about:blank');
        const isPageUrl = typeof window !== 'undefined' && window.location && typeof window.location.href === 'string' && img.src === window.location.href;
        const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-srcset') || img.getAttribute('data-lazy-src');
        const currentSrc = typeof img.currentSrc === 'string' ? img.currentSrc.trim() : '';
        const validCurrentSrc = (currentSrc !== '' && (!isPageUrl || currentSrc !== img.src)) ? currentSrc : '';
        const fallbackSrcset = hasSrcset ? (validCurrentSrc || rawAttrSrcset.trim()) : '';
        const rawSrc = (isEmptyAttr || isPageUrl) ? fallbackSrcset : (rawAttrSrc || img.src || fallbackSrcset || '');
        // If empty src or placeholder src, check lazy attributes without evaluating img.src (which resolves to page URL)
        if (!rawSrc || rawSrc.trim() === '' || rawSrc.trim() === '#' || rawSrc.trim() === 'about:blank') {
          if (!lazySrc && (!img.closest || !img.closest('[data-lazy]'))) {
            findings.push({
              type: 'image',
              url: '(empty src)',
              elementSelector: getSelector(img),
              reason: 'Image tag has empty src and no data-src lazy attribute'
            });
          } else if (lazySrc) {
            if (typeof lazySrc === 'string' && BROKEN_LAZY_URL_RE.test(lazySrc)) {
              findings.push({
                type: 'image',
                url: lazySrc,
                elementSelector: getSelector(img),
                reason: 'Lazy image attribute contains broken Liquid output or invalid URL'
              });
            } else if (isVisibleStuckLazyImage(img)) {
              findings.push({
                type: 'image',
                url: lazySrc,
                elementSelector: getSelector(img),
                reason: 'Visible in-viewport lazy image never loaded its data-src into src'
              });
            }
          }
          continue;
        }

        const src = rawSrc;
        // Ignore valid data URIs and blank placeholder SVGs unless stuck in viewport or carrying broken lazySrc
        if (src.startsWith('data:image/svg+xml') || src.startsWith('data:image/gif;base64,R0lGODlhAQABA') || src.startsWith('data:image/png;base64,iVBORw0KGgo')) {
          if (lazySrc) {
            if (typeof lazySrc === 'string' && BROKEN_LAZY_URL_RE.test(lazySrc)) {
              findings.push({
                type: 'image',
                url: lazySrc,
                elementSelector: getSelector(img),
                reason: 'Lazy image attribute contains broken Liquid output or invalid URL'
              });
            } else if (isVisibleStuckLazyImage(img)) {
              findings.push({
                type: 'image',
                url: lazySrc,
                elementSelector: getSelector(img),
                reason: 'Visible in-viewport lazy image remained stuck on placeholder data URI'
              });
            }
          }
          continue;
        }

        // If lazy loaded image that hasn't loaded yet, do not flag prematurely
        if (lazySrc && !img.complete && img.naturalWidth === 0) {
          continue;
        }

        // Check if image failed to load in DOM
        if (img.complete && (img.naturalWidth === 0 || img.naturalHeight === 0)) {
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
        const elId = typeof el.id === 'string' ? el.id : (el.getAttribute('id') || '');
        if (elId) return s + '#' + elId;
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
          const parentId = typeof parent.id === 'string' ? parent.id : (parent.getAttribute('id') || '');
          const pSel = parentId ? '#' + parentId : (parent.className && typeof parent.className === 'string' && parent.className.trim() ? '.' + parent.className.trim().split(/\\s+/)[0] : parent.tagName.toLowerCase());
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
