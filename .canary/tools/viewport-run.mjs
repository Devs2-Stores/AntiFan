/**
 * Real-canary viewport runner: reference vs independent clone at one viewport.
 *
 *   node .canary/tools/viewport-run.mjs <label> <width> <height> <refTabId> <cloneTabId> [runDir] [minSections] [minCards]
 *
 * Evidence model (never merged):
 *   - INDEPENDENT lineage  : anti.screenshot.full_page per tab -> raw PNG + receipt + SHA256.
 *                            Continuity evidence only; NEVER an authoritative pixel input.
 *   - AUTHORITATIVE lineage: one atomic anti.visual.compare pair captured under a single pair
 *                            lock. The only pixel inputs the verdict may use.
 *   - STRUCTURAL           : unmasked geometry/cardinality probes on both sides.
 *   - SELF-DRIFT           : optional reference-vs-reference pair (CANARY_SELF_DRIFT=1),
 *                            diagnostic only; never subtracted from the candidate mismatch.
 *
 * Strict fidelity parameters are mandatory here: allowHeightDrift:false,
 * useDefaultWidgetMasks:false, no user masks.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { call, evalOn, bootstrap } from './lib-rpc.mjs';
import { hydrateToCapturedState, requireDoubleSettledMetrics } from './canary-settle.mjs';
import { sha256Buffer, sha256File } from '../../scripts/lib/atomic-record.mjs';
import { detectBundleDrift, loadInstanceIdentity, PROVENANCE_CODES } from '../../scripts/lib/evidence-provenance.mjs';


const [, , label, widthArg, heightArg, refTabId, cloneTabId, runDirArg, minSectionsArg, minCardsArg] = process.argv;
if (!label || !widthArg || !heightArg || !refTabId || !cloneTabId) {
  console.error('usage: viewport-run.mjs <label> <width> <height> <refTabId> <cloneTabId> [runDir] [minSections] [minCards]');
  process.exit(2);
}
const width = Number(widthArg);
const height = Number(heightArg);
// Readiness floors are derived from the captured reference artifact (never invented
// per-run): the reference must still expose at least this structure before any
// pixel verdict is meaningful.
const minSections = Number(minSectionsArg || 1);
const minCards = Number(minCardsArg || 1);
// Settled document height of the reference at probe time. Counts alone accept an
// over-expanded page (measured: 6756px against a 5546px floor passed the count
// floor and was compared, reporting the reference's broken state as a 27.5% clone
// mismatch), so the state the artifact was captured in is part of readiness.
const floorDocHeight = Number(process.env.CANARY_FLOOR_DOC_HEIGHT || 0);
const runDir = path.resolve(runDirArg || '.canary/run1');
// The controller hands over the attempt's evidence root. When it does, it
// replaces the legacy per-page directory for every document this runner writes;
// when it does not, the legacy path must stay byte-identical because the report
// readers still resolve it.
const evDir = process.env.CANARY_EVIDENCE_ROOT
  ? path.resolve(process.env.CANARY_EVIDENCE_ROOT)
  : path.join(runDir, 'evidence');
// persist(), failClosed() and the terminal write all resolve through this one
// function: a second path expression could drift and leave a verdict outside the
// attempt whose bundle it judges.
const evidenceDocPath = () => path.join(evDir, `${label}.json`);
fs.mkdirSync(evDir, { recursive: true });

// The minted identity is carried in verbatim from the build stage. Re-deriving it
// here would reintroduce the check-then-rebuild window the attempt layout removes,
// so an unreadable block is recorded as null with its reason in `provenanceGap`
// and never silently omitted or invented.
const bundleParse = (() => {
  const raw = process.env.CANARY_BUNDLE_IDENTITY;
  if (!raw) return { identity: null, gap: 'CANARY_BUNDLE_IDENTITY is not set' };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.entryPath !== 'string' || typeof parsed.entrySha256 !== 'string') {
      return { identity: null, gap: 'CANARY_BUNDLE_IDENTITY did not carry entryPath/entrySha256' };
    }
    return { identity: parsed, gap: null };
  } catch (e) {
    return { identity: null, gap: `CANARY_BUNDLE_IDENTITY is not valid JSON (${String(e && e.message).slice(0, 120)})` };
  }
})();
const bundleIdentity = bundleParse.identity;
// The entry this tier expects to be served. Its hash is read once here and
// compared against the document the clone tab is actually displaying.
const servedEntryPath = process.env.CANARY_SERVED_ENTRY ? path.resolve(process.env.CANARY_SERVED_ENTRY) : null;
const servedEntrySha256 = servedEntryPath && fs.existsSync(servedEntryPath) ? sha256File(servedEntryPath) : null;
const instanceIdentity = loadInstanceIdentity();
const provenanceGap = [
  bundleParse.gap ? `bundle: ${bundleParse.gap}` : null,
  instanceIdentity ? null : 'instance: .canary/state/canary-session.json is absent or unreadable',
].filter(Boolean).join('; ') || null;

const COMPARE_TIMEOUT_MS = Number(process.env.CANARY_COMPARE_TIMEOUT_MS || 240000);
const STANDALONE_TIMEOUT_MS = Number(process.env.CANARY_STANDALONE_TIMEOUT_MS || 120000);
const SKIP_COMPARE = process.env.CANARY_SKIP_COMPARE === '1';
const SECTION_BANDS = process.env.CANARY_SECTION_BANDS === '1';
const SELF_DRIFT = process.env.CANARY_SELF_DRIFT === '1';
// The orchestrator hands over a freshly created reference tab that it already
// hydrated and verified against the measured floor. Re-running the viewport
// switch and the hydration capture on that tab re-enters the live site's mount
// sequence and can measure a partially mounted page (measured once: 13 sections
// against a floor of 14), so the near side is measured in place instead.
const REFERENCE_PREHYDRATED = process.env.CANARY_REFERENCE_PREHYDRATED === '1';
// Exclusive evidence-run lease minted by canary-run.mjs (artifact.preflight).
// Every staging capability must present it while the lease is held, otherwise
// the runtime rejects the stage with TRANSACTION_CONFLICT.
const LEASE_TOKEN = process.env.CANARY_LEASE_TOKEN || null;
const LEASE_PARAM = LEASE_TOKEN ? { leaseToken: LEASE_TOKEN } : {};

const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const TRACKED = [
  'body', 'header.site-header', 'main', '.site-footer', 'section',
  '.product-list__item', '.slide', '.news-item',
];


/**
 * Fail closed: a pixel verdict is only meaningful when both sides reached a real
 * settled state and the reference still exposes the structure it was captured with.
 */
