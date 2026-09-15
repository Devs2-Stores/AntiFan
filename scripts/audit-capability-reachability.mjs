#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — Capability Reachability Audit
 *
 * WHY THIS EXISTS
 * ---------------
 * Every capability is registered in the real `CapabilityCatalogue`, but being
 * REGISTERED is not the same as being REACHABLE. `CapabilityCatalogue.isVisible`
 * (src/main/tools/capability-catalogue.ts:523) decides what any given session can
 * see, and its truth table is not a lattice:
 *
 *     if (filter && !isCapabilityNamePermitted(...)) return false;    // name gate
 *     if (definition.risk === 'read') return true;                    // always
 *     if (this.runtime.mode !== 'standalone') return false;           // mode cliff
 *     if (grant === 'write')   return definition.risk === 'write';
 *     if (grant === 'execute') return definition.risk === 'execute';
 *     if (grant === 'eval')    return this.options.allowEval === true
 *                                    && (risk === 'eval' || risk === 'write');
 *     return false;
 *
 * Three defects follow from that shape, and all three are SILENT: the capability
 * simply does not appear in `tools/list`, and dispatching it by name comes back
 * `POLICY_DENIED` with a message that blames the grant rather than the ladder.
 *
 *   1. TIER NON-MONOTONICITY — asking for a HIGHER grant can LOSE a lower tier.
 *      `grant='execute'` matches only `risk==='execute'`, so an execute session
 *      cannot see a single `risk:'write'` capability; `grant='eval'` matches only
 *      `eval|write`, so an eval session cannot see anything `risk:'execute'`.
 *      Measured here: 0 capabilities are registered as `risk:'execute'`, so
 *      `grant='execute'` is EXACTLY as capable as `grant='read'` — 99 read-risk
 *      capabilities and nothing else — while `grant='write'` reaches 232.
 *   2. `allowEval` BINARY CLIFF — the `grant='eval'` branch is ANDed with the
 *      runtime-wide `allowEval`, which src/main/index.ts:128-131 derives from
 *      `--allow-eval` / `--mcp-high-risk` / `ANTIFAN_ALLOW_EVAL=true` (explicit
 *      opt-in; false on a plain packaged launch). On such a host an eval-granted
 *      session sees ONLY `risk:'read'`: strictly less than a plain write session,
 *      and the 5 `risk:'eval'` capabilities become unreachable under every grant.
 *   3. `runtime.mode` CLIFF — the `mode !== 'standalone'` line sits above every
 *      grant check, so after `rollbackLegacy()` (control-plane-runtime.ts:301) no
 *      grant level reaches any non-read capability at all.
 *
 * A fourth, INDEPENDENT gate can make a capability unreachable for reasons that
 * have nothing to do with risk tiers: `isCapabilityNamePermitted(name,
 * sessionFilter)` from `allowedCapabilityNames` / `forbiddenCapabilityNames`
 * (capability-catalogue.ts:89), which the DSH profile injects as
 * `--forbidden-capabilities=terminal.*`. This audit re-uses the REAL matcher
 * against the REAL enumerated names, so a glob cannot quietly widen.
 *
 * WHAT IT DOES
 * ------------
 * It builds the REAL catalogue from the compiled emit exactly the way
 * scripts/check-mcp-budget-dominance.mjs does (same registration entry points, same
 * stub ports), enumerates `catalogue.listAll()`, and then asks the REAL
 * `catalogue.isVisible()` for every capability under every grant level and every
 * harness configuration. Names, risks and visibility all come from the running
 * registry — there is no hardcoded capability list, and no source parsing. If a
 * registration site ever stops being called the module-attribution check fails,
 * instead of the audit silently certifying a smaller universe.
 *
 * It exits 1 when it finds:
 *   * a capability reachable under NO grant level in the reference configuration
 *     (standalone + allowEval) — a capability that is always POLICY_DENIED;
 *   * a tier-monotonicity violation in the reference configuration;
 *   * a session-filter glob that denies a name outside its literal prefix;
 *   * a registration module that contributed zero capabilities;
 *   * a risk value outside the CapabilityRisk enum.
 * The `allowEval=false` and `runtime.mode='legacy'` cliffs, and the eval-grant
 * monotonicity violation they cause, are reported always and fail only under
 * `--strict-eval` (the allowEval opt-in is deliberate policy, so its consequence is
 * a documented cliff rather than a code regression).
 * It exits 2 when it cannot audit at all (missing or stale compiled emit), so a
 * stale run is never mistaken for a clean one.
 *
 * Usage:
 *   node scripts/audit-capability-reachability.mjs
 *   node scripts/audit-capability-reachability.mjs --dump         # full risk table
 *   node scripts/audit-capability-reachability.mjs --json         # machine-readable
 *   node scripts/audit-capability-reachability.mjs --quiet        # findings only
 *   node scripts/audit-capability-reachability.mjs --strict-eval  # fail on eval-off cliffs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPILED = path.join(ROOT, '.compiled', 'src');

