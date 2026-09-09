/**
 * Live Hoplongtech canary orchestrator (Phase 5).
 *
 *   node .canary/tools/canary-run.mjs [--run-dir .canary/run3] [--clone-port 7852]
 *        [--ref-url https://hoplongtech.com/] [--viewports 1440x900,1024x900,390x844]
 *        [--skip-build] [--skip-capture] [--keep-server]
 *
 * Sequence (each step persisted into <runDir>/evidence/pipeline.json):
 *   0. hash .canary/run1 + .canary/run2 (preservation proof, re-hashed at the end)
 *   1. artifact.preflight -> exclusive evidence lease for a fresh runId. Nothing is
 *      created under <runDir> until the lease is granted; abort on rejection.
 *   2. fresh reference capture from the live storefront (hydrate -> dump sanitized DOM)
 *   3. real clone pipeline (CloneIRBuilder + IndependentHtmlCloneGenerator)
 *   4. hardened local static server for the generated bundle (reference HTML and
 *      reference visual assets are never proxied or embedded)
 *   5. per-viewport: viewport-run.mjs (settlement, standalone independent captures,
 *      atomic authoritative pair, structural probes, sectional clips, self-drift)
 *   6. runtime asset/dependency audit on the clone tab
 *   7. release the evidence lease; write summary
 *
 * The lease is always released, including on failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const RUN_DIR = path.resolve(arg('run-dir', '.canary/run3'));
const CLONE_PORT = Number(arg('clone-port', '7852'));
const REF_URL = arg('ref-url', 'https://hoplongtech.com/');
const VIEWPORTS = arg('viewports', '1440x900,1024x900,390x844').split(',').map((v) => {
  const [w, h] = v.split('x').map(Number);
  return { label: `run3-${w}`, width: w, height: h };
});
const SKIP_BUILD = flag('skip-build');
const SKIP_CAPTURE = flag('skip-capture');
const KEEP_SERVER = flag('keep-server');
const EVIDENCE_DIR = path.join(RUN_DIR, 'evidence');

const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// lib-rpc resolves the canary session file first (ambient ANTIFAN_MCP_BOOTSTRAP
// points at the user's instance); children inherit ANTIFAN_MCP_BOOTSTRAP_FILE.
const { call, bootstrap: boot } = await import('./lib-rpc.mjs');
const childBootstrapEnv = process.env.ANTIFAN_MCP_BOOTSTRAP_FILE
  ? { ANTIFAN_MCP_BOOTSTRAP_FILE: process.env.ANTIFAN_MCP_BOOTSTRAP_FILE }
  : {};

const pipeline = {
  startedAt: new Date().toISOString(),
  runDir: RUN_DIR,
  clonePort: CLONE_PORT,
  referenceUrl: REF_URL,
  viewports: VIEWPORTS.map((v) => `${v.width}x${v.height}`),
  bootstrap: { port: boot.port, attachmentId: boot.attachmentId, runId: boot.runId, primaryTabId: boot.tabId },
  steps: {},
};
// Evidence dir may not exist yet (preflight precedes creation) — buffer until then.
let evidenceReady = false;
function persist() {
  if (!evidenceReady) return;
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'pipeline.json'), JSON.stringify(pipeline, null, 2));
}

/** Deterministic hash of a directory tree: relative path + size + sha256 per file. */
function hashTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const buf = fs.readFileSync(p);
        out.push({ path: path.relative(dir, p).replace(/\\/g, '/'), bytes: buf.length, sha256: sha256(buf) });
      }
    }
  };
  if (!fs.existsSync(dir)) return { exists: false, files: [], treeHash: null };
  walk(dir);
  return {
    exists: true,
    files: out.length,
    bytes: out.reduce((a, f) => a + f.bytes, 0),
    treeHash: sha256(out.map((f) => `${f.path}\u0000${f.bytes}\u0000${f.sha256}`).join('\n')),
  };
}

function run(cmd, args, { timeoutMs = 900_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr, timedOut: true, elapsedMs: Date.now() - started });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e.message), spawnError: true, elapsedMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

