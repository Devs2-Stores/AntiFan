/**
 * Provenance spine: mint a bundle identity once, carry it, and refuse to judge
 * anything that does not match it.
 *
 * The identity is minted **at the build stage**, over the entry the build just
 * wrote into an immutable attempt directory, and is then copied verbatim into
 * every downstream document. Nothing downstream re-derives it:
 *
 *   mint  ->  carry  ->  verify at capture start  ->  drift check afterwards
 *
 * A mismatch between the entry actually served to the clone tab and the minted
 * identity is `BUNDLE_IDENTITY_MISMATCH`: the wrong directory was served, and no
 * verdict may be produced. A change on disk *after* the mint is
 * `BUNDLE_DRIFT_AFTER_BUILD`: reported, and the recorded identity is never
 * silently rewritten.
 *
 * Published views are manifest pointers into immutable attempt directories —
 * `<pageDir>/current-attempt.json` and `.canary/15-pages/current-report.json` —
 * written through the atomic record writer, because swapping a directory or a
 * symlink is not reliably atomic on Windows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readRecord, sha256Buffer, sha256File, writeRecordAtomic } from './atomic-record.mjs';

export const PAGE_POINTER_FILE = 'current-attempt.json';
export const RUN_POINTER_FILE = 'current-report.json';

export const PROVENANCE_CODES = {
  IDENTITY_MISMATCH: 'BUNDLE_IDENTITY_MISMATCH',
  BUNDLE_DRIFT: 'BUNDLE_DRIFT_AFTER_BUILD',
  IDENTITY_MISSING: 'BUNDLE_IDENTITY_MISSING',
};

/** Mint the page's identity over the attempt entry the build just produced. */
export function mintBundleIdentity({ entryPath, sourceUrl, attemptId, evidenceRoot }) {
  const resolved = path.resolve(entryPath);
  const bytes = fs.readFileSync(resolved);
  return {
    entryPath: resolved,
    entrySha256: sha256Buffer(bytes),
    entryBytes: bytes.length,
    generatedAt: new Date().toISOString(),
    sourceUrl: sourceUrl ?? null,
    attemptId,
    evidenceRoot: evidenceRoot ? path.resolve(evidenceRoot) : null,
  };
}

/**
 * The entry the tab is about to be judged on must be the entry that was minted.
 * `served` may be a Buffer, a file path, or null (nothing served at all).
 */
export function verifyServedEntry(identity, served) {
  if (!identity || !identity.entrySha256) {
    return { ok: false, code: PROVENANCE_CODES.IDENTITY_MISSING, reason: 'no minted identity was carried into this case' };
  }
  if (served === null || served === undefined) {
    return { ok: false, code: PROVENANCE_CODES.IDENTITY_MISMATCH, reason: 'no served entry was observed' };
  }
  let observedSha256;
  let observedBytes;
  let entryPath = null;
  if (Buffer.isBuffer(served)) {
    observedSha256 = sha256Buffer(served);
    observedBytes = served.length;
  } else {
    entryPath = path.resolve(String(served));
    if (!fs.existsSync(entryPath)) {
      return { ok: false, code: PROVENANCE_CODES.IDENTITY_MISMATCH, reason: `served entry is absent: ${entryPath}` };
    }
    observedSha256 = sha256File(entryPath);
    observedBytes = fs.statSync(entryPath).size;
  }
  if (observedSha256 !== identity.entrySha256) {
    return {
      ok: false,
      code: PROVENANCE_CODES.IDENTITY_MISMATCH,
      reason: entryPath
        ? `served entry ${entryPath} does not equal the minted identity`
        : 'served entry does not equal the minted identity',
      expected: identity.entrySha256,
      observed: observedSha256,
      observedBytes,
      entryPath,
    };
  }
  return { ok: true, sha256: observedSha256, bytes: observedBytes, entryPath };
}

/**
 * Select the candidate entry for a target viewport.
 *
 * Responsive verification requires the same candidate entry across all viewports.
 * Rejects an attempt to provide or substitute a different entry for mobile, while
 * accepting the unified candidate entry.
 */
export function selectCandidateEntryForViewport({ bundleIdentity, cloneDir, viewport, candidateEntry = null }) {
  const defaultEntry = bundleIdentity?.entryPath
    ? path.resolve(bundleIdentity.entryPath)
    : (cloneDir ? path.resolve(cloneDir, 'index.html') : null);
  if (!defaultEntry) {
    return {
      ok: false,
      code: PROVENANCE_CODES.IDENTITY_MISSING,
      reason: 'no candidate entry or bundle identity provided',
      entryPath: null,
    };
  }
  if (candidateEntry) {
    const resolvedCandidate = path.resolve(candidateEntry);
    if (resolvedCandidate !== defaultEntry) {
      const vpLabel = viewport?.label ?? (typeof viewport === 'string' ? viewport : (viewport?.width ? `${viewport.width}x${viewport.height}` : 'target'));
      return {
        ok: false,
        code: PROVENANCE_CODES.IDENTITY_MISMATCH,
        reason: `viewport ${vpLabel} candidate entry ${resolvedCandidate} differs from minted entry ${defaultEntry}; responsive verification requires the same candidate entry across all viewports`,
        expected: defaultEntry,
        received: resolvedCandidate,
        entryPath: defaultEntry,
      };
    }
  }
  return {
    ok: true,
    entryPath: defaultEntry,
    bundleIdentity: bundleIdentity ?? null,
    cloneDir: cloneDir ? path.resolve(cloneDir) : path.dirname(defaultEntry),
  };
}

