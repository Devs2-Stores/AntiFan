/**
 * AntiFan Browser Desktop — side-by-side layout candidates.
 *
 * One call renders up to five CSS candidates for one section next to the current design
 * (baseline) at up to three widths, sequentially in the same tab so cookies, cart and data are
 * identical for every column. For each width x candidate it applies the CSS in memory, settles,
 * captures the section, measures it, and removes the CSS; the viewport is restored at the end.
 *
 * Deterministic outputs only: breaks disqualify (horizontal page overflow, content spilling out of
 * the section, clipped text, overlapping text), quality penalties lower a 0-100 score (contrast,
 * tap targets, type-scale sprawl, misaligned left edges, gaps off a 4px grid, ellipsis
 * truncation). Which surviving candidate looks best is left to a visual judge reading the
 * per-width contact sheets; this module never claims taste.
 */
import { VisualQualityScanner, type VisualQualityScanResult } from './scanners/visual-quality-scanner';

export interface LayoutCandidate {
  id: string;
  label?: string;
  css: string;
}

export interface LayoutCandidatesOptions {
  scopeSelector: string;
  candidates: LayoutCandidate[];
  /** CSS widths (default [375, 1440]); at most 3, each 240-3840. */
  breakpoints?: number[];
  /** Wait after applying each candidate (default 350ms, 100-2000). */
  settleMs?: number;
  /** Compare against the page as it is (default true). */
  includeBaseline?: boolean;
}

export interface SectionMetrics {
  found: boolean;
  rect: { x: number; y: number; width: number; height: number } | null;
  docOverflowX: boolean;
  spill: string[];
  /** Text or media of the section that runs past the viewport edge (lost even when the page masks overflow). */
  offViewport: string[];
  clippedText: string[];
  truncatedText: number;
  overlappingText: string[];
  fontSizes: number[];
  leftEdges: number;
  gapCount: number;
  gapsOnGrid: number;
}

export interface BreakCounts {
  pageOverflow: number;
  spill: number;
  offViewport: number;
  clippedText: number;
  overlappingText: number;
}

export interface CandidateWidthResult {
  width: number;
  artifact?: unknown;
  metrics?: SectionMetrics;
  visualQuality?: { contrastLow: number; tapTiny: number; samples: string[] };
  breaks: string[];
  breakCounts?: BreakCounts;
  penalties: Array<{ reason: string; points: number }>;
  score: number;
  error?: string;
}

export interface CandidateResult {
  id: string;
  label: string;
  isBaseline: boolean;
  widths: CandidateWidthResult[];
  score: number;
  disqualified: boolean;
  disqualifyReasons: string[];
  /** Breaks the section already has in the current design; reported, never disqualifying. */
  preExistingBreaks?: string[];
}

export interface LayoutCandidatesResult {
  measured: boolean;
  scopeSelector: string;
  breakpoints: number[];
  candidates: CandidateResult[];
  ranking: string[];
  recommendation: { id: string; reason: string } | null;
  contactSheets: Array<{ width: number; artifact?: unknown; columns: string[]; downscale: number; error?: string }>;
  scoring: string;
  durationMs: number;
  /** False when the tab could not be put back to the viewport it had before the run. */
  viewportRestored?: boolean;
  error?: string;
}

export interface LayoutCandidatesDeps {
  evalJs(script: string): Promise<unknown>;
  setViewportWidth(width: number): Promise<void>;
  /** Capture a document-coordinate rect as PNG bytes. */
  captureClip(rect: { x: number; y: number; width: number; height: number }): Promise<Buffer | null>;
  stagePng(png: Buffer, label: string): Promise<unknown>;
  /** Compose PNGs left-to-right; returns the sheet bytes and the downscale factor used. */
  composeSheet?(pngs: Buffer[]): Promise<{ png: Buffer; downscale: number } | null> | { png: Buffer; downscale: number } | null;
  /** Put the tab back as the run found it; false when the host refused part of the restore. */
  restoreViewport(): Promise<boolean | void>;
  wait(ms: number): Promise<void>;
  /**
   * Throws when the caller cancelled. Checked before every width and every candidate, outside
   * the per-candidate error capture, so a cancel ends the run (stylesheet cleared, viewport
   * restored) instead of being recorded as one candidate's error.
   */
  throwIfCancelled?(): void;
  now?(): number;
}

