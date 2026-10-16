import type { ProbeDeps, ProbeFinding, ProbeResult } from './probe-deps';
import { PDP_PAGE_HELPERS_SOURCE } from './pdp-page-helpers';

export interface VariantImageProbeParams {
  maxValues?: number;
  productHandle?: string;
}

export interface VariantImageProbeData {
  perValue: Array<{
    option: string;
    value: string;
    expectedImage: string | null;
    shownImage: string | null;
    changed: boolean;
    mismatch: boolean;
  }>;
  optionValuesCount: Record<string, number>;
}

export interface CollectedVariant {
  id: number | string;
  sku: string;
  available: boolean;
  imageKey: string | null;
  options: Array<string | null>;
}

export interface CollectedControl {
  idx: number;
  option: string;
  value: string;
  kind: 'click' | 'select';
  probe: string;
  optionValue?: string;
  selected: boolean;
}

export interface CollectedProduct {
  ok: boolean;
  reason?: string;
  currentHandle: string | null;
  handle?: string | null;
  origin?: string;
  options?: Array<{ name: string; values: string[] }>;
  variants?: CollectedVariant[];
  controls?: CollectedControl[];
  missingOptions?: string[];
}

export interface VariantPageState {
  variantId: string | null;
  urlVariant: string | null;
  selected: Record<string, string>;
  shownUrl: string | null;
  shownKey: string | null;
}

const DEFAULT_MAX_VALUES = 12;
const MAX_VALUES_CEILING = 50;
const SETTLE_MS = 350;
const NAVIGATE_SETTLE_MS = 800;
const MAX_COLOUR_VALUES = 8;
const MAX_OTHER_VALUES = 10;

/** Resolves the product matrix, then tags one clickable element per option value with `data-antifan-probe`. */
export function buildVariantCollectScript(params: { handle?: string | null; maxValues: number }): string {
  return `(async () => {
${PDP_PAGE_HELPERS_SOURCE}
var hint = ${JSON.stringify(params.handle ?? null)};
var maxValues = ${JSON.stringify(params.maxValues)};
var cur = currentHandle();
var product = await loadProduct(hint || cur);
if (!product) return { ok: false, reason: 'no-product', currentHandle: cur, origin: location.origin };
Array.prototype.forEach.call(document.querySelectorAll('[data-antifan-probe]'), function (el) { el.removeAttribute('data-antifan-probe'); });
var counter = 0;
var controls = [];
var missing = [];
product.options.forEach(function (opt, idx) {
  var found = findOptionControls(opt, idx);
  if (!found) { missing.push(opt.name); return; }
  var before = controls.length;
  var values = opt.values.slice(0, maxValues);
  if (found.kind === 'select') {
    var sel = found.el;
    var selId = String(counter++);
    sel.setAttribute('data-antifan-probe', selId);
    values.forEach(function (v) {
      var o = Array.prototype.filter.call(sel.options, function (op) { return norm(op.value) === norm(v) || norm(op.textContent) === norm(v); })[0];
      if (!o) return;
      controls.push({ idx: idx, option: opt.name, value: v, kind: 'select', probe: selId, optionValue: o.value, selected: sel.value === o.value });
    });
  } else {
    values.forEach(function (v) {
      var nv = norm(v);
      var el = found.items.filter(function (it) { return valueTexts(it).indexOf(nv) >= 0; })[0];
      if (!el) return;
      var target = el;
      if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) {
        var lbl = labelsFor(el)[0];
        if (lbl) target = lbl;
      }
      var id = String(counter++);
      target.setAttribute('data-antifan-probe', id);
      controls.push({ idx: idx, option: opt.name, value: v, kind: 'click', probe: id, selected: isSelectedControl(el) });
    });
  }
  if (controls.length === before) missing.push(opt.name);
});
return { ok: true, currentHandle: cur, handle: product.handle || cur, origin: location.origin, options: product.options, variants: product.variants, controls: controls, missingOptions: missing };
})()`;
}

export function buildVariantStateScript(controls: CollectedControl[]): string {
  const slim = controls.map((c) => ({ idx: c.idx, value: c.value, probe: c.probe, kind: c.kind, optionValue: c.optionValue ?? null }));
  return `(function () {
${PDP_PAGE_HELPERS_SOURCE}
var controls = ${JSON.stringify(slim)};
var selected = {};
controls.forEach(function (c) {
  var el = document.querySelector('[data-antifan-probe="' + c.probe + '"]');
  if (!el) return;
  if (c.kind === 'select') { if (el.value === c.optionValue) selected[c.idx] = c.value; }
  else if (isSelectedControl(el)) selected[c.idx] = c.value;
});
var shownUrl = findGalleryImage();
return { variantId: readFormVariantId(), urlVariant: readUrlVariant(), selected: selected, shownUrl: shownUrl, shownKey: imageKey(shownUrl) };
})()`;
}

