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
}

export interface LoadBaselineOptions {
  baselinePath?: string;
  reviewed?: boolean;
}

export interface EvaluateRatchetOptions {
  workspaceRoot?: string;
  baselinePath?: string;
  persist?: boolean;
}

export interface SettingsRatchetResult {
  ok: boolean;
  newFailures: SettingsFinding[];
  legacyDebt: SettingsFinding[];
  baselineUpdated: boolean;
  auditOnly: boolean;
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
  const options: EvaluateRatchetOptions =
    typeof optionsOrWorkspaceRoot === 'string'
      ? { workspaceRoot: optionsOrWorkspaceRoot }
      : optionsOrWorkspaceRoot || {};

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
    const persistPath = options.baselinePath || (options.workspaceRoot ? path.join(options.workspaceRoot, '.antifan', 'settings-baseline.json') : null);
    if (persistPath && options.persist !== false) {
      try {
        fs.mkdirSync(path.dirname(persistPath), { recursive: true });
        fs.writeFileSync(persistPath, JSON.stringify(baseline, null, 2), 'utf8');
      } catch {
        // Non-fatal write failure
      }
    }
  }

  const blocking = Boolean(baseline.reviewed && newFailures.length > 0);
  return {
    ok: !blocking,
    newFailures,
    legacyDebt,
    baselineUpdated,
    auditOnly: !baseline.reviewed,
  };
}
