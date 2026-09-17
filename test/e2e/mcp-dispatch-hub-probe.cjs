/**
 * AntiFan Toolbar — "Thống kê MCP (Dispatch)" live-renderer probe.
 *
 * What this asserts, and why it needs a real Electron renderer:
 *   The MCP-dispatch tab of the Workflow Hub had only ever been exercised under jsdom. jsdom does
 *   not give a DOM with a real HTML parser behind `innerHTML`, a real `escapeHtml` consumer, real
 *   `document.getElementById` id lookup, or a real `contextBridge` preload. This probe boots the
 *   *compiled production renderer* in a real `BrowserWindow` with the *production preload*, drives
 *   the tab through real DOM clicks, and reads the values that actually landed in the live DOM.
 *
 * Payload-delivery route (stated because it bounds what this proves):
 *   - Real: compiled `toolbar.html` + `toolbar.js`, real `toolbar-preload.js` (contextBridge →
 *     `window.antifanToolbar.getMcpDispatchState()`), real channel name
 *     `antifan:mcp-dispatch:get-state`, real structured-clone IPC boundary.
 *   - Seeded: the main-process side of that channel. The production handler lives inside
 *     `NativeTabHost` (`src/main/browser/native-tab-host.ts:2265`) and needs the whole app graph
 *     (capsule manager, session vault, data-root resolution) to be constructed; it is also gated by
 *     `isTrustedSessionVaultSender`. Standing that graph up is out of scope for an e2e probe, so the
 *     probe registers its own `ipcMain.handle` on the *same channel name* and returns a seeded
 *     envelope.
 *   - Where possible the seed is passed through the **real** Phase-4 projection
 *     (`projectEnvelope` from `.compiled/src/main/diagnostics/mcp-dispatch-service.js`) before it
 *     crosses the boundary, so the renderer receives a genuinely contract-shaped payload and the
 *     probe can report what the real boundary does to hostile input. If that module cannot be
 *     required, the raw seed is delivered and the route is recorded as degraded.
 *
 * This probe observes only. It never writes to `src/` and never repairs the renderer.
 *
 * Usage: node scripts/run-electron.cjs test/e2e/mcp-dispatch-hub-probe.cjs
 */

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// ---------------------------------------------------------------------------------------------
// Paths and constants
// ---------------------------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../..');
const COMPILED = path.join(ROOT, '.compiled');
const HTML_PATH = path.join(COMPILED, 'src/renderer/toolbar.html');
const RENDERER_JS_PATH = path.join(COMPILED, 'src/renderer/toolbar.js');
const RENDERER_SHIM_PATH = path.join(COMPILED, 'src/renderer/exports-shim.js');
const PRELOAD_PATH = path.join(COMPILED, 'src/preload/toolbar-preload.js');
const SERVICE_PATH = path.join(COMPILED, 'src/main/diagnostics/mcp-dispatch-service.js');
const REPORTS_DIR = path.join(ROOT, 'plans/260917-0341-mcp-dispatch-accounting/reports');
const REPORT_JSON_PATH = path.join(REPORTS_DIR, 'mcp-dispatch-hub-probe.json');

const HUB_BUTTON_ID = 'btnWorkflowHub';
const HUB_OVERLAY_ID = 'workflowHubOverlay';
const NAV_BUTTON_ID = 'tabNavMcpDispatch';
const LIST_ID = 'hubItemsList';
const DISPATCH_CHANNEL = 'antifan:mcp-dispatch:get-state';
const STORE_LABEL = 'invocations';

/** Marker 1: survives the real projection (no '/', no '\', not location-shaped) as a name/key. */
const MARKUP = '<img src=x onerror=alert(1)>';
/** Marker 2: drive-absolute path — the projection rewrites it to UNRECOGNIZED when it is a KEY. */
const WINDOWS_PATH = 'C:\\Users\\Admin\\secrets';
/** Marker 3: contains '/' (in `</script>`), so the projection treats it as location-shaped. */
const SCRIPT_MARKUP = '<script>alert(2)</script>';
const MARKERS = [MARKUP, WINDOWS_PATH, SCRIPT_MARKUP];
/**
 * Scanner self-test sentinel: proves the element/attribute scanner can actually detect a hit.
 * All-lowercase and separator-free because it must be legal as an attribute *name* too (`<`
 * `>` and spaces are not), and the HTML parser lowercases attribute names.
 */
const SELFTEST_MARKER = 'probe-selftest-token';
/**
 * Baseline document facts, captured before any payload renders. The toolbar template itself carries
 * one `<img class="tab-icon" src="" alt=""/>` per rendered tab (`src/renderer/toolbar.ts:1669`) and
 * the two `<script src>` tags, so an absolute-zero element count would be a false expectation; the
 * payload's effect is asserted as a delta against this baseline plus a list-scoped zero.
 */
const DOCUMENT_BASELINE_NOTE = 'toolbar.ts:1669 renders <img class="tab-icon"> for the boot tab; exports-shim.js + toolbar.js are the two scripts';

const SCENARIOS = {
  'A-measured-truncated': {
    expectation: 'MEASURED + ceiling-tripped rows, invariants, margin, partial notice',
    mode: 'projected',
    sentinel: 'calls 7',
  },
  'B-unmeasured-no-census': {
    expectation: 'UNMEASURED notice with reasonCode, no fabricated 0',
    mode: 'projected',
    sentinel: 'NO_DATA_ROOT_RESOLVED',
  },
  'C-unmeasured-with-census': {
    expectation: 'UNMEASURED + reasonCode + read facts (payload-sourced 0 only)',
    mode: 'projected',
    sentinel: 'CENSUS_DRIFT',
  },
  'D1-hostile-projected': {
    expectation: 'hostile seed through the real projection: markup survives, paths do not',
    mode: 'projected',
    sentinel: 'UNRECOGNIZED',
  },
  'D2-hostile-raw': {
    expectation: 'hostile seed delivered unprojected: escaped, never parsed',
    mode: 'raw',
    sentinel: 'secrets',
  },
};

// ---------------------------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------------------------

const telemetry = {
  probe: 'test/e2e/mcp-dispatch-hub-probe.cjs',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  electron: process.versions.electron,
  node: process.versions.node,
  cwd: process.cwd(),
  artifacts: {},
  route: {
    renderer: 'real compiled toolbar.html + toolbar.js via BrowserWindow.loadFile',
    preload: 'real compiled toolbar-preload.js (contextBridge -> window.antifanToolbar)',
    ipcChannel: DISPATCH_CHANNEL,
    mainProcessHandler:
      'probe-registered ipcMain.handle on the production channel name; the production handler '
      + '(native-tab-host.ts:2265) lives inside NativeTabHost and requires the full app graph',
    payloadDelivery: null,
    navButtonId: NAV_BUTTON_ID,
    hubButtonId: HUB_BUTTON_ID,
    listElementId: LIST_ID,
  },
  projection: { available: false, module: SERVICE_PATH, error: null, storeLabel: STORE_LABEL },
  boot: null,
  scannerSelfTest: null,
  scenarios: {},
  payloads: {},
  ipcCalls: [],
  rendererLogs: [],
  consoleErrors: [],
  assertions: [],
  findings: [],
  summary: null,
};

let assertionCount = 0;
let failedCount = 0;

function assert(name, condition, expected, observed) {
  const verdict = condition ? 'PASS' : 'FAIL';
  if (!condition) failedCount += 1;
  assertionCount += 1;
  telemetry.assertions.push({ id: name, verdict, expected, observed });
  console.log(`[${verdict}] ${name}`);
  console.log(`        expected: ${compact(expected)}`);
  console.log(`        observed: ${compact(observed)}`);
  return !!condition;
}

function warn(name, observed) {
  telemetry.findings.push({ id: name, severity: 'WARN', observed });
  console.log(`[WARN] ${name}: ${compact(observed)}`);
}

function compact(value) {
  let text;
  if (typeof value === 'string') text = value;
  else text = JSON.stringify(value);
  if (text === undefined) text = String(value);
  return text.length > 900 ? `${text.slice(0, 900)}…[truncated ${text.length} chars]` : text;
}

function sha256File(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return {
      path: path.relative(ROOT, filePath),
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
      mtimeMs: fs.statSync(filePath).mtimeMs,
    };
  } catch (err) {
    return { path: path.relative(ROOT, filePath), error: String(err && err.message ? err.message : err) };
  }
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The document census captured before any payload rendered (see DOCUMENT_BASELINE_NOTE). */
function baselineCensus() {
  return (telemetry.boot && telemetry.boot.baselineCensus) || { img: null, script: null, elementsWithOnAttributes: null, imgWithOnerror: null, canary: null };
}

// ---------------------------------------------------------------------------------------------
// Seeded payloads (contract-shaped; see src/shared/mcp-dispatch-contracts.ts:441-597)
// ---------------------------------------------------------------------------------------------

