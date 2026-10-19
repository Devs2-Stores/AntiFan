import * as fs from 'node:fs';
import * as path from 'node:path';

export type QaProfile = 'audit' | 'build-strict';

export type QaTitleLevel = 'h1' | 'h2' | 'h3' | 'h4';

/** Thresholds the registry rules grade against (same shape as the kit `registry/thresholds.json`). */
export interface QaThresholds {
  minTextPx: number;
  minTapHitPx: number;
  /** Allowed rendered font-size range [min, max] in px per heading level at mobile widths. Without it same-level headings are compared with each other. */
  titleScale?: Record<QaTitleLevel, [number, number]>;
  /** Largest allowed height difference in px between inputs of one form. Defaults to 4. */
  inputHeightBandPx?: number;
}

export type QaThresholdsSource = 'explicit' | 'contract' | 'default';

/** Profile the workflow applies when its caller names none. */
export const DEFAULT_QA_PROFILE: QaProfile = 'build-strict';

/** Built-in values; they equal the kit registry/thresholds.json, which AntiFan must not read across repositories. */
export const DEFAULT_QA_THRESHOLDS: QaThresholds = Object.freeze({
  minTextPx: 12,
  minTapHitPx: 24,
});

const CONTRACT_RELATIVE_PATH = path.join('deliverables', 'FULL_REMAKE_CONTRACT.json');
const CONTRACT_KEYS = ['minTextPx', 'minTapHitPx'] as const;

export interface ResolvedQaThresholds {
  thresholds: QaThresholds;
  source: QaThresholdsSource;
  /** Why a present contract was not used (malformed typeScale, unreadable JSON). */
  note?: string;
}

function readContractTypeScale(workspaceRoot: string): { scale?: Record<string, unknown>; note?: string } {
  const file = path.join(workspaceRoot, CONTRACT_RELATIVE_PATH);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    return { note: `contract is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const designDefaults = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).designDefaults : undefined;
  if (!designDefaults || typeof designDefaults !== 'object') return {};
  const scale = (designDefaults as Record<string, unknown>).typeScale;
  if (scale === undefined) return {};
  if (!scale || typeof scale !== 'object' || Array.isArray(scale)) return { note: 'contract designDefaults.typeScale is not an object' };
  return { scale: scale as Record<string, unknown> };
}

/**
 * Explicit thresholds win; then the workspace contract's `designDefaults.typeScale` (a contract may
 * only tighten a built-in value, never loosen it); then the built-in defaults. A contract that cannot
 * be read as a whole falls back to the defaults and says why, so a malformed file never fails a run.
 */
export function resolveQaThresholds(a: { explicit?: QaThresholds; workspaceRoot?: string }): ResolvedQaThresholds {
  if (a.explicit) return { thresholds: a.explicit, source: 'explicit' };
  if (!a.workspaceRoot) return { thresholds: { ...DEFAULT_QA_THRESHOLDS }, source: 'default' };
  const { scale, note } = readContractTypeScale(a.workspaceRoot);
  if (!scale) return { thresholds: { ...DEFAULT_QA_THRESHOLDS }, source: 'default', ...(note ? { note } : {}) };
  const merged: QaThresholds = { ...DEFAULT_QA_THRESHOLDS };
  let applied = 0;
  for (const [key, value] of Object.entries(scale)) {
    if (!(CONTRACT_KEYS as readonly string[]).includes(key)) {
      return { thresholds: { ...DEFAULT_QA_THRESHOLDS }, source: 'default', note: `contract designDefaults.typeScale.${key} is not a known threshold (${CONTRACT_KEYS.join(', ')})` };
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return { thresholds: { ...DEFAULT_QA_THRESHOLDS }, source: 'default', note: `contract designDefaults.typeScale.${key}=${JSON.stringify(value)} is not a positive number` };
    }
    const k = key as (typeof CONTRACT_KEYS)[number];
    merged[k] = Math.max(DEFAULT_QA_THRESHOLDS[k], value);
    applied++;
  }
  if (applied === 0) return { thresholds: { ...DEFAULT_QA_THRESHOLDS }, source: 'default' };
  return { thresholds: merged, source: 'contract' };
}