const argv = process.argv.slice(2);
const FLAG = (name) => argv.includes(`--${name}`);
const DUMP = FLAG('dump');
const JSON_OUT = FLAG('json');
const QUIET = FLAG('quiet');
const STRICT_EVAL = FLAG('strict-eval');

/**
 * Grant levels ordered by the rank the bridge itself enforces on a requested grant
 * (src/main/bridge/bridge-server.ts:898 `grantRanks`). `none` is the absence of a
 * grant, which the catalogue treats as strictly lower than `read`.
 */
const GRANT_RANKS = { read: 1, write: 2, execute: 3, eval: 4 };
const GRANTS = ['read', 'write', 'execute', 'eval'];
const ORDERED_TIERS = ['none', ...GRANTS];
const RISK_ENUM = ['read', 'write', 'execute', 'eval'];

const problems = [];
const warnings = [];
const fatalProblems = [];
const notes = [];

const fail = (message) => problems.push(message);
const warn = (message) => warnings.push(message);
const fatal = (message) => fatalProblems.push(message);

// ─── 0. Registration entry points (the same list the budget-dominance check uses) ─
/**
 * Every module that can call `catalogue.register`. Declared first because both the
 * freshness gate and the module-attribution check are derived from this one table.
 * Each module is asserted to contribute at least one capability, so a registration
 * site that silently stops running surfaces as a failure rather than as a smaller
 * universe this audit would otherwise certify.
 */
const REGISTRATION_TARGETS = [
  ['main/tools/browser-capabilities.js', 'registerBrowserCapabilities'],
  ['main/tools/file-capabilities.js', 'registerFileCapabilities'],
  ['main/tools/artifact-capabilities.js', 'registerArtifactCapabilities'],
  ['main/tools/terminal-capabilities.js', 'registerTerminalCapabilities'],
  ['main/tools/theme-transaction-capabilities.js', 'registerThemeTransactionCapabilities'],
  ['main/tools/device-capabilities.js', 'registerDeviceCapabilities'],
  ['main/workflow/workflow-capabilities.js', 'registerWorkflowCapabilities'],
  ['main/tools/core-capabilities.js', 'registerCoreCapabilities'],
];

// ─── 1. Freshness: the audit reads compiled truth, so stale emit invalidates it ──
/**
 * A source newer than its emit means `.compiled` no longer describes the working
 * tree, and enumerating it would report yesterday's capability set as today's.
 *
 * Staleness is graded by whether it can actually change what this audit asserts:
 *
 *   HARD — the visibility predicate, the risk enum, and the eight modules that own
 *          every `catalogue.register` call. If any of these is newer than its emit,
 *          the enumerated (name, risk) set or its visibility is simply unknown, and
 *          the run is refused (exit 2) rather than reported.
 *   SOFT — everything else under the scanned directories. These files can change how
 *          a capability BEHAVES, but not which capabilities exist or what risk they
 *          declare, because every registration lives in the eight modules above.
 *          They are reported as a warning so the audit stays usable while other work
 *          is in flight in the same tree.
 */
const SOURCE_SCAN_DIRS = ['src/main/tools', 'src/main/workflow', 'src/main/control-plane', 'src/shared'];

/** Files whose emit must be at least as new as the source for the run to be valid. */
function hardSourceList() {
  return new Set([
    'src/main/tools/capability-catalogue.ts',
    'src/shared/control-plane-contracts.ts',
    // The registration entry points, derived from the one table above so the two
    // lists cannot drift.
    ...REGISTRATION_TARGETS.map(([rel]) => `src/${rel.replace(/\.js$/, '.ts')}`),
  ]);
}

function collectTsSources(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsSources(full, out);
      continue;
    }
    if (entry.name.endsWith('.d.ts')) continue;
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
}

const hardSources = hardSourceList();
const sources = [];
for (const rel of SOURCE_SCAN_DIRS) collectTsSources(path.join(ROOT, rel), sources);

const staleHard = [];
const staleSoft = [];
for (const source of sources) {
  const relFromRoot = path.relative(ROOT, source).replace(/\\/g, '/');
  const relFromSrc = path.relative(path.join(ROOT, 'src'), source).replace(/\\/g, '/');
  const emit = path.join(COMPILED, relFromSrc.replace(/\.tsx?$/, '.js'));
  let sourceMtime;
  try {
    sourceMtime = fs.statSync(source).mtimeMs;
  } catch {
    continue;
  }
  let emitMtime;
  try {
    emitMtime = fs.statSync(emit).mtimeMs;
  } catch {
    if (hardSources.has(relFromRoot)) fatal(`compiled emit missing for ${relFromRoot} — compile before auditing`);
    continue;
  }
  if (sourceMtime > emitMtime + 1) (hardSources.has(relFromRoot) ? staleHard : staleSoft).push(relFromRoot);
}
if (staleHard.length > 0) {
  fatal(
    `${staleHard.length} reachability-critical source file(s) are newer than their emit, so the registered set or its ` +
      `visibility is unknown: ${staleHard.join(', ')} — compile before auditing`,
  );
}
if (staleSoft.length > 0) {
  warn(
    `${staleSoft.length} source file(s) are newer than their emit but cannot change the registered set or its risks ` +
      `(no registration lives there): ${staleSoft.slice(0, 6).join(', ')}` +
      (staleSoft.length > 6 ? `, +${staleSoft.length - 6} more` : ''),
  );
}