const SEED_MEASURED = {
  status: 'MEASURED',
  reasonCode: 'OK',
  affected: [],
  evidenceRefs: ['census:1a2b3c4d#L12', 'census:deadbeef#L4', 'not-an-evidence-ref'],
  asOf: '2026-09-17T03:41:00.000Z',
  storePath: 'C:\\Users\\Admin\\AppData\\Roaming\\AntiFan\\control-plane\\invocations',
  census: {
    asOf: '2026-09-17T03:41:00.000Z',
    files: [],
    fileCount: 12,
    jsonlCount: 11,
    quarantineCount: 1,
    tempCount: 0,
    otherCount: 0,
    totalBytes: 40960,
    censusHash: 'a1b2c3d4e5f60718',
    limits: {
      budgetMs: 5000,
      maxBytes: 8388608,
      maxFiles: 3,
      observedBytes: 40960,
      observedFiles: 12,
      filesRead: 3,
      filesSkipped: 9,
      ceiling: 'MAX_CENSUS_FILES',
      windowNewestMtimeMs: 1758080460000,
      windowOldestMtimeMs: 1757994060000,
      elapsedMs: 41,
      outcome: 'POPULATION_TRUNCATED',
    },
  },
  fileRollups: [
    { file: '2026-09-16.jsonl', quarantineLike: false, tempLike: false, frames: 4, admitted: 4, namedInvalid: 0 },
    { file: '2026-09-17.jsonl', quarantineLike: true, tempLike: false, frames: 6, admitted: 5, namedInvalid: 1 },
  ],
  rows: [
    {
      name: 'antifan_navigate_3f6a73181cb6',
      calls: 7,
      frames: 7,
      superseded: 1,
      states: { completed: 5, failed: 1, superseded: 1 },
      errors: { E_TIMEOUT: 1 },
      latency: { count: 5, p50Ms: 12, p95Ms: 88 },
      excludedLatency: { count: 0 },
      firstSeen: '2026-09-16T01:00:00.000Z',
      lastSeen: '2026-09-17T03:40:00.000Z',
      lowerBound: true,
    },
    {
      name: 'antifan_screenshot_viewport_3d98bcf74af0',
      calls: 4,
      frames: 4,
      superseded: 0,
      states: { completed: 4 },
      errors: {},
      latency: { count: 4, p50Ms: 210, p95Ms: 640 },
      excludedLatency: { count: 0 },
      firstSeen: '2026-09-16T02:00:00.000Z',
      lastSeen: '2026-09-17T02:00:00.000Z',
      lowerBound: false,
    },
  ],
  totals: {
    residue: {
      ADMITTED: 9,
      STRUCTURAL_INVALID: 0,
      CHECKSUM_MISMATCH: 0,
      TORN_TAIL: 0,
      UNPARSEABLE: 0,
      RESIDUE_NO_CHECKSUM: 0,
      POST_CENSUS_APPEND: 1,
      POST_CENSUS_TRUNCATE: 0,
      VANISHED: 0,
    },
    quarantineMargin: {
      label: 'Chuẩn cách ly: 0 frame bị loại — 6 trên 6 frame đủ điều kiện',
      files: 1,
      framesPresent: 6,
      framesAdmitted: 5,
      framesNamedInvalid: 1,
      reasons: [],
    },
    retention: {
      firstSeen: '2026-09-16T01:00:00.000Z',
      lastSeen: '2026-09-17T03:40:00.000Z',
      note: 'a name absent from this store means no frame is retained, not that the tool was never called',
    },
    excludedLatency: { count: 0, p50Ms: null, p95Ms: null },
    unattributedByReason: { MISSING_IDENTITY_FIELD: 0, MISSING_ROW_KEY: 0 },
    truncation: {
      ceiling: 'MAX_CENSUS_FILES',
      filesRead: 3,
      filesSkipped: 9,
      order: 'mtimeMs-desc,name-asc',
      label: 'partial: 3 of 12 files',
    },
  },
  reconciliation: {
    classifiedKeys: 7,
    unattributedKeys: 0,
    unattributedFrames: 0,
    unattributedByReason: { MISSING_IDENTITY_FIELD: 0, MISSING_ROW_KEY: 0 },
    keylessFrames: 4,
    compositeKeys: 7,
    frames: 12,
    superseded: 1,
    holdsKeys: true,
    holdsFrames: true,
    holdsMargin: true,
    lines: [
      'classifiedKeys 7 + unattributedKeys 0 == compositeKeys 7',
      'frames 12 == compositeKeys 7 + superseded 1 + keylessFrames 4',
    ],
  },
};

const SEED_UNMEASURED_NO_CENSUS = {
  status: 'UNMEASURED',
  reasonCode: 'NO_DATA_ROOT_RESOLVED',
  affected: ['ipc-sender-not-trusted'],
  evidenceRefs: [],
  asOf: '2026-09-17T03:41:00.000Z',
  storePath: null,
  census: null,
  fileRollups: [],
  rows: [],
  totals: null,
  reconciliation: null,
};

const SEED_UNMEASURED_WITH_CENSUS = {
  status: 'UNMEASURED',
  reasonCode: 'CENSUS_DRIFT',
  affected: ['ipc-sender-not-trusted', 'C:\\Users\\Admin\\secrets'],
  evidenceRefs: ['census:0f0f0f0f#L9'],
  asOf: '2026-09-17T03:41:00.000Z',
  storePath: 'C:\\Users\\Admin\\AppData\\Roaming\\AntiFan\\control-plane\\invocations',
  census: {
    asOf: '2026-09-17T03:41:00.000Z',
    files: [],
    fileCount: 9,
    jsonlCount: 9,
    quarantineCount: 0,
    tempCount: 0,
    otherCount: 0,
    totalBytes: 0,
    censusHash: '0f0f0f0f0f0f0f0f',
    limits: {
      budgetMs: 5000,
      maxBytes: 1,
      maxFiles: 0,
      observedBytes: 81920,
      observedFiles: 9,
      filesRead: 0,
      filesSkipped: 9,
      ceiling: 'MAX_CENSUS_BYTES',
      windowNewestMtimeMs: null,
      windowOldestMtimeMs: null,
      elapsedMs: 12,
      outcome: 'POPULATION_TRUNCATED',
    },
  },
  fileRollups: [],
  rows: [],
  totals: null,
  reconciliation: null,
};

const SEED_HOSTILE = {
  status: 'MEASURED',
  reasonCode: 'OK',
  affected: [],
  evidenceRefs: [],
  asOf: '2026-09-17T03:41:00.000Z',
  storePath: 'C:\\Users\\Admin\\AppData\\Roaming\\AntiFan\\control-plane\\invocations',
  census: null,
  fileRollups: [],
  rows: [
    {
      name: MARKUP,
      calls: 3,
      frames: 3,
      superseded: 0,
      states: { HTML_STATE: 3 },
      errors: { [MARKUP]: 2, [WINDOWS_PATH]: 5 },
      latency: { count: 3, p50Ms: 7, p95Ms: 9 },
      excludedLatency: { count: 0 },
      firstSeen: '2026-09-17T01:00:00.000Z',
      lastSeen: '2026-09-17T02:00:00.000Z',
      lowerBound: false,
    },
    {
      name: WINDOWS_PATH,
      calls: 2,
      frames: 2,
      superseded: 0,
      states: { [SCRIPT_MARKUP]: 2 },
      errors: { [SCRIPT_MARKUP]: 1 },
      latency: { count: 2, p50Ms: 5, p95Ms: 6 },
      excludedLatency: { count: 0 },
      firstSeen: '2026-09-17T01:10:00.000Z',
      lastSeen: '2026-09-17T02:10:00.000Z',
      lowerBound: false,
    },
  ],
  totals: {
    quarantineMargin: {
      label: 'Chuẩn cách ly: 0 frame bị loại — 0 trên 0 frame đủ điều kiện',
      files: 0,
      framesPresent: 0,
      framesAdmitted: 0,
      framesNamedInvalid: 0,
      reasons: [],
    },
    truncation: null,
  },
  reconciliation: {
    classificationLine: 'classifiedKeys 2 + unattributedKeys 0 == compositeKeys 2',
    lines: ['classifiedKeys 2 + unattributedKeys 0 == compositeKeys 2'],
  },
};

const SEEDS = {
  'A-measured-truncated': SEED_MEASURED,
  'B-unmeasured-no-census': SEED_UNMEASURED_NO_CENSUS,
  'C-unmeasured-with-census': SEED_UNMEASURED_WITH_CENSUS,
  'D1-hostile-projected': SEED_HOSTILE,
  'D2-hostile-raw': SEED_HOSTILE,
};

// ---------------------------------------------------------------------------------------------
// Real projection (Phase 4 delivery surface)
// ---------------------------------------------------------------------------------------------

let projectEnvelope = null;
try {
  // eslint-disable-next-line global-require
  const service = require(SERVICE_PATH);
  if (typeof service.projectEnvelope === 'function') {
    projectEnvelope = service.projectEnvelope;
    telemetry.projection.available = true;
    telemetry.projection.envelopeKeys = service.MCP_DISPATCH_KEY_SETS
      ? Array.from(service.MCP_DISPATCH_KEY_SETS.envelope)
      : null;
    telemetry.projection.rowKeys = service.MCP_DISPATCH_KEY_SETS
      ? Array.from(service.MCP_DISPATCH_KEY_SETS.row)
      : null;
  } else {
    telemetry.projection.error = 'compiled module has no projectEnvelope export';
  }
} catch (err) {
  telemetry.projection.error = String((err && err.message) || err);
}

