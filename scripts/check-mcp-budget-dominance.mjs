#!/usr/bin/env node
/**
 * Compile-time dominance + parity gate for the MCP client surface.
 *
 * Budget dominance: the standalone stdio proxy (scripts/antifan-omp-mcp.cjs)
 * owns exactly one budget number: DEFAULT_CLIENT_TIMEOUT_MS. It exists so the
 * SERVER is always the side that bounds a hung capability first, which is what
 * lets the client observe a typed terminal (or EXECUTION_TIMEOUT_PENDING_CLEANUP)
 * receipt instead of abandoning the invocation and replaying unknown work.
 *
 * That guarantee only holds while the ceiling exceeds every capability policy
 * the catalogue can enforce. A per-tool override table used to hold the
 * exceptions by hand and rotted silently (theme.debug_bundle carries a 60 s
 * policy and had no entry, so the 30 s default fired first). This check makes
 * the invariant structural: it builds the real catalogue, reads the largest
 * policy from it, and refuses to compile when the ceiling stops dominating —
 * and it refuses a re-introduced per-tool table or a no-op routing row.
 *
 * Schema parity: CapabilityDefinition.inputSchema is the single source of
 * truth for what a capability accepts. The proxy's advertised definitions are
 * a hand-maintained projection of that source and rot silently — at the time
 * this gate was added, core.record_regression still demanded a replayResult
 * argument the store had started throwing on, and core.replay_regression /
 * core.record_observation were registered but unreachable. The parity section
 * below fails the build when the advertised surface diverges from the
 * catalogue, when a core.* tool has no dispatch entry, when a dispatch entry
 * names a store method that does not exist, or when the catalogue and the
 * proxy bind the same tool to different store methods.
 *
 * --proxy <path> substitutes a fixture proxy module (used by the seeded-drift
 * test to prove the gate actually fires).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPILED = path.join(ROOT, '.compiled', 'src');
const PROXY_PATH = (() => {
  const idx = process.argv.indexOf('--proxy');
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  return path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs');
})();
const SUPER_CORE_DIST = path.join(ROOT, 'packages', 'super-core', 'dist', 'index.js');
const SUPER_CORE_SRC = path.join(ROOT, 'packages', 'super-core', 'src', 'index.ts');

const problems = [];
const notes = [];

// Structural schema comparison: a property spec is its type, enum set, and
// array-item type — the fields that decide whether a call is accepted and how
// it is coerced. Descriptions and defaults are presentation, not contract.
function specKey(spec) {
  if (!spec || typeof spec !== 'object') return JSON.stringify(spec ?? null);
  return JSON.stringify({
    type: spec.type ?? null,
    enum: Array.isArray(spec.enum) ? [...spec.enum].sort() : null,
    items: spec.items && typeof spec.items === 'object' ? (spec.items.type ?? null) : null,
  });
}
// A oneOf contract is the SET of required-groups it accepts, order-insensitive:
// [{required:['a']},{required:['b']}] and [{required:['b']},{required:['a']}]
// are the same promise.
function oneOfKey(oneOf) {
  if (!Array.isArray(oneOf) || oneOf.length === 0) return null;
  return JSON.stringify(
    oneOf
      .map((group) => (group && Array.isArray(group.required) ? [...group.required].sort() : []))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  );
}
function sortedKeys(obj) {
  return Object.keys(obj || {}).sort();
}

function required(rel) {
  const abs = path.join(COMPILED, rel);
  if (!fs.existsSync(abs)) {
    problems.push(`compiled module missing: .compiled/src/${rel} (run tsc before this check)`);
    return undefined;
  }
  try {
    return require(abs);
  } catch (err) {
    problems.push(`cannot require .compiled/src/${rel}: ${err.message}`);
    return undefined;
  }
}

// ─── 1. The proxy side: one ceiling, no per-tool table, no no-op routing ─────
const proxySource = fs.readFileSync(PROXY_PATH, 'utf8');
const proxy = require(PROXY_PATH);
const ceiling = proxy.DEFAULT_CLIENT_TIMEOUT_MS;
if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0) {
  problems.push('proxy does not export a usable DEFAULT_CLIENT_TIMEOUT_MS');
}
if (/const\s+CLIENT_TIMEOUT_MS\s*=/.test(proxySource)) {
  problems.push('proxy re-introduced a per-tool CLIENT_TIMEOUT_MS table; the single ceiling must stay structural');
}
const map = proxy.CAPABILITY_MAP || {};
for (const [advertised, target] of Object.entries(map)) {
  if (advertised === target) {
    problems.push(`CAPABILITY_MAP['${advertised}'] is a no-op row; the advertised name is already authoritative`);
  }
  if (typeof target !== 'string' || target.length === 0) {
    problems.push(`CAPABILITY_MAP['${advertised}'] has no target`);
  }
}
// A routing row exists to reach a name the server registers under a different
// spelling; the safety property is that the target really is a registration.
const routedTargets = new Set(Object.values(map).filter((target) => typeof target === 'string'));

// ─── 2. The server side: build the real catalogue ───────────────────────────
const { CapabilityCatalogue } = required('main/tools/capability-catalogue.js') || {};
const { BrowserControlPort } = required('main/tools/browser-control-port.js') || {};
const { makeControlPlaneId } = required('shared/control-plane-contracts.js') || {};

const registrationTargets = [
  ['main/tools/browser-capabilities.js', 'registerBrowserCapabilities'],
  ['main/tools/file-capabilities.js', 'registerFileCapabilities'],
  ['main/tools/artifact-capabilities.js', 'registerArtifactCapabilities'],
  ['main/tools/terminal-capabilities.js', 'registerTerminalCapabilities'],
  ['main/tools/theme-transaction-capabilities.js', 'registerThemeTransactionCapabilities'],
  ['main/tools/device-capabilities.js', 'registerDeviceCapabilities'],
  ['main/workflow/workflow-capabilities.js', 'registerWorkflowCapabilities'],
  ['main/tools/core-capabilities.js', 'registerCoreCapabilities'],
];

let maxPolicy = 0;
let maxPolicyName = '(none)';
let registered = 0;

if (CapabilityCatalogue && BrowserControlPort && makeControlPlaneId && problems.length === 0) {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId,
    workspaceId,
    runtimeId: 'runtime-budget-dominance',
    hostEpoch: 1,
    isTabAllowed: () => true,
    resolveTabId: (id) => id,
    getDocumentGeneration: () => 1,
  });
  const host = { getTabList: () => [], getManagedTabIds: () => new Set() };
  const browserPort = new BrowserControlPort(host);
  const getWorkspaceRoot = () => ROOT;
  // Stub collaborators: registration validates policy shape, and nothing in a
  // register* call may dereference its collaborator while registering.
  // The core port is a recording stub instead: the parity check below executes
  // each advertised core.* capability against it to prove the catalogue binds
  // the same store method the proxy's CORE_DISPATCH table names.
  const coreCalls = [];
  const recordingCorePort = new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop !== 'string') return undefined;
      return () => { coreCalls.push(prop); return { recorded: prop }; };
    },
  });
  const registrations = {
    registerBrowserCapabilities: [browserPort, undefined, getWorkspaceRoot],
    registerFileCapabilities: [{}, getWorkspaceRoot, undefined],
    registerArtifactCapabilities: [{}],
    registerTerminalCapabilities: [{}],
    registerThemeTransactionCapabilities: [{}, getWorkspaceRoot],
    // The device port is only dereferenced when a device capability executes, never while registering.
    registerDeviceCapabilities: [{}],
    registerWorkflowCapabilities: [{}],
    registerCoreCapabilities: [recordingCorePort],
  };
  for (const [rel, fnName] of registrationTargets) {
    const mod = required(rel);
    if (!mod) continue;
    const register = mod[fnName];
    if (typeof register !== 'function') {
      problems.push(`${rel} does not export ${fnName}`);
      continue;
    }
    try {
      register(catalogue, ...registrations[fnName]);
    } catch (err) {
      problems.push(`${fnName} failed to register against stub ports: ${err.message}`);
    }
  }
  for (const entry of catalogue.listAll()) {
    const policy = catalogue.getPolicy(entry.name);
    const timeoutMs = Math.trunc(policy?.timeoutMs ?? 0);
    if (timeoutMs > maxPolicy) {
      maxPolicy = timeoutMs;
      maxPolicyName = entry.name;
    }
    registered += 1;
  }
  if (registered === 0) problems.push('catalogue registered no capabilities; the dominance check cannot be trusted');
  // Every advertised tool must resolve to a registration: either the advertised
  // name itself, or the rename its routing row declares. This is what catches a
  // row that survives a rename/retirement on the server side.
  for (const [advertised] of proxy.definitions || []) {
    const resolved = map[advertised] || advertised;
    if (!catalogue.has(resolved)) {
      problems.push(`advertised tool '${advertised}' resolves to '${resolved}', which the catalogue does not register`);
    }
  }
  for (const target of routedTargets) {
    if (!catalogue.has(target)) {
      problems.push(`CAPABILITY_MAP target '${target}' is not a registered capability`);
    }
  }

  // ─── Parity: advertised schema vs CapabilityDefinition.inputSchema ──────
  // The advertised surface is a promise; the catalogue is the source of truth.
  // Unsafe direction (fails): the client accepts a call the server rejects —
  // a catalogue-required field the advertisement leaves optional, an
  // advertised property the capability does not declare, a type/enum that
  // disagrees. Safe direction (allowed): the advertisement narrows the
  // declared surface — fewer optional props, stricter required fields.
  // For core.* the proxy IS the implementation, so the advertised schema must
  // equal the catalogue schema exactly, in both directions.
  const coreDispatch = proxy.CORE_DISPATCH || {};
  const advertisedCore = new Set();
  const advertisedResolved = new Set();
  for (const [advertised, , advProps, advRequired, advOneOf] of proxy.definitions || []) {
    const resolved = map[advertised] || advertised;
    advertisedResolved.add(resolved);
    const entry = catalogue.get(resolved);
    if (!entry) continue; // unresolved advertised names are already reported above
    const declared = entry.inputSchema || {};
    const declaredProps = declared.properties || {};
    const declaredRequired = (declared.required || []).slice().sort();
    const advPropNames = sortedKeys(advProps);
    const advReq = (advRequired || []).slice().sort();
    for (const r of advReq) {
      if (!advPropNames.includes(r)) {
        problems.push(`advertised tool '${advertised}' requires '${r}' but does not declare it as a property`);
      }
      if (!(r in declaredProps)) {
        problems.push(`advertised tool '${advertised}' requires '${r}', which '${resolved}' does not declare`);
      }
    }
    for (const r of declaredRequired) {
      if (!advReq.includes(r)) {
        problems.push(`advertised tool '${advertised}' does not require '${r}', which '${resolved}' requires — the server would reject calls the client accepted`);
      }
    }
    for (const p of advPropNames) {
      if (!(p in declaredProps)) {
        problems.push(`advertised tool '${advertised}' declares property '${p}', which '${resolved}' does not accept`);
      } else if (specKey(advProps[p]) !== specKey(declaredProps[p])) {
        problems.push(`advertised tool '${advertised}' property '${p}' diverges from '${resolved}': advertised ${specKey(advProps[p])} vs declared ${specKey(declaredProps[p])}`);
      }
    }
    const advOneOfKey = oneOfKey(advOneOf);
    const declaredOneOfKey = oneOfKey(declared.oneOf);
    if (advOneOfKey !== declaredOneOfKey) {
      problems.push(`advertised tool '${advertised}' oneOf diverges from '${resolved}': advertised ${advOneOfKey ?? '(none)'} vs declared ${declaredOneOfKey ?? '(none)'}`);
    }
    if (resolved.startsWith('core.')) {
      advertisedCore.add(resolved);
      for (const p of sortedKeys(declaredProps)) {
        if (!advPropNames.includes(p)) {
          problems.push(`advertised core tool '${advertised}' omits property '${p}', which '${resolved}' declares — the proxy is the implementation, so its schema must be exact`);
        }
      }
      for (const r of advReq) {
        if (!declaredRequired.includes(r)) {
          problems.push(`advertised core tool '${advertised}' requires '${r}', which '${resolved}' does not`);
        }
      }
      if (!coreDispatch[resolved]) {
        problems.push(`advertised core tool '${advertised}' resolves to '${resolved}' but CORE_DISPATCH has no entry — it is unreachable`);
      }
    }
  }

  // ─── Ambient bound-tab default: the declaration must be truthful ──────────
  // The proxy fills an omitted field from the session's bound tab ONLY for rows
  // that declare an ambient target field (definition element 5). The catalogue
  // cannot distinguish a `tabId` that selects the tab to act on from one that
  // predicates over stored records — both register requiresBrowserTarget:false
  // with an optional tabId — so the row declaration is the sole authority and
  // this gate verifies it against the catalogue:
  //   * a declared row must resolve to a registration that accepts the field,
  //    and the field must stay optional (a required field can never receive a
  //    default, so declaring one is dead configuration);
  //   * a declared row whose capability does not consume a browser target must
  //    still show browser-target forwarding in its execute body — the evidence
  //    that separates a selector (browser.get-viewport -> browser.getViewport)
  //    from a filter (anti.verification.list -> IssueRegister.listVerifications);
  //   * an undeclared row that advertises an optional `tabId` while its
  //    capability consumes a browser target (requiresBrowserTarget, or the same
  //    execute evidence for target-optional rows) would silently lose the
  //    ambient default — declare the field or drop the property.
  const browserTargetEvidence = (entry) =>
    typeof entry?.execute === 'function' && /\bcontext\.browserTarget\b|\bbrowser\./.test(entry.execute.toString());
  for (const [advertised, , advProps, advRequired, , ambientField] of proxy.definitions || []) {
    const resolved = map[advertised] || advertised;
    const entry = catalogue.has(resolved) ? catalogue.get(resolved) : null;
    const advertisedOptionalTabId = Boolean(advProps && advProps.tabId) && !(Array.isArray(advRequired) && advRequired.includes('tabId'));
    if (typeof ambientField === 'string' && ambientField.length > 0) {
      if (!advProps || !(ambientField in advProps)) {
        problems.push(`advertised tool '${advertised}' declares ambient target field '${ambientField}' but does not advertise it as a property`);
      }
      if (Array.isArray(advRequired) && advRequired.includes(ambientField)) {
        problems.push(`advertised tool '${advertised}' declares ambient target field '${ambientField}' but also requires it — a required field can never receive the ambient default`);
      }
      if (!entry) {
        problems.push(`advertised tool '${advertised}' declares ambient target field '${ambientField}' but resolves to '${resolved}', which the catalogue does not register`);
      } else {
        const declaredProps = (entry.inputSchema && entry.inputSchema.properties) || {};
        if (!(ambientField in declaredProps)) {
          problems.push(`advertised tool '${advertised}' declares ambient target field '${ambientField}', which '${resolved}' does not accept`);
        }
        if (!entry.requiresBrowserTarget && !browserTargetEvidence(entry)) {
          problems.push(`advertised tool '${advertised}' declares ambient target field '${ambientField}' but '${resolved}' does not consume a browser target — its execute body forwards to no browser-scoped collaborator, so the field is a filter, not a selector`);
        }
      }
    } else if (advertisedOptionalTabId) {
      if (entry && entry.requiresBrowserTarget) {
        problems.push(`advertised tool '${advertised}' advertises an optional 'tabId' and '${resolved}' consumes a browser target, but declares no ambient target field — the bound-tab default is silently lost; declare 'tabId' as the row's ambient field or drop the property`);
      } else if (entry && browserTargetEvidence(entry)) {
        problems.push(`advertised tool '${advertised}' advertises an optional 'tabId' and '${resolved}' forwards it to a browser-scoped collaborator, but declares no ambient target field — the bound-tab default is silently lost; declare 'tabId' as the row's ambient field or drop the property`);
      }
    }
  }
  // Every catalogue registration inside a namespace the surface promises must
  // be advertised: an unadvertised registration is unreachable through this
  // surface. `core.*` additionally requires a CORE_DISPATCH entry, because the
  // proxy implements those in-process — a dispatch entry with no registration
  // is a phantom. `terminal.*` joins the rule because the namespace was
  // registered and wired while the surface advertised zero of its lines.
  const COMPLETENESS_NAMESPACES = Object.freeze(['core.', 'terminal.']);
  for (const entry of catalogue.listAll()) {
    if (!COMPLETENESS_NAMESPACES.some((prefix) => entry.name.startsWith(prefix))) continue;
    if (!advertisedResolved.has(entry.name)) {
      problems.push(`catalogue registers '${entry.name}' but the proxy does not advertise it`);
    }
    if (entry.name.startsWith('core.') && !coreDispatch[entry.name]) {
      problems.push(`catalogue registers '${entry.name}' but CORE_DISPATCH has no entry for it`);
    }
  }
  for (const name of Object.keys(coreDispatch)) {
    if (!catalogue.has(name)) {
      problems.push(`CORE_DISPATCH['${name}'] has no catalogue registration`);
    }
  }
  // The store method each dispatch entry names must exist on the real Core
  // class — this is what catches an advertised capability whose backing store
  // method was renamed or removed.
  const storeMethods = resolveCoreStoreMethods();
  let mutatingCount = 0;
  for (const [name, dispatchEntry] of Object.entries(coreDispatch)) {
    const method = Array.isArray(dispatchEntry) ? dispatchEntry[0] : undefined;
    const adapt = Array.isArray(dispatchEntry) ? dispatchEntry[1] : undefined;
    const mutating = Array.isArray(dispatchEntry) ? dispatchEntry[2] : undefined;
    if (typeof method !== 'string' || typeof adapt !== 'function') {
      problems.push(`CORE_DISPATCH['${name}'] is malformed (expected [storeMethod, adapt, mutating])`);
      continue;
    }
    // Mutability must be declared, never inferred: an unclassified entry
    // defaults to the soft `{available:false}` path, so a write the caller
    // believes landed would no-op silently when the store is unreachable.
    if (typeof mutating !== 'boolean') {
      problems.push(`CORE_DISPATCH['${name}'] does not declare mutability (expected a boolean third element)`);
    } else if (mutating) {
      mutatingCount += 1;
    }
    if (storeMethods && !storeMethods.has(method)) {
      problems.push(`CORE_DISPATCH['${name}'] calls store method '${method}', which does not exist on Core`);
    }
  }
  notes.push(`dispatch: ${mutatingCount} of ${Object.keys(coreDispatch).length} core.* entries declared mutating (refused when the store is unavailable)`);
  // The catalogue's own binding (core-capabilities.ts) must call the same
  // store method the proxy dispatches to — two surfaces, one method.
  const SENTINEL_PARAMS = { name: 'parity', note: 'parity', releaseId: 'parity', fromNodeId: 'parity', depth: 1, phase: 'parity', gate: 'parity', regressionId: 'parity' };
  for (const name of advertisedCore) {
    const def = catalogue.get(name);
    const dispatchEntry = coreDispatch[name];
    if (!def || !dispatchEntry) continue;
    coreCalls.length = 0;
    try {
      def.execute(SENTINEL_PARAMS, {});
    } catch { /* a recording port cannot throw; a binding that does is itself drift */ }
    const called = coreCalls[0];
    if (called !== dispatchEntry[0]) {
      problems.push(`catalogue binds '${name}' to store method '${called ?? '(none)'}' but the proxy dispatches '${dispatchEntry[0]}'`);
    }
  }
  notes.push(`parity: ${(proxy.definitions || []).length} advertised tools checked against catalogue schemas; ${advertisedCore.size} core.* dispatched`);
  // A row that redirects a name the catalogue ALSO registers swaps the server's
  // own semantics for the target's. It is reported rather than rejected: several
  // anti.* aliases are independent implementations, so a fatal rule here would
  // flag legitimate rows. anti.browser.tabs.list was one of these and is fixed;
  // the rest form the deferred routing sweep.
  const shadowing = Object.entries(map)
    .filter(([advertised, target]) => advertised !== target && catalogue.has(advertised))
    .map(([advertised, target]) => `${advertised} -> ${target}`);
  if (shadowing.length > 0) {
    notes.push(
      `routing rows that shadow a registration the catalogue owns (${shadowing.length}): ` +
        shadowing.slice(0, 6).join(', ') +
        (shadowing.length > 6 ? `, +${shadowing.length - 6} more` : '')
    );
  }
  notes.push(`catalogue: ${registered} capabilities, largest policy ${maxPolicy} ms (${maxPolicyName})`);
  notes.push(`proxy ceiling: ${ceiling} ms`);
  if (typeof ceiling === 'number' && maxPolicy > 0 && ceiling <= maxPolicy) {
    problems.push(
      `client ceiling ${ceiling} ms does not exceed the largest server policy ${maxPolicy} ms (${maxPolicyName}); ` +
        'a capability using its full budget would be abandoned client-side before the server answers'
    );
  }
}

