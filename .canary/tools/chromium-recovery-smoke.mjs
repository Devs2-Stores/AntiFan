/**
 * Controlled real-Chromium recovery smoke (Phase 4).
 *
 *   node .canary/tools/chromium-recovery-smoke.mjs [--port 7853] [--out <evidence.json>]
 *
 * Runs against the ISOLATED canary instance (never the user's instance) through
 * the bridge, exercising canonical production capabilities only — no browser
 * mock, no test hook. Serves deterministic tall local pages with a known
 * below-fold marker through the hardened static server.
 *
 * Proven live here: capture mode/geometry receipts, >8 MiB byte-exact round-trip,
 * below-fold coverage, over-policy rejection before any ArtifactRef, offscreen
 * full-page rejection, deterministic zero-mask self-compare, pre-dispatch lock
 * cancellation with a succeeding next waiter, and post-dispatch client-timeout
 * quarantine exclusion followed by recovery. Deep adapter-level quarantine and
 * ledger terminalization semantics live in the compiled integration suite
 * (test/integration/execution-control-cancellation.test.ts); this runner never
 * fakes them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = Number(arg('port', '7853'));
const OUT = path.resolve(arg('out', '.canary/smoke/recovery-smoke.json'));
const MAX_ARTIFACT_BYTES = Number(arg('max-artifact-bytes', String(24 * 1024 * 1024)));

// Always bind to the isolated canary session. An ambient ANTIFAN_MCP_BOOTSTRAP
// exported by a developer shell points at the USER's long-running instance
// (bridge 20130); this smoke must never touch it.
const bootFile = path.resolve('.canary/state/canary-session.json');
if (!fs.existsSync(bootFile)) {
  console.error(`no canary session at ${bootFile}: run .canary/tools/canary-session.mjs first`);
  process.exit(2);
}
process.env.ANTIFAN_MCP_BOOTSTRAP = fs.readFileSync(bootFile, 'utf8').trim();

const { call } = await import('./lib-rpc.mjs');

const results = [];
let failures = 0;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const log = (...a) => console.log(...a);

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  if (ok) log(`PASS ${name}`);
  else { failures++; log(`FAIL ${name} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`); }
}

/** Bridge envelopes vary between {…} and {result:{…}}; normalise once. */
const unwrap = (r) => (r && typeof r === 'object' && r.result && typeof r.result === 'object' ? r.result : r);

/** Deterministic high-entropy page: one full-document canvas filled with
 *  xorshift128 noise, so the PNG raster is incompressible and its byte length
 *  scales with the captured area. A repeated tile would let zlib match the
 *  duplicated rows and collapse a document-sized capture by ~3x. */