/** The exact object handed to the renderer for a scenario, and how it was produced. */
function buildPayload(scenarioId) {
  const seed = SEEDS[scenarioId];
  const mode = SCENARIOS[scenarioId].mode;
  if (mode === 'projected' && projectEnvelope) {
    return { delivered: projectEnvelope(seed, STORE_LABEL), via: 'projectEnvelope(seed, storeLabel)' };
  }
  return { delivered: seed, via: mode === 'projected' ? 'raw (projection unavailable)' : 'raw (by design: simulate a hostile upstream producer)' };
}

// ---------------------------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------------------------

const registeredChannels = new Set();
let currentScenario = null;
let dispatchInvocations = 0;

function handle(channel, fn) {
  if (registeredChannels.has(channel)) return;
  registeredChannels.add(channel);
  ipcMain.handle(channel, (event, ...args) => {
    telemetry.ipcCalls.push({
      channel,
      scenario: currentScenario,
      at: new Date().toISOString(),
      argSummary: args.length ? compact(args[0]).slice(0, 200) : null,
    });
    return fn(event, ...args);
  });
}

/** Every channel the compiled preload can `invoke`, so no boot call rejects for want of a handler. */
function preloadChannels() {
  try {
    const source = fs.readFileSync(PRELOAD_PATH, 'utf8');
    const names = new Set();
    const re = /^\s{4}([A-Z_0-9]+):\s*'([^']+)',/gm;
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[2]);
    return Array.from(names);
  } catch {
    return [];
  }
}

function installIpc() {
  handle('antifan:toolbar:get-initial-state', () => ({
    tabs: [{ id: 'tab-1', url: 'https://example.com', title: 'Example Page', state: { url: 'https://example.com' } }],
    activeTabId: 'tab-1',
    bookmarks: [],
    chromeProfiles: [],
    themeQa: { status: 'idle', issueCount: 0, updatedAt: Date.now() },
  }));
  handle('antifan:toolbar:set-overlay', () => true);
  handle('antifan:workflow:get-state', () => ({ workflows: [], tools: [] }));
  handle('antifan:core-health:get-state', () => ({ snapshot: { status: 'UNAVAILABLE', reasonCode: 'PROBE_STUB', affected: [], evidenceRefs: [], checks: [] } }));
  handle('antifan:toolbar:get-phone-status', () => null);
  handle('antifan:toolbar:get-mobile-remote-info', () => null);

  // The channel under test. Seeded, and only seeded: this is the probe's declared delivery route.
  handle(DISPATCH_CHANNEL, () => {
    dispatchInvocations += 1;
    const payload = currentScenario ? telemetry.payloads[currentScenario].delivered : null;
    // Round-trip through JSON so the renderer receives exactly what an IPC boundary would deliver
    // (no shared object identity, no undefined-vs-null ambiguity).
    return payload === null ? null : JSON.parse(JSON.stringify(payload));
  });

  for (const channel of preloadChannels()) handle(channel, () => null);
}

// ---------------------------------------------------------------------------------------------
// In-page driver
// ---------------------------------------------------------------------------------------------

let win = null;

/**
 * The page-side prelude. Kept as one string so every scenario shares identical helper semantics;
 * all inner strings are single-quoted + concatenated (no nested template literals).
 */
const PAGE_PRELUDE = `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const listEl = () => document.getElementById('hubItemsList');
    const listItems = () => Array.from(document.querySelectorAll('#hubItemsList > .hub-list-item'));
    const elById = (id) => document.getElementById(id);
    const textOf = (id) => { const el = document.getElementById(id); return el ? el.textContent : null; };
    const htmlOf = (id) => { const el = document.getElementById(id); return el ? el.innerHTML : null; };
    async function waitFor(pred, label, timeoutMs) {
      const started = Date.now();
      for (;;) {
        let ok = false;
        try { ok = !!pred(); } catch (e) { ok = false; }
        if (ok) return { ok: true, label: label, waitedMs: Date.now() - started };
        if (Date.now() - started > timeoutMs) return { ok: false, label: label, waitedMs: Date.now() - started };
        await sleep(50);
      }
    }
    function scanMarkers(markers) {
      const hits = { tag: [], attrName: [], attrValue: [], id: [], class: [] };
      const all = document.getElementsByTagName('*');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const tag = String(el.tagName || '').toLowerCase();
        const id = el.getAttribute ? String(el.getAttribute('id') || '') : '';
        const cls = el.getAttribute ? String(el.getAttribute('class') || '') : '';
        for (let k = 0; k < markers.length; k++) {
          const m = markers[k];
          const ml = m.toLowerCase();
          if (tag.indexOf(ml) !== -1) hits.tag.push({ tag: tag, marker: m });
          if (id.toLowerCase().indexOf(ml) !== -1) hits.id.push({ tag: tag, id: id, marker: m });
          if (cls.toLowerCase().indexOf(ml) !== -1) hits.class.push({ tag: tag, cls: cls, marker: m });
          const attrs = el.attributes || [];
          for (let j = 0; j < attrs.length; j++) {
            const a = attrs[j];
            const an = String(a.name || '').toLowerCase();
            const av = String(a.value == null ? '' : a.value);
            if (an.indexOf(ml) !== -1) hits.attrName.push({ tag: tag, attr: a.name, marker: m });
            if (av.toLowerCase().indexOf(ml) !== -1) {
              hits.attrValue.push({ tag: tag, attr: a.name, value: av.slice(0, 200), marker: m });
            }
          }
        }
      }
      return hits;
    }
    function scanTextNodes(markers) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      const hits = [];
      let node = walker.nextNode();
      while (node) {
        const v = String(node.nodeValue || '');
        for (let k = 0; k < markers.length; k++) {
          const m = markers[k];
          if (v.indexOf(m) !== -1) {
            const p = node.parentElement;
            hits.push({
              marker: m,
              parent: p ? p.tagName + (p.id ? '#' + p.id : '') : null,
              snippet: v.length > 240 ? v.slice(0, 240) : v,
            });
          }
        }
        node = walker.nextNode();
      }
      return hits;
    }
    function jsonPaneKeyScan(markers) {
      const el = document.getElementById('coreDetailCode');
      if (!el) return { present: false };
      const text = String(el.textContent || '');
      const out = {
        present: true,
        tagName: el.tagName,
        childElementCount: el.children.length,
        textLength: text.length,
        parsed: false,
        parsedKeys: [],
        textHits: [],
      };
      for (let k = 0; k < markers.length; k++) if (text.indexOf(markers[k]) !== -1) out.textHits.push(markers[k]);
      let parsed = null;
      try { parsed = JSON.parse(text); out.parsed = true; } catch (e) { out.parsed = false; }
      if (out.parsed) {
        const walk = (v, p) => {
          if (!v || typeof v !== 'object') return;
          const keys = Object.keys(v);
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            for (let k = 0; k < markers.length; k++) {
              const m = markers[k];
              if (key.toLowerCase().indexOf(m.toLowerCase()) !== -1) {
                out.parsedKeys.push({ marker: m, keyPath: p + '.' + key, key: key.slice(0, 200) });
              }
            }
            walk(v[keys[i]], p + '.' + key);
          }
        };
        walk(parsed, '$');
      }
      return out;
    }
    function elementCensus() {
      const all = document.getElementsByTagName('*');
      let onAttr = 0;
      const onAttrSamples = [];
      for (let i = 0; i < all.length; i++) {
        const attrs = all[i].attributes || [];
        for (let j = 0; j < attrs.length; j++) {
          if (/^on/i.test(String(attrs[j].name))) {
            onAttr += 1;
            if (onAttrSamples.length < 5) onAttrSamples.push(all[i].tagName + '[' + attrs[j].name + ']');
          }
        }
      }
      return {
        elements: all.length,
        img: document.querySelectorAll('img').length,
        imgWithOnerror: document.querySelectorAll('img[onerror]').length,
        script: document.querySelectorAll('script').length,
        elementsWithOnAttributes: onAttr,
        onAttributeSamples: onAttrSamples,
        canary: typeof window.__xssCanary === 'number' ? window.__xssCanary : null,
      };
    }
    function itemsView() {
      return listItems().map((el) => ({
        id: el.id,
        cls: el.className,
        title: el.querySelector('.hub-item-title') ? el.querySelector('.hub-item-title').textContent : null,
        pill: el.querySelector('.hub-item-pill') ? el.querySelector('.hub-item-pill').textContent : null,
        desc: el.querySelector('.hub-item-desc') ? el.querySelector('.hub-item-desc').textContent : null,
        meta: el.querySelector('.hub-item-meta') ? el.querySelector('.hub-item-meta').textContent : null,
        childElementCount: el.children.length,
      }));
    }
    function listDangerousDescendants() {
      const list = listEl();
      if (!list) return { present: false };
      const scoped = (sel) => list.querySelectorAll(sel).length;
      return {
        present: true,
        totalElements: list.getElementsByTagName('*').length,
        img: scoped('img'),
        script: scoped('script'),
        iframe: scoped('iframe'),
        objectEmbeds: scoped('object, embed'),
        elementsWithOnAttributes: Array.from(list.getElementsByTagName('*')).filter(
          (el) => Array.from(el.attributes || []).some((a) => /^on/i.test(a.name)),
        ).length,
        listIds: Array.from(list.getElementsByTagName('*')).map((el) => el.id).filter((id) => !!id).slice(0, 40),
        listTagNames: Array.from(new Set(Array.from(list.getElementsByTagName('*')).map((el) => el.tagName))).slice(0, 40),
      };
    }
`;