// ─── 1b. Source↔emit registration-site reconciliation ──────────────────────────
/**
 * mtime is a heuristic; this is the structural check. Each registration module is
 * parsed for `catalogue.register` CALL SITES and the count is compared between the
 * TypeScript source and the compiled emit the audit actually enumerates. A transpile
 * never adds or removes a call, so a mismatch means the emit does not describe the
 * source's registration surface and the enumerated universe is not the source's.
 *
 * The parse is deliberately shallow and anchored on the callee, not on formatting:
 * `catalogue` `.` `register`, then either `<` (generic arguments) or `(`. That is the
 * only spelling used anywhere in the tree, and it is asserted below, not assumed: if
 * a registration site were ever written through a different receiver, the per-module
 * "contributed 0 capabilities" check fires instead.
 */
const REGISTER_CALL_SITE = /catalogue\s*\.\s*register\s*[<(]/g;
const registrationSiteCounts = {};
for (const [rel] of REGISTRATION_TARGETS) {
  const sourcePath = path.join(ROOT, 'src', rel.replace(/\.js$/, '.ts'));
  const emitPath = path.join(COMPILED, rel);
  const countSites = (file) => {
    try {
      return (fs.readFileSync(file, 'utf8').match(REGISTER_CALL_SITE) || []).length;
    } catch {
      return -1;
    }
  };
  const sourceSites = countSites(sourcePath);
  const emitSites = countSites(emitPath);
  registrationSiteCounts[rel] = { sourceSites, emitSites };
  if (sourceSites < 0 || emitSites < 0) {
    fatal(`could not read a registration module for the site reconciliation: ${sourceSites < 0 ? rel.replace(/\.js$/, '.ts') : rel}`);
    continue;
  }
  if (sourceSites !== emitSites) {
    fatal(
      `${rel} has ${sourceSites} \`catalogue.register\` call site(s) in source but ${emitSites} in the compiled emit — ` +
        'the emit does not describe the source registration surface; compile before auditing',
    );
  }
  if (sourceSites === 0) {
    fail(`${rel} contains no \`catalogue.register\` call site; the audit's site reconciliation is blind to it`);
  }
}
const totalSites = Object.values(registrationSiteCounts).reduce((sum, entry) => sum + entry.sourceSites, 0);

// ─── 2. Build the real catalogue ────────────────────────────────────────────────
function required(rel) {
  const abs = path.join(COMPILED, rel);
  if (!fs.existsSync(abs)) {
    fatal(`compiled module missing: .compiled/src/${rel} (the real registry cannot be enumerated)`);
    return undefined;
  }
  try {
    return require(abs);
  } catch (err) {
    fatal(`cannot require .compiled/src/${rel}: ${err.message}`);
    return undefined;
  }
}

/**
 * Build the real catalogue the way the host does, but with stub collaborators.
 * Registration validates policy shape and never dereferences a collaborator while
 * registering — the same invariant scripts/check-mcp-budget-dominance.mjs depends on.
 * The module-attribution map doubles as the guard against a registration site that
 * quietly stops contributing.
 */
function buildCatalogue({ mode, allowEval }) {
  const { CapabilityCatalogue } = required('main/tools/capability-catalogue.js') || {};
  const { BrowserControlPort } = required('main/tools/browser-control-port.js') || {};
  const { makeControlPlaneId } = required('shared/control-plane-contracts.js') || {};
  if (!CapabilityCatalogue || !BrowserControlPort || !makeControlPlaneId) return undefined;

  const catalogue = new CapabilityCatalogue({
    runtime: { mode, lifecycle: 'active' },
    projectId: makeControlPlaneId('project'),
    workspaceId: makeControlPlaneId('workspace'),
    runtimeId: `runtime-reachability-${mode}-${allowEval ? 'eval-on' : 'eval-off'}`,
    hostEpoch: 1,
    allowEval,
    isTabAllowed: () => true,
    resolveTabId: (id) => id,
    getDocumentGeneration: () => 1,
  });

  const host = { getTabList: () => [], getManagedTabIds: () => new Set() };
  const browserPort = new BrowserControlPort(host);
  const getWorkspaceRoot = () => ROOT;

  const collaboratorArguments = {
    registerBrowserCapabilities: [browserPort, undefined, getWorkspaceRoot],
    registerFileCapabilities: [{}, getWorkspaceRoot, undefined],
    registerArtifactCapabilities: [{}],
    registerTerminalCapabilities: [{}],
    registerThemeTransactionCapabilities: [{}, getWorkspaceRoot],
    registerDeviceCapabilities: [{}],
    registerWorkflowCapabilities: [{}],
    registerCoreCapabilities: [{}],
  };

  const contributedBy = new Map();
  for (const [rel, fnName] of REGISTRATION_TARGETS) {
    const mod = required(rel);
    if (!mod) continue;
    const register = mod[fnName];
    if (typeof register !== 'function') {
      fail(`${rel} does not export ${fnName}; the audited universe would be incomplete`);
      continue;
    }
    const before = catalogue.listAll().length;
    try {
      register(catalogue, ...collaboratorArguments[fnName]);
    } catch (err) {
      fail(`${fnName} failed to register against stub ports: ${err.message}`);
      continue;
    }
    contributedBy.set(fnName, catalogue.listAll().length - before);
  }
  for (const [, fnName] of REGISTRATION_TARGETS) {
    if ((contributedBy.get(fnName) ?? 0) === 0) {
      fail(`${fnName} registered 0 capabilities; a registration site stopped running or was renamed`);
    }
  }

  /** Ask the catalogue's own predicate; never a re-implementation of it. */
  const visibleUnder = (tier) => {
    const grant = tier === 'none' ? undefined : tier;
    const visible = new Set();
    for (const { name } of catalogue.listAll()) {
      const definition = catalogue.get(name);
      if (definition && catalogue.isVisible(definition, grant, undefined)) visible.add(name);
    }
    return visible;
  };

  return { catalogue, contributedBy, visibleUnder, mode, allowEval };
}

// ─── 3. Session-filter gate (independent of the grant gate) ─────────────────────
/**
 * Patterns actually in force are read from the live DSH profile patches and from this
 * process's own argv/env, so no glob string is hardcoded as truth.
 */
function collectForbiddenPatterns() {
  const patterns = new Set();
  for (const source of [process.env.ANTIFAN_FORBIDDEN_CAPABILITIES, process.env.ANTIFAN_FORBIDDEN_CAPABILITY_NAMES]) {
    if (!source) continue;
    try {
      if (source.trim().startsWith('[')) {
        for (const entry of JSON.parse(source)) patterns.add(String(entry).trim());
        continue;
      }
    } catch {}
    for (const entry of source.split(',')) if (entry.trim()) patterns.add(entry.trim());
  }
  for (const arg of argv) {
    if (arg.startsWith('--forbidden-capabilities=')) {
      for (const entry of arg.slice('--forbidden-capabilities='.length).split(',')) {
        if (entry.trim()) patterns.add(entry.trim());
      }
    }
  }

  const profilesRoot =
    process.env.DSH_PROFILES_ROOT || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles');
  const patchFiles = [];
  let entries = [];
  try {
    entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const patch = path.join(profilesRoot, entry.name, 'cordis.patch.yml');
    if (!fs.existsSync(patch)) continue;
    patchFiles.push(patch);
    let text = '';
    try {
      text = fs.readFileSync(patch, 'utf8');
    } catch {
      continue;
    }
    // Only a well-formed capability-name token is accepted, so prose that merely
    // MENTIONS the flag (comments, docs) cannot inject a bogus pattern such as a
    // stray backtick, which would otherwise be reported as an unassertable glob.
    const re = /--forbidden-capabilities=([A-Za-z0-9_.*?!,\-[\]$^(){}|+\\]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      for (const name of m[1].split(',')) if (name.trim()) patterns.add(name.trim());
    }
  }
  return { patterns: [...patterns].sort(), profilesRoot, patchFiles };
}

/** `PREFIX.*` must deny exactly `PREFIX.`-prefixed names and nothing else. */
function prefixOfGlob(pattern) {
  const trimmed = pattern.trim();
  if (!trimmed.endsWith('.*')) return undefined;
  const prefix = trimmed.slice(0, -2);
  if (prefix === '' || prefix.includes('*') || prefix.includes('?')) return undefined;
  return prefix;
}

// ─── 4. Repo cross-check: what the MCP surface ADVERTISES vs what is registered ──
function readAdvertisedSurface() {
  const proxyPath = path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs');
  const result = { proxyPath, advertised: [], capabilityMap: {}, error: undefined, mapFile: undefined, mapTotalTools: undefined };
  if (!fs.existsSync(proxyPath)) {
    result.error = 'scripts/antifan-omp-mcp.cjs not found';
    return result;
  }
  try {
    const proxy = require(proxyPath);
    result.advertised = (proxy.definitions || []).map((d) => (Array.isArray(d) ? d[0] : d?.name)).filter((n) => typeof n === 'string');
    result.capabilityMap = proxy.CAPABILITY_MAP || {};
  } catch (err) {
    result.error = `cannot require the proxy: ${err.message}`;
  }
  const mapJson = path.join(ROOT, 'reports', 'antifan-mcp-capability-map.json');
  if (fs.existsSync(mapJson)) {
    result.mapFile = path.relative(ROOT, mapJson).replace(/\\/g, '/');
    try {
      const parsed = JSON.parse(fs.readFileSync(mapJson, 'utf8'));
      result.mapTotalTools = parsed.totalTools;
    } catch {}
  }
  return result;
}

// ─── 5. Run the audit ──────────────────────────────────────────────────────────
const findings = {
  deadCapabilities: [],
  deadWithoutAllowEval: [],
  tierMonotonicity: [],
  tierMonotonicityEvalOff: [],
  evalOnly: [],
  sessionFilterOverreach: [],
  riskValuesOutsideEnum: [],
};

let report;

if (fatalProblems.length === 0) {
  const reference = buildCatalogue({ mode: 'standalone', allowEval: true });
  const evalOff = buildCatalogue({ mode: 'standalone', allowEval: false });
  const legacy = buildCatalogue({ mode: 'legacy', allowEval: true });

  if (!reference || !evalOff || !legacy) {
    fatal('catalogue could not be constructed; reachability is undetermined');
  } else {
    const { catalogue, contributedBy } = reference;
    const all = catalogue.listAll().map((entry) => entry.name).sort();

    // 5a. Visibility of every capability under every tier, per harness configuration,
    //     always through the catalogue's own isVisible.
    const visibility = new Map(ORDERED_TIERS.map((tier) => [tier, reference.visibleUnder(tier)]));
    const visibilityEvalOff = new Map(ORDERED_TIERS.map((tier) => [tier, evalOff.visibleUnder(tier)]));
    const visibilityLegacy = new Map(ORDERED_TIERS.map((tier) => [tier, legacy.visibleUnder(tier)]));

    // 5b. Dead capability in the reference configuration: reachable under NO grant
    //     level even with the most permissive host switch. This is the host-independent
    //     defect — always POLICY_DENIED for every possible session.
    for (const name of all) {
      const definition = catalogue.get(name);
      const risk = definition?.risk;
      const reachable = ORDERED_TIERS.some((tier) => visibility.get(tier).has(name));
      if (!reachable) findings.deadCapabilities.push({ name, risk: risk ?? '(unreadable)' });
      if (typeof risk === 'string' && !RISK_ENUM.includes(risk)) {
        findings.riskValuesOutsideEnum.push({ name, risk });
      }
    }

    // 5c. Dead only because allowEval is off. The allowEval opt-in is deliberate
    //     (src/main/index.ts:130), so this is a documented cliff, not a code
    //     regression — it is reported always and fails only under --strict-eval.
    for (const name of all) {
      const reachableInEvalOff = ORDERED_TIERS.some((tier) => visibilityEvalOff.get(tier).has(name));
      if (!reachableInEvalOff) {
        findings.deadWithoutAllowEval.push({ name, risk: catalogue.get(name)?.risk ?? '(unreadable)' });
      }
    }

    // 5d. Tier monotonicity: `none < read < write < execute < eval`. A higher tier
    //     must be a superset of every lower tier; anything else means a client that
    //     negotiated MORE authority lost capability it previously had.
    const monotonicityOf = (table) => {
      const violations = [];
      for (let i = 0; i < ORDERED_TIERS.length; i += 1) {
        for (let j = i + 1; j < ORDERED_TIERS.length; j += 1) {
          const lower = ORDERED_TIERS[i];
          const higher = ORDERED_TIERS[j];
          const lost = [...table.get(lower)].filter((name) => !table.get(higher).has(name)).sort();
          if (lost.length > 0) violations.push({ lower, higher, lost });
        }
      }
      return violations;
    };
    findings.tierMonotonicity = monotonicityOf(visibility);
    findings.tierMonotonicityEvalOff = monotonicityOf(visibilityEvalOff);

    // 5e. Reachable ONLY at grant='eval' in the reference configuration.
    for (const name of all) {
      const atEval = visibility.get('eval').has(name);
      if (atEval && !visibility.get('write').has(name) && !visibility.get('execute').has(name)) {
        findings.evalOnly.push({ name, risk: catalogue.get(name)?.risk ?? '?' });
      }
    }

    // 5f. The runtime.mode cliff: same session, same grant, after rollbackLegacy().
    const lostInLegacy = [];
    for (const name of all) {
      if (!visibilityLegacy.get('eval').has(name)) lostInLegacy.push(name);
    }

    // 5g. Session-filter glob confinement, using the REAL matcher on REAL names.
    const { patterns, profilesRoot, patchFiles } = collectForbiddenPatterns();
    const { isCapabilityNamePermitted } = required('main/tools/capability-catalogue.js') || {};
    const globChecks = [];
    if (typeof isCapabilityNamePermitted !== 'function') {
      fail('isCapabilityNamePermitted is not exported from the compiled catalogue; the glob gate cannot be audited');
    } else {
      for (const pattern of patterns) {
        const denied = all.filter((name) => !isCapabilityNamePermitted(name, { forbiddenCapabilityNames: [pattern] }));
        const prefix = prefixOfGlob(pattern);
        if (prefix === undefined) {
          globChecks.push({ pattern, denied: denied.length, confined: null, note: 'not a simple PREFIX.* glob; confinement not asserted' });
          continue;
        }
        const expected = all.filter((name) => name.startsWith(`${prefix}.`));
        const overreach = denied.filter((name) => !expected.includes(name));
        const underreach = expected.filter((name) => !denied.includes(name));
        const confined = overreach.length === 0 && underreach.length === 0;
        globChecks.push({ pattern, prefix, denied: denied.length, expected: expected.length, confined, overreach, underreach });
        if (!confined) {
          findings.sessionFilterOverreach.push({ pattern, overreach: overreach.slice(0, 20), underreach: underreach.slice(0, 20) });
        }
      }
      if (patterns.length === 0) {
        notes.push('no --forbidden-capabilities= pattern found in argv/env or any DSH profile patch; the glob gate was not exercised');
      } else {
        notes.push(
          `glob patterns in force: ${patterns.map((p) => `'${p}'`).join(', ')} ` +
            `(from ${patchFiles.length} DSH profile patch(es) under ${profilesRoot})`
        );
      }
    }

    // 5h. Repo cross-check against the MCP advertisement and the checked-in map.
    //
    // The advertisement is grant-agnostic on purpose in both implementations
    // (src/main/mcp/mcp-server.ts:829 unions the read and write listings; the stdio
    // proxy at scripts/antifan-omp-mcp.cjs:10 is a static table filtered only by name
    // globs at line 1481). Dispatch, however, is grant-gated by isVisible. So the gap
    // between "advertised" and "dispatchable at the session's grant" IS the size of the
    // silent-unreachability class, and it is measured here per tier.
    const advertised = readAdvertisedSurface();
    const registered = new Set(all);
    const resolveAdvertised = (name) => advertised.capabilityMap[name] || name;
    const advertisedUnregistered = advertised.advertised.filter((name) => {
      const target = resolveAdvertised(name);
      return !registered.has(name) && !registered.has(target);
    });
    const deniedByTier = {};
    for (const tier of ORDERED_TIERS) {
      deniedByTier[tier] = advertised.advertised.filter((name) => {
        const target = resolveAdvertised(name);
        return registered.has(target) && !visibility.get(tier).has(target);
      });
    }
    const crossCheck = {
      proxyAdvertised: advertised.advertised.length,
      proxyCapabilityMapRows: Object.keys(advertised.capabilityMap).length,
      checkedInMapTotalTools: advertised.mapTotalTools,
      checkedInMapFile: advertised.mapFile,
      catalogRegistered: all.length,
      advertisedUnregistered,
      advertisedDeniedByTier: Object.fromEntries(
        ORDERED_TIERS.map((tier) => [tier, { count: deniedByTier[tier].length, examples: deniedByTier[tier].slice(0, 6) }])
      ),
      error: advertised.error,
    };
    if (advertised.error) {
      warn(`MCP surface cross-check skipped: ${advertised.error}`);
    } else {
      notes.push(
        `MCP cross-check: catalogue=${all.length} registered, proxy advertises ${crossCheck.proxyAdvertised}, ` +
          `${crossCheck.proxyCapabilityMapRows} routing row(s), checked-in map reports ${crossCheck.checkedInMapTotalTools ?? 'n/a'}` +
          (crossCheck.checkedInMapFile ? ` (${crossCheck.checkedInMapFile})` : '')
      );
      notes.push(
        `advertised-tool reachability by session grant: ` +
          ORDERED_TIERS.map((tier) => `${tier}=${deniedByTier[tier].length}/${crossCheck.proxyAdvertised} denied`).join(', ')
      );
      if (advertisedUnregistered.length > 0) {
        warn(
          `${advertisedUnregistered.length} advertised tool(s) resolve to no registration: ` +
            advertisedUnregistered.slice(0, 8).join(', ') +
            (advertisedUnregistered.length > 8 ? `, +${advertisedUnregistered.length - 8} more` : '')
        );
      }
      if (deniedByTier.write.count > 0) {
        warn(
          `${deniedByTier.write.count} advertised tool(s) are POLICY_DENIED at the bridge pairing default grant 'write': ` +
            deniedByTier.write.slice(0, 6).join(', ')
        );
      }
      if (deniedByTier.execute.count > deniedByTier.read.count) {
        warn(
          `an 'execute'-granted session is denied ${deniedByTier.execute.count} of ${crossCheck.proxyAdvertised} advertised tools — ` +
            `more than the ${deniedByTier.read.count} denied to a plain 'read' session, which is the tier inversion's blast radius`
        );
      }
    }

    const riskCounts = {};
    for (const name of all) {
      const risk = catalogue.get(name)?.risk ?? '(unreadable)';
      riskCounts[risk] = (riskCounts[risk] ?? 0) + 1;
    }

    // 5i. Findings that fail the build.
    if (findings.deadCapabilities.length > 0) {
      fail(
        `${findings.deadCapabilities.length} capability(ies) are unreachable under EVERY grant level: ` +
          findings.deadCapabilities.map((d) => `${d.name} (risk=${d.risk})`).slice(0, 10).join(', ')
      );
    }
    if (findings.tierMonotonicity.length > 0) {
      for (const violation of findings.tierMonotonicity) {
        fail(
          `tier non-monotonicity: grant='${violation.higher}' loses ${violation.lost.length} capability(ies) that '${violation.lower}' reaches ` +
            `(${violation.lost.slice(0, 5).join(', ')}${violation.lost.length > 5 ? ', …' : ''})`
        );
      }
    }
    if (findings.sessionFilterOverreach.length > 0) {
      for (const overreach of findings.sessionFilterOverreach) {
        fail(`session-filter glob '${overreach.pattern}' denies names outside its prefix: ${overreach.overreach.join(', ') || '(none)'} / misses: ${overreach.underreach.join(', ') || '(none)'}`);
      }
    }
    if (findings.riskValuesOutsideEnum.length > 0) {
      fail(
        `${findings.riskValuesOutsideEnum.length} capability(ies) declare a risk outside CapabilityRisk: ` +
          findings.riskValuesOutsideEnum.map((r) => `${r.name}=${JSON.stringify(r.risk)}`).join(', ')
      );
    }
    if (STRICT_EVAL) {
      if (findings.deadWithoutAllowEval.length > 0) {
        fail(
          `--strict-eval: ${findings.deadWithoutAllowEval.length} capability(ies) are unreachable under every grant when allowEval=false: ` +
            findings.deadWithoutAllowEval.map((d) => d.name).slice(0, 10).join(', ')
        );
      }
      for (const violation of findings.tierMonotonicityEvalOff) {
        fail(`--strict-eval: tier non-monotonicity when allowEval=false: grant='${violation.higher}' loses ${violation.lost.length} capability(ies) that '${violation.lower}' reaches`);
      }
    } else {
      if (findings.tierMonotonicityEvalOff.length > 0) {
        warn(
          `when allowEval=false, grant='eval' is NOT a superset: ` +
            findings.tierMonotonicityEvalOff
              .map((v) => `'${v.higher}' loses ${v.lost.length} of '${v.lower}'`)
              .join('; ') +
            ` — and ${findings.deadWithoutAllowEval.length} capability(ies) become unreachable at every grant (re-run with --strict-eval to fail on this)`
        );
      }
    }

    report = {
      root: ROOT,
      compiled: COMPILED,
      auditedAt: new Date().toISOString(),
      totals: { registered: all.length, riskCounts },
      contributedBy: Object.fromEntries(contributedBy),
      registrationSiteCounts,
      registrationSiteTotal: totalSites,
      visibilityCounts: Object.fromEntries(ORDERED_TIERS.map((tier) => [`standalone/eval-on/${tier}`, visibility.get(tier).size])),
      visibilityCountsEvalOff: Object.fromEntries(ORDERED_TIERS.map((tier) => [`standalone/eval-off/${tier}`, visibilityEvalOff.get(tier).size])),
      visibilityCountsLegacy: Object.fromEntries(ORDERED_TIERS.map((tier) => [`legacy/${tier}`, visibilityLegacy.get(tier).size])),
      lostInLegacy: lostInLegacy.length,
      globChecks,
      crossCheck,
      capabilities: all.map((name) => ({
        name,
        risk: catalogue.get(name)?.risk ?? '(unreadable)',
        visibleAt: ORDERED_TIERS.filter((tier) => visibility.get(tier).has(name)),
      })),
      findings,
    };
  }
}

// ─── 6. Report ─────────────────────────────────────────────────────────────────
const verdict = fatalProblems.length > 0 ? 'UNAUDITABLE' : problems.length > 0 ? 'FAIL' : 'PASS';

if (JSON_OUT) {
  process.stdout.write(
    `${JSON.stringify({ verdict, healthy: verdict === 'PASS', problems, warnings, notes, fatal: fatalProblems, report, findings }, null, 2)}\n`
  );
} else {
  if (report) {
    const { totals } = report;
    process.stdout.write(
      `[capability-reachability] ${totals.registered} capabilities registered (` +
        `${Object.entries(totals.riskCounts).map(([risk, count]) => `${risk}=${count}`).join(', ')})\n`
    );
    process.stdout.write(
      `[capability-reachability] visible by grant, standalone+eval-on: ` +
        ORDERED_TIERS.map((tier) => `${tier}=${report.visibilityCounts[`standalone/eval-on/${tier}`]}`).join(', ') +
        '\n'
    );
    if (!QUIET) {
      process.stdout.write(
        `[capability-reachability] visible by grant, standalone+eval-off: ` +
          ORDERED_TIERS.map((tier) => `${tier}=${report.visibilityCountsEvalOff[`standalone/eval-off/${tier}`]}`).join(', ') +
          ' | legacy+eval-on: ' +
          ORDERED_TIERS.map((tier) => `${tier}=${report.visibilityCountsLegacy[`legacy/${tier}`]}`).join(', ') +
          '\n'
      );
      for (const [fnName, count] of Object.entries(report.contributedBy)) {
        process.stdout.write(`[capability-reachability]   ${fnName}: ${count}\n`);
      }
      process.stdout.write(
        `[capability-reachability]   registration call sites in source (== emit): ${report.registrationSiteTotal} ` +
          `for ${report.totals.registered} registered capabilities ` +
          '(a module that registers through a helper contributes more capabilities than call sites)\n'
      );
    }

    if (DUMP) {
      process.stdout.write('\n| capability | risk | visible at |\n|---|---|---|\n');
      for (const entry of report.capabilities) {
        process.stdout.write(`| ${entry.name} | ${entry.risk} | ${entry.visibleAt.join(', ')} |\n`);
      }
      process.stdout.write('\n');
    }

    const printList = (label, items, render) => {
      if (items.length === 0) return;
      process.stdout.write(`\n[capability-reachability] ${label}\n`);
      for (const item of items) process.stdout.write(`  - ${render(item)}\n`);
    };

    printList('DEAD CAPABILITIES (reachable under no grant level, standalone+eval-on):', findings.deadCapabilities, (d) => `${d.name} (risk=${d.risk})`);
    printList(
      'tier non-monotonicity (standalone+eval-on):',
      findings.tierMonotonicity,
      (v) =>
        `grant='${v.higher}' loses ${v.lost.length} capability(ies) reached by '${v.lower}': ` +
        `${v.lost.slice(0, 10).join(', ')}${v.lost.length > 10 ? `, +${v.lost.length - 10} more` : ''}`
    );
    printList(
      'unreachable at every grant when allowEval=false (the eval-risk family):',
      findings.deadWithoutAllowEval,
      (d) => `${d.name} (risk=${d.risk})`
    );
    printList('reachable ONLY at grant=eval (standalone+eval-on):', findings.evalOnly, (e) => `${e.name} (risk=${e.risk})`);
    printList('risks outside the CapabilityRisk enum:', findings.riskValuesOutsideEnum, (r) => `${r.name} (risk=${JSON.stringify(r.risk)})`);
    printList(
      'session-filter glob overreach:',
      findings.sessionFilterOverreach,
      (g) => `'${g.pattern}' over: ${g.overreach.join(', ') || 'none'} / under: ${g.underreach.join(', ') || 'none'}`
    );

    if (report.globChecks.length > 0) {
      process.stdout.write('\n[capability-reachability] session-filter glob confinement (real matcher, real names):\n');
      for (const check of report.globChecks) {
        const text = check.confined === null ? 'not asserted (not a simple PREFIX.* glob)' : check.confined ? 'CONFINED' : 'OVERREACH';
        process.stdout.write(`  - '${check.pattern}' denies ${check.denied} name(s) of ${report.totals.registered} — ${text}\n`);
      }
    }
    if (report.lostInLegacy > 0) {
      process.stdout.write(
        `\n[capability-reachability] runtime.mode cliff: after rollbackLegacy() ${report.lostInLegacy} of ${report.totals.registered} ` +
          'capability(ies) are unreachable at EVERY grant (every non-read capability)\n'
      );
    }
  }

  if (!QUIET) for (const note of notes) process.stdout.write(`[capability-reachability] note: ${note}\n`);
  for (const message of warnings) process.stdout.write(`[capability-reachability] warn: ${message}\n`);
  for (const message of fatalProblems) process.stderr.write(`[capability-reachability] UNAUDITABLE ${message}\n`);
  for (const problem of problems) process.stderr.write(`[capability-reachability] FAIL ${problem}\n`);
}

if (fatalProblems.length > 0) process.exit(2);
if (problems.length > 0) process.exit(1);
if (!JSON_OUT) process.stdout.write('[capability-reachability] OK: no capability is dead and the grant ladder is monotone in the reference configuration\n');
process.exit(0);