function evaluateReadiness(stage, role) {
  const s = stage.settle || {};
  const m = stage.metrics || {};
  const reasons = [];
  if (s.fontsSettled !== true) reasons.push('fontsSettled=false');
  if (s.imagesSettled !== true) reasons.push(`imagesSettled=false(pending=${s.pendingImages ?? '?'})`);
  if (s.domSettled !== true) reasons.push('domSettled=false');
  if (s.visualStable !== true) reasons.push('visualStable=false');
  if (s.mediaFrozen !== true) reasons.push(`mediaFrozen=${s.mediaFrozen}`);
  if ((s.pendingImages || 0) > 0) reasons.push(`pendingImages=${s.pendingImages}`);
  // Note: overflowX is an empirical defect recorded in metrics/structural, not a settlement failure.
  if (role === 'reference') {
    const requiredSections = minSections;
    if (requiredSections > 0 && (m.sectionCount || 0) < requiredSections) reasons.push(`sectionCount=${m.sectionCount}<${requiredSections}`);
    if (minCards > 0 && (m.productCardCount || 0) < minCards) reasons.push(`productCardCount=${m.productCardCount}<${minCards}`);
    if (floorDocHeight > 0) {
      const drift = Math.abs((m.docHeight || 0) - floorDocHeight) / floorDocHeight;
      if (drift > 0.05) reasons.push(`docHeight=${m.docHeight} deviates ${(drift * 100).toFixed(1)}% from floored ${floorDocHeight}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

const evidence = {
  label,
  viewport: { width, height },
  // Run identity: the authority runId that authorised staging, plus a
  // per-invocation stamp that tells this run's evidence from any other run
  // against the same authority.
  runId: process.env.CANARY_AUTHORITY_RUN_ID || null,
  evidenceRunId: process.env.CANARY_EVIDENCE_RUN_ID || null,
  cloneDir: process.env.CANARY_CLONE_DIR || null,
  // Provenance is carried, never re-derived. A null block is recorded with its
  // reason in `provenanceGap`, so a reader can tell "not carried" from
  // "carried as empty" — the two states that produced the unjudgeable verdicts.
  bundle: bundleIdentity ? { ...bundleIdentity, servedEntryPath, servedEntrySha256 } : null,
  instance: instanceIdentity,
  provenanceGap,
  startedAt: new Date().toISOString(),
  evidenceModel: {
    independent: 'anti.screenshot.full_page per tab — continuity evidence only, never an authoritative pixel input',
    authoritative: 'single atomic anti.visual.compare pair under one pair lock — the only authoritative pixel inputs',
    strictParams: { allowHeightDrift: false, useDefaultWidgetMasks: false, userMasks: [] },
  },
  stages: {},
};
const persist = () => fs.writeFileSync(evidenceDocPath(), JSON.stringify(evidence, null, 2));

// A staging failure must still leave a durable record. A bare crash writes no
// file, and a missing file is indistinguishable from a viewport that never ran,
// which is how a quarantined reference tab silently removed a whole viewport's
// evidence from the run.
const failClosed = (err) => {
  try {
    evidence.status = evidence.status || 'STAGING_FAILED';
    evidence.stagingError = String((err && err.message) || err).slice(0, 800);
    persist();
    log(`STAGING_FAILED: ${evidence.stagingError}`);
  } catch {}
  process.exit(1);
};
process.on('unhandledRejection', failClosed);
process.on('uncaughtException', failClosed);

// ── Campaign provenance presence gate ─────────────────────────────────────────
// A campaign invocation declares an attempt, the entry it serves and the instance
// that owns the bridge; a verdict written without any of the three names nothing
// it measured, so the case is refused before the first capture. The legacy
// standalone arm (canary-run.mjs) declares none of these and is untouched: its
// behaviour is decided by `campaignMode` alone.
const campaignMode = Boolean(process.env.CANARY_EVIDENCE_ROOT || process.env.CANARY_ATTEMPT_DIR);
if (campaignMode) {
  if (!bundleIdentity) {
    refuseProvenance({
      code: PROVENANCE_CODES.IDENTITY_MISSING,
      reason: `campaign run carries no minted bundle identity (${bundleParse.gap})`,
      observedSha256: null,
      servedUrl: null,
    });
  } else if (!servedEntryPath) {
    refuseProvenance({
      code: PROVENANCE_CODES.IDENTITY_MISSING,
      reason: 'campaign run does not declare CANARY_SERVED_ENTRY, so no entry can be verified against the minted identity',
      observedSha256: null,
      servedUrl: null,
    });
  } else if (servedEntrySha256 === null) {
    refuseProvenance({
      code: PROVENANCE_CODES.IDENTITY_MISSING,
      reason: `declared served entry ${servedEntryPath} does not exist or is unreadable`,
      observedSha256: null,
      servedUrl: null,
    });
  } else if (!instanceIdentity) {
    refuseProvenance({
      code: PROVENANCE_CODES.IDENTITY_MISSING,
      reason: 'campaign run has no instance identity: .canary/state/canary-session.json is absent or unreadable',
      observedSha256: null,
      servedUrl: null,
    });
  }
}

/** Reference-vs-clone structural deltas (§11). Cardinality and geometry only. */
function buildStructuralComparison(ref, clone) {
  const delta = (a, b) => (typeof a === 'number' && typeof b === 'number') ? Math.round((b - a) * 100) / 100 : null;
  const box = (a, b) => (a && b) ? { dh: delta(a.h, b.h), dy: delta(a.y, b.y), dw: delta(a.w, b.w) } : null;
  const key = (s) => ((s.cls || '').split('.').filter(Boolean)[0]) || s.tag;
  const consumed = new Set();
  const sections = ref.sections.map((rs) => {
    const idx = clone.sections.findIndex((cs, i) => !consumed.has(i) && key(cs) === key(rs));
    if (idx === -1) return { cls: key(rs), reference: { y: Math.round(rs.rect.y), h: Math.round(rs.rect.h) }, clone: null, dh: null };
    consumed.add(idx);
    const cs = clone.sections[idx];
    return { cls: key(rs), reference: { y: Math.round(rs.rect.y), h: Math.round(rs.rect.h) }, clone: { y: Math.round(cs.rect.y), h: Math.round(cs.rect.h) }, dh: Math.round(cs.rect.h - rs.rect.h) };
  });
  return {
    docHeight: { reference: ref.docHeight, clone: clone.docHeight, delta: delta(ref.docHeight, clone.docHeight), ratio: ref.docHeight ? Math.round((clone.docHeight / ref.docHeight) * 1000) / 1000 : null },
    overflowX: { reference: ref.overflowX, clone: clone.overflowX },
    sectionCount: { reference: ref.sectionCount, clone: clone.sectionCount, delta: delta(ref.sectionCount, clone.sectionCount) },
    productCardCount: { reference: ref.productCardCount, clone: clone.productCardCount, delta: delta(ref.productCardCount, clone.productCardCount) },
    articleCardCount: { reference: ref.articleCardCount, clone: clone.articleCardCount, delta: delta(ref.articleCardCount, clone.articleCardCount) },
    navItemCount: { reference: ref.navItemCount, clone: clone.navItemCount, delta: delta(ref.navItemCount, clone.navItemCount) },
    linkCount: { reference: ref.linkCount, clone: clone.linkCount, delta: delta(ref.linkCount, clone.linkCount) },
    imageCount: { reference: ref.imageCount, clone: clone.imageCount, delta: delta(ref.imageCount, clone.imageCount) },
    brokenImages: { reference: ref.brokenImages.length, clone: clone.brokenImages.length },
    header: box(ref.headerRect, clone.headerRect),
    main: box(ref.mainRect, clone.mainRect),
    footer: box(ref.footerRect, clone.footerRect),
    sections
  };
}

/** Fetch an immutable artifact over the bridge HTTP endpoint in bounded chunks and persist it locally. */
async function fetchArtifact(artifactId, outFile) {
  const boot = bootstrap;
  const CHUNK = 1024 * 1024;
  const chunks = [];
  let offset = 0;
  for (;;) {
    const { buffer, hasMore } = await new Promise((resolve, reject) => {
      const p = `/api/artifacts/${encodeURIComponent(artifactId)}?offset=${offset}&limit=${CHUNK}`;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: boot.port,
          path: p,
          headers: {
            'x-antifan-attachment-secret': boot.secret,
            'Authorization': `Bearer ${boot.secret}`,
          },
        },
        (r) => {
          const parts = [];
          r.on('data', (d) => parts.push(d));
          r.on('end', () =>
            r.statusCode === 200
              ? resolve({ buffer: Buffer.concat(parts), hasMore: r.headers['x-artifact-has-more'] === 'true' })
              : reject(new Error(`artifact fetch status ${r.statusCode}`))
          );
        }
      );
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('ARTIFACT_STREAM_TIMEOUT')));
      req.end();
    });
    chunks.push(buffer);
    offset += buffer.length;
    if (!hasMore || buffer.length === 0) break;
  }
  const buf = Buffer.concat(chunks);
  const isPng = buf.length >= 8 && buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
  const hasIend = buf.length >= 8 && buf.subarray(-8, -4).toString('latin1') === 'IEND';
  if (!isPng || !hasIend) {
    throw new Error(`artifact ${artifactId} is not a complete PNG (isPng=${isPng} hasIend=${hasIend} bytes=${buf.length})`);
  }
  fs.writeFileSync(outFile, buf);
  return { bytes: buf.length, sha256: sha256(buf) };
}

// ── Served-entry provenance gate ──────────────────────────────────────────────
// A verdict must name the bundle it judged, so the entry this tier expects to be
// served is compared against the document the clone tab is actually displaying.
// The served document is fetched over loopback from the tab's own URL: a tab
// pointed at some other directory refuses with BUNDLE_IDENTITY_MISMATCH instead
// of yielding a pixel verdict about a bundle this run never built.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function httpGetBuffer(rawUrl, depth = 0) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(rawUrl);
    } catch {
      reject(new Error(`served URL is not absolute: ${rawUrl}`));
      return;
    }
    if (!LOOPBACK_HOSTS.has(target.hostname)) {
      reject(new Error(`served document is not on loopback: ${target.hostname}`));
      return;
    }
    const req = http.get(
      { hostname: target.hostname, port: target.port || 80, path: `${target.pathname}${target.search}`, timeout: 30_000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 3) {
          res.resume();
          httpGetBuffer(new URL(res.headers.location, target.origin).toString(), depth + 1).then(resolve, reject);
          return;
        }
        const parts = [];
        res.on('data', (d) => parts.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
      }
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('SERVED_ENTRY_FETCH_TIMEOUT')));
    req.end();
  });
}

async function resolveServedUrl() {
  const fromTab = await evalOn(cloneTabId, 'location.origin + location.pathname', 5000).catch(() => null);
  if (typeof fromTab === 'string' && /^https?:\/\//i.test(fromTab)) {
    const parsed = new URL(fromTab);
    return { url: `${parsed.origin}${parsed.pathname}`, source: 'clone tab location' };
  }
  // An unreadable page context is not a licence to skip the check: the tab census
  // names the same URL from the browser's side rather than the page's.
  try {
    const listing = await call('anti.browser.tabs.list', {}, 15_000);
    const tabs = listing?.tabs || listing?.result?.tabs || (Array.isArray(listing) ? listing : []);
    const tab = tabs.find((t) => String(t?.tabId ?? t?.id ?? '') === String(cloneTabId));
    if (tab && typeof tab.url === 'string' && /^https?:\/\//i.test(tab.url)) {
      const parsed = new URL(tab.url);
      return { url: `${parsed.origin}${parsed.pathname}`, source: 'clone tab census' };
    }
  } catch {}
  return null;
}

/**
 * Refuse the case: no compare is issued and no pixel verdict is ever promoted.
 * One shape for every refusal, so the index reads a single cause field whether the
 * refusal is a wrong served entry or an absent provenance block.
 */
function refuseProvenance({ code = PROVENANCE_CODES.IDENTITY_MISMATCH, reason, observedSha256, servedUrl }) {
  const refusal = {
    code,
    expectedSha256: servedEntrySha256,
    mintedSha256: bundleIdentity?.entrySha256 ?? null,
    observedSha256: observedSha256 ?? null,
    servedUrl: servedUrl ?? null,
    expectedEntryPath: servedEntryPath,
  };
  evidence.status = code;
  // A case with no carried bundle has no block to hang the cause on, so the
  // refusal is mirrored at the top level as well.
  evidence.refusal = refusal;
  evidence.visual = { verdict: 'INCONCLUSIVE', reason, refusal };
  persist();
  log(`REFUSAL: ${code} — ${reason}`);
  process.exit(4);
}

async function assertServedEntryMatchesMinted() {
  if (!servedEntryPath) return;
  const resolved = await resolveServedUrl();
  if (!resolved) {
    refuseProvenance({
      reason: 'the clone tab URL could not be read, so the served entry cannot be verified against the minted identity',
      observedSha256: null,
      servedUrl: null,
    });
    return;
  }
  let observed;
  try {
    observed = await httpGetBuffer(resolved.url);
  } catch (e) {
    refuseProvenance({
      reason: `served document could not be fetched over loopback: ${String(e && e.message).slice(0, 200)}`,
      observedSha256: null,
      servedUrl: resolved.url,
    });
    return;
  }
  if (observed.status !== 200) {
    refuseProvenance({
      reason: `served document returned HTTP ${observed.status}`,
      observedSha256: null,
      servedUrl: resolved.url,
    });
    return;
  }
  const observedSha256 = sha256Buffer(observed.body);
  const mintedSha256 = bundleIdentity?.entrySha256 ?? null;
  // The carried identity is the page's desktop mint, while the expected entry is
  // this tier's: for 390 they are legitimately different files. The minted digest
  // is therefore only binding when this tier IS the minted tier; the expected-entry
  // digest is the check that applies to every tier.
  const mintedIsThisTier = Boolean(bundleIdentity?.entryPath) && path.resolve(bundleIdentity.entryPath) === servedEntryPath;
  const matchesExpected = observedSha256 === servedEntrySha256;
  const matchesMinted = !mintedIsThisTier || observedSha256 === mintedSha256;
  if (!matchesExpected || !matchesMinted) {
    // Name only the comparison that actually failed: "the wrong directory for this
    // tier" and "not the entry the build minted" are different diagnoses, and
    // conflating them sends the operator to the wrong directory.
    const failed = [];
    if (!matchesExpected) failed.push(`the entry expected at ${servedEntryPath} (sha256 ${servedEntrySha256})`);
    if (!matchesMinted) failed.push(`the minted identity at ${bundleIdentity.entryPath} (sha256 ${mintedSha256})`);
    refuseProvenance({
      reason: `served entry ${resolved.url} (sha256 ${observedSha256}) does not equal ${failed.join(' nor ')}`,
      observedSha256,
      servedUrl: resolved.url,
    });
    return;
  }
  const verified = {
    ok: true,
    sha256: observedSha256,
    bytes: observed.body.length,
    servedUrl: resolved.url,
    urlSource: resolved.source,
    tierIsMintedTier: mintedIsThisTier,
    mintedSha256,
  };
  // Without a carried identity there is no `bundle` block to attach the proof to;
  // reporting it at the top level keeps the observation instead of dropping it.
  if (evidence.bundle) evidence.bundle.servedEntryVerified = verified;
  else evidence.servedEntryVerified = verified;
  log(`served entry verified: ${resolved.url} sha256=${observedSha256.slice(0, 16)}… bytes=${observed.body.length} (${resolved.source})`);
  persist();
}

const isMobile = width < 768;
const dpr = 1;
log(`set viewport ${width}x${height} (mobile=${isMobile}, dpr=${dpr}) on both tabs (atomic viewport + reload)`);
// A tab that has never been foregrounded reports innerHeight=0 and lays out
// against a zero-height viewport; a reload in the background re-enters that
// degenerate state. Establish each side's viewport and hydrate it while it is
// foreground, then move on to the other side (a foregrounded tab keeps its real
// layout once backgrounded).
if (REFERENCE_PREHYDRATED) {
  log('reference tab is prehydrated by the orchestrator: measuring in place');
} else {
  await call('browser.switch-tab', { tabId: refTabId }, 30_000).catch((e) => log(`reference activate warning: ${e.message}`));
  await call('browser.set-viewport', { tabId: refTabId, width, height, mobile: isMobile, deviceScaleFactor: dpr, reload: true });
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 400));
    try {
      const r = await evalOn(refTabId, '({ rs: document.readyState, h: document.documentElement.scrollHeight })', 5000);
      if (r && r.rs === 'complete') break;
    } catch {}
  }
  await evalOn(refTabId, `(async () => {
    document.querySelectorAll('img[loading="lazy"]').forEach(img => {
      try { img.loading = 'eager'; } catch {}
    });
    await Promise.all(
      Array.from(document.images)
        .filter(i => !i.complete)
        .map(i => new Promise(resolve => {
          i.addEventListener('load', resolve, { once: true });
          i.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 6000);
        }))
    );
    window.scrollTo(0, 0);
    return true;
  })()`, 15000).catch(() => null);
}

// Hydration contract, shared with canary-run.mjs: rasterizing the document is
// what mounts the storefront's remaining sections, so the authoritative state is
// the post-capture one. Measuring before it gates readiness on a pre-mount page.
if (REFERENCE_PREHYDRATED) {
  evidence.stages.reference = await requireDoubleSettledMetrics(refTabId, 'reference');
  evidence.hydration = { reference: { source: 'orchestrator reference tab (already captured into the mounted state)', byteLength: null } };
} else {
  log('materializing reference (full-page rasterize) then settling + measuring');
  const refHydration = await hydrateToCapturedState(refTabId, 'reference', LEASE_PARAM);
  evidence.stages.reference = refHydration.settled;
  evidence.hydration = { reference: { byteLength: refHydration.capture?.byteLength ?? refHydration.capture?.bytes ?? null } };
}
const refReadiness = evaluateReadiness(evidence.stages.reference, 'reference');
evidence.readiness = { reference: refReadiness };
log(`reference docHeight=${evidence.stages.reference.metrics.docHeight} sections=${evidence.stages.reference.metrics.sectionCount} cards=${evidence.stages.reference.metrics.productCardCount} ready=${refReadiness.ok}`);
if (!refReadiness.ok) {
  evidence.status = 'REFERENCE_NOT_READY';
  persist();
  log(`ABORT: reference not ready [${refReadiness.reasons.join('; ')}] — no pixel verdict produced`);
  process.exit(3);
}
if (isMobile) {
  // The mobile bundle belongs to the same attempt as the desktop bundle; the
  // attempt directory is what makes the pair immutable together.
  const cloneRootDir = process.env.CANARY_ATTEMPT_DIR
    ? path.join(path.resolve(process.env.CANARY_ATTEMPT_DIR), 'clone')
    : path.join(runDir, 'clone');
  const mobileEntry = path.join(cloneRootDir, 'mobile', 'index.html');
  if (!fs.existsSync(mobileEntry)) {
    throw new Error(`Mobile viewport run requires independent mobile bundle at ${mobileEntry}`);
  }
  const currentUrl = await evalOn(cloneTabId, 'location.href', 5000).catch(() => '');
  if (!currentUrl.includes('/mobile')) {
    const origin = await evalOn(cloneTabId, 'location.origin', 5000).catch(() => '');
    if (origin) {
      log(`navigating clone tab to mobile bundle: ${origin}/mobile/`);
      await call('browser.navigate', { tabId: cloneTabId, url: `${origin}/mobile/` }, 30_000);
    }
  }
} else {
  const currentUrl = await evalOn(cloneTabId, 'location.href', 5000).catch(() => '');
  if (currentUrl.includes('/mobile')) {
    const origin = await evalOn(cloneTabId, 'location.origin', 5000).catch(() => '');
    if (origin) {
      log(`navigating clone tab back to desktop bundle: ${origin}/`);
      await call('browser.navigate', { tabId: cloneTabId, url: `${origin}/` }, 30_000);
    }
  }
}

// Provenance gate, before any compare and before the clone side is captured: the
// tab must be displaying the entry the build minted, or there is nothing this
// viewport may judge.
await assertServedEntryMatchesMinted();

await call('browser.switch-tab', { tabId: cloneTabId }, 30_000).catch((e) => log(`clone activate warning: ${e.message}`));
await call('browser.set-viewport', { tabId: cloneTabId, width, height, mobile: isMobile, deviceScaleFactor: dpr, reload: true });
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 400));
  try {
    const r = await evalOn(cloneTabId, '({ rs: document.readyState, h: document.documentElement.scrollHeight })', 5000);
    if (r && r.rs === 'complete') break;
  } catch {}
}
await evalOn(cloneTabId, `(async () => {
  document.querySelectorAll('img[loading="lazy"]').forEach(img => {
    try { img.loading = 'eager'; } catch {}
  });
  await Promise.all(
    Array.from(document.images)
      .filter(i => !i.complete)
      .map(i => new Promise(resolve => {
        i.addEventListener('load', resolve, { once: true });
        i.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 6000);
      }))
  );
  window.scrollTo(0, 0);
  return true;
})()`, 15000).catch(() => null);

// Same contract for the bundle: if rasterization changed either side, the pair
// the comparator produces would not be the pair that was gated.
log('materializing clone (full-page rasterize) then settling + measuring');
const cloneHydration = await hydrateToCapturedState(cloneTabId, 'clone', LEASE_PARAM);
evidence.stages.clone = cloneHydration.settled;
evidence.hydration.clone = { byteLength: cloneHydration.capture?.byteLength ?? cloneHydration.capture?.bytes ?? null };
const cloneReadiness = evaluateReadiness(evidence.stages.clone, 'clone');
evidence.readiness.clone = cloneReadiness;
log(`clone docHeight=${evidence.stages.clone.metrics.docHeight} sections=${evidence.stages.clone.metrics.sectionCount} cards=${evidence.stages.clone.metrics.productCardCount} ready=${cloneReadiness.ok}`);
if (!cloneReadiness.ok) {
  evidence.status = 'CLONE_NOT_READY';
  persist();
  log(`ABORT: clone not ready [${cloneReadiness.reasons.join('; ')}] — no pixel verdict produced`);
  process.exit(3);
}

evidence.structural = buildStructuralComparison(evidence.stages.reference.metrics, evidence.stages.clone.metrics);
persist();

// ── INDEPENDENT lineage: standalone canonical full-page capture per tab ────────
// Continuity evidence only. Never promoted to an authoritative compare input.
log('standalone full-page captures (independent lineage)');
evidence.standalone = {};
for (const [role, tabId] of [['reference', refTabId], ['clone', cloneTabId]]) {
  try {
    const res = await call('anti.screenshot.full_page', { tabId, ...LEASE_PARAM }, STANDALONE_TIMEOUT_MS);
    const artifactId = res?.artifactRef?.id || res?.artifactId || res?.artifactRef;
    const receipt = res?.receipt || res?.captureReceipt || null;
    const entry = {
      tabId,
      status: 'CAPTURED',
      artifactId,
      receipt,
      sha256: res?.sha256 ?? null,
      byteLength: res?.byteLength ?? null,
      authoritative: false,
      label: 'independent continuity evidence — NOT an authoritative pixel input',
    };
    if (artifactId) {
      try {
        const file = path.join(evDir, `${label}-standalone-${role}.png`);
        const saved = await fetchArtifact(artifactId, file);
        entry.file = path.basename(file);
        entry.fetchedBytes = saved.bytes;
        entry.fetchedSha256 = saved.sha256;
        entry.byteForByte = entry.sha256 ? saved.sha256 === entry.sha256 : null;
        if (entry.sha256 && saved.sha256 !== entry.sha256) {
          entry.status = 'CORRUPT_SHA';
          throw new Error(`standalone SHA mismatch: declared ${entry.sha256} vs fetched ${saved.sha256}`);
        }
        if (entry.byteLength && saved.bytes !== entry.byteLength) {
          entry.status = 'TRUNCATED_BYTES';
          throw new Error(`standalone byte mismatch: declared ${entry.byteLength} vs fetched ${saved.bytes}`);
        }
      } catch (e) {
        entry.fetchError = String(e.message || e).slice(0, 300);
      }
    }
    evidence.standalone[role] = entry;
    log(`  ${role} standalone ${entry.status} mode=${receipt?.captureMode ?? '?'} raster=${receipt?.rasterSize ? `${receipt.rasterSize.width}x${receipt.rasterSize.height}` : '?'} bytes=${entry.byteLength ?? '?'}`);
  } catch (e) {
    evidence.standalone[role] = { tabId, status: 'STANDALONE_CAPTURE_ERROR', error: String(e.message || e).slice(0, 500), authoritative: false };
    log(`  ${role} standalone FAILED: ${e.message}`);
  }
  persist();
}

// ── AUTHORITATIVE lineage: one atomic compare pair ────────────────────────────
log(`full-page visual compare (authoritative)${SKIP_COMPARE ? ' (skipped by CANARY_SKIP_COMPARE)' : ''}`);
let compare = null;
if (SKIP_COMPARE) {
  evidence.stages.compare = { status: 'SKIPPED' };
  evidence.visual = { status: 'SKIPPED' };
} else try {
  compare = await call('anti.visual.compare', {
    tabId: refTabId,
    comparisonTabId: cloneTabId,
    fullPage: true,
    tolerance: 2,
    normalizeScroll: true,
    allowHeightDrift: false,
    useDefaultWidgetMasks: false,
    trackedSelectors: TRACKED,
    ...LEASE_PARAM,
  }, COMPARE_TIMEOUT_MS);
  evidence.stages.compare = compare.result || compare;
  log(`mismatch=${compare.result?.mismatchPercentage}% dimsMatch=${compare.result?.dimensionsMatch}`);
} catch (e) {
  evidence.stages.compare = { status: 'COMPARE_ERROR', error: String(e.message || e).slice(0, 500), elapsedMs: Date.now() - T0 };
  log(`full-page compare FAILED: ${e.message}`);
}
const cr = compare?.result || compare || {};

// ── Rasterization stability gate ──────────────────────────────────────────────
// The comparator and the standalone continuity capture rasterize the same tabs
// through the same path. If the two receipts for one side disagree, that side
// moved between rasterizations, so the pair behind `cr` is not the pair that was
// gated and no pixel verdict may be promoted from it.
const receiptH = (r) => {
  const h = r?.cssCaptureSize?.height ?? r?.rasterSize?.height;
  return typeof h === 'number' ? h : null;
};
evidence.rasterizationStability = {};
// Only a completed comparison has receipts to compare against. When the
// comparison itself failed, its failure is the finding and must not be
// restated as an instability.
const compareReceipts = cr?.captureReceipts ?? null;
if (!compareReceipts) {
  evidence.rasterizationStability = { status: 'NOT_EVALUATED', reason: 'comparison produced no capture receipts' };
} else {
  const unstable = [];
  for (const [role, key] of [['reference', 'target'], ['clone', 'baseline']]) {
    const standaloneH = receiptH(evidence.standalone?.[role]?.receipt);
    const compareH = receiptH(compareReceipts[key]);
    const hydratedH = typeof evidence.stages?.[role]?.metrics?.docHeight === 'number' ? evidence.stages[role].metrics.docHeight : null;
    const stable = standaloneH !== null && compareH !== null && standaloneH === compareH;
    evidence.rasterizationStability[role] = { standaloneHeight: standaloneH, compareHeight: compareH, hydratedDocHeight: hydratedH, stable };
    if (!stable) {
      unstable.push(role);
      log(`  rasterization UNSTABLE for ${role}: standalone=${standaloneH} compare=${compareH} hydratedDocHeight=${hydratedH}`);
    }
  }
  if (unstable.length) {
    evidence.status = 'RASTERIZATION_UNSTABLE';
    evidence.visual = {
      status: 'RASTERIZATION_UNSTABLE',
      match: null,
      mismatchPercentage: null,
      verdict: 'INCONCLUSIVE',
      reason: `side(s) ${unstable.join(', ')} produced different full-page raster heights on the same tab, so the compared pair is not the gated pair`,
      captureReceipts: compareReceipts,
    };
    persist();
    log(`ABORT: RASTERIZATION_UNSTABLE (${unstable.join(', ')}) — pixel verdict withheld`);
    process.exit(3);
  }
}

const derivedVerdict = cr.dimensionsMatch === true
  ? (cr.match === true ? 'PASS' : 'FAIL')
  : (cr.verdict || (cr.status === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : null));
evidence.visual = {
  match: cr.match ?? null,
  mismatchPercentage: cr.mismatchPercentage ?? null,
  verdict: derivedVerdict,
  toolVerdict: cr.verdict ?? null,
  toolStatus: cr.status ?? null,
  reason: cr.reason ?? null,
  dimensionsMatch: cr.dimensionsMatch ?? null,
  diffPixels: cr.diffPixels ?? null,
  totalPixels: cr.totalPixels ?? null,
  diffBoundingBox: cr.diffBoundingBox ?? null,
  mask: cr.maskResolution ?? cr.maskAudit ?? null,
  layout: cr.dimensions?.layout ?? null,
  coherence: cr.coherence ?? null,
  captureReceipts: cr.captureReceipts ?? null,
  normalization: cr.normalization ?? null,
};
log(`visual mismatch=${evidence.visual.mismatchPercentage}% verdict=${evidence.visual.verdict} mask=${JSON.stringify(evidence.visual.mask)?.slice(0, 160)}`);
persist();

// Persist the authoritative pair (the ONLY pixel inputs the verdict may use).
evidence.authoritativePair = {};
const cur = cr.currentScreenshot;
const base = cr.baselineScreenshot;
const artifactId = (a) => (typeof a === 'string' ? a : a?.artifactId || a?.id || a?.artifactRef);
for (const [key, art] of [['reference', cur], ['clone', base]]) {
  const id = artifactId(art);
  if (!id) { evidence.authoritativePair[key] = { status: 'NO_ARTIFACT', raw: JSON.stringify(art ?? null).slice(0, 200) }; continue; }
  try {
    const file = path.join(evDir, `${label}-${key}.png`);
    const saved = await fetchArtifact(id, file);
    let stat = null;
    try { stat = await call('artifact.stat', { artifactId: id }, 10000); } catch {}
    const declaredSha = (typeof art === 'object' && typeof art?.sha256 === 'string') ? art.sha256 : (stat?.sha256 || null);
    const declaredBytes = (typeof art === 'object' && typeof art?.byteLength === 'number') ? art.byteLength : (stat?.byteLength || null);
    if (!declaredSha || typeof declaredSha !== 'string') {
      throw new Error(`missing declared SHA for artifact ${id}`);
    }
    if (!declaredBytes || typeof declaredBytes !== 'number' || declaredBytes <= 0) {
      throw new Error(`missing declared byte length for artifact ${id}`);
    }
    if (saved.sha256 !== declaredSha) {
      throw new Error(`authoritative SHA mismatch: declared ${declaredSha} vs fetched ${saved.sha256}`);
    }
    if (saved.bytes !== declaredBytes) {
      throw new Error(`authoritative byte mismatch: declared ${declaredBytes} vs fetched ${saved.bytes}`);
    }
    const byteForByte = Boolean(saved.bytes === declaredBytes && saved.sha256 === declaredSha);
    if (!byteForByte) {
      throw new Error(`authoritative byte-for-byte mismatch for ${id}`);
    }
    evidence.authoritativePair[key] = {
      status: 'PERSISTED',
      artifactId: id,
      file: path.basename(file),
      bytes: saved.bytes,
      sha256: saved.sha256,
      authoritative: true,
      declaredBytes,
      declaredSha,
      byteForByte,
    };
    log(`  saved authoritative ${key} ${saved.bytes} bytes sha256=${saved.sha256.slice(0, 16)}… byteForByte=${evidence.authoritativePair[key].byteForByte}`);
  } catch (e) {
    evidence.authoritativePair[key] = { status: 'FETCH_ERROR', artifactId: id, error: String(e.message || e).slice(0, 300), authoritative: true };
    log(`  authoritative ${key} fetch FAILED: ${e.message}`);
  }
}
persist();

// ── SELF-DRIFT (diagnostic only; never subtracted from the candidate) ─────────
if (SELF_DRIFT) {
  log('reference self-drift pair (diagnostic only)');
  try {
    const drift = await call('anti.visual.compare', {
      tabId: refTabId,
      comparisonTabId: refTabId,
      fullPage: true,
      tolerance: 2,
      normalizeScroll: true,
      allowHeightDrift: false,
      useDefaultWidgetMasks: false,
      trackedSelectors: TRACKED,
      ...LEASE_PARAM,
    }, COMPARE_TIMEOUT_MS);
    const dr = drift?.result || drift;
    evidence.selfDrift = {
      status: 'MEASURED',
      mismatchPercentage: dr?.mismatchPercentage ?? null,
      dimensionsMatch: dr?.dimensionsMatch ?? null,
      maskedAreaRatio: dr?.maskResolution?.maskedAreaRatio ?? null,
      note: 'diagnostic only — never subtracted from the candidate mismatch',
    };
    log(`  self-drift mismatch=${dr?.mismatchPercentage}%`);
  } catch (e) {
    evidence.selfDrift = { status: 'SELF_DRIFT_ERROR', error: String(e.message || e).slice(0, 400) };
    log(`  self-drift FAILED: ${e.message}`);
  }
  persist();
}

// Sectional diagnostics via clipRect (same rect on both tabs = like-for-like regions).
const refMetrics = evidence.stages.reference.metrics;
const cloneMetrics = evidence.stages.clone.metrics;
const bands = [];
const push = (name, rect) => { if (rect && rect.h > 8 && rect.w > 8) bands.push({ name, rect }); };
push('header', refMetrics.headerRect);
push('hero', refMetrics.heroRect);
for (const s of refMetrics.sections) push(`section:${s.cls || s.tag}`, s.rect);
push('footer', refMetrics.footerRect);
// Each band comparison rasterizes both full pages, so the band list is also the
// run's capture-budget list: a 14-section page cost 28 extra full-page captures
// and drained the reference tab before the diagnostics finished. Bands that
// already match structurally add nothing, so only the fixed anchors and the
// sections whose geometry actually differs are captured.
const differing = new Set(
  (evidence.structural?.sections || [])
    .filter((s) => s.clone === null || s.dh !== 0)
    .map((s) => s.cls)
);
const ANCHOR_BANDS = new Set(['header', 'hero', 'footer']);
const selectedBands = bands.filter((b) => ANCHOR_BANDS.has(b.name) || differing.has(b.name.replace(/^section:/, '')));
if (selectedBands.length !== bands.length) {
  log(`  sectional diagnostics reduced to ${selectedBands.length}/${bands.length} bands (anchors + structurally differing sections)`);
}
const seen = new Set();
evidence.stages.sections = [];
if (!SECTION_BANDS) {
  // Non-authoritative diagnostics: every band comparison rasterizes both full pages
  // again, and that capture budget is what quarantines the reference tab (measured:
  // the 1440 comparison drained mid-run and every later viewport inherited the
  // quarantined tab). Structural per-section geometry is measured from the DOM and
  // is unaffected by this flag.
  log(`  sectional band compares skipped (${selectedBands.length} bands available; set CANARY_SECTION_BANDS=1 to capture them)`);
  evidence.stages.sectionsSkipped = { reason: 'CANARY_SECTION_BANDS not set', bandsAvailable: selectedBands.map((b) => b.name) };
  persist();
} else if (SKIP_COMPARE || evidence.stages.compare?.status === 'COMPARE_ERROR') {
  log(`skipping sectional compares (${SKIP_COMPARE ? 'CANARY_SKIP_COMPARE' : 'full-page compare failed'})`);
  persist();
} else
for (const band of selectedBands) {
  const key = `${band.name}@${band.rect.y}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const rect = { x: 0, y: Math.round(band.rect.y), width: Math.round(refMetrics.clientWidth), height: Math.min(Math.round(band.rect.h), 2000) };
  const cloneHas = cloneMetrics.docHeight >= rect.y + 20;
  if (!cloneHas) {
    evidence.stages.sections.push({ name: band.name, rect, status: 'REGION_ABSENT_IN_CLONE', cloneDocHeight: cloneMetrics.docHeight });
    continue;
  }
  try {
    const r = await call('anti.visual.compare', {
      tabId: refTabId, comparisonTabId: cloneTabId, fullPage: true, tolerance: 2,
      normalizeScroll: true, allowHeightDrift: false, useDefaultWidgetMasks: false, clipRect: rect,
      ...LEASE_PARAM,
    }, Math.min(COMPARE_TIMEOUT_MS, 120000));
    const res = r.result || r;
    evidence.stages.sections.push({ name: band.name, rect, mismatchPercentage: res.mismatchPercentage, dimensionsMatch: res.dimensionsMatch, diffPixels: res.diffPixels, totalPixels: res.totalPixels, maskRatio: res.maskResolution?.maskedAreaRatio });
    log(`  section ${band.name} @y=${rect.y} h=${rect.height}: ${res.mismatchPercentage}%`);
  } catch (e) {
    evidence.stages.sections.push({ name: band.name, rect, status: 'COMPARE_ERROR', error: String(e.message || e).slice(0, 300) });
    log(`  section ${band.name}: ERROR ${e.message}`);
  }
  persist();
}

evidence.finishedAt = new Date().toISOString();
// Drift is a report, not a re-identification: a post-mint change on disk marks the
// run defective with BUNDLE_DRIFT_AFTER_BUILD semantics, and the recorded identity
// stays exactly as the build minted it. It never changes the exit status, which
// encodes process success rather than fidelity.
if (bundleIdentity) {
  evidence.bundle.drift = detectBundleDrift(bundleIdentity);
  if (evidence.bundle.drift.drifted) {
    log(`DRIFT: ${PROVENANCE_CODES.BUNDLE_DRIFT} — ${bundleIdentity.entryPath} no longer hashes to the minted identity (expected ${evidence.bundle.drift.expected}, observed ${evidence.bundle.drift.observed})`);
  } else {
    log(`bundle entry unchanged since the mint (${bundleIdentity.entryPath})`);
  }
}
const outFile = evidenceDocPath();
fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2));