/**
 * Boot assertions: prove the real toolbar document + real preload are live, arm the XSS canary,
 * and self-test the element/attribute scanner so a later "no hits" result cannot be vacuous.
 */
function bootScript() {
  return `(async () => {
    const out = {};
${PAGE_PRELUDE}
    window.__xssCanary = 0;
    window.alert = () => { window.__xssCanary += 1; };

    out.readyWait = await waitFor(
      () => document.readyState === 'complete' && document.getElementById('${NAV_BUTTON_ID}'),
      'toolbar document ready with nav button', 8000,
    );
    out.location = String(window.location.href);
    out.readyState = document.readyState;
    out.title = document.title;
    out.bridgeKeys = window.antifanToolbar ? Object.keys(window.antifanToolbar).length : 0;
    out.hasBridge = !!window.antifanToolbar;
    out.hasGetMcpDispatchState = !!(window.antifanToolbar && typeof window.antifanToolbar.getMcpDispatchState === 'function');
    out.hasGetWorkflowState = !!(window.antifanToolbar && typeof window.antifanToolbar.getWorkflowState === 'function');
    out.hasExportsShim = typeof window.exports === 'object' && window.exports !== null;
    out.scriptSources = Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src'));

    const hubBtn = document.getElementById('${HUB_BUTTON_ID}');
    const nav = document.getElementById('${NAV_BUTTON_ID}');
    out.hubButton = hubBtn ? { id: hubBtn.id, text: hubBtn.textContent.trim(), visible: hubBtn.offsetParent !== null } : null;
    out.navButton = nav
      ? { id: nav.id, text: nav.textContent.trim().replace(/\\s+/g, ' '), cls: nav.className, present: true }
      : { present: false };
    out.overlayBefore = document.getElementById('${HUB_OVERLAY_ID}') ? document.getElementById('${HUB_OVERLAY_ID}').style.display : null;

    out.baselineCensus = elementCensus();
    out.baselineHits = scanMarkers(${JSON.stringify(MARKERS)});
    out.baselineTextHits = scanTextNodes(${JSON.stringify(MARKERS)});

    // --- scanner self-test (positive then negative) ---
    const probeEl = document.createElement('div');
    probeEl.setAttribute('id', '${SELFTEST_MARKER}');
    probeEl.setAttribute('${SELFTEST_MARKER}', '${SELFTEST_MARKER}');
    probeEl.textContent = '${SELFTEST_MARKER}';
    document.body.appendChild(probeEl);
    const positive = scanMarkers(['${SELFTEST_MARKER}']);
    const positiveText = scanTextNodes(['${SELFTEST_MARKER}']);
    probeEl.remove();
    const negative = scanMarkers(['${SELFTEST_MARKER}']);
    const negativeText = scanTextNodes(['${SELFTEST_MARKER}']);
    out.scannerSelfTest = {
      marker: '${SELFTEST_MARKER}',
      positiveTagHits: positive.tag.length,
      positiveIdHits: positive.id.length,
      positiveAttrNameHits: positive.attrName.length,
      positiveAttrValueHits: positive.attrValue.length,
      positiveTextNodeHits: positiveText.length,
      negativeTagHits: negative.tag.length,
      negativeIdHits: negative.id.length,
      negativeAttrNameHits: negative.attrName.length,
      negativeAttrValueHits: negative.attrValue.length,
      negativeTextNodeHits: negativeText.length,
      residueElements: document.querySelectorAll('[id="${SELFTEST_MARKER}"]').length,
    };
    out.afterSelfTestCensus = elementCensus();
    return out;
  })()`;
}

/** One scenario: clear the list, click the nav button, wait for a scenario-specific sentinel, read DOM. */
function scenarioScript(scenarioId) {
  const cfg = SCENARIOS[scenarioId];
  const sentinel = JSON.stringify(cfg.sentinel);
  const markers = JSON.stringify(MARKERS);
  const clickHub = scenarioId === 'A-measured-truncated';
  return `(async () => {
    const out = {};
${PAGE_PRELUDE}
    const sentinel = ${sentinel};
    const markers = ${markers};

    ${clickHub ? `
    const hubBtn = document.getElementById('${HUB_BUTTON_ID}');
    if (hubBtn) hubBtn.click();
    out.overlayOpenWait = await waitFor(
      () => { const o = document.getElementById('${HUB_OVERLAY_ID}'); return o && o.style.display !== 'none'; },
      'workflow hub overlay opened', 5000,
    );
    out.overlayDisplay = document.getElementById('${HUB_OVERLAY_ID}') ? document.getElementById('${HUB_OVERLAY_ID}').style.display : null;
    ` : `
    out.overlayDisplay = document.getElementById('${HUB_OVERLAY_ID}') ? document.getElementById('${HUB_OVERLAY_ID}').style.display : null;
    `}

    // Clear the pane so any content observed below had to be rendered after this click.
    const list = listEl();
    out.listChildCountBeforeClick = list ? list.children.length : null;
    if (list) list.innerHTML = '';

    const nav = document.getElementById('${NAV_BUTTON_ID}');
    out.navClicked = !!nav;
    out.navClassAfterClickPending = nav ? nav.className : null;
    if (nav) nav.click();

    out.sentinelWait = await waitFor(
      () => { const l = listEl(); return l && l.textContent.indexOf(sentinel) !== -1; },
      'list text contains sentinel ' + sentinel, 6000,
    );
    await sleep(120);

    out.navClass = nav ? nav.className : null;
    out.navAriaSelected = nav ? nav.getAttribute('aria-selected') : null;
    out.listChildCount = listEl() ? listEl().children.length : null;
    out.listItemCount = listItems().length;
    out.listText = listEl() ? listEl().textContent : null;
    out.listTextLength = out.listText ? out.listText.length : 0;
    out.listInnerHtml = listEl() ? String(listEl().innerHTML).slice(0, 6000) : null;
    out.items = itemsView();

    out.notice = (() => {
      const n = document.getElementById('mcpDispatchNotice');
      if (!n) return null;
      return { id: n.id, text: n.textContent, childElementCount: n.children.length, listChildCount: listEl() ? listEl().children.length : null };
    })();
    out.margin = (() => {
      const m = document.getElementById('mcpDispatchQuarantineMargin');
      return m ? { id: m.id, text: m.textContent, html: m.innerHTML, childElementCount: m.children.length } : null;
    })();
    out.truncation = (() => {
      const t = document.getElementById('mcpDispatchTruncation');
      return t ? { id: t.id, text: t.textContent, html: t.innerHTML } : null;
    })();
    out.reconciliation = (() => {
      const r = document.getElementById('mcpDispatchReconciliation');
      if (!r) return null;
      return {
        id: r.id,
        title: r.querySelector('.hub-item-title') ? r.querySelector('.hub-item-title').textContent : null,
        desc: r.querySelector('.hub-item-desc') ? r.querySelector('.hub-item-desc').textContent : null,
        meta: r.querySelector('.hub-item-meta') ? r.querySelector('.hub-item-meta').textContent : null,
      };
    })();
    out.coreHole = (() => {
      const c = document.getElementById('mcpDispatchCoreHole');
      if (!c) return null;
      return {
        id: c.id,
        title: c.querySelector('.hub-item-title') ? c.querySelector('.hub-item-title').textContent : null,
        pill: c.querySelector('.hub-item-pill') ? c.querySelector('.hub-item-pill').textContent : null,
        desc: c.querySelector('.hub-item-desc') ? c.querySelector('.hub-item-desc').textContent : null,
      };
    })();
    out.listIds = listItems().map((el) => el.id);
    out.badge = textOf('badgeMcpDispatch');

    // Layout proof: jsdom has no layout engine (getBoundingClientRect is all zeros there), so real
    // laid-out boxes for the payload-rendered nodes are the strongest available "this is a real
    // Chromium renderer, not a DOM emulation" evidence.
    out.layout = (() => {
      const rectOf = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const round = (n) => Math.round(n * 100) / 100;
        return { w: round(r.width), h: round(r.height), top: round(r.top), left: round(r.left) };
      };
      const rows = listItems().map((el) => ({ id: el.id, rect: rectOf(el) }));
      const overlay = document.getElementById('workflowHubOverlay');
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        docScrollHeight: document.documentElement.scrollHeight,
        list: rectOf(listEl()),
        reconciliation: rectOf(document.getElementById('mcpDispatchReconciliation')),
        margin: rectOf(document.getElementById('mcpDispatchQuarantineMargin')),
        truncation: rectOf(document.getElementById('mcpDispatchTruncation')),
        rowsWithPositiveHeight: rows.filter((r) => r.rect && r.rect.h > 0).length,
        rows,
        overlayComputedDisplay: overlay ? getComputedStyle(overlay).display : null,
        listComputedVisibility: listEl() ? getComputedStyle(listEl()).visibility : null,
      };
    })();

    // Detail pane for the first item (auto-selected on render).
    const firstId = out.listIds.length ? out.listIds[0] : null;
    out.detailAutoSelectedFor = firstId;
    out.detailName = textOf('coreDetailName');
    out.detailCategory = textOf('coreDetailCategory');
    out.detailStatusPill = textOf('coreStatusPill');
    out.detailPaneDisplay = (() => { const d = document.getElementById('hubCoreDetail'); return d ? d.style.display : null; })();

    // Then click the first per-name row so the JSON pane describes a row (name/errors/states).
    const rowId = out.listIds.filter((id) => id.indexOf('mcpDispatchRow:') === 0)[0] || null;
    out.rowClicked = rowId;
    if (rowId) {
      const rowEl = document.getElementById(rowId);
      if (rowEl) rowEl.click();
      await sleep(150);
    }
    out.detailNameAfterRowClick = textOf('coreDetailName');
    out.detailDescAfterRowClick = textOf('coreDetailDesc');
    out.detailCategoryAfterRowClick = textOf('coreDetailCategory');
    out.detailStatusPillAfterRowClick = textOf('coreStatusPill');
    out.detailNameChildElementCount = (() => { const d = document.getElementById('coreDetailName'); return d ? d.children.length : null; })();
    out.detailDescChildElementCount = (() => { const d = document.getElementById('coreDetailDesc'); return d ? d.children.length : null; })();

    out.census = elementCensus();
    out.listScoped = listDangerousDescendants();
    out.markerHits = scanMarkers(markers);
    out.markerTextHits = scanTextNodes(markers);
    out.jsonPane = jsonPaneKeyScan(markers);
    out.bodyHasMarkupAsText = ${JSON.stringify(MARKERS)}.map((m) => ({ marker: m, inBodyText: document.body.textContent.indexOf(m) !== -1 }));
    out.getElementByIdForMarkers = ${JSON.stringify(MARKERS)}.map((m) => ({ marker: m, found: !!document.getElementById(m) }));
    return out;
  })()`;
}

