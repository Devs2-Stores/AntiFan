/**
 * Core Health Hub surfaces (Phase 6 items 13/14/15/28/29) — real DOM proof.
 *
 * Loads the compiled toolbar.html + toolbar.js into jsdom with a stubbed
 * antifanToolbar bridge, opens the existing Workflow & MCP Hub, and asserts
 * the five surfaces render inside #workflowHubOverlay — no second overlay.
 *
 * jsdom is a transitive dep; when the shared node_modules copy is broken the
 * test honors ANTIFAN_JSDOM (a dir containing node_modules/jsdom) and skips
 * with the resolution error as the named blocker.
 */
import { test, describe, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

interface JsdomLike { window: Window & { eval: (src: string) => unknown } }
type JsdomCtor = new (html: string, options?: { runScripts?: string; url?: string }) => JsdomLike;

function loadJsdom(): { JSDOM?: JsdomCtor; error?: string } {
  const req = createRequire(__filename);
  // ANTIFAN_JSDOM points at a dir containing node_modules/jsdom and wins first;
  // the default lookup (junctioned node_modules) is the fallback.
  const searchPaths = process.env.ANTIFAN_JSDOM
    ? [process.env.ANTIFAN_JSDOM, path.dirname(__filename)]
    : [path.dirname(__filename)];
  try {
    const resolved = req.resolve('jsdom', { paths: searchPaths });
    return { JSDOM: (req(resolved) as { JSDOM: JsdomCtor }).JSDOM };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err) };
  }
}

const RENDERER_DIR = (() => {
  // Compiled tests run from .compiled/test/renderer — walk up until the
  // compiled renderer assets are found (works from src/ and .compiled/).
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.compiled', 'src', 'renderer');
    if (fs.existsSync(path.join(candidate, 'toolbar.html'))) return candidate;
    const direct = path.join(dir, 'src', 'renderer');
    if (fs.existsSync(path.join(direct, 'toolbar.html'))) return direct;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..', '.compiled', 'src', 'renderer');
})();

const DEGRADED_STATE = {
  snapshot: {
    status: 'DEGRADED',
    reasonCode: 'PENDING_CANDIDATES',
    affected: ['3 pending candidates'],
    evidenceRefs: ['phase_gates:gate-p'],
    checkedAt: '2026-09-16T00:00:00Z',
    checks: [
      { name: 'core.store', status: 'HEALTHY', reasonCode: 'STORE_REACHABLE', affected: [], evidenceRefs: ['cli:health'], detail: '10 artifacts' },
      { name: 'core.promotion', status: 'DEGRADED', reasonCode: 'PENDING_CANDIDATES', affected: ['3 pending candidates'], evidenceRefs: ['phase_gates:gate-p'], detail: '3 pending candidates' },
    ],
    stats: { artifacts: 10, claims: 5 },
  },
  bridge: {
    status: 'UNKNOWN',
    reasonCode: 'BRIDGE_TELEMETRY_MISSING',
    affected: ['proj/.canary/core-bridge/events.jsonl'],
    evidenceRefs: ['cli:stats'],
    coreReachable: true,
    telemetryFound: false,
    telemetryPaths: [],
    failures: [],
    recentPacks: [{ packId: 'pack-abc', task: 'demo task', platform: 'haravan', createdAt: '2026-09-15T00:00:00Z' }],
    unknowns: ['pack injection rate per agent turn — not measurable from this surface'],
  },
  taskRuns: {
    status: 'HEALTHY',
    reasonCode: 'TASK_RUNS_PRESENT',
    affected: [],
    evidenceRefs: ['cli:task-runs'],
    taskRunsTable: false,
    taskRuns: [],
    packs: [{ packId: 'pack-abc', task: 'demo task', platform: 'haravan', createdAt: '2026-09-15T00:00:00Z' }],
    cases: [{ caseId: 'case-xyz', task: 'verified outcome', createdAt: '2026-09-14T00:00:00Z' }],
  },
  rootCauses: {
    status: 'DEGRADED',
    reasonCode: 'OPEN_HIGH_SEVERITY_ISSUES',
    affected: ['CAPTURE_TIMEOUT ×2'],
    evidenceRefs: ['issue-register:open'],
    openTotal: 2,
    groups: [{ key: 'CAPTURE_TIMEOUT', issueClass: 'browser', count: 2, worstSeverity: 'P1', affected: ['tab-1'], latestIssueId: 'ISS-9', latestMessage: 'screenshot timed out' }],
  },
  regressions: {
    status: 'DEGRADED',
    reasonCode: 'REGRESSION_FAILED',
    affected: ['reg-1'],
    evidenceRefs: ['cli:regressions'],
    replayEngineAvailable: true,
    rows: [{ regressionId: 'reg-1', newKnowledge: 'batch', replayResult: 'FAIL', createdAt: '2026-09-15T01:00:00Z' }],
  },
};

