/**
 * audits.mjs — Pure audit functions for AntiFan B-Lite v2 Fix Loop
 *
 * Single source of truth for scope, budget, expansion, drift, tool surface,
 * and self-verification audits. Shared between merge-gate and session hooks.
 *
 * INVARIANT: This module MUST remain 100% pure — NO filesystem operations,
 * NO network operations, NO external process execution, NO side effects on import.
 */

export const DECISIONS = Object.freeze({
  OK: 'OK',
  REFUSED_TOUCHED_PATH: 'REFUSED_TOUCHED_PATH',
  REFUSED_DIFF_BUDGET: 'REFUSED_DIFF_BUDGET',
  REFUSED_SCOPE_EXPANSION: 'REFUSED_SCOPE_EXPANSION',
  REFUSED_DRIFT: 'REFUSED_DRIFT',
  REFUSED_TOOL_SURFACE: 'REFUSED_TOOL_SURFACE',
  REFUSED_SELF_VERIFICATION: 'REFUSED_SELF_VERIFICATION',
});

export const LIFECYCLE_STATES = Object.freeze({
  FIXED_VERIFIED: 'FIXED_VERIFIED',
  REFUSED_SCOPE: 'REFUSED_SCOPE',
  STALEMATE: 'STALEMATE',
  SCOPE_DISCOVERY: 'SCOPE_DISCOVERY',
});

export const ROUTE_REFUSAL_CODES = Object.freeze({
  URL_HOST_MISMATCH: 'URL_HOST_MISMATCH',
  URL_THEME_MISMATCH: 'URL_THEME_MISMATCH',
  URL_PATH_MISMATCH: 'URL_PATH_MISMATCH',
  URL_EXPECTATION_MISSING: 'URL_EXPECTATION_MISSING',
});

export const DEFAULT_FORBIDDEN_PATHS = Object.freeze([]);

export const DEFAULT_PERMITTED_TOOLS = Object.freeze([
  'file.read',
  'file.write',
  'anti.*',
  'browser.*',
  'theme.*',
  'mcp__*',
  '**',
]);

export const DEFAULT_FORBIDDEN_TOOLS = Object.freeze([]);

/**
 * Normalizes a file path to POSIX style (forward slashes, stripped leading/trailing slashes).
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p) {
  if (typeof p !== 'string') return '';
  let s = p.replace(/\\/g, '/').trim();
  s = s.replace(/^\.\//, '');
  s = s.replace(/^\/+/, '');
  return s;
}

/**
 * Matches a relative file path against a pattern (exact, directory prefix, or wildcard * / **).
 * @param {string} pattern
 * @param {string} filePath
 * @returns {boolean}
 */