// ---------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------

function assertBoot(boot) {
  assert(
    'boot-A1-toolbar-document-loaded',
    !!boot && String(boot.location || '').toLowerCase().indexOf('toolbar.html') !== -1,
    'location.href ends in toolbar.html',
    boot ? boot.location : null,
  );
  assert(
    'boot-A2-real-preload-bridge-present',
    !!boot && boot.hasBridge === true && boot.hasGetMcpDispatchState === true,
    'window.antifanToolbar.getMcpDispatchState is a function (real compiled preload)',
    boot ? { hasBridge: boot.hasBridge, bridgeKeys: boot.bridgeKeys, hasGetMcpDispatchState: boot.hasGetMcpDispatchState, hasGetWorkflowState: boot.hasGetWorkflowState } : null,
  );
  assert(
    'boot-A3-renderer-scripts-loaded',
    !!boot && boot.hasExportsShim === true && Array.isArray(boot.scriptSources)
      && boot.scriptSources.indexOf('exports-shim.js') !== -1 && boot.scriptSources.indexOf('toolbar.js') !== -1,
    'exports-shim.js + toolbar.js are the loaded scripts',
    boot ? { hasExportsShim: boot.hasExportsShim, scriptSources: boot.scriptSources } : null,
  );
  assert(
    'boot-A4-nav-button-present',
    !!boot && boot.navButton && boot.navButton.present === true && boot.navButton.id === NAV_BUTTON_ID,
    `#${NAV_BUTTON_ID} exists in the live toolbar document`,
    boot ? boot.navButton : null,
  );
  assert(
    'boot-A5-scanner-self-test-detects-hits',
    !!boot && boot.scannerSelfTest && boot.scannerSelfTest.positiveIdHits >= 1
      && boot.scannerSelfTest.positiveAttrNameHits >= 1 && boot.scannerSelfTest.positiveAttrValueHits >= 2
      && boot.scannerSelfTest.positiveTextNodeHits >= 1,
    'the scanner reports hits for a planted marker in every non-tag category (id, attribute name, '
      + 'attribute value, text node), so a later "no hits" result is not vacuous',
    boot ? boot.scannerSelfTest : null,
  );
  assert(
    'boot-A6-scanner-self-test-clean-after-removal',
    !!boot && boot.scannerSelfTest && boot.scannerSelfTest.negativeIdHits === 0
      && boot.scannerSelfTest.negativeAttrNameHits === 0 && boot.scannerSelfTest.negativeAttrValueHits === 0
      && boot.scannerSelfTest.negativeTagHits === 0 && boot.scannerSelfTest.negativeTextNodeHits === 0
      && boot.scannerSelfTest.residueElements === 0,
    'removing the planted element clears every scanner hit and leaves no residue',
    boot ? boot.scannerSelfTest : null,
  );
  assert(
    'boot-A7-baseline-has-no-inline-handlers',
    !!boot && boot.baselineCensus && boot.baselineCensus.elementsWithOnAttributes === 0
      && boot.baselineCensus.imgWithOnerror === 0 && boot.baselineCensus.canary === 0,
    'baseline document has 0 elements with inline on* attributes, 0 img[onerror], canary 0',
    boot ? { census: boot.baselineCensus, note: DOCUMENT_BASELINE_NOTE, baselineMarkerHits: boot.baselineHits, baselineTextHits: boot.baselineTextHits } : null,
  );
  assert(
    'boot-A8-canary-armed',
    !!boot && boot.afterSelfTestCensus && boot.afterSelfTestCensus.canary === 0,
    'window.alert override armed and never invoked (canary === 0)',
    boot ? { canary: boot.afterSelfTestCensus.canary, elements: boot.afterSelfTestCensus.elements } : null,
  );
}