export function buildSelectValueScript(probe: string, optionValue: string): string {
  return `(function () {
var el = document.querySelector(${JSON.stringify(probeSelector(probe))});
if (!el) return false;
el.value = ${JSON.stringify(optionValue)};
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return el.value === ${JSON.stringify(optionValue)};
})()`;
}

function probeSelector(probe: string): string {
  return `[data-antifan-probe="${probe}"]`;
}

function clampMaxValues(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_MAX_VALUES;
  return Math.min(MAX_VALUES_CEILING, Math.max(1, Math.floor(raw)));
}

function norm(s: string): string {
  return s.normalize('NFD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/\u0111/g, 'd').replace(/\s+/g, ' ').trim();
}

function isColourOption(name: string): boolean {
  return /(^|\b)(mau|mau sac|color|colour)(\b|$)/.test(norm(name));
}

function emptyData(): VariantImageProbeData {
  return { perValue: [], optionValuesCount: {} };
}

function unmeasured(error: string, data: VariantImageProbeData = emptyData(), findings: ProbeFinding[] = []): ProbeResult<VariantImageProbeData> {
  return { measured: false, passed: null, findings, data, error };
}

function resolveVariant(collected: CollectedProduct, state: VariantPageState, control: CollectedControl): CollectedVariant | undefined {
  const variants = collected.variants ?? [];
  for (const id of [state.variantId, state.urlVariant]) {
    if (!id) continue;
    const hit = variants.find((v) => String(v.id) === String(id));
    if (hit && hit.options[control.idx] === control.value) return hit;
  }
  const selected = { ...state.selected, [String(control.idx)]: control.value };
  return variants.find((v) => Object.entries(selected).every(([i, val]) => v.options[Number(i)] === val));
}

async function collect(deps: ProbeDeps, handle: string | undefined, maxValues: number): Promise<CollectedProduct> {
  return (await deps.evalJs(buildVariantCollectScript({ handle, maxValues }))) as CollectedProduct;
}

async function clickControl(deps: ProbeDeps, control: CollectedControl): Promise<{ ok: boolean; error?: string }> {
  if (control.kind === 'select') {
    const applied = await deps.evalJs(buildSelectValueScript(control.probe, control.optionValue ?? control.value));
    return applied === true ? { ok: true } : { ok: false, error: 'select value was not applied' };
  }
  return deps.click(probeSelector(control.probe));
}

function analyze(collected: CollectedProduct, perValue: VariantImageProbeData['perValue']): ProbeFinding[] {
  const findings: ProbeFinding[] = [];
  const options = collected.options ?? [];
  const variants = collected.variants ?? [];
  const controls = collected.controls ?? [];

  for (const opt of options) {
    const rows = perValue.filter((r) => r.option === opt.name);
    const clash = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i];
        const b = rows[j];
        if (!a || !b) continue;
        if (a.expectedImage && b.expectedImage && a.expectedImage !== b.expectedImage && a.shownImage && a.shownImage === b.shownImage) {
          clash.add(a.value);
          clash.add(b.value);
        }
      }
    }
    if (clash.size > 0) {
      findings.push({
        ruleId: 'swatch-no-image-switch',
        severity: 'critical',
        message: `Option "${opt.name}": values ${[...clash].slice(0, 4).join(', ')} map to different variant images but the gallery shows the same image`,
        measured: { option: opt.name, values: [...clash] },
      });
    }
  }

  options.forEach((opt, idx) => {
    if (!isColourOption(opt.name) || opt.values.length < 2) return;
    const without = opt.values.filter((value) => {
      const matching = variants.filter((v) => v.options[idx] === value);
      return matching.length > 0 && matching.every((v) => !v.imageKey);
    });
    if (without.length > 0) {
      findings.push({
        ruleId: 'variant-missing-featured-image',
        severity: 'critical',
        message: `Option "${opt.name}": ${without.length} value(s) have no variant featured image, so the gallery cannot switch (${without.slice(0, 4).join(', ')})`,
        measured: { option: opt.name, values: without },
      });
    }
  });

  options.forEach((opt) => {
    const usesSelect = controls.some((c) => c.option === opt.name && c.kind === 'select');
    const limit = isColourOption(opt.name) ? MAX_COLOUR_VALUES : MAX_OTHER_VALUES;
    if (!usesSelect && opt.values.length > limit) {
      findings.push({
        ruleId: 'option-values-excess',
        severity: 'info',
        message: `Option "${opt.name}" renders ${opt.values.length} values as separate controls (limit ${limit}) without grouping`,
        measured: { option: opt.name, count: opt.values.length, limit },
      });
    }
  });

  for (const name of collected.missingOptions ?? []) {
    findings.push({
      ruleId: 'option-control-not-found',
      severity: 'warning',
      message: `No clickable control was found for option "${name}"; its values were not probed`,
      measured: { option: name },
    });
  }
  return findings;
}