export function matchPathPattern(pattern, filePath) {
  const normPat = normalizePath(pattern);
  const normPath = normalizePath(filePath);

  if (!normPat || !normPath) return false;
  if (normPat === normPath) return true;

  // Directory prefix match: e.g. "assets/" matches "assets/theme.css"
  if (normPat.endsWith('/')) {
    return normPath.startsWith(normPat);
  }

  // Handle glob syntax
  if (normPat.includes('*')) {
    // Escape regex characters except *
    let regexStr = '^';
    let i = 0;
    while (i < normPat.length) {
      if (normPat[i] === '*' && normPat[i + 1] === '*') {
        // ** matches any number of directories/characters
        if (normPat[i + 2] === '/') {
          regexStr += '(?:.+/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else if (normPat[i] === '*') {
        // * matches within a path segment
        regexStr += '[^/]*';
        i += 1;
      } else if (['.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'].includes(normPat[i])) {
        regexStr += '\\' + normPat[i];
        i += 1;
      } else {
        regexStr += normPat[i];
        i += 1;
      }
    }
    regexStr += '$';
    try {
      const re = new RegExp(regexStr);
      return re.test(normPath);
    } catch {
      return false;
    }
  }

  // If pattern has no wildcard and no trailing slash, check if path equals or is inside directory
  if (normPath.startsWith(normPat + '/')) {
    return true;
  }

  return false;
}

/**
 * Normalizes a manifest (array of objects or map of entries) into a standard map:
 * { [normalizedPath]: { sha256: string, size: number } }
 * @param {Record<string, any> | Array<{path: string, sha256: string, size?: number, bytes?: number}>} manifest
 * @returns {Record<string, { sha256: string, size: number }>}
 */
export function normalizeManifestMap(manifest) {
  const map = {};
  if (!manifest) return map;

  if (Array.isArray(manifest)) {
    for (const item of manifest) {
      if (item && typeof item.path === 'string') {
        const norm = normalizePath(item.path);
        map[norm] = {
          sha256: String(item.sha256 || '').toLowerCase(),
          size: Number(item.size ?? item.bytes ?? 0),
        };
      }
    }
  } else if (typeof manifest === 'object') {
    // Check if manifest is an envelope: { files: { ... } } or { manifest: { ... } }
    const entries = manifest.files && typeof manifest.files === 'object'
      ? manifest.files
      : manifest;

    for (const [key, val] of Object.entries(entries)) {
      if (!val) continue;
      const norm = normalizePath(key);
      if (typeof val === 'string') {
        map[norm] = { sha256: val.toLowerCase(), size: 0 };
      } else if (typeof val === 'object') {
        map[norm] = {
          sha256: String(val.sha256 || '').toLowerCase(),
          size: Number(val.size ?? val.bytes ?? 0),
        };
      }
    }
  }
  return map;
}

/**
 * Bytes that differ between two versions of one file, for the budget's unit
 * ("bytes changed"). Lines one side carries more often than the other count by their own
 * byte length; a file whose line multiset is unchanged but whose bytes differ (a reorder,
 * or a change the multiset cannot localize) counts in full, because a change volume this
 * measure cannot attribute must not be reported as zero and slip under maxBytes.
 *
 * Pure: text in, bytes out. `baseSize`/`postSize` are the manifest sizes, used only for
 * that unattributable fallback.
 *
 * @param {string} baseText
 * @param {string} postText
 * @param {number} baseSize
 * @param {number} postSize
 * @returns {number}
 */
export function measureChangedBytes(baseText, postText, baseSize, postSize) {
  if (baseText === postText) return 0;
  const tally = (text) => {
    const counts = new Map();
    for (const line of String(text).split('\n')) counts.set(line, (counts.get(line) || 0) + 1);
    return counts;
  };
  const baseLines = tally(baseText);
  const postLines = tally(postText);
  // The newline each line carried is part of what changed, and counting it keeps an
  // added empty line from measuring as nothing.
  const bytesOf = (line) => Buffer.byteLength(line, 'utf8') + 1;

  let changed = 0;
  for (const [line, count] of postLines) {
    const before = baseLines.get(line) || 0;
    if (count > before) changed += (count - before) * bytesOf(line);
  }
  for (const [line, count] of baseLines) {
    const after = postLines.get(line) || 0;
    if (count > after) changed += (count - after) * bytesOf(line);
  }
  return changed > 0 ? changed : Math.max(Number(baseSize) || 0, Number(postSize) || 0);
}

/**
 * Computes difference between base manifest and post manifest.
 *
 * `changedBytesFor(path, baseEntry, postEntry)` is optional and returns the exact bytes
 * changed in one modified file. A caller with both file contents on disk supplies it, and
 * the budget then measures real change volume instead of the net size delta — a rewrite
 * that keeps the size nearly constant otherwise measures as a few bytes. Without it the
 * net delta is used, which is all a manifest-only caller can know.
 *
 * @param {any} baseManifest
 * @param {any} postManifest
 * @param {((path: string, baseEntry: any, postEntry: any) => number|null)} [changedBytesFor]
 * @returns {{
 *   touchedPaths: string[],
 *   addedPaths: string[],
 *   modifiedPaths: string[],
 *   deletedPaths: string[],
 *   unchangedPaths: string[],
 *   totalFilesChanged: number,
 *   totalBytesChanged: number,
 *   byteDeltas: Record<string, number>
 * }}
 */
export function computeManifestDiff(baseManifest, postManifest, changedBytesFor = null) {
  const baseMap = normalizeManifestMap(baseManifest);
  const postMap = normalizeManifestMap(postManifest);

  const allPaths = new Set([...Object.keys(baseMap), ...Object.keys(postMap)]);
  const addedPaths = [];
  const modifiedPaths = [];
  const deletedPaths = [];
  const unchangedPaths = [];
  const touchedPaths = [];
  const byteDeltas = {};
  let totalBytesChanged = 0;

  for (const p of allPaths) {
    const inBase = p in baseMap;
    const inPost = p in postMap;

    if (!inBase && inPost) {
      addedPaths.push(p);
      touchedPaths.push(p);
      const bytes = postMap[p].size;
      byteDeltas[p] = bytes;
      totalBytesChanged += bytes;
    } else if (inBase && !inPost) {
      deletedPaths.push(p);
      touchedPaths.push(p);
      const bytes = baseMap[p].size;
      byteDeltas[p] = bytes;
      totalBytesChanged += bytes;
    } else if (inBase && inPost) {
      if (baseMap[p].sha256 !== postMap[p].sha256) {
        modifiedPaths.push(p);
        touchedPaths.push(p);
        const measured = typeof changedBytesFor === 'function'
          ? changedBytesFor(p, baseMap[p], postMap[p])
          : null;
        const changeVolume = typeof measured === 'number' && measured >= 0
          ? measured
          : (() => {
              const delta = Math.abs(postMap[p].size - baseMap[p].size);
              return delta === 0 ? postMap[p].size : delta;
            })();
        byteDeltas[p] = changeVolume;
        totalBytesChanged += changeVolume;
      } else {
        unchangedPaths.push(p);
      }
    }
  }

  addedPaths.sort();
  modifiedPaths.sort();
  deletedPaths.sort();
  unchangedPaths.sort();
  touchedPaths.sort();

  return {
    touchedPaths,
    addedPaths,
    modifiedPaths,
    deletedPaths,
    unchangedPaths,
    totalFilesChanged: touchedPaths.length,
    totalBytesChanged,
    byteDeltas,
  };
}

/**
 * Audits touched paths against allowedFiles and forbiddenPaths.
 * Requirement: touchedPaths ⊆ allowedFiles AND touchedPaths ∩ forbiddenPaths === ∅
 *
 * @param {string[]} touchedPaths
 * @param {string[]} allowedFiles
 * @param {string[]} [forbiddenPaths]
 * @returns {{
 *   decision: 'OK' | 'REFUSED_TOUCHED_PATH',
 *   offendingPaths: string[],
 *   allowed: boolean,
 *   reason?: string
 * }}
 */
export function auditTouchedPaths(touchedPaths, allowedFiles = [], forbiddenPaths = DEFAULT_FORBIDDEN_PATHS) {
  const normAllowed = (allowedFiles || []).map(normalizePath).filter(Boolean);
  const normForbidden = (forbiddenPaths || []).map(normalizePath).filter(Boolean);

  const offending = new Set();

  for (const p of touchedPaths) {
    const normP = normalizePath(p);

    // 1. Explicit forbidden check takes precedence
    let isForbidden = false;
    for (const fPat of normForbidden) {
      if (matchPathPattern(fPat, normP)) {
        offending.add(normP);
        isForbidden = true;
        break;
      }
    }
    if (isForbidden) continue;

    // 2. Must be in allowedFiles
    let isAllowed = false;
    for (const aPat of normAllowed) {
      if (matchPathPattern(aPat, normP)) {
        isAllowed = true;
        break;
      }
    }

    if (!isAllowed) {
      offending.add(normP);
    }
  }

  const offendingPaths = Array.from(offending).sort();
  if (offendingPaths.length > 0) {
    return {
      decision: DECISIONS.REFUSED_TOUCHED_PATH,
      offendingPaths,
      allowed: false,
      reason: `Touched paths outside allowedFiles or in forbiddenPaths: ${offendingPaths.join(', ')}`,
    };
  }

  return {
    decision: DECISIONS.OK,
    offendingPaths: [],
    allowed: true,
  };
}

/**
 * Audits diff budget (changed file count and changed byte volume).
 *
 * @param {string[]} touchedPaths
 * @param {number} totalBytesChanged
 * @param {{ maxFiles?: number, maxBytes?: number }} [diffBudget]
 * @returns {{
 *   decision: 'OK' | 'REFUSED_DIFF_BUDGET',
 *   offendingPaths: string[],
 *   budgetExceeded?: 'maxFiles' | 'maxBytes',
 *   measured: { files: number, bytes: number, maxFiles?: number, maxBytes?: number },
 *   reason?: string
 * }}
 */
export function auditDiffBudget(touchedPaths, totalBytesChanged, diffBudget = {}) {
  const maxFiles = diffBudget?.maxFiles;
  const maxBytes = diffBudget?.maxBytes;
  const filesCount = touchedPaths.length;

  if (typeof maxFiles === 'number' && filesCount > maxFiles) {
    return {
      decision: DECISIONS.REFUSED_DIFF_BUDGET,
      offendingPaths: [...touchedPaths].sort(),
      budgetExceeded: 'maxFiles',
      measured: { files: filesCount, bytes: totalBytesChanged, maxFiles, maxBytes },
      reason: `Touched file count (${filesCount}) exceeds maxFiles budget (${maxFiles})`,
    };
  }

  if (typeof maxBytes === 'number' && totalBytesChanged > maxBytes) {
    return {
      decision: DECISIONS.REFUSED_DIFF_BUDGET,
      offendingPaths: [...touchedPaths].sort(),
      budgetExceeded: 'maxBytes',
      measured: { files: filesCount, bytes: totalBytesChanged, maxFiles, maxBytes },
      reason: `Changed bytes volume (${totalBytesChanged}) exceeds maxBytes budget (${maxBytes})`,
    };
  }

  return {
    decision: DECISIONS.OK,
    offendingPaths: [],
    measured: { files: filesCount, bytes: totalBytesChanged, maxFiles, maxBytes },
  };
}

/**
 * Audits scope expansion: |T \ R| <= maxScopeExpansion
 * where T is touchedPaths and R is requestedTargets.
 *
 * @param {string[]} touchedPaths
 * @param {string[]} requestedTargets
 * @param {number} [maxScopeExpansion=0]
 * @returns {{
 *   decision: 'OK' | 'REFUSED_SCOPE_EXPANSION',
 *   offendingPaths: string[],
 *   expandedPaths: string[],
 *   measured: { expandedFiles: number, maxScopeExpansion: number },
 *   reason?: string
 * }}
 */
export function auditScopeExpansion(touchedPaths, requestedTargets = [], maxScopeExpansion = 0) {
  const normTargets = (requestedTargets || []).map(normalizePath).filter(Boolean);
  const limit = typeof maxScopeExpansion === 'number' ? maxScopeExpansion : 0;

  const expanded = [];

  for (const p of touchedPaths) {
    const normP = normalizePath(p);
    let matchedTarget = false;
    for (const tPat of normTargets) {
      if (matchPathPattern(tPat, normP)) {
        matchedTarget = true;
        break;
      }
    }
    if (!matchedTarget) {
      expanded.push(normP);
    }
  }

  expanded.sort();
  const expandedCount = expanded.length;

  if (expandedCount > limit) {
    return {
      decision: DECISIONS.REFUSED_SCOPE_EXPANSION,
      offendingPaths: expanded,
      expandedPaths: expanded,
      measured: { expandedFiles: expandedCount, maxScopeExpansion: limit },
      reason: `Scope expansion |T \\ R| = ${expandedCount} exceeds maxScopeExpansion (${limit}): ${expanded.join(', ')}`,
    };
  }

  return {
    decision: DECISIONS.OK,
    offendingPaths: [],
    expandedPaths: expanded,
    measured: { expandedFiles: expandedCount, maxScopeExpansion: limit },
  };
}

/**
 * Audits the tool surface declared in a FixResult or specified in a FixRequest against
 * forbidden and permitted tools.
 *
 * Accepts:
 * - null / undefined: documented no-op (decision OK)
 * - string[]: list of tool names (FixResult array form or FixRequest array form)
 * - { usedTools: string[] }: FixResult v2 object form
 * - { allowedTools?: string[], forbiddenToolPatterns?: string[] }: FixRequest v2 object form
 *
 * Refuses genuinely malformed declarations (bare strings, numbers, objects without recognized
 * keys, or lists with non-string elements) with REFUSED_TOOL_SURFACE and a descriptive reason.
 *
 * @param {string[] | { usedTools?: string[] } | { allowedTools?: string[], forbiddenToolPatterns?: string[] } | null} [toolSurface]
 * @param {string[]} [forbiddenTools]
 * @param {string[]} [permittedTools]
 * @returns {{
 *   decision: 'OK' | 'REFUSED_TOOL_SURFACE',
 *   offendingTools: string[],
 *   reason?: string
 * }}
 */
export function auditToolSurface(
  toolSurface = null,
  forbiddenTools = DEFAULT_FORBIDDEN_TOOLS,
  permittedTools = DEFAULT_PERMITTED_TOOLS
) {
  // 1. Absent (null / undefined) is the documented no-op
  if (toolSurface == null) {
    return { decision: DECISIONS.OK, offendingTools: [] };
  }

  // 2. Bare primitive (string, number, boolean, etc.) is malformed
  if (typeof toolSurface !== 'object') {
    return {
      decision: DECISIONS.REFUSED_TOOL_SURFACE,
      offendingTools: [],
      reason: `Malformed tool surface declaration: expected an array of tool names or object, got ${typeof toolSurface}`,
    };
  }

  let toolsToCheck = null;
  let effectiveForbidden = forbiddenTools;
  let effectivePermitted = permittedTools;

  // 3. Array form (result array or request array of tool names)
  if (Array.isArray(toolSurface)) {
    if (toolSurface.some((tool) => typeof tool !== 'string')) {
      return {
        decision: DECISIONS.REFUSED_TOOL_SURFACE,
        offendingTools: [],
        reason: 'Malformed tool surface declaration: list contains non-string elements',
      };
    }
    toolsToCheck = toolSurface;
  } else {
    // 4. Object form: recognize usedTools (result form) or allowedTools/forbiddenToolPatterns (request form)
    const hasUsedTools = 'usedTools' in toolSurface;
    const hasAllowedTools = 'allowedTools' in toolSurface;
    const hasForbiddenPatterns = 'forbiddenToolPatterns' in toolSurface;

    if (!hasUsedTools && !hasAllowedTools && !hasForbiddenPatterns) {
      return {
        decision: DECISIONS.REFUSED_TOOL_SURFACE,
        offendingTools: [],
        reason: `Malformed tool surface declaration: object must contain at least one recognized key (allowedTools, forbiddenToolPatterns, usedTools), got [${Object.keys(toolSurface).join(', ')}]`,
      };
    }

    if (hasUsedTools) {
      if (!Array.isArray(toolSurface.usedTools) || toolSurface.usedTools.some((t) => typeof t !== 'string')) {
        return {
          decision: DECISIONS.REFUSED_TOOL_SURFACE,
          offendingTools: [],
          reason: 'Malformed tool surface declaration: usedTools must be an array of strings',
        };
      }
      toolsToCheck = toolSurface.usedTools;
    }

    if (hasAllowedTools || hasForbiddenPatterns) {
      if (hasAllowedTools) {
        if (!Array.isArray(toolSurface.allowedTools) || toolSurface.allowedTools.some((t) => typeof t !== 'string')) {
          return {
            decision: DECISIONS.REFUSED_TOOL_SURFACE,
            offendingTools: [],
            reason: 'Malformed tool surface declaration: allowedTools must be an array of strings',
          };
        }
      }
      if (hasForbiddenPatterns) {
        if (!Array.isArray(toolSurface.forbiddenToolPatterns) || toolSurface.forbiddenToolPatterns.some((t) => typeof t !== 'string')) {
          return {
            decision: DECISIONS.REFUSED_TOOL_SURFACE,
            offendingTools: [],
            reason: 'Malformed tool surface declaration: forbiddenToolPatterns must be an array of strings',
          };
        }
        effectiveForbidden = [...forbiddenTools, ...toolSurface.forbiddenToolPatterns];
      }

      if (!hasUsedTools) {
        // Request object form: audit allowedTools against DEFAULT_PERMITTED_TOOLS and treat forbiddenToolPatterns as declared forbiddens
        toolsToCheck = toolSurface.allowedTools || [];
        effectivePermitted = permittedTools || DEFAULT_PERMITTED_TOOLS;
      }
    }
  }

  if (toolsToCheck.length === 0) {
    return { decision: DECISIONS.OK, offendingTools: [] };
  }

  const offending = new Set();
  const normForbidden = effectiveForbidden.map(normalizePath);
  const normPermitted = effectivePermitted.map(normalizePath);

  for (const t of toolsToCheck) {
    const normT = normalizePath(t);

    // Check against forbidden tools pattern
    let isForbidden = false;
    for (const fPat of normForbidden) {
      if (matchPathPattern(fPat, normT)) {
        offending.add(t);
        isForbidden = true;
        break;
      }
    }
    if (isForbidden) continue;

    // Check if tool is outside permitted tools
    let isPermitted = false;
    for (const pPat of normPermitted) {
      if (matchPathPattern(pPat, normT)) {
        isPermitted = true;
        break;
      }
    }
    if (!isPermitted) {
      offending.add(t);
    }
  }

  const offendingTools = Array.from(offending).sort();
  if (offendingTools.length > 0) {
    return {
      decision: DECISIONS.REFUSED_TOOL_SURFACE,
      offendingTools,
      reason: `Tool surface contains unpermitted or forbidden tools: ${offendingTools.join(', ')}`,
    };
  }

  return { decision: DECISIONS.OK, offendingTools: [] };
}

/**
 * Audits self-verification claims by the fixer.
 * The fixer is forbidden from asserting verification verdicts, so only an explicit
 * `false` (or an absent field) clears the gate: a truthy spelling such as "true",
 * "yes", or 1 is a claim, and a value this audit cannot read as "the fixer made no
 * claim" must not be read as one.
 *
 * @param {unknown} [selfVerificationClaimed]
 * @returns {{
 *   decision: 'OK' | 'REFUSED_SELF_VERIFICATION',
 *   reason?: string
 * }}
 */
export function auditSelfVerification(selfVerificationClaimed) {
  if (selfVerificationClaimed === false || selfVerificationClaimed === undefined || selfVerificationClaimed === null) {
    return { decision: DECISIONS.OK };
  }
  return {
    decision: DECISIONS.REFUSED_SELF_VERIFICATION,
    reason: `Fixer declared selfVerificationClaimed=${JSON.stringify(selfVerificationClaimed)}. Only AntiFan evidence engine may adjudicate verdicts.`,
  };
}

/**
 * Audits drift between stage-time base manifest and merge-time current base manifest.
 *
 * @param {any} stageBaseManifest
 * @param {any} currentBaseManifest
 * @returns {{
 *   decision: 'OK' | 'REFUSED_DRIFT',
 *   offendingPaths: string[],
 *   reason?: string
 * }}
 */
export function auditDrift(stageBaseManifest, currentBaseManifest) {
  const stageMap = normalizeManifestMap(stageBaseManifest);
  const currentMap = normalizeManifestMap(currentBaseManifest);

  const drifting = new Set();
  const allPaths = new Set([...Object.keys(stageMap), ...Object.keys(currentMap)]);

  for (const p of allPaths) {
    const s = stageMap[p];
    const c = currentMap[p];
    if (!s || !c || s.sha256 !== c.sha256) {
      drifting.add(p);
    }
  }

  const offendingPaths = Array.from(drifting).sort();
  if (offendingPaths.length > 0) {
    return {
      decision: DECISIONS.REFUSED_DRIFT,
      offendingPaths,
      reason: `Base workspace drifted between stage and merge times: ${offendingPaths.join(', ')}`,
    };
  }

  return { decision: DECISIONS.OK, offendingPaths: [] };
}

/**
 * Runs all audits over (baseManifest, postManifest, request, currentBaseManifest, fixerResult).
 * Returns FixResult v2 compatible structure.
 *
 * @param {{
 *   baseManifest: any,
 *   postManifest: any,
 *   request: {
 *     allowedFiles?: string[],
 *     forbiddenPaths?: string[],
 *     diffBudget?: { maxFiles?: number, maxBytes?: number },
 *     maxScopeExpansion?: number,
 *     requestedTargets?: string[],
 *     toolSurface?: string[]
 *   },
 *   currentBaseManifest?: any,
 *   fixerResult?: {
 *     toolSurface?: string[],
 *     selfVerificationClaimed?: boolean,
 *     notes?: string
 *   }
 * }} params
 * @returns {{
 *   decision: string,
 *   ok: boolean,
 *   touchedPaths: string[],
 *   budgets: { files: number, bytes: number, maxFiles?: number, maxBytes?: number },
 *   expandedPaths: string[],
 *   missingPaths: string[],
 *   toolSurface: string[],
 *   selfVerificationClaimed: boolean,
 *   offendingPaths: string[],
 *   notes: string,
 *   details: Record<string, any>
 * }}
 */
export function runAllAudits({
  baseManifest,
  postManifest,
  request = {},
  currentBaseManifest = null,
  fixerResult = {},
  changedBytesFor = null,
}) {
  const diff = computeManifestDiff(baseManifest, postManifest, changedBytesFor);
  const { touchedPaths, totalBytesChanged, deletedPaths } = diff;

  const allowedFiles = request.allowedFiles || [];
  // The default forbidden set is policy, not a request parameter: a request may add
  // paths to it, never remove one. Substituting a declared list (or an empty one) for
  // the defaults silently un-forbids the sources and the manifest.
  const forbiddenPaths = [...new Set([...DEFAULT_FORBIDDEN_PATHS, ...(request.forbiddenPaths || [])])];
  const diffBudget = request.diffBudget || {};
  const maxScopeExpansion = request.maxScopeExpansion ?? 0;
  const requestedTargets = request.requestedTargets || [];

  // The fixer's result declares which tools it used (an array, or { usedTools }); the request's
  // toolSurface is this round's policy (allowedTools/forbiddenToolPatterns). Conflating them fed a
  // policy object into a used-tools audit, where a non-array read as "nothing to audit".
  const declaredToolSurface = fixerResult.toolSurface ?? null;
  const toolPolicy = request.toolSurface && typeof request.toolSurface === 'object' && !Array.isArray(request.toolSurface)
    ? request.toolSurface
    : null;
  // The raw value is adjudicated (a string "true" is a claim, not a boolean to coerce
  // away) and recorded as declared, so the receipt and the gate cannot disagree.
  const selfVerifyReported = fixerResult.selfVerificationClaimed ?? false;

  // 1. Audit Drift if current base manifest provided
  let driftAudit = { decision: DECISIONS.OK, offendingPaths: [] };
  if (currentBaseManifest) {
    driftAudit = auditDrift(baseManifest, currentBaseManifest);
  }

  // 2. Audit Touched Paths
  const touchedAudit = auditTouchedPaths(touchedPaths, allowedFiles, forbiddenPaths);

  // 3. Audit Diff Budget
  const budgetAudit = auditDiffBudget(touchedPaths, totalBytesChanged, diffBudget);

  // 4. Audit Scope Expansion
  const expansionAudit = auditScopeExpansion(touchedPaths, requestedTargets, maxScopeExpansion);

  // 5. Audit Tool Surface
  // Audit request tool surface policy first if provided (refuse malformed or forbidden policy)
  let toolAudit = request.toolSurface != null
    ? auditToolSurface(request.toolSurface)
    : { decision: DECISIONS.OK, offendingTools: [] };

  if (toolAudit.decision === DECISIONS.OK) {
    // Same rule for tools: a round may forbid more than the defaults, never less.
    // Replacing the default list let a round declare one narrow pattern and thereby
    // re-permit evaluate/execute-style tools the plane forbids outright.
    const effectiveForbidden = [
      ...new Set([
        ...DEFAULT_FORBIDDEN_TOOLS,
        ...(Array.isArray(toolPolicy?.forbiddenToolPatterns) ? toolPolicy.forbiddenToolPatterns : []),
      ]),
    ];
    const effectivePermitted = Array.isArray(toolPolicy?.allowedTools)
      ? toolPolicy.allowedTools
      : (Array.isArray(request.toolSurface) ? request.toolSurface : DEFAULT_PERMITTED_TOOLS);

    toolAudit = auditToolSurface(
      declaredToolSurface,
      effectiveForbidden,
      effectivePermitted
    );
  }

  // 6. Audit Self Verification
  const verifyAudit = auditSelfVerification(selfVerifyReported);

  const details = {
    drift: driftAudit,
    touched: touchedAudit,
    budget: budgetAudit,
    expansion: expansionAudit,
    toolSurface: toolAudit,
    selfVerification: verifyAudit,
    diff,
  };

  // Evaluation in strict priority order
  let finalDecision = DECISIONS.OK;
  let offendingPaths = [];
  let notes = 'All audits passed.';

  if (driftAudit.decision !== DECISIONS.OK) {
    finalDecision = DECISIONS.REFUSED_DRIFT;
    offendingPaths = driftAudit.offendingPaths;
    notes = driftAudit.reason || 'Base manifest drifted';
  } else if (touchedAudit.decision !== DECISIONS.OK) {
    finalDecision = DECISIONS.REFUSED_TOUCHED_PATH;
    offendingPaths = touchedAudit.offendingPaths;
    notes = touchedAudit.reason || 'Unauthorized touched paths';
  } else if (budgetAudit.decision !== DECISIONS.OK) {
    finalDecision = DECISIONS.REFUSED_DIFF_BUDGET;
    offendingPaths = budgetAudit.offendingPaths;
    notes = budgetAudit.reason || 'Diff budget exceeded';
  } else if (expansionAudit.decision !== DECISIONS.OK) {
    finalDecision = DECISIONS.REFUSED_SCOPE_EXPANSION;
    offendingPaths = expansionAudit.offendingPaths;
    notes = expansionAudit.reason || 'Scope expansion exceeded';
  } else if (toolAudit.decision !== DECISIONS.OK) {
    finalDecision = DECISIONS.REFUSED_TOOL_SURFACE;
    offendingPaths = toolAudit.offendingTools;
    notes = toolAudit.reason || 'Forbidden tool surface';
  } else if (verifyAudit.decision !== DECISIONS.OK) {
    finalDecision = DECISIONS.REFUSED_SELF_VERIFICATION;
    offendingPaths = [];
    notes = verifyAudit.reason || 'Self-verification claimed';
  }

  return {
    decision: finalDecision,
    ok: finalDecision === DECISIONS.OK,
    touchedPaths,
    budgets: {
      files: touchedPaths.length,
      bytes: totalBytesChanged,
      maxFiles: diffBudget.maxFiles,
      maxBytes: diffBudget.maxBytes,
    },
    expandedPaths: expansionAudit.expandedPaths || [],
    missingPaths: deletedPaths,
    toolSurface: declaredToolSurface ?? [],
    selfVerificationClaimed: selfVerifyReported,
    offendingPaths,
    notes,
    details,
  };
}