export const LAYOUT_CANDIDATE_LIMITS = Object.freeze({
  maxCandidates: 5,
  maxBreakpoints: 3,
  minWidth: 240,
  maxWidth: 3840,
  maxCssBytes: 64 * 1024,
  maxClipHeight: 2400,
  defaultSettleMs: 350,
  viewportSettleMs: 600,
});

export const LAYOUT_CANDIDATE_SCORING =
  'score = 100 - penalties (floored at 0), averaged over widths. Penalties: contrast below AA 5 each; tap target <24px 6 each (mobile widths); ellipsis-truncated text 1 each; more than 5 distinct font sizes 2 per extra size; more than 4 distinct left edges 2 per extra edge; share of vertical gaps off a 4px grid x 15. Breaks disqualify: page overflows horizontally, content spills out of the section, text clipped by overflow, or text boxes overlapping. Visual taste is not scored: compare the contact sheets.';

const STYLE_ID = '__antifan_candidate_override';

export function buildApplyCandidateScript(css: string | null): string {
  return `(() => {
  let el = document.getElementById(${JSON.stringify(STYLE_ID)});
  const css = ${JSON.stringify(css)};
  if (css === null) { if (el) el.remove(); return { applied: false }; }
  if (!el) {
    el = document.createElement('style');
    el.id = ${JSON.stringify(STYLE_ID)};
    el.setAttribute('data-antifan-override', 'true');
    (document.head || document.documentElement).appendChild(el);
  }
  el.textContent = css;
  return { applied: true, bytes: css.length };
})()`;
}