function assertScenarioA(id, s) {
  const delivered = telemetry.payloads[id].delivered;
  assert(
    'A1-hub-overlay-opens',
    s.overlayDisplay === 'flex',
    `${HUB_OVERLAY_ID} style.display === 'flex' after clicking #${HUB_BUTTON_ID}`,
    { overlayDisplay: s.overlayDisplay, overlayOpenWait: s.overlayWait || s.overlayOpenWait, navClicked: s.navClicked },
  );
  assert(
    'A2-nav-click-activates-tab',
    typeof s.navClass === 'string' && s.navClass.indexOf('active') !== -1,
    `#${NAV_BUTTON_ID}.className contains 'active'`,
    { navClass: s.navClass, navAriaSelected: s.navAriaSelected },
  );
  assert(
    'A3-sentinel-rendered',
    s.sentinelWait && s.sentinelWait.ok === true,
    `list text contains '${SCENARIOS[id].sentinel}' within 6000ms`,
    { sentinelWait: s.sentinelWait, listItemCount: s.listItemCount, listIds: s.listIds },
  );
  assert(
    'A4-list-rendered-six-items',
    s.listItemCount === 6 && Array.isArray(s.listIds)
      && s.listIds.indexOf('mcpDispatchReconciliation') !== -1
      && s.listIds.indexOf('mcpDispatchRow:0') !== -1
      && s.listIds.indexOf('mcpDispatchRow:1') !== -1
      && s.listIds.indexOf('mcpDispatchQuarantineMargin') !== -1
      && s.listIds.indexOf('mcpDispatchTruncation') !== -1
      && s.listIds.indexOf('mcpDispatchCoreHole') !== -1,
    '6 .hub-list-item rows: reconciliation + 2 names + margin + truncation + core-hole',
    { listItemCount: s.listItemCount, listIds: s.listIds, listChildCount: s.listChildCount, listChildCountBeforeClick: s.listChildCountBeforeClick },
  );

  const row0 = (s.items || []).filter((i) => i.id === 'mcpDispatchRow:0')[0] || null;
  const row1 = (s.items || []).filter((i) => i.id === 'mcpDispatchRow:1')[0] || null;
  assert(
    'A5-row0-name-calls-states-errors-latency',
    !!row0 && row0.title === 'antifan_navigate_3f6a73181cb6'
      && typeof row0.meta === 'string' && row0.meta.indexOf('calls 7') !== -1 && row0.meta.indexOf('≥ calls 7') === 0
      && typeof row0.desc === 'string' && row0.desc.indexOf('states: completed×5 · failed×1 · superseded×1') !== -1
      && row0.desc.indexOf('errors: E_TIMEOUT×1') !== -1
      && row0.desc.indexOf('latency: p50 12ms · p95 88ms (n=5)') !== -1,
    'row 0 renders name, "≥ calls 7", states mix, error histogram and latency line',
    row0,
  );
  assert(
    'A6-row0-lower-bound-marker',
    !!row0 && row0.pill === '≥ LOWER BOUND'
      && typeof row0.desc === 'string' && row0.desc.indexOf('sàn (lowerBound)') !== -1,
    'row 0 pill is "≥ LOWER BOUND" and its desc carries the lowerBound marker',
    row0 ? { pill: row0.pill, desc: row0.desc } : null,
  );
  assert(
    'A7-row1-retained-and-reads-exact-counts',
    !!row1 && row1.title === 'antifan_screenshot_viewport_3d98bcf74af0' && row1.pill === 'RETAINED'
      && typeof row1.meta === 'string' && row1.meta.indexOf('calls 4') !== -1 && row1.meta.indexOf('≥ ') === -1
      && typeof row1.desc === 'string' && row1.desc.indexOf('latency: p50 210ms · p95 640ms (n=4)') !== -1,
    'row 1 (lowerBound false) is RETAINED with exact calls 4 and its own latency line',
    row1,
  );
  assert(
    'A8-empty-histogram-and-empty-latency-render-UNMEASURED',
    !!row1 && typeof row1.desc === 'string'
      && row1.desc.indexOf('errors: UNMEASURED') !== -1
      && row1.desc.indexOf('excluded: UNMEASURED') !== -1,
    'empty errors histogram and count===0 latency render UNMEASURED, never a fabricated 0',
    row1 ? row1.desc : null,
  );
  assert(
    'A9-invariant-lines-printed',
    !!s.reconciliation && typeof s.reconciliation.desc === 'string'
      && s.reconciliation.desc.indexOf('classifiedKeys + unattributedKeys == compositeKeys') !== -1
      && s.reconciliation.desc.indexOf('frames == compositeKeys + superseded + keylessFrames') !== -1
      && s.reconciliation.desc.indexOf('classifiedKeys 7 + unattributedKeys 0 == compositeKeys 7') !== -1
      && s.reconciliation.desc.indexOf('frames 12 == compositeKeys 7 + superseded 1 + keylessFrames 4') !== -1,
    'both GENERAL invariant lines plus the payload reconciliation lines are printed',
    s.reconciliation,
  );
  assert(
    'A10-reconciliation-meta-asof-store-label',
    !!s.reconciliation && typeof s.reconciliation.meta === 'string'
      && s.reconciliation.meta.indexOf('asOf 2026-09-17T03:41:00.000Z') !== -1
      && s.reconciliation.meta.indexOf(STORE_LABEL) !== -1
      && s.reconciliation.meta.indexOf('AppData') === -1,
    `meta reads 'asOf <instant> · ${STORE_LABEL}' with no path fragment`,
    s.reconciliation ? s.reconciliation.meta : null,
  );
  assert(
    'A11-quarantine-margin-label-printed-verbatim',
    !!s.margin && s.margin.text === delivered.totals.quarantineMargin.label,
    JSON.stringify(delivered.totals.quarantineMargin.label),
    s.margin ? { text: s.margin.text, childElementCount: s.margin.childElementCount } : null,
  );
  const expectedPartial = `partial: ${delivered.totals.truncation.filesRead} of ${delivered.totals.truncation.filesRead + delivered.totals.truncation.filesSkipped} files`;
  assert(
    'A12-truncation-partial-notice',
    !!s.truncation && s.truncation.text === expectedPartial,
    `'${expectedPartial}'`,
    s.truncation ? { text: s.truncation.text, html: s.truncation.html, contractLabel: delivered.totals.truncation.label } : null,
  );
  assert(
    'A13-core-hole-disclosure',
    !!s.coreHole && s.coreHole.pill === 'UNMEASURED'
      && typeof s.coreHole.desc === 'string' && s.coreHole.desc.indexOf('CHƯA ĐƯỢC GHI NHẬN') !== -1,
    'core.* hole row present, pill UNMEASURED, desc keeps the "0 attempts ≠ unused" disclosure',
    s.coreHole,
  );
  assert(
    'A14-badge-rows-count',
    s.badge === String((delivered.rows || []).length),
    `#badgeMcpDispatch textContent === '${(delivered.rows || []).length}' for a MEASURED payload`,
    { badge: s.badge, rows: (delivered.rows || []).length },
  );
  assert(
    'A15-detail-pane-json-text-only',
    s.jsonPane && s.jsonPane.present === true && s.jsonPane.tagName === 'PRE' && s.jsonPane.childElementCount === 0 && s.jsonPane.parsed === true,
    '<pre id="coreDetailCode"> carries JSON as text with 0 child elements',
    s.jsonPane ? { tagName: s.jsonPane.tagName, childElementCount: s.jsonPane.childElementCount, parsed: s.jsonPane.parsed, textLength: s.jsonPane.textLength } : null,
  );
  assert(
    'A16-live-layout-boxes-non-zero',
    !!s.layout && s.layout.viewport.w > 0 && s.layout.viewport.h > 0
      && s.layout.rowsWithPositiveHeight === s.listItemCount
      && !!s.layout.reconciliation && s.layout.reconciliation.h > 0
      && !!s.layout.margin && s.layout.margin.h > 0
      && !!s.layout.truncation && s.layout.truncation.h > 0
      && s.layout.overlayComputedDisplay === 'flex',
    `a real layout engine produced positive-height boxes for all ${s.listItemCount} items `
      + '(jsdom reports 0x0 for every one of these) and the overlay computes to display:flex',
    s.layout ? {
      viewport: s.layout.viewport,
      docScrollHeight: s.layout.docScrollHeight,
      rowsWithPositiveHeight: s.layout.rowsWithPositiveHeight,
      reconciliation: s.layout.reconciliation,
      margin: s.layout.margin,
      truncation: s.layout.truncation,
      overlayComputedDisplay: s.layout.overlayComputedDisplay,
      listComputedVisibility: s.layout.listComputedVisibility,
      rows: s.layout.rows,
    } : null,
  );
}

function assertScenarioB(id, s) {
  assert(
    'B1-nav-sentinel-and-single-notice',
    s.sentinelWait && s.sentinelWait.ok === true && !!s.notice && s.listItemCount === 0 && s.notice.listChildCount === 1,
    'the list holds exactly one child (#mcpDispatchNotice) and zero .hub-list-item rows',
    { sentinelWait: s.sentinelWait, listItemCount: s.listItemCount, notice: s.notice ? { id: s.notice.id, childElementCount: s.notice.childElementCount, listChildCount: s.notice.listChildCount } : null },
  );
  const noticeText = s.notice ? s.notice.text : '';
  assert(
    'B2-unmeasured-copy-with-reason-code',
    noticeText.indexOf('UNMEASURED') !== -1 && noticeText.indexOf('NO_DATA_ROOT_RESOLVED') !== -1,
    'notice text contains UNMEASURED and the reasonCode NO_DATA_ROOT_RESOLVED',
    noticeText,
  );
  assert(
    'B3-store-label-falls-back-to-reason-code-not-null',
    noticeText.indexOf('null') === -1 && noticeText.indexOf('undefined') === -1,
    'no literal "null"/"undefined" in the notice',
    noticeText,
  );
  assert(
    'B4-badge-is-dash-not-zero',
    s.badge === '–',
    "#badgeMcpDispatch textContent === '–' (a 0 badge would claim 'never dispatched')",
    { badge: s.badge, noticeText },
  );
  assert(
    'B5-no-fabricated-count-zero',
    noticeText.indexOf('calls 0') === -1 && noticeText.indexOf('n=0') === -1 && noticeText.indexOf('0 rows') === -1
      && (s.listText || '').indexOf('calls 0') === -1,
    'no fabricated count text (calls 0 / n=0 / 0 rows) anywhere in the pane',
    { noticeText: noticeText, listText: s.listText },
  );
  assert(
    'B6-affected-token-rendered',
    noticeText.indexOf('affected: ipc-sender-not-trusted') !== -1,
    'the affected[] mechanism token is printed',
    noticeText,
  );
}

function assertScenarioC(id, s) {
  const noticeText = s.notice ? s.notice.text : '';
  const limits = telemetry.payloads[id].delivered.census.limits;
  assert(
    'C1-unmeasured-with-reason-code',
    s.sentinelWait && s.sentinelWait.ok === true && noticeText.indexOf('UNMEASURED') !== -1 && noticeText.indexOf('CENSUS_DRIFT') !== -1,
    'notice renders UNMEASURED + CENSUS_DRIFT',
    noticeText,
  );
  assert(
    'C2-read-facts-verbatim-from-payload',
    noticeText.indexOf('census.limits.observedFiles: 9') !== -1
      && noticeText.indexOf('census.limits.filesRead: 0') !== -1
      && noticeText.indexOf('census.limits.outcome: POPULATION_TRUNCATED') !== -1
      && noticeText.indexOf('census.limits.ceiling: MAX_CENSUS_BYTES') !== -1,
    'every rendered number/outcome is the payload value (observedFiles 9, filesRead 0, outcome, ceiling)',
    { noticeText, deliveredLimits: limits },
  );
  assert(
    'C3-read-facts-are-payload-sourced',
    noticeText.indexOf(`census.limits.observedFiles: ${limits.observedFiles}`) !== -1
      && noticeText.indexOf(`census.limits.filesRead: ${limits.filesRead}`) !== -1,
    'the rendered read facts equal the delivered envelope values',
    { observedFiles: limits.observedFiles, filesRead: limits.filesRead, noticeText },
  );
  assert(
    'C4-path-in-affected-never-crosses-the-boundary',
    noticeText.indexOf('secrets') === -1 && noticeText.indexOf('C:\\') === -1,
    'the drive-absolute path in affected[] is reduced to the store label; no path text reaches the DOM',
    noticeText,
  );
}