const PRESERVED = ['.canary/run1', '.canary/run2'];

// ── 0. preservation baseline ─────────────────────────────────────────────────
log('hashing run1/run2 (preservation baseline)');
const before = Object.fromEntries(PRESERVED.map((d) => [d, hashTree(path.resolve(d))]));
pipeline.steps.preservationBefore = before;

// ── 1. artifact.preflight (before any run3 write) ────────────────────────────
// The lease must cover the run that actually stages evidence: capture/compare
// stage under the attachment's runId (context.runId), and this canary session
// mints a fresh run per invocation, so that run IS the dedicated evidence run.
const runId = boot.runId;
const ESTIMATED_ARTIFACT_BYTES = Number(arg('artifact-bytes', String(24 * 1024 * 1024)));
const ESTIMATED_AGGREGATE_BYTES = Number(arg('aggregate-bytes', String(768 * 1024 * 1024)));
log(`artifact.preflight runId=${runId} artifact=${ESTIMATED_ARTIFACT_BYTES}B aggregate=${ESTIMATED_AGGREGATE_BYTES}B`);
let lease = null;
try {
  const pre = await call('artifact.preflight', {
    runId,
    artifactBytes: ESTIMATED_ARTIFACT_BYTES,
    aggregateBytes: ESTIMATED_AGGREGATE_BYTES,
    leaseTtlMs: 4 * 60 * 60 * 1000,
  }, 30_000);
  pipeline.steps.preflight = { runId, request: { artifactBytes: ESTIMATED_ARTIFACT_BYTES, aggregateBytes: ESTIMATED_AGGREGATE_BYTES, leaseTtlMs: 4 * 60 * 60 * 1000 }, result: pre };
  if (!pre?.granted) {
    pipeline.status = 'PREFLIGHT_DENIED';
    console.error(`preflight denied: ${pre?.reason} (committed=${pre?.committedBytes} limits=${JSON.stringify(pre?.limits)})`);
    process.exit(3);
  }
  lease = { runId, leaseToken: pre.leaseToken };
  log(`lease granted token=${String(pre.leaseToken).slice(0, 12)}… committed=${pre.committedBytes} available=${pre.availableRunBytes}`);
} catch (e) {
  pipeline.steps.preflight = { runId, error: String(e.message || e).slice(0, 500) };
  pipeline.status = 'PREFLIGHT_ERROR';
  console.error(`preflight failed: ${e.message}`);
  process.exit(3);
}