function makeApi(state: unknown) {
  const noop = () => () => undefined;
  return {
    getInitialState: () => Promise.resolve({ tabs: [], activeTabId: '', bookmarks: [] }),
    getWorkflowState: () => Promise.resolve({ workflows: [], tools: [] }),
    getCoreHealthState: () => Promise.resolve(state),
    getCoreTaskRunTrace: (id: string) => Promise.resolve({
      status: 'HEALTHY', reasonCode: 'TRACE_FOUND', affected: [id], evidenceRefs: ['cli:pack-detail'],
      kind: 'pack', pack: { packId: id, task: 'demo task' }, claims: [{ claimId: 'c1', statement: 's' }], receipts: [],
    }),
    onStateUpdated: noop,
    onThemeQaState: noop,
    onFocusFind: noop,
    onFocusOmnibox: noop,
    onShowShortcuts: noop,
    onFindResult: noop,
    onPhoneStatusChanged: noop,
    onWorkflowEvent: noop,
    getPhoneStatus: () => Promise.resolve({ state: 'unknown' }),
  };
}

async function flush(rounds = 8) {
  // Microtask yields only — every async hop in the toolbar is promise-based,
  // so draining the microtask queue is the deterministic wait (no timers).
  for (let i = 0; i < rounds; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    queueMicrotask(resolve);
    await promise;
  }
}

async function loadToolbar(state: unknown) {
  const { JSDOM, error } = loadJsdom();
  if (!JSDOM) throw new Error(`jsdom unavailable: ${error}`);
  const html = fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const win = dom.window;
  (win as { antifanToolbar?: unknown }).antifanToolbar = makeApi(state);
  win.eval(fs.readFileSync(path.join(RENDERER_DIR, 'exports-shim.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.js'), 'utf8'));
  await flush();
  return { dom, win, doc: win.document };
}

