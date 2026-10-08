#!/usr/bin/env node
/**
 * Per-tool latency benchmark of the full AntiFan MCP surface, measured end to end
 * through the real stdio proxy (scripts/antifan-omp-mcp.cjs) — the exact path an
 * agent's tool call takes: stdio JSON-RPC → proxy → bridge WebSocket → control plane
 * → BrowserControlPort/CockpitPort → NativeTabHost → Chromium WebContents.
 *
 * Two modes share one plan and one report shape:
 *
 * - live (this file run directly, inside an AntiFan terminal): the proxy pairs with
 *   the running desktop app. The benchmark tab needs the terminal's project to own a
 *   window; tab-free tools still run when it does not. Tools that would touch the
 *   user's windows or durable registers are skipped with the reason. `--tab <id>`
 *   measures on an existing tab instead (any tab the session may rebind to): its own
 *   URL is the navigate/reload target, generic selectors replace the synthetic
 *   storefront's ids, click/type/drop steps are skipped, and the tab stays open
 *   with its viewport restored.
 * - electron (scripts/benchmark-mcp-electron.cjs, `npm run benchmark:mcp`): a private
 *   Electron process wires the production port stack against its own window and a
 *   throwaway data root, so every WebContents tool — including activation, rebinding,
 *   frames, drop and the verification register — is measured without touching the app.
 *
 * Usage: node scripts/benchmark-mcp-tools.mjs [--samples N] [--only <substring>] [--tab <tabId>] [--out <path>]
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY = path.join(ROOT, 'scripts', 'antifan-omp-mcp.cjs');
const SCRATCH_DIR = path.join(ROOT, '.bench-tmp');

export function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ---------- synthetic storefront ----------
function storefrontHtml() {
  const cards = Array.from({ length: 120 }, (_, i) => `
    <article class="card" data-id="${i}">
      <img alt="Product ${i}" width="240" height="240" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Crect width='240' height='240' fill='%23${((i * 2654435761) >>> 8).toString(16).padStart(6, '0').slice(0, 6)}'/%3E%3C/svg%3E">
      <h3 class="card-title">Product ${i}</h3>
      <p class="price">${(100000 + i * 1000).toLocaleString('en-US')} VND</p>
      <button class="add" type="button">Add</button>
    </article>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Bench Storefront</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { --gap: 16px; --accent: #2563eb; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #fafafa; }
  header { position: sticky; top: 0; background: #fff; padding: 12px 24px; border-bottom: 1px solid #e5e7eb; display: flex; gap: 16px; align-items: center; }
  h1 { font-size: 20px; margin: 0; }
  main { padding: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--gap); }
  .card { background: #fff; border-radius: 8px; padding: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  .card img { width: 100%; height: auto; display: block; }
  .add { background: var(--accent); color: #fff; border: 0; padding: 8px 12px; border-radius: 6px; cursor: pointer; }
  #drop-zone { padding: 8px; border: 1px dashed #94a3b8; }
  iframe { width: 320px; height: 80px; border: 1px solid #e5e7eb; }
  footer { padding: 32px 24px; background: #111827; color: #e5e7eb; }
  @media (max-width: 640px) { main { padding: 12px; } header { flex-wrap: wrap; } }
</style></head>
<body>
  <header><h1 id="title">Bench Storefront</h1>
    <input id="search" type="search" placeholder="Search products">
    <input id="price" type="range" min="0" max="100" value="20">
    <input id="upload" type="file">
    <div id="drop-zone">Drop files</div>
    <span id="cart-count">0</span>
  </header>
  <iframe id="promo" src="/frame/promo" title="Promo"></iframe>
  <main><section class="grid">${cards}</section></main>
  <footer><p>Footer newsletter</p></footer>
  <script>
    document.addEventListener('click', (e) => {
      if (e.target.classList && e.target.classList.contains('add')) {
        const c = document.getElementById('cart-count'); c.textContent = String(Number(c.textContent) + 1);
      }
    });
    const zone = document.getElementById('drop-zone');
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.textContent = 'Dropped ' + e.dataTransfer.files.length; });
  </script>
</body></html>`;
}
const FRAME_HTML = '<!DOCTYPE html><html><head><title>Promo frame</title></head><body><p id="promo-text">Free shipping</p></body></html>';

export function startStorefront() {
  const server = http.createServer((req, res) => {
    const body = req.url && req.url.startsWith('/frame/') ? FRAME_HTML : storefrontHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/collections/all` })));
}

// ---------- MCP stdio client ----------
function wrapProxy(child) {
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve({ msg, bytes: Buffer.byteLength(line, 'utf8') });
      }
    }
  });
  child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 65536) stderr = stderr.slice(-32768); });
  let nextId = 1;
  function request(method, params, timeoutMs = 60_000) {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ msg: { error: { code: 'BENCH_TIMEOUT', message: `no response after ${timeoutMs}ms` } }, bytes: 0, timedOut: true });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return { child, request, stderrTail: () => stderr.slice(-2000) };
}

/** The proxy as an AntiFan terminal launches it: ambient env, bridge discovered from terminal context. */
function spawnLiveProxy() {
  return spawn(process.execPath, [PROXY], { cwd: ROOT, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
}

function responseText(msg) {
  const content = msg?.result?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

function errorCodeOf(msg, timedOut) {
  if (timedOut) return 'BENCH_TIMEOUT';
  if (msg?.error) return String(msg.error.code ?? 'JSONRPC_ERROR');
  if (!msg?.result?.isError) return null;
  const text = responseText(msg);
  const m = text.match(/"code"\s*:\s*"([A-Z][A-Z0-9_]+)"/) || text.match(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/);
  return m ? m[1] : 'TOOL_ERROR';
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
const round = (n) => (n == null ? null : Math.round(n * 10) / 10);
// sendCdpCommand releases a draining target only once it has drained for >5000ms.
const DRAIN_WINDOW_MS = 5_500;

// ---------- benchmark plan ----------
// args() returns the call arguments; samples overrides the default for slow/heavy tools;
// capture(msg) records ids later tools need (baseline, artifact, claim); isolatedOnly
// marks tools only the private Electron harness may exercise.
function plan(ctx) {
  const t = () => ({ tabId: ctx.tabId });
  // On a user tab (--tab) the synthetic storefront's ids do not exist: inspect
  // elements every storefront has, and never click/type/drop into the user's page.
  const sel = ctx.userTab
    ? { card: 'img', title: 'a', add: 'a', grid: 'body', search: 'input', price: 'a', cart: 'a', product: 'sau-rieng-1' }
    : { card: '.card', title: '#title', add: '.card .add', grid: '.grid', search: '#search', price: '#price', cart: '#cart-count', product: 'winter-parka' };
  const outFile = (name) => path.join(ctx.scratchDir, name);
  const captureIds = (msg) => {
    const text = responseText(msg);
    const baseline = text.match(/"(?:baselineRef|baselineScreenshotRef|baselineId)"\s*:\s*"([^"]+)"/);
    if (baseline) ctx.baselineRef = baseline[1];
    const artifact = text.match(/"(?:artifactId|screenshotArtifactId|screenshotRef|domArtifactId)"\s*:\s*"([^"]+)"/);
    if (artifact) ctx.artifactId = artifact[1];
    // record_claim answers the register row: its claim id is `id: "CLM-..."`.
    const claim = text.match(/"(?:claimId|id)"\s*:\s*"(CLM-[^"]+)"/);
    if (claim) ctx.claimId = claim[1];
  };
  // promote_baseline answers a VisualBaselineRef (baseline-authority.ts): the ref is its `id`.
  const captureBaseline = (msg) => {
    const ref = parseJson(responseText(msg));
    if (ref?.id && ref?.sha256 && ref?.sourceArtifactId) ctx.baselineRef = ref.id;
  };
  return [
    // tab + navigation
    { name: 'anti.browser.tabs.list', args: () => ({}) },
    { name: 'anti.browser.tabs.get', args: t },
    { name: 'anti.browser.tabs.activate', args: t, isolatedOnly: true },
    { name: 'anti.browser.set_automation_target', args: t, isolatedOnly: true },
    { name: 'anti.browser.rebind_target', args: t, isolatedOnly: true },
    { name: 'anti.browser.get_viewport', args: t },
    { name: 'browser.get-viewport', args: t },
    { name: 'anti.browser.navigate', args: () => ({ ...t(), url: ctx.url }), samples: 3 },
    { name: 'anti.browser.reload', args: t, samples: 3 },
    { name: 'browser.wait', label: 'browser.wait#dom-stable', args: () => ({ ...t(), condition: 'dom-stable', timeoutMs: 5000 }) },
    { name: 'browser.wait', label: 'browser.wait#selector', args: () => ({ ...t(), condition: 'selector', selector: sel.card, timeoutMs: 5000 }) },
    { name: 'browser.wait', label: 'browser.wait#network', args: () => ({ ...t(), condition: 'network', timeoutMs: 5000 }) },
    { name: 'browser.wait', label: 'browser.wait#images-settled', args: () => ({ ...t(), condition: 'images-settled', timeoutMs: 5000 }) },
    { name: 'anti.browser.set_viewport', args: () => ({ ...t(), width: 1280, height: 800 }), samples: 3 },
    { name: 'browser.set-viewport', args: () => ({ ...t(), width: 1280, height: 800 }), samples: 3 },
    // DOM / CSS inspection
    { name: 'anti.inspect.dom', args: t },
    { name: 'anti.inspect.dom', label: 'anti.inspect.dom#selector', args: () => ({ ...t(), selector: sel.card }) },
    { name: 'anti.inspect.snapshot', args: t },
    { name: 'anti.inspect.snapshot', label: 'anti.inspect.snapshot#viewportOnly', args: () => ({ ...t(), viewportOnly: true }) },
    { name: 'anti.inspect.styles', args: () => ({ ...t(), selector: sel.card }) },
    { name: 'anti.inspect.matched_styles', args: () => ({ ...t(), selector: sel.card }) },
    { name: 'anti.inspect.region', args: () => ({ ...t(), x: 0, y: 0, width: 800, height: 600 }) },
    { name: 'anti.inspect.page_inventory', args: t },
    { name: 'anti.inspect.style_diff', args: () => ({ ...t(), selector: sel.title, comparisonSelector: sel.card }) },
    { name: 'anti.inspect.responsive_matrix', args: () => ({ ...t(), selector: sel.grid }), samples: 2 },
    { name: 'anti.theme.resolve_element', args: () => ({ ...t(), selector: sel.title }) },
    { name: 'anti.browser.evaluate', args: () => ({ ...t(), expression: 'document.title' }) },
    { name: 'anti.browser.evaluate', label: 'anti.browser.evaluate#bulk', args: () => ({ ...t(), expression: `[...document.querySelectorAll(${JSON.stringify(sel.card)})].map(c => c.textContent.trim())` }) },
    { name: 'anti.browser.evaluate_frame', args: () => ({ ...t(), frameUrl: '/frame/promo', expression: 'document.getElementById("promo-text").textContent' }), isolatedOnly: true },
    // capture + visual
    { name: 'anti.screenshot.viewport', args: () => ({ ...t(), format: 'jpeg', quality: 70 }), capture: captureIds },
    { name: 'anti.screenshot.viewport', label: 'anti.screenshot.viewport#png', args: () => ({ ...t(), format: 'png' }) },
    // full_page stages PNG evidence only; jpeg is refused with INVALID_ARGUMENT.
    { name: 'anti.screenshot.full_page', args: () => ({ ...t(), format: 'png' }), samples: 3, capture: captureIds },
    // Lazy loaders that only swap data-src on user interaction refuse the plain
    // capture/export forever; the opt-in swaps them first and is timed separately.
    { name: 'anti.screenshot.full_page', label: 'anti.screenshot.full_page#materializeDataSrc', args: () => ({ ...t(), format: 'png', materializeDataSrc: true }), samples: 3, capture: captureIds },
    { name: 'anti.reference.capture', args: () => ({ ...t(), screenshot: false }), samples: 3, capture: captureIds },
    { name: 'anti.reference.capture', label: 'anti.reference.capture#screenshot', args: () => ({ ...t(), screenshot: true, format: 'jpeg', quality: 70 }), samples: 3, capture: captureIds },
    { name: 'anti.visual.promote_baseline', args: t, samples: 2, capture: captureBaseline },
    { name: 'browser.promote-baseline', args: t, samples: 2, capture: captureBaseline },
    { name: 'anti.visual.compare', args: () => ({ ...t(), baselineRef: ctx.baselineRef }), samples: 3, needs: () => ctx.baselineRef, needsWhy: 'no promoted baseline to compare against' },
    { name: 'anti.visual.compare', label: 'anti.visual.compare#fullPage', args: () => ({ ...t(), fullPage: true, baselineRef: ctx.baselineRef }), samples: 3, needs: () => ctx.baselineRef, needsWhy: 'no promoted baseline to compare against' },
    { name: 'anti.media.freeze', args: () => ({ ...t(), freeze: true }) },
    { name: 'anti.media.freeze', label: 'anti.media.freeze#unfreeze', args: () => ({ ...t(), freeze: false }) },
    { name: 'anti.theme.style_override', args: () => ({ ...t(), operation: 'apply', id: 'bench', css: 'footer{outline:1px solid red}' }) },
    { name: 'theme.style_override', args: () => ({ ...t(), operation: 'remove', id: 'bench' }) },
    { name: 'anti.browser.dump_dom', args: () => ({ ...t(), outputPath: outFile('dom.html') }), samples: 3 },
    { name: 'anti.browser.dump_dom', label: 'anti.browser.dump_dom#materializeDataSrc', args: () => ({ ...t(), outputPath: outFile('dom-materialized.html'), materializeDataSrc: true }), samples: 3 },
    { name: 'anti.theme.export_clean', args: () => ({ ...t(), outputPath: outFile('clean.html') }), samples: 3 },
    { name: 'anti.theme.export_clean', label: 'anti.theme.export_clean#materializeDataSrc', args: () => ({ ...t(), outputPath: outFile('clean-materialized.html'), materializeDataSrc: true }), samples: 3 },
    { name: 'anti.artifact.stat', args: () => ({ artifactId: ctx.artifactId }), needs: () => ctx.artifactId, needsWhy: 'no artifact id surfaced by capture tools' },
    { name: 'anti.artifact.read', args: () => ({ artifactId: ctx.artifactId, limit: 32768 }), needs: () => ctx.artifactId, needsWhy: 'no artifact id surfaced by capture tools' },
    // agent input
    { name: 'anti.agent.cursor.move', args: () => ({ ...t(), selector: sel.title }) },
    { name: 'anti.agent.cursor.hover', args: () => ({ ...t(), selector: sel.add }) },
    { name: 'anti.agent.cursor.highlight', args: () => ({ ...t(), selector: sel.grid, label: 'bench' }) },
    { name: 'anti.agent.cursor.clear', args: t },
    { name: 'anti.agent.cursor.click', args: () => ({ ...t(), selector: sel.add }), mutatesPage: true },
    { name: 'anti.agent.cursor.type', args: () => ({ ...t(), selector: sel.search, text: 'parka', clear: true }), mutatesPage: true },
    { name: 'anti.agent.cursor.scroll', args: () => ({ ...t(), deltaY: 400 }) },
    { name: 'anti.agent.drag', args: () => ({ ...t(), fromSelector: sel.price, toSelector: sel.cart, steps: 5 }), mutatesPage: true },
    // Upload/drop resolve the tab's workspace fail-closed (NativeTabHost.resolveTabStrictWorkspace):
    // only a tab bound to a terminal session or a known-shop URL has one, so live mode only.
    { name: 'anti.agent.file_upload', args: () => ({ ...t(), refOrSelector: '#upload', filePaths: [path.join(ROOT, 'package.json')] }), liveOnly: true, mutatesPage: true },
    { name: 'anti.agent.drop', args: () => ({ ...t(), refOrSelector: '#drop-zone', filePaths: [path.join(ROOT, 'package.json')] }), liveOnly: true, mutatesPage: true },
    { name: 'anti.trace.interaction', args: () => ({ ...t(), action: 'hover', selector: sel.add, settleMs: 50 }) },
    { name: 'anti.agent.sequence', args: () => ({ ...t(), actions: [{ type: 'scroll', deltaY: 300 }, { type: 'hover', selector: sel.title }, { type: 'wait', waitMs: 10 }] }) },
    // theme QA (synthetic page is not a Haravan/Shopify theme: measures the detect + refusal path)
    { name: 'theme.debug_bundle', args: t, samples: 3 },
    { name: 'anti.theme.debug_bundle', args: t, samples: 3 },
    // Offline: reads the authoritative workspace on disk, no tab.
    { name: 'theme.settings_check', args: () => ({}), samples: 3 },
    { name: 'theme.assert_cart', args: t },
    { name: 'theme.resolve_product', args: () => ({ ...t(), handle: sel.product }), samples: 3 },
    { name: 'storefront.resolve_product', args: () => ({ ...t(), handle: sel.product }), samples: 3 },
    { name: 'theme.qa_validate', args: t, samples: 2, timeoutMs: 180_000 },
    { name: 'anti.theme.qa_validate', args: t, samples: 2, timeoutMs: 180_000 },
    { name: 'theme.cockpit_list', args: t },
    { name: 'theme.cockpit_findings', args: t },
    { name: 'theme.cockpit_report', args: t },
    { name: 'anti.spec.validate_gate', args: () => ({ specTabId: ctx.tabId, targetTabId: ctx.tabId }), samples: 2 },
    // verification register
    { name: 'anti.verification.record_claim', args: () => ({ ...t(), claim: 'bench grid renders 120 cards', category: 'LAYOUT', actor: 'agent', selector: '.grid', expectedHeight: 4000, tolerance: 0.5 }), capture: captureIds, isolatedOnly: true },
    // A claim verifies once per run attempt: a repeat answers POLICY_DENIED (STALEMATE), so only the cold call is timed.
    { name: 'anti.verification.verify_claim', args: () => ({ claimId: ctx.claimId }), samples: 0, needs: () => ctx.claimId, needsWhy: 'record_claim surfaced no claimId', isolatedOnly: true },
    { name: 'anti.verification.list', args: () => ({ limit: 5 }) },
    // workspace / host
    { name: 'file.read', args: () => ({ path: 'package.json', maxBytes: 4096 }) },
    // The isolated runtime is wired without host tab authority and without a device
    // adapter, so these refuse by construction there; only live mode times them.
    { name: 'terminal.list', args: () => ({}), liveOnly: true },
    { name: 'device.list', args: () => ({}), liveOnly: true },
    { name: 'device.status', args: () => ({}), liveOnly: true },
    // Super Core (local SQLite inside the proxy) — read paths
    { name: 'core.stats', args: () => ({}) },
    { name: 'core.health', args: () => ({}) },
    { name: 'core.query', args: () => ({ text: 'theme', limit: 10 }) },
    { name: 'core.context_pack', args: () => ({ task: 'benchmark mcp latency', limit: 10 }) },
    { name: 'core.context_pack_v2', args: () => ({ task: 'benchmark mcp latency', limit: 10 }) },
    { name: 'core.recommend', args: () => ({ task: 'benchmark mcp latency' }) },
    { name: 'core.find_similar', args: () => ({ task: 'benchmark mcp latency', limit: 10 }) },
    { name: 'core.reuse_metric', args: () => ({ task: 'benchmark mcp latency' }) },
    { name: 'core.classify_uncertainty', args: () => ({ task: 'benchmark mcp latency' }) },
    { name: 'core.domain', args: () => ({ name: 'theme' }) },
    { name: 'core.decay_check', args: () => ({}) },
    { name: 'core.corpus_audit', args: () => ({}) },
    { name: 'core.knowledge_gaps', args: () => ({}) },
    { name: 'core.candidates', args: () => ({ limit: 10 }) },
    { name: 'core.check_phase_gate', args: () => ({ phase: 'benchmark', gate: 'coverage' }) },
    { name: 'core.experience_chain', args: () => ({ fromNodeId: 'bench-missing-node', depth: 2 }) },
    { name: 'core.anti_patterns', args: () => ({}) },
    { name: 'core.workarounds', args: () => ({}) },
    { name: 'core.fix_patterns', args: () => ({ limit: 10 }) },
    { name: 'core.principles', args: () => ({}) },
    { name: 'core.hidden_requirements', args: () => ({}) },
    { name: 'core.commercial_intel', args: () => ({}) },
    { name: 'core.tool_intel', args: () => ({}) },
    { name: 'core.archetypes', args: () => ({}) },
    { name: 'core.platform_semantics', args: () => ({}) },
    { name: 'core.practice_parity', args: () => ({}) },
    { name: 'core.skill_genealogy', args: () => ({ skillId: 'bench-missing-skill' }) },
  ];
}

// Never exercised: they act on state outside any benchmark scope in both modes.
const SKIPPED = {
  'anti.telemetry.record_fallback': 'appends fallback telemetry rows to the shared telemetry store',
  'theme.cockpit_mark': 'mutates a theme checklist scope on disk',
  'theme.cockpit_mark_page': 'mutates a theme checklist scope on disk',
  'theme.cockpit_add_item': 'mutates a theme checklist scope on disk',
  'theme.cockpit_remove_item': 'mutates a theme checklist scope on disk',
  'theme.cockpit_scan': 'navigates through checklist routes of a real theme workspace',
  'file.write': 'writes workspace files',
  'terminal.create': 'spawns a terminal process in the app',
  'terminal.write': 'writes into a live terminal',
  'terminal.resize': 'resizes a live terminal',
  'terminal.wait': 'blocks on a live terminal session',
  'terminal.close': 'kills a terminal process tree',
  'device.open_safari': 'drives a physical iOS device',
  'device.navigate': 'drives a physical iOS device',
  'device.reload': 'drives a physical iOS device',
  'device.screenshot': 'drives a physical iOS device',
  'device.tap': 'drives a physical iOS device',
  'device.swipe': 'drives a physical iOS device',
  'device.type': 'drives a physical iOS device',
  'device.wait': 'drives a physical iOS device',
};
const CORE_WRITE = /^core\.(record_|ingest_outcome|adjudicate|receipt|invalidate|revoke|snapshot|rollback|resolve_conflict|replay_regression)/;
// Tools that never address a browser tab: they run even when no benchmark tab exists.
const TAB_FREE = /^(core\.|file\.|terminal\.|device\.|anti\.verification\.list$|anti\.browser\.tabs\.list$)/;
// Measured separately by the tab-lifecycle probe.
const LIFECYCLE = new Set(['anti.browser.tabs.create', 'anti.browser.tabs.close']);

/**
 * @param {object} opts
 * @param {'live'|'electron'} opts.mode
 * @param {() => import('node:child_process').ChildProcess} opts.spawnProxy
 * @param {string} opts.url storefront URL the benchmark tab loads
 * @param {object} [opts.tabCreateArgs] extra arguments for the benchmark tab's tabs.create
 * @param {string} [opts.tab] an existing tab to measure on instead of creating one: the
 *   session rebinds to it, navigate/reload target its current URL, and it is left open.
 */
export async function runBenchmark({ mode, spawnProxy, url, tab = '', tabCreateArgs = {}, scratchDir = SCRATCH_DIR, samples, only, out }) {
  const isolated = mode === 'electron';
  // dump_dom / export_clean refuse an outputPath outside the session's workspace root.
  fs.mkdirSync(scratchDir, { recursive: true });
  const ctx = { url, scratchDir, tabId: null, userTab: Boolean(tab), baselineRef: null, artifactId: null, claimId: null };
  // set_viewport is measured on the user tab too; its size is put back afterwards.
  let userViewport = null;
  const startedAt = performance.now();
  const proxy = wrapProxy(spawnProxy());
  const report = {
    timestamp: new Date().toISOString(),
    mode,
    platform: process.platform,
    runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`,
    samplesPerTool: samples,
    target: url,
    proxy: {},
    tabLifecycle: null,
    concurrency: null,
    tools: [],
    skipped: [],
  };

  try {
    let t0 = performance.now();
    const init = await proxy.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'antifan-mcp-bench', version: '1' } }, 30_000);
    report.proxy.initializeMs = round(performance.now() - t0);
    if (init.msg.error) throw new Error(`initialize failed: ${JSON.stringify(init.msg.error)}`);
    proxy.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    t0 = performance.now();
    const list = await proxy.request('tools/list', {});
    report.proxy.toolsListMs = round(performance.now() - t0);
    report.proxy.toolsListBytes = list.bytes;
    const catalog = list.msg.result?.tools ?? [];
    report.proxy.toolCount = catalog.length;
    const advertised = new Set(catalog.map((x) => x.name));

    // First bridge call pays session pairing/autoheal: time it separately.
    t0 = performance.now();
    if (tab) {
      const bound = await proxy.request('tools/call', { name: 'anti.browser.rebind_target', arguments: { tabId: tab } });
      report.proxy.firstBridgeCallMs = round(performance.now() - t0);
      const bindErr = errorCodeOf(bound.msg, bound.timedOut);
      if (bindErr) throw new Error(`rebind to --tab ${tab} failed (${bindErr}): ${responseText(bound.msg).slice(0, 300)}`);
      const info = parseJson(responseText(bound.msg));
      if (!info?.url) throw new Error(`rebind_target returned no url for ${tab}: ${responseText(bound.msg).slice(0, 300)}`);
      ctx.tabId = tab;
      ctx.url = info.url;
      report.tabId = tab;
      report.target = info.url;
      const vp = await proxy.request('tools/call', { name: 'anti.browser.get_viewport', arguments: { tabId: tab } });
      const vpInfo = parseJson(responseText(vp.msg));
      if (vpInfo?.width > 0 && vpInfo?.height > 0) userViewport = { width: vpInfo.width, height: vpInfo.height };
    } else {
      const created = await proxy.request('tools/call', { name: 'anti.browser.tabs.create', arguments: { url, ...tabCreateArgs } });
      report.proxy.firstBridgeCallMs = round(performance.now() - t0);
      const createErr = errorCodeOf(created.msg, created.timedOut);
      if (createErr) {
        // Live mode: the session's project comes from the terminal's project assignment; an
        // unassigned terminal gets the boot project, which owns no window. Tab-free tools
        // still run and are still worth timing.
        report.tabBlocked = `${createErr}: ${(responseText(created.msg) || JSON.stringify(created.msg.error)).slice(0, 300)}`;
        console.error(`tab tools BLOCKED — ${report.tabBlocked}`);
        if (isolated) throw new Error(`benchmark tab creation failed in the isolated harness: ${report.tabBlocked}`);
      } else {
        ctx.tabId = parseJson(responseText(created.msg))?.tabId;
        if (!ctx.tabId) throw new Error(`anti.browser.tabs.create returned no tabId: ${responseText(created.msg).slice(0, 300)}`);
        report.tabId = ctx.tabId;
        await proxy.request('tools/call', { name: 'browser.wait', arguments: { tabId: ctx.tabId, condition: 'document_loaded', timeoutMs: 10_000 } });
      }
    }

    const steps = plan(ctx).filter((s) => !only || (s.label ?? s.name).includes(only));
    for (const step of steps) {
      const label = step.label ?? step.name;
      if (!advertised.has(step.name)) {
        report.skipped.push({ tool: label, reason: 'not advertised by tools/list' });
        continue;
      }
      if (step.isolatedOnly && !isolated) {
        report.skipped.push({ tool: label, reason: 'live mode: acts on the shared session or durable registers (measured by the isolated Electron harness)' });
        continue;
      }
      if (step.liveOnly && isolated) {
        report.skipped.push({ tool: label, reason: 'isolated harness: no host tab authority / device adapter wired (measured in live mode)' });
        continue;
      }
      if (!ctx.tabId && !TAB_FREE.test(step.name)) {
        report.skipped.push({ tool: label, reason: `no benchmark tab (${report.tabBlocked?.split(':')[0]})` });
        continue;
      }
      if (step.mutatesPage && ctx.userTab) {
        report.skipped.push({ tool: label, reason: 'would click/type/drop into the user tab (--tab); measured on the synthetic storefront' });
        continue;
      }
      if (step.needs && !step.needs()) {
        report.skipped.push({ tool: label, reason: step.needsWhy });
        continue;
      }
      const n = step.samples ?? samples;
      const timeoutMs = step.timeoutMs ?? 60_000;
      const call = () => proxy.request('tools/call', { name: step.name, arguments: step.args() }, timeoutMs);

      // A CAPTURE_TIMEOUT leaves the target draining for DRAIN_WINDOW_MS
      // (tab-devtools-host.ts sendCdpCommand); every CDP call inside that window is
      // refused in ~4ms. Waiting it out keeps one hung capture from being recorded as
      // a fast refusal on this and every following tool.
      const settleAfter = async (r) => {
        if (/CAPTURE_TIMEOUT|TARGET_BUSY_DRAINING/.test(responseText(r.msg))) {
          report.drainWaits = (report.drainWaits ?? 0) + 1;
          await new Promise((res) => setTimeout(res, DRAIN_WINDOW_MS));
        }
      };
      let s = performance.now();
      const cold = await call();
      const coldMs = performance.now() - s;
      step.capture?.(cold.msg);
      const timings = [];
      const errors = {};
      let bytes = cold.bytes;
      let errorSample = null;
      const coldErr = errorCodeOf(cold.msg, cold.timedOut);
      if (coldErr) {
        errors[coldErr] = 1;
        errorSample = responseText(cold.msg) || JSON.stringify(cold.msg.error ?? '');
      }
      await settleAfter(cold);
      for (let i = 0; i < n; i++) {
        s = performance.now();
        const r = await call();
        timings.push(performance.now() - s);
        bytes = Math.max(bytes, r.bytes);
        step.capture?.(r.msg);
        const code = errorCodeOf(r.msg, r.timedOut);
        if (code) {
          errors[code] = (errors[code] ?? 0) + 1;
          errorSample ??= responseText(r.msg) || JSON.stringify(r.msg.error ?? '');
        }
        await settleAfter(r);
      }
      const sorted = [...timings].sort((a, b) => a - b);
      const failed = Object.values(errors).reduce((a, b) => a + b, 0);
      const row = {
        tool: label,
        status: failed === 0 ? 'OK' : failed > n ? 'ERROR' : 'PARTIAL',
        coldMs: round(coldMs),
        p50Ms: round(percentile(sorted, 50)),
        p95Ms: round(percentile(sorted, 95)),
        maxMs: round(sorted[sorted.length - 1]),
        samples: n,
        maxResponseBytes: bytes,
        ...(failed ? { errors, errorSample: errorSample.slice(0, 240) } : {}),
      };
      report.tools.push(row);
      console.log(`${row.status.padEnd(7)} ${label.padEnd(42)} cold ${String(row.coldMs).padStart(8)}ms  p50 ${String(row.p50Ms).padStart(8)}ms  p95 ${String(row.p95Ms).padStart(8)}ms  ${String(bytes).padStart(9)}B${row.errors ? '  ' + JSON.stringify(row.errors) : ''}`);
    }

    // Tab lifecycle: create a background tab and close it, N times. Isolated mode only —
    // in live mode every created tab lands in a user-visible window strip.
    if (isolated && ctx.tabId && !only) {
      const createMs = [];
      const closeMs = [];
      const errors = {};
      for (let i = 0; i < Math.max(3, samples); i++) {
        let s = performance.now();
        const c = await proxy.request('tools/call', { name: 'anti.browser.tabs.create', arguments: { url, anchorTabId: ctx.tabId } });
        createMs.push(performance.now() - s);
        const cErr = errorCodeOf(c.msg, c.timedOut);
        if (cErr) { errors[`create:${cErr}`] = (errors[`create:${cErr}`] ?? 0) + 1; continue; }
        const childId = parseJson(responseText(c.msg))?.tabId;
        s = performance.now();
        const d = await proxy.request('tools/call', { name: 'anti.browser.tabs.close', arguments: { tabId: childId } });
        closeMs.push(performance.now() - s);
        const dErr = errorCodeOf(d.msg, d.timedOut);
        if (dErr) errors[`close:${dErr}`] = (errors[`close:${dErr}`] ?? 0) + 1;
      }
      const stat = (arr) => { const s = [...arr].sort((a, b) => a - b); return { p50Ms: round(percentile(s, 50)), p95Ms: round(percentile(s, 95)) }; };
      report.tabLifecycle = { create: stat(createMs), close: stat(closeMs), ...(Object.keys(errors).length ? { errors } : {}) };
      console.log(`tab lifecycle: create p50 ${report.tabLifecycle.create.p50Ms}ms, close p50 ${report.tabLifecycle.close.p50Ms}ms${Object.keys(errors).length ? ' ' + JSON.stringify(errors) : ''}`);
    }

    // Concurrency: does the transport pipeline parallel calls or serialize them?
    if (!only && ctx.tabId) {
      const N = 8;
      const probe = async (name, args) => {
        let failed = 0;
        const one = async () => {
          const r = await proxy.request('tools/call', { name, arguments: args });
          if (errorCodeOf(r.msg, r.timedOut)) failed++;
        };
        let s = performance.now();
        for (let i = 0; i < N; i++) await one();
        const serialMs = performance.now() - s;
        const serialFailed = failed;
        if (serialFailed) await new Promise((res) => setTimeout(res, DRAIN_WINDOW_MS));
        failed = 0;
        s = performance.now();
        await Promise.all(Array.from({ length: N }, one));
        const parallelMs = performance.now() - s;
        // A speedup is only meaningful when both passes did the work.
        const valid = serialFailed === 0 && failed === 0;
        return { tool: name, calls: N, serialMs: round(serialMs), parallelMs: round(parallelMs), speedup: valid ? round(serialMs / parallelMs) : null, serialFailed, parallelFailed: failed };
      };
      report.concurrency = [
        await probe('anti.browser.get_viewport', { tabId: ctx.tabId }),
        await probe('anti.inspect.styles', { tabId: ctx.tabId, selector: ctx.userTab ? 'img' : '.card' }),
        await probe('anti.screenshot.viewport', { tabId: ctx.tabId, format: 'jpeg', quality: 70 }),
      ];
      for (const c of report.concurrency) console.log(`concurrency x${N} ${c.tool}: serial ${c.serialMs}ms, parallel ${c.parallelMs}ms (${c.speedup == null ? `invalid: failed serial ${c.serialFailed}/${N}, parallel ${c.parallelFailed}/${N}` : `x${c.speedup}`})`);
    }

    const skippedNames = new Set(report.skipped.map((s) => s.tool));
    for (const name of advertised) {
      if (skippedNames.has(name)) continue;
      if (SKIPPED[name]) report.skipped.push({ tool: name, reason: SKIPPED[name] });
      else if (CORE_WRITE.test(name)) report.skipped.push({ tool: name, reason: 'writes the Super Core store' });
    }
    const measured = new Set(report.tools.map((r) => r.tool.split('#')[0]));
    const covered = (n) => measured.has(n) || report.skipped.some((s) => s.tool === n) || (LIFECYCLE.has(n) && (report.tabLifecycle || ctx.tabId));
    report.uncovered = only ? [] : [...advertised].filter((n) => !covered(n));
  } finally {
    if (ctx.tabId && !tab) {
      const s = performance.now();
      const closed = await proxy.request('tools/call', { name: 'anti.browser.tabs.close', arguments: { tabId: ctx.tabId } }, 15_000);
      report.proxy.tabsCloseMs = round(performance.now() - s);
      report.proxy.tabsCloseError = errorCodeOf(closed.msg, closed.timedOut);
    }
    if (userViewport) {
      await proxy.request('tools/call', { name: 'anti.browser.set_viewport', arguments: { tabId: tab, ...userViewport } }, 15_000);
    }
    report.totalMs = round(performance.now() - startedAt);
    report.proxyStderrTail = proxy.stderrTail();
    proxy.child.stdin.end();
    proxy.child.kill();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  report.tools.sort((a, b) => (b.p50Ms ?? 0) - (a.p50Ms ?? 0));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nproxy: initialize ${report.proxy.initializeMs}ms, tools/list ${report.proxy.toolsListMs}ms (${report.proxy.toolsListBytes}B, ${report.proxy.toolCount} tools), first bridge call ${report.proxy.firstBridgeCallMs}ms`);
  console.log(`measured ${report.tools.length}, skipped ${report.skipped.length}, uncovered ${report.uncovered?.length ?? 0}; total ${report.totalMs}ms -> ${path.relative(ROOT, out)}`);
  return report;
}

export function cliOptions(defaultOut) {
  return {
    samples: Math.max(1, parseInt(argValue('--samples', '5'), 10) || 5),
    only: argValue('--only', ''),
    tab: argValue('--tab', ''),
    out: path.resolve(ROOT, argValue('--out', defaultOut)),
  };
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  if (!process.env.ANTIFAN_TERMINAL_SESSION_ID && !process.env.ANTIFAN_BRIDGE_PID) {
    console.error('BLOCKED: no AntiFan terminal context (ANTIFAN_TERMINAL_SESSION_ID / ANTIFAN_BRIDGE_PID). Run inside an AntiFan terminal, or use `npm run benchmark:mcp` for the isolated Electron harness.');
    process.exit(2);
  }
  const { server, url } = await startStorefront();
  try {
    await runBenchmark({ mode: 'live', spawnProxy: spawnLiveProxy, url, ...cliOptions('plans/reports/mcp-tool-latency-live.json') });
  } catch (err) {
    console.error(`BENCHMARK FAILED: ${err?.stack || err}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
}