export function buildSectionMetricsScript(scopeSelector: string, maxClipHeight: number): string {
  return `(() => {
  const sel = ${JSON.stringify(scopeSelector)};
  let scope = null;
  try { scope = document.querySelector(sel); } catch (e) {}
  const vw = window.innerWidth;
  const docEl = document.scrollingElement || document.documentElement;
  if (!scope) return { found: false, rect: null, docOverflowX: docEl.scrollWidth > vw + 1, spill: [], offViewport: [], clippedText: [], truncatedText: 0, overlappingText: [], fontSizes: [], leftEdges: 0, gapCount: 0, gapsOnGrid: 0 };
  const selectorOf = (el) => {
    if (el.id) return '#' + el.id;
    let s = el.tagName.toLowerCase();
    if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
    return s;
  };
  const visible = (el, r) => r.width > 0 && r.height > 0 && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  const sr = scope.getBoundingClientRect();
  const sx = window.scrollX; const sy = window.scrollY;
  const all = Array.from(scope.querySelectorAll('*')).slice(0, 4000);
  // Up to and including the scope: a carousel section that scrolls or clips sideways keeps its
  // off-screen slides reachable, which is not spill.
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
      if (p === scope) break;
    }
    return false;
  };
  const spill = [];
  const offViewport = [];
  const MEDIA = /^(IMG|PICTURE|VIDEO|SVG|CANVAS|IFRAME|BUTTON|INPUT|SELECT|TEXTAREA)$/;
  const clipped = [];
  let truncated = 0;
  const sizes = new Set();
  const textBoxes = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    if ((r.right > sr.right + 2 || r.left < sr.left - 2) && !inScroller(el) && spill.length < 8) {
      spill.push(selectorOf(el) + ' ' + Math.round(r.left) + '..' + Math.round(r.right) + ' vs ' + Math.round(sr.left) + '..' + Math.round(sr.right));
    }
    let ownText = '';
    for (const n of el.childNodes) if (n.nodeType === 3) ownText += n.nodeValue;
    ownText = ownText.trim();
    // Past the viewport edge is lost whatever the page does with its own overflow: a masked
    // page (overflow-x: hidden on body) reports no document overflow while the text is cut off.
    if ((ownText || MEDIA.test(el.tagName.toUpperCase())) && (r.right > vw + 2 || r.left < -2) && !inScroller(el) && offViewport.length < 8) {
      offViewport.push(selectorOf(el) + ' ' + Math.round(r.left) + '..' + Math.round(r.right) + ' vs viewport 0..' + vw);
    }
    if (!ownText) continue;
    const cs = getComputedStyle(el);
    sizes.add(Math.round(parseFloat(cs.fontSize)));
    if (el.scrollWidth > el.clientWidth + 1 && (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflow === 'hidden')) {
      if (cs.textOverflow === 'ellipsis') truncated++;
      else if (clipped.length < 8) clipped.push(selectorOf(el) + ' "' + ownText.slice(0, 30) + '"');
    } else if (el.scrollHeight > el.clientHeight + 2 && (cs.overflowY === 'hidden' || cs.overflowY === 'clip') && cs.webkitLineClamp === 'none' && clipped.length < 8) {
      clipped.push(selectorOf(el) + ' "' + ownText.slice(0, 30) + '" (vertical)');
    }
    if (textBoxes.length < 400) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const tr = range.getBoundingClientRect();
      if (tr.width > 0 && tr.height > 0) textBoxes.push({ el, r: tr });
    }
  }
  const overlaps = [];
  for (let i = 0; i < textBoxes.length && overlaps.length < 6; i++) {
    for (let j = i + 1; j < textBoxes.length && overlaps.length < 6; j++) {
      const a = textBoxes[i]; const b = textBoxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ix >= 4 && iy >= Math.min(a.r.height, b.r.height) * 0.5) overlaps.push(selectorOf(a.el) + ' x ' + selectorOf(b.el));
    }
  }
  // Left-edge alignment and vertical rhythm over block children two levels deep.
  const edges = new Set();
  const gaps = [];
  const blocks = [];
  for (const child of Array.from(scope.children)) {
    blocks.push(child);
    for (const g of Array.from(child.children)) blocks.push(g);
  }
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r) || r.width < sr.width * 0.2) continue;
    edges.add(Math.round(r.left - sr.left));
  }
  for (const parent of [scope, ...Array.from(scope.children)]) {
    const kids = Array.from(parent.children).filter((k) => { const r = k.getBoundingClientRect(); return visible(k, r) && getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).position !== 'fixed'; });
    for (let i = 1; i < kids.length; i++) {
      const prev = kids[i - 1].getBoundingClientRect();
      const cur = kids[i].getBoundingClientRect();
      const gap = cur.top - prev.bottom;
      if (gap > 0 && gap < 400 && Math.abs(cur.left - prev.left) < 4) gaps.push(gap);
    }
  }
  const onGrid = gaps.filter((g) => { const m = g % 4; return m <= 1 || m >= 3; }).length;
  const height = Math.min(Math.round(sr.height), ${JSON.stringify(maxClipHeight)});
  return {
    found: true,
    rect: { x: Math.max(0, Math.round(sr.left + sx)), y: Math.max(0, Math.round(sr.top + sy)), width: Math.round(Math.min(sr.width, vw)), height },
    docOverflowX: docEl.scrollWidth > vw + 1,
    spill,
    offViewport,
    clippedText: clipped,
    truncatedText: truncated,
    overlappingText: overlaps,
    fontSizes: Array.from(sizes).sort((x, y) => x - y),
    leftEdges: edges.size,
    gapCount: gaps.length,
    gapsOnGrid: onGrid,
  };
})()`;
}

