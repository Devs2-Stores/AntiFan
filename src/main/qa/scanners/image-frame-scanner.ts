/**
 * AntiFan Browser Desktop — Image Frame Scanner
 *
 * Deterministic in-page measurements of how a loaded <img> sits in its frame:
 *  - image-crop:    object-fit: cover hides more than 8% of the picture (rendered box and source
 *                   aspect ratios disagree), so the shopper sees a cut-off product or face.
 *  - image-low-res: the file the browser picked is narrower than 1.5x the width it is drawn at, so
 *                   it renders soft.
 *
 * Images that have not finished loading are counted in stats.imagesPending and not graded: a
 * missing natural size is a loading state, never a defect of the frame. Parked boxes (closed
 * drawers), visually hidden images and preview-bar chrome are skipped. Every rule reports
 * `warning`; whether a warning may fail a run is the QA workflow profile's decision.
 */

export const IMAGE_FRAME_RULE_IDS = ['image-crop', 'image-low-res'] as const;

export type ImageFrameRuleId = (typeof IMAGE_FRAME_RULE_IDS)[number];

export interface ImageFrameFinding {
  ruleId: ImageFrameRuleId;
  severity: 'warning';
  selector: string;
  details: string;
  rect?: { x: number; y: number; w: number; h: number };
  measured?: Record<string, unknown>;
  occurrences?: number;
}

export interface ImageFrameStats {
  imagesChecked: number;
  imagesPending: number;
  durationMs: number;
  truncated: boolean;
  truncatedReasons: string[];
  measuredRules: string[];
  unmeasuredRules: string[];
}

export interface ImageFrameScanResult {
  measured: boolean;
  viewport: { width: number; height: number };
  findings: ImageFrameFinding[];
  stats: ImageFrameStats;
  error?: string;
}

export interface ImageFrameScanOptions {
  /** Restrict the scan to this subtree. */
  scopeSelector?: string;
}

export const IMAGE_FRAME_LIMITS = Object.freeze({
  maxImages: 1500,
  maxFindingsPerRule: 40,
  minBoxPx: 32,
  maxCropShare: 0.08,
  minSourceToBoxRatio: 1.5,
});

