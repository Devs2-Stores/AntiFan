/**
 * In-page probe for the responsive sweep: names the elements that make the layout wider than the
 * emulated viewport. It runs only when a width's reading shows the document wider than its window,
 * so the receipt can point at the element ("needs 186px in a 160px column") instead of at the page.
 *
 * A culprit is an element that sticks out of its parent's content box, or whose own text or
 * children run past its box. Only the deepest such elements are kept: every ancestor of an
 * overflowing element overflows too, and listing them would bury the cause.
 */

export interface SweepOverflowCulprit {
  selector: string;
  /** Width the element needs, in CSS px. */
  neededPx: number;
  /** Width its parent (or its own box, for content running past it) offers, in CSS px. */
  availablePx: number;
}

export const SWEEP_OVERFLOW_CULPRIT_LIMIT = 5;

export function buildSweepOverflowCulpritScript(): string {
  return `(() => {
    const limit = ${SWEEP_OVERFLOW_CULPRIT_LIMIT};
    const body = document.body;
    if (!body) return [];
    const nodes = Array.from(body.querySelectorAll('*')).slice(0, 6000);
    const pathOf = (el) => {
      const parts = [];
      for (let n = el; n && n !== document.body && parts.length < 3; n = n.parentElement) {
        let part = n.tagName.toLowerCase();
        if (n.id) { part += '#' + n.id; parts.unshift(part); break; }
        const cls = typeof n.className === 'string' ? n.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
        if (cls.length) part += '.' + cls.join('.');
        parts.unshift(part);
      }
      return parts.join(' > ');
    };
    const hits = new Map();
    for (const el of nodes) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const parent = el.parentElement;
      let needed = 0;
      let available = 0;
      if (parent && parent !== document.documentElement && parent !== body) {
        const pcs = getComputedStyle(parent);
        if (pcs.overflowX === 'visible' && pcs.display !== 'contents') {
          const pr = parent.getBoundingClientRect();
          const room = pr.left + parent.clientWidth - r.left;
          if (cs.position !== 'absolute' && r.width > room + 1) { needed = Math.max(r.width, el.scrollWidth); available = Math.max(0, room); }
        }
      }
      if (!needed && cs.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        needed = el.scrollWidth; available = el.clientWidth;
      }
      if (needed) hits.set(el, { needed, available });
    }
    const deepest = [];
    for (const [el, info] of hits) {
      let hasDeeper = false;
      for (const other of hits.keys()) { if (other !== el && el.contains(other)) { hasDeeper = true; break; } }
      if (!hasDeeper) deepest.push({ el, info });
    }
    deepest.sort((a, b) => (b.info.needed - b.info.available) - (a.info.needed - a.info.available));
    return deepest.slice(0, limit).map(({ el, info }) => ({
      selector: pathOf(el), neededPx: Math.round(info.needed), availablePx: Math.round(info.available),
    }));
  })()`;
}

export function describeSweepOverflowCulprits(culprits: readonly SweepOverflowCulprit[]): string {
  return culprits.map((c) => `${c.selector} needs ${c.neededPx}px of ${c.availablePx}px`).join('; ');
}
