import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SettingsFinding {
  rule: string;
  id?: string;
  file: string;
  line?: number;
  message?: string;
  detail?: string;
  count?: number;
}

export interface BaselineFile {
  reviewed: boolean;
  bootstrappedAt: string;
  counts: Record<string, number>;
  totalFindings: number;
  /** Rule set the counts were recorded under; absent on baselines from the original set (1). */
  rulesetVersion?: number;
}

/**
 * Version of the settings rule set. A baseline recorded under an older set never ran the rules
 * added since, so what they find is the theme as it already was, not a regression: the first
 * evaluation under the newer set absorbs those findings as legacy debt.
 */
export const SETTINGS_RULESET_VERSION = 2;

/** Rules each rule-set version added; version 1 is the original set. */
const RULES_ADDED_IN_VERSION: Record<number, ReadonlySet<string>> = {
  2: new Set([
    'dead-setting',
    'F1GENZ_SCHEMA_FAILURE',
    'residue-vocabulary',
    'duplicate-group',
    'select-default-invalid',
    'data-orphan-key',
    'select-value-invalid',
    'image-picker-theme-scoped-url',
    'image-picker-bare-default',
    'image-picker-bare-value',
    'image-picker-default-missing',
    'image-picker-empty',
    'social-bare-domain',
    'liquid-hardcoded-fallback',
    'liquid-hardcoded-handle',
    'setting-id-unguarded',
    'duplicate-setting-id',
  ]),
};

export interface LoadBaselineOptions {
  baselinePath?: string;
  reviewed?: boolean;
}

export interface EvaluateRatchetOptions {
  workspaceRoot?: string;
  baselinePath?: string;
  persist?: boolean;
  deadIds?: Array<{ id: string } | string>;
}

export interface SettingsRatchetResult {
  ok: boolean;
  newFailures: SettingsFinding[];
  legacyDebt: SettingsFinding[];
  baselineUpdated: boolean;
  auditOnly: boolean;
  deadInSchema?: number;
}

/**
 * Multiset key for finding comparison: (rule, id, file), ignoring line shifts.
 */
export function findingKey(f: SettingsFinding): string {
  const normFile = (f.file || '').replace(/\\/g, '/');
  return `${f.rule}::${f.id ?? ''}::${normFile}`;
}

/**
 * Load existing baseline or bootstrap a new one in AUDIT mode (reviewed: false).
 */
export function loadOrBootstrapBaseline(
  workspaceRoot: string,
  currentFindings: SettingsFinding[],
  options: LoadBaselineOptions = {}
): BaselineFile {
  const targetPath = options.baselinePath || path.join(workspaceRoot, '.antifan', 'settings-baseline.json');
  if (fs.existsSync(targetPath)) {
    try {
      const raw = fs.readFileSync(targetPath, 'utf8');
      const parsed = JSON.parse(raw) as BaselineFile;
      const counts = parsed.counts && typeof parsed.counts === 'object' ? parsed.counts : {};
      const totalFindings = typeof parsed.totalFindings === 'number'
        ? parsed.totalFindings
        : Object.values(counts).reduce((s, c) => s + (typeof c === 'number' ? c : 0), 0);
      return {
        reviewed: Boolean(parsed.reviewed),
        bootstrappedAt: typeof parsed.bootstrappedAt === 'string' ? parsed.bootstrappedAt : new Date().toISOString(),
        counts,
        totalFindings,
        rulesetVersion: typeof parsed.rulesetVersion === 'number' ? parsed.rulesetVersion : 1,
      };
    } catch {
      // If corrupted, fall through to re-bootstrap
    }
  }

  // First bootstrap: calculate multiset counts
  const counts: Record<string, number> = {};
  let totalFindings = 0;
  for (const f of currentFindings) {
    const key = findingKey(f);
    const inc = typeof f.count === 'number' ? f.count : 1;
    counts[key] = (counts[key] || 0) + inc;
    totalFindings += inc;
  }

  const baseline: BaselineFile = {
    reviewed: options.reviewed ?? false, // First bootstrap: AUDIT mode (reviewed: false) per AC #3
    bootstrappedAt: new Date().toISOString(),
    counts,
    totalFindings,
    rulesetVersion: SETTINGS_RULESET_VERSION,
  };

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(baseline, null, 2), 'utf8');
  } catch {
    // Non-fatal if filesystem is read-only
  }

  return baseline;
}

/**
 * Compare working findings with baseline using multiset keys.
 * Monotonically ratchets down when findings are fixed.
 * Only blocks when baseline is reviewed and newFailures > 0.
 *
 * NOT PURE: ratchet-down always mutates `baseline.counts`/`totalFindings` in
 * place; `persist: false` only suppresses the disk write. Read-only callers
 * (cockpit) must pass `{ persist: false }` AND re-load via
 * loadOrBootstrapBaseline per evaluation — never reuse a baseline object.
 */
