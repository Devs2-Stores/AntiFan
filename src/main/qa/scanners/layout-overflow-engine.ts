interface OverflowCulprit {
  selector: string;
  tagName: string;
  id?: string;
  className?: string;
  deltaX: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
    right: number;
  };
  outerHtmlSnippet: string;
  offendingStyles?: {
    width?: string;
    minWidth?: string;
    position?: string;
    overflow?: string;
    margin?: string;
  };
}

export interface ViewportOverflowResult {
  viewport: {
    name: 'mobile' | 'tablet' | 'desktop' | 'custom';
    width: number;
    height: number;
  };
  /**
   * False when the scanned tab had no laid-out CSS viewport to measure. `deltaX`
   * is then 0 because nothing was measured, not because nothing overflows.
   */
  measured: boolean;
  /** Present only alongside `measured: false`. */
  unmeasuredReason?: string;
  hasOverflow: boolean;
  deltaX: number;
  scrollWidth: number;
  clientWidth: number;
  culprits: OverflowCulprit[];
  innerClippedCulprits?: OverflowCulprit[];
}

export class LayoutOverflowEngine {
  /**
   * Browser injection script to calculate horizontal overflow and locate exact culprit elements
   * Wrapped in self-executing IIFE for isolated evaluation (RT-01 mitigation)
   */
  public static getBrowserScanScript(viewportName: string = 'active'): string {
    return `(() => {
      const doc = document.documentElement;
      const body = document.body;
      const dpr = window.devicePixelRatio || 1.0;
      const deadband = 1.0 * dpr; // RT-06 mitigation

      const scrollWidth = Math.max(doc.scrollWidth, body ? body.scrollWidth : 0);
      const clientWidth = doc.clientWidth || window.innerWidth;
      // The documentElement content box is the compositor-surface signal: an unrendered
      // tab lays out against a zero-width box, so neither it nor the
      // window width masking it may anchor a delta.
      const measured = Number.isFinite(doc.clientWidth) && doc.clientWidth > 0 && Number.isFinite(scrollWidth);
      const rawDeltaX = measured ? scrollWidth - clientWidth : 0;
      const deltaX = rawDeltaX > deadband ? rawDeltaX : 0;

      const culprits = [];

      if (deltaX > 0) {
        const viewportWidth = window.innerWidth || doc.clientWidth;
        
        // RT-04 mitigation: Top-level containers first to prevent unbounded tree walking
        const topContainers = Array.from(document.querySelectorAll('header, nav, main, section, footer, [id^="shopify-section-"], [id^="haravan-section-"], .section, .container, body > *'));

        const inspectedElements = new Set();

        function inspectElement(el) {
          if (!el || inspectedElements.has(el) || el.nodeType !== 1) return;
          inspectedElements.add(el);

          const rect = el.getBoundingClientRect();
          // Check if element extends beyond right edge or left edge of viewport
          const elRight = rect.right;
          const elDeltaRight = elRight - viewportWidth;
          const elDeltaLeft = -rect.left;
          const elDelta = Math.max(elDeltaRight, elDeltaLeft);

          if ((elDeltaRight > deadband || elDeltaLeft > deadband) && rect.width > 0 && rect.height > 0) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              let hasOffendingChild = false;
              if (el.children && el.children.length > 0) {
                for (let i = 0; i < el.children.length; i++) {
                  const child = el.children[i];
                  const childRect = child.getBoundingClientRect();
                  const childDeltaRight = childRect.right - viewportWidth;
                  const childDeltaLeft = -childRect.left;
                  if (childDeltaRight > deadband || childDeltaLeft > deadband) {
                    hasOffendingChild = true;
                    inspectElement(child);
                  }
                }
              }

              // If no child was found to be the narrower culprit, record this element
              if (!hasOffendingChild) {
                let selector = el.tagName.toLowerCase();
                const elId = typeof el.id === 'string' ? el.id : (el.getAttribute('id') || '');
                if (elId) selector += '#' + elId;
                else if (el.className && typeof el.className === 'string') {
                  selector += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
                }

                culprits.push({
                  selector,
                  tagName: el.tagName.toLowerCase(),
                  id: elId || undefined,
                  className: typeof el.className === 'string' ? el.className.trim() : undefined,
                  deltaX: Math.round(elDelta * 10) / 10,
                  boundingBox: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    right: Math.round(rect.right)
                  },
                  outerHtmlSnippet: (el.outerHTML || '').substring(0, 200).trim(),
                  offendingStyles: {
                    width: style.width,
                    minWidth: style.minWidth,
                    position: style.position,
                    overflow: style.overflow,
                    margin: style.margin
                  }
                });
              }
            }
          }
        }

        for (const container of topContainers) {
          inspectElement(container);
          if (culprits.length >= 10) break; // Limit findings per viewport
        }
      }

      const innerClippedCulprits = [];
      if (measured) {
        const clipContainers = typeof document.querySelectorAll === 'function'
          ? Array.from(document.querySelectorAll('header, nav, main, section, footer, [id^="shopify-section-"], [id^="haravan-section-"], .section, .container, .wrapper, .card, body > *'))
          : (body && body.children ? Array.from(body.children) : []);
        for (let cIdx = 0; cIdx < clipContainers.length && innerClippedCulprits.length < 10; cIdx++) {
          const container = clipContainers[cIdx];
          if (!container || container.nodeType !== 1 || !container.children || container.children.length === 0) continue;
          const cs = window.getComputedStyle(container);
          if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
          if (cs.overflowX !== 'hidden' && cs.overflowX !== 'clip') continue;
          const clsStr = typeof container.className === 'string' ? container.className : '';
          if (/swiper|carousel|slider|splide|flickity|glide|owl|marquee|ticker|sr-only|visually-hidden/i.test(clsStr)) continue;
          const cRect = typeof container.getBoundingClientRect === 'function' ? container.getBoundingClientRect() : null;
          if (!cRect || cRect.width <= 0 || cRect.height <= 0) continue;
          for (let k = 0; k < container.children.length && innerClippedCulprits.length < 10; k++) {
            const child = container.children[k];
            if (!child || child.nodeType !== 1 || typeof child.getBoundingClientRect !== 'function') continue;
            const chStyle = window.getComputedStyle(child);
            if (!chStyle || chStyle.display === 'none' || chStyle.visibility === 'hidden' || chStyle.opacity === '0' || chStyle.position === 'absolute' || chStyle.position === 'fixed') continue;
            if (chStyle.textOverflow === 'ellipsis') continue;
            const chCls = typeof child.className === 'string' ? child.className : '';
            if (/swiper|carousel|slider|splide|flickity|glide|owl|marquee|ticker|sr-only|visually-hidden/i.test(chCls)) continue;
            const chRect = child.getBoundingClientRect();
            const overR = chRect.right - cRect.right;
            const overL = cRect.left - chRect.left;
            const overDelta = Math.max(overR, overL);
            if (overDelta > deadband * 2 && chRect.width > 0 && chRect.height > 0) {
              let sel = (child.tagName || 'div').toLowerCase();
              if (child.id) sel = '#' + child.id;
              else if (chCls.trim()) sel += '.' + chCls.trim().split(/\\s+/).slice(0, 2).join('.');
              innerClippedCulprits.push({
                selector: sel,
                tagName: (child.tagName || 'div').toLowerCase(),
                id: child.id || undefined,
                className: chCls.trim() || undefined,
                deltaX: Math.round(overDelta * 10) / 10,
                boundingBox: {
                  x: Math.round(chRect.x || chRect.left || 0),
                  y: Math.round(chRect.y || chRect.top || 0),
                  width: Math.round(chRect.width),
                  height: Math.round(chRect.height),
                  right: Math.round(chRect.right)
                },
                outerHtmlSnippet: (child.outerHTML || '').substring(0, 200).trim(),
                offendingStyles: {
                  width: chStyle.width || '',
                  minWidth: chStyle.minWidth || '',
                  position: chStyle.position || '',
                  overflow: cs.overflowX || '',
                  margin: chStyle.margin || ''
                }
              });
            }
          }
        }
      }

      return {
        viewport: {
          name: '${viewportName}',
          width: window.innerWidth,
          height: window.innerHeight
        },
        measured,
        ...(measured
          ? {}
          : { unmeasuredReason: 'the scanned tab has no laid-out CSS viewport (documentElement.clientWidth=' + doc.clientWidth + ', window.innerWidth=' + window.innerWidth + '); horizontal overflow was not measured' }),
        hasOverflow: deltaX > 0,
        deltaX: Math.round(deltaX * 10) / 10,
        scrollWidth,
        clientWidth,
        culprits,
        ...(innerClippedCulprits.length > 0 ? { innerClippedCulprits } : {})
      };
    })()`;
  }

