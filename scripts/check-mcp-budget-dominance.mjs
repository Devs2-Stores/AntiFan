#!/usr/bin/env node
/**
 * Compile-time dominance check for the MCP client dispatch ceiling.
 *
 * The standalone stdio proxy (scripts/antifan-omp-mcp.cjs) owns exactly one
 * budget number: DEFAULT_CLIENT_TIMEOUT_MS. It exists so the SERVER is always
 * the side that bounds a hung capability first, which is what lets the client
 * observe a typed terminal (or EXECUTION_TIMEOUT_PENDING_CLEANUP) receipt
 * instead of abandoning the invocation and replaying unknown work.
 *
 * That guarantee only holds while the ceiling exceeds every capability policy
 * the catalogue can enforce. A per-tool override table used to hold the
 * exceptions by hand and rotted silently (theme.debug_bundle carries a 60 s
 * policy and had no entry, so the 30 s default fired first). This check makes
 * the invariant structural: it builds the real catalogue, reads the largest
 * policy from it, and refuses to compile when the ceiling stops dominating —
 * and it refuses a re-introduced per-tool table or a no-op routing row.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPILED = path.join(ROOT, '.compiled', 'src');
const PROXY_PATH = path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs');

const problems = [];
const notes = [];

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
  ['main/workflow/workflow-capabilities.js', 'registerWorkflowCapabilities'],
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
  const registrations = {
    registerBrowserCapabilities: [browserPort, undefined, getWorkspaceRoot],
    registerFileCapabilities: [{}, getWorkspaceRoot, undefined],
    registerArtifactCapabilities: [{}],
    registerTerminalCapabilities: [{}],
    registerThemeTransactionCapabilities: [{}, getWorkspaceRoot],
    registerWorkflowCapabilities: [{}],
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

// ─── 3. Verdict ─────────────────────────────────────────────────────────────
for (const note of notes) process.stdout.write(`[budget-dominance] ${note}\n`);
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`[budget-dominance] FAIL ${problem}\n`);
  process.exit(1);
}
process.stdout.write('[budget-dominance] OK: one ceiling dominates every server policy\n');
