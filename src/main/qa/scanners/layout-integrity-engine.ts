export interface LayoutIntegrityFinding {
  kind: 'overlap' | 'clipping' | 'occlusion' | 'offscreen' | 'zero-size' | 'sticky-obstruction' | 'layout-shift';
  severity: 'critical' | 'warning';
  selector: string; // best-effort CSS path, capped 200 chars
  details: string; // human sentence, capped 240 chars
  rect?: { x: number; y: number; w: number; h: number };
}

export interface LayoutIntegrityResult {
  measured: boolean;
  unmeasuredReason?: string; // REQUIRED when measured === false (same marker contract as overflow engine)
  viewport: {
    name?: string;
    width: number;
    height: number;
  };
  findings: LayoutIntegrityFinding[];
}

export class LayoutIntegrityEngine {
  /**
   * Standard device presets for multi-breakpoint testing
   */
  public static readonly BREAKPOINTS = [
    { name: 'mobile' as const, width: 393, height: 852, label: 'iPhone 16 (Mobile)' },
    { name: 'tablet' as const, width: 820, height: 1180, label: 'iPad Air (Tablet)' },
    { name: 'desktop' as const, width: 1440, height: 900, label: 'Standard Laptop (Desktop)' },
  ];

  /**
   * Browser injection script to verify visual layout integrity:
   * 1. zero-size / offscreen controls
   * 2. text clipping
   * 3. element overlaps
   * 4. CTA occlusion
   * 5. sticky/fixed element obstruction
   * 6. layout shift witness
   *
   * Wrapped in self-executing IIFE for isolated evaluation.
   */
  public static getBrowserScanScript(viewportName: string = 'active'): string {
    return `(() => {
  try {
    const doc = document.documentElement;
    const body = document.body;
    const measured = Boolean(doc && Number.isFinite(doc.clientWidth) && doc.clientWidth > 0);
    const viewportWidth = window.innerWidth || (doc ? doc.clientWidth : 0);
    const viewportHeight = window.innerHeight || (doc ? doc.clientHeight : 0);

    if (!measured) {
      return {
        measured: false,
        unmeasuredReason: 'the scanned tab has no laid-out CSS viewport (documentElement.clientWidth=' + (doc ? doc.clientWidth : 'null') + ', window.innerWidth=' + window.innerWidth + '); layout integrity was not measured',
        viewport: {
          name: '${viewportName}',
          width: viewportWidth,
          height: viewportHeight
        },
        findings: []
      };
    }

    let findings = [];

    const capDetails = (str) => {
      if (typeof str !== 'string') return '';
      return str.length > 240 ? str.slice(0, 237) + '...' : str;
    };

    const getSelector = (el) => {
      if (!el || el.nodeType !== 1) return 'document';
      try {
        const parts = [];
        let curr = el;
        while (curr && curr.nodeType === 1 && parts.length < 4 && curr !== document.documentElement && curr !== document.body) {
          let part = curr.tagName.toLowerCase();
          if (curr.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(curr.id)) {
            part += '#' + curr.id;
            parts.unshift(part);
            break;
          } else if (curr.className && typeof curr.className === 'string') {
            const cls = curr.className.trim().split(/\\s+/).find(c => c && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(c));
            if (cls) part += '.' + cls;
          }
          parts.unshift(part);
          curr = curr.parentElement;
        }
        if (parts.length === 0 && curr) {
          parts.push(curr.tagName.toLowerCase());
        }
        const sel = parts.join(' > ');
        return sel.length > 200 ? sel.slice(0, 200) : sel;
      } catch {
        return (el.tagName ? el.tagName.toLowerCase() : 'element').slice(0, 200);
      }
    };

    const isEffectivelyHidden = (el, style) => {
      if (!el || el.nodeType !== 1) return true;
      if (el.hasAttribute && el.hasAttribute('hidden')) return true;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
      if (el.closest && el.closest('[hidden], [aria-hidden="true"], details:not([open])')) return true;
      const s = style || (window.getComputedStyle ? window.getComputedStyle(el) : null);
      if (!s) return false;
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0' || parseFloat(s.opacity) <= 0) return true;
      return false;
    };

    const getDepth = (el) => {
      let d = 0;
      let curr = el;
      while (curr && curr !== document.body && curr !== document.documentElement) {
        d++;
        curr = curr.parentElement;
      }
      return d;
    };

    const isLegitOverlay = (el, style) => {
      if (style && style.pointerEvents === 'none') return true;
      const cls = typeof el.className === 'string' ? el.className : '';
      const id = el.id || '';
      const role = el.getAttribute ? (el.getAttribute('role') || '') : '';
      const ariaHasPopup = el.getAttribute ? (el.getAttribute('aria-haspopup') || '') : '';
      const hintPattern = /(?:badge|tooltip|popover|overlay|modal|dropdown)/i;
      if (hintPattern.test(cls) || hintPattern.test(id) || hintPattern.test(role) || ariaHasPopup) return true;
      if (el.closest && el.closest('[class*="badge" i], [class*="tooltip" i], [class*="popover" i], [class*="overlay" i], [class*="modal" i], [class*="dropdown" i]')) return true;
      return false;
    };

    const allElements = Array.from(document.querySelectorAll('*')).slice(0, 2000);

    // 1. zero-size / offscreen
    try {
      const interactiveSelector = 'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, [data-action]';
      const interactiveElements = Array.from(document.querySelectorAll(interactiveSelector)).slice(0, 500);

      for (let i = 0; i < interactiveElements.length; i++) {
        const el = interactiveElements[i];
        if (!el || el.nodeType !== 1) continue;
        if (isEffectivelyHidden(el)) continue;

        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
        const style = window.getComputedStyle ? window.getComputedStyle(el) : {};

        if (rect.width <= 0 || rect.height <= 0) {
          findings.push({
            kind: 'zero-size',
            severity: 'critical',
            selector: getSelector(el),
            details: capDetails('Visible actionable control has zero dimensions (' + Math.round(rect.width) + 'x' + Math.round(rect.height) + 'px)'),
            rect: {
              x: Math.round(rect.x !== undefined ? rect.x : rect.left),
              y: Math.round(rect.y !== undefined ? rect.y : rect.top),
              w: Math.round(rect.width),
              h: Math.round(rect.height)
            }
          });
        } else {
          const isOffscreen = rect.right <= 0 ||
                              rect.bottom <= 0 ||
                              rect.left >= viewportWidth ||
                              (style.position === 'fixed' && rect.top >= viewportHeight) ||
                              (rect.top >= viewportHeight && (!doc.scrollHeight || doc.scrollHeight <= viewportHeight));
          if (isOffscreen) {
            findings.push({
              kind: 'offscreen',
              severity: 'critical',
              selector: getSelector(el),
              details: capDetails('Visible actionable control is rendered offscreen (x: ' + Math.round(rect.x !== undefined ? rect.x : rect.left) + ', y: ' + Math.round(rect.y !== undefined ? rect.y : rect.top) + ')'),
              rect: {
                x: Math.round(rect.x !== undefined ? rect.x : rect.left),
                y: Math.round(rect.y !== undefined ? rect.y : rect.top),
                w: Math.round(rect.width),
                h: Math.round(rect.height)
              }
            });
          }
        }
      }
    } catch (err) {
      findings.push({
        kind: 'zero-size',
        severity: 'warning',
        selector: 'document',
        details: capDetails('Detector zero-size/offscreen threw: ' + (err && err.message ? err.message : String(err)))
      });
    }

    // 2. clipping
    try {
      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        if (!el || el.nodeType !== 1) continue;
        if (isEffectivelyHidden(el)) continue;

        let hasDirectText = false;
        if (el.childNodes && el.childNodes.length > 0) {
          for (let j = 0; j < el.childNodes.length; j++) {
            const child = el.childNodes[j];
            if (child && child.nodeType === 3 && child.nodeValue && child.nodeValue.trim().length > 0) {
              hasDirectText = true;
              break;
            }
          }
        }

        if (!hasDirectText) continue;

        const isHorizClipped = el.scrollWidth > el.clientWidth + 2;
        const isVertClipped = el.scrollHeight > el.clientHeight + 2;

        if (isHorizClipped || isVertClipped) {
          const isCritical = Boolean(el.matches && el.matches('a[href], button, [role="button"], input, select, textarea, [data-action]'));
          const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0 };
          findings.push({
            kind: 'clipping',
            severity: isCritical ? 'critical' : 'warning',
            selector: getSelector(el),
            details: capDetails('Visible text clipped in <' + el.tagName.toLowerCase() + '>: ' + (isHorizClipped ? 'scrollWidth (' + el.scrollWidth + ') > clientWidth (' + el.clientWidth + ')' : 'scrollHeight (' + el.scrollHeight + ') > clientHeight (' + el.clientHeight + ')')),
            rect: {
              x: Math.round(rect.x !== undefined ? rect.x : rect.left),
              y: Math.round(rect.y !== undefined ? rect.y : rect.top),
              w: Math.round(rect.width),
              h: Math.round(rect.height)
            }
          });
        }
      }
    } catch (err) {
      findings.push({
        kind: 'clipping',
        severity: 'warning',
        selector: 'document',
        details: capDetails('Detector clipping threw: ' + (err && err.message ? err.message : String(err)))
      });
    }

    // 3. overlap
    try {
      const overlapCandidates = [];
      for (let i = 0; i < allElements.length && overlapCandidates.length < 200; i++) {
        const el = allElements[i];
        if (!el || el.nodeType !== 1) continue;
        if (getDepth(el) > 6) continue;
        if (isEffectivelyHidden(el)) continue;

        const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
        if (!style || style.pointerEvents === 'none') continue;
        if (el.closest && el.closest('dialog, [role="dialog"], [aria-modal="true"]')) continue;
        if (isLegitOverlay(el, style)) continue;

        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
        const area = rect.width * rect.height;
        if (area <= 0) continue;

        overlapCandidates.push({ el, rect, style, area });
      }

      for (let i = 0; i < overlapCandidates.length; i++) {
        for (let j = i + 1; j < overlapCandidates.length; j++) {
          const itemA = overlapCandidates[i];
          const itemB = overlapCandidates[j];

          // Ancestor-descendant suppression
          if (itemA.el.contains(itemB.el) || itemB.el.contains(itemA.el)) continue;

          // Header sticky/fixed suppression
          const isStickyOrFixedA = itemA.style.position === 'fixed' || itemA.style.position === 'sticky';
          const isStickyOrFixedB = itemB.style.position === 'fixed' || itemB.style.position === 'sticky';
          if (isStickyOrFixedA || isStickyOrFixedB) continue;

          const rectA = itemA.rect;
          const rectB = itemB.rect;

          const ix = Math.max(0, Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left));
          const iy = Math.max(0, Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top));
          const intersectionArea = ix * iy;

          if (intersectionArea > 0) {
            const minArea = Math.min(itemA.area, itemB.area);
            if (minArea > 0 && (intersectionArea / minArea) > 0.6) {
              const isCritical = Boolean((itemA.el.matches && itemA.el.matches('a[href], button, [role="button"], input, select, textarea, [data-action]')) ||
                                 (itemB.el.matches && itemB.el.matches('a[href], button, [role="button"], input, select, textarea, [data-action]')));
              const pct = Math.round((intersectionArea / minArea) * 100);
              findings.push({
                kind: 'overlap',
                severity: isCritical ? 'critical' : 'warning',
                selector: getSelector(itemA.el),
                details: capDetails('Elements overlap by ' + pct + '% (' + getSelector(itemA.el) + ' and ' + getSelector(itemB.el) + ')'),
                rect: {
                  x: Math.round(Math.max(rectA.left, rectB.left)),
                  y: Math.round(Math.max(rectA.top, rectB.top)),
                  w: Math.round(ix),
                  h: Math.round(iy)
                }
              });
            }
          }
        }
      }
    } catch (err) {
      findings.push({
        kind: 'overlap',
        severity: 'warning',
        selector: 'document',
        details: capDetails('Detector overlap threw: ' + (err && err.message ? err.message : String(err)))
      });
    }

    // 4. occlusion
    try {
      const ctaSelector = 'button, a[href], input[type="submit"], [role="button"], [name*="cart" i], [class*="add-to-cart" i], nav a, header nav a';
      const ctaCandidates = Array.from(document.querySelectorAll(ctaSelector)).slice(0, 100);

      for (let i = 0; i < ctaCandidates.length; i++) {
        const el = ctaCandidates[i];
        if (!el || el.nodeType !== 1) continue;
        if (isEffectivelyHidden(el)) continue;
        if (el.closest && el.closest('details:not([open])')) continue;

        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 };
        if (rect.width <= 0 || rect.height <= 0) continue;

        const cx = Math.floor(rect.left + rect.width / 2);
        const cy = Math.floor(rect.top + rect.height / 2);

        if (cx < 0 || cx >= viewportWidth || cy < 0 || cy >= viewportHeight) continue;

        if (typeof document.elementFromPoint === 'function') {
          const topEl = document.elementFromPoint(cx, cy);
          if (!topEl) continue;
          if (topEl === el || el.contains(topEl)) continue;

          const topStyle = window.getComputedStyle ? window.getComputedStyle(topEl) : null;
          if (topStyle && topStyle.pointerEvents === 'none') continue;

          findings.push({
            kind: 'occlusion',
            severity: 'critical',
            selector: getSelector(el),
            details: capDetails('Actionable control is occluded by <' + topEl.tagName.toLowerCase() + (topEl.id ? '#' + topEl.id : '') + '> at center (' + cx + ', ' + cy + ')'),
            rect: {
              x: Math.round(rect.x !== undefined ? rect.x : rect.left),
              y: Math.round(rect.y !== undefined ? rect.y : rect.top),
              w: Math.round(rect.width),
              h: Math.round(rect.height)
            }
          });
        }
      }
    } catch (err) {
      findings.push({
        kind: 'occlusion',
        severity: 'warning',
        selector: 'document',
        details: capDetails('Detector occlusion threw: ' + (err && err.message ? err.message : String(err)))
      });
    }

    // 5. sticky-obstruction
    try {
      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        if (!el || el.nodeType !== 1) continue;
        if (isEffectivelyHidden(el)) continue;

        const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
        if (!style) continue;
        const isStickyOrFixed = style.position === 'sticky' || style.position === 'fixed';
        if (!isStickyOrFixed) continue;

        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, width: 0, height: 0 };
        const inTop25 = rect.top < (viewportHeight * 0.25) && rect.bottom > 0;
        if (!inTop25) continue;

        if (rect.width <= (viewportWidth * 0.30)) continue;

        const zIndex = parseInt(style.zIndex, 10);
        if (isNaN(zIndex) || zIndex <= 0) continue;

        const sampleY = Math.min(viewportHeight - 1, Math.max(0, Math.floor(rect.bottom - 2)));
        const sampleXs = [
          Math.floor(rect.left + rect.width * 0.25),
          Math.floor(rect.left + rect.width * 0.50),
          Math.floor(rect.left + rect.width * 0.75)
        ];

        let occludedFinding = null;

        for (let s = 0; s < sampleXs.length; s++) {
          const sx = sampleXs[s];
          if (sx < 0 || sx >= viewportWidth) continue;

          let occludedEl = null;

          if (typeof document.elementsFromPoint === 'function') {
            const stack = document.elementsFromPoint(sx, sampleY);
            if (Array.isArray(stack)) {
              for (let k = 0; k < stack.length; k++) {
                const under = stack[k];
                if (under && under !== el && !el.contains(under)) {
                  if (under.matches && under.matches('a[href], button, input, select, textarea, [role="button"], nav, nav *')) {
                    occludedEl = under;
                    break;
                  }
                }
              }
            }
          }

          if (!occludedEl && typeof document.elementFromPoint === 'function') {
            const originalPE = el.style ? el.style.pointerEvents : '';
            try {
              if (el.style) el.style.pointerEvents = 'none';
              const under = document.elementFromPoint(sx, sampleY);
              if (under && under !== el && !el.contains(under)) {
                if (under.matches && under.matches('a[href], button, input, select, textarea, [role="button"], nav, nav *')) {
                  occludedEl = under;
                }
              }
            } finally {
              if (el.style) el.style.pointerEvents = originalPE;
            }
          }

          if (occludedEl) {
            const isCritical = Boolean(occludedEl.matches && occludedEl.matches('input, select, textarea, form, nav, [role="navigation"], header nav, header nav *'));
            occludedFinding = {
              kind: 'sticky-obstruction',
              severity: isCritical ? 'critical' : 'warning',
              selector: getSelector(el),
              details: capDetails('Sticky/fixed element occludes ' + (isCritical ? 'form control or primary nav' : 'content links/controls') + ' at bottom edge (y: ' + sampleY + ')'),
              rect: {
                x: Math.round(rect.x !== undefined ? rect.x : rect.left),
                y: Math.round(rect.y !== undefined ? rect.y : rect.top),
                w: Math.round(rect.width),
                h: Math.round(rect.height)
              }
            };
            break;
          }
        }

        if (occludedFinding) {
          findings.push(occludedFinding);
        }
      }
    } catch (err) {
      findings.push({
        kind: 'sticky-obstruction',
        severity: 'warning',
        selector: 'document',
        details: capDetails('Detector sticky-obstruction threw: ' + (err && err.message ? err.message : String(err)))
      });
    }

    // 6. layout-shift witness
    try {
      let clsScore = 0;
      if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
        try {
          const entries = performance.getEntriesByType('layout-shift');
          if (Array.isArray(entries)) {
            for (let i = 0; i < entries.length; i++) {
              const entry = entries[i];
              if (entry && !entry.hadRecentInput && typeof entry.value === 'number') {
                clsScore += entry.value;
              }
            }
          }
        } catch {}
      }

      if (typeof PerformanceObserver !== 'undefined') {
        try {
          const observer = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            for (let i = 0; i < entries.length; i++) {
              const entry = entries[i];
              if (entry && !entry.hadRecentInput && typeof entry.value === 'number') {
                clsScore += entry.value;
              }
            }
          });
          observer.observe({ type: 'layout-shift', buffered: true });
          observer.disconnect();
        } catch {}
      }

      if (clsScore > 0.1) {
        findings.push({
          kind: 'layout-shift',
          severity: 'warning',
          selector: 'document',
          details: capDetails('Cumulative layout shift score exceeds threshold: ' + clsScore.toFixed(3) + ' > 0.1'),
          rect: {
            x: 0,
            y: 0,
            w: Math.round(viewportWidth),
            h: Math.round(viewportHeight)
          }
        });
      }
    } catch (err) {
      findings.push({
        kind: 'layout-shift',
        severity: 'warning',
        selector: 'document',
        details: capDetails('Detector layout-shift threw: ' + (err && err.message ? err.message : String(err)))
      });
    }

    // Cap total findings at 50, prefer criticals
    if (findings.length > 50) {
      const criticals = findings.filter(f => f.severity === 'critical');
      const warnings = findings.filter(f => f.severity !== 'critical');
      findings = criticals.concat(warnings).slice(0, 50);
    }

    return {
      measured: true,
      viewport: {
        name: '${viewportName}',
        width: viewportWidth,
        height: viewportHeight
      },
      findings
    };
  } catch (wholeErr) {
    return {
      measured: false,
      unmeasuredReason: 'layout integrity scan threw: ' + (wholeErr && wholeErr.message ? wholeErr.message : String(wholeErr)),
      viewport: {
        name: '${viewportName}',
        width: window.innerWidth || 0,
        height: window.innerHeight || 0
      },
      findings: []
    };
  }
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
}