function noisePage(heightPx, markerTop) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>canary-smoke-${heightPx}</title>
<style>
  html,body{margin:0;padding:0;background:#fff}
  body{height:${heightPx}px;position:relative}
  #noise{position:absolute;top:0;left:0;width:1440px;height:${heightPx}px}
  #below-fold-marker{position:absolute;top:${markerTop}px;left:0;width:200px;height:80px;background:#ff00ff}
  #top-marker{position:absolute;top:0;left:0;width:200px;height:80px;background:#00ffff}
</style></head><body>
<canvas id="noise" width="1440" height="${heightPx}"></canvas>
<div id="top-marker"></div>
<div id="below-fold-marker"></div>
<script>
(() => {
  const W = 1440, H = ${heightPx};
  const c = document.getElementById('noise');
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  let x = 123456789 >>> 0, y = 362436069 >>> 0, z = 521288629 >>> 0, w = 88675123 >>> 0;
  const rnd = () => {
    const t = (x ^ (x << 11)) >>> 0;
    x = y; y = z; z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w;
  };
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rnd() & 0xff; img.data[i + 1] = rnd() & 0xff; img.data[i + 2] = rnd() & 0xff; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  window.__smokeReady = true;
})();
</script></body></html>`;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-smoke-pages-'));
const PAGE_ROUNDTRIP = 'tall-2200.html';
const PAGE_VIEWPORT = 'short-900.html';
// The compare path stages each side with a hard 8 MiB reject ceiling (independent
// of the instance artifact ceiling), so the pair-lock subject must stay under it
// while still taking long enough to hold the lock past a 1.5s waiter budget.
const PAGE_COMPARE = 'compare-1800.html';
// ~23.4 MiB PNG: under the instance's 24 MiB ceiling and the 32 MiB full-page
// stage cap, but slow enough (~2.2s) that a 1.2s client budget expires after
// dispatch, forcing the quarantine/recovery path.
const PAGE_SLOW = 'slow-5400.html';
fs.writeFileSync(path.join(tmp, PAGE_ROUNDTRIP), noisePage(2200, 1800));
fs.writeFileSync(path.join(tmp, PAGE_VIEWPORT), noisePage(900, 850));
fs.writeFileSync(path.join(tmp, PAGE_COMPARE), noisePage(1800, 1400));
fs.writeFileSync(path.join(tmp, PAGE_SLOW), noisePage(5400, 5000));

const server = spawn('node', ['.canary/tools/serve-static.mjs', tmp, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.stderr.write(`[static:err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: PORT, path: p, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

/** Fetch an immutable artifact over the bridge and verify it is a complete PNG.
 *  The endpoint caps one response at 1 MiB, so the runner pages through
 *  `x-artifact-has-more` exactly like the MCP proxy does. */
async function fetchArtifact(artifactId) {
  const boot = JSON.parse(process.env.ANTIFAN_MCP_BOOTSTRAP);
  const CHUNK = 1024 * 1024;
  const chunks = [];
  let offset = 0;
  for (;;) {
    const { buffer, hasMore } = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: boot.port,
          path: `/api/artifacts/${encodeURIComponent(artifactId)}?offset=${offset}&limit=${CHUNK}`,
          headers: { 'x-antifan-attachment-secret': boot.secret },
        },
        (r) => {
          const parts = [];
          r.on('data', (d) => parts.push(d));
          r.on('end', () =>
            r.statusCode === 200
              ? resolve({ buffer: Buffer.concat(parts), hasMore: r.headers['x-artifact-has-more'] === 'true' })
              : reject(new Error(`status ${r.statusCode}`))
          );
        }
      );
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('artifact stream timeout')));
      req.end();
    });
    chunks.push(buffer);
    offset += buffer.length;
    if (!hasMore || buffer.length === 0) break;
  }
  const buf = Buffer.concat(chunks);
  const png = validatePng(buf);
  return { bytes: buf.length, sha256: sha256(buf), png };
}

/** Independent PNG completeness check (signature + IHDR + IEND). */
function validatePng(buf) {
  if (buf.length < 24) return { ok: false, reason: 'too short' };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) return { ok: false, reason: 'bad signature' };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  // The IEND chunk is [length:4][type:'IEND'][crc:4]; the type sits 8..4 bytes
  // from the end, so a complete file ends with the type+CRC pair.
  const hasIend = buf.subarray(-8, -4).toString('latin1') === 'IEND';
  return { ok: hasIend && width > 0 && height > 0, width, height, hasIend, reason: hasIend ? undefined : 'no terminal IEND' };
}

/** Every tab this smoke opens is tracked so the run releases its session tab
 *  budget (10 tabs) even when a check throws. */
const ownedTabs = [];

async function openTab(url) {
  const t = await call('anti.browser.tabs.create', { url, activate: false }, 60_000);
  const tabId = t.tabId || t.result?.tabId;
  if (tabId) ownedTabs.push(tabId);
  return tabId;
}

async function waitReady(tabId, deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const v = await call('anti.browser.evaluate', {
        tabId,
        expression: '({ ready: window.__smokeReady === true, rs: document.readyState, h: document.documentElement.scrollHeight })',
      }, 15_000);
      if (v && v.ready === true && v.rs === 'complete' && v.h > 100) return v;
    } catch { /* page may still be initializing */ }
    if (Date.now() > deadline) throw new Error(`page never ready: ${tabId}`);
    await sleep(400);
  }
}