export async function runVariantImageProbe(deps: ProbeDeps, p: VariantImageProbeParams): Promise<ProbeResult<VariantImageProbeData>> {
  const maxValues = clampMaxValues(p.maxValues);
  let collected: CollectedProduct;
  try {
    collected = await collect(deps, p.productHandle, maxValues);
    if (collected.ok && p.productHandle && collected.currentHandle !== p.productHandle) {
      if (!deps.navigate || !collected.origin) return unmeasured(`current page is not the product "${p.productHandle}" and navigation is unavailable`);
      const navigated = await deps.navigate(`${collected.origin}/products/${encodeURIComponent(p.productHandle)}`);
      if (!navigated) return unmeasured(`navigation to product "${p.productHandle}" failed`);
      await deps.wait(NAVIGATE_SETTLE_MS);
      collected = await collect(deps, p.productHandle, maxValues);
    }
  } catch (err) {
    return unmeasured(err instanceof Error ? err.message : String(err));
  }
  if (!collected.ok) return unmeasured(collected.reason === 'no-product' ? 'no product metadata found on the current page' : (collected.reason ?? 'product collection failed'));
  if (!p.productHandle && !collected.currentHandle) return unmeasured('current page is not a product page');

  const options = collected.options ?? [];
  const optionValuesCount: Record<string, number> = {};
  for (const opt of options) optionValuesCount[opt.name] = opt.values.length;
  if (options.length === 0) return { measured: true, passed: true, findings: [], data: { perValue: [], optionValuesCount } };

  let controls = collected.controls ?? [];
  if (controls.length === 0) return unmeasured('no option controls were found on the page', { perValue: [], optionValuesCount }, analyze(collected, []));

  const perValue: VariantImageProbeData['perValue'] = [];
  const findings: ProbeFinding[] = [];
  try {
    const baseline = (await deps.evalJs(buildVariantStateScript(controls))) as VariantPageState;
    let previousShown = baseline.shownKey;
    let lastState = baseline;
    const initialSelection = new Map<number, CollectedControl>();
    for (const c of controls) if (c.selected && !initialSelection.has(c.idx)) initialSelection.set(c.idx, c);

    for (const planned of [...controls]) {
      let control = planned;
      let clicked = await clickControl(deps, control);
      if (!clicked.ok) {
        const refreshed = await collect(deps, collected.handle ?? undefined, maxValues);
        const again = refreshed.controls?.find((c) => c.idx === control.idx && c.value === control.value);
        if (again) {
          control = again;
          controls = refreshed.controls ?? controls;
          clicked = await clickControl(deps, control);
        }
      }
      if (!clicked.ok) {
        findings.push({
          ruleId: 'variant-control-unclickable',
          severity: 'warning',
          message: `Option "${control.option}" value "${control.value}" could not be clicked: ${clicked.error ?? 'unknown error'}`,
          measured: { option: control.option, value: control.value },
        });
        continue;
      }
      await deps.wait(SETTLE_MS);
      const state = (await deps.evalJs(buildVariantStateScript(controls))) as VariantPageState;
      lastState = state;
      const variant = resolveVariant(collected, state, control);
      const expectedImage = variant?.imageKey ?? null;
      const shownImage = state.shownKey;
      perValue.push({
        option: control.option,
        value: control.value,
        expectedImage,
        shownImage,
        changed: shownImage !== previousShown,
        mismatch: expectedImage !== null && shownImage !== null && expectedImage !== shownImage,
      });
      previousShown = shownImage;
    }

    for (const [idx, original] of initialSelection) {
      if (lastState.selected[String(idx)] === original.value) continue;
      const target = controls.find((c) => c.idx === idx && c.value === original.value);
      if (target) await clickControl(deps, target);
    }
  } catch (err) {
    return unmeasured(err instanceof Error ? err.message : String(err), { perValue, optionValuesCount }, findings);
  }

  if (perValue.length > 0 && perValue.every((r) => r.shownImage === null)) {
    return unmeasured('the active gallery image could not be read after selecting option values', { perValue, optionValuesCount }, findings);
  }
  findings.push(...analyze(collected, perValue));
  return {
    measured: true,
    passed: !findings.some((f) => f.severity === 'critical'),
    findings,
    data: { perValue, optionValuesCount },
  };
}
