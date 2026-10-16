export interface SweepViewport {
  w: number;
  h: number;
}

export interface SweepBreakpoint {
  id: string;
  name: string;
  width: number;
  height: number;
  mobile: boolean;
  deviceScaleFactor?: number;
}

export const SWEEP_VIEWPORT_MAX_ENTRIES = 5;
export const SWEEP_VIEWPORT_MIN_PX = 200;
export const SWEEP_VIEWPORT_MAX_PX = 3000;

/** Standard widths with the heights the host sweep has always used. */
export const DEFAULT_SWEEP_BREAKPOINTS: readonly SweepBreakpoint[] = [
  { id: 'mobile-small', name: 'Mobile Small (320px)', width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
  { id: 'mobile-standard', name: 'Mobile Standard (375px)', width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
  { id: 'tablet-portrait', name: 'Tablet Portrait (768px)', width: 768, height: 1024, deviceScaleFactor: 2, mobile: false },
  { id: 'tablet-landscape', name: 'Tablet Landscape (1024px)', width: 1024, height: 768, deviceScaleFactor: 2, mobile: false },
  { id: 'desktop-laptop', name: 'Desktop Laptop (1440px)', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
];

/**
 * Short viewports where fixed headers, sticky bars and cookie banners eat most of the screen:
 * a landscape phone, a small laptop, and a phone with the keyboard open. A caller adds them
 * through `viewports`; no sweep includes them unasked.
 */
export const SHORT_HEIGHT_VIEWPORTS: readonly SweepViewport[] = [
  { w: 667, h: 375 },
  { w: 1366, h: 600 },
  { w: 375, h: 350 },
];

/** Validate a caller's `viewports` list and turn it into sweep breakpoints. Throws a plain Error naming the bad entry. */
export function viewportsToBreakpoints(viewports: unknown): SweepBreakpoint[] {
  if (!Array.isArray(viewports) || viewports.length === 0) {
    throw new Error('viewports must be a non-empty array of { w, h }');
  }
  if (viewports.length > SWEEP_VIEWPORT_MAX_ENTRIES) {
    throw new Error(`viewports cannot exceed ${SWEEP_VIEWPORT_MAX_ENTRIES} entries`);
  }
  const seen = new Set<string>();
  return viewports.map((entry, index) => {
    const v = entry as { w?: unknown; h?: unknown } | null;
    const w = v && typeof v === 'object' ? v.w : undefined;
    const h = v && typeof v === 'object' ? v.h : undefined;
    const inRange = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= SWEEP_VIEWPORT_MIN_PX && n <= SWEEP_VIEWPORT_MAX_PX;
    if (!inRange(w) || !inRange(h)) {
      throw new Error(`viewports[${index}] must be { w, h } with both between ${SWEEP_VIEWPORT_MIN_PX} and ${SWEEP_VIEWPORT_MAX_PX}`);
    }
    const width = Math.round(w);
    const height = Math.round(h);
    const key = `${width}x${height}`;
    if (seen.has(key)) throw new Error(`viewports[${index}] repeats ${key}`);
    seen.add(key);
    const mobile = width < 768;
    return {
      id: `vp-${key}`,
      name: `Viewport ${width}x${height}`,
      width,
      height,
      mobile,
      deviceScaleFactor: mobile ? 2 : 1,
    };
  });
}

/**
 * Breakpoints one sweep measures: the base list (standard five unless the caller named its own)
 * followed by the caller's extra `viewports`. An extra that repeats a base width+height is dropped.
 */
export function resolveSweepBreakpoints(base: readonly SweepBreakpoint[] | undefined, viewports: unknown): SweepBreakpoint[] {
  const list: SweepBreakpoint[] = (base && base.length > 0 ? base : DEFAULT_SWEEP_BREAKPOINTS).map((b) => ({ ...b }));
  if (viewports === undefined || viewports === null) return list;
  const have = new Set(list.map((b) => `${b.width}x${b.height}`));
  for (const extra of viewportsToBreakpoints(viewports)) {
    if (!have.has(`${extra.width}x${extra.height}`)) list.push(extra);
  }
  return list;
}