try {
  // ── 0. server + pages ──────────────────────────────────────────────────────
  await sleep(800);
  // Sweep tabs leaked by an aborted earlier run. Only this smoke's own pages
  // are touched; a failed close is non-fatal (the finally sweep retries).
  const pre = await call('anti.browser.tabs.list', {}, 30_000).catch(() => []);
  for (const t of (Array.isArray(pre) ? pre : (pre?.tabs || []))) {
    if (/127\.0\.0\.1:785[0-9]\//.test(String(t.url || ''))) {
      await call('anti.browser.tabs.close', { tabId: t.id }, 30_000).catch(() => {});
    }
  }
  const probe = await httpGet(`/${PAGE_VIEWPORT}`);
  check('static server serves smoke pages', probe.status === 200 && probe.body.length > 100, { status: probe.status, bytes: probe.body.length });

  const base = `http://127.0.0.1:${PORT}`;
  const viewportTab = await openTab(`${base}/${PAGE_VIEWPORT}`);
  await waitReady(viewportTab);
  await call('browser.set-viewport', { tabId: viewportTab, width: 1440, height: 900, mobile: false, deviceScaleFactor: 1, reload: true }, 30_000);
  await waitReady(viewportTab);

  // ── 1. viewport receipt ────────────────────────────────────────────────────
  const vpShot = await call('anti.screenshot.viewport', { tabId: viewportTab, format: 'png' }, 60_000)
    .then((r) => unwrap(r), (e) => ({ error: String(e.message) }));
  if (vpShot?.error) check('viewport capture receipt', false, vpShot.error);
  else {
    const r = vpShot.receipt || {};
    check('viewport capture receipt', r.captureMode === 'viewport' && r.cssCaptureSize?.width === 1440 && r.rasterSize?.width === 1440 * (r.dpr || 1), { receipt: r });
  }

  // Viewport-only capabilities must refuse fullPage rather than silently degrade.
  for (const cap of ['anti.screenshot.viewport', 'browser.screenshot']) {
    const r = await call(cap, { tabId: viewportTab, fullPage: true, format: 'png' }, 60_000)
      .then((v) => ({ resolved: unwrap(v) }), (e) => ({ error: String(e.message), code: e.code }));
    check(`${cap} rejects fullPage:true with INVALID_ARGUMENT`, Boolean(r.error) && (r.code === 'INVALID_ARGUMENT' || /INVALID_ARGUMENT/i.test(r.error)), r.error ? { code: r.code, error: r.error.slice(0, 160) } : { unexpected: r.resolved?.receipt?.captureMode ?? 'resolved' });
  }

  // ── 2. clip receipt ────────────────────────────────────────────────────────
  const clipShot = await call('anti.visual.compare', {
    tabId: viewportTab, comparisonTabId: viewportTab, tolerance: 2, normalizeScroll: true,
    allowHeightDrift: false, useDefaultWidgetMasks: false, clipRect: { x: 0, y: 0, width: 1440, height: 900 },
  }, 120_000).then((r) => unwrap(r), (e) => ({ error: String(e.message) }));
  check('clipRect compare returns a receipt-bearing result', !clipShot?.error && clipShot?.mismatchPercentage !== undefined, clipShot?.error || { mismatch: clipShot?.mismatchPercentage });

  // ── 3. deterministic zero-mask self-compare ────────────────────────────────
  const self1 = unwrap(await call('anti.visual.compare', {
    tabId: viewportTab, comparisonTabId: viewportTab, fullPage: true, tolerance: 2, normalizeScroll: true,
    allowHeightDrift: false, useDefaultWidgetMasks: false,
  }, 180_000));
  const self2 = unwrap(await call('anti.visual.compare', {
    tabId: viewportTab, comparisonTabId: viewportTab, fullPage: true, tolerance: 2, normalizeScroll: true,
    allowHeightDrift: false, useDefaultWidgetMasks: false,
  }, 180_000));
  const maskLedger = self1.maskResolution || self1.maskAudit || null;
  check('self-compare deterministic at 0%', self1.mismatchPercentage === 0 && self2.mismatchPercentage === 0, { a: self1.mismatchPercentage, b: self2.mismatchPercentage });
  check('self-compare uses no implicit masks', self1.dimensionsMatch === true && (maskLedger ? (maskLedger.implicitMaskCount ?? maskLedger.defaultMaskSelectors?.length ?? 0) === 0 : true), { maskLedger });

  // ── 4. full-page integrity + >8 MiB round-trip ─────────────────────────────
  const tallTab = await openTab(`${base}/${PAGE_ROUNDTRIP}`);
  await waitReady(tallTab);
  await call('browser.set-viewport', { tabId: tallTab, width: 1440, height: 900, mobile: false, deviceScaleFactor: 1, reload: true }, 30_000);
  await waitReady(tallTab);

  const marker = await call('anti.browser.evaluate', {
    tabId: tallTab,
    expression: `(() => { const r = document.getElementById('below-fold-marker').getBoundingClientRect(); return { y: r.y + window.scrollY, h: r.height, docH: document.documentElement.scrollHeight, vh: window.innerHeight }; })()`,
  }, 30_000);
  check('below-fold marker is below the viewport', marker.y > marker.vh, marker);

  const full = unwrap(await call('anti.screenshot.full_page', { tabId: tallTab }, 120_000));
  const receipt = full.receipt || {};
  const dpr = receipt.dpr || 1;
  const zoom = receipt.zoom || 1;
  check('full-page receipt mode', receipt.captureMode === 'full-page', receipt);
  check('full-page cssCaptureSize spans the document', receipt.cssCaptureSize?.height >= marker.docH - 2 && receipt.cssCaptureSize?.width === 1440, { css: receipt.cssCaptureSize, docH: marker.docH });
  check('full-page raster = css * dpr * zoom', Math.abs(receipt.rasterSize.height - receipt.cssCaptureSize.height * dpr * zoom) <= 2 && Math.abs(receipt.rasterSize.width - receipt.cssCaptureSize.width * dpr * zoom) <= 2, { raster: receipt.rasterSize, dpr, zoom });
  check('full-page raster exceeds viewport height', receipt.rasterSize.height > 900 * dpr * zoom, receipt.rasterSize);
  check('below-fold marker inside captured region', marker.y + marker.h <= receipt.cssCaptureSize.height, { markerEnd: marker.y + marker.h, captured: receipt.cssCaptureSize.height });
  const refId = full.artifactRef?.artifactId || full.artifactRef?.id;
  check('artifactRef is present and carries the declared sha256', Boolean(refId) && typeof full.sha256 === 'string' && full.artifactRef?.sha256 === full.sha256, { sha256: full.sha256?.slice(0, 16), ref: full.artifactRef?.sha256?.slice(0, 16), refId });
  const fetched = await fetchArtifact(refId);
  check('full-page artifact round-trips byte-exact', fetched.bytes === full.byteLength && fetched.sha256 === full.sha256, { bytes: fetched.bytes, declared: full.byteLength, sha: fetched.sha256.slice(0, 16) });
  check('full-page artifact is a complete decodable PNG', fetched.png.ok && fetched.png.width === receipt.rasterSize.width && fetched.png.height === receipt.rasterSize.height, fetched.png);
  check('full-page artifact exceeds 8 MiB', fetched.bytes > 8 * 1024 * 1024, { bytes: fetched.bytes, mib: +(fetched.bytes / 1048576).toFixed(2) });

  // ── 5. over-policy capture fails before any ArtifactRef ────────────────────
  // The per-artifact ceiling is an instance configuration; probe increasing page
  // sizes until the runtime refuses, proving the refusal happens with no ref.
  const overCandidates = [3600, 7200, 12000];
  let overPolicy = null;
  let overHeight = null;
  for (const h of overCandidates) {
    const file = `over-${h}.html`;
    fs.writeFileSync(path.join(tmp, file), noisePage(h, h - 300));
    const t = await openTab(`${base}/${file}`);
    await waitReady(t);
    await call('browser.set-viewport', { tabId: t, width: 1440, height: 900, mobile: false, deviceScaleFactor: 1, reload: true }, 30_000);
    await waitReady(t);
    let r;
    try {
      r = await call('anti.screenshot.full_page', { tabId: t }, 180_000);
    } catch (e) {
      r = { error: String(e.message), code: e.code, details: e.details };
    }
    overPolicy = r;
    overHeight = h;
    if (r?.error) break;
  }
  check('over-policy full-page fails without an ArtifactRef', Boolean(overPolicy?.error) && !overPolicy?.artifactRef, { error: overPolicy?.error?.slice(0, 200), pageHeight: overHeight, configuredMaxArtifactBytes: MAX_ARTIFACT_BYTES });

  // ── 6. offscreen full-page cannot silently degrade to viewport ─────────────
  const offTab = await call('anti.browser.tabs.create', { url: `${base}/${PAGE_ROUNDTRIP}`, activate: false, offscreen: true }, 60_000);
  const offTabId = offTab.tabId || offTab.result?.tabId;
  if (offTabId) ownedTabs.push(offTabId);
  let offscreen = null;
  try {
    offscreen = unwrap(await call('anti.screenshot.full_page', { tabId: offTabId }, 120_000));
  } catch (e) {
    offscreen = { error: String(e.message), code: e.code };
  }
  const offReceipt = offscreen?.receipt;
  check(
    'offscreen full-page rejects or stays full-page geometry (never silent viewport)',
    Boolean(offscreen?.error) || (offReceipt?.captureMode === 'full-page' && offReceipt.cssCaptureSize.height > 900),
    { error: offscreen?.error?.slice(0, 160), mode: offReceipt?.captureMode, css: offReceipt?.cssCaptureSize }
  );

  // ── 7. pre-dispatch lock cancellation + next waiter succeeds ───────────────
  const compareTab = await openTab(`${base}/${PAGE_COMPARE}`);
  await waitReady(compareTab);
  await call('browser.set-viewport', { tabId: compareTab, width: 1440, height: 900, mobile: false, deviceScaleFactor: 1, reload: true }, 30_000);
  await waitReady(compareTab);
  const slow = call('anti.visual.compare', {
    tabId: compareTab, comparisonTabId: compareTab, fullPage: true, tolerance: 2, normalizeScroll: true,
    allowHeightDrift: false, useDefaultWidgetMasks: false,
  }, 180_000);
  const cancelled = await call('anti.visual.compare', {
    tabId: compareTab, comparisonTabId: compareTab, fullPage: true, tolerance: 2, normalizeScroll: true,
    allowHeightDrift: false, useDefaultWidgetMasks: false,
  }, 1_500).then(() => ({ error: null }), (e) => ({ error: String(e.message), code: e.code }));
  // The waiter must die on the client budget before dispatch — any server-side
  // error (e.g. ARTIFACT_TOO_LARGE) would mean it dispatched and is not proof.
  check('second same-pair compare times out client-side without replay', cancelled.code === 'TIMEOUT' && /^RPC timeout 1500ms/.test(cancelled.error || ''), { error: cancelled.error?.slice(0, 160), code: cancelled.code });
  const slowResult = await slow.then((r) => ({ ok: unwrap(r) }), (e) => ({ error: String(e.message) }));
  check('holder compare completed normally after client-side cancellation of the waiter', Boolean(slowResult.ok) && slowResult.ok.mismatchPercentage === 0, slowResult.error || { mismatch: slowResult.ok?.mismatchPercentage });
  const next = await call('anti.visual.compare', {
    tabId: compareTab, comparisonTabId: compareTab, fullPage: true, tolerance: 2, normalizeScroll: true,
    allowHeightDrift: false, useDefaultWidgetMasks: false,
  }, 180_000).then((r) => ({ ok: unwrap(r) }), (e) => ({ error: String(e.message) }));
  check('next waiter succeeds after holder release (socket and lock queue usable)', Boolean(next.ok) && next.ok.mismatchPercentage === 0, next.error || { mismatch: next.ok?.mismatchPercentage });
  const rev = JSON.parse(fs.readFileSync(path.resolve('.canary/state/authority-revision.json'), 'utf8'));
  check('authority revision remains well-formed and attachment-scoped after cancellation', /^rev_[0-9a-f]{32}$/.test(rev.revision) && rev.attachmentId === JSON.parse(process.env.ANTIFAN_MCP_BOOTSTRAP).attachmentId, { revision: rev.revision, attachmentId: rev.attachmentId });

  // ── 8. post-dispatch timeout: quarantine exclusion then recovery ───────────
  const slowTab = await openTab(`${base}/${PAGE_SLOW}`);
  await waitReady(slowTab, 120_000);
  await call('browser.set-viewport', { tabId: slowTab, width: 1440, height: 900, mobile: false, deviceScaleFactor: 1, reload: true }, 30_000);
  await waitReady(slowTab, 120_000);
  const postDispatch = call('anti.screenshot.full_page', { tabId: slowTab }, 1_200).then(() => ({ ok: true }), (e) => ({ error: String(e.message), code: e.code }));
  // Clip-only compare: a serialized run stays under the 8 MiB per-side compare
  // ceiling, so the only possible outcomes are a typed target-busy/quarantine
  // refusal or a serialized success. A full-page compare here would fail on the
  // compare ceiling itself and prove nothing about exclusion.
  const inflight = await call('anti.visual.compare', {
    tabId: slowTab, comparisonTabId: slowTab, clipRect: { x: 0, y: 0, width: 1440, height: 900 },
    tolerance: 2, normalizeScroll: true, allowHeightDrift: false, useDefaultWidgetMasks: false,
  }, 5_000).then((r) => ({ ok: unwrap(r) }), (e) => ({ error: String(e.message), code: e.code }));
  // Quarantine exclusion must be a typed target-busy/quarantine refusal or a
  // serialized success — an artifact-size error would not prove exclusion.
  const busyCodes = ['TARGET_BUSY', 'TARGET_BUSY_DRAINING', 'TARGET_QUARANTINED', 'QUARANTINED', 'EXECUTION_TIMEOUT_PENDING_CLEANUP'];
  check(
    'same-target operation during in-flight/quarantine fails typed or serializes',
    (Boolean(inflight.error) && busyCodes.includes(inflight.code)) || inflight.ok?.mismatchPercentage === 0,
    inflight.error ? { error: inflight.error.slice(0, 160), code: inflight.code } : { mismatch: inflight.ok?.mismatchPercentage }
  );
  const postResult = await postDispatch;
  check('post-dispatch client timeout returns bounded failure without replay', postResult.code === 'TIMEOUT' && /^RPC timeout 1200ms/.test(postResult.error || ''), { error: postResult.error?.slice(0, 160), code: postResult.code });
  await sleep(3_000);
  const recovered = await call('anti.screenshot.full_page', { tabId: slowTab }, 120_000).then((r) => ({ ok: unwrap(r) }), (e) => ({ error: String(e.message) }));
  check('target recovers after the timed-out operation completes', Boolean(recovered.ok) && recovered.ok.receipt?.captureMode === 'full-page', recovered.error || { mode: recovered.ok?.receipt?.captureMode });
} catch (e) {
  check('smoke runner completed without an unhandled error', false, String(e && e.stack ? e.stack.slice(0, 800) : e));
} finally {
  for (const owned of ownedTabs) {
    await call('anti.browser.tabs.close', { tabId: owned }, 30_000).catch(() => {});
  }
  server.kill('SIGTERM');
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}

const doc = {
  generatedAt: new Date().toISOString(),
  target: 'isolated canary instance',
  port: PORT,
  maxArtifactBytes: MAX_ARTIFACT_BYTES,
  total: results.length,
  passed: results.length - failures,
  failed: failures,
  results,
  unitSuiteCompanion: {
    file: 'test/integration/execution-control-cancellation.test.ts',
    covers: [
      'cooperative cleanup terminalizes inside policy budget; uncooperative returns nonterminal EXECUTION_TIMEOUT_PENDING_CLEANUP',
      'pre-dispatch lock-wait cancellation dispatches zero CDP commands and preserves FIFO',
      'post-dispatch capture timeout keeps TARGET_BUSY_DRAINING until drain/reset receipt',
      'terminal receipt only after owned-resource cleanup or completed isolation teardown',
    ],
  },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
log(`\n${doc.passed}/${doc.total} checks passed -> ${OUT}`);
process.exit(failures === 0 ? 0 : 1);