let server = null;
let exitCode = 0;
try {
  // ── 2. run3 layout ─────────────────────────────────────────────────────────
  for (const sub of ['reference', 'clone', 'evidence', 'diff', 'sections']) {
    fs.mkdirSync(path.join(RUN_DIR, sub), { recursive: true });
  }
  evidenceReady = true;
  pipeline.steps.layout = { created: fs.readdirSync(RUN_DIR) };
  persist();

  // ── 3. fresh reference capture ─────────────────────────────────────────────
  let refTabId = boot.tabId;
  let refCapture = null;
  const refHtmlPath = path.join(RUN_DIR, 'reference', 'reference.html');
  if (SKIP_CAPTURE && fs.existsSync(refHtmlPath)) {
    refCapture = { skipped: true, path: refHtmlPath, sha256: sha256(fs.readFileSync(refHtmlPath)) };
    log('reference capture skipped (--skip-capture, reusing existing reference.html)');
  } else {
    log(`opening reference tab ${REF_URL}`);
    // activate: a never-foregrounded tab reports innerHeight=0 and lays out
    // against a zero-height viewport, so the dump would capture a degenerate
    // pre-hydration DOM (measured: 68 images / 5 sections instead of 101 / 11).
    const t = await call('anti.browser.tabs.create', { url: REF_URL, activate: true }, 60_000);
    refTabId = t.tabId || t.result?.tabId;
    const prep = await run('node', ['.canary/tools/prepare-ref.mjs', refTabId, 'run3-reference'], { timeoutMs: 600_000, env: childBootstrapEnv });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'reference-prepare.json'), prep.stdout + (prep.stderr ? `\n--- stderr ---\n${prep.stderr}` : ''));
    if (prep.code !== 0) throw new Error(`prepare-ref failed (code ${prep.code}): ${prep.stderr.slice(0, 400)}`);
    const dump = await run('node', ['.canary/tools/dump-ref.mjs', refTabId, refHtmlPath, 'sanitize'], { timeoutMs: 300_000, env: childBootstrapEnv });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'reference-dump.json'), dump.stdout + (dump.stderr ? `\n--- stderr ---\n${dump.stderr}` : ''));
    if (dump.code !== 0) throw new Error(`dump-ref failed (code ${dump.code}): ${dump.stderr.slice(0, 400)}`);
    const parsed = JSON.parse(dump.stdout);
    refCapture = { tabId: refTabId, ...parsed, prepare: JSON.parse(prep.stdout) };
    log(`reference captured: ${parsed.bytes} bytes, sections=${parsed.sections.length}, productItems=${parsed.productItems}, images=${parsed.images}`);
  }
  pipeline.steps.referenceCapture = refCapture;
  persist();

  // Readiness floors derive from the captured reference artifact, never invented.
  const minSections = Math.max(1, (refCapture?.sections?.length ?? refCapture?.prepare?.fingerprint?.sections?.length ?? 1));
  // The floor may not exceed the reference's own observation: a landing page with
  // no product grid (productItems=0) would otherwise be permanently unready.
  const minCards = Math.max(0, refCapture?.productItems ?? refCapture?.prepare?.fingerprint?.productCards ?? 0);
  pipeline.steps.readinessFloors = { minSections, minCards };

  // ── 4. clone pipeline ──────────────────────────────────────────────────────
  const telemetryPath = path.join(EVIDENCE_DIR, 'build-telemetry.json');
  if (SKIP_BUILD && fs.existsSync(path.join(RUN_DIR, 'clone', 'index.html'))) {
    pipeline.steps.build = { skipped: true, telemetry: telemetryPath };
    log('clone build skipped (--skip-build, reusing existing bundle)');
  } else {
    log('building independent HTML clone (real pipeline)');
    const build = await run('node', ['.canary/tools/build-clone.mjs', refHtmlPath, path.join(RUN_DIR, 'clone'), telemetryPath], { timeoutMs: 1_800_000 });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'build.log'), build.stdout + (build.stderr ? `\n--- stderr ---\n${build.stderr}` : ''));
    pipeline.steps.build = { code: build.code, elapsedMs: build.elapsedMs, stdout: build.stdout.slice(0, 4000), stderr: build.stderr.slice(0, 4000) };
    if (build.code !== 0) throw new Error(`build-clone failed (code ${build.code}): ${build.stderr.slice(0, 400)}`);
    log('clone bundle built');
  }
  const cloneEntry = path.join(RUN_DIR, 'clone', 'index.html');
  if (!fs.existsSync(cloneEntry)) throw new Error(`clone entry missing: ${cloneEntry}`);
  pipeline.steps.bundle = { entry: cloneEntry, entrySha256: sha256(fs.readFileSync(cloneEntry)), tree: hashTree(path.join(RUN_DIR, 'clone')) };
  persist();

  // ── 5. hardened local server ───────────────────────────────────────────────
  log(`starting hardened static server on 127.0.0.1:${CLONE_PORT}`);
  server = spawn('node', ['.canary/tools/serve-static.mjs', path.join(RUN_DIR, 'clone'), String(CLONE_PORT)], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 20_000;
    const tick = () => {
      const req = http.get({ hostname: '127.0.0.1', port: CLONE_PORT, path: '/index.html', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else if (Date.now() > deadline) reject(new Error(`server returned ${res.statusCode}`));
        else setTimeout(tick, 300);
      });
      req.on('error', () => (Date.now() > deadline ? reject(new Error('server never became ready')) : setTimeout(tick, 300)));
      req.on('timeout', () => req.destroy());
    };
    tick();
  });
  pipeline.steps.server = { port: CLONE_PORT, root: path.join(RUN_DIR, 'clone'), ready: true };
  log('server ready');

  // ── 6. clone tab ───────────────────────────────────────────────────────────
  const cloneUrl = `http://127.0.0.1:${CLONE_PORT}/`;
  log(`opening clone tab ${cloneUrl}`);
  const ct = await call('anti.browser.tabs.create', { url: cloneUrl, activate: true }, 60_000);
  const cloneTabId = ct.tabId || ct.result?.tabId;
  pipeline.steps.tabs = { referenceTabId: refTabId, cloneTabId, cloneUrl };
  persist();

  // ── 7. per-viewport runs ───────────────────────────────────────────────────
  pipeline.viewportRuns = [];
  for (const vp of VIEWPORTS) {
    log(`viewport ${vp.width}x${vp.height} (${vp.label})`);
    const r = await run('node', [
      '.canary/tools/viewport-run.mjs',
      vp.label, String(vp.width), String(vp.height), refTabId, cloneTabId, RUN_DIR,
      String(minSections), String(minCards),
    ], {
      timeoutMs: 1_200_000,
      env: {
        ...childBootstrapEnv,
        CANARY_SELF_DRIFT: '1',
        CANARY_COMPARE_TIMEOUT_MS: '240000',
        CANARY_STANDALONE_TIMEOUT_MS: '120000',
        CANARY_EVIDENCE_RUN_ID: lease.runId,
        CANARY_LEASE_TOKEN: lease.leaseToken,
      },
    });
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${vp.label}.log`), r.stdout + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''));
    const evidenceFile = path.join(EVIDENCE_DIR, `${vp.label}.json`);
    let evidence = null;
    if (fs.existsSync(evidenceFile)) {
      try { evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')); } catch (e) { evidence = { parseError: String(e.message) }; }
    }
    const row = {
      label: vp.label,
      viewport: `${vp.width}x${vp.height}`,
      exitCode: r.code,
      elapsedMs: r.elapsedMs,
      evidenceFile: path.relative(RUN_DIR, evidenceFile).replace(/\\/g, '/'),
      status: evidence?.status ?? (r.code === 0 ? 'RAN' : r.code === 3 ? 'NOT_READY' : 'ERROR'),
      readiness: evidence?.readiness ?? null,
      authoritative: evidence?.visual
        ? {
            match: evidence.visual.match ?? null,
            mismatchPercentage: evidence.visual.mismatchPercentage,
            verdict: evidence.visual.verdict,
            toolVerdict: evidence.visual.toolVerdict ?? null,
            toolStatus: evidence.visual.toolStatus ?? null,
            reason: evidence.visual.reason ?? null,
            dimensionsMatch: evidence.visual.dimensionsMatch,
            maskRatio: evidence.visual.mask?.maskedAreaRatio ?? null,
          }
        : null,
      selfDrift: evidence?.selfDrift ?? null,
      standalone: evidence?.standalone
        ? Object.fromEntries(Object.entries(evidence.standalone).map(([k, v]) => [k, {
            status: v.status,
            artifactId: v.artifactId ?? null,
            byteLength: v.byteLength ?? null,
            fetchedBytes: v.fetchedBytes ?? null,
            sha256: v.sha256 ?? null,
            fetchedSha256: v.fetchedSha256 ?? null,
            byteForByte: v.byteForByte ?? false,
            fetchError: v.fetchError ?? null,
            captureMode: v.receipt?.captureMode ?? null,
          }]))
        : null,
      pairPersisted: evidence?.authoritativePair ?? null,
      structural: evidence?.structural ?? null,
      sectionCount: evidence?.stages?.sections?.length ?? null,
      compareStatus: evidence?.stages?.compare?.status ?? null,
      compareError: evidence?.stages?.compare?.error ?? null,
    };
    pipeline.viewportRuns.push(row);
    persist();
    log(`  ${vp.label}: status=${row.status} mismatch=${row.authoritative?.mismatchPercentage ?? 'n/a'} drift=${row.selfDrift?.mismatchPercentage ?? 'n/a'} exit=${r.code}`);
    if (r.code === 3) log(`  ${vp.label}: INCONCLUSIVE (readiness) — continuing so every viewport has evidence`);
  }

  // ── 8. runtime asset/dependency audit (clone side) ─────────────────────────
  log('runtime asset/dependency audit on clone tab');
  const auditScript = `(() => {
    const refHost = new URL(${JSON.stringify(REF_URL)}).host;
    const visualTypes = new Set(['img', 'image', 'css', 'link', 'script', 'font', 'media', 'video', 'audio', 'fetch', 'xmlhttprequest', 'other']);
    const entries = performance.getEntriesByType('resource').map((e) => {
      let host = ''; let pathname = '';
      try { const u = new URL(e.name); host = u.host; pathname = u.pathname; } catch {}
      return { name: e.name.slice(0, 300), host, pathname, initiatorType: e.initiatorType, transferSize: e.transferSize || 0, duration: Math.round(e.duration) };
    });
    const referenceOrigin = entries.filter((e) => e.host === refHost);
    const referenceVisual = referenceOrigin.filter((e) => visualTypes.has(e.initiatorType));
    const byHost = entries.reduce((acc, e) => { acc[e.host] = (acc[e.host] || 0) + 1; return acc; }, {});
    const imgs = Array.from(document.images).map((i) => ({ src: (i.currentSrc || i.src || '').slice(0, 300), complete: i.complete, lazy: i.loading === 'lazy', natural: [i.naturalWidth, i.naturalHeight] }));
    const cssUrls = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules = null;
      try { rules = sheet.cssRules; } catch {}
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        const t = rule.cssText || '';
        const m = t.match(/url\\((['"]?)([^'")]+)\\1\\)/g) || [];
        for (const raw of m) cssUrls.push(raw.slice(4, -1).replace(/['"]/g, ''));
      }
    }
    const externalCssUrls = cssUrls.filter((u) => /^(https?:)?\\/\\//i.test(u));
    const externalCssRefOrigin = externalCssUrls.filter((u) => { try { return new URL(u, location.href).host === refHost; } catch { return false; } });
    return {
      href: location.href,
      refHost,
      resourceCount: entries.length,
      byHost,
      referenceOriginCount: referenceOrigin.length,
      referenceOriginVisualCount: referenceVisual.length,
      referenceOriginVisual: referenceVisual.slice(0, 50),
      referenceOriginSample: referenceOrigin.slice(0, 50),
      images: {
        total: imgs.length,
        broken: imgs.filter((i) => i.complete === true && i.natural[0] === 0).map((i) => i.src),
        pending: imgs.filter((i) => !i.complete).length,
        pendingLazy: imgs.filter((i) => !i.complete && i.lazy).length,
        zeroArea: imgs.filter((i) => i.natural[0] === 0 && i.natural[1] === 0).length,
      },
      cssUrlCount: cssUrls.length,
      externalCssUrls: Array.from(new Set(externalCssUrls)).slice(0, 50),
      externalCssRefOrigin: Array.from(new Set(externalCssRefOrigin)).slice(0, 50),
      documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`;
  // Non-lazy images get a bounded window to finish; lazy images below the fold
  // are reported as pending rather than broken.
  for (let i = 0; i < 12; i++) {
    const raw = await call('anti.browser.evaluate', { tabId: cloneTabId, expression: `[...document.images].filter((i) => !i.complete && i.loading !== 'lazy').length` }, 30_000).catch(() => 0);
    const pending = Number(raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw);
    if (!pending) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  let audit = null;
  try {
    audit = await call('anti.browser.evaluate', { tabId: cloneTabId, expression: auditScript }, 60_000);
  } catch (e) {
    audit = { error: String(e.message || e).slice(0, 500) };
  }
  // Pipeline-side remote reference: what the bundle still points at on disk.
  let buildTelemetry = null;
  if (fs.existsSync(telemetryPath)) {
    try { buildTelemetry = JSON.parse(fs.readFileSync(telemetryPath, 'utf8')); } catch {}
  }
  const auditDoc = {
    generatedAt: new Date().toISOString(),
    cloneTabId,
    runtime: audit,
    bundle: buildTelemetry
      ? {
          entrySha256: buildTelemetry.bundle?.entrySha256,
          assetFiles: buildTelemetry.bundle?.assetFiles,
          assetBytes: buildTelemetry.bundle?.assetBytes,
          productCount: buildTelemetry.bundle?.productCount,
          articleCount: buildTelemetry.bundle?.articleCount,
          remoteSubresources: buildTelemetry.bundle?.remoteSubresources ?? [],
          remoteNavigationCount: buildTelemetry.bundle?.remoteNavigationCount ?? null,
          a0: buildTelemetry.a0 ?? null,
          assetIntegrity: {
            files: buildTelemetry.assetIntegrity?.length ?? 0,
            zeroByte: (buildTelemetry.assetIntegrity ?? []).filter((a) => a.bytes === 0).map((a) => a.file),
            undecoded: (buildTelemetry.assetIntegrity ?? []).filter((a) => ['other'].includes(a.decoded?.format) && /\.(png|jpe?g|gif|webp|avif)$/i.test(a.file)).map((a) => a.file),
          },
        }
      : null,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'asset-audit.json'), JSON.stringify(auditDoc, null, 2));
  pipeline.steps.assetAudit = {
    file: 'asset-audit.json',
    referenceOriginVisualCount: audit?.referenceOriginVisualCount ?? null,
    referenceOriginCount: audit?.referenceOriginCount ?? null,
    brokenImages: audit?.images?.broken?.length ?? null,
    remoteSubresources: auditDoc.bundle?.remoteSubresources?.length ?? null,
    overflowX: audit?.documentOverflowX ?? null,
  };
  log(`audit: reference-origin visual requests=${audit?.referenceOriginVisualCount ?? 'n/a'} broken images=${audit?.images?.broken?.length ?? 'n/a'} remote subresources=${auditDoc.bundle?.remoteSubresources?.length ?? 'n/a'}`);
  persist();

  // ── 9. preservation re-check ───────────────────────────────────────────────
  const after = Object.fromEntries(PRESERVED.map((d) => [d, hashTree(path.resolve(d))]));
  const preserved = PRESERVED.every((d) => before[d].treeHash === after[d].treeHash);
  pipeline.steps.preservationAfter = after;
  pipeline.steps.preservation = { preserved, before: Object.fromEntries(PRESERVED.map((d) => [d, before[d].treeHash])), after: Object.fromEntries(PRESERVED.map((d) => [d, after[d].treeHash])) };
  if (!preserved) { log('PRESERVATION VIOLATION: run1/run2 changed'); exitCode = 4; }
  else log('preservation OK: run1/run2 byte-identical');

  const allViewportsHaveEvidence = pipeline.viewportRuns?.length === VIEWPORTS.length &&
    pipeline.viewportRuns.every((v) => {
      const exitOk = v.exitCode === 0;
      const refBytes = v.pairPersisted?.reference?.bytes ?? v.pairPersisted?.reference?.byteLength;
      const refPersisted = v.pairPersisted?.reference?.status === 'PERSISTED' &&
        typeof refBytes === 'number' && refBytes > 0 &&
        typeof v.pairPersisted.reference.sha256 === 'string' &&
        v.pairPersisted.reference.byteForByte === true;
      const cloneBytes = v.pairPersisted?.clone?.bytes ?? v.pairPersisted?.clone?.byteLength;
      const clonePersisted = v.pairPersisted?.clone?.status === 'PERSISTED' &&
        typeof cloneBytes === 'number' && cloneBytes > 0 &&
        typeof v.pairPersisted.clone.sha256 === 'string' &&
        v.pairPersisted.clone.byteForByte === true;
      const authoritativeOk = v.authoritative &&
        typeof v.authoritative.mismatchPercentage === 'number' &&
        v.authoritative.dimensionsMatch === true &&
        (v.authoritative.verdict === 'PASS' || v.authoritative.verdict === 'FAIL');
      const standaloneRefOk = v.standalone?.reference &&
        v.standalone.reference.status === 'CAPTURED' &&
        Boolean(v.standalone.reference.artifactId) &&
        typeof v.standalone.reference.byteLength === 'number' && v.standalone.reference.byteLength > 0 &&
        typeof v.standalone.reference.fetchedBytes === 'number' && v.standalone.reference.fetchedBytes === v.standalone.reference.byteLength &&
        typeof v.standalone.reference.sha256 === 'string' &&
        typeof v.standalone.reference.fetchedSha256 === 'string' && v.standalone.reference.fetchedSha256 === v.standalone.reference.sha256 &&
        v.standalone.reference.byteForByte === true &&
        typeof v.standalone.reference.captureMode === 'string';
      const standaloneCloneOk = v.standalone?.clone &&
        v.standalone.clone.status === 'CAPTURED' &&
        Boolean(v.standalone.clone.artifactId) &&
        typeof v.standalone.clone.byteLength === 'number' && v.standalone.clone.byteLength > 0 &&
        typeof v.standalone.clone.fetchedBytes === 'number' && v.standalone.clone.fetchedBytes === v.standalone.clone.byteLength &&
        typeof v.standalone.clone.sha256 === 'string' &&
        typeof v.standalone.clone.fetchedSha256 === 'string' && v.standalone.clone.fetchedSha256 === v.standalone.clone.sha256 &&
        v.standalone.clone.byteForByte === true &&
        typeof v.standalone.clone.captureMode === 'string';
      const structuralOk = v.structural !== null && typeof v.structural === 'object';
      return exitOk && refPersisted && clonePersisted && authoritativeOk && standaloneRefOk && standaloneCloneOk && structuralOk;
    });
  const anyViewportInconclusive = pipeline.viewportRuns?.some((v) =>
    v.exitCode === 3 ||
    v.status === 'REFERENCE_NOT_READY' ||
    v.status === 'CLONE_NOT_READY' ||
    v.status === 'INCONCLUSIVE' ||
    v.authoritative?.verdict === 'INCONCLUSIVE' ||
    v.authoritative?.toolStatus === 'INCONCLUSIVE' ||
    v.compareStatus === 'INCONCLUSIVE'
  );
  if (!preserved) {
    pipeline.status = 'PRESERVATION_VIOLATION';
    exitCode = 4;
  } else if (!allViewportsHaveEvidence) {
    pipeline.status = anyViewportInconclusive ? 'INCONCLUSIVE' : 'PARTIAL_EVIDENCE';
    exitCode = 3;
  } else {
    pipeline.status = 'COMPLETED';
    exitCode = 0;
  }
} catch (e) {
  pipeline.status = 'ERROR';
  pipeline.error = String(e && e.stack ? e.stack.slice(0, 2000) : e);
  console.error(`FAILED: ${e && e.message}`);
  exitCode = 1;
} finally {
  pipeline.finishedAt = new Date().toISOString();
  // Release the evidence lease before anything else: capacity must not stay pinned
  // by a dead run.
  if (lease) {
    try {
      const rel = await call('artifact.release_lease', { runId: lease.runId, leaseToken: lease.leaseToken }, 30_000);
      pipeline.steps.leaseRelease = rel;
      log(`lease released: ${JSON.stringify(rel)}`);
    } catch (e) {
      pipeline.steps.leaseRelease = { error: String(e.message || e).slice(0, 300) };
      log(`lease release FAILED: ${e.message}`);
    }
  }
  if (server && !KEEP_SERVER) {
    server.kill('SIGTERM');
    log('static server stopped');
  } else if (server) {
    log(`static server left running on ${CLONE_PORT} (--keep-server)`);
  }
  if (evidenceReady) {
    persist();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'summary.json'), JSON.stringify({
      status: pipeline.status,
      runId: pipeline.steps.preflight?.runId,
      referenceUrl: REF_URL,
      viewports: pipeline.viewportRuns,
      assetAudit: pipeline.steps.assetAudit,
      preservation: pipeline.steps.preservation,
    }, null, 2));
    log(`summary written: ${path.join(EVIDENCE_DIR, 'summary.json')}`);
  }
}
process.exit(exitCode);