/** Pure scoring of one width measurement. */
export function scoreCandidateWidth(
  width: number,
  metrics: SectionMetrics,
  vq: { contrastLow: number; tapTiny: number }
): { breaks: string[]; breakCounts: BreakCounts; penalties: Array<{ reason: string; points: number }>; score: number } {
  const breaks: string[] = [];
  const breakCounts: BreakCounts = {
    pageOverflow: metrics.docOverflowX ? 1 : 0,
    spill: metrics.spill.length,
    offViewport: (metrics.offViewport || []).length,
    clippedText: metrics.clippedText.length,
    overlappingText: metrics.overlappingText.length,
  };
  if (metrics.docOverflowX) breaks.push(`page overflows horizontally at ${width}px`);
  if (metrics.spill.length) breaks.push(`content spills out of the section: ${metrics.spill.slice(0, 2).join('; ')}`);
  if (metrics.offViewport && metrics.offViewport.length) breaks.push(`content runs past the viewport edge: ${metrics.offViewport.slice(0, 2).join('; ')}`);
  if (metrics.clippedText.length) breaks.push(`text clipped: ${metrics.clippedText.slice(0, 2).join('; ')}`);
  if (metrics.overlappingText.length) breaks.push(`text overlaps: ${metrics.overlappingText.slice(0, 2).join('; ')}`);
  const penalties: Array<{ reason: string; points: number }> = [];
  const add = (reason: string, points: number) => { if (points > 0) penalties.push({ reason, points: Math.round(points * 10) / 10 }); };
  add(`${vq.contrastLow} text run(s) below WCAG AA`, vq.contrastLow * 5);
  add(`${vq.tapTiny} tap target(s) under 24px`, vq.tapTiny * 6);
  add(`${metrics.truncatedText} ellipsis-truncated text run(s)`, metrics.truncatedText);
  add(`${metrics.fontSizes.length} distinct font sizes`, Math.max(0, metrics.fontSizes.length - 5) * 2);
  add(`${metrics.leftEdges} distinct left edges`, Math.max(0, metrics.leftEdges - 4) * 2);
  if (metrics.gapCount > 0) add(`${metrics.gapCount - metrics.gapsOnGrid}/${metrics.gapCount} vertical gaps off a 4px grid`, (1 - metrics.gapsOnGrid / metrics.gapCount) * 15);
  const score = Math.max(0, Math.round((100 - penalties.reduce((s, p) => s + p.points, 0)) * 10) / 10);
  return { breaks, breakCounts, penalties, score };
}

const BREAK_KINDS: Array<[keyof BreakCounts, string]> = [
  ['pageOverflow', 'page horizontal overflow'],
  ['spill', 'content spilling out of the section'],
  ['offViewport', 'content past the viewport edge'],
  ['clippedText', 'clipped text'],
  ['overlappingText', 'overlapping text'],
];

/**
 * Breaks a candidate introduces relative to the baseline at the same width. Without a baseline
 * every break counts; with one, a candidate is only charged for breaks beyond what the current
 * design already has, so a pre-existing defect does not disqualify every option.
 */