// The real store method set: prefer the built package (authoritative), fall
// back to the TypeScript source's method declarations so the gate still fires
// in a checkout where packages/super-core has not been built.
function resolveCoreStoreMethods() {
  if (fs.existsSync(SUPER_CORE_DIST)) {
    try {
      const mod = require(SUPER_CORE_DIST);
      const CoreClass = mod && mod.Core;
      if (CoreClass && CoreClass.prototype) {
        return new Set(Object.getOwnPropertyNames(CoreClass.prototype));
      }
    } catch (err) {
      notes.push(`super-core dist present but not loadable (${err.message}); falling back to source scan`);
    }
  }
  if (fs.existsSync(SUPER_CORE_SRC)) {
    const src = fs.readFileSync(SUPER_CORE_SRC, 'utf8');
    const classStart = src.indexOf('export class Core');
    const classEnd = src.indexOf('\nexport function openCore', classStart);
    if (classStart !== -1 && classEnd > classStart) {
      const body = src.slice(classStart, classEnd);
      const methods = new Set();
      // `get`/`set` are declaration modifiers, so the alternation must include them:
      // without it a dispatched accessor looks like a phantom method.
      const re = /^ {2}(?:private\s+|public\s+|async\s+|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*[(:]/gm;
      let m;
      while ((m = re.exec(body)) !== null) methods.add(m[1]);
      if (methods.size > 0) return methods;
    }
  }
  problems.push('cannot resolve the super-core store method set (dist missing and source scan found no methods); the store-method parity check cannot run');
  return null;
}

// ─── 3. Verdict ─────────────────────────────────────────────────────────────
for (const note of notes) process.stdout.write(`[budget-dominance] ${note}\n`);
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`[budget-dominance] FAIL ${problem}\n`);
  process.exit(1);
}
process.stdout.write('[budget-dominance] OK: one ceiling dominates every server policy\n');
