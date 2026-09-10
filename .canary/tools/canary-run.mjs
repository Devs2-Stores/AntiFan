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
import { loadCachedReadinessFloors, validateProbedFloor } from './canary-floors.mjs';
import { hydrateToCapturedState, requireDoubleSettledMetrics } from './canary-settle.mjs';
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
const KEEP_TABS = flag('keep-tabs');
const EVIDENCE_DIR = path.join(RUN_DIR, 'evidence');

const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hasMobileViewport = VIEWPORTS.some((v) => v.width < 768);
const refMobileHtmlPath = path.join(RUN_DIR, 'reference', 'reference-mobile.html');
// The desktop reference artifact is captured at the widest declared target; the
// browser's default window is not a declared target viewport.
const desktopTarget = VIEWPORTS[0];

// lib-rpc resolves the canary session file first (ambient ANTIFAN_MCP_BOOTSTRAP
// points at the user's instance); children inherit ANTIFAN_MCP_BOOTSTRAP_FILE.
const { call, probeTabHealth, bootstrap: boot } = await import('./lib-rpc.mjs');
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
function hashTree(dir, excludeTopLevel = []) {
  const out = [];
  const skip = new Set(excludeTopLevel);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (skip.has(path.relative(dir, p).replace(/\\/g, '/'))) continue;
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
let evidenceRunId = null;
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
  // The lease runId is session-scoped (it identifies the canary authority, not
  // this invocation), so it cannot tell one run's evidence from the next. A fresh
  // per-invocation stamp is what the provenance check below compares.
  evidenceRunId = crypto.randomUUID();
  pipeline.steps.evidenceRun = { evidenceRunId };
  log(`lease granted token=${String(pre.leaseToken).slice(0, 12)}… committed=${pre.committedBytes} available=${pre.availableRunBytes}`);
} catch (e) {
  pipeline.steps.preflight = { runId, error: String(e.message || e).slice(0, 500) };
  pipeline.status = 'PREFLIGHT_ERROR';
  console.error(`preflight failed: ${e.message}`);
  process.exit(3);
}