/** A post-mint change on disk: reported as drift, never re-identified. */
export function detectBundleDrift(identity) {
  if (!identity?.entryPath || !identity?.entrySha256) {
    return { drifted: null, reason: 'no identity to check' };
  }
  if (!fs.existsSync(identity.entryPath)) {
    return { drifted: true, reason: 'entry disappeared after the mint', expected: identity.entrySha256, observed: null };
  }
  const observed = sha256File(identity.entryPath);
  return {
    drifted: observed !== identity.entrySha256,
    expected: identity.entrySha256,
    observed,
    entryPath: identity.entryPath,
  };
}

/** Publish a page's immutable attempt as the page's current view. */
export function writePagePointer(pageDir, { identity, cloneDir, mobileCloneDir, referencePath, viewports }) {
  return writeRecordAtomic(path.resolve(pageDir, PAGE_POINTER_FILE), {
    attemptId: identity.attemptId,
    entryPath: identity.entryPath,
    entrySha256: identity.entrySha256,
    entryBytes: identity.entryBytes,
    generatedAt: identity.generatedAt,
    sourceUrl: identity.sourceUrl,
    evidenceRoot: identity.evidenceRoot,
    cloneDir: path.resolve(cloneDir),
    mobileCloneDir: mobileCloneDir ? path.resolve(mobileCloneDir) : null,
    referencePath: referencePath ? path.resolve(referencePath) : null,
    viewports: viewports ?? null,
    publishedAt: new Date().toISOString(),
  });
}

export function readPagePointer(pageDir) {
  return readRecord(path.resolve(pageDir, PAGE_POINTER_FILE));
}

/** Publish a run's aggregate report as the campaign's current report. */
export function writeRunPointer(campaignDir, { runId, reportDir, reportPath, rootCopyPath, pages, cases, verdict }) {
  return writeRecordAtomic(path.resolve(campaignDir, RUN_POINTER_FILE), {
    runId,
    reportDir: path.resolve(reportDir),
    // The retained report: the artifact a reader of this pointer can trust, because
    // nothing overwrites it. The tracked root copy is recorded separately.
    reportPath: path.resolve(reportPath),
    rootCopyPath: rootCopyPath ? path.resolve(rootCopyPath) : null,
    pages: pages ?? null,
    cases: cases ?? null,
    verdict: verdict ?? null,
    publishedAt: new Date().toISOString(),
  });
}

export function readRunPointer(campaignDir) {
  return readRecord(path.resolve(campaignDir, RUN_POINTER_FILE));
}

/** Resolve a page's artifacts through its pointer, falling back to legacy paths. */
export function resolvePageArtifacts(pageDir) {
  const pointer = readPagePointer(pageDir);
  if (pointer) {
    return {
      attemptId: pointer.attemptId,
      evidenceDir: pointer.evidenceRoot,
      cloneDir: pointer.cloneDir,
      mobileCloneDir: pointer.mobileCloneDir ?? null,
      legacy: false,
      pointer,
    };
  }
  return {
    attemptId: null,
    evidenceDir: path.resolve(pageDir, 'evidence'),
    cloneDir: path.resolve(pageDir, 'clone'),
    mobileCloneDir: path.resolve(pageDir, 'clone', 'mobile'),
    legacy: true,
    pointer: null,
  };
}

/**
 * The session file is the instance's identity carrier; verdicts echo these
 * fields so a later reader can still prove which process produced them.
 */
export function loadInstanceIdentity(sessionPath = '.canary/state/canary-session.json') {
  const session = readRecord(path.resolve(sessionPath));
  if (!session) return null;
  return {
    pid: session.instancePid ?? null,
    startedAt: session.instanceStartedAt ?? null,
    processStartToken: session.instanceProcessStartToken ?? null,
    processStartTokenFormat: session.instanceProcessStartTokenFormat ?? null,
    bridgePort: session.bridgePort ?? session.port ?? null,
    attachmentId: session.attachmentId ?? null,
    primaryTabId: session.tabId ?? null,
    runId: session.runId ?? null,
    attemptId: session.attemptId ?? null,
    leaseUntil: session.leaseUntil ?? null,
  };
}

/** One canonical verdict and cause per case, whatever the sub-signals said. */
export function canonicalVerdict({ refusal, captureValid, visualVerdict, networkVerdict, structural }) {
  if (refusal) return { verdict: 'INCONCLUSIVE', causeCode: refusal.code, refusal };
  if (captureValid === false) return { verdict: 'INCONCLUSIVE', causeCode: 'CAPTURE_INVALID' };
  if (networkVerdict && networkVerdict !== 'PASS') return { verdict: 'FAIL', causeCode: networkVerdict };
  if (visualVerdict === 'PASS') {
    const geometryDelta = structural?.geometryDeltaPx ?? null;
    return { verdict: 'PASS', causeCode: geometryDelta === null ? 'MATCH' : 'MATCH_WITHIN_GEOMETRY_TOLERANCE' };
  }
  if (visualVerdict === 'FAIL') return { verdict: 'FAIL', causeCode: 'STRUCTURAL_PARITY_MISMATCH' };
  return { verdict: 'INCONCLUSIVE', causeCode: 'VISUAL_INCONCLUSIVE' };
}