export function evaluateSettingsRatchet(
  baseline: BaselineFile,
  currentFindings: SettingsFinding[],
  optionsOrWorkspaceRoot?: string | EvaluateRatchetOptions
): SettingsRatchetResult {
  const isStringOpt = typeof optionsOrWorkspaceRoot === 'string';
  const workspaceRoot = isStringOpt ? optionsOrWorkspaceRoot : optionsOrWorkspaceRoot?.workspaceRoot;
  const baselinePathOpt = isStringOpt ? undefined : optionsOrWorkspaceRoot?.baselinePath;
  const persistOpt = isStringOpt ? true : (optionsOrWorkspaceRoot?.persist ?? true);
  const deadIdsOpt = isStringOpt ? undefined : optionsOrWorkspaceRoot?.deadIds;

  const workingMap = new Map<string, number>();
  const findingsByKey = new Map<string, SettingsFinding>();

  for (const f of currentFindings) {
    const key = findingKey(f);
    const inc = typeof f.count === 'number' ? f.count : 1;
    workingMap.set(key, (workingMap.get(key) || 0) + inc);
    if (!findingsByKey.has(key)) {
      findingsByKey.set(key, f);
    }
  }
  const newFailures: SettingsFinding[] = [];
  const legacyDebt: SettingsFinding[] = [];
  let baselineUpdated = false;

  const recordedVersion = typeof baseline.rulesetVersion === 'number' ? baseline.rulesetVersion : 1;
  if (recordedVersion < SETTINGS_RULESET_VERSION) {
    const addedRules = new Set<string>();
    for (let version = recordedVersion + 1; version <= SETTINGS_RULESET_VERSION; version++) {
      RULES_ADDED_IN_VERSION[version]?.forEach((rule) => addedRules.add(rule));
    }
    if (!baseline.counts) baseline.counts = {};
    for (const [key, workingCount] of workingMap) {
      if (addedRules.has(key.split('::')[0] || '')) {
        baseline.counts[key] = Math.max(baseline.counts[key] || 0, workingCount);
      }
    }
    baseline.rulesetVersion = SETTINGS_RULESET_VERSION;
    baselineUpdated = true;
  }

  const allKeys = new Set<string>([
    ...workingMap.keys(),
    ...Object.keys(baseline.counts || {}),
  ]);

  for (const key of allKeys) {
    const workingCount = workingMap.get(key) || 0;
    const baseCount = (baseline.counts && baseline.counts[key]) || 0;
    const diff = workingCount - baseCount;

    const parts = key.split('::');
    const templateFinding: SettingsFinding = findingsByKey.get(key) || {
      rule: parts[0] || 'SETTINGS_FINDING',
      id: parts[1] || undefined,
      file: parts[2] || '',
    };

    if (diff > 0) {
      newFailures.push({
        ...templateFinding,
        count: diff,
      });
    }

    if (workingCount > 0 && (diff <= 0 || baseCount > 0)) {
      // Legacy debt = pre-existing baseline violations still present in the
      // working tree. When the same key also regresses (diff > 0), the baseline
      // portion remains debt — dropping it would make metrics oscillate and
      // understate the true debt while a new failure is active.
      const debtCount = diff > 0 ? baseCount : workingCount;
      legacyDebt.push({
        ...templateFinding,
        count: debtCount,
      });
    }

    if (diff < 0) {
      // Monotonic ratchet down: workingCount < baseCount
      if (!baseline.counts) baseline.counts = {};
      if (workingCount <= 0) {
        delete baseline.counts[key];
      } else {
        baseline.counts[key] = workingCount;
      }
      baselineUpdated = true;
    }
  }

  if (baselineUpdated) {
    baseline.totalFindings = Object.values(baseline.counts || {}).reduce((s, c) => s + (typeof c === 'number' ? c : 0), 0);
    const persistPath = baselinePathOpt || (workspaceRoot ? path.join(workspaceRoot, '.antifan', 'settings-baseline.json') : null);
    if (persistPath && persistOpt !== false) {
      try {
        fs.mkdirSync(path.dirname(persistPath), { recursive: true });
        fs.writeFileSync(persistPath, JSON.stringify(baseline, null, 2), 'utf8');
      } catch {
        // Non-fatal write failure
      }
    }
  }

  const blocking = Boolean(baseline.reviewed && newFailures.length > 0);
  const deadInSchema = Array.isArray(deadIdsOpt)
    ? deadIdsOpt.length
    : currentFindings.filter((f) => f.rule === 'dead-setting' || f.rule === 'SETTING_DEAD_IN_SCHEMA').length;
  return {
    ok: !blocking,
    newFailures,
    legacyDebt,
    baselineUpdated,
    auditOnly: !baseline.reviewed,
    ...(Array.isArray(deadIdsOpt) || deadInSchema > 0 ? { deadInSchema } : {}),
  };
}
