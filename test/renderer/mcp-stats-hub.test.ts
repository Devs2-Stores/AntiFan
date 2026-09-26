/**
 * MCP Dispatch accounting tab inside the existing Workflow & MCP Hub.
 *
 * Loads the compiled toolbar.html + toolbar.js into jsdom with a stubbed
 * antifanToolbar bridge, exactly like test/renderer/core-health-hub.test.ts, and
 * asserts the renderer half of plans/260917-0341-mcp-dispatch-accounting
 * (phase-04-delivery-surface.md, rows R1-R9):
 *
 *   - the tab is a nav button inside the single `.hub-nav-strip` (no second overlay);
 *   - BOTH mandatory arms are wired (the `renderHubList` branch and the `setHubTab`
 *     arm) — omitting either one blanks the list or the detail pane;
 *   - the reconciliation invariants print in their GENERAL forms, the quarantine
 *     margin label and the `partial: N of M files` truncation label render as their
 *     own rows, and truncated rows carry the `lowerBound` floor marker;
 *   - UNMEASURED with no rows renders one notice block, zero `.hub-list-item`
 *     children and never a `0`;
 *   - a rejected bridge promise and an absent bridge method both degrade to
 *     UNMEASURED with zero unhandled rejections;
 *   - the search box filters per-name rows only and can never hide a disclosure;
 *   - markup seeded into `rows[*].name` and into an `errors` key creates no element
 *     and no attribute (plan.md constraint E).
 *
 * Every payload here is hand-built in this file; no frame is copied out of the live
 * store. jsdom is a transitive dev dep; when the shared node_modules copy is broken
 * the harness honors ANTIFAN_JSDOM (a dir containing node_modules/jsdom).
 */
