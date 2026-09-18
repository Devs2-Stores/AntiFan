import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = path.join(ROOT, 'scripts', 'check-mcp-budget-dominance.mjs');
const PROXY = path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs');
const DRIFT_FIXTURE = path.join(ROOT, 'test', 'unit', 'fixtures', 'mcp', 'proxy-seeded-drift.cjs');
const PHANTOM_FIXTURE = path.join(ROOT, 'test', 'unit', 'fixtures', 'mcp', 'proxy-seeded-phantom.cjs');
const COMPILED = path.join(ROOT, '.compiled', 'src');
function runGate(extraArgs = []) {
  return spawnSync(process.execPath, [GATE, ...extraArgs], { cwd: ROOT, encoding: 'utf8' });
}

test('parity gate passes at HEAD: advertised schemas match the catalogue and every core.* dispatch resolves', () => {
  const result = runGate();
  assert.equal(result.status, 0, `gate must pass at HEAD\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /one ceiling dominates every server policy/, 'budget dominance verdict must still print');
});

test('parity gate fails on seeded schema drift', () => {
  const result = runGate(['--proxy', DRIFT_FIXTURE]);
  assert.equal(result.status, 1, `gate must fail on drifted advertised schema\nstdout:\n${result.stdout}`);
  assert.match(result.stderr, /bogusDrift/, 'the failure must name the drifted property');
});

test('parity gate fails when a dispatch entry names a store method that does not exist', () => {
  const result = runGate(['--proxy', PHANTOM_FIXTURE]);
  assert.equal(result.status, 1, `gate must fail on a phantom store method\nstdout:\n${result.stdout}`);
  assert.match(result.stderr, /nonexistentStoreMethod/, 'the failure must name the phantom method');
});

// The proxy handles core.* in-process; SUPER_CORE_DB=':memory:' gives it a real
// store with no file to clean up. Set before require so getCore() resolves it.
process.env.SUPER_CORE_DB = ':memory:';
const proxy = require(PROXY);

test('core.record_regression no longer demands replayResult, and the store still refuses it', async () => {
  const recorded = await proxy.invoke('core.record_regression', {
    newKnowledge: 'parity-test',
    checks: [{ kind: 'query-hit', text: 'parity-test', min: 0 }],
  });
  assert.equal(typeof recorded.regressionId, 'string', 'record must return a regressionId without replayResult');

  await assert.rejects(
    () => proxy.invoke('core.record_regression', { replayResult: 'PASS' }),
    /replayResult is produced by replayRegression/,
    'the store must still throw when a caller supplies replayResult'
  );
});

test('core.replay_regression is callable through MCP dispatch and writes the replay result', async () => {
  const recorded = await proxy.invoke('core.record_regression', {
    newKnowledge: 'parity-replay',
    checks: [{ kind: 'query-hit', text: 'parity-replay', min: 0 }],
  });
  const replayed = await proxy.invoke('core.replay_regression', { regressionId: recorded.regressionId });
  assert.equal(replayed.regressionId, recorded.regressionId);
  assert.equal(replayed.replayResult, 'PASS', 'a regression whose checks all pass must replay PASS');

  await assert.rejects(
    () => proxy.invoke('core.replay_regression', {}),
    /INVALID_ARGUMENT/,
    'regressionId is advertised required and must be enforced before dispatch'
  );
});

test('core.record_observation is callable through MCP dispatch', async () => {
  const result = await proxy.invoke('core.record_observation', {
    source: 'parity-test',
    kind: 'TEST_OBSERVATION',
    payload: { ok: true },
  });
  assert.equal(typeof result.observationId, 'string', 'record must return an observationId');

  await assert.rejects(
    () => proxy.invoke('core.record_observation', { kind: 'TEST_OBSERVATION' }),
    /INVALID_ARGUMENT/,
    'source is advertised required and must be enforced before dispatch'
  );
});

test('core.health is callable through MCP dispatch and reports a reason code', async () => {
  const result = await proxy.invoke('core.health', {});
  assert.equal(typeof result.status, 'string', 'health must report a status');
  assert.equal(typeof result.reasonCode, 'string', 'a status without a reason code is not actionable');
  assert.ok(['HEALTHY', 'DEGRADED', 'UNKNOWN'].includes(result.status), `unexpected health status ${result.status}`);
  // A degraded or unmeasured store must never carry the all-pass reason code;
  // that pairing is how a health surface launders a problem into a green light.
  // The code is asserted against what the store emits today AND against the
  // composition it must satisfy for a degraded store, so a rename can only make
  // this guard stale, never silently unreachable.
  if (result.status === 'DEGRADED') {
    assert.ok(
      Array.isArray(result.failedGates) && result.failedGates.length > 0,
      `a degraded store must name the gates that failed (got ${JSON.stringify(result.failedGates)})`
    );
    assert.strictEqual(
      result.reasonCode,
      result.failedGates.map((name) => `GATE_${String(name).toUpperCase()}_FAILED`).join('+'),
      'a degraded reason code must name every failed gate, not a subset'
    );
  } else if (result.status !== 'HEALTHY') {
    assert.notEqual(result.reasonCode, 'ALL_GATES_PASSED', 'a non-healthy status must not report the all-pass reason code');
  }
  assert.ok(result.gates && typeof result.gates === 'object', 'health must carry the gate results it summarised');
});

test('retired browser_find routing row is behaviour-preserving: registration and browser.find call the same port method', () => {
  const { CapabilityCatalogue } = require(path.join(COMPILED, 'main/tools/capability-catalogue.js'));
  const { BrowserControlPort } = require(path.join(COMPILED, 'main/tools/browser-control-port.js'));
  const { makeControlPlaneId } = require(path.join(COMPILED, 'shared/control-plane-contracts.js'));
  const { registerBrowserCapabilities } = require(path.join(COMPILED, 'main/tools/browser-capabilities.js'));

  const calls = [];
  const recordingPort = new Proxy({}, {
    get: (_t, prop) => (typeof prop === 'string'
      ? (params) => { calls.push([prop, params]); return { recorded: prop }; }
      : undefined),
  });
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId: makeControlPlaneId('project'),
    workspaceId: makeControlPlaneId('workspace'),
    runtimeId: 'parity-test',
    hostEpoch: 1,
    isTabAllowed: () => true,
    resolveTabId: (id) => id,
    getDocumentGeneration: () => 1,
  });
  registerBrowserCapabilities(catalogue, recordingPort, undefined, () => ROOT);

  const params = { text: 'needle', pattern: 'needle', query: 'needle', tabId: 'tab-1' };
  for (const name of ['browser.find', 'browser_find']) {
    calls.length = 0;
    catalogue.get(name).execute(params, {});
    assert.deepEqual(calls, [['agentFind', params]], `${name} must call agentFind with the params unchanged`);
  }

  // Dispatch parity alone does not prove the params are reachable: a client can
  // only pass what the advertised schema declares. agentFind accepts tabId,
  // paneId and maxMatches, so the schema must expose them.
  const TARGETING = ['tabId', 'paneId', 'maxMatches'];
  const catalogueProps = catalogue.get('browser_find').inputSchema.properties;
  for (const prop of TARGETING) {
    assert.ok(prop in catalogueProps, `catalogue browser_find schema must advertise ${prop}`);
  }
  const advertised = (proxy.definitions || []).find((row) => row[0] === 'browser_find');
  assert.ok(advertised, 'browser_find must still be advertised');
  const advertisedProps = advertised[2] || {};
  for (const prop of TARGETING) {
    assert.ok(prop in advertisedProps, `advertised browser_find schema must expose ${prop}`);
  }
});

// A routing row that shadows a registration sends an advertised name to a
// different capability on the server. When both bind the same port method the
// row is a redundant duplicate; when they diverge, one of the two paths is
// wrong and callers get whichever behaviour the routing row happens to pick.
// This is the per-row proof the deferred routing sweep needs, asserted so a
// future divergence cannot hide behind the row.
test('every shadowing routing row agrees with its registration on the port method', () => {
  const { CapabilityCatalogue } = require(path.join(COMPILED, 'main/tools/capability-catalogue.js'));
  const { makeControlPlaneId } = require(path.join(COMPILED, 'shared/control-plane-contracts.js'));
  const { registerBrowserCapabilities } = require(path.join(COMPILED, 'main/tools/browser-capabilities.js'));

  const calls = [];
  const recordingPort = new Proxy({}, {
    get: (_t, prop) => (typeof prop === 'string'
      ? (params) => { calls.push([prop, params]); return { recorded: prop }; }
      : undefined),
  });
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId: makeControlPlaneId('project'),
    workspaceId: makeControlPlaneId('workspace'),
    runtimeId: 'shadow-parity',
    hostEpoch: 1,
    isTabAllowed: () => true,
    resolveTabId: (id) => id,
    getDocumentGeneration: () => 1,
  });
  registerBrowserCapabilities(catalogue, recordingPort, undefined, () => ROOT);

  const SENTINEL = {
    name: 'p', note: 'p', releaseId: 'p', fromNodeId: 'p', depth: 1, phase: 'p', gate: 'p', regressionId: 'p',
    tabId: 'tab-1', paneId: 'desktop', width: 800, height: 600, selector: '.x', ref: '@e1', text: 'x', key: 'Enter',
    action: 'click', steps: [], actions: [], deltaY: 1, zoomFactor: 1, presetId: 'p', operation: 'apply', id: 'i',
    artifactId: 'a', path: 'p', outputPath: 'p', expression: '1', frameUrl: 'f', claimId: 'c',
  };
  const portMethodFor = (name) => {
    const def = catalogue.get(name);
    if (!def) return null;
    calls.length = 0;
    try { def.execute({ ...SENTINEL }, {}); } catch { /* a throwing binding still records the method it reached for */ }
    return calls[0] ? calls[0][0] : '(none)';
  };

  const map = proxy.CAPABILITY_MAP || {};
  const rows = Object.entries(map).filter(([advertised, target]) => advertised !== target && catalogue.has(advertised));
  assert.ok(rows.length > 0, 'positive control: the sweep has rows to check');
  const divergent = [];
  for (const [advertised, target] of rows) {
    const own = portMethodFor(advertised);
    const routed = portMethodFor(target);
    if (own !== routed) divergent.push(`${advertised} binds ${own} but routes to ${target} which binds ${routed}`);
  }
  assert.deepEqual(divergent, [], 'a shadowing row must not change which port method runs');
});

// A mutating capability that answers `{available:false}` reads as "nothing
// happened"; a caller that believes its write landed will not retry. Writes must
// therefore be refused out loud when the store is unreachable.
test('mutating core.* capabilities are refused, not soft-failed, when the store is unreachable', () => {
  const WRITES = {
    'core.replay_regression': { regressionId: 'reg-1' },
    'core.record_observation': { source: 's', kind: 'K' },
    'core.record_regression': { newKnowledge: 'n' },
    'core.ingest_outcome': { task: 't', outcome: 'o' },
  };
  const script = `
const proxy = require(${JSON.stringify(PROXY)});
(async () => {
  const results = {};
  for (const [tool, params] of Object.entries(${JSON.stringify(WRITES)})) {
    try { await proxy.invoke(tool, params); results[tool] = 'RESOLVED'; }
    catch (e) { try { results[tool] = JSON.parse(e.message).code; } catch { results[tool] = 'THREW_NON_JSON'; } }
  }
  try {
    const r = await proxy.invoke('core.stats', {});
    results['core.stats'] = r && r.available === false ? 'SOFT_UNAVAILABLE' : 'RESOLVED';
  } catch (e) { results['core.stats'] = 'THREW'; }
  console.log(JSON.stringify(results));
})();
`;
  // A db path whose parent is a file cannot be created, so the store fails to open.
  const unreachable = path.join(ROOT, 'package.json', 'core.db');
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SUPER_CORE_DB: unreachable },
  });
  assert.equal(child.status, 0, `probe failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
  const results = JSON.parse(child.stdout.trim().split('\n').pop());
  for (const tool of Object.keys(WRITES)) {
    assert.equal(results[tool], 'CORE_UNAVAILABLE', `${tool} must refuse rather than return a soft unavailable`);
  }
  assert.equal(results['core.stats'], 'SOFT_UNAVAILABLE', 'read-shaped capabilities keep the soft unavailable response');
});