let terminalStatus = 'INCONCLUSIVE';
let exitCode = 2;

if (SKIP_COMPARE) {
  terminalStatus = 'SKIPPED';
  exitCode = 0;
} else if (evidence.stages.compare?.status === 'COMPARE_ERROR') {
  terminalStatus = 'COMPARE_ERROR';
  exitCode = 1;
} else if (evidence.visual?.verdict === 'PASS') {
  terminalStatus = 'PASS';
  exitCode = 0;
} else if (evidence.visual?.verdict === 'FAIL') {
  terminalStatus = 'FAIL';
  exitCode = 1;
} else if (evidence.visual?.verdict === 'INCONCLUSIVE' || evidence.visual?.toolStatus === 'INCONCLUSIVE') {
  terminalStatus = 'INCONCLUSIVE';
  exitCode = 2;
}

if (SELF_DRIFT && evidence.selfDrift) {
  if (evidence.selfDrift.status === 'SELF_DRIFT_ERROR' || (typeof evidence.selfDrift.mismatchPercentage === 'number' && evidence.selfDrift.mismatchPercentage > 5)) {
    terminalStatus = 'INCONCLUSIVE_SELF_DRIFT';
    exitCode = 2;
  }
}

evidence.status = terminalStatus;
fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2));
log(`TERMINAL STATUS: ${evidence.status} (exit code ${exitCode})`);
process.exit(exitCode);
log(`wrote ${outFile}`);