import { test, describe, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

type JsdomWindow = Window & typeof globalThis & {
  eval: (src: string) => unknown;
  antifanToolbar?: unknown;
  __pwned?: unknown;
};
interface JsdomLike { window: JsdomWindow }
type JsdomCtor = new (html: string, options?: { runScripts?: string; url?: string }) => JsdomLike;

function loadJsdom(): { JSDOM: JsdomCtor } {
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
    throw new Error(`jsdom is a declared devDependency and a hard prerequisite of this suite; resolution failed (searched: ${searchPaths.join(', ')}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

const RENDERER_DIR = (() => {
  // Compiled tests run from .compiled/test/renderer — walk up until the compiled
  // renderer assets are found (works from src/ and .compiled/).
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

const SOURCE_TOOLBAR_TS = (() => {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'src', 'renderer', 'toolbar.ts');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..', 'src', 'renderer', 'toolbar.ts');
})();

// ---- Fixtures (all hand-built; no live frame is copied into the repo) ----------

const MARGIN_LABEL = 'quarantine margin: present 254 = admitted 247 + named-invalid 7 (CHECKSUM_MISMATCH 7) — a margin, not a recovery promise';
const WINDOW_NEWEST_MS = 1758000000000;
const WINDOW_OLDEST_MS = 1757000000000;
// Deliberately unrelated to either window bound: the covered window must come from
// census.limits, never from census.files or from row timestamps.
const CENSUS_FILE_MTIME_MS = 111111111;
// The label the service actually derives: `storeDisplayLabel(...)` is the FINAL path
// segment (phase-01:207, "e.g. invocations"), because Phase 1 (:207, :273) bans `/`,
// `\` and drive-letter prefixes in `storePath` and in every `affected[]` entry — a
// two-segment label is unsatisfiable, so the fixture must not document that shape.
const STORE_LABEL = 'invocations';

const CORE_STATE = {
  snapshot: {
    status: 'HEALTHY', reasonCode: 'OK', affected: [], evidenceRefs: [],
    checkedAt: '2026-09-17T00:00:00.000Z', checks: [],
  },
};

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'browser.switch-tab',
    calls: 787, frames: 800, superseded: 13,
    states: { completed: 790, interrupted: 10 },
    errors: { TARGET_STALE: 4 },
    latency: { count: 12, p50Ms: 13, p95Ms: 3799 },
    excludedLatency: { count: 2, p50Ms: 262957, p95Ms: 2427228 },
    firstSeen: '2026-09-01T00:00:00.000Z',
    lastSeen: '2026-09-17T00:00:00.000Z',
    lowerBound: false,
    ...overrides,
  };
}

function secondRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'anti.browser.evaluate',
    calls: 9040, frames: 9040, superseded: 0,
    states: { completed: 9040 },
    errors: {},
    latency: null,
    excludedLatency: null,
    firstSeen: '2026-09-02T00:00:00.000Z',
    lastSeen: '2026-09-16T00:00:00.000Z',
    lowerBound: false,
    ...overrides,
  };
}

function measuredPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'MEASURED',
    reasonCode: 'OK',
    affected: [],
    evidenceRefs: ['census:abcdef12#L7'],
    asOf: '2026-09-17T00:00:00.000Z',
    storePath: STORE_LABEL,
    census: {
      asOf: '2026-09-17T00:00:00.000Z',
      // No `dir`: phase-01:81 removed `Census.dir` entirely — `storeDisplayLabel(dir)`
      // is the only spelling of "where" that crosses a boundary, so the reader gets the
      // directory as `FrameReadOptions.storeDir` and the census has no key to project.
      files: [{
        name: 'stale-partition-name.jsonl', bucket: 'jsonl', size: 10,
        mtimeMs: CENSUS_FILE_MTIME_MS, lineCount: 1, sha256: 'deadbeef', consistency: 'clean',
      }],
      fileCount: 3, jsonlCount: 3, quarantineCount: 0, tempCount: 0, otherCount: 0,
      totalBytes: 30, censusHash: 'abc',
      limits: {
        budgetMs: 20000, maxBytes: 1, maxFiles: 1,
        observedBytes: 30, observedFiles: 3, filesRead: 3, filesSkipped: 0,
        ceiling: null,
        windowNewestMtimeMs: WINDOW_NEWEST_MS,
        windowOldestMtimeMs: WINDOW_OLDEST_MS,
        elapsedMs: 12, outcome: 'COMPLETE',
      },
    },
    fileRollups: [],
    rows: [baseRow(), secondRow()],
    totals: {
      quarantineMargin: {
        label: MARGIN_LABEL, files: 7,
        framesPresent: 254, framesAdmitted: 247, framesNamedInvalid: 7,
        reasons: [{ class: 'CHECKSUM_MISMATCH', count: 7 }],
      },
      truncation: null,
      retention: {
        firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-17T00:00:00.000Z',
        note: 'a name absent from the row set means no frame is retained in this store, not that the tool was never called',
      },
    },
    reconciliation: {
      classifiedKeys: 9827, unattributedKeys: 0, unattributedFrames: 0, keylessFrames: 0,
      compositeKeys: 9827, frames: 9840, superseded: 13,
      holdsKeys: true, holdsFrames: true,
      lines: [
        'classifiedKeys + unattributedKeys == compositeKeys (9827 + 0 == 9827)',
        'frames == compositeKeys + superseded + keylessFrames (9840 == 9827 + 13 + 0)',
      ],
    },
    ...overrides,
  };
}

function truncatedPayload(): Record<string, unknown> {
  const payload = measuredPayload();
  payload.rows = [baseRow({ lowerBound: true }), secondRow({ lowerBound: true })];
  return {
    ...payload,
    totals: {
      ...(payload.totals as Record<string, unknown>),
      truncation: { ceiling: 'MAX_CENSUS_BYTES', filesRead: 5, filesSkipped: 1, order: 'mtimeMs-desc,name-asc' },
    },
  };
}

function unmeasuredPayload(storePath: string | null, reasonCode: string, affected: string[]): Record<string, unknown> {
  return {
    status: 'UNMEASURED', reasonCode, affected, evidenceRefs: [],
    asOf: '2026-09-17T00:00:00.000Z', storePath,
    census: null, fileRollups: [], rows: [], totals: null, reconciliation: null,
  };
}

function markupPayload(): Record<string, unknown> {
  return measuredPayload({
    rows: [
      baseRow({ name: '<img src=x onerror="window.__pwned=1">', errors: { '<script>x</script>': 1 } }),
      secondRow({ name: 'browser.find' }),
    ],
  });
}

/**
 * An UNMEASURED payload that WAS read: census drift, a degenerate ceiling with
 * `filesRead === 0`, or a partition that vanished between census and read. The store
 * label deliberately carries no digit, so a digit assertion can only be satisfied by
 * digits the payload itself contains.
 */
function unmeasuredWithCensusPayload(
  limitsOverrides: Record<string, unknown> = {},
  outcome: unknown = 'CENSUS_DRIFT',
): Record<string, unknown> {
  return {
    status: 'UNMEASURED', reasonCode: 'NO_DATA', affected: ['census-drift'], evidenceRefs: [],
    asOf: '2026-09-17T00:00:00.000Z', storePath: 'invocations',
    census: {
      asOf: '2026-09-17T00:00:00.000Z',
      files: [],
      fileCount: 3, jsonlCount: 3, quarantineCount: 0, tempCount: 0, otherCount: 0,
      totalBytes: 30, censusHash: 'abc',
      limits: {
        budgetMs: 20000, maxBytes: 1, maxFiles: 1,
        observedBytes: 30, observedFiles: 12, filesRead: 0, filesSkipped: 12,
        ceiling: 'MAX_CENSUS_BYTES',
        windowNewestMtimeMs: WINDOW_NEWEST_MS,
        windowOldestMtimeMs: WINDOW_OLDEST_MS,
        elapsedMs: 7, outcome,
        ...limitsOverrides,
      },
    },
    fileRollups: [], rows: [], totals: null, reconciliation: null,
  };
}

// ---- Harness ----------------------------------------------------------------

type DispatchMode = 'resolve' | 'reject' | 'absent';

function makeApi(state: unknown, mode: DispatchMode) {
  const noop = () => () => undefined;
  const api: Record<string, unknown> = {
    getInitialState: () => Promise.resolve({ tabs: [], activeTabId: '', bookmarks: [] }),
    getWorkflowState: () => Promise.resolve({ workflows: [], tools: [] }),
    getCoreHealthState: () => Promise.resolve(CORE_STATE),
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
  if (mode === 'resolve') {
    api.getMcpDispatchState = () => Promise.resolve(state);
  } else if (mode === 'reject') {
    // The real hazard: a host loads the real preload without registering the handler.
    api.getMcpDispatchState = () => Promise.reject(new Error("No handler registered for 'antifan:mcp-dispatch:get-state'"));
  }
  // 'absent' leaves the key out entirely. The harness bridge is a plain object, so
  // this is constructible here — unlike under the real preload.
  return api;
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

/** Macrotask yields, so a rejection Node would report as unhandled has been reported. */
async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface HubContext { dom: JsdomLike; win: JsdomWindow; doc: Document }

async function loadToolbar(state: unknown, mode: DispatchMode = 'resolve'): Promise<HubContext> {
  const { JSDOM } = loadJsdom();
  const html = fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const win = dom.window;
  // The compiled renderer augments Window with `antifanToolbar`; the harness bridge
  // is a plain object, so it is installed through a cast (the core-health idiom).
  (win as unknown as { antifanToolbar?: unknown }).antifanToolbar = makeApi(state, mode);
  win.eval(fs.readFileSync(path.join(RENDERER_DIR, 'exports-shim.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.js'), 'utf8'));
  await flush();
  return { dom, win, doc: win.document };
}

/** Open the Hub, then click the MCP Dispatch tab — the two flows the plan wires. */
async function openMcpDispatchTab(ctx: HubContext) {
  (ctx.doc.getElementById('btnWorkflowHub') as HTMLElement).click();
  await flush();
  (ctx.doc.getElementById('tabNavMcpDispatch') as HTMLElement).click();
  await flush();
}

function listItems(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll('#hubItemsList .hub-list-item'));
}

function textOf(doc: Document, id: string): string {
  return doc.getElementById(id)?.textContent ?? '';
}

describe('MCP Dispatch tab inside the existing Hub', () => {
  let dom: JsdomLike | undefined;
  after(() => { dom?.window.close(); });

  test('R1 — the tab is a nav button inside the single .hub-nav-strip (no second overlay)', async (t) => {
    const ctx = await loadToolbar(measuredPayload());
    dom = ctx.dom;
    const doc = ctx.doc;
    const overlay = doc.getElementById('workflowHubOverlay');
    assert.ok(overlay, 'hub overlay exists');
    assert.equal(doc.querySelectorAll('.workflow-hub-overlay').length, 1, 'exactly one hub overlay');
    assert.equal(doc.querySelectorAll('.hub-nav-strip').length, 1, 'exactly one nav strip');
    const tab = doc.getElementById('tabNavMcpDispatch');
    assert.ok(tab, '#tabNavMcpDispatch exists');
    assert.ok(tab.closest('.hub-nav-strip'), 'the tab sits inside .hub-nav-strip');
    assert.ok(overlay.contains(tab), 'the tab is inside the existing Hub overlay');
    assert.ok(doc.getElementById('badgeMcpDispatch'), '#badgeMcpDispatch exists');
    assert.ok(!doc.getElementById('mcpDispatchOverlay'), 'no second overlay was built');
    // Structural position: the new button is the last child of the strip, i.e. it
    // landed after #tabNavRegressions and before the strip's closing </div>.
    const stripButtons = Array.from(doc.querySelector('.hub-nav-strip')!.querySelectorAll('button'));
    assert.equal(stripButtons[stripButtons.length - 1]?.id, 'tabNavMcpDispatch');
  });

  test('R2 — both arms wired: rows render, overview selected, detail pane filled', async (t) => {
    const ctx = await loadToolbar(measuredPayload());
    dom = ctx.dom;
    const doc = ctx.doc;
    await openMcpDispatchTab(ctx);

    const items = listItems(doc);
    assert.equal(items.length, 5, 'overview + 2 name rows + quarantine-margin + core.* hole');
    const list = doc.getElementById('hubItemsList')!;
    const listText = list.textContent ?? '';
    assert.ok(listText.includes('browser.switch-tab'), 'row 1 carries its recorded name');
    assert.ok(listText.includes('787'), 'row 1 carries its call count');
    assert.ok(listText.includes('anti.browser.evaluate'), 'row 2 carries its recorded name');
    assert.ok(listText.includes('9040'), 'row 2 carries its call count');

    // The reconciliation row prints the two GENERAL forms verbatim.
    assert.ok(doc.getElementById('mcpDispatchReconciliation'), '#mcpDispatchReconciliation rendered');
    const reconcileText = textOf(doc, 'mcpDispatchReconciliation');
    assert.ok(reconcileText.includes('classifiedKeys + unattributedKeys == compositeKeys'), 'key-level general form');
    assert.ok(reconcileText.includes('frames == compositeKeys + superseded + keylessFrames'), 'frame-level general form');

    // The setHubTab arm: without it the detail pane is blanked by showCoreDetailEmpty().
    assert.equal(doc.getElementById('hubCoreDetail')?.style.display, 'flex', 'detail pane shown');
    assert.equal(doc.getElementById('coreDetailCategory')?.textContent, 'RECONCILIATION');
    assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'MEASURED');
    assert.ok((doc.getElementById('coreDetailCode')?.textContent ?? '').includes('frames == compositeKeys + superseded + keylessFrames'));
    assert.equal(doc.getElementById('badgeMcpDispatch')?.textContent, '2', 'badge counts rendered rows');
  });

  test('R3 — margin label, truncation label and the Phase-1 covered window render', async (t) => {

    const plain = await loadToolbar(measuredPayload());
    dom = plain.dom;
    await openMcpDispatchTab(plain);
    assert.equal(textOf(plain.doc, 'mcpDispatchQuarantineMargin'), MARGIN_LABEL, 'margin label printed verbatim');
    assert.equal(plain.doc.getElementById('mcpDispatchTruncation'), null, 'no truncation row when totals.truncation is null');
    plain.dom.window.close();

    const truncated = await loadToolbar(truncatedPayload());
    dom = truncated.dom;
    const doc = truncated.doc;
    await openMcpDispatchTab(truncated);
    assert.equal(textOf(doc, 'mcpDispatchTruncation'), 'partial: 5 of 6 files', 'truncation label from filesRead/filesSkipped');
    assert.equal(textOf(doc, 'mcpDispatchQuarantineMargin'), MARGIN_LABEL, 'the margin is still disclosed beside it');
    assert.equal(listItems(doc).length, 6, 'overview + 2 name rows + margin + truncation + core.* hole');

    const nameRows = listItems(doc).filter((el) => (el.textContent ?? '').includes('calls '));
    assert.equal(nameRows.length, 2, 'two per-name rows');
    for (const row of nameRows) {
      const text = row.textContent ?? '';
      assert.ok(text.includes('lowerBound'), 'the floor marker is visible on a truncated row');
      assert.ok(text.includes('≥'), 'the count is drawn as a floor, not as an exact count');
    }

    // The covered window comes from census.limits (Phase 1), not from census.files.
    (doc.getElementById('mcpDispatchTruncation') as HTMLElement).click();
    await flush();
    const body = doc.getElementById('coreDetailCode')?.textContent ?? '';
    assert.ok(body.includes(String(WINDOW_NEWEST_MS)), 'covered window newest bound from census.limits');
    assert.ok(body.includes(String(WINDOW_OLDEST_MS)), 'covered window oldest bound from census.limits');
    assert.ok(!body.includes(String(CENSUS_FILE_MTIME_MS)), 'the window is never re-derived from census.files');
    assert.ok(body.includes('mtimeMs-desc,name-asc'), 'the selection order is part of the disclosure');
  });

  test('R4 — UNMEASURED with no rows: one notice, zero .hub-list-item, never a 0', async (t) => {
    const ctx = await loadToolbar(unmeasuredPayload(STORE_LABEL, 'READ_BUDGET_EXCEEDED', ['budget-expired', STORE_LABEL]));
    dom = ctx.dom;
    const doc = ctx.doc;
    await openMcpDispatchTab(ctx);

    assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'UNMEASURED', 'pill says UNMEASURED');
    assert.equal(listItems(doc).length, 0, 'no rows rendered');
    assert.equal(doc.getElementById('mcpDispatchReconciliation'), null, 'no reconciliation row without a reconciliation');
    const notice = doc.getElementById('mcpDispatchNotice');
    assert.ok(notice, 'a single non-metric notice block');
    const noticeText = notice.textContent ?? '';
    assert.ok(noticeText.includes('READ_BUDGET_EXCEEDED'), 'reasonCode named');
    assert.ok(noticeText.includes(STORE_LABEL), 'storePath display label named');
    assert.ok(noticeText.includes('budget-expired'), 'affected mechanism named');
  });

  test('R4b — storePath === null renders the reasonCode copy, never "null" and never a path', async (t) => {
    const ctx = await loadToolbar(unmeasuredPayload(null, 'NO_DATA_ROOT_RESOLVED', ['no-data-root-resolved']));
    dom = ctx.dom;
    const doc = ctx.doc;
    await openMcpDispatchTab(ctx);

    const noticeText = doc.getElementById('mcpDispatchNotice')?.textContent ?? '';
    assert.ok(noticeText.includes('NO_DATA_ROOT_RESOLVED'), 'the unresolved case names its reason');
    assert.ok(!/\bnull\b/.test(noticeText), 'the text "null" is never rendered');
    assert.ok(!noticeText.includes('/') && !noticeText.includes('\\'), 'no invented path');
    assert.ok(!/0/.test(noticeText), 'no 0 where the truth is unknown');
  });

  test('R4c — UNMEASURED with a non-null census discloses the read facts it holds', async (t) => {
    const ctx = await loadToolbar(unmeasuredWithCensusPayload());
    dom = ctx.dom;
    const doc = ctx.doc;
    await openMcpDispatchTab(ctx);

    assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'UNMEASURED', 'pill stays UNMEASURED');
    assert.equal(listItems(doc).length, 0, 'still zero rows');
    assert.equal(doc.getElementById('mcpDispatchReconciliation'), null, 'no reconciliation without one');
    const notice = doc.getElementById('mcpDispatchNotice');
    assert.ok(notice, 'the notice block is still the only list content');
    const noticeText = notice.textContent ?? '';
    assert.ok(noticeText.includes('NO_DATA'), 'reasonCode still named');
    assert.ok(noticeText.includes('invocations'), 'storePath display label still named');
    // The read facts, read verbatim from census.limits: a degenerate ceiling with
    // filesRead === 0 must not look like "nothing was read at all".
    assert.ok(noticeText.includes('census.limits.observedFiles: 12'), 'observedFiles rendered');
    assert.ok(noticeText.includes('census.limits.filesRead: 0'), 'filesRead rendered (the degenerate-ceiling fact)');
    assert.ok(noticeText.includes('census.limits.outcome: CENSUS_DRIFT'), 'limits.outcome rendered');
    assert.ok(noticeText.includes('census.limits.ceiling: MAX_CENSUS_BYTES'), 'non-null limits.ceiling rendered');
    // Only digits the payload itself contains may appear: 12 and 0, nothing else.
    const digitRuns = [...new Set((noticeText.match(/\d+/g) ?? []))].sort();
    assert.deepEqual(digitRuns, ['0', '12'], 'no digit appears that the payload does not contain');
    // The auto-selected detail pane mirrors the same helper, so it cannot contradict
    // the notice beside it.
    const detail = doc.getElementById('coreDetailCode')?.textContent ?? '';
    assert.ok(detail.includes('censusReadFacts'), 'detail body carries the same read facts');
    assert.ok(detail.includes('CENSUS_DRIFT'));
  });

  test('R4d — UNMEASURED with census: null is unchanged: reasonCode copy only', async (t) => {
    const ctx = await loadToolbar(unmeasuredPayload(STORE_LABEL, 'READ_BUDGET_EXCEEDED', ['budget-expired', STORE_LABEL]));
    dom = ctx.dom;
    const doc = ctx.doc;
    await openMcpDispatchTab(ctx);

    const notice = doc.getElementById('mcpDispatchNotice');
    assert.ok(notice, 'notice rendered');
    // Byte-identical to the pre-change notice shape: status, reasonCode · store label,
    // affected — and nothing about a census that does not exist.
    assert.equal(
      notice.textContent,
      `UNMEASURED\nREAD_BUDGET_EXCEEDED · ${STORE_LABEL}\naffected: budget-expired · ${STORE_LABEL}`,
      'census === null keeps the reasonCode-only copy',
    );
    assert.ok(!(notice.textContent ?? '').includes('census.limits.'), 'no read facts without a census');
    assert.ok(!(notice.textContent ?? '').includes('read:'), 'no read line without a census');
    assert.equal(listItems(doc).length, 0);
  });

  test('R4e — escaping covers the census-derived read facts', async (t) => {
    const hostileOutcome = '<img src=x onerror="window.__pwned=1">';
    const ctx = await loadToolbar(unmeasuredWithCensusPayload({ ceiling: '<script>x</script>' }, hostileOutcome));
    dom = ctx.dom;
    const doc = ctx.doc;
    const win = ctx.win;
    await openMcpDispatchTab(ctx);

    const notice = doc.getElementById('mcpDispatchNotice');
    assert.ok(notice, 'notice rendered');
    assert.equal(notice.querySelectorAll('*').length, 0, 'the notice has no injected child element');
    assert.equal(doc.querySelectorAll('#hubItemsList img, #hubItemsList script').length, 0, 'no injected element');
    assert.equal(win.__pwned, undefined, 'no inline handler ran');
    for (const el of Array.from(doc.querySelectorAll('#hubItemsList *'))) {
      for (const name of Array.from(el.getAttributeNames())) {
        assert.ok(!/^on/i.test(name), `no event-handler attribute (${name})`);
        assert.notEqual(name, 'src', 'no src attribute');
      }
    }
    assert.ok(!(notice.innerHTML).includes('<img'), 'the hostile outcome is not parsed as an element');
    assert.ok(!(notice.innerHTML).includes('<script'), 'the hostile ceiling is not parsed as an element');
    const noticeText = notice.textContent ?? '';
    assert.ok(noticeText.includes(hostileOutcome), 'the hostile outcome is rendered as text');
    assert.ok(noticeText.includes('<script>x</script>'), 'the hostile ceiling is rendered as text');
    assert.equal(listItems(doc).length, 0);
  });

  test('R4f — a non-numeric census count is never rendered as a number', async (t) => {
    // A hostile or malformed count is not a count: the read-fact line must not fall
    // back to a fabricated figure, it simply carries no count field.
    const ctx = await loadToolbar(unmeasuredWithCensusPayload({ observedFiles: '<b>99</b>', filesRead: null }));
    dom = ctx.dom;
    const doc = ctx.doc;
    await openMcpDispatchTab(ctx);

    const noticeText = doc.getElementById('mcpDispatchNotice')?.textContent ?? '';
    assert.ok(!noticeText.includes('99'), 'a non-numeric observedFiles is not rendered as a number');
    assert.ok(!noticeText.includes('census.limits.observedFiles'), 'no count fact is invented');
    assert.ok(!noticeText.includes('census.limits.filesRead'), 'a null filesRead renders nothing');
    assert.ok(noticeText.includes('census.limits.outcome: CENSUS_DRIFT'), 'the outcome fact still renders');
    assert.ok(noticeText.includes('census.limits.ceiling: MAX_CENSUS_BYTES'), 'the ceiling fact still renders');
    assert.equal(doc.querySelectorAll('#hubItemsList img, #hubItemsList script').length, 0);
  });

  test('R4g — the real store label renders verbatim and carries no path separator', async (t) => {
    const ctx = await loadToolbar(unmeasuredPayload('invocations', 'READ_BUDGET_EXCEEDED', ['budget-expired', 'invocations']));
    dom = ctx.dom;
    const doc = ctx.doc;
    await openMcpDispatchTab(ctx);

    const notice = doc.getElementById('mcpDispatchNotice');
    assert.ok(notice, 'notice rendered');
    const noticeText = notice.textContent ?? '';
    assert.ok(noticeText.includes('invocations'), 'the label the service derives (final path segment) renders');
    // Phase 1's hard rule, now guarded from the renderer lane: no separator and no
    // drive-letter prefix in anything this surface shows.
    assert.ok(!noticeText.includes('/') && !noticeText.includes('\\'), 'no path separator in the notice');
    assert.ok(!/[A-Za-z]:[\\/]/.test(noticeText), 'no drive-letter prefix in the notice');
    const detail = doc.getElementById('coreDetailCode')?.textContent ?? '';
    assert.ok(detail.includes('"storeLabel": "invocations"'), 'the notice detail body carries the same label');
    assert.ok(!detail.includes('/') && !detail.includes('\\'), 'no path separator in the notice detail');
    assert.ok(!/[A-Za-z]:[\\/]/.test(detail), 'no drive-letter prefix in the notice detail');

    // The MEASURED surface publishes the same label on its overview detail.
    ctx.dom.window.close();
    const measured = await loadToolbar(measuredPayload());
    dom = measured.dom;
    await openMcpDispatchTab(measured);
    const measuredDetail = measured.doc.getElementById('coreDetailCode')?.textContent ?? '';
    assert.ok(measuredDetail.includes('"storeLabel": "invocations"'), 'the measured overview publishes the same label');
    assert.ok(!measuredDetail.includes('/') && !measuredDetail.includes('\\'), 'no path separator in the measured detail');
    assert.ok(!/[A-Za-z]:[\\/]/.test(measuredDetail), 'no drive-letter prefix in the measured detail');
  });

  test('R4h — an odd-but-legal label renders verbatim: the label is never pattern-matched', async (t) => {
    // Legal under Phase 1's rule (no separator, no drive letter) yet nothing like the
    // canonical 'invocations': 206 characters with spaces. Whatever the service hands
    // over is what the surface shows, whole.
    const oddLabel = 'invocations archive segment ' + 'x'.repeat(180);
    const payload = unmeasuredWithCensusPayload();
    payload.storePath = oddLabel;
    const ctx = await loadToolbar(payload);
    dom = ctx.dom;
    const doc = ctx.doc;
    await openMcpDispatchTab(ctx);

    const noticeText = doc.getElementById('mcpDispatchNotice')?.textContent ?? '';
    assert.ok(noticeText.includes(oddLabel), 'the odd-but-legal label renders verbatim, untruncated');
    assert.ok(!noticeText.includes('/') && !noticeText.includes('\\'), 'the odd label still carries no separator');
    assert.ok(noticeText.includes('census.limits.outcome: CENSUS_DRIFT'), 'the read facts still render beside it');
    const detail = doc.getElementById('coreDetailCode')?.textContent ?? '';
    assert.ok(detail.includes(oddLabel), 'the detail body renders the same label verbatim');
    assert.equal(listItems(doc).length, 0);
  });

  test('R5 — the detail pane shows the per-name latency pair and error histogram', async (t) => {
    const ctx = await loadToolbar(measuredPayload());
    dom = ctx.dom;
    const doc = ctx.doc;
    await openMcpDispatchTab(ctx);

    const nameRow = listItems(doc).find((el) => (el.textContent ?? '').includes('browser.switch-tab'));
    assert.ok(nameRow, 'the seeded name row is present');
    (nameRow as HTMLElement).click();
    await flush();

    assert.equal(doc.getElementById('coreDetailCategory')?.textContent, 'DISPATCH NAME');
    assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'RETAINED');
    const body = doc.getElementById('coreDetailCode')?.textContent ?? '';
    assert.ok(body.includes('TARGET_STALE'), 'error.code histogram in the detail');
    assert.ok(body.includes('p50Ms'), 'latency pair in the detail');
    assert.ok(body.includes('13') && body.includes('3799'), 'p50/p95 values in the detail');
    assert.ok(body.includes('262957'), 'the excluded population publishes its own p50');
    assert.ok(body.includes('"lowerBound": false'), 'the floor flag is stated');
  });

  test('R6 — a rejected invoke degrades to UNMEASURED with zero unhandled rejections', async (t) => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      const ctx = await loadToolbar(null, 'reject');
      dom = ctx.dom;
      const doc = ctx.doc;
      await openMcpDispatchTab(ctx);
      await settle();
      assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'UNMEASURED', 'pill degrades to UNMEASURED');
      assert.ok((doc.getElementById('mcpDispatchNotice')?.textContent ?? '').includes('IPC_FAILED'), 'the renderer-local reason is named');
      assert.equal(listItems(doc).length, 0, 'no rows are invented');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    assert.equal(rejections.length, 0, 'no unhandled rejection escapes the renderer refresh');
  });

  test('R6b — an absent bridge method degrades to UNMEASURED + NO_DATA', async (t) => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      const ctx = await loadToolbar(null, 'absent');
      dom = ctx.dom;
      const doc = ctx.doc;
      await openMcpDispatchTab(ctx);
      await settle();
      assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'UNMEASURED');
      assert.ok((doc.getElementById('mcpDispatchNotice')?.textContent ?? '').includes('NO_DATA'), 'NO_DATA is rendered');
      assert.equal(doc.getElementById('badgeMcpDispatch')?.textContent, '–', 'the badge never claims 0');
      assert.equal(listItems(doc).length, 0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    assert.equal(rejections.length, 0, 'optional chaining is not the safety mechanism: the catch is');
  });

  test('R7 — the search box filters name rows only and hides no disclosure', async (t) => {
    const ctx = await loadToolbar(measuredPayload());
    dom = ctx.dom;
    const doc = ctx.doc;
    await openMcpDispatchTab(ctx);

    const input = doc.getElementById('hubSearchInput') as HTMLInputElement;
    assert.ok(input, '#hubSearchInput exists');
    input.value = 'switch';
    input.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    await flush();

    const nameRows = listItems(doc).filter((el) => (el.textContent ?? '').includes('calls '));
    assert.equal(nameRows.length, 1, 'only the matching name row survives');
    assert.ok((nameRows[0]?.textContent ?? '').includes('browser.switch-tab'));
    assert.ok(doc.getElementById('mcpDispatchReconciliation'), 'the overview disclosure is not hidden');
    assert.ok(doc.getElementById('mcpDispatchQuarantineMargin'), 'the margin disclosure is not hidden');
    assert.ok(doc.getElementById('mcpDispatchCoreHole'), 'the core.* hole is not hidden');
  });

  test('R7b — a search that matches nothing still renders the UNMEASURED notice', async (t) => {
    const ctx = await loadToolbar(unmeasuredPayload(STORE_LABEL, 'READ_BUDGET_EXCEEDED', ['budget-expired']));
    dom = ctx.dom;
    const doc = ctx.doc;
    await openMcpDispatchTab(ctx);

    const input = doc.getElementById('hubSearchInput') as HTMLInputElement;
    input.value = 'zzz-no-such-name';
    input.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    await flush();

    assert.ok(doc.getElementById('mcpDispatchNotice'), 'the UNMEASURED notice is not hideable by the search box');
    assert.equal(listItems(doc).length, 0);
    assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'UNMEASURED');
  });

  test('the dispatch refresh never leaves its rows on another active tab', async (t) => {
    const ctx = await loadToolbar(measuredPayload());
    dom = ctx.dom;
    const doc = ctx.doc;
    // openWorkflowHub awaits refreshMcpDispatchState() BEFORE renderHubList(), so the
    // active tab's own rows win even though the dispatch payload was fetched first.
    (doc.getElementById('btnWorkflowHub') as HTMLElement).click();
    await flush();
    assert.equal(doc.getElementById('tabNavWorkflows')?.className.includes('active'), true, 'workflows is still the active tab');
    assert.ok(!(doc.getElementById('hubItemsList')?.textContent ?? '').includes('browser.switch-tab'), 'no dispatch row on the workflows tab');
    assert.equal(doc.getElementById('mcpDispatchReconciliation'), null);
  });

  test('R8 — markup seeded into name/errors creates no element and no attribute', async (t) => {
    const ctx = await loadToolbar(markupPayload());
    dom = ctx.dom;
    const doc = ctx.doc;
    const win = ctx.win;
    await openMcpDispatchTab(ctx);

    const list = doc.getElementById('hubItemsList')!;
    assert.equal(doc.querySelectorAll('#hubItemsList img, #hubItemsList script').length, 0, 'no injected element');
    assert.equal(win.__pwned, undefined, 'no inline handler ran');
    for (const el of Array.from(doc.querySelectorAll('#hubItemsList *'))) {
      for (const name of Array.from(el.getAttributeNames())) {
        assert.ok(!/^on/i.test(name), `no event-handler attribute (${name})`);
        assert.notEqual(name, 'src', 'no src attribute');
      }
    }
    const html = list.innerHTML;
    assert.ok(!html.includes('<img'), 'the markup is not parsed as an element');
    assert.ok(!html.includes('<script'), 'the script tag is not parsed as an element');
    assert.equal(listItems(doc).length, 5, 'the seeded markup does not change the row count');
    assert.ok((list.textContent ?? '').includes('<script>x</script>'), 'the histogram key is present as text');
  });

  test('R9 — rows survive a close/re-open of the Hub and a row is still selected', async (t) => {
    const ctx = await loadToolbar(measuredPayload());
    dom = ctx.dom;
    const doc = ctx.doc;
    await openMcpDispatchTab(ctx);

    (doc.getElementById('btnWorkflowHubClose') as HTMLElement).click();
    await flush();
    (doc.getElementById('btnWorkflowHub') as HTMLElement).click();
    await flush();

    assert.equal(listItems(doc).length, 5, 'rows are still rendered after reopen');
    const selected = doc.querySelectorAll('#hubItemsList .hub-list-item.selected');
    assert.equal(selected.length, 1, 'exactly one row is re-selected by openWorkflowHub');
    assert.equal(doc.getElementById('mcpDispatchReconciliation')?.className.includes('selected'), true);
    assert.equal(doc.getElementById('coreStatusPill')?.textContent, 'MEASURED');
  });

  test('structural — the tab is deliberately absent from HUB_CORE_TABS', async (t) => {
    assert.ok(fs.existsSync(SOURCE_TOOLBAR_TS), `source toolbar.ts must exist at ${SOURCE_TOOLBAR_TS}`);
    const source = fs.readFileSync(SOURCE_TOOLBAR_TS, 'utf8');
    const coreTabs = /const HUB_CORE_TABS: HubTab\[\] = \[([^\]]*)\]/.exec(source);
    assert.ok(coreTabs, 'HUB_CORE_TABS declaration found');
    assert.ok(!coreTabs[1]!.includes('mcp-dispatch'), 'mcp-dispatch must NOT be routed through HUB_CORE_TABS (coreListItems() would blank it)');
    const navButtons = /const HUB_NAV_BUTTONS: Record<HubTab, HTMLButtonElement \| null> = \{([\s\S]*?)\};/.exec(source);
    assert.ok(navButtons, 'HUB_NAV_BUTTONS declaration found');
    assert.ok(navButtons[1]!.includes("'mcp-dispatch': tabNavMcpDispatch"), 'HUB_NAV_BUTTONS must carry the new key');
  });
});

// ---------------------------------------------------------------------------
// The provenance disclosure: what this panel does and does not measure.
//
// The request behind this plan was to see how effective each MCP is. What the
// panel can actually observe is what the ledger recorded, which is a PROXY for
// effectiveness rather than a measurement of it, because agent-side fallback and
// escape live in another plan's gaps.jsonl and are deliberately never joined.
// Nothing on the surface said so, which let a reader take the counts for an
// effectiveness score. The sentence that fixes that is static markup, and these
// tests hold it static: the literal is pinned, and the same text must come out
// for a measured payload, an unmeasured payload, and no payload at all.
// ---------------------------------------------------------------------------
const PROVENANCE_TEXT = 'Nguồn số liệu: các dispatch đã được ghi vào invocation ledger — đây là chỉ báo thay thế (proxy) cho mức độ hiệu quả, không phải phép đo hiệu quả. Fallback phía agent (gaps.jsonl, thuộc plan khác) không được join vào bảng này.';

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

describe('MCP Dispatch provenance disclosure (the framing of the honest hole)', () => {
  test('R10 — the line renders beside the rows and is declared exactly once, in markup', async (t) => {
    const ctx = await loadToolbar(measuredPayload());
    await openMcpDispatchTab(ctx);
    const el = ctx.doc.getElementById('mcpDispatchProvenance');
    assert.ok(el, '#mcpDispatchProvenance must exist in the Hub markup');
    assert.equal(normalizeText(el!.textContent), PROVENANCE_TEXT, 'the line renders verbatim');
    // It belongs where the counts are read, not buried in the detail pane.
    assert.ok(ctx.doc.getElementById('hubListPane')!.contains(el), 'the line sits in the list pane beside the rows');
    // It is MARKUP: one declaration, in the HTML, not assembled by the renderer.
    const html = fs.readFileSync(path.join(RENDERER_DIR, 'toolbar.html'), 'utf8');
    assert.equal(html.split('id="mcpDispatchProvenance"').length - 1, 1, 'declared exactly once in toolbar.html');
    assert.ok(html.includes('chỉ báo thay thế (proxy)'), 'the proxy wording lives in the markup');
    const rendererSource = fs.readFileSync(SOURCE_TOOLBAR_TS, 'utf8');
    assert.ok(!rendererSource.includes('chỉ báo thay thế (proxy)'), 'the sentence is NOT built in toolbar.ts');
  });

  test('R10b — the text is identical for a measured payload, an unmeasured one and none at all', async (t) => {
    const measured = await loadToolbar(measuredPayload());
    await openMcpDispatchTab(measured);
    const withRows = normalizeText(measured.doc.getElementById('mcpDispatchProvenance')?.textContent);
    // An UNMEASURED store is exactly the state in which a reader is most tempted to
    // read the panel as an effectiveness score, so the qualifier must not disappear.
    const nothing = await loadToolbar(unmeasuredPayload(null, 'NO_DATA_ROOT_RESOLVED', []));
    await openMcpDispatchTab(nothing);
    const withoutRows = normalizeText(nothing.doc.getElementById('mcpDispatchProvenance')?.textContent);
    // A bridge that never answers leaves the tab with no payload object at all.
    const absent = await loadToolbar(undefined, 'absent');
    await openMcpDispatchTab(absent);
    const withNoPayload = normalizeText(absent.doc.getElementById('mcpDispatchProvenance')?.textContent);
    measured.dom.window.close();
    nothing.dom.window.close();
    absent.dom.window.close();
    assert.equal(withRows, PROVENANCE_TEXT);
    assert.equal(withoutRows, withRows, 'a measured→unmeasured change must not alter the sentence');
    assert.equal(withNoPayload, withRows, 'a missing payload must not alter the sentence');
  });

  test('R10c — the line follows the tab: shown on mcp-dispatch, hidden on every other tab', async (t) => {
    const ctx = await loadToolbar(measuredPayload());
    const doc = ctx.doc;
    const el = doc.getElementById('mcpDispatchProvenance') as HTMLElement;
    (doc.getElementById('btnWorkflowHub') as HTMLElement).click();
    await flush();
    assert.notEqual(el.style.display, 'block', 'hidden on the tab the Hub opens with');
    (doc.getElementById('tabNavMcpDispatch') as HTMLElement).click();
    await flush();
    assert.equal(el.style.display, 'block', 'shown with the counts it qualifies');
    (doc.getElementById('tabNavMcp') as HTMLElement).click();
    await flush();
    assert.notEqual(el.style.display, 'block', 'hidden again when another tab takes over');
    ctx.dom.window.close();
  });
});