describe('Core Health surfaces inside the existing Hub', () => {
  let dom: JsdomLike | undefined;
  after(() => { dom?.window.close(); });

  test('five surfaces live inside #workflowHubOverlay — no second overlay', async (t) => {
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const ctx = await loadToolbar(DEGRADED_STATE);
    dom = ctx.dom;
    const doc = ctx.doc;
    const overlay = doc.getElementById('workflowHubOverlay');
    assert.ok(overlay, 'hub overlay exists');
    for (const id of ['tabNavCoreHealth', 'tabNavBridge', 'tabNavTaskRuns', 'tabNavRootCauses', 'tabNavRegressions']) {
      const el = doc.getElementById(id);
      assert.ok(el, `${id} exists`);
      assert.ok(overlay.contains(el), `${id} is inside the existing Hub overlay`);
      assert.ok(el.closest('.hub-nav-strip'), `${id} sits in the hub nav strip`);
    }
    assert.equal(doc.querySelectorAll('.workflow-hub-overlay').length, 1, 'exactly one hub overlay');
    assert.ok(!doc.getElementById('coreHealthOverlay'), 'no second overlay was built');
  });

  test('Health surface: seeded DEGRADED renders status + reasonCode, not a percentage', async (t) => {
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const ctx = await loadToolbar(DEGRADED_STATE);
    dom = ctx.dom;
    const doc = ctx.doc;
    (doc.getElementById('btnWorkflowHub') as HTMLElement).click();
    await flush();
    (doc.getElementById('tabNavCoreHealth') as HTMLElement).click();
    await flush();
    const pill = doc.getElementById('coreStatusPill');
    const cat = doc.getElementById('coreDetailCategory');
    const body = doc.getElementById('coreDetailCode');
    assert.equal(doc.getElementById('hubCoreDetail')?.style.display, 'flex');
    assert.equal(pill?.textContent, 'DEGRADED');
    assert.equal(cat?.textContent, 'PENDING_CANDIDATES');
    assert.ok(body?.textContent?.includes('pending candidates'));
    assert.ok(!/%/.test(pill?.textContent ?? ''), 'status pill must not show a percentage');
    const items = doc.querySelectorAll('#hubItemsList .hub-list-item');
    assert.ok(items.length >= 2, 'checks listed in the list pane');
  });

  test('Bridge surface: missing telemetry → UNKNOWN + unknowns visible', async (t) => {
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const ctx = await loadToolbar(DEGRADED_STATE);
    dom = ctx.dom;
    const doc = ctx.doc;
    (doc.getElementById('btnWorkflowHub') as HTMLElement).click();
    await flush();
    (doc.getElementById('tabNavBridge') as HTMLElement).click();
    await flush();
    assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'UNKNOWN');
    assert.equal(doc.getElementById('coreDetailCategory')?.textContent, 'BRIDGE_TELEMETRY_MISSING');
    assert.ok(doc.getElementById('coreDetailCode')?.textContent?.includes('unknowns'));
    assert.ok(doc.getElementById('coreDetailCode')?.textContent?.includes('pack injection rate'));
  });

  test('Task Run surface: selecting a pack loads its real trace via IPC', async (t) => {
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const ctx = await loadToolbar(DEGRADED_STATE);
    dom = ctx.dom;
    const doc = ctx.doc;
    (doc.getElementById('btnWorkflowHub') as HTMLElement).click();
    await flush();
    (doc.getElementById('tabNavTaskRuns') as HTMLElement).click();
    await flush();
    const items = doc.querySelectorAll('#hubItemsList .hub-list-item');
    assert.ok(items.length >= 3, 'surface + pack + case rows listed');
    // The surface row is auto-selected and sits first; the trace loads only for
    // the pack row, so select it by identity rather than by position.
    const packRow = doc.querySelector('#hubItemsList .hub-list-item[data-item-id="pack-abc"]') as HTMLElement | null;
    assert.ok(packRow, 'pack row addressable');
    packRow.click();
    await flush();
    assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'HEALTHY');
    assert.equal(doc.getElementById('coreDetailCategory')?.textContent, 'TRACE_FOUND');
    assert.ok(doc.getElementById('coreDetailCode')?.textContent?.includes('c1'));
  });

  test('Root cause surface: groups open issues with severity-driven status', async (t) => {
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const ctx = await loadToolbar(DEGRADED_STATE);
    dom = ctx.dom;
    const doc = ctx.doc;
    (doc.getElementById('btnWorkflowHub') as HTMLElement).click();
    await flush();
    (doc.getElementById('tabNavRootCauses') as HTMLElement).click();
    await flush();
    assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'DEGRADED');
    assert.ok(doc.getElementById('coreDetailCode')?.textContent?.includes('CAPTURE_TIMEOUT'));
    assert.ok(doc.getElementById('coreDetailCode')?.textContent?.includes('screenshot timed out'));
  });

  test('Regression surface: a failed replay renders DEGRADED/REGRESSION_FAILED with its rows', async (t) => {
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const ctx = await loadToolbar(DEGRADED_STATE);
    dom = ctx.dom;
    const doc = ctx.doc;
    (doc.getElementById('btnWorkflowHub') as HTMLElement).click();
    await flush();
    (doc.getElementById('tabNavRegressions') as HTMLElement).click();
    await flush();
    assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'DEGRADED');
    assert.equal(doc.getElementById('coreDetailCategory')?.textContent, 'REGRESSION_FAILED');
    assert.ok(doc.getElementById('coreDetailCode')?.textContent?.includes('replayEngineAvailable'));
    const items = doc.querySelectorAll('#hubItemsList .hub-list-item');
    assert.ok(items.length >= 2, 'engine status + recorded row listed');
  });

  test('Task-run badge counts task_runs rows only, not packs or cases', async (t) => {
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const ctx = await loadToolbar(DEGRADED_STATE);
    dom = ctx.dom;
    const doc = ctx.doc;
    (doc.getElementById('btnWorkflowHub') as HTMLElement).click();
    await flush();
    assert.equal(doc.getElementById('badgeTaskRuns')?.textContent, '0');
  });

  test('Root cause P2 maps to WARN rather than DEGRADED', async (t) => {
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const state = {
      ...DEGRADED_STATE,
      rootCauses: {
        ...DEGRADED_STATE.rootCauses,
        groups: [{
          key: 'SLOW_PAINT',
          issueClass: 'perf',
          count: 1,
          worstSeverity: 'P2',
          affected: ['tab-1'],
          latestIssueId: 'ISS-2',
          latestMessage: 'paint exceeded budget',
        }],
      },
    };
    const ctx = await loadToolbar(state);
    dom = ctx.dom;
    const doc = ctx.doc;
    (doc.getElementById('btnWorkflowHub') as HTMLElement).click();
    await flush();
    (doc.getElementById('tabNavRootCauses') as HTMLElement).click();
    await flush();
    assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'WARN');
    assert.ok(doc.getElementById('coreDetailCode')?.textContent?.includes('SLOW_PAINT'));
  });

  test('Prompt overlay includes a hidden multiline field for JSON authoring', async (t) => {
    if (!loadJsdom().JSDOM) { t.skip(`jsdom unavailable: ${loadJsdom().error}`); return; }
    const ctx = await loadToolbar(DEGRADED_STATE);
    dom = ctx.dom;
    const doc = ctx.doc;
    const multiline = doc.getElementById('promptMultiline');
    assert.ok(multiline, 'promptMultiline textarea exists');
    assert.equal((multiline as HTMLElement).style.display, 'none');
    assert.ok(doc.getElementById('promptModal'));
  });
});