let server = null;
let exitCode = 0;
// Declared outside the run body so teardown can close them even when the run
// fails before either tab is created.
let refTabId = null;
let cloneTabId = null;
try {
  // ── 2. run3 layout ─────────────────────────────────────────────────────────
  for (const sub of ['reference', 'clone', 'evidence', 'diff', 'sections']) {
    fs.mkdirSync(path.join(RUN_DIR, sub), { recursive: true });
  }
  // Evidence is run-scoped. A stage that dies mid-write must not leave a file a
  // later invocation reads as its own result, and per-viewport names carry no run
  // identity of their own, so every run starts from an empty output set.
  const cleared = [];
  for (const sub of ['reference', 'clone', 'evidence', 'diff', 'sections']) {
    const dir = path.join(RUN_DIR, sub);
    for (const name of fs.readdirSync(dir)) {
      const target = path.join(dir, name);
      fs.rmSync(target, { recursive: true, force: true });
      cleared.push(path.relative(RUN_DIR, target).replace(/\\/g, '/'));
    }
  }
  evidenceReady = true;
  pipeline.steps.layout = { created: fs.readdirSync(RUN_DIR), cleared };
  persist();
  if (cleared.length) log(`cleared ${cleared.length} stale run outputs before capture`);

  // ── 3. fresh reference capture ─────────────────────────────────────────────
  refTabId = boot.tabId;
  let refCapture = null;
  const refHtmlPath = path.join(RUN_DIR, 'reference', 'reference.html');
  const refFloorsFile = path.join(EVIDENCE_DIR, 'reference-floors.json');
  let readinessFloors = null;

  if (SKIP_CAPTURE && fs.existsSync(refHtmlPath)) {
    const currentRefSha = sha256(fs.readFileSync(refHtmlPath));
    const refBuf = fs.readFileSync(refHtmlPath);
    refCapture = {
      skipped: true,
      path: refHtmlPath,
      sha256: currentRefSha,
      desktop: { path: refHtmlPath, bytes: refBuf.length, sha256: currentRefSha },
    };
    if (hasMobileViewport) {
      if (!fs.existsSync(refMobileHtmlPath)) {
        throw new Error(`Cannot --skip-capture: target viewports include mobile, but required mobile reference artifact is missing at ${refMobileHtmlPath}`);
      }
      const refMobileBuf = fs.readFileSync(refMobileHtmlPath);
      refCapture.mobile = { path: refMobileHtmlPath, bytes: refMobileBuf.length, sha256: sha256(refMobileBuf) };
    }
    log('reference capture skipped (--skip-capture, reusing existing reference.html' + (hasMobileViewport ? ' and reference-mobile.html' : '') + ')');
    readinessFloors = loadCachedReadinessFloors(refFloorsFile, currentRefSha, VIEWPORTS);
    log('loaded validated per-viewport readiness floors matching reference HTML hash');
  } else {
    log(`opening reference tab ${REF_URL}`);
    // activate: a never-foregrounded tab reports innerHeight=0 and lays out
    // against a zero-height viewport, so the dump would capture a degenerate
    // pre-hydration DOM (measured: 68 images / 5 sections instead of 101 / 11).
    const t = await call('anti.browser.tabs.create', { url: REF_URL, activate: true }, 60_000);
    refTabId = t.tabId || t.result?.tabId;
    refCapture = { tabId: refTabId };

    // Probe live reference tab at each viewport in the current run to capture empirical per-viewport floors:
    log('probing reference tab across all target viewports for empirical readiness floors');
    readinessFloors = {};
    for (const vp of VIEWPORTS) {
      const isMobile = vp.width < 768;
      await call('browser.switch-tab', { tabId: refTabId }, 30_000).catch(() => null);
      // Atomic viewport + reload, then the canonical settle contract. A separate
      // set-viewport + reload leaves the tab hydrated against the previous layout,
      // and an ad-hoc sampler can then "stabilize" on an under-hydrated shell.
      await call('browser.set-viewport', {
        tabId: refTabId,
        width: vp.width,
        height: vp.height,
        mobile: isMobile,
        deviceScaleFactor: 1,
        reload: true,
      });

      // Hydration contract (see hydrateToCapturedState): the capture runs before
      // any measurement or dump, because rasterizing the document is what mounts
      // the storefront's remaining sections.
      const hydration = await hydrateToCapturedState(refTabId, `${vp.label}-reference`, { leaseToken: lease.leaseToken });
      const settled = hydration.settled;
      // The floor comes from the settled metric pair itself: re-measuring here
      // would re-implement the metric and open a window between the proven-stable
      // read and the count the floor is derived from.
      const sectionCount = settled.metrics?.sectionCount;
      const cardCount = settled.metrics?.productCardCount;
      const docHeight = settled.metrics?.docHeight;
      if (typeof sectionCount !== 'number' || typeof cardCount !== 'number' || typeof docHeight !== 'number') {
        throw new Error(`Reference probe at ${vp.width}x${vp.height} produced no settled metrics: ${JSON.stringify(settled.metrics)}`);
      }
      if (cardCount < 1) {
        throw new Error(
          `Reference probe at ${vp.width}x${vp.height} settled with zero storefront cards, so the resulting minCards floor would be vacuous ` +
          `and could not detect an under-hydrated capture (sections=${sectionCount}).`
        );
      }
      readinessFloors[vp.label] = validateProbedFloor({ sectionCount, productCardCount: cardCount, docHeight }, vp);
      log(
        `reference floor for ${vp.label} (${vp.width}x${vp.height}): minSections=${sectionCount}, minCards=${cardCount}, ` +
        `settled=${settled.settle?.visualStable === true}, docHeight=${docHeight}`
      );

      // Capture stability is not asserted here with an extra rasterization: the
      // comparator and the standalone continuity capture both rasterize this same
      // tab later in the run, and viewport-run.mjs fails closed if those two
      // receipts disagree with each other.

      // Only the widest desktop target and the mobile target own reference artifacts.
      const ownsArtifact = isMobile || vp === desktopTarget;
      if (!ownsArtifact) continue;
      const artifactPath = isMobile ? refMobileHtmlPath : refHtmlPath;
      log(`capturing ${isMobile ? 'mobile ' : ''}reference HTML at ${vp.width}x${vp.height} to ${artifactPath}`);
      const dumpRes = await run('node', ['.canary/tools/dump-ref.mjs', refTabId, artifactPath, 'sanitize'], { timeoutMs: 300_000, env: childBootstrapEnv });
      if (dumpRes.code !== 0) {
        throw new Error(`dump-ref at ${vp.width}x${vp.height} failed (code ${dumpRes.code}): ${dumpRes.stderr.slice(0, 400)}`);
      }
      const parsedDump = JSON.parse(dumpRes.stdout);
      const floor = readinessFloors[vp.label];
      if (parsedDump.sectionCount < floor.minSections || parsedDump.cardCount < floor.minCards) {
        throw new Error(
          `Captured reference at ${vp.width}x${vp.height} is under-hydrated: artifact sectionCount=${parsedDump.sectionCount}/cardCount=${parsedDump.cardCount} ` +
          `is below the settled floor sectionCount=${floor.minSections}/cardCount=${floor.minCards}.`
        );
      }
      log(`reference artifact validated at ${vp.width}x${vp.height}: ${parsedDump.bytes} bytes, sections=${parsedDump.sectionCount}, cards=${parsedDump.cardCount}, images=${parsedDump.images}`);
      fs.writeFileSync(path.join(EVIDENCE_DIR, isMobile ? 'reference-dump-mobile.json' : 'reference-dump-validated.json'), dumpRes.stdout);
      const artifactRecord = {
        viewport: { width: vp.width, height: vp.height },
        path: artifactPath,
        bytes: parsedDump.bytes,
        sha256: parsedDump.sha256,
        sectionCount: parsedDump.sectionCount,
        cardCount: parsedDump.cardCount,
        images: parsedDump.images,
        removed: parsedDump.removed,
        settled: settled.settle,
      };
      if (isMobile) refCapture.mobile = artifactRecord;
      else refCapture.desktop = artifactRecord;
      log(`${isMobile ? 'mobile reference' : 'reference'} captured: ${parsedDump.bytes} bytes, sections=${parsedDump.sectionCount}, cards=${parsedDump.cardCount}, images=${parsedDump.images}`);
    }
    if (hasMobileViewport && !fs.existsSync(refMobileHtmlPath)) {
      throw new Error(`Mobile reference capture failed to produce required artifact at ${refMobileHtmlPath}`);
    }
    const currentRefSha = sha256(fs.readFileSync(refHtmlPath));
    fs.writeFileSync(refFloorsFile, JSON.stringify({ refSha256: currentRefSha, floors: readinessFloors }, null, 2));
  }
  pipeline.steps.referenceCapture = refCapture;
  pipeline.steps.readinessFloors = readinessFloors;
  persist();
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
    const desktopEntry = path.join(RUN_DIR, 'clone', 'index.html');
    if (!fs.existsSync(desktopEntry)) {
      throw new Error(`build-clone reported success but produced no bundle entry at ${desktopEntry}`);
    }
    log('clone bundle built');
  }
  // ── 4b. mobile clone pipeline (required if target viewports include mobile) ──
  if (hasMobileViewport) {
    const mobileCloneDir = path.join(RUN_DIR, 'clone', 'mobile');
    const mobileTelemetryPath = path.join(EVIDENCE_DIR, 'build-telemetry-mobile.json');
    const mobileEntry = path.join(mobileCloneDir, 'index.html');
    if (SKIP_BUILD && fs.existsSync(mobileEntry)) {
      log('mobile clone build skipped (--skip-build, reusing existing mobile bundle)');
      pipeline.steps.buildMobile = { skipped: true, telemetry: mobileTelemetryPath };
    } else {
      log('building independent HTML mobile clone (real pipeline)');
      const buildMobile = await run('node', ['.canary/tools/build-clone.mjs', refMobileHtmlPath, mobileCloneDir, mobileTelemetryPath], { timeoutMs: 1_800_000 });
      fs.writeFileSync(path.join(EVIDENCE_DIR, 'build-mobile.log'), buildMobile.stdout + (buildMobile.stderr ? `\n--- stderr ---\n${buildMobile.stderr}` : ''));
      pipeline.steps.buildMobile = { code: buildMobile.code, elapsedMs: buildMobile.elapsedMs, stdout: buildMobile.stdout.slice(0, 4000), stderr: buildMobile.stderr.slice(0, 4000) };
      if (buildMobile.code !== 0) {
        throw new Error(`build-clone for mobile failed (code ${buildMobile.code}): ${buildMobile.stderr.slice(0, 400)}`);
      }
      log('mobile clone bundle built at clone/mobile');
    }
    if (!fs.existsSync(mobileEntry)) throw new Error(`mobile clone entry missing: ${mobileEntry}`);
    pipeline.steps.bundleMobile = {
      entry: mobileEntry,
      entrySha256: sha256(fs.readFileSync(mobileEntry)),
      tree: hashTree(mobileCloneDir),
    };
  }
  const cloneEntry = path.join(RUN_DIR, 'clone', 'index.html');
  if (!fs.existsSync(cloneEntry)) throw new Error(`clone entry missing: ${cloneEntry}`);
  pipeline.steps.bundle = { entry: cloneEntry, entrySha256: sha256(fs.readFileSync(cloneEntry)), tree: hashTree(path.join(RUN_DIR, 'clone'), ['mobile']) };
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
  cloneTabId = ct.tabId || ct.result?.tabId;
  pipeline.steps.tabs = { referenceTabId: refTabId, cloneTabId, cloneUrl };
  persist();

  // ── 7. per-viewport runs ───────────────────────────────────────────────────
  if (!readinessFloors || typeof readinessFloors !== 'object') {
    throw new Error('readinessFloors must be an object before running per-viewport runs');
  }
  pipeline.viewportRuns = [];
  // A capture that fails to settle quarantines its tab. The quarantine is
  // invisible to an evaluate probe, so the next viewport would inherit it and
  // report drains instead of a verdict. Replace the tab once that is observed.
  let refTabNeedsReplacement = false;
  for (const vp of VIEWPORTS) {
    log(`viewport ${vp.width}x${vp.height} (${vp.label})`);
    const floor = readinessFloors[vp.label];
    if (
      !floor ||
      floor.width !== vp.width ||
      floor.height !== vp.height ||
      typeof floor.minSections !== 'number' ||
      !Number.isInteger(floor.minSections) ||
      floor.minSections < 1 ||
      typeof floor.minCards !== 'number' ||
      !Number.isInteger(floor.minCards) ||
      floor.minCards < 0
    ) {
      throw new Error(`Missing or invalid readiness floor for viewport ${vp.label} in readinessFloors: ${JSON.stringify(floor)}`);
    }
    // The whole run keeps exactly two browser tabs: one live reference and one
    // clone. The reference artifact, the floors and every viewport comparison are
    // therefore measured on the same tab in one frozen page state. Per-viewport
    // reference tabs were tried and reverted: they multiply live storefront tabs,
    // and they let the artifact and the compare describe different live states
    // (measured: an artifact with 14 sections compared against a fresh tab that
    // had mounted 13).
    let vpRefTabId = refTabId;
    let vpPrehydrated = false;
    try {
      if (refTabNeedsReplacement || !(await probeTabHealth(vpRefTabId))) {
        // One bounded replacement per viewport, for a tab that is gone (host
        // restart, closed target) or left quarantined by a drained capture. The
        // artifact and the floors still describe this run's reference; only the
        // tab object changes, so a drained 1440 no longer decides 1024.
        const why = refTabNeedsReplacement ? 'was quarantined by a drained capture' : 'is unreachable';
        refTabNeedsReplacement = false;
        log(`  ${vp.label}: reference tab ${vpRefTabId} ${why}; replacing it`);
        await call('anti.browser.tabs.close', { tabId: vpRefTabId }, 15_000).catch(() => null);
        const rt = await call('anti.browser.tabs.create', { url: REF_URL, activate: true }, 60_000);
        const replacement = rt.tabId || rt.result?.tabId;
        if (!replacement) throw new Error('tab replacement returned no tab id');
        refTabId = replacement;
        vpRefTabId = replacement;
        pipeline.steps.tabs = { referenceTabId: refTabId, cloneTabId, cloneUrl, referenceTabReplaced: true };
        persist();
      }
      await call('browser.switch-tab', { tabId: vpRefTabId }, 30_000).catch(() => null);
      // Atomic viewport + reload, then the shared hydration contract. The child is
      // told the tab is already hydrated, so nothing reloads the reference between
      // this measurement, the artifact and the comparison.
      await call('browser.set-viewport', {
        tabId: vpRefTabId,
        width: vp.width,
        height: vp.height,
        mobile: vp.width < 768,
        deviceScaleFactor: 1,
        reload: true,
      });
      const vpHydration = await hydrateToCapturedState(vpRefTabId, `${vp.label}-reference-tab`, { leaseToken: lease.leaseToken });
      const vm = vpHydration.settled.metrics || {};
      if ((vm.sectionCount ?? 0) < floor.minSections || (vm.productCardCount ?? 0) < floor.minCards) {
        throw new Error(
          `reference tab for ${vp.label} is below the measured floor (sections=${vm.sectionCount}, cards=${vm.productCardCount}, ` +
          `floor=${floor.minSections}/${floor.minCards})`
        );
      }
      const heightDrift = floor.docHeight ? Math.abs((vm.docHeight ?? 0) - floor.docHeight) / floor.docHeight : 0;
      if (floor.docHeight && heightDrift > 0.05) {
        throw new Error(
          `reference tab for ${vp.label} is not in the captured state: docHeight=${vm.docHeight} deviates ${(heightDrift * 100).toFixed(1)}% ` +
          `from the probed floor ${floor.docHeight}`
        );
      }
      vpPrehydrated = true;
      log(`  ${vp.label}: reference tab ${vpRefTabId} hydrated at docHeight=${vm.docHeight}`);
    } catch (e) {
      log(`  ${vp.label}: reference tab hydration failed: ${e.message}; child retries the load on its own`);
    }
    const r = await run('node', [
      '.canary/tools/viewport-run.mjs',
      vp.label, String(vp.width), String(vp.height), vpRefTabId, cloneTabId, RUN_DIR,
      String(floor.minSections), String(floor.minCards),
    ], {
      timeoutMs: 1_200_000,
      env: {
        ...childBootstrapEnv,
        CANARY_SELF_DRIFT: '1',
        CANARY_COMPARE_TIMEOUT_MS: '240000',
        CANARY_STANDALONE_TIMEOUT_MS: '120000',
        CANARY_EVIDENCE_RUN_ID: evidenceRunId ?? lease.runId,
        CANARY_AUTHORITY_RUN_ID: lease.runId,
        ...(vpPrehydrated ? { CANARY_REFERENCE_PREHYDRATED: '1' } : {}),
        CANARY_LEASE_TOKEN: lease.leaseToken,
        CANARY_FLOOR_DOC_HEIGHT: floor.docHeight ? String(floor.docHeight) : '',
        CANARY_CLONE_DIR: vp.width < 768 ? path.join(RUN_DIR, 'clone', 'mobile') : path.join(RUN_DIR, 'clone'),
      },
    });
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${vp.label}.log`), r.stdout + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''));
    const evidenceFile = path.join(EVIDENCE_DIR, `${vp.label}.json`);
    let evidence = null;
    if (fs.existsSync(evidenceFile)) {
      try { evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')); } catch (e) { evidence = { parseError: String(e.message) }; }
    }
    // Fail closed on provenance: an evidence file that is not bound to this lease
    // describes a different run and must never be summarised as this one's result.
    if (evidence && !evidence.parseError && evidence.evidenceRunId !== evidenceRunId) {
      const foreignRunId = evidence.evidenceRunId ?? null;
      evidence = {
        status: 'EVIDENCE_STALE',
        error: `evidence file declares evidenceRunId=${foreignRunId} but this run is ${evidenceRunId}`,
      };
      log(`  ${vp.label}: EVIDENCE_STALE (file evidenceRunId=${foreignRunId})`);
    }
    // Drain detection reads the child's own failure text: the quarantine surfaces as
    // a capture that did not settle, in the full-page comparison or the self-drift pair.
    const drainText = JSON.stringify([
      evidence?.stages?.compare?.error,
      evidence?.selfDrift?.error,
      evidence?.error,
      evidence?.stagingError,
    ]).slice(0, 4000);
    if (/DRAINING|did not settle|quarantin/i.test(drainText)) {
      refTabNeedsReplacement = true;
      log(`  ${vp.label}: capture drain observed; the reference tab will be replaced before the next viewport`);
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
  // The run owns exactly the two tabs it opened (one live reference, one clone).
  // Leaving them behind accumulates live storefront renderers across runs.
  if (!KEEP_TABS) {
    for (const [role, id] of [['reference', refTabId], ['clone', cloneTabId]]) {
      if (!id || id === boot.tabId) continue;
      try {
        await call('anti.browser.tabs.close', { tabId: id }, 15_000);
        log(`closed ${role} tab ${id}`);
      } catch (e) {
        log(`${role} tab close warning: ${e.message}`);
      }
    }
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