export class ImageFrameScanner {
  public static getBrowserScanScript(options: ImageFrameScanOptions = {}): string {
    const opts = JSON.stringify({
      scopeSelector: typeof options.scopeSelector === 'string' && options.scopeSelector.trim() ? options.scopeSelector.trim() : null,
    });
    const limits = JSON.stringify(IMAGE_FRAME_LIMITS);
    const allRules = JSON.stringify(IMAGE_FRAME_RULE_IDS);
    return `(() => {
  const OPTS = ${opts};
  const L = ${limits};
  const ALL_RULES = ${allRules};
  const started = Date.now();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const PREVIEW_CHROME = '#preview-bar-iframe, [id*="preview-bar"], .preview-bar, ul.preview-cta, #haravan-notification, .hrv-admin-bar, #admin-bar-iframe, #PBarNextFrameWrapper, [data-antifan-override]';
  const findings = [];
  const counts = {};
  const truncatedReasons = [];
  const stats = { imagesChecked: 0, imagesPending: 0 };
  const merged = new Map();
  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    let sel = el.tagName.toLowerCase();
    if (typeof el.className === 'string' && el.className.trim()) {
      const cls = el.className.trim().split(/\\s+/).filter((c) => c && !c.includes(':')).slice(0, 2);
      if (cls.length) sel += '.' + cls.join('.');
    }
    return sel;
  }
  function rectOf(r) {
    return { x: Math.round(r.left), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  }
  function push(f, mergeKey) {
    if (mergeKey && merged.has(mergeKey)) { merged.get(mergeKey).occurrences += 1; return; }
    counts[f.ruleId] = (counts[f.ruleId] || 0) + 1;
    if (counts[f.ruleId] > L.maxFindingsPerRule) {
      const reason = f.ruleId + ' capped at ' + L.maxFindingsPerRule;
      if (!truncatedReasons.includes(reason)) truncatedReasons.push(reason);
      return;
    }
    f.occurrences = 1;
    findings.push(f);
    if (mergeKey) merged.set(mergeKey, f);
  }
  function rendered(el, r) {
    if (!r || r.width <= 0 || r.height <= 0) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0;
  }
  function visuallyHidden(r) { return r.width <= 1 || r.height <= 1; }
  function offCanvas(r) { return r.right <= 0 || r.left >= vw || r.bottom + window.scrollY <= 0; }
  const scope = (() => {
    if (!OPTS.scopeSelector) return document.body || document.documentElement;
    try { return document.querySelector(OPTS.scopeSelector) || null; } catch (e) { return null; }
  })();
  const report = () => ({ measuredRules: ALL_RULES.slice(), unmeasuredRules: [] });
  if (!scope) {
    return { measured: false, viewport: { width: vw, height: vh }, findings: [], stats: Object.assign(stats, { durationMs: Date.now() - started, truncated: false, truncatedReasons: [], measuredRules: [], unmeasuredRules: ALL_RULES.slice() }), error: 'SCOPE_NOT_FOUND' };
  }
  const images = scope.querySelectorAll('img');
  for (let i = 0; i < images.length; i++) {
    if (i >= L.maxImages) { truncatedReasons.push('image scan capped at ' + L.maxImages + ' images'); break; }
    const img = images[i];
    try {
      if (img.closest(PREVIEW_CHROME) || img.closest('[aria-hidden="true"]')) continue;
      const r = img.getBoundingClientRect();
      if (!rendered(img, r) || visuallyHidden(r) || offCanvas(r)) continue;
      if (r.width < L.minBoxPx || r.height < L.minBoxPx) continue;
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (!img.complete || !(nw > 0) || !(nh > 0)) { stats.imagesPending++; continue; }
      const src = String(img.currentSrc || img.src || '');
      if (/\\.svg(?:[?#]|$)/i.test(src) || src.startsWith('data:image/svg')) continue;
      stats.imagesChecked++;
      const cs = getComputedStyle(img);
      const sel = selectorOf(img);
      if (cs.objectFit === 'cover') {
        const scale = Math.max(r.width / nw, r.height / nh);
        const shownShare = Math.min(1, (r.width * r.height) / (scale * scale * nw * nh));
        const crop = 1 - shownShare;
        if (crop > L.maxCropShare) {
          const pct = Math.round(crop * 1000) / 10;
          push({
            ruleId: 'image-crop',
            severity: 'warning',
            selector: sel,
            details: 'Image ' + sel + ' (' + nw + 'x' + nh + ') is cropped by ' + pct + '% to fill its ' + Math.round(r.width) + 'x' + Math.round(r.height) + 'px frame with object-fit: cover',
            rect: rectOf(r),
            measured: { cropSharePct: pct, naturalWidth: nw, naturalHeight: nh, boxWidth: Math.round(r.width), boxHeight: Math.round(r.height), maxSharePct: L.maxCropShare * 100 },
          }, 'crop|' + sel + '|' + nw + 'x' + nh + '|' + Math.round(r.width) + 'x' + Math.round(r.height));
        }
      }
      if (nw < r.width * L.minSourceToBoxRatio) {
        const ratio = Math.round((nw / r.width) * 100) / 100;
        push({
          ruleId: 'image-low-res',
          severity: 'warning',
          selector: sel,
          details: 'Image ' + sel + ' source is ' + nw + 'px wide for a ' + Math.round(r.width) + 'px box (' + ratio + 'x, needs ' + L.minSourceToBoxRatio + 'x)',
          rect: rectOf(r),
          measured: { naturalWidth: nw, boxWidth: Math.round(r.width), ratio: ratio, minRatio: L.minSourceToBoxRatio },
        }, 'lowres|' + sel + '|' + nw + '|' + Math.round(r.width));
      }
    } catch (e) {}
  }
  return {
    measured: true,
    viewport: { width: vw, height: vh },
    findings: findings,
    stats: Object.assign(stats, { durationMs: Date.now() - started, truncated: truncatedReasons.length > 0, truncatedReasons: truncatedReasons }, report()),
  };
})()`;
  }

  /** Shape guard for a value returned by the in-page script. */
  public static normalize(raw: unknown): ImageFrameScanResult {
    const empty: ImageFrameScanResult = {
      measured: false,
      viewport: { width: 0, height: 0 },
      findings: [],
      stats: { imagesChecked: 0, imagesPending: 0, durationMs: 0, truncated: false, truncatedReasons: [], measuredRules: [], unmeasuredRules: [...IMAGE_FRAME_RULE_IDS] },
    };
    if (!raw || typeof raw !== 'object') return { ...empty, error: 'SCAN_RETURNED_NO_OBJECT' };
    const r = raw as Partial<ImageFrameScanResult>;
    if (r.measured !== true || !Array.isArray(r.findings) || !r.stats) {
      return { ...empty, error: typeof r.error === 'string' ? r.error : 'SCAN_SHAPE_INVALID' };
    }
    const stats = r.stats as ImageFrameStats;
    return { ...(r as ImageFrameScanResult), stats: { ...stats, measuredRules: stats.measuredRules ?? [], unmeasuredRules: stats.unmeasuredRules ?? [] } };
  }
}