function assertScenarioD1(id, s) {
  const delivered = telemetry.payloads[id].delivered;
  const row0 = (s.items || []).filter((i) => i.id === 'mcpDispatchRow:0')[0] || null;
  const row1 = (s.items || []).filter((i) => i.id === 'mcpDispatchRow:1')[0] || null;

  assert(
    'D1-1-markup-survives-the-real-projection',
    !!row0 && row0.title === MARKUP && delivered.rows[0].name === MARKUP,
    'row 0 name is the raw markup string (proves the projection admits it and it really reached the DOM)',
    { title: row0 ? row0.title : null, deliveredName: delivered.rows[0].name },
  );
  assert(
    'D1-2-path-keys-and-names-collapse-to-UNRECOGNIZED',
    !!row1 && row1.title === STORE_LABEL
      && delivered.rows[1].name === STORE_LABEL
      && Object.prototype.hasOwnProperty.call(delivered.rows[0].errors, 'UNRECOGNIZED')
      && delivered.rows[0].errors.UNRECOGNIZED === 5
      && !Object.prototype.hasOwnProperty.call(delivered.rows[0].errors, WINDOWS_PATH),
    `location-shaped keys/names are rewritten (count preserved: UNRECOGNIZED=5) and row 1's path name becomes '${STORE_LABEL}'`,
    { row1Title: row1 ? row1.title : null, deliveredRow1Name: delivered.rows[1].name, projectedErrors: delivered.rows[0].errors },
  );
  const text = s.listText || '';
  assert(
    'D1-3-markup-is-visible-as-text',
    text.indexOf(MARKUP) !== -1 && !!row0 && typeof row0.desc === 'string' && row0.desc.indexOf(MARKUP) !== -1,
    'the markup string is present as text (non-vacuity: the payload really rendered)',
    { inListText: text.indexOf(MARKUP) !== -1, rowDesc: row0 ? row0.desc : null },
  );
  assert(
    'D1-4-no-element-tag-id-class-or-attribute-hit',
    s.markerHits && s.markerHits.tag.length === 0 && s.markerHits.id.length === 0
      && s.markerHits.class.length === 0 && s.markerHits.attrName.length === 0 && s.markerHits.attrValue.length === 0,
    'no element tagName/id/class/attribute name/attribute value contains any marker',
    s.markerHits,
  );
  assert(
    'D1-5-no-injected-elements-or-handlers',
    !!s.listScoped && s.listScoped.present === true && s.listScoped.img === 0 && s.listScoped.script === 0
      && s.listScoped.iframe === 0 && s.listScoped.objectEmbeds === 0
      && s.listScoped.elementsWithOnAttributes === 0
      && s.census && s.census.imgWithOnerror === 0 && s.census.elementsWithOnAttributes === 0 && s.census.canary === 0
      && s.census.img === baselineCensus().img && s.census.script === baselineCensus().script,
    'inside #hubItemsList: 0 img/script/iframe/object/embed and 0 elements with on* attributes; '
      + 'document-wide img/script counts equal the pre-payload baseline, img[onerror] 0, canary 0',
    {
      listScoped: s.listScoped,
      census: s.census,
      baseline: baselineCensus(),
      baselineNote: DOCUMENT_BASELINE_NOTE,
    },
  );
  assert(
    'D1-6-getElementById-pollution-none',
    Array.isArray(s.getElementByIdForMarkers) && s.getElementByIdForMarkers.every((e) => e.found === false),
    'document.getElementById(<marker>) returns null for every marker (no id was built from payload text)',
    s.getElementByIdForMarkers,
  );
  assert(
    'D1-7-json-pane-keys-are-inert-text',
    !!s.jsonPane && s.jsonPane.present === true && s.jsonPane.childElementCount === 0,
    'the JSON detail pane kept 0 child elements even where a marker appears as a serialized key',
    s.jsonPane,
  );
  const pathTextHits = (s.markerTextHits || []).filter((h) => h.marker === WINDOWS_PATH);
  assert(
    'D1-8-path-text-absent-from-the-whole-document',
    pathTextHits.length === 0,
    'the drive-absolute path appears in no text node anywhere in the document',
    { pathTextHits, deliveredStorePath: delivered.storePath },
  );
}

function assertScenarioD2(id, s) {
  const row0 = (s.items || []).filter((i) => i.id === 'mcpDispatchRow:0')[0] || null;
  const row1 = (s.items || []).filter((i) => i.id === 'mcpDispatchRow:1')[0] || null;
  const text = s.listText || '';
  assert(
    'D2-1-raw-hostile-payload-rendered',
    !!row0 && row0.title === MARKUP && !!row1 && row1.title === WINDOWS_PATH
      && text.indexOf(WINDOWS_PATH) !== -1 && text.indexOf(MARKUP) !== -1,
    'unprojected hostile name and error.code values are present as text (non-vacuity)',
    { row0Title: row0 ? row0.title : null, row1Title: row1 ? row1.title : null, row0Desc: row0 ? row0.desc : null, row1Desc: row1 ? row1.desc : null },
  );
  assert(
    'D2-2-no-element-tag-id-class-or-attribute-hit',
    s.markerHits && s.markerHits.tag.length === 0 && s.markerHits.id.length === 0
      && s.markerHits.class.length === 0 && s.markerHits.attrName.length === 0 && s.markerHits.attrValue.length === 0,
    'no element tagName/id/class/attribute name/attribute value contains any marker',
    s.markerHits,
  );
  assert(
    'D2-3-no-img-or-script-element-created',
    !!s.listScoped && s.listScoped.present === true && s.listScoped.img === 0 && s.listScoped.script === 0
      && s.listScoped.iframe === 0 && s.listScoped.objectEmbeds === 0
      && s.listScoped.elementsWithOnAttributes === 0
      && s.census && s.census.imgWithOnerror === 0 && s.census.elementsWithOnAttributes === 0 && s.census.canary === 0
      && s.census.img === baselineCensus().img && s.census.script === baselineCensus().script,
    'inside #hubItemsList: 0 img/script/iframe/object/embed and 0 elements with on* attributes; '
      + 'document-wide img/script counts equal the pre-payload baseline, img[onerror] 0, alert() canary 0',
    {
      listScoped: s.listScoped,
      census: s.census,
      baseline: baselineCensus(),
      baselineNote: DOCUMENT_BASELINE_NOTE,
    },
  );
  assert(
    'D2-4-markup-escaped-in-innerhtml',
    typeof s.listInnerHtml === 'string'
      && s.listInnerHtml.indexOf('&lt;img src=x onerror=alert(1)&gt;') !== -1
      && s.listInnerHtml.indexOf('<img src=x') === -1,
    'the list innerHTML carries the escaped entity form and contains no live <img src=x',
    { escapedPresent: typeof s.listInnerHtml === 'string' ? s.listInnerHtml.indexOf('&lt;img src=x onerror=alert(1)&gt;') !== -1 : null, liveImgPresent: typeof s.listInnerHtml === 'string' ? s.listInnerHtml.indexOf('<img src=x') !== -1 : null },
  );
  assert(
    'D2-5-getElementById-pollution-none',
    Array.isArray(s.getElementByIdForMarkers) && s.getElementByIdForMarkers.every((e) => e.found === false),
    'document.getElementById(<marker>) returns null for every marker',
    s.getElementByIdForMarkers,
  );
  assert(
    'D2-6-detail-pane-text-only',
    s.detailNameAfterRowClick === MARKUP && s.detailNameChildElementCount === 0
      && s.detailDescChildElementCount === 0,
    'the detail pane name is the raw string as textContent with 0 child elements',
    {
      detailNameAfterRowClick: s.detailNameAfterRowClick,
      detailNameChildElementCount: s.detailNameChildElementCount,
      detailDescChildElementCount: s.detailDescChildElementCount,
      jsonPane: s.jsonPane,
    },
  );
  assert(
    'D2-7-json-pane-keys-are-inert-text',
    !!s.jsonPane && s.jsonPane.present === true && s.jsonPane.childElementCount === 0 && s.jsonPane.parsed === true,
    'the JSON pane serializes the marker as a key inside a <pre> text node with 0 child elements (inert, never parsed as markup)',
    s.jsonPane,
  );
  const textHits = s.markerTextHits || [];
  assert(
    'D2-8-markers-exist-only-as-text-nodes',
    textHits.length >= 2 && textHits.every((h) => typeof h.parent === 'string'),
    'every marker occurrence is inside a text node with a real parent element (text only)',
    textHits,
  );
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

const watchdog = setTimeout(() => {
  console.error('[PROBE] WATCHDOG: probe exceeded 120s; writing partial telemetry and exiting 1');
  telemetry.findings.push({ id: 'watchdog', severity: 'FATAL', observed: 'probe exceeded 120000ms' });
  writeReport('WATCHDOG');
  app.exit(1);
}, 120000);

function writeReport(statusOverride) {
  telemetry.finishedAt = new Date().toISOString();
  const failed = telemetry.assertions.filter((a) => a.verdict === 'FAIL');
  telemetry.summary = {
    assertions: telemetry.assertions.length,
    pass: telemetry.assertions.length - failed.length,
    fail: failed.length,
    failedIds: failed.map((a) => a.id),
    status: statusOverride || (failed.length === 0 && telemetry.assertions.length > 0 ? 'PASS' : 'FAIL'),
    dispatchInvocationCount: dispatchInvocations,
    booted: !!(telemetry.boot && telemetry.boot.hasGetMcpDispatchState === true),
  };
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(telemetry, null, 2), 'utf8');
    console.log(`[PROBE] report written: ${path.relative(ROOT, REPORT_JSON_PATH)}`);
  } catch (err) {
    console.error('[PROBE] failed to write report:', err && err.message);
  }
  console.log('================ PROBE SUMMARY ================');
  for (const a of telemetry.assertions) console.log(`${a.verdict}  ${a.id}`);
  console.log(`assertions=${telemetry.summary.assertions} pass=${telemetry.summary.pass} fail=${telemetry.summary.fail}`);
  console.log(`status=${telemetry.summary.status}`);
  console.log('==============================================');
}