  /**
   * Marker reader for every consumer of the payload. Only an explicit
   * `measured: false` declares the surface unmeasurable, so a payload that
   * predates the marker is never mistaken for an unmeasured one.
   */
  public static readUnmeasuredReason(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return undefined;
    }
    const obj = payload as Record<string, unknown>;
    if (obj.measured !== false) {
      return undefined;
    }
    return typeof obj.unmeasuredReason === 'string' && obj.unmeasuredReason.trim().length > 0
      ? obj.unmeasuredReason
      : 'the scanned tab reported no measurable CSS viewport';
  }

  /**
   * Canonical QA viewport contract — the same five CSS widths the host
   * runResponsiveCheck sweep measures (320/375/768/1024/1440). Presets here are
   * metadata only; per-width measurement authority lives in the sweep.
   */
  public static readonly BREAKPOINTS = [
    { name: 'mobile' as const, width: 375, height: 667, label: 'Small Mobile (375)' },
    { name: 'mobile-xs' as const, width: 320, height: 568, label: 'Extra Small (320)' },
    { name: 'tablet' as const, width: 768, height: 1024, label: 'Tablet (768)' },
    { name: 'laptop' as const, width: 1024, height: 768, label: 'Laptop (1024)' },
    { name: 'desktop' as const, width: 1440, height: 900, label: 'Desktop (1440)' },
  ];
}