export function introducedBreaks(candidate: BreakCounts, baseline: BreakCounts | undefined): string[] {
  const out: string[] = [];
  for (const [kind, label] of BREAK_KINDS) {
    const allowed = baseline ? baseline[kind] : 0;
    if (candidate[kind] > allowed) out.push(baseline ? `${label}: ${candidate[kind]} vs ${allowed} in the current design` : `${label}: ${candidate[kind]}`);
  }
  return out;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

/** Validate caller input; throws with a message the capability maps to INVALID_ARGUMENT. */
export function normalizeCandidateOptions(options: LayoutCandidatesOptions): { scopeSelector: string; sets: Array<{ id: string; label: string; css: string | null; isBaseline: boolean }>; breakpoints: number[]; settleMs: number } {
  const scopeSelector = typeof options.scopeSelector === 'string' ? options.scopeSelector.trim() : '';
  if (!scopeSelector) throw new Error('scopeSelector is required: name the section to compare');
  const raw = Array.isArray(options.candidates) ? options.candidates : [];
  if (raw.length < 1 || raw.length > LAYOUT_CANDIDATE_LIMITS.maxCandidates) {
    throw new Error(`candidates must hold 1-${LAYOUT_CANDIDATE_LIMITS.maxCandidates} entries (got ${raw.length})`);
  }
  const ids = new Set<string>();
  const sets: Array<{ id: string; label: string; css: string | null; isBaseline: boolean }> = [];
  if (options.includeBaseline !== false) sets.push({ id: 'baseline', label: 'Current design', css: null, isBaseline: true });
  for (const c of raw) {
    const id = typeof c?.id === 'string' ? c.id.trim() : '';
    if (!id || id === 'baseline' || ids.has(id)) throw new Error(`candidate ids must be unique, non-empty and not "baseline" (got "${id}")`);
    if (typeof c.css !== 'string' || !c.css.trim()) throw new Error(`candidate "${id}" has no css`);
    if (Buffer.byteLength(c.css) > LAYOUT_CANDIDATE_LIMITS.maxCssBytes) throw new Error(`candidate "${id}" css exceeds ${LAYOUT_CANDIDATE_LIMITS.maxCssBytes} bytes`);
    ids.add(id);
    sets.push({ id, label: typeof c.label === 'string' && c.label.trim() ? c.label.trim() : id, css: c.css, isBaseline: false });
  }
  const bpsRaw = Array.isArray(options.breakpoints) && options.breakpoints.length ? options.breakpoints : [375, 1440];
  if (bpsRaw.length > LAYOUT_CANDIDATE_LIMITS.maxBreakpoints) throw new Error(`at most ${LAYOUT_CANDIDATE_LIMITS.maxBreakpoints} breakpoints`);
  const breakpoints = Array.from(new Set(bpsRaw.map((w) => clampInt(w, LAYOUT_CANDIDATE_LIMITS.minWidth, LAYOUT_CANDIDATE_LIMITS.maxWidth, 1440))));
  const settleMs = clampInt(options.settleMs, 100, 2000, LAYOUT_CANDIDATE_LIMITS.defaultSettleMs);
  return { scopeSelector, sets, breakpoints, settleMs };
}

export async function runLayoutCandidates(deps: LayoutCandidatesDeps, options: LayoutCandidatesOptions): Promise<LayoutCandidatesResult> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const { scopeSelector, sets, breakpoints, settleMs } = normalizeCandidateOptions(options);
  const results: CandidateResult[] = sets.map((s) => ({ id: s.id, label: s.label, isBaseline: s.isBaseline, widths: [], score: 0, disqualified: false, disqualifyReasons: [] }));
  const sheets: LayoutCandidatesResult['contactSheets'] = [];
  let scopeMissingEverywhere = true;
  let viewportRestored: boolean | undefined;

  try {
    for (const width of breakpoints) {
      deps.throwIfCancelled?.();
      await deps.setViewportWidth(width);
      await deps.wait(LAYOUT_CANDIDATE_LIMITS.viewportSettleMs);
      const pngs: Buffer[] = [];
      const columns: string[] = [];
      for (let i = 0; i < sets.length; i++) {
        deps.throwIfCancelled?.();
        const set = sets[i]!;
        const out: CandidateWidthResult = { width, breaks: [], penalties: [], score: 0 };
        results[i]!.widths.push(out);
        try {
          await deps.evalJs(buildApplyCandidateScript(set.css));
          await deps.wait(settleMs);
          const metrics = (await deps.evalJs(buildSectionMetricsScript(scopeSelector, LAYOUT_CANDIDATE_LIMITS.maxClipHeight))) as SectionMetrics;
          if (!metrics || !metrics.found || !metrics.rect) {
            out.error = 'SCOPE_NOT_FOUND';
            continue;
          }
          scopeMissingEverywhere = false;
          out.metrics = metrics;
          const vqRaw: VisualQualityScanResult = VisualQualityScanner.normalize(await deps.evalJs(VisualQualityScanner.getBrowserScanScript({ scopeSelector, skipFloating: true })));
          const vq = {
            contrastLow: vqRaw.findings.filter((f) => f.ruleId === 'contrast-low').reduce((n, f) => n + (f.occurrences || 1), 0),
            tapTiny: vqRaw.findings.filter((f) => f.ruleId === 'tap-target-tiny').reduce((n, f) => n + (f.occurrences || 1), 0),
          };
          out.visualQuality = { ...vq, samples: vqRaw.findings.slice(0, 4).map((f) => f.details) };
          Object.assign(out, scoreCandidateWidth(width, metrics, vq));
          const png = await deps.captureClip(metrics.rect);
          if (png && png.length) {
            out.artifact = await deps.stagePng(png, `${set.id}@${width}`);
            pngs.push(png);
            columns.push(set.id);
          } else {
            out.error = 'CAPTURE_EMPTY';
          }
        } catch (err) {
          out.error = err instanceof Error ? err.message : String(err);
        }
      }
      // Clear between widths so the next viewport change lays out the untouched page.
      await deps.evalJs(buildApplyCandidateScript(null));
      if (deps.composeSheet && pngs.length > 1) {
        deps.throwIfCancelled?.();
        try {
          const sheet = await deps.composeSheet(pngs);
          if (sheet) sheets.push({ width, artifact: await deps.stagePng(sheet.png, `contact-sheet@${width}`), columns, downscale: sheet.downscale });
          else sheets.push({ width, columns, downscale: 1, error: 'COMPOSE_UNSUPPORTED_PNG' });
        } catch (err) {
          sheets.push({ width, columns, downscale: 1, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  } finally {
    try { await deps.evalJs(buildApplyCandidateScript(null)); } catch { /* page gone: nothing to clear */ }
    const restored = await deps.restoreViewport();
    if (typeof restored === 'boolean') viewportRestored = restored;
  }

  const baseline = results.find((r) => r.isBaseline);
  for (const r of results) {
    const measured = r.widths.filter((w) => w.metrics);
    if (r.isBaseline) {
      // The reference cannot be disqualified by its own defects; they are surfaced instead.
      r.preExistingBreaks = measured.flatMap((w) => w.breaks.map((b) => `${w.width}px: ${b}`));
      r.disqualifyReasons = [];
    } else {
      r.disqualifyReasons = measured.flatMap((w) => {
        const ref = baseline?.widths.find((bw) => bw.width === w.width && bw.breakCounts)?.breakCounts;
        const introduced = w.breakCounts ? introducedBreaks(w.breakCounts, ref) : [];
        return introduced.map((b) => `${w.width}px: ${b}`);
      });
    }
    r.disqualified = r.disqualifyReasons.length > 0 || measured.length < r.widths.length;
    if (measured.length < r.widths.length) r.disqualifyReasons.push('not measured at every width');
    r.score = measured.length ? Math.round((measured.reduce((s, w) => s + w.score, 0) / measured.length) * 10) / 10 : 0;
  }
  const ranking = results
    .filter((r) => !r.disqualified)
    .sort((a, b) => b.score - a.score || (a.isBaseline ? 1 : 0) - (b.isBaseline ? 1 : 0))
    .map((r) => r.id);
  const best = ranking.length ? results.find((r) => r.id === ranking[0])! : null;
  const runnerUp = ranking.length > 1 ? results.find((r) => r.id === ranking[1])! : null;
  const recommendation = best
    ? {
        id: best.id,
        reason: best.isBaseline
          ? 'No candidate beats the current design on the deterministic checks; keep it or judge the sheets visually.'
          : runnerUp && Math.abs(best.score - runnerUp.score) < 3
            ? `Top two are within 3 points (${best.id} ${best.score} vs ${runnerUp.id} ${runnerUp.score}): decide visually from the contact sheets.`
            : `Highest deterministic score among non-breaking candidates (${best.score}).`,
      }
    : null;
  return {
    measured: !scopeMissingEverywhere,
    scopeSelector,
    breakpoints,
    candidates: results,
    ranking,
    recommendation,
    contactSheets: sheets,
    scoring: LAYOUT_CANDIDATE_SCORING,
    durationMs: now() - started,
    ...(viewportRestored !== undefined ? { viewportRestored } : {}),
    ...(scopeMissingEverywhere ? { error: `SCOPE_NOT_FOUND: ${scopeSelector}` } : {}),
  };
}