function finish(code) {
  clearTimeout(watchdog);
  writeReport();
  const code2 = telemetry.summary.status === 'PASS' ? 0 : 1;
  setTimeout(() => app.exit(code === undefined ? code2 : code), 250);
}

async function main() {
  telemetry.artifacts = {
    // What the probe actually observed (loaded by BrowserWindow / the preload):
    toolbarHtml: sha256File(HTML_PATH),
    toolbarJs: sha256File(RENDERER_JS_PATH),
    exportsShim: sha256File(RENDERER_SHIM_PATH),
    toolbarPreload: sha256File(PRELOAD_PATH),
    mcpDispatchService: sha256File(SERVICE_PATH),
    // Upstream sources, hashed only so the report can say whether the observed compiled revision is
    // the current source revision. The probe never compiles and never edits them.
    sourceToolbarTs: sha256File(path.join(ROOT, 'src/renderer/toolbar.ts')),
    sourceToolbarHtml: sha256File(path.join(ROOT, 'src/renderer/toolbar.html')),
  };
  const compiledJs = telemetry.artifacts.toolbarJs;
  const sourceTs = telemetry.artifacts.sourceToolbarTs;
  telemetry.artifacts.sourceVsCompiled = {
    compiledToolbarJsMtimeMs: compiledJs.mtimeMs || null,
    sourceToolbarTsMtimeMs: sourceTs.mtimeMs || null,
    sourceIsNewerThanCompiled: !!(sourceTs.mtimeMs && compiledJs.mtimeMs && sourceTs.mtimeMs > compiledJs.mtimeMs),
    note: 'This probe observes the COMPILED renderer. If the source is newer, the observed revision '
      + 'is not the current source revision and the hashes above (not the working tree) define what '
      + 'passed. Re-run after a compile to certify the newer source.',
  };
  telemetry.route.payloadDelivery = projectEnvelope
    ? 'seeded envelope -> real projectEnvelope() (Phase 4 delivery surface) -> IPC channel -> real preload -> renderer'
    : 'seeded envelope (raw) -> IPC channel -> real preload -> renderer (projectEnvelope unavailable)';

  console.log('[PROBE] artifacts:');
  for (const [key, value] of Object.entries(telemetry.artifacts)) {
    if (value && typeof value === 'object' && 'sha256' in value) console.log(`  ${key}: ${value.sha256} (${value.bytes} bytes)`);
    else if (value && typeof value === 'object' && 'error' in value) console.log(`  ${key}: ERROR ${value.error}`);
    else if (key === 'sourceVsCompiled') console.log(`  ${key}: ${JSON.stringify(value)}`);
  }
  if (telemetry.artifacts.sourceVsCompiled.sourceIsNewerThanCompiled) {
    warn('compiled-artifact-predates-working-tree', telemetry.artifacts.sourceVsCompiled);
  }
  console.log(`[PROBE] projection available: ${telemetry.projection.available}${telemetry.projection.error ? ` (${telemetry.projection.error})` : ''}`);

  for (const scenarioId of Object.keys(SCENARIOS)) {
    const built = buildPayload(scenarioId);
    telemetry.payloads[scenarioId] = {
      via: built.via,
      expectedByProbe: SCENARIOS[scenarioId].expectation,
      sha256: sha256Text(JSON.stringify(built.delivered)),
      delivered: built.delivered,
    };
  }

  installIpc();

  win = new BrowserWindow({
    width: 1200,
    height: 760,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.webContents.on('console-message', (...args) => {
    // Electron >= 35 delivers one event object; older versions deliver (event, level, message, ...).
    let level;
    let message;
    const maybeEvent = args[0];
    if (maybeEvent && typeof maybeEvent === 'object' && typeof maybeEvent.message === 'string') {
      // Electron >= 35 object form.
      level = maybeEvent.level;
      message = maybeEvent.message;
    } else if (args[1] && typeof args[1] === 'object' && typeof args[1].message === 'string') {
      level = args[1].level;
      message = args[1].message;
    } else {
      // Legacy (event, level, message, line, sourceId) form.
      level = args[1];
      message = args[2];
    }
    const record = { level: level === undefined ? null : String(level), message: message === undefined ? null : String(message) };
    if (record.message && record.message.indexOf('Insecure Content-Security-Policy') !== -1) return;
    telemetry.rendererLogs.push(record);
    if (String(record.level || '').toLowerCase().indexOf('error') !== -1) telemetry.consoleErrors.push(record);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    telemetry.findings.push({ id: 'render-process-gone', severity: 'FATAL', observed: details });
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    telemetry.findings.push({ id: 'preload-error', severity: 'FATAL', observed: { preloadPath, error: String(error) } });
  });

  console.log(`[PROBE] loading ${path.relative(ROOT, HTML_PATH)} with preload ${path.relative(ROOT, PRELOAD_PATH)}`);
  await win.loadFile(HTML_PATH);

  const bootResult = await win.webContents.executeJavaScript(bootScript(), true);
  telemetry.boot = bootResult;
  console.log('[PROBE] boot telemetry:');
  console.log(JSON.stringify({
    location: bootResult.location,
    readyState: bootResult.readyState,
    hasBridge: bootResult.hasBridge,
    hasGetMcpDispatchState: bootResult.hasGetMcpDispatchState,
    navButton: bootResult.navButton,
    baselineCensus: bootResult.baselineCensus,
    scannerSelfTest: bootResult.scannerSelfTest,
    readyWait: bootResult.readyWait,
  }, null, 2));

  assertBoot(bootResult);

  if (!bootResult.hasGetMcpDispatchState) {
    telemetry.findings.push({
      id: 'boot-blocked',
      severity: 'FATAL',
      observed: 'the real preload did not expose window.antifanToolbar.getMcpDispatchState; '
        + 'the dispatch tab cannot be driven, so no rendering assertion can be made',
    });
    finish(1);
    return;
  }

  for (const scenarioId of Object.keys(SCENARIOS)) {
    currentScenario = scenarioId;
    console.log(`[PROBE] scenario ${scenarioId} (payload via ${telemetry.payloads[scenarioId].via})`);
    const result = await win.webContents.executeJavaScript(scenarioScript(scenarioId), true);
    telemetry.scenarios[scenarioId] = {
      expectation: SCENARIOS[scenarioId].expectation,
      payloadSha256: telemetry.payloads[scenarioId].sha256,
      payloadVia: telemetry.payloads[scenarioId].via,
      result,
    };
    if (scenarioId === 'A-measured-truncated') assertScenarioA(scenarioId, result);
    else if (scenarioId === 'B-unmeasured-no-census') assertScenarioB(scenarioId, result);
    else if (scenarioId === 'C-unmeasured-with-census') assertScenarioC(scenarioId, result);
    else if (scenarioId === 'D1-hostile-projected') assertScenarioD1(scenarioId, result);
    else if (scenarioId === 'D2-hostile-raw') assertScenarioD2(scenarioId, result);
  }

  assert(
    'route-1-dispatch-channel-invoked',
    dispatchInvocations >= Object.keys(SCENARIOS).length,
    `the seeded handler for ${DISPATCH_CHANNEL} was invoked at least once per scenario`,
    { dispatchInvocations, scenarios: Object.keys(SCENARIOS).length },
  );
  assert(
    'route-2-real-projection-available',
    telemetry.projection.available === true,
    'the compiled Phase-4 projectEnvelope was loaded and used for the projected scenarios',
    { available: telemetry.projection.available, error: telemetry.projection.error, module: path.relative(ROOT, SERVICE_PATH) },
  );

  const fatalConsole = telemetry.consoleErrors.filter((entry) => entry.message && entry.message.indexOf('No handler registered') !== -1);
  if (fatalConsole.length) warn('renderer-console-no-handler', fatalConsole);
  if (telemetry.rendererLogs.length) {
    console.log(`[PROBE] captured ${telemetry.rendererLogs.length} renderer console message(s)`);
  }

  finish();
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('[PROBE] FATAL:', err && err.stack ? err.stack : err);
    telemetry.findings.push({ id: 'probe-exception', severity: 'FATAL', observed: String((err && err.stack) || err) });
    finish(1);
  });
});

process.on('uncaughtException', (err) => {
  console.error('[PROBE] uncaughtException:', err && err.stack ? err.stack : err);
  telemetry.findings.push({ id: 'uncaught-exception', severity: 'FATAL', observed: String((err && err.stack) || err) });
  finish(1);
});
