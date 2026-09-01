export interface OverflowCulprit {
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
  hasOverflow: boolean;
  deltaX: number;
  scrollWidth: number;
  clientWidth: number;
  culprits: OverflowCulprit[];
}

export interface LayoutOverflowScanReport {
  hasAnyOverflow: boolean;
  maxDeltaX: number;
  results: ViewportOverflowResult[];
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
      const rawDeltaX = scrollWidth - clientWidth;
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
                if (el.id) selector += '#' + el.id;
                else if (el.className && typeof el.className === 'string') {
                  selector += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
                }

                culprits.push({
                  selector,
                  tagName: el.tagName.toLowerCase(),
                  id: el.id || undefined,
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

      return {
        viewport: {
          name: '${viewportName}',
          width: window.innerWidth,
          height: window.innerHeight
        },
        hasOverflow: deltaX > 0,
        deltaX: Math.round(deltaX * 10) / 10,
        scrollWidth,
        clientWidth,
        culprits
      };
    })()`;
  }

  /**
   * Standard device presets for multi-breakpoint testing
   */
  public static readonly BREAKPOINTS = [
    { name: 'mobile' as const, width: 393, height: 852, label: 'iPhone 16 (Mobile)' },
    { name: 'tablet' as const, width: 820, height: 1180, label: 'iPad Air (Tablet)' },
    { name: 'desktop' as const, width: 1440, height: 900, label: 'Standard Laptop (Desktop)' },
  ];
}
