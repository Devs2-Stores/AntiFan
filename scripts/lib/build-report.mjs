#!/usr/bin/env node
/**
 * build-report.mjs — deterministic Phase 6 fidelity report generator.
 *
 *   node .canary/tools/build-report.mjs [runDir] [--out <file>] [--artifact-root <dir>] [--json]
 *
 * Reads ONLY persisted evidence:
 *   <pageDir>/current-attempt.json               published attempt pointer (when present)
 *   <attempt>/evidence/*.json                    viewport evidence, build telemetry, receipts
 *   <attempt>/clone/... (via telemetry refs)     referenced bundle assets (verified by hash)
 *   15-pages/current-report.json                 published run pointer (pages with an attempt)
 *   .canary/run1, .canary/run2                   immutable historical runs, Section 12 only
 *
 * A page directory without a pointer keeps its pre-pointer `evidence/` and `clone/`
 * layout, and is labelled `superseded` because its evidence names no bundle identity.
 *
 * Writes <runDir>/REPORT.md (or --out) with the sixteen required sections and exactly one
 * final verdict: PASS | FAIL | INCONCLUSIVE.
 *
 * Fail-closed contract (exit 1, nothing written):
 *   - run/evidence directory missing, no evidence JSON, no viewport evidence document;
 *   - ambiguous viewport evidence;
 *   - evidence JSON unreadable/invalid;
 *   - a referenced artifact is missing, size/hash-mismatched, marked truncated, or
 *     contradicts its own capture receipt (mode/geometry/scale/byte/sha disagreement).
 *
 * A gate outcome of PASS/FAIL/INCONCLUSIVE is a successful generation (exit 0).
 *
 * Lineage law: standalone full-page captures are independent continuity evidence only.
 * Authoritative pixel inputs come exclusively from the atomic compare pair. The generator
 * never merges, substitutes, or chooses between the two lineages.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PAGE_POINTER_FILE, readRunPointer, resolvePageArtifacts } from './evidence-provenance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CANARY_ROOT = path.resolve(REPO_ROOT, '.canary');

const GENERATOR = 'build-report.mjs (phase-06-report-and-fidelity-gate)';

/** Exact required section order — asserted before any write. */
const REQUIRED_SECTIONS = [
  'Environment',
  'Pipeline Tested',
  'Reference Capture',
  'Asset Discovery',
  'Asset Localization',
  'Independent HTML',
  'Live Chromium Results',
  'Structural Findings',
  'Visual Findings',
  'Mask Audit',
  'Remote Dependency Audit',
  'Run #1 vs Run #2',
  'Remaining Failures',
  'Final Fidelity Gate',
  'What Is Actually Proven',
  'Next Action',
];

/** The three exact canary viewports. A missing viewport forces INCONCLUSIVE. */
const REQUIRED_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 900 },
  { width: 390, height: 844 },
];

/** Gate policy constants (phase-06). Never relaxed to obtain a verdict. */
const PIXEL_MISMATCH_TARGET_PCT = 2;
const PAGE_HEIGHT_TARGET_PCT = 2;
const SECTION_HEIGHT_TARGET_PCT = 2;
const SECTION_HEIGHT_FLOOR_PX = 2;
const REFERENCE_DRIFT_LIMIT_PCT = 2;
const MASK_AREA_LIMIT_RATIO = 0.02;
const OVERFLOW_REGRESSION_TOLERANCE_PX = 1;
const COMPARE_NUMERIC_TOLERANCE_PCT = 0.05;

const FAILURE_CATEGORIES = new Set([
  'ASSET_MISMATCH',
  'ASSET_RENDER_MISMATCH',
  'LAYOUT_MISMATCH',
  'STRUCTURAL_HEIGHT_MISMATCH',
  'CARDINALITY_MISMATCH',
  'GRID_MISMATCH',
  'TYPOGRAPHY_MISMATCH',
  'RESPONSIVE_MISMATCH',
  'OVERFLOW_MISMATCH',
  'NAVIGATION_MISMATCH',
  'HERO_MISMATCH',
  'SETTLEMENT_FAILURE',
  'REMOTE_VISUAL_DEPENDENCY',
  'MASKING_TOO_BROAD',
  'TARGET_STALE',
  'OTHER',
]);

const REQUIRED_FINDING_KEYS = ['WHAT', 'WHERE', 'EXPECTED', 'ACTUAL', 'DELTA', 'LIKELY SCOPE', 'EVIDENCE'];

class GenerationError extends Error {}

/* ------------------------------------------------------------------ *
 * Small deterministic helpers
 * ------------------------------------------------------------------ */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const firstDef = (...vals) => vals.find((v) => v !== undefined && v !== null);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (isObj(v) ? v : {});

function num(v) {
  if (isNum(v)) return v;
  if (typeof v === 'boolean' || v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(n, digits = 2) {
  if (!isNum(n)) return 'n/a';
  return n.toFixed(digits);
}

function pct(n, digits = 2) {
  return isNum(n) ? `${fmt(n, digits)}%` : 'n/a';
}

function ratio(a, b) {
  if (!isNum(a) || !isNum(b) || b === 0) return null;
  return a / b;
}

function deltaPct(delta, reference) {
  if (!isNum(delta) || !isNum(reference) || reference === 0) return null;
  return (delta / reference) * 100;
}

function cell(v) {
  return String(v === undefined || v === null ? 'n/a' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdTable(headers, rows) {
  const out = [];
  out.push(`| ${headers.map(cell).join(' | ')} |`);
  out.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) out.push(`| ${row.map(cell).join(' | ')} |`);
  return out.join('\n');
}

function codeBlock(lines) {
  return ['```text', ...lines, '```'].join('\n');
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new GenerationError(`evidence file unreadable: ${path.relative(REPO_ROOT, file)} (${e.message})`);
  }
  if (!raw.trim()) throw new GenerationError(`evidence file is empty: ${path.relative(REPO_ROOT, file)}`);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new GenerationError(`evidence file is not valid JSON: ${path.relative(REPO_ROOT, file)} (${e.message})`);
  }
}

function relToRepo(file) {
  const rel = path.relative(REPO_ROOT, file);
  return (rel.startsWith('..') ? file : rel).split(path.sep).join('/');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { runDir: null, out: null, artifactRoot: null, json: false, now: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out' || a === '-o') {
      opts.out = argv[++i];
      if (!opts.out) throw new GenerationError('--out requires a file path');
    } else if (a === '--artifact-root') {
      opts.artifactRoot = argv[++i];
      if (!opts.artifactRoot) throw new GenerationError('--artifact-root requires a directory');
    } else if (a === '--now') {
      opts.now = argv[++i];
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a.startsWith('-')) {
      throw new GenerationError(`unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) throw new GenerationError(`unexpected extra arguments: ${positional.slice(1).join(' ')}`);
  opts.runDir = path.resolve(positional[0] || path.join(CANARY_ROOT, 'run3'));
  opts.out = opts.out ? path.resolve(opts.out) : path.join(opts.runDir, 'REPORT.md');
  return opts;
}

const USAGE = [
  'usage: node .canary/tools/build-report.mjs [runDir] [--out <file>] [--artifact-root <dir>] [--json]',
  '',
  '  runDir           run directory containing evidence/ (default .canary/run3)',
  '  --out            report path (default <runDir>/REPORT.md)',
  '  --artifact-root  AntiFan artifact store root used to resolve artifact ids',
  '  --json           also print a machine-readable summary to stdout',
].join('\n');

/* ------------------------------------------------------------------ *
 * Artifact references — collection, resolution, verification (fail closed)
 * ------------------------------------------------------------------ */

const SHA256_RE = /^[0-9a-f]{64}$/i;
const ARTIFACT_KEY_RE = /screenshot|artifact/i;

function isArtifactLike(v) {
  if (!isObj(v)) return false;
  // A capture receipt carries geometry + hashes but is not a fetchable artifact.
  if (looksLikeCaptureReceipt(v)) return false;
  const hasSha = isStr(v.sha256) && SHA256_RE.test(v.sha256);
  const hasPath = isStr(v.path) || isStr(v.file);
  const hasSize = isNum(v.byteLength) || isNum(v.bytes);
  const hasId = isStr(v.id) || isStr(v.artifactId);
  const hasLocator = hasPath || hasId;
  if (hasSha && hasLocator) return true;
  if (hasPath && hasSize) return true;
  if (hasId && (hasPath || hasSha || hasSize)) return true;
  return false;
}

function roleHint(jsonPath) {
  if (/clone|candidate|baseline|comparison/i.test(jsonPath)) return 'clone';
  if (/ref|reference|target|current/i.test(jsonPath)) return 'ref';
  return null;
}

class ArtifactIndex {
  constructor(ctx) {
    this.ctx = ctx;
    this.byObject = new WeakMap();
    this.byPath = new Map();
    this.indexCache = new Map();
    this.verified = [];
  }

  getIndex(idxPath) {
    if (this.indexCache.has(idxPath)) return this.indexCache.get(idxPath);
    if (!fs.existsSync(idxPath)) {
      this.indexCache.set(idxPath, null);
      return null;
    }
    let content;
    try {
      content = fs.readFileSync(idxPath, 'utf8');
    } catch (e) {
      throw new GenerationError(`artifact index unreadable at ${relToRepo(idxPath)}: ${e.message}`);
    }
    try {
      const parsed = JSON.parse(content);
      this.indexCache.set(idxPath, parsed);
      return parsed;
    } catch (e) {
      throw new GenerationError(`artifact index malformed JSON at ${relToRepo(idxPath)}: ${e.message}`);
    }
  }
  /** Walk a document, verify every referenced artifact, throw on any failure. */
  collect(docId, node, jsonPath = '') {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (ARTIFACT_KEY_RE.test(jsonPath)) this.record(docId, jsonPath, node, { stringRef: true });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => this.collect(docId, v, `${jsonPath}[${i}]`));
      return;
    }
    if (typeof node !== 'object') return;
    if (isArtifactLike(node)) {
      this.record(docId, jsonPath, node, { stringRef: false });
      return;
    }
    for (const key of Object.keys(node)) this.collect(docId, node[key], `${jsonPath}.${key}`);
  }

  record(docId, jsonPath, rawRef, { stringRef }) {
    const key = `${docId}${jsonPath}`;
    const result = this.resolve(docId, jsonPath, rawRef, stringRef);
    this.byPath.set(key, result);
    if (!stringRef && rawRef && typeof rawRef === 'object') this.byObject.set(rawRef, result);
    this.verified.push(result);
    return result;
  }

  resolve(docId, jsonPath, rawRef, stringRef) {
    const ref = stringRef ? { id: rawRef } : rawRef;
    const declaredSha = isStr(ref.sha256) && SHA256_RE.test(ref.sha256) ? ref.sha256.toLowerCase() : null;
    const declaredBytes = num(ref.byteLength) ?? num(ref.bytes);
    const declaredId = isStr(ref.id) ? ref.id : isStr(ref.artifactId) ? ref.artifactId : stringRef ? rawRef : null;

    const candidates = this.candidates(ref, declaredId, roleHint(jsonPath));
    const found = candidates.find((c) => fs.existsSync(c));
    if (!found) {
      throw new GenerationError(
        `referenced artifact missing: ${relToRepo(this.ctx.evidenceDir)}${jsonPath} ` +
          `(id=${declaredId || 'n/a'}) — tried: ${candidates.length ? candidates.map(relToRepo).join(', ') : 'no resolvable path'}`,
      );
    }
    let stat;
    try {
      stat = fs.statSync(found);
    } catch (e) {
      throw new GenerationError(`referenced artifact unreadable: ${relToRepo(found)} (${e.message})`);
    }
    if (!stat.isFile()) throw new GenerationError(`referenced artifact is not a file: ${relToRepo(found)}`);
    if (ref.truncated === true) {
      throw new GenerationError(`referenced artifact is marked truncated by its own receipt: ${relToRepo(found)} (${jsonPath})`);
    }
    if (isNum(declaredBytes) && stat.size !== declaredBytes) {
      throw new GenerationError(
        `referenced artifact size mismatch: ${relToRepo(found)} is ${stat.size} B, receipt declares ${declaredBytes} B (${jsonPath})`,
      );
    }
    let actualSha = null;
    if (declaredSha) {
      actualSha = sha256File(found);
      if (actualSha !== declaredSha) {
        throw new GenerationError(
          `referenced artifact sha256 mismatch: ${relToRepo(found)} is ${actualSha}, receipt declares ${declaredSha} (${jsonPath})`,
        );
      }
    }
    return {
      docId,
      jsonPath,
      id: declaredId,
      resolvedPath: found,
      resolvedRel: relToRepo(found),
      bytes: stat.size,
      declaredBytes,
      declaredSha,
      actualSha,
      shaVerified: Boolean(declaredSha),
      sizeVerified: isNum(declaredBytes),
      existenceOnly: !declaredSha,
    };
  }

  candidates(ref, declaredId, role) {
    const out = [];
    const push = (p) => {
      if (!p) return;
      const abs = path.resolve(p);
      if (!out.includes(abs)) out.push(abs);
    };
    if (isStr(ref.path)) {
      push(ref.path);
      if (!path.isAbsolute(ref.path)) {
        push(path.join(this.ctx.refRootDir, ref.path));
        push(path.join(REPO_ROOT, ref.path));
        push(path.join(this.ctx.evidenceDir, ref.path));
        push(path.join(this.ctx.cloneDir || this.ctx.refRootDir, ref.path));
      }
    }
    if (isStr(ref.file)) {
      push(path.join(this.ctx.assetsDir || '', ref.file));
      push(path.join(this.ctx.cloneDir || '', ref.file));
      push(path.join(this.ctx.evidenceDir, ref.file));
    }
    const label = this.ctx.label;
    if (label) {
      if (role === 'ref' || role === null) push(path.join(this.ctx.evidenceDir, `${label}-ref.png`));
      if (role === 'clone' || role === null) push(path.join(this.ctx.evidenceDir, `${label}-clone.png`));
      push(path.join(this.ctx.evidenceDir, `${label}.png`));
    }
    if (declaredId) {
      for (const root of this.ctx.artifactRoots) {
        push(path.join(root, declaredId));
        push(path.join(root, `${declaredId}.png`));
        if (this.ctx.runId) {
          push(path.join(root, this.ctx.runId, declaredId));
          push(path.join(root, this.ctx.runId, `${declaredId}.png`));
          if (ref.sha256) push(path.join(root, this.ctx.runId, `${ref.sha256}.artifact`));
          const idxPath = path.join(root, this.ctx.runId, 'index.json');
          const idx = this.getIndex(idxPath);
          if (idx && typeof idx === 'object') {
            for (const entry of Object.values(idx)) {
              if (entry && (entry.id === declaredId || (ref.sha256 && entry.sha256 === ref.sha256))) {
                if (ref.sha256 && entry.sha256 && ref.sha256 !== entry.sha256) {
                  throw new GenerationError(
                    `artifact index sha256 mismatch for ${declaredId}: evidence has ${ref.sha256} vs index has ${entry.sha256}`,
                  );
                }
                if (entry.path) push(entry.path);
              }
            }
          }
        }
        if (ref.sha256) push(path.join(root, `${ref.sha256}.artifact`));
      }
    }
    return out;
  }

  lookup(rawRef, docId, jsonPath) {
    if (rawRef && typeof rawRef === 'object') {
      const hit = this.byObject.get(rawRef);
      if (hit) return hit;
    }
    const byPath = this.byPath.get(`${docId}${jsonPath}`);
    if (byPath) return byPath;
    if (typeof rawRef === 'string') {
      return this.verified.find((v) => v.docId === docId && v.id === rawRef) || null;
    }
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Capture receipt self-consistency (fail closed)
 *
 * A receipt that contradicts its own geometry, or a pair of artifact/receipt
 * fields that disagree, must fail generation instead of producing a verdict.
 * Missing fields are not contradictions — they surface as INCONCLUSIVE.
 * ------------------------------------------------------------------ */

function looksLikeCaptureReceipt(o) {
  return (
    isObj(o) &&
    isObj(o.cssViewport) &&
    isObj(o.rasterSize) &&
    (isNum(num(o.dpr)) || isNum(num(o.zoom)) || isStr(o.captureMode) || isObj(o.cssCaptureSize))
  );
}

function verifyReceiptGeometry(receipt, jsonPath) {
  const cssViewport = obj(receipt.cssViewport);
  const cssCaptureSize = obj(receipt.cssCaptureSize);
  const rasterSize = obj(receipt.rasterSize);
  const dpr = num(receipt.dpr);
  const zoom = num(receipt.zoom);
  if (receipt.truncated === true) {
    throw new GenerationError(`capture receipt contradicts itself (truncated=true): ${jsonPath}`);
  }
  if (receipt.captureMode === 'full-page' && isNum(num(cssCaptureSize.height)) && isNum(num(cssViewport.height))) {
    if (num(cssCaptureSize.height) < num(cssViewport.height)) {
      throw new GenerationError(
        `capture receipt contradicts its captureMode: ${jsonPath} declares captureMode="full-page" but ` +
          `cssCaptureSize.height=${cssCaptureSize.height} < cssViewport.height=${cssViewport.height}`,
      );
    }
  }
  if (isObj(receipt.cssCaptureSize) && isNum(dpr) && isNum(zoom) && isNum(num(cssCaptureSize.width)) && isNum(num(cssCaptureSize.height))) {
    const expectedW = num(cssCaptureSize.width) * dpr * zoom;
    const expectedH = num(cssCaptureSize.height) * dpr * zoom;
    if (isNum(num(rasterSize.width)) && Math.abs(num(rasterSize.width) - expectedW) > 1) {
      throw new GenerationError(
        `capture receipt contradicts its geometry: ${jsonPath} rasterSize.width=${rasterSize.width} != ` +
          `cssCaptureSize.width×dpr×zoom=${expectedW}`,
      );
    }
    if (isNum(num(rasterSize.height)) && Math.abs(num(rasterSize.height) - expectedH) > 1) {
      throw new GenerationError(
        `capture receipt contradicts its geometry: ${jsonPath} rasterSize.height=${rasterSize.height} != ` +
          `cssCaptureSize.height×dpr×zoom=${expectedH}`,
      );
    }
  }
}

function verifyReceiptConsistency(docId, node, jsonPath = '') {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => verifyReceiptConsistency(docId, v, `${jsonPath}[${i}]`));
    return;
  }
  if (looksLikeCaptureReceipt(node)) verifyReceiptGeometry(node, `${docId}${jsonPath}`);

  // Artifact ref + receipt in the same record must agree on byte length / hash.
  const pairs = [
    [isArtifactLike(node) ? node : null, firstObj(node.receipt, node.captureReceipt)],
    [extractArtifact(node.artifact), firstObj(node.receipt, node.captureReceipt)],
    [extractArtifact(node.artifactRef), firstObj(node.receipt, node.captureReceipt)],
  ];
  for (const [ref, receipt] of pairs) {
    if (!ref || !receipt) continue;
    const refBytes = num(ref.byteLength) ?? num(ref.bytes);
    const recBytes = num(receipt.byteLength) ?? num(receipt.bytes);
    if (isNum(refBytes) && isNum(recBytes) && refBytes !== recBytes) {
      throw new GenerationError(
        `artifact contradicts its receipt: ${docId}${jsonPath} declares ${refBytes} B but receipt declares ${recBytes} B`,
      );
    }
    if (isStr(ref.sha256) && isStr(receipt.sha256) && ref.sha256.toLowerCase() !== receipt.sha256.toLowerCase()) {
      throw new GenerationError(
        `artifact contradicts its receipt: ${docId}${jsonPath} declares sha256 ${ref.sha256} but receipt declares ${receipt.sha256}`,
      );
    }
  }

  for (const key of Object.keys(node)) verifyReceiptConsistency(docId, node[key], `${jsonPath}.${key}`);
}

/* ------------------------------------------------------------------ *
 * Evidence loading and classification
 * ------------------------------------------------------------------ */

function classifyDocument(file, json) {
  const name = path.basename(file);
  if (/audit/i.test(name)) return 'audit';
  if (isObj(json.viewport) && isNum(num(json.viewport.width)) && isNum(num(json.viewport.height)) && isObj(json.stages)) {
    return 'viewport';
  }
  if (isObj(json.a0) || isObj(json.bundle) || Array.isArray(json.blueprints) || isObj(json.assetIntegrity)) {
    return 'telemetry';
  }
  if (isNum(num(json.mismatchPercentage)) && (isObj(json.captureReceipts) || isObj(json.receipt))) {
    return 'compare-receipt';
  }
  if (isObj(json.lease) || isObj(json.preflight) || isObj(json.artifactPreflight)) return 'lease';
  if (/verif|test|smoke/i.test(name)) return 'verification';
  return 'other';
}

function viewportKey(width, height) {
  return `${width}x${height}`;
}

function docViewportKey(json) {
  const w = num(json?.viewport?.width);
  const h = num(json?.viewport?.height);
  return isNum(w) && isNum(h) ? viewportKey(w, h) : null;
}

/**
 * The bundle directory a document's own reference belongs to.
 *
 * A page that publishes an attempt may only be judged against a bundle inside that
 * attempt (desktop or mobile). A document that still names the page's pre-pointer
 * `evidence/` or `clone/` subtree is evidence from before the pointer: it is refused
 * rather than quietly re-pointed at the published attempt, because re-pointing would
 * attribute a verdict to a bundle that document never measured. Directories outside
 * the page entirely (artifact-store roots, an absolute path a document legitimately
 * carries) stay as declared, exactly as before.
 */
function assertPublishedBundle(declaredDir, page, label) {
  if (!isStr(declaredDir) || page.legacy) return declaredDir;
  const resolved = path.resolve(declaredDir);
  const published = [page.cloneDir, page.mobileCloneDir].filter(isStr);
  if (published.some((dir) => isWithinPath(dir, resolved))) return resolved;
  const prePointer = [path.resolve(page.pageDir, 'evidence'), path.resolve(page.pageDir, 'clone')];
  if (prePointer.some((dir) => isWithinPath(dir, resolved))) {
    throw new GenerationError(
      `${label} names ${relToRepo(resolved)}, which belongs to the pre-pointer layout of ${relToRepo(page.pageDir)}; ` +
        `the page publishes attempt ${page.attemptId} at ${relToRepo(page.cloneDir)}, and that evidence describes a bundle this page no longer serves`,
    );
  }
  return resolved;
}

function loadEvidence(runDir, opts) {
  let stat = null;
  try {
    stat = fs.statSync(runDir);
  } catch {
    throw new GenerationError(`run directory not found: ${relToRepo(runDir)}`);
  }
  if (!stat.isDirectory()) throw new GenerationError(`run path is not a directory: ${relToRepo(runDir)}`);

  const page = resolvePageProvenance(runDir);
  const evidenceDir = page.evidenceDir;
  if (!fs.existsSync(evidenceDir) || !fs.statSync(evidenceDir).isDirectory()) {
    throw new GenerationError(`evidence directory missing: ${relToRepo(evidenceDir)} (nothing persisted to report)`);
  }
  const files = fs
    .readdirSync(evidenceDir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort()
    .map((f) => path.join(evidenceDir, f));
  if (files.length === 0) throw new GenerationError(`no evidence JSON files under ${relToRepo(evidenceDir)}`);

  const docs = [];
  for (const file of files) {
    const json = readJsonFile(file);
    const kind = classifyDocument(file, json);
    docs.push({
      file,
      rel: relToRepo(file),
      name: path.basename(file),
      bytes: fs.statSync(file).size,
      sha256: sha256File(file),
      kind,
      json,
      docId: relToRepo(file),
    });
  }

  const runBasename = path.basename(runDir);
  const byKey = new Map();
  for (const doc of docs.filter((d) => d.kind === 'viewport')) {
    const key = docViewportKey(doc.json);
    if (!key) continue;
    const list = byKey.get(key) || [];
    list.push(doc);
    byKey.set(key, list);
  }
  const viewportDocs = new Map();
  for (const [key, list] of byKey) {
    const [w] = key.split('x');
    const preferredLabel = `${runBasename}-${w}`;
    const exact = list.filter((d) => isStr(d.json.label) && d.json.label === preferredLabel);
    const chosen = exact.length === 1 ? exact[0] : list.length === 1 ? list[0] : null;
    if (!chosen) {
      throw new GenerationError(
        `ambiguous viewport evidence for ${key}: ${list.map((d) => d.rel).join(', ')} ` +
          `(no single document labelled "${preferredLabel}")`,
      );
    }
    viewportDocs.set(key, chosen);
  }
  if (viewportDocs.size === 0) {
    throw new GenerationError(
      `no viewport evidence documents under ${relToRepo(evidenceDir)} ` +
        '(a viewport document must contain viewport{width,height} and stages)',
    );
  }

  const telemetryCandidates = docs.filter(
    (d) => d.kind === 'telemetry' && (isStr(d.json.bundle?.entryHtmlPath) || isStr(d.json.generation?.result?.entryHtmlPath)),
  );
  // A run can carry more than one bundle (desktop and mobile). The report describes
  // the bundle the viewport evidence was measured against, so rank candidates by how
  // many viewports were served from their bundle directory, then break ties on the
  // canonical "build-telemetry.json" name and finally alphabetically. Membership in
  // the viewport bundle set is not enough: both bundles appear there, so the choice
  // would fall back to directory order.
  const viewportBundleUse = new Map();
  for (const d of docs.filter((d) => d.kind === 'viewport')) {
    const dir = docBundleDir(d.json);
    if (!isStr(dir)) continue;
    viewportBundleUse.set(dir, (viewportBundleUse.get(dir) || 0) + 1);
  }
  const canonicalFirst = (d) => (d.name === 'build-telemetry.json' ? 0 : 1);
  const telemetryDoc =
    [...telemetryCandidates].sort((a, b) => {
      const usedA = viewportBundleUse.get(docBundleDir(a.json)) || 0;
      const usedB = viewportBundleUse.get(docBundleDir(b.json)) || 0;
      if (usedA !== usedB) return usedB - usedA;
      if (canonicalFirst(a) !== canonicalFirst(b)) return canonicalFirst(a) - canonicalFirst(b);
      return a.name.localeCompare(b.name);
    })[0] ||
    docs.find((d) => d.kind === 'telemetry' && isObj(d.json.bundle)) ||
    docs.find((d) => d.kind === 'telemetry') ||
    null;
  return { runDir, runBasename, evidenceDir, page, files: docs, viewportDocs, telemetryDoc, opts };
}

/**
 * The bundle directory a document's own asset references belong to. A viewport
 * document names the bundle it was served from; a telemetry document names the
 * bundle it generated; anything else falls back to the run's primary bundle.
 */
function docBundleDir(json) {
  if (!isObj(json)) return null;
  if (isStr(json.cloneDir)) return json.cloneDir;
  if (isStr(json.bundle?.entryHtmlPath)) return path.dirname(json.bundle.entryHtmlPath);
  if (isStr(json.generation?.result?.entryHtmlPath)) return path.dirname(json.generation.result.entryHtmlPath);
  return null;
}

/* ------------------------------------------------------------------ *
 * Artifact root + run context
 * ------------------------------------------------------------------ */

/** True when `target` is `root` itself or sits beneath it. */
function isWithinPath(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A page's artifacts are resolved through its published view. `current-attempt.json`
 * names the immutable attempt directory holding both the bundle that was served and
 * the evidence the verdict was produced from. A directory with no pointer is
 * pre-pointer history: its fixed `evidence/` and `clone/` layout is still read, but it
 * is labelled `superseded` because it names no bundle identity and must never be
 * silently attributed to whichever run is current now.
 */
function resolvePageProvenance(pageDir) {
  const resolved = path.resolve(pageDir);
  const artifacts = resolvePageArtifacts(resolved);
  if (!artifacts.legacy && !(isStr(artifacts.evidenceDir) && isStr(artifacts.cloneDir))) {
    throw new GenerationError(
      `published attempt pointer for ${relToRepo(resolved)} is incomplete: ` +
        `${relToRepo(path.join(resolved, PAGE_POINTER_FILE))} must name both an evidence root and a bundle`,
    );
  }
  const evidenceDir = path.resolve(artifacts.evidenceDir);
  return {
    pageDir: resolved,
    attemptId: artifacts.attemptId,
    evidenceDir,
    cloneDir: path.resolve(artifacts.cloneDir),
    mobileCloneDir: isStr(artifacts.mobileCloneDir) ? path.resolve(artifacts.mobileCloneDir) : null,
    // Relative references inside a document resolve against the artifact root of the
    // page's published attempt, never against the page directory: once a pointer exists
    // the page's fixed evidence/ and clone/ subtrees are history.
    artifactRootDir: artifacts.legacy ? resolved : path.dirname(evidenceDir),
    legacy: artifacts.legacy,
    pointer: artifacts.pointer,
    provenance: artifacts.legacy ? 'superseded' : 'attempt',
    provenanceReason: artifacts.legacy ? 'evidence predates any attempt pointer' : null,
  };
}

/**
 * The campaign root is the `15-pages` directory the page itself lives under. It is
 * resolved from the page rather than from the repository root so a copied campaign —
 * the fixture a fail-closed probe runs against — reads its own published-run pointer
 * instead of the repository's.
 */
function campaignRootFor(pageDir) {
  for (let dir = path.resolve(pageDir); ; dir = path.dirname(dir)) {
    if (path.basename(dir) === '15-pages') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
  }
}

/**
 * The campaign's published report is named by `15-pages/current-report.json`. It is
 * consulted only for a page that publishes an attempt: pre-pointer evidence keeps the
 * run identity its own documents record, so a legacy page is never attributed to the
 * run that is current now. A run directory outside the campaign has no pointer to
 * prefer and keeps the evidence-derived identity.
 */
function resolvePublishedRun(page, evidenceRunId) {
  const campaignRoot = page.legacy ? null : campaignRootFor(page.pageDir);
  const pointer = campaignRoot ? readRunPointer(campaignRoot) : null;
  if (!pointer) {
    return { runId: evidenceRunId, reportDir: null, reportPath: null, publishedAt: null, published: false, source: 'evidence' };
  }
  return {
    runId: isStr(pointer.runId) ? pointer.runId : evidenceRunId,
    reportDir: isStr(pointer.reportDir) ? path.resolve(pointer.reportDir) : null,
    reportPath: isStr(pointer.reportPath) ? path.resolve(pointer.reportPath) : null,
    publishedAt: isStr(pointer.publishedAt) ? pointer.publishedAt : null,
    published: true,
    source: 'campaign-run-pointer',
  };
}

function artifactRoots(explicit) {
  const roots = [];
  const push = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!roots.includes(abs)) roots.push(abs);
  };
  push(explicit);
  push(process.env.ANTIFAN_ARTIFACT_ROOT);
  push(path.join(REPO_ROOT, '.antifan-data', 'control-plane-v2', 'artifacts'));
  push(path.join(REPO_ROOT, '..', '.antifan-data', 'control-plane-v2', 'artifacts'));
  push(path.join(REPO_ROOT, '..', '.antifan-canary', 'control-plane-v2', 'artifacts'));
  try {
    const instEnv = path.join(CANARY_ROOT, 'state', 'instance-env.json');
    if (fs.existsSync(instEnv)) {
      const data = JSON.parse(fs.readFileSync(instEnv, 'utf8'));
      if (data?.env?.ANTIFAN_DATA_ROOT) {
        push(path.join(data.env.ANTIFAN_DATA_ROOT, 'control-plane-v2', 'artifacts'));
      }
    }
  } catch {}
  return roots;
}

function telemetryDerivedPaths(telemetry, page) {
  const out = { cloneDir: null, assetsDir: null, runId: null };
  const bundle = obj(telemetry?.bundle);
  if (isStr(bundle.entryHtmlPath)) {
    out.cloneDir = assertPublishedBundle(path.dirname(bundle.entryHtmlPath), page, 'build telemetry bundle entry');
    out.assetsDir = out.cloneDir ? path.join(out.cloneDir, 'assets') : null;
  }
  if (isStr(telemetry?.generation?.result?.entryHtmlPath) && !out.cloneDir) {
    out.cloneDir = assertPublishedBundle(path.dirname(telemetry.generation.result.entryHtmlPath), page, 'generation result entry');
    out.assetsDir = out.cloneDir ? path.join(out.cloneDir, 'assets') : null;
  }
  if (!out.cloneDir && isStr(page.cloneDir) && fs.existsSync(page.cloneDir)) {
    // The page's published bundle: the immutable attempt directory named by its
    // pointer, or the fixed <pageDir>/clone for evidence that predates any pointer.
    out.cloneDir = page.cloneDir;
    out.assetsDir = path.join(page.cloneDir, 'assets');
  }
  const ref = firstDef(bundle.entryHtmlPath, telemetry?.input?.path);
  void ref;
  return out;
}

/* ------------------------------------------------------------------ *
 * Facts extraction (reuses persisted field names only)
 * ------------------------------------------------------------------ */

function settleFacts(stage) {
  const settle = obj(stage?.settle);
  const networkIdle = obj(stage?.networkIdle);
  const domStable = obj(stage?.domStable);
  return {
    present: Boolean(stage),
    networkIdle: isObj(stage?.networkIdle) ? networkIdle.satisfied === true : null,
    networkIdleDetail: networkIdle,
    domStable: isObj(stage?.domStable) ? domStable.satisfied === true : null,
    fontsSettled: settle.fontsSettled === true,
    imagesSettled: settle.imagesSettled === true,
    domSettled: settle.domSettled === true,
    visualStable: settle.visualStable === true,
    timedOut: settle.timedOut === true,
    settlementDuration: num(settle.settlementDuration),
    imageCount: num(settle.imageCount),
    pendingImages: num(settle.pendingImages),
    brokenImages: arr(settle.brokenImages),
    readyState: isStr(settle.readyState) ? settle.readyState : null,
    fontsStatus: isStr(settle.fontsStatus) ? settle.fontsStatus : null,
    complete:
      isObj(stage?.settle) &&
      settle.fontsSettled === true &&
      settle.imagesSettled === true &&
      settle.domSettled === true &&
      settle.visualStable === true &&
      settle.timedOut !== true &&
      (num(settle.pendingImages) ?? 1) === 0 &&
      (isObj(stage?.networkIdle) ? networkIdle.satisfied === true : true) &&
      (isObj(stage?.domStable) ? domStable.satisfied === true : true),
  };
}

function metricsFacts(stage) {
  const m = obj(stage?.metrics);
  const grids = arr(m.productListGrids).filter((g) => isNum(num(g?.columns)));
  const firstGrid = grids[0] || null;
  return {
    present: Boolean(stage?.metrics),
    url: isStr(m.url) ? m.url : null,
    docHeight: num(m.docHeight),
    clientWidth: num(m.clientWidth),
    scrollWidth: num(m.scrollWidth),
    overflowX: num(m.overflowX),
    sectionCount: num(m.sectionCount),
    productCardCount: num(m.productCardCount),
    articleCardCount: num(m.articleCardCount),
    navItemCount: num(m.navItemCount),
    linkCount: num(m.linkCount),
    imageCount: num(m.imageCount),
    brokenImages: arr(m.brokenImages),
    sections: arr(m.sections),
    headerRect: isObj(m.headerRect) ? m.headerRect : null,
    heroRect: isObj(m.heroRect) ? m.heroRect : null,
    navRect: isObj(m.navRect) ? m.navRect : null,
    mainRect: isObj(m.mainRect) ? m.mainRect : null,
    footerRect: isObj(m.footerRect) ? m.footerRect : null,
    fonts: obj(m.fonts),
    grids,
    firstGrid,
    cardRects: arr(m.cardRects),
    textNodes: num(m.textNodes),
  };
}

function firstObj(...vals) {
  for (const v of vals) if (isObj(v)) return v;
  return null;
}

function compareFacts(doc) {
  const rawCmp = firstObj(doc.stages?.compare, doc.compare);
  const visual = isObj(doc.visual) && (isStr(doc.visual.verdict) || isStr(doc.visual.toolStatus) || isStr(doc.visual.status) || isObj(doc.visual.captureReceipts))
    ? doc.visual
    : null;
  const cmp = visual ? { ...rawCmp, ...visual } : rawCmp;
  const status = isStr(cmp?.toolStatus)
    ? cmp.toolStatus
    : isStr(cmp?.status)
    ? cmp.status
    : isStr(cmp?._type)
    ? cmp._type
    : isStr(cmp?.verdict)
    ? cmp.verdict
    : null;
  const code = isStr(cmp?.code) ? cmp.code : null;
  const nonterminal =
    cmp?._type === 'PENDING_CLEANUP' ||
    cmp?.code === 'EXECUTION_TIMEOUT_PENDING_CLEANUP' ||
    cmp?.cleanupPending === true ||
    cmp?.nonterminal === true ||
    cmp?.terminal === false ||
    isObj(cmp?.pendingCleanup) ||
    /EXECUTION_TIMEOUT_PENDING_CLEANUP|PENDING_CLEANUP/.test(String(cmp?.error || cmp?.message || ''));
  const isInconclusive =
    status?.toUpperCase() === 'INCONCLUSIVE' ||
    cmp?.verdict?.toUpperCase() === 'INCONCLUSIVE' ||
    cmp?.dimensionsMatch === false ||
    cmp?.captureStateCompatible === false;
  const real =
    isObj(cmp) &&
    !nonterminal &&
    !isInconclusive &&
    (isNum(num(cmp.mismatchPercentage)) || typeof cmp.match === 'boolean') &&
    ['OK', 'SUCCESS', 'COMPLETE', 'DONE', 'PASS', 'FAIL'].includes(status?.toUpperCase() ?? '');
  return {
    present: isObj(cmp),
    raw: cmp,
    status,
    code,
    error: isStr(cmp?.error) ? cmp.error : null,
    nonterminal,
    real,
    mismatchPercentage: num(cmp?.mismatchPercentage),
    match: typeof cmp?.match === 'boolean' ? cmp.match : null,
    dimensionsMatch: typeof cmp?.dimensionsMatch === 'boolean' ? cmp.dimensionsMatch : null,
    diffPixels: num(cmp?.diffPixels),
    totalPixels: num(cmp?.totalPixels),
    tolerance: num(cmp?.tolerance),
    verdict: isStr(cmp?.verdict) ? cmp.verdict : null,
    reason: isStr(cmp?.reason) ? cmp.reason : null,
    layout: firstObj(cmp?.dimensions?.layout, cmp?.layout),
    captureReceipts: firstObj(cmp?.captureReceipts),
    coherence: firstObj(cmp?.coherence),
    normalization: firstObj(cmp?.normalization),
    settle: firstObj(cmp?.settle),
    structural: firstObj(cmp?.structural),
    receipt: firstObj(cmp?.receipt),
    metricSamples: arr(cmp?.metricSamples),
    currentScreenshot: cmp?.currentScreenshot,
    baselineScreenshot: cmp?.baselineScreenshot,
    sections: arr(doc.stages?.sections),
  };
}

function pairFacts(doc, cmp) {
  const block = firstObj(
    doc.authoritativePair,
    doc.atomicPair,
    doc.stages?.authoritativePair,
    doc.stages?.atomicPair,
    doc.pair,
    cmp?.pair,
    doc.compare?.pair,
  );
  if (block) {
    const refEntry = firstObj(block.reference, block.target, block.ref) || block.reference || block.target;
    const cloneEntry = firstObj(block.candidate, block.baseline, block.clone) || block.candidate || block.baseline;
    return {
      present: true,
      source: 'authoritativePair-block',
      block,
      refEntry: isObj(refEntry) ? refEntry : null,
      cloneEntry: isObj(cloneEntry) ? cloneEntry : null,
      refArtifact: extractArtifact(refEntry),
      cloneArtifact: extractArtifact(cloneEntry),
      refReceipt: extractReceipt(refEntry, block, 'reference') || firstObj(cmp?.captureReceipts?.target, cmp?.captureReceipts?.reference),
      cloneReceipt: extractReceipt(cloneEntry, block, 'candidate') || firstObj(cmp?.captureReceipts?.baseline, cmp?.captureReceipts?.clone, cmp?.captureReceipts?.candidate),
      identity: firstObj(block.identity, block.coherence, refEntry?.identity, cloneEntry?.identity, cmp?.coherence),
      captureStateCompatible:
        typeof block.captureStateCompatible === 'boolean'
          ? block.captureStateCompatible
          : typeof cmp?.coherence?.captureStateCompatible === 'boolean'
          ? cmp.coherence.captureStateCompatible
          : null,
    };
  }
  if (cmp.real && (cmp.currentScreenshot || cmp.baselineScreenshot)) {
    return {
      present: true,
      source: 'compare-result',
      block: cmp.raw,
      refEntry: null,
      cloneEntry: null,
      refArtifact: cmp.currentScreenshot,
      cloneArtifact: cmp.baselineScreenshot,
      refReceipt: firstObj(cmp.captureReceipts?.target, cmp.captureReceipts?.reference),
      cloneReceipt: firstObj(cmp.captureReceipts?.baseline, cmp.captureReceipts?.comparison, cmp.captureReceipts?.clone),
      identity: cmp.coherence,
      captureStateCompatible: typeof cmp.raw?.captureStateCompatible === 'boolean' ? cmp.raw.captureStateCompatible : null,
    };
  }
  return {
    present: false,
    source: null,
    block: null,
    refEntry: null,
    cloneEntry: null,
    refArtifact: null,
    cloneArtifact: null,
    refReceipt: null,
    cloneReceipt: null,
    identity: null,
    captureStateCompatible: null,
  };
}
function extractArtifact(entry) {
  if (!entry) return null;
  if (isObj(entry)) return firstDef(entry.artifact, entry.artifactRef, entry.ref, entry.screenshot, entry);
  return entry;
}

function isReceiptObj(obj) {
  return (
    isObj(obj) &&
    (isStr(obj.captureMode) ||
      isObj(obj.cssViewport) ||
      isObj(obj.rasterSize) ||
      isObj(obj.cssCaptureSize) ||
      isStr(obj.backend) ||
      isNum(obj.dpr) ||
      isNum(obj.timestamp))
  );
}

function extractReceipt(entry, block, role) {
  const fromEntry = isObj(entry)
    ? firstObj(entry.receipt, entry.captureReceipt, entry.captureReceipts)
    : null;
  if (isReceiptObj(fromEntry)) return fromEntry;
  if (isReceiptObj(entry)) return entry;
  const fromBlock = firstObj(
    block?.receipts?.[role],
    block?.captureReceipts?.[role],
    role === 'reference' ? firstObj(block?.receipts?.target, block?.captureReceipts?.target) : null,
    role === 'candidate' ? firstObj(block?.receipts?.baseline, block?.captureReceipts?.baseline, block?.receipts?.clone, block?.captureReceipts?.clone) : null,
  );
  if (isReceiptObj(fromBlock)) return fromBlock;
  return null;
}

function standaloneFacts(doc) {
  const block = firstObj(
    doc.standalone,
    doc.stages?.standalone,
    doc.standaloneCaptures,
    doc.standaloneCapture,
    doc.captures,
    doc.stages?.standaloneCaptures,
    doc.stages?.standaloneCapture,
    doc.stages?.captures,
  );
  if (!block) return { present: false, block: null, refArtifact: null, cloneArtifact: null, refReceipt: null, cloneReceipt: null };
  const refEntry = firstObj(block.reference, block.target, block.ref) || block.reference;
  const cloneEntry = firstObj(block.candidate, block.baseline, block.clone) || block.candidate || block.clone;
  return {
    present: true,
    block,
    refArtifact: extractArtifact(refEntry) || refEntry,
    cloneArtifact: extractArtifact(cloneEntry) || cloneEntry,
    refReceipt: extractReceipt(refEntry, block, 'reference') || refEntry?.receipt,
    cloneReceipt: extractReceipt(cloneEntry, block, 'candidate') || extractReceipt(cloneEntry, block, 'clone') || cloneEntry?.receipt,
  };
}

function maskFacts(doc, cmp, pair) {
  const strict = firstObj(doc.evidenceModel?.strictParams, doc.strictParams);
  const ledger = firstObj(
    doc.maskLedger,
    doc.maskResolution,
    doc.visual?.mask,
    cmp?.maskResolution,
    cmp?.mask,
    cmp?.receipt?.maskResolution,
    pair?.block?.maskResolution,
    pair?.block?.mask,
  );
  const requested = arr(
    firstDef(
      strict?.userMasks,
      doc.compareParams?.maskSelectors,
      doc.maskSelectors,
      cmp?.requestedMasks,
      ledger?.requested,
      ledger?.requestedSelectors,
    ),
  );
  const unresolved = arr(firstDef(ledger?.unresolved, ledger?.unresolvedSelectors, ledger?.requiredUnresolved));
  const ratio = num(
    firstDef(
      ledger?.maskedAreaRatio,
      cmp?.receipt?.maskedAreaRatio,
      doc.visual?.maskedAreaRatio,
      cmp?.maskedAreaRatio,
    ),
  );
  const useDefaultWidgetMasks = firstDef(
    strict?.useDefaultWidgetMasks,
    doc.compareParams?.useDefaultWidgetMasks,
    doc.useDefaultWidgetMasks,
    pair?.block?.params?.useDefaultWidgetMasks,
    cmp?.params?.useDefaultWidgetMasks,
    cmp?.useDefaultWidgetMasks,
    doc.visual?.useDefaultWidgetMasks,
  );
  return {
    present: isObj(ledger),
    ledger,
    status: isStr(ledger?.status) ? ledger.status : null,
    requested,
    unresolved,
    ratio,
    useDefaultWidgetMasks: typeof useDefaultWidgetMasks === 'boolean' ? useDefaultWidgetMasks : null,
  };
}

function driftDocFor(evidenceFiles, width) {
  const candidates = evidenceFiles.filter((d) => {
    if (d.kind !== 'compare-receipt') return false;
    const name = `${d.name} ${isStr(d.json.label) ? d.json.label : ''}`;
    return /drift|ref-vs-ref|self/i.test(name);
  });
  if (candidates.length === 0) return null;
  const withWidth = candidates.filter((d) => {
    const name = `${d.name} ${isStr(d.json.label) ? d.json.label : ''}`;
    if (new RegExp(`(^|[^0-9])${width}([^0-9]|$)`).test(name)) return true;
    const cw = num(d.json?.captureReceipts?.target?.cssViewport?.width);
    return cw === width;
  });
  if (withWidth.length === 1) return withWidth[0];
  if (candidates.length === 1) return candidates[0];
  return withWidth[0] || null;
}

function driftFacts(input) {
  if (!input) return { present: false };
  const j = input.json || input;
  if (!isObj(j) || (j.status === undefined && j.mismatchPercentage === undefined && j.driftMismatch === undefined)) {
    return { present: false };
  }
  return {
    present: true,
    doc: input.json ? input : null,
    mismatchPercentage: num(j.mismatchPercentage) ?? num(j.driftMismatch),
    dimensionsMatch: typeof j.dimensionsMatch === 'boolean' ? j.dimensionsMatch : null,
    maskStatus: isStr(j.maskResolution?.status) ? j.maskResolution.status : isStr(j.receipt?.maskResolutionStatus) ? j.receipt.maskResolutionStatus : null,
    maskedAreaRatio: num(j.maskResolution?.maskedAreaRatio) ?? num(j.receipt?.maskedAreaRatio) ?? num(j.maskedAreaRatio) ?? 0,
    captureStateCompatible: typeof j.captureStateCompatible === 'boolean' ? j.captureStateCompatible : null,
    identityCoherent: typeof j.coherence?.identityCoherent === 'boolean' ? j.coherence.identityCoherent : null,
    settleComplete: typeof j.receipt?.settleComplete === 'boolean' ? j.receipt.settleComplete : null,
    notes: isStr(j.notes) ? j.notes : isStr(j.note) ? j.note : null,
  };
}

function runtimeAuditFacts(doc, telemetry, files = []) {
  const auditDoc = Array.isArray(files) ? files.find((f) => f.kind === 'audit' || /audit/i.test(f.name)) : null;
  const audit = firstObj(
    doc.runtimeAudit,
    doc.assetAudit,
    doc.dependencyAudit,
    doc.runtime,
    doc.stages?.runtimeAudit,
    doc.stages?.assetAudit,
    doc.stages?.dependencyAudit,
    doc.stages?.clone?.runtimeAudit,
    doc.stages?.reference?.runtimeAudit,
    auditDoc?.json?.runtime,
    auditDoc?.json?.assetAudit,
    auditDoc?.json,
  );
  const referenceOrigin = num(
    firstDef(
      audit?.referenceOriginRequests,
      audit?.referenceOriginVisualRequests,
      audit?.referenceOriginVisualRequestCount,
      audit?.referenceOriginVisualCount,
      audit?.forbiddenReferenceOriginRequests,
    ),
  );
  const remote = num(firstDef(audit?.remoteResourceRequests, audit?.remoteRequests, audit?.remote));
  const bundleRemote = num(telemetry?.bundle?.remoteSubresources?.length);
  const resourceEntries = num(firstDef(audit?.resourceEntries, audit?.entries, audit?.resourceCount));
  const imagesLoaded = num(firstDef(audit?.imagesLoaded, audit?.images?.loaded, audit?.images?.total));
  const brokenImages = num(firstDef(audit?.brokenImages, Array.isArray(audit?.images?.broken) ? audit.images.broken.length : null));
  const pendingImages = num(firstDef(audit?.pendingImages, audit?.images?.pending));
  return {
    present: isObj(audit),
    audit,
    referenceOrigin,
    remote,
    bundleRemote,
    resourceEntries,
    imagesLoaded,
    brokenImages,
    pendingImages,
  };
}

function buildViewportModel(doc, spec, ctx) {
  const stageRef = obj(doc.json.stages?.reference);
  const stageClone = obj(doc.json.stages?.clone);
  const refSettle = settleFacts(stageRef);
  const cloneSettle = settleFacts(stageClone);
  const refMetrics = metricsFacts(stageRef);
  const cloneMetrics = metricsFacts(stageClone);
  const cmp = compareFacts(doc.json);
  const pair = pairFacts(doc.json, cmp);
  const standalone = standaloneFacts(doc.json);
  const mask = maskFacts(doc.json, cmp, pair);
  const structural = firstObj(doc.json.structural, cmp.structural);
  const selfDriftFact = driftFacts(doc.json.selfDrift);
  const drift = selfDriftFact.present ? selfDriftFact : driftFacts(driftDocFor(ctx.files, spec.width));
  const runtime = runtimeAuditFacts(doc.json, ctx.telemetry, ctx.files);

  const docHeight = isObj(structural?.docHeight)
    ? {
        reference: num(structural.docHeight.reference),
        clone: num(structural.docHeight.clone),
        delta: num(structural.docHeight.delta),
        ratio: num(structural.docHeight.ratio),
        source: 'structural.docHeight',
      }
    : {
        reference: refMetrics.docHeight,
        clone: cloneMetrics.docHeight,
        delta: isNum(refMetrics.docHeight) && isNum(cloneMetrics.docHeight) ? cloneMetrics.docHeight - refMetrics.docHeight : null,
        ratio: ratio(cloneMetrics.docHeight, refMetrics.docHeight),
        source: 'stages.*.metrics.docHeight',
      };

  return {
    doc,
    spec,
    label: isStr(doc.json.label) ? doc.json.label : `${ctx.runBasename}-${spec.width}`,
    width: spec.width,
    height: spec.height,
    readiness: obj(doc.json.readiness),
    refSettle,
    cloneSettle,
    refMetrics,
    cloneMetrics,
    cmp,
    pair,
    standalone,
    mask,
    structural,
    structuralSections: arr(structural?.sections),
    drift,
    runtime,
    telemetry: ctx.telemetry,
    docHeight,
    visual: obj(doc.json.visual),
  };
}

/* ------------------------------------------------------------------ *
 * Gate evaluation
 * ------------------------------------------------------------------ */

function makeFinding(category, parts) {
  if (!FAILURE_CATEGORIES.has(category)) {
    throw new GenerationError(`internal error: unknown failure category ${category}`);
  }
  const normalized = { ...parts };
  normalized.EVIDENCE = Array.isArray(parts.EVIDENCE) ? parts.EVIDENCE : [parts.EVIDENCE];
  const missing = REQUIRED_FINDING_KEYS.filter((k) => !normalized[k] || normalized[k].length === 0);
  if (missing.length) throw new GenerationError(`internal error: finding missing keys ${missing.join(', ')}`);
  return { category, ...normalized };
}

/**
 * Blockers that only prevent PASS (missing corroborating evidence) versus blockers
 * that make the viewport undecidable (settlement/pair/identity/mask-lineage). A
 * deterministic failure is only adjudicated when no hard blocker exists, because
 * FAIL requires complete deterministic evidence.
 */
const SOFT_BLOCKERS = new Set([
  'STANDALONE_CAPTURE_MISSING',
  'RUNTIME_AUDIT_MISSING',
  'REFERENCE_DRIFT_MISSING',
  'MASK_RATIO_UNRECORDED',
  'IMPLICIT_MASK_STATE_UNRECORDED',
]);

function blocker(code, category, parts, opts = {}) {
  return { status: 'unavailable', code, hard: opts.hard ?? !SOFT_BLOCKERS.has(code), finding: makeFinding(category, parts) };
}

function pass(detail) {
  return { status: 'pass', detail };
}

function fail(code, category, parts) {
  return { status: 'fail', code, finding: makeFinding(category, parts) };
}

function na(detail) {
  return { status: 'not-applicable', detail };
}

function checkSettlement(model, side) {
  const settle = side === 'reference' ? model.refSettle : model.cloneSettle;
  const role = side === 'reference' ? 'Reference' : 'Clone';
  const missing = [];
  if (settle.networkIdle !== true) missing.push(`network_idle=${settle.networkIdle === null ? 'not-recorded' : settle.networkIdle}`);
  if (settle.domStable !== true) missing.push(`dom_stable=${settle.domStable === null ? 'not-recorded' : settle.domStable}`);
  if (settle.fontsSettled !== true) missing.push('fontsSettled=false');
  if (settle.imagesSettled !== true) missing.push(`imagesSettled=false(pending=${settle.pendingImages ?? '?'})`);
  if (settle.domSettled !== true) missing.push('domSettled=false');
  if (settle.visualStable !== true) missing.push('visualStable=false');
  if (settle.timedOut === true) missing.push('settlement timedOut=true');
  if (isNum(settle.pendingImages) && settle.pendingImages > 0) missing.push(`pendingImages=${settle.pendingImages}`);
  if (isStr(settle.readyState) && settle.readyState !== 'complete') missing.push(`readyState=${settle.readyState}`);
  if (missing.length === 0) return pass(`${role} settlement complete (${settle.settlementDuration ?? '?'} ms)`);
  return blocker(`${side.toUpperCase()}_NOT_SETTLED`, 'SETTLEMENT_FAILURE', {
    WHAT: `${role} side did not reach a complete settled state at ${model.width}×${model.height}.`,
    WHERE: `stages.${side}.settle / stages.${side}.networkIdle / stages.${side}.domStable`,
    EXPECTED: 'network_idle + dom_stable satisfied, fonts/images/DOM/visual stability true, 0 pending images',
    ACTUAL: missing.join('; '),
    DELTA: 'settlement receipt incomplete',
    'LIKELY SCOPE': 'capture/settlement path for the bound target',
    EVIDENCE: `${model.doc.rel} stages.${side}`,
  });
}

function evaluateGate(model) {
  const checks = [];
  const W = `${model.width}×${model.height}`;
  const docRel = model.doc.rel;

  /* --- 1. Evidence availability and typed status (evaluated first) --- */

  checks.push(checkSettlement(model, 'reference'));
  checks.push(checkSettlement(model, 'clone'));

  if (isObj(model.readiness.reference) && model.readiness.reference.ok !== true) {
    checks.push(
      blocker('REFERENCE_NOT_READY', 'SETTLEMENT_FAILURE', {
        WHAT: `Reference readiness gate failed at ${W}.`,
        WHERE: 'readiness.reference',
        EXPECTED: 'readiness.reference.ok === true',
        ACTUAL: `ok=${model.readiness.reference.ok}; reasons=${arr(model.readiness.reference.reasons).join('; ') || 'none'}`,
        DELTA: 'reference structure not re-validated before measurement',
        'LIKELY SCOPE': 'reference capture state',
        EVIDENCE: `${docRel} readiness.reference`,
      }),
    );
  }
  if (isObj(model.readiness.clone) && model.readiness.clone.ok !== true) {
    checks.push(
      blocker('CLONE_NOT_READY', 'SETTLEMENT_FAILURE', {
        WHAT: `Clone readiness gate failed at ${W}.`,
        WHERE: 'readiness.clone',
        EXPECTED: 'readiness.clone.ok === true',
        ACTUAL: `ok=${model.readiness.clone.ok}; reasons=${arr(model.readiness.clone.reasons).join('; ') || 'none'}`,
        DELTA: 'clone structure not re-validated before measurement',
        'LIKELY SCOPE': 'clone capture state',
        EVIDENCE: `${docRel} readiness.clone`,
      }),
    );
  }

  const cmp = model.cmp;
  if (!cmp.present) {
    checks.push(
      blocker('COMPARE_NOT_RUN', 'SETTLEMENT_FAILURE', {
        WHAT: `No visual compare transaction is persisted for ${W}.`,
        WHERE: 'stages.compare',
        EXPECTED: 'a bounded compare transaction with an authoritative atomic pair',
        ACTUAL: 'stages.compare absent from evidence',
        DELTA: 'no pixel evidence',
        'LIKELY SCOPE': 'compare transport / capture path',
        EVIDENCE: `${docRel} stages`,
      }),
    );
  } else if (cmp.nonterminal) {
    checks.push(
      blocker('COMPARE_PENDING_CLEANUP', 'SETTLEMENT_FAILURE', {
        WHAT: `Compare at ${W} returned a nonterminal pending-cleanup state.`,
        WHERE: 'stages.compare',
        EXPECTED: 'terminal receipt only after owned resources are released or fenced',
        ACTUAL: `code=${cmp.code || cmp.status}; cleanupPending=true`,
        DELTA: 'operation outcome unknown; no terminal receipt',
        'LIKELY SCOPE': 'execution control / transport cleanup',
        EVIDENCE: `${docRel} stages.compare`,
      }),
    );
  } else if (!cmp.real) {
    checks.push(
      blocker('COMPARE_STATUS_NOT_RESULT', 'SETTLEMENT_FAILURE', {
        WHAT: `Compare at ${W} did not produce a comparison result.`,
        WHERE: 'stages.compare',
        EXPECTED: 'a deterministic compare result over an authoritative atomic pair',
        ACTUAL: `status=${cmp.status || 'absent'}${cmp.error ? `; error=${cmp.error}` : ''}`,
        DELTA: 'no pixel evidence',
        'LIKELY SCOPE': 'compare transport / capture path',
        EVIDENCE: `${docRel} stages.compare`,
      }),
    );
  }

  if (!model.pair.present) {
    checks.push(
      blocker('MISSING_AUTHORITATIVE_PAIR', 'SETTLEMENT_FAILURE', {
        WHAT: `No authoritative atomic compare pair exists for ${W}.`,
        WHERE: 'authoritativePair / stages.compare capture pair',
        EXPECTED: 'one atomic pair captured under a pair lock with post-checked identities',
        ACTUAL: 'no atomic pair artifacts recorded; standalone captures, if any, are not authoritative pixel inputs',
        DELTA: 'pixel verdict unavailable',
        'LIKELY SCOPE': 'bounded compare transaction (pair capture/staging)',
        EVIDENCE: `${docRel} stages.compare${model.standalone.present ? ' + standaloneCaptures (independent only)' : ''}`,
      }),
    );
  } else {
    const lineage = evaluatePairLineage(model);
    checks.push(...lineage);
  }

  if (model.pair.present) {
    const identity = model.pair.identity;
    const identityCoherent =
      typeof identity?.identityCoherent === 'boolean'
        ? identity.identityCoherent
        : typeof identity?.identity?.coherent === 'boolean'
          ? identity.identity.coherent
          : null;
    if (identityCoherent === false) {
      checks.push(
        blocker('TARGET_STALE', 'TARGET_STALE', {
          WHAT: `Target identity became incoherent during the ${W} compare.`,
          WHERE: 'compare coherence receipts',
          EXPECTED: 'identical browserEpoch/documentGeneration/mutationRevision across inject → capture',
          ACTUAL: `identityCoherent=false${isStr(identity?.identity?.reason) ? ` (${identity.identity.reason})` : ''}`,
          DELTA: 'captured pair not attributable to a stable target',
          'LIKELY SCOPE': 'target lifecycle / navigation during capture',
          EVIDENCE: `${docRel} stages.compare.coherence`,
        }),
      );
    } else if (identityCoherent === null) {
      checks.push(
        blocker('TARGET_IDENTITY_UNRECORDED', 'TARGET_STALE', {
          WHAT: `Target identity receipts are missing for the ${W} compare.`,
          WHERE: 'compare coherence receipts',
          EXPECTED: 'pre-inject / post-inject / after-capture identity receipts for both sides',
          ACTUAL: 'no coherence block persisted with the pair',
          DELTA: 'target stability unproven',
          'LIKELY SCOPE': 'compare transaction receipts',
          EVIDENCE: `${docRel} stages.compare`,
        }),
      );
    }
    if (model.pair.captureStateCompatible === false || cmp.raw?.captureStateCompatible === false) {
      checks.push(
        blocker('CAPTURE_STATE_INCOMPATIBLE', 'TARGET_STALE', {
          WHAT: `Reference and candidate capture state were incompatible at ${W}.`,
          WHERE: 'captureStateCompatible / captureReceipts',
          EXPECTED: 'identical backend, capture mode, CSS viewport, CSS capture size, raster geometry, DPR and zoom',
          ACTUAL: 'captureStateCompatible=false',
          DELTA: 'pixel comparison not like-for-like',
          'LIKELY SCOPE': 'capture state normalization',
          EVIDENCE: `${docRel} stages.compare.captureStateCompatible`,
        }),
      );
    }
  }

  const quarantine = firstObj(
    model.doc.json.quarantine,
    model.doc.json.targetQuarantine,
    model.doc.json.stages?.quarantine,
    model.doc.json.stages?.clone?.quarantine,
    model.doc.json.stages?.reference?.quarantine,
  );
  if (quarantine) {
    const recovered =
      quarantine.recovered === true ||
      quarantine.recovery === true ||
      isObj(quarantine.recoveryReceipt) ||
      isStr(quarantine.recoveredAt) ||
      isObj(model.doc.json.stages?.drain) ||
      isObj(model.doc.json.stages?.targetRecovery);
    if (!recovered) {
      checks.push(
        blocker('QUARANTINE_WITHOUT_RECOVERY', 'TARGET_STALE', {
          WHAT: `A target quarantine is recorded at ${W} without a typed recovery receipt.`,
          WHERE: 'quarantine / drain / targetRecovery',
          EXPECTED: 'typed drain/reset recovery receipt before reuse',
          ACTUAL: `quarantine=${JSON.stringify(quarantine).slice(0, 200)}`,
          DELTA: 'target may still be draining; capture untrusted',
          'LIKELY SCOPE': 'tab-devtools-host quarantine recovery',
          EVIDENCE: `${docRel} quarantine block`,
        }),
      );
    }
  }

  const mask = model.mask;
  if (!mask.present) {
    checks.push(
      blocker('MASK_LEDGER_MISSING', 'OTHER', {
        WHAT: `No mask ledger was persisted for ${W}.`,
        WHERE: 'maskResolution / maskLedger',
        EXPECTED: 'requested/resolved/unresolved selectors with a masked-area ratio',
        ACTUAL: 'no mask ledger in evidence',
        DELTA: 'mask state unresolved',
        'LIKELY SCOPE': 'compare mask reporting',
        EVIDENCE: `${docRel} stages.compare`,
      }),
    );
  } else {
    if (mask.status !== null && mask.status !== 'ok') {
      checks.push(
        blocker('MASK_STATE_UNRESOLVED', 'OTHER', {
          WHAT: `Mask resolution status is not ok at ${W}.`,
          WHERE: 'maskResolution.status',
          EXPECTED: 'status === "ok" with every required selector resolved',
          ACTUAL: `status=${mask.status}`,
          DELTA: 'mask state unresolved',
          'LIKELY SCOPE': 'compare mask ledger',
          EVIDENCE: `${docRel} maskResolution`,
        }),
      );
    }
    if (mask.unresolved.length > 0) {
      checks.push(
        blocker('MASK_SELECTORS_UNRESOLVED', 'OTHER', {
          WHAT: `Required mask selectors were unresolved at ${W}.`,
          WHERE: 'maskResolution.unresolved',
          EXPECTED: 'zero unresolved required selectors',
          ACTUAL: `${mask.unresolved.length} unresolved: ${mask.unresolved.slice(0, 6).join(', ')}`,
          DELTA: `${mask.unresolved.length} unresolved`,
          'LIKELY SCOPE': 'compare mask ledger',
          EVIDENCE: `${docRel} maskResolution`,
        }),
      );
    }
    if (!isNum(mask.ratio)) {
      checks.push(
        blocker('MASK_RATIO_UNRECORDED', 'OTHER', {
          WHAT: `Masked-area ratio was not recorded at ${W}.`,
          WHERE: 'maskResolution.maskedAreaRatio',
          EXPECTED: 'a recorded masked-area ratio for the authoritative pair',
          ACTUAL: 'maskedAreaRatio missing',
          DELTA: 'masking cannot be bounded',
          'LIKELY SCOPE': 'compare mask ledger',
          EVIDENCE: `${docRel} maskResolution`,
        }),
      );
    }
    if (mask.useDefaultWidgetMasks === null) {
      checks.push(
        blocker('IMPLICIT_MASK_STATE_UNRECORDED', 'OTHER', {
          WHAT: `Implicit/default mask policy was not recorded at ${W}.`,
          WHERE: 'compare params (useDefaultWidgetMasks)',
          EXPECTED: 'useDefaultWidgetMasks === false and zero user masks for the final compare',
          ACTUAL: 'useDefaultWidgetMasks not persisted',
          DELTA: 'implicit masking cannot be excluded',
          'LIKELY SCOPE': 'compare params reporting',
          EVIDENCE: `${docRel} stages.compare`,
        }),
      );
    }
  }

  if (!model.drift.present) {
    checks.push(
      blocker('REFERENCE_DRIFT_MISSING', 'OTHER', {
        WHAT: `No reference self-drift pair was persisted for ${W}.`,
        WHERE: 'evidence/*drift* / ref-vs-ref*',
        EXPECTED: 'a reference self-drift compare under identical state (diagnostic only)',
        ACTUAL: 'no self-drift document for this viewport',
        DELTA: 'target stability unproven',
        'LIKELY SCOPE': 'canary harness (phase 5 procedure step 10)',
        EVIDENCE: `${docRel}`,
      }),
    );
  } else {
    if (model.drift.captureStateCompatible === false || model.drift.identityCoherent === false) {
      checks.push(
        blocker('REFERENCE_DRIFT_INCOHERENT', 'TARGET_STALE', {
          WHAT: `Reference self-drift pair at ${W} is not coherent.`,
          WHERE: 'drift captureReceipts / coherence',
          EXPECTED: 'coherent identity and compatible capture state on both drift captures',
          ACTUAL: `captureStateCompatible=${model.drift.captureStateCompatible}; identityCoherent=${model.drift.identityCoherent}`,
          DELTA: 'reference cannot reproduce itself',
          'LIKELY SCOPE': 'reference stability',
          EVIDENCE: `${model.drift.doc?.rel || docRel}`,
        }),
      );
    }
    if (isNum(model.drift.mismatchPercentage) && model.drift.mismatchPercentage > REFERENCE_DRIFT_LIMIT_PCT) {
      checks.push(
        blocker('EXCESSIVE_REFERENCE_DRIFT', 'TARGET_STALE', {
          WHAT: `Reference self-drift at ${W} exceeds the determinism limit.`,
          WHERE: 'drift mismatchPercentage',
          EXPECTED: `<= ${REFERENCE_DRIFT_LIMIT_PCT}% self-drift (never subtracted from candidate mismatch)`,
          ACTUAL: `${pct(model.drift.mismatchPercentage)}`,
          DELTA: `${pct(model.drift.mismatchPercentage - REFERENCE_DRIFT_LIMIT_PCT)} over limit`,
          'LIKELY SCOPE': 'reference target instability (diagnostic, not a clone defect)',
          EVIDENCE: `${model.drift.doc?.rel || docRel}`,
        }),
      );
    }
  }

  if (!model.runtime.present) {
    checks.push(
      blocker('RUNTIME_AUDIT_MISSING', 'REMOTE_VISUAL_DEPENDENCY', {
        WHAT: `No runtime asset/dependency audit was persisted for ${W}.`,
        WHERE: 'runtimeAudit / performance resource entries',
        EXPECTED: 'runtime resource entries with reference-origin visual request count',
        ACTUAL: 'no runtime audit in evidence',
        DELTA: 'forbidden reference-origin requests cannot be excluded',
        'LIKELY SCOPE': 'canary harness runtime audit',
        EVIDENCE: `${docRel}`,
      }),
    );
  }

  if (!model.standalone.present) {
    checks.push(
      blocker('STANDALONE_CAPTURE_MISSING', 'OTHER', {
        WHAT: `No standalone full-page capture lineage was persisted for ${W}.`,
        WHERE: 'standaloneCaptures',
        EXPECTED: 'independent reference/candidate full-page captures with receipts and hashes (non-authoritative)',
        ACTUAL: 'no standalone capture block in evidence',
        DELTA: 'independent continuity evidence missing',
        'LIKELY SCOPE': 'canary harness standalone capture step',
        EVIDENCE: `${docRel}`,
      }),
    );
  }

  if (!model.refMetrics.present || !model.cloneMetrics.present) {
    checks.push(
      blocker('STRUCTURAL_METRICS_MISSING', 'OTHER', {
        WHAT: `Structural metrics are missing for one side at ${W}.`,
        WHERE: 'stages.reference.metrics / stages.clone.metrics',
        EXPECTED: 'geometry + cardinality metrics for both sides',
        ACTUAL: `reference=${model.refMetrics.present} clone=${model.cloneMetrics.present}`,
        DELTA: 'structural gate unmeasurable',
        'LIKELY SCOPE': 'viewport runner measurement step',
        EVIDENCE: `${docRel} stages`,
      }),
    );
  }

  /* --- 2. Deterministic failures (only with complete evidence) --- */

  const heightDeltaPct =
    isNum(model.docHeight.delta) && isNum(model.docHeight.reference)
      ? Math.abs(deltaPct(model.docHeight.delta, model.docHeight.reference) ?? 0)
      : null;
  const heightDeterministicFail = heightDeltaPct !== null && heightDeltaPct > PAGE_HEIGHT_TARGET_PCT;

  if (cmp.real) {
    const numericConsistent =
      isNum(cmp.diffPixels) && isNum(cmp.totalPixels) && cmp.totalPixels > 0
        ? Math.abs((cmp.diffPixels / cmp.totalPixels) * 100 - cmp.mismatchPercentage) <= COMPARE_NUMERIC_TOLERANCE_PCT
        : null;
    const deterministicSample = arr(cmp.metricSamples).find(
      (s) =>
        /pixel_mismatch/i.test(String(s?.metric || '')) &&
        s?.source === 'deterministic' &&
        isNum(num(s.value)),
    );
    const numericVerified =
      numericConsistent === true ||
      (deterministicSample !== undefined &&
        Math.abs(num(deterministicSample.value) - cmp.mismatchPercentage) <= COMPARE_NUMERIC_TOLERANCE_PCT);

    let dimensionsMatch = cmp.dimensionsMatch;
    if (dimensionsMatch === null && model.pair.present) {
      const a = obj(model.pair.refReceipt?.cssCaptureSize);
      const b = obj(model.pair.cloneReceipt?.cssCaptureSize);
      if (isNum(num(a.width)) && isNum(num(b.width)) && isNum(num(a.height)) && isNum(num(b.height))) {
        dimensionsMatch = Math.abs(num(a.width) - num(b.width)) <= 1 && Math.abs(num(a.height) - num(b.height)) <= 1;
      }
    }

    if (dimensionsMatch === false) {
      checks.push(
        na(
          `pixel numeric is a placeholder produced by a dimensions short-circuit ` +
            `(dimensionsMatch=false; ${pct(cmp.mismatchPercentage)}) — never used as FAIL evidence`,
        ),
      );
      if (!heightDeterministicFail) {
        checks.push(
          blocker('PAIR_DIMENSIONS_MISMATCH', 'SETTLEMENT_FAILURE', {
            WHAT: `Authoritative pair dimensions differ at ${W} without a deterministic height failure.`,
            WHERE: 'compare dimensionsMatch',
            EXPECTED: 'identical capture dimensions, or a proven structural height failure',
            ACTUAL: `dimensionsMatch=false; layout=${JSON.stringify(cmp.layout).slice(0, 200)}`,
            DELTA: 'pixel comparison not like-for-like',
            'LIKELY SCOPE': 'capture geometry / candidate layout',
            EVIDENCE: `${docRel} stages.compare`,
          }),
        );
      }
    } else if (numericVerified === false) {
      checks.push(
        blocker('PIXEL_NUMERIC_INCONSISTENT', 'SETTLEMENT_FAILURE', {
          WHAT: `Authoritative pixel numeric is internally inconsistent at ${W}.`,
          WHERE: 'compare mismatchPercentage vs diffPixels/totalPixels',
          EXPECTED: 'mismatchPercentage ≈ diffPixels/totalPixels×100, or a deterministic metric sample',
          ACTUAL: `${pct(cmp.mismatchPercentage)} vs ${cmp.diffPixels ?? 'n/a'}/${cmp.totalPixels ?? 'n/a'}`,
          DELTA: 'pixel measurement unverifiable',
          'LIKELY SCOPE': 'compare result reporting',
          EVIDENCE: `${docRel} stages.compare`,
        }),
      );
    } else if (!isNum(cmp.mismatchPercentage)) {
      checks.push(
        blocker('PIXEL_MISMATCH_UNRECORDED', 'SETTLEMENT_FAILURE', {
          WHAT: `Authoritative pixel mismatch was not recorded at ${W}.`,
          WHERE: 'compare mismatchPercentage',
          EXPECTED: 'a deterministic mismatch percentage over the atomic pair',
          ACTUAL: 'mismatchPercentage missing',
          DELTA: 'pixel verdict unavailable',
          'LIKELY SCOPE': 'compare result reporting',
          EVIDENCE: `${docRel} stages.compare`,
        }),
      );
    } else if (cmp.mismatchPercentage > PIXEL_MISMATCH_TARGET_PCT) {
      checks.push(
        fail('PIXEL_MISMATCH', 'LAYOUT_MISMATCH', {
          WHAT: `Authoritative pixel mismatch at ${W} exceeds the ${PIXEL_MISMATCH_TARGET_PCT}% target.`,
          WHERE: 'atomic compare pair (full-page, no implicit masks)',
          EXPECTED: `<= ${PIXEL_MISMATCH_TARGET_PCT}%`,
          ACTUAL: `${pct(cmp.mismatchPercentage)} (${cmp.diffPixels ?? '?'} / ${cmp.totalPixels ?? '?'} px)`,
          DELTA: `${pct(cmp.mismatchPercentage - PIXEL_MISMATCH_TARGET_PCT)} over target`,
          'LIKELY SCOPE': 'candidate rendering/layout',
          EVIDENCE: `${docRel} stages.compare.mismatchPercentage`,
        }),
      );
    } else {
      checks.push(pass(`authoritative pixel mismatch ${pct(cmp.mismatchPercentage)} <= ${PIXEL_MISMATCH_TARGET_PCT}%`));
    }
  }

  const dh = model.docHeight;
  if (isNum(dh.delta) && isNum(dh.reference)) {
    const p = Math.abs(deltaPct(dh.delta, dh.reference) ?? 0);
    if (p > PAGE_HEIGHT_TARGET_PCT) {
      checks.push(
        fail('PAGE_HEIGHT_DRIFT', 'STRUCTURAL_HEIGHT_MISMATCH', {
          WHAT: `Document height differs from the reference at ${W}.`,
          WHERE: `${dh.source} (documentElement/body scrollHeight)`,
          EXPECTED: `reference ${dh.reference} px ±${PAGE_HEIGHT_TARGET_PCT}%`,
          ACTUAL: `candidate ${dh.clone} px (${dh.delta > 0 ? '+' : ''}${dh.delta} px, ratio ${fmt(dh.ratio, 3)})`,
          DELTA: `${pct(p)} document height`,
          'LIKELY SCOPE': 'candidate layout/section heights',
          EVIDENCE: `${docRel} ${dh.source}`,
        }),
      );
    } else {
      checks.push(pass(`document height delta ${dh.delta} px (${pct(p)}) within ±${PAGE_HEIGHT_TARGET_PCT}%`));
    }
  } else {
    checks.push(na('document height delta not measurable from persisted structural evidence'));
  }

  const sectionFindings = [];
  for (const s of model.structuralSections) {
    if (!isObj(s.reference) || !isObj(s.clone)) continue;
    const refH = num(s.reference.h);
    const cloneH = num(s.clone.h);
    if (!isNum(refH) || !isNum(cloneH)) continue;
    const d = cloneH - refH;
    const allowed = Math.max(SECTION_HEIGHT_FLOOR_PX, (Math.abs(refH) * SECTION_HEIGHT_TARGET_PCT) / 100);
    if (Math.abs(d) > allowed) {
      sectionFindings.push({ cls: isStr(s.cls) ? s.cls : 'section', refH, cloneH, d, allowed });
    }
  }
  if (sectionFindings.length > 0) {
    checks.push(
      fail('SECTION_HEIGHT_DRIFT', 'STRUCTURAL_HEIGHT_MISMATCH', {
        WHAT: `${sectionFindings.length} section(s) exceed the per-section height tolerance at ${W}.`,
        WHERE: sectionFindings.map((s) => s.cls).join(', '),
        EXPECTED: `each section within ±${SECTION_HEIGHT_TARGET_PCT}% (floor ${SECTION_HEIGHT_FLOOR_PX} px)`,
        ACTUAL: sectionFindings
          .slice(0, 6)
          .map((s) => `${s.cls}: ${s.refH}→${s.cloneH} (${s.d > 0 ? '+' : ''}${s.d} px)`)
          .join('; '),
        DELTA: `${sectionFindings.length} section(s) outside tolerance`,
        'LIKELY SCOPE': 'candidate section layout',
        EVIDENCE: `${docRel} structural.sections`,
      }),
    );
  } else if (model.structuralSections.length > 0) {
    checks.push(pass(`all ${model.structuralSections.length} matched sections within ±${SECTION_HEIGHT_TARGET_PCT}%`));
  }

  const cardinalityPairs = [
    ['sectionCount', model.refMetrics.sectionCount, model.cloneMetrics.sectionCount, 'CARDINALITY_MISMATCH', 'sections'],
    ['productCardCount', model.refMetrics.productCardCount, model.cloneMetrics.productCardCount, 'CARDINALITY_MISMATCH', 'product cards'],
    ['articleCardCount', model.refMetrics.articleCardCount, model.cloneMetrics.articleCardCount, 'CARDINALITY_MISMATCH', 'article cards'],
    ['imageCount', model.refMetrics.imageCount, model.cloneMetrics.imageCount, 'ASSET_RENDER_MISMATCH', 'rendered images'],
  ];
  for (const [key, refV, cloneV, category, label] of cardinalityPairs) {
    if (!isNum(refV) || !isNum(cloneV)) continue;
    if (refV !== cloneV) {
      checks.push(
        fail(`CARDINALITY_${key}`, category, {
          WHAT: `Rendered ${label} cardinality differs at ${W}.`,
          WHERE: `stages.reference.metrics.${key} vs stages.clone.metrics.${key}`,
          EXPECTED: `${refV}`,
          ACTUAL: `${cloneV}`,
          DELTA: `${cloneV - refV > 0 ? '+' : ''}${cloneV - refV}`,
          'LIKELY SCOPE': 'candidate generation/rendering',
          EVIDENCE: `${docRel} structural.${key}`,
        }),
      );
    } else {
      checks.push(pass(`${key}: ${refV} = ${cloneV}`));
    }
  }

  const navRef = model.refMetrics.navItemCount;
  const navClone = model.cloneMetrics.navItemCount;
  if (isNum(navRef) && isNum(navClone) && navRef !== navClone) {
    checks.push(
      fail('NAV_ITEM_MISMATCH', 'NAVIGATION_MISMATCH', {
        WHAT: `Navigation item count differs at ${W}.`,
        WHERE: 'header.site-header nav a / .menu a / li a',
        EXPECTED: `${navRef}`,
        ACTUAL: `${navClone}`,
        DELTA: `${navClone - navRef > 0 ? '+' : ''}${navClone - navRef}`,
        'LIKELY SCOPE': 'candidate header/navigation rendering',
        EVIDENCE: `${docRel} structural.navItemCount`,
      }),
    );
  } else if (isNum(navRef) && isNum(navClone)) {
    checks.push(pass(`navItemCount: ${navRef} = ${navClone}`));
  }

  const sectionOrderRef = model.refMetrics.sections.map((s) => `${s.tag || ''}.${s.cls || ''}`);
  const sectionOrderClone = model.cloneMetrics.sections.map((s) => `${s.tag || ''}.${s.cls || ''}`);
  if (sectionOrderRef.length > 0 && sectionOrderClone.length > 0) {
    const sameOrder =
      sectionOrderRef.length === sectionOrderClone.length &&
      sectionOrderRef.every((v, i) => v === sectionOrderClone[i]);
    if (!sameOrder) {
      checks.push(
        fail('SECTION_ORDER_MISMATCH', 'STRUCTURAL_HEIGHT_MISMATCH', {
          WHAT: `Rendered section order differs at ${W}.`,
          WHERE: 'document section sequence',
          EXPECTED: sectionOrderRef.slice(0, 8).join(' > '),
          ACTUAL: sectionOrderClone.slice(0, 8).join(' > '),
          DELTA: `${sectionOrderClone.length - sectionOrderRef.length} section(s)`,
          'LIKELY SCOPE': 'candidate body order',
          EVIDENCE: `${docRel} stages.*.metrics.sections`,
        }),
      );
    } else {
      checks.push(pass(`section order identical (${sectionOrderRef.length} sections)`));
    }
  }

  const geometryDiffs = [];
  for (const [name, r, c] of [
    ['header', model.refMetrics.headerRect, model.cloneMetrics.headerRect],
    ['main', model.refMetrics.mainRect, model.cloneMetrics.mainRect],
    ['footer', model.refMetrics.footerRect, model.cloneMetrics.footerRect],
  ]) {
    if (!isObj(r) || !isObj(c)) continue;
    for (const axis of ['h', 'w']) {
      const rv = num(r[axis]);
      const cv = num(c[axis]);
      if (!isNum(rv) || !isNum(cv)) continue;
      const allowed = Math.max(SECTION_HEIGHT_FLOOR_PX, (Math.abs(rv) * SECTION_HEIGHT_TARGET_PCT) / 100);
      if (Math.abs(cv - rv) > allowed) geometryDiffs.push(`${name}.${axis}: ${rv}→${cv}`);
    }
  }
  if (geometryDiffs.length > 0) {
    checks.push(
      fail('MAJOR_GEOMETRY_DRIFT', 'LAYOUT_MISMATCH', {
        WHAT: `Major component geometry differs at ${W}.`,
        WHERE: 'header / main / footer bounding boxes',
        EXPECTED: `each box within ±${SECTION_HEIGHT_TARGET_PCT}% (floor ${SECTION_HEIGHT_FLOOR_PX} px)`,
        ACTUAL: geometryDiffs.slice(0, 6).join('; '),
        DELTA: `${geometryDiffs.length} axis mismatch(es)`,
        'LIKELY SCOPE': 'candidate layout',
        EVIDENCE: `${docRel} stages.*.metrics.{headerRect,mainRect,footerRect}`,
      }),
    );
  } else if (isObj(model.refMetrics.headerRect) || isObj(model.refMetrics.mainRect) || isObj(model.refMetrics.footerRect)) {
    checks.push(pass('major component boxes within tolerance'));
  }

  const heroRef = model.refMetrics.heroRect;
  const heroClone = model.cloneMetrics.heroRect;
  if (isObj(heroRef) && isObj(heroClone) && isNum(num(heroRef.h)) && isNum(num(heroClone.h))) {
    const allowed = Math.max(SECTION_HEIGHT_FLOOR_PX, (Math.abs(num(heroRef.h)) * SECTION_HEIGHT_TARGET_PCT) / 100);
    const d = num(heroClone.h) - num(heroRef.h);
    if (Math.abs(d) > allowed) {
      checks.push(
        fail('HERO_MISMATCH', 'HERO_MISMATCH', {
          WHAT: `Hero/slider geometry differs at ${W}.`,
          WHERE: 'hero element bounding box',
          EXPECTED: `height ${num(heroRef.h)} px ±${SECTION_HEIGHT_TARGET_PCT}%`,
          ACTUAL: `${num(heroClone.h)} px`,
          DELTA: `${d > 0 ? '+' : ''}${d} px`,
          'LIKELY SCOPE': 'candidate hero/slider layout',
          EVIDENCE: `${docRel} stages.*.metrics.heroRect`,
        }),
      );
    } else {
      checks.push(pass(`hero height ${num(heroRef.h)} → ${num(heroClone.h)} px within tolerance`));
    }
  }

  if (isNum(model.refMetrics.clientWidth) && isNum(model.cloneMetrics.clientWidth)) {
    const d = model.cloneMetrics.clientWidth - model.refMetrics.clientWidth;
    if (Math.abs(d) > 1) {
      checks.push(
        fail('RESPONSIVE_CLIENT_WIDTH', 'RESPONSIVE_MISMATCH', {
          WHAT: `CSS client width differs at ${W}.`,
          WHERE: 'documentElement.clientWidth',
          EXPECTED: `${model.refMetrics.clientWidth} px (±1 px)`,
          ACTUAL: `${model.cloneMetrics.clientWidth} px`,
          DELTA: `${d > 0 ? '+' : ''}${d} px`,
          'LIKELY SCOPE': 'viewport/scrollbar capture state or candidate responsive layout',
          EVIDENCE: `${docRel} stages.*.metrics.clientWidth`,
        }),
      );
    } else {
      checks.push(pass(`clientWidth parity ${model.refMetrics.clientWidth} px`));
    }
  }

  const remoteHtml = Array.isArray(model.telemetry?.bundle?.remoteSubresources)
    ? model.telemetry.bundle.remoteSubresources.length
    : null;
  if (isNum(remoteHtml)) {
    if (remoteHtml > 0) {
      checks.push(
        fail('REMOTE_SUBRESOURCES_IN_HTML', 'ASSET_MISMATCH', {
          WHAT: `Generated HTML still references remote subresources at ${W}.`,
          WHERE: 'bundle.remoteSubresources',
          EXPECTED: '0 remote subresources (all localized)',
          ACTUAL: `${remoteHtml}: ${arr(model.telemetry.bundle.remoteSubresources).slice(0, 4).join(', ')}`,
          DELTA: `+${remoteHtml}`,
          'LIKELY SCOPE': 'asset localization/rewrite',
          EVIDENCE: 'build telemetry bundle.remoteSubresources',
        }),
      );
    } else {
      checks.push(pass('0 remote subresources in generated HTML'));
    }
  }

  const gridRef = model.refMetrics.firstGrid;
  const gridClone = model.cloneMetrics.firstGrid;
  if (gridRef && gridClone) {
    const fields = ['columns', 'rows', 'childCount'];
    const diffs = fields.filter((f) => num(gridRef[f]) !== num(gridClone[f]));
    if (diffs.length > 0) {
      checks.push(
        fail('GRID_MISMATCH', 'GRID_MISMATCH', {
          WHAT: `Product grid geometry differs at ${W}.`,
          WHERE: `${gridRef.cls || '.product-list'} display=${gridRef.display}`,
          EXPECTED: diffs.map((f) => `${f}=${gridRef[f]}`).join(', '),
          ACTUAL: diffs.map((f) => `${f}=${gridClone[f]}`).join(', '),
          DELTA: diffs.map((f) => `${f}: ${num(gridClone[f]) - num(gridRef[f]) > 0 ? '+' : ''}${num(gridClone[f]) - num(gridRef[f])}`).join('; '),
          'LIKELY SCOPE': 'candidate grid layout',
          EVIDENCE: `${docRel} stages.*.metrics.productListGrids[0]`,
        }),
      );
    } else {
      checks.push(pass(`grid ${gridRef.columns}×${gridRef.rows} with ${gridRef.childCount} children identical`));
    }
  }

  const typographyDiffs = [];
  for (const sel of Object.keys(model.refMetrics.fonts)) {
    const r = obj(model.refMetrics.fonts[sel]);
    const c = obj(model.cloneMetrics.fonts[sel]);
    if (!isObj(model.cloneMetrics.fonts[sel])) continue;
    for (const field of ['family', 'size', 'weight']) {
      if (isStr(r[field]) && isStr(c[field]) && r[field] !== c[field]) {
        typographyDiffs.push(`${sel}.${field}: ${r[field]} → ${c[field]}`);
      }
    }
  }
  if (typographyDiffs.length > 0) {
    checks.push(
      fail('TYPOGRAPHY_MISMATCH', 'TYPOGRAPHY_MISMATCH', {
        WHAT: `Computed typography differs at ${W}.`,
        WHERE: typographyDiffs.map((d) => d.split(':')[0]).join(', '),
        EXPECTED: 'identical family/size/weight on both sides',
        ACTUAL: typographyDiffs.slice(0, 6).join('; '),
        DELTA: `${typographyDiffs.length} property mismatch(es)`,
        'LIKELY SCOPE': 'candidate CSS/font loading',
        EVIDENCE: `${docRel} stages.*.metrics.fonts`,
      }),
    );
  } else if (Object.keys(model.refMetrics.fonts).length > 0) {
    checks.push(pass('computed typography identical for all sampled selectors'));
  }

  if (isNum(model.refMetrics.overflowX) && isNum(model.cloneMetrics.overflowX)) {
    const regression = model.cloneMetrics.overflowX - model.refMetrics.overflowX;
    if (regression > OVERFLOW_REGRESSION_TOLERANCE_PX) {
      checks.push(
        fail('OVERFLOW_REGRESSION', 'OVERFLOW_MISMATCH', {
          WHAT: `Candidate overflows horizontally more than the reference at ${W}.`,
          WHERE: 'documentElement scrollWidth − clientWidth',
          EXPECTED: `<= reference overflow ${model.refMetrics.overflowX} px (+${OVERFLOW_REGRESSION_TOLERANCE_PX} px tolerance)`,
          ACTUAL: `${model.cloneMetrics.overflowX} px`,
          DELTA: `+${regression} px candidate-worse`,
          'LIKELY SCOPE': 'candidate responsive layout',
          EVIDENCE: `${docRel} structural.overflowX`,
        }),
      );
    } else if (model.refMetrics.overflowX > 0 || model.cloneMetrics.overflowX > 0) {
      checks.push(
        pass(
          `no candidate-worse overflow (reference ${model.refMetrics.overflowX} px, candidate ${model.cloneMetrics.overflowX} px` +
            `${model.refMetrics.overflowX > 0 ? '; target itself overflows' : ''})`,
        ),
      );
    } else {
      checks.push(pass('no horizontal overflow on either side'));
    }
  }

  const brokenRef = model.refSettle.brokenImages.length;
  const brokenClone = model.cloneSettle.brokenImages.length;
  if (brokenClone > 0) {
    checks.push(
      fail('BROKEN_RENDERED_ASSETS', 'ASSET_RENDER_MISMATCH', {
        WHAT: `Rendered assets failed to load in the candidate at ${W}.`,
        WHERE: 'document.images naturalWidth === 0',
        EXPECTED: '0 broken rendered assets',
        ACTUAL: `${brokenClone} broken (reference has ${brokenRef})`,
        DELTA: `${brokenClone - brokenRef > 0 ? '+' : ''}${brokenClone - brokenRef} vs reference`,
        'LIKELY SCOPE': 'asset localization/rendering',
        EVIDENCE: `${docRel} stages.clone.settle.brokenImages`,
      }),
    );
  } else if (isNum(brokenClone)) {
    checks.push(pass(`0 broken rendered assets (reference ${brokenRef})`));
  }

  if (isNum(model.runtime.referenceOrigin)) {
    if (model.runtime.referenceOrigin > 0) {
      checks.push(
        fail('REFERENCE_ORIGIN_REQUESTS', 'REMOTE_VISUAL_DEPENDENCY', {
          WHAT: `The clone runtime issued reference-origin visual requests at ${W}.`,
          WHERE: 'runtime resource entries',
          EXPECTED: '0 reference-origin visual requests',
          ACTUAL: `${model.runtime.referenceOrigin}`,
          DELTA: `+${model.runtime.referenceOrigin}`,
          'LIKELY SCOPE': 'candidate HTML asset rewriting',
          EVIDENCE: `${docRel} runtime audit`,
        }),
      );
    } else {
      checks.push(pass('0 reference-origin visual requests at runtime'));
    }
  }

  if (isNum(mask.ratio)) {
    if (mask.ratio > MASK_AREA_LIMIT_RATIO) {
      checks.push(
        fail('MASKING_TOO_BROAD', 'MASKING_TOO_BROAD', {
          WHAT: `Masked area exceeds the allowed budget at ${W}.`,
          WHERE: 'maskResolution.maskedAreaRatio',
          EXPECTED: `<= ${MASK_AREA_LIMIT_RATIO * 100}%`,
          ACTUAL: `${pct(mask.ratio * 100)}`,
          DELTA: `${pct((mask.ratio - MASK_AREA_LIMIT_RATIO) * 100)} over budget`,
          'LIKELY SCOPE': 'compare mask policy',
          EVIDENCE: `${docRel} maskResolution.maskedAreaRatio`,
        }),
      );
    } else {
      checks.push(pass(`masked area ${pct(mask.ratio * 100)} <= ${MASK_AREA_LIMIT_RATIO * 100}%`));
    }
  }
  if (mask.useDefaultWidgetMasks === true) {
    checks.push(
      fail('IMPLICIT_DEFAULT_MASKS', 'MASKING_TOO_BROAD', {
        WHAT: `The final compare used implicit default widget masks at ${W}.`,
        WHERE: 'compare params useDefaultWidgetMasks',
        EXPECTED: 'useDefaultWidgetMasks === false with zero user masks',
        ACTUAL: 'useDefaultWidgetMasks=true',
        DELTA: 'implicit masking applied',
        'LIKELY SCOPE': 'compare params',
        EVIDENCE: `${docRel} stages.compare`,
      }),
    );
  }
  if (mask.requested.length > 0) {
    checks.push(
      fail('USER_MASKS_REQUESTED', 'MASKING_TOO_BROAD', {
        WHAT: `User-supplied masks were requested in the final compare at ${W}.`,
        WHERE: 'compare params maskSelectors',
        EXPECTED: 'zero user masks for the final fidelity compare',
        ACTUAL: `${mask.requested.length} requested: ${mask.requested.slice(0, 6).join(', ')}`,
        DELTA: `${mask.requested.length} requested masks`,
        'LIKELY SCOPE': 'compare params',
        EVIDENCE: `${docRel} stages.compare`,
      }),
    );
  }

  /* --- 3. Aggregate: availability first, then deterministic failures --- */

  const blockers = checks.filter((c) => c.status === 'unavailable');
  const hardBlockers = blockers.filter((c) => c.hard);
  const softBlockers = blockers.filter((c) => !c.hard);
  let failures = checks.filter((c) => c.status === 'fail');
  let notAdjudicated = [];
  if (hardBlockers.length > 0) {
    // FAIL requires complete deterministic evidence; with a hard blocker present the
    // viewport is undecidable and observed deltas are diagnostics, not proven failures.
    notAdjudicated = failures.map((c) => c.code);
    failures = [];
  }
  const status =
    hardBlockers.length > 0
      ? 'INCONCLUSIVE'
      : failures.length > 0
        ? 'FAIL'
        : softBlockers.length > 0
          ? 'INCONCLUSIVE'
          : 'PASS';
  return { status, checks, blockers, hardBlockers, softBlockers, failures, notAdjudicated };
}

function evaluatePairLineage(model) {
  const checks = [];
  const W = `${model.width}×${model.height}`;
  const docRel = model.doc.rel;
  const pair = model.pair;

  const refRes = model.artifactIndex.lookup(pair.refArtifact, model.doc.docId, '.authoritativePair.reference');
  const cloneRes = model.artifactIndex.lookup(pair.cloneArtifact, model.doc.docId, '.authoritativePair.candidate');
  const refVerified = Boolean(refRes && refRes.shaVerified);
  const cloneVerified = Boolean(cloneRes && cloneRes.shaVerified);

  if (!refVerified || !cloneVerified) {
    checks.push(
      blocker('PAIR_ARTIFACTS_UNVERIFIED', 'SETTLEMENT_FAILURE', {
        WHAT: `Authoritative pair artifacts are not hash-verified at ${W}.`,
        WHERE: 'atomic pair reference/candidate artifacts',
        EXPECTED: 'both pair PNGs resolved with matching sha256 and byte length',
        ACTUAL: `reference=${refVerified ? 'verified' : 'missing/unverified'}; candidate=${cloneVerified ? 'verified' : 'missing/unverified'}`,
        DELTA: 'authoritative pixel lineage incomplete',
        'LIKELY SCOPE': 'artifact staging/fetch',
        EVIDENCE: `${docRel} atomic pair`,
      }),
    );
  }

  const receipts = [
    ['reference', pair.refReceipt, refRes],
    ['candidate', pair.cloneReceipt, cloneRes],
  ];
  for (const [role, receipt, res] of receipts) {
    if (!isObj(receipt)) {
      checks.push(
        blocker(`PAIR_${role.toUpperCase()}_RECEIPT_MISSING`, 'SETTLEMENT_FAILURE', {
          WHAT: `No capture receipt is attached to the ${role} pair artifact at ${W}.`,
          WHERE: `atomic pair ${role} receipt`,
          EXPECTED: 'backend, captureMode, cssViewport, cssCaptureSize, rasterSize, dpr, zoom, timestamp',
          ACTUAL: 'receipt absent',
          DELTA: 'capture lineage unproven',
          'LIKELY SCOPE': 'capture envelope/receipt plumbing',
          EVIDENCE: `${docRel} atomic pair`,
        }),
      );
      continue;
    }
    const mode = isStr(receipt.captureMode) ? receipt.captureMode : null;
    if (mode !== 'full-page') {
      checks.push(
        blocker(`PAIR_${role.toUpperCase()}_MODE`, 'SETTLEMENT_FAILURE', {
          WHAT: `Authoritative ${role} capture is not a full-page capture at ${W}.`,
          WHERE: `atomic pair ${role} receipt.captureMode`,
          EXPECTED: 'captureMode === "full-page"',
          ACTUAL: `captureMode=${mode || 'not-recorded'}`,
          DELTA: 'full-page lineage absent',
          'LIKELY SCOPE': 'capture mode resolution',
          EVIDENCE: `${docRel} atomic pair ${role} receipt`,
        }),
      );
    }
    const cssViewport = firstObj(receipt.cssViewport);
    const cssCaptureSize = firstObj(receipt.cssCaptureSize);
    const rasterSize = firstObj(receipt.rasterSize);
    const dpr = num(receipt.dpr);
    const zoom = num(receipt.zoom);
    if (!cssViewport || !cssCaptureSize || !rasterSize || !isNum(dpr) || !isNum(zoom)) {
      checks.push(
        blocker(`PAIR_${role.toUpperCase()}_GEOMETRY_MISSING`, 'SETTLEMENT_FAILURE', {
          WHAT: `Authoritative ${role} capture geometry is incomplete at ${W}.`,
          WHERE: `atomic pair ${role} receipt`,
          EXPECTED: 'cssViewport, cssCaptureSize, rasterSize, dpr, zoom all recorded',
          ACTUAL: `cssViewport=${Boolean(cssViewport)} cssCaptureSize=${Boolean(cssCaptureSize)} rasterSize=${Boolean(rasterSize)} dpr=${dpr ?? 'n/a'} zoom=${zoom ?? 'n/a'}`,
          DELTA: 'geometry compatibility unproven',
          'LIKELY SCOPE': 'capture envelope/receipt plumbing',
          EVIDENCE: `${docRel} atomic pair ${role} receipt`,
        }),
      );
      continue;
    }
    if (receipt.settleComplete === false) {
      checks.push(
        blocker(`PAIR_${role.toUpperCase()}_SETTLE_INCOMPLETE`, 'SETTLEMENT_FAILURE', {
          WHAT: `Authoritative ${role} capture receipt reports incomplete settlement at ${W}.`,
          WHERE: `atomic pair ${role} receipt.settleComplete`,
          EXPECTED: 'settleComplete === true',
          ACTUAL: 'settleComplete=false',
          DELTA: 'capture not settled',
          'LIKELY SCOPE': 'settlement barrier',
          EVIDENCE: `${docRel} atomic pair ${role} receipt`,
        }),
      );
    }
  }

  if (checks.length === 0) checks.push(pass('authoritative atomic pair present with full-page lineage on both sides'));
  return checks;
}

/* ------------------------------------------------------------------ *
 * Historical runs (Section 12) — read-only, never rewritten
 * ------------------------------------------------------------------ */

function loadHistorical() {
  const runs = {};
  for (const name of ['run1', 'run2']) {
    const dir = path.join(CANARY_ROOT, name);
    const evidenceDir = path.join(dir, 'evidence');
    const entry = { name, dir, present: fs.existsSync(dir), evidence: [], telemetry: null, viewports: {}, compare: null, drift: null };
    if (entry.present && fs.existsSync(evidenceDir)) {
      for (const file of fs.readdirSync(evidenceDir).filter((f) => f.toLowerCase().endsWith('.json')).sort()) {
        let json = null;
        try {
          json = JSON.parse(fs.readFileSync(path.join(evidenceDir, file), 'utf8'));
        } catch {
          continue;
        }
        if (!isObj(json)) continue;
        entry.evidence.push(file);
        if (isObj(json.bundle) && isObj(json.a0)) entry.telemetry = json;
        if (isObj(json.viewport) && isObj(json.stages)) entry.viewports[viewportKey(num(json.viewport.width), num(json.viewport.height))] = json;
        if (isNum(num(json.mismatchPercentage)) && isObj(json.captureReceipts)) {
          const isSelfDrift = /ref-vs-ref|self/i.test(file);
          const isDrift = isSelfDrift || /drift/i.test(file);
          if (isSelfDrift && !entry.selfDrift) {
            entry.drift = json;
            entry.selfDrift = true;
          } else if (isDrift && !entry.drift) {
            entry.drift = json;
          } else if (!isDrift && !entry.compare) {
            entry.compare = json;
          }
        }
      }
    }
    runs[name] = entry;
  }
  return runs;
}

function historicalMetrics(run) {
  const t = obj(run.telemetry);
  const bundle = obj(t.bundle);
  const a0 = obj(t.a0);
  const docHeight = {};
  for (const key of Object.keys(run.viewports)) {
    const j = run.viewports[key];
    docHeight[key] = firstDef(num(j.structural?.docHeight?.clone), num(j.stages?.clone?.metrics?.docHeight));
  }
  return {
    blueprints: Array.isArray(t.blueprints) ? t.blueprints.length : null,
    entryBytes: num(bundle.entryBytes),
    entrySha256: isStr(bundle.entrySha256) ? bundle.entrySha256 : null,
    productCount: num(bundle.productCount),
    assetFiles: num(bundle.assetFiles),
    remoteSubresources: Array.isArray(bundle.remoteSubresources) ? bundle.remoteSubresources.length : null,
    a0Images: num(a0.images),
    a0Fonts: num(a0.fonts),
    localizedAssets: Array.isArray(t.assetIntegrity) ? t.assetIntegrity.length : null,
    compareMismatch: num(run.compare?.mismatchPercentage),
    compareVerdict: isStr(run.compare?.verdict) ? run.compare.verdict : null,
    compareDimensionsMatch: typeof run.compare?.dimensionsMatch === 'boolean' ? run.compare.dimensionsMatch : null,
    compareHeightDelta: num(run.compare?.dimensions?.layout?.deltaPx),
    driftMismatch: num(run.drift?.mismatchPercentage),
    docHeight,
  };
}

/* ------------------------------------------------------------------ *
 * Report rendering
 * ------------------------------------------------------------------ */

function renderEnvironment(ctx) {
  const lines = [];
  lines.push('## 1. Environment');
  lines.push('');
  const telemetry = obj(ctx.telemetry);
  const input = obj(telemetry.input);
  const refUrl = ctx.viewportModels.map((m) => m.refMetrics.url).find(isStr) || 'not recorded in evidence';
  const cloneUrl = ctx.viewportModels.map((m) => m.cloneMetrics.url).find(isStr) || 'not recorded in evidence';
  const page = ctx.page;
  const publishedRun = ctx.publishedRun;
  lines.push(
    codeBlock([
      `Run directory:  ${relToRepo(ctx.runDir)}`,
      `Evidence dir:   ${relToRepo(ctx.evidenceDir)} (${ctx.files.length} JSON documents)`,
      `Attempt:        ${page.attemptId || 'none (no attempt pointer)'}`,
      `Provenance:     ${page.provenance}${page.provenanceReason ? ` (${page.provenanceReason})` : ''}`,
      `Mobile bundle:  ${isStr(page.mobileCloneDir) ? relToRepo(page.mobileCloneDir) : 'not published'}`,
      `Published run:  ${publishedRun.runId} (${publishedRun.source})`,
      `Campaign report:${publishedRun.reportPath ? ` ${relToRepo(publishedRun.reportPath)}` : ' not published'}`,
      `Generator:      ${GENERATOR}`,
      `Report anchor:  ${ctx.generatedAt || 'no evidence timestamp recorded'}`,
      `Reference URL:  ${refUrl}`,
      `Clone URL:      ${cloneUrl}`,
      `Runtime:        node ${process.version} on ${process.platform} ${process.arch}`,
      `Clone bundle:   ${isStr(telemetry.bundle?.entryHtmlPath) ? relToRepo(telemetry.bundle.entryHtmlPath) : 'not recorded'}`,
      `Clone input:    ${isStr(input.path) ? relToRepo(input.path) : 'not recorded'}`,
    ]),
  );
  lines.push('');
  lines.push('Persisted evidence inventory (sha256 computed at generation time):');
  lines.push('');
  lines.push(
    mdTable(
      ['Document', 'Role', 'Bytes', 'sha256'],
      ctx.files.map((d) => [d.rel, d.kind, d.bytes, d.sha256]),
    ),
  );
  lines.push('');
  lines.push(
    'Standalone full-page captures recorded in this run are independent continuity evidence. ' +
      'Only the atomic compare pair is an authoritative pixel input; this generator never merges, substitutes, or chooses between the two lineages.',
  );
  return lines.join('\n');
}

function renderPipeline(ctx) {
  const t = obj(ctx.telemetry);
  const a0 = obj(t.a0);
  const bundle = obj(t.bundle);
  const integrity = arr(t.assetIntegrity);
  const settlementComplete = ctx.viewportModels.filter((m) => m.refSettle.complete && m.cloneSettle.complete).length;
  const pairCount = ctx.viewportModels.filter((m) => m.pair.present).length;
  const cmpResults = ctx.viewportModels.filter((m) => m.cmp.real).length;
  const rows = [
    ['A0 Discovery', 'AssetHarvester via CloneIRBuilder.harvestFromHtml', isObj(t.a0) ? `YES (${a0.total ?? '?'} resources)` : 'NO EVIDENCE'],
    ['A1 Localization', 'AssetLocalizer', integrity.length ? `YES (${integrity.length} files)` : 'NO EVIDENCE'],
    ['A2 Optimization/Preservation', 'IndependentHtmlCloneGenerator (localize + rewrite + audit)', integrity.length ? 'YES' : 'NO EVIDENCE'],
    ['Independent HTML Generation', 'IndependentHtmlCloneGenerator.generateCloneBundle', isNum(bundle.entryBytes) ? `YES (${bundle.entryBytes.toLocaleString('en-US')} B)` : 'NO EVIDENCE'],
    ['Chromium Render', 'live AntiFan Desktop tabs (real Chromium)', ctx.viewportModels.length ? `YES (${ctx.viewportModels.length} viewports)` : 'NO EVIDENCE'],
    ['Settlement', 'runtime settle probe (network/fonts/images/DOM/visual)', settlementComplete ? `YES (${settlementComplete}/${ctx.viewportModels.length} viewports)` : 'NO EVIDENCE'],
    ['Standalone Capture', 'anti.screenshot.full_page (independent continuity evidence)', ctx.viewportModels.filter((m) => m.standalone.present).length ? `YES (${ctx.viewportModels.filter((m) => m.standalone.present).length}/${ctx.viewportModels.length})` : 'NO EVIDENCE'],
    ['Visual Compare', 'anti.visual.compare (atomic pair)', pairCount ? `PAIR PRESENT (${pairCount}/${ctx.viewportModels.length})` : 'NO AUTHORITATIVE PAIR'],
    ['Structural Verification', 'unmasked live geometry/cardinality probes on both tabs', ctx.viewportModels.some((m) => m.structuralSections.length) ? 'YES' : 'NO EVIDENCE'],
    ['Fidelity Gate', 'this report (deterministic from persisted evidence)', 'EVALUATED'],
  ];
  return ['## 2. Pipeline Tested', '', mdTable(['Stage', 'Real implementation', 'Executed'], rows), '',
    `Compare results evaluated: ${cmpResults}/${ctx.viewportModels.length} viewports; authoritative pairs: ${pairCount}/${ctx.viewportModels.length}.`,
  ].join('\n');
}

function renderReferenceCapture(ctx) {
  const rows = ctx.viewportModels.map((m) => {
    const settle = m.refSettle;
    const capture = m.pair.present ? 'atomic pair recorded' : m.standalone.present ? 'standalone only (non-authoritative)' : 'NOT CAPTURED';
    return [
      `${m.width}×${m.height}`,
      m.refMetrics.url || 'n/a',
      m.refMetrics.docHeight ?? 'n/a',
      m.refMetrics.sectionCount ?? 'n/a',
      m.refMetrics.productCardCount ?? 'n/a',
      m.refMetrics.imageCount ?? 'n/a',
      settle.complete ? `settled ${settle.settlementDuration ?? '?'} ms` : 'NOT SETTLED',
      capture,
    ];
  });
  return [
    '## 3. Reference Capture',
    '',
    mdTable(['Viewport', 'Reference URL', 'docHeight', 'Sections', 'Cards', 'Images', 'Settlement', 'Capture'], rows),
    '',
    'Readiness floors are derived from the captured reference artifact; a reference that no longer exposes that structure is rejected (`REFERENCE_NOT_READY`) rather than measured.',
  ].join('\n');
}

function renderAssetDiscovery(ctx) {
  const t = obj(ctx.telemetry);
  const a0 = obj(t.a0);
  if (!isObj(t.a0)) return ['## 4. Asset Discovery', '', 'No A0 discovery telemetry was persisted for this run.'].join('\n');
  const hosts = arr(a0.imageHosts).map(([host, count]) => `${host} ${count}`).join(', ') || 'n/a';
  const archetypes = Object.entries(obj(a0.byArchetype)).map(([k, v]) => `${k} ${v}`).join(', ') || 'n/a';
  return [
    '## 4. Asset Discovery (A0, real storefront)',
    '',
    codeBlock([
      `stylesheets            ${a0.stylesheets ?? 'n/a'}`,
      `javascripts            ${a0.javascripts ?? 'n/a'}`,
      `images                 ${a0.images ?? 'n/a'}`,
      `fonts (A0 counter)     ${a0.fonts ?? 'n/a'}`,
      `total resources        ${a0.total ?? 'n/a'}`,
      `image hosts            ${hosts}`,
      `unresolvedRelative     ${a0.unresolvedRelative ?? 'n/a'} (A0 telemetry label; localization outcome is audited in §5)`,
      `by archetype           ${archetypes}`,
    ]),
  ].join('\n');
}

function renderAssetLocalization(ctx) {
  const t = obj(ctx.telemetry);
  const bundle = obj(t.bundle);
  const integrity = arr(t.assetIntegrity);
  if (!integrity.length && !isObj(t.bundle)) {
    return ['## 5. Asset Localization', '', 'No localization/bundle telemetry was persisted for this run.'].join('\n');
  }
  const totalBytes = integrity.reduce((sum, a) => sum + (num(a.bytes) ?? 0), 0);
  const missingSha = integrity.filter((a) => !isStr(a.sha256)).length;
  const missingMagic = integrity.filter((a) => !isStr(a.magic)).length;
  const zeroByte = integrity.filter((a) => (num(a.bytes) ?? 0) === 0).length;
  const formats = {};
  for (const a of integrity) {
    const ext = isStr(a.file) ? (path.extname(a.file).replace('.', '') || 'none') : 'unknown';
    formats[ext] = (formats[ext] || 0) + 1;
  }
  const formatLine = Object.entries(formats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  return [
    '## 5. Asset Localization (A1/A2)',
    '',
    codeBlock([
      `localized                ${integrity.length} files / ${totalBytes.toLocaleString('en-US')} bytes`,
      `zero-byte                ${zeroByte}`,
      `missing sha256           ${missingSha}`,
      `missing magic bytes      ${missingMagic}`,
      `formats                  ${formatLine || 'n/a'}`,
      `remote subresources in generated HTML  ${isNum(num(bundle.remoteSubresources?.length)) ? bundle.remoteSubresources.length : 'n/a'}`,
      `localized asset files    ${bundle.assetFiles ?? 'n/a'} / ${isNum(bundle.assetBytes) ? bundle.assetBytes.toLocaleString('en-US') : 'n/a'} bytes`,
    ]),
    '',
    'Every referenced asset above was resolved and hash-verified against its persisted receipt during report generation; a missing or mismatched asset fails generation instead of producing a verdict.',
  ].join('\n');
}

function renderIndependentHtml(ctx) {
  const t = obj(ctx.telemetry);
  const bundle = obj(t.bundle);
  if (!isObj(t.bundle)) return ['## 6. Independent HTML', '', 'No bundle telemetry was persisted for this run.'].join('\n');
  const blueprintCount = Array.isArray(t.blueprints) ? t.blueprints.length : null;
  return [
    '## 6. Independent HTML',
    '',
    codeBlock([
      `output      ${isStr(bundle.entryHtmlPath) ? relToRepo(bundle.entryHtmlPath) : 'n/a'}`,
      `bytes       ${isNum(bundle.entryBytes) ? bundle.entryBytes.toLocaleString('en-US') : 'n/a'}`,
      `sha256      ${isStr(bundle.entrySha256) ? bundle.entrySha256 : 'n/a'}`,
      `assets      ${bundle.assetFiles ?? 'n/a'} files / ${isNum(bundle.assetBytes) ? bundle.assetBytes.toLocaleString('en-US') : 'n/a'} bytes`,
      `blueprints  ${blueprintCount ?? 'n/a'}`,
      `products    ${bundle.productCount ?? 'n/a'} (normalized) / articles ${bundle.articleCount ?? 'n/a'}`,
      `remote navigation links (allowed)  ${bundle.remoteNavigationCount ?? 'n/a'}`,
    ]),
  ].join('\n');
}

function renderLiveChromium(ctx) {
  const rows = ctx.viewportModels.map((m) => {
    const pixel = m.cmp.real
      ? m.cmp.dimensionsMatch === false
        ? `placeholder ${pct(m.cmp.mismatchPercentage)} (dimensions mismatch)`
        : pct(m.cmp.mismatchPercentage)
      : 'BLOCKED';
    const height = isNum(m.docHeight.delta)
      ? `${m.docHeight.delta > 0 ? '+' : ''}${m.docHeight.delta} px (${m.docHeight.reference} → ${m.docHeight.clone}, ratio ${fmt(m.docHeight.ratio, 3)})`
      : 'n/a';
    const structural = `${m.refMetrics.sectionCount ?? '?'}/${m.cloneMetrics.sectionCount ?? '?'} sections, ` +
      `${m.refMetrics.productCardCount ?? '?'}/${m.cloneMetrics.productCardCount ?? '?'} cards, ` +
      `${m.refMetrics.imageCount ?? '?'}/${m.cloneMetrics.imageCount ?? '?'} imgs`;
    const assets = `${m.cloneSettle.brokenImages.length} broken / ${m.cloneSettle.imageCount ?? '?'} rendered`;
    const settlement = m.refSettle.complete && m.cloneSettle.complete
      ? `all gates true (ref ${m.refSettle.settlementDuration ?? '?'} ms / clone ${m.cloneSettle.settlementDuration ?? '?'} ms)`
      : 'INCOMPLETE';
    return [`${m.width}×${m.height}`, pixel, height, structural, assets, settlement, m.gate.status];
  });
  return [
    '## 7. Live Chromium Results',
    '',
    mdTable(['Viewport', 'Pixel Diff', 'Height Diff', 'Structural', 'Assets', 'Settlement', 'Verdict'], rows),
    '',
    '`Verdict` is the per-viewport gate outcome defined in §14. A placeholder numeric produced by a dimensions short-circuit is never treated as a pixel measurement.',
  ].join('\n');
}

function renderStructuralFindings(ctx) {
  const lines = ['## 8. Structural Findings', ''];
  for (const m of ctx.viewportModels) {
    lines.push(`### ${m.width}×${m.height}`);
    lines.push('');
    if (!m.structuralSections.length && !m.refMetrics.present) {
      lines.push('No structural evidence persisted for this viewport.');
      lines.push('');
      continue;
    }
    const dh = m.docHeight;
    const compatible = m.pair.present && m.pair.captureStateCompatible !== false && m.cmp.dimensionsMatch !== false;
    lines.push(
      codeBlock([
        `docHeight        reference ${dh.reference ?? 'n/a'} → candidate ${dh.clone ?? 'n/a'} (${isNum(dh.delta) ? `${dh.delta > 0 ? '+' : ''}${dh.delta}` : 'n/a'} px, ratio ${fmt(dh.ratio, 3)})`,
        `overflowX        reference ${m.refMetrics.overflowX ?? 'n/a'} → candidate ${m.cloneMetrics.overflowX ?? 'n/a'}`,
        `sectionCount     ${m.refMetrics.sectionCount ?? 'n/a'} → ${m.cloneMetrics.sectionCount ?? 'n/a'}`,
        `productCardCount ${m.refMetrics.productCardCount ?? 'n/a'} → ${m.cloneMetrics.productCardCount ?? 'n/a'}`,
        `articleCardCount ${m.refMetrics.articleCardCount ?? 'n/a'} → ${m.cloneMetrics.articleCardCount ?? 'n/a'}`,
        `navItemCount     ${m.refMetrics.navItemCount ?? 'n/a'} → ${m.cloneMetrics.navItemCount ?? 'n/a'}`,
        `linkCount        ${m.refMetrics.linkCount ?? 'n/a'} → ${m.cloneMetrics.linkCount ?? 'n/a'} (diagnostic; time-dependent on hydrated targets)`,
        `imageCount       ${m.refMetrics.imageCount ?? 'n/a'} → ${m.cloneMetrics.imageCount ?? 'n/a'}`,
        `brokenImages     ${m.refSettle.brokenImages.length} → ${m.cloneSettle.brokenImages.length}`,
      ]),
    );
    const changed = m.structuralSections.filter((s) => isNum(num(s.dh)) && s.dh !== 0);
    if (changed.length) {
      lines.push('');
      lines.push('Non-zero matched section deltas:');
      lines.push('');
      lines.push(
        mdTable(
          ['Section', 'Reference h', 'Candidate h', 'Δh'],
          changed.map((s) => [s.cls || 'section', num(s.reference?.h) ?? 'n/a', num(s.clone?.h) ?? 'n/a', s.dh > 0 ? `+${s.dh}` : s.dh]),
        ),
      );
    } else if (m.structuralSections.length) {
      lines.push('');
      lines.push(`All ${m.structuralSections.length} matched sections have identical heights.`);
    }
    if (m.refMetrics.firstGrid && m.cloneMetrics.firstGrid) {
      const g = m.refMetrics.firstGrid;
      const c = m.cloneMetrics.firstGrid;
      lines.push('');
      lines.push(
        codeBlock([
          `grid             reference ${g.display} ${g.columns}×${g.rows} (${g.childCount} children)`,
          `                 candidate ${c.display} ${c.columns}×${c.rows} (${c.childCount} children)`,
          `fonts            ${Object.entries(m.refMetrics.fonts).slice(0, 3).map(([sel, f]) => `${sel} ${f.family} ${f.size}/${f.weight}`).join(' | ') || 'n/a'}`,
        ]),
      );
    }
    if (!compatible) {
      lines.push('');
      lines.push(
        'Capture-state note: this viewport has no verified atomic pair, so the geometry above is ' +
          'observed structural evidence only; it is not attributed to the clone as a pixel-verified defect.',
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderVisualFindings(ctx) {
  const lines = ['## 9. Visual Findings', ''];
  const withPair = ctx.viewportModels.filter((m) => m.pair.present);
  const withStandalone = ctx.viewportModels.filter((m) => m.standalone.present);
  if (withPair.length === 0) {
    lines.push(
      '**No authoritative pixel comparison was produced.** No atomic compare pair exists in the persisted evidence for any required viewport, so the pixel layer carries no verdict.',
    );
  } else {
    lines.push('Authoritative pixel inputs (atomic compare pairs only):');
    lines.push('');
    lines.push(
      mdTable(
        ['Viewport', 'Mismatch', 'Diff px', 'Total px', 'dimensionsMatch', 'Compare verdict'],
        withPair.map((m) => [
          `${m.width}×${m.height}`,
          pct(m.cmp.mismatchPercentage),
          m.cmp.diffPixels ?? 'n/a',
          m.cmp.totalPixels ?? 'n/a',
          m.cmp.dimensionsMatch ?? 'n/a',
          m.cmp.verdict || m.cmp.status || 'n/a',
        ]),
      ),
    );
  }
  lines.push('');
  lines.push(
    codeBlock([
      `authoritative pixel inputs : ${withPair.length}/${ctx.viewportModels.length} viewports (atomic compare pair)`,
      `independent continuity     : ${withStandalone.length}/${ctx.viewportModels.length} viewports (standalone full-page captures, never authoritative)`,
      `placeholder numerics       : ${ctx.viewportModels.filter((m) => m.cmp.real && (m.cmp.dimensionsMatch === false)).length} viewport(s) — excluded from pixel verdicts`,
    ]),
  );
  const drift = ctx.viewportModels.filter((m) => m.drift.present);
  if (drift.length) {
    lines.push('');
    lines.push('Reference self-drift diagnostic (never subtracted from candidate mismatch, never used to relax the 2% target):');
    lines.push('');
    lines.push(
      mdTable(
        ['Viewport', 'Self-drift', 'dimensionsMatch', 'mask ratio', 'capture state', 'identity'],
        drift.map((m) => [
          `${m.width}×${m.height}`,
          pct(m.drift.mismatchPercentage),
          m.drift.dimensionsMatch ?? 'n/a',
          isNum(m.drift.maskedAreaRatio) ? pct(m.drift.maskedAreaRatio * 100) : 'n/a',
          m.drift.captureStateCompatible ?? 'n/a',
          m.drift.identityCoherent ?? 'n/a',
        ]),
      ),
    );
  }
  const sectional = ctx.viewportModels.flatMap((m) => m.cmp.sections.map((s) => ({ m, s })));
  if (sectional.length) {
    lines.push('');
    lines.push('Sectional clip diagnostics (non-authoritative, never substituted for the global result):');
    lines.push('');
    lines.push(
      mdTable(
        ['Viewport', 'Region', 'Mismatch', 'Status'],
        sectional.map(({ m, s }) => [
          `${m.width}×${m.height}`,
          s.name || 'n/a',
          isNum(num(s.mismatchPercentage)) ? pct(s.mismatchPercentage) : 'n/a',
          s.status || (isNum(num(s.mismatchPercentage)) ? 'measured' : 'n/a'),
        ]),
      ),
    );
  }
  return lines.join('\n');
}

function renderMaskAudit(ctx) {
  const rows = ctx.viewportModels.map((m) => [
    `${m.width}×${m.height}`,
    m.mask.present ? m.mask.status || 'recorded' : 'NOT RECORDED',
    m.mask.requested.length,
    m.mask.unresolved.length,
    isNum(m.mask.ratio) ? pct(m.mask.ratio * 100) : 'n/a',
    m.mask.useDefaultWidgetMasks === null ? 'NOT RECORDED' : String(m.mask.useDefaultWidgetMasks),
  ]);
  return [
    '## 10. Mask Audit',
    '',
    mdTable(['Viewport', 'Mask ledger', 'Requested', 'Unresolved', 'Masked area', 'useDefaultWidgetMasks'], rows),
    '',
    codeBlock([
      `masked-area budget            ${MASK_AREA_LIMIT_RATIO * 100}%`,
      'final compare policy          useDefaultWidgetMasks=false, zero user masks',
      'structural regions masked     NONE — header/nav/hero/grid/article/footer geometry stays unmasked and measurable',
    ]),
  ].join('\n');
}

function renderRemoteDependencyAudit(ctx) {
  const t = obj(ctx.telemetry);
  const bundle = obj(t.bundle);
  const rows = ctx.viewportModels.map((m) => [
    `${m.width}×${m.height}`,
    m.runtime.present ? (m.runtime.referenceOrigin ?? 'n/a') : 'NOT RECORDED',
    m.runtime.present ? (m.runtime.remote ?? 'n/a') : 'NOT RECORDED',
    m.runtime.present ? (m.runtime.resourceEntries ?? 'n/a') : 'NOT RECORDED',
    m.runtime.present ? (m.runtime.imagesLoaded ?? 'n/a') : 'NOT RECORDED',
  ]);
  return [
    '## 11. Remote Dependency Audit',
    '',
    codeBlock([
      `remote subresources in generated HTML  ${Array.isArray(bundle.remoteSubresources) ? bundle.remoteSubresources.length : 'n/a'}`,
      `remote navigation links (allowed)      ${bundle.remoteNavigationCount ?? 'n/a'}`,
      `local assets                           ${bundle.assetFiles ?? 'n/a'}`,
    ]),
    '',
    mdTable(['Viewport', 'Reference-origin visual requests', 'Remote resource requests', 'Resource entries', 'Images loaded'], rows),
    '',
    'Navigation links to the reference origin are allowed; reference-origin visual requests from the clone runtime are not.',
  ].join('\n');
}

function renderRunComparison(ctx) {
  const h = ctx.historical;
  const r1 = historicalMetrics(h.run1);
  const r2 = historicalMetrics(h.run2);
  const change = (a, b) => {
    if (!isNum(a) || !isNum(b)) return 'n/a';
    const d = b - a;
    return `${d > 0 ? '+' : ''}${d}`;
  };
  const historicalRows = [
    ['Blueprints', r1.blueprints ?? 'n/a', r2.blueprints ?? 'n/a', change(r1.blueprints, r2.blueprints)],
    ['Generated HTML bytes', r1.entryBytes ?? 'n/a', r2.entryBytes ?? 'n/a', change(r1.entryBytes, r2.entryBytes)],
    ['Localized assets', r1.localizedAssets ?? 'n/a', r2.localizedAssets ?? 'n/a', change(r1.localizedAssets, r2.localizedAssets)],
    ['docHeight @1440', r1.docHeight['1440x900'] ?? 'not measured', r2.docHeight['1440x900'] ?? 'not measured', change(r1.docHeight['1440x900'], r2.docHeight['1440x900'])],
    ['docHeight @1024', r1.docHeight['1024x900'] ?? 'not measured', r2.docHeight['1024x900'] ?? 'not measured', change(r1.docHeight['1024x900'], r2.docHeight['1024x900'])],
    ['docHeight @390', r1.docHeight['390x844'] ?? 'not measured', r2.docHeight['390x844'] ?? 'not measured', change(r1.docHeight['390x844'], r2.docHeight['390x844'])],
    ['Compare mismatch @1440', isNum(r1.compareMismatch) ? `${pct(r1.compareMismatch)}${r1.compareDimensionsMatch === false ? ' (placeholder, dimensions mismatch)' : ''}` : 'n/a', isNum(r2.compareMismatch) ? pct(r2.compareMismatch) : 'not produced', 'n/a'],
    ['Compare verdict @1440', r1.compareVerdict || 'n/a', r2.compareVerdict || 'not produced', 'n/a'],
    ['Reference self-drift', isNum(r1.driftMismatch) ? pct(r1.driftMismatch) : 'n/a', isNum(r2.driftMismatch) ? pct(r2.driftMismatch) : 'not measured', 'n/a'],
    ['Remote subresources', r1.remoteSubresources ?? 'n/a', r2.remoteSubresources ?? 'n/a', '0'],
    ['A0 images / fonts', `${r1.a0Images ?? 'n/a'} / ${r1.a0Fonts ?? 'n/a'}`, `${r2.a0Images ?? 'n/a'} / ${r2.a0Fonts ?? 'n/a'}`, 'n/a'],
  ];

  const targetIsRun2 = ctx.runBasename === 'run2';
  const targetRows = [];
  const targetMetrics = {
    blueprints: Array.isArray(obj(ctx.telemetry).blueprints) ? obj(ctx.telemetry).blueprints.length : null,
    entryBytes: num(obj(ctx.telemetry).bundle?.entryBytes),
    localizedAssets: arr(obj(ctx.telemetry).assetIntegrity).length || null,
    docHeight: {},
    compareMismatch: null,
    compareVerdict: null,
    remoteSubresources: Array.isArray(obj(ctx.telemetry).bundle?.remoteSubresources) ? obj(ctx.telemetry).bundle.remoteSubresources.length : null,
    a0Images: num(obj(ctx.telemetry).a0?.images),
    a0Fonts: num(obj(ctx.telemetry).a0?.fonts),
  };
  for (const m of ctx.viewportModels) targetMetrics.docHeight[`${m.width}x${m.height}`] = m.docHeight.clone;
  const withPair = ctx.viewportModels.find((m) => m.pair.present);
  if (withPair) {
    targetMetrics.compareMismatch = withPair.cmp.mismatchPercentage;
    targetMetrics.compareVerdict = withPair.cmp.verdict;
  }
  targetRows.push(['Blueprints', r2.blueprints ?? 'n/a', targetMetrics.blueprints ?? 'n/a', change(r2.blueprints, targetMetrics.blueprints)]);
  targetRows.push(['Generated HTML bytes', r2.entryBytes ?? 'n/a', targetMetrics.entryBytes ?? 'n/a', change(r2.entryBytes, targetMetrics.entryBytes)]);
  targetRows.push(['Localized assets', r2.localizedAssets ?? 'n/a', targetMetrics.localizedAssets ?? 'n/a', change(r2.localizedAssets, targetMetrics.localizedAssets)]);
  for (const key of ['1440x900', '1024x900', '390x844']) {
    targetRows.push([`docHeight @${key.split('x')[0]}`, r2.docHeight[key] ?? 'not measured', targetMetrics.docHeight[key] ?? 'not measured', change(r2.docHeight[key], targetMetrics.docHeight[key])]);
  }
  targetRows.push([
    'Authoritative pair',
    'not produced',
    `${ctx.viewportModels.filter((m) => m.pair.present).length}/${ctx.viewportModels.length} viewports`,
    'n/a',
  ]);
  targetRows.push(['Compare mismatch', isNum(r2.compareMismatch) ? pct(r2.compareMismatch) : 'not produced', isNum(targetMetrics.compareMismatch) ? pct(targetMetrics.compareMismatch) : 'not produced', 'n/a']);
  targetRows.push(['Remote subresources', r2.remoteSubresources ?? 'n/a', targetMetrics.remoteSubresources ?? 'n/a', '0']);

  return [
    '## 12. Run #1 vs Run #2',
    '',
    '### Historical comparison — Run #1 vs Run #2 (immutable prior evidence)',
    '',
    mdTable(['Metric', 'Run #1', 'Run #2', 'Change'], historicalRows),
    '',
    `Run #1 evidence: ${h.run1.present ? h.run1.evidence.length : 0} documents. Run #2 evidence: ${h.run2.present ? h.run2.evidence.length : 0} documents. ` +
      'Prior raw evidence is never rewritten by this generator.',
    '',
    targetIsRun2
      ? '### Recovery comparison — no recovery run\n\nThe target of this report is Run #2 itself; no recovery-run (Run #3) evidence exists yet, so no recovery-vs-Run-#2 comparison is possible from persisted evidence.'
      : `### Recovery comparison — Run #3 (recovery, this report) vs Run #2\n\n${mdTable(['Metric', 'Run #2 (baseline)', 'Recovery run', 'Change'], targetRows)}`,
  ].join('\n');
}

function renderRemainingFailures(ctx) {
  const lines = ['## 13. Remaining Failures', ''];
  const entries = [];
  for (const m of ctx.viewportModels) {
    for (const c of m.gate.failures) entries.push({ viewport: `${m.width}×${m.height}`, kind: 'FAIL', ...c });
    for (const c of m.gate.blockers) entries.push({ viewport: `${m.width}×${m.height}`, kind: 'INCONCLUSIVE BLOCKER', ...c });
  }
  if (entries.length === 0) {
    lines.push('No confirmed remaining failures were derived from persisted evidence.');
    return lines.join('\n');
  }
  entries.forEach((e, i) => {
    const f = e.finding;
    lines.push(`### F${i + 1} — ${e.code} [${e.kind}] @ ${e.viewport} — ${f.category}`);
    lines.push('');
    lines.push(
      codeBlock(
        REQUIRED_FINDING_KEYS.map((k) => `${k.padEnd(13)}${k === 'EVIDENCE' ? f.EVIDENCE.join('; ') : f[k]}`),
      ),
    );
    lines.push('');
  });
  lines.push(
    'Speculative failures are excluded by construction: every entry above is derived from a typed check in §14 ' +
      'and is backed by the cited persisted evidence.',
  );
  return lines.join('\n');
}

function renderFinalGate(ctx) {
  const lines = ['## 14. Final Fidelity Gate', ''];
  lines.push(codeBlock([`FINAL VERDICT: ${ctx.verdict}`]));
  lines.push('');
  lines.push(
    mdTable(
      ['Viewport', 'Gate', 'Deterministic failures', 'Inconclusive blockers'],
      ctx.viewportModels.map((m) => [
        `${m.width}×${m.height}`,
        m.gate.status,
        m.gate.failures.length
          ? m.gate.failures.map((c) => c.code).join(', ')
          : m.gate.notAdjudicated.length
            ? `none (not adjudicated: ${m.gate.notAdjudicated.join(', ')})`
            : 'none',
        m.gate.blockers.length
          ? m.gate.blockers.map((c) => `${c.code}${c.hard ? '' : ' [pass-blocking]'}`).join(', ')
          : 'none',
      ]),
    ),
  );
  lines.push('');
  lines.push('Policy applied, in order:');
  lines.push('');
  lines.push(
    codeBlock([
      '1. Evidence availability and typed status are evaluated first.',
      '2. Missing authoritative atomic pair, failed settlement, stale identity, quarantine',
      '   without recovery, or an inconclusive/failed compare fixes that viewport to INCONCLUSIVE.',
      '   Placeholder numerics (e.g. mismatchPercentage 100 from a dimensions short-circuit)',
      '   never override that precedence into FAIL.',
      '3. PASS requires every exact viewport to have: complete settlement + coherent target',
      '   identity; valid full-page lineage for the atomic pair (complete PNG, compatible',
      '   geometry); authoritative pixel mismatch <= 2%; no cardinality/grid/navigation/hero/',
      '   section-order/responsive structural failure; acceptable page/section heights and',
      '   major geometry; zero reference-origin visual requests; zero broken rendered assets;',
      '   no unresolved localization failure; no broad or implicit masking with a recorded',
      '   mask ratio; no candidate-worse horizontal overflow.',
      '4. FAIL only on complete deterministic evidence proving mismatch beyond policy.',
      '5. Aggregation: a deterministic FAIL at any required viewport dominates when no hard',
      '   blocker exists for that viewport; otherwise any INCONCLUSIVE viewport makes the gate',
      '   INCONCLUSIVE; otherwise PASS.',
      '6. Soft evidence gaps (reference drift, runtime audit, standalone continuity) block PASS',
      '   but never mask a proven deterministic FAIL; observed deltas under a hard blocker are',
      '   reported as not adjudicated rather than as proven failures.',
    ]),
  );
  lines.push('');
  const hardBlocked = ctx.viewportModels.filter((m) => m.gate.hardBlockers.length > 0);
  const softBlocked = ctx.viewportModels.filter((m) => m.gate.status === 'INCONCLUSIVE' && m.gate.hardBlockers.length === 0);
  if (hardBlocked.length) {
    lines.push(
      `Rationale: ${hardBlocked.length}/${ctx.viewportModels.length} viewport(s) are undecidable from persisted evidence ` +
        `(${hardBlocked.map((m) => `${m.width}×${m.height}: ${m.gate.hardBlockers.map((c) => c.code).join('+')}`).join('; ')}).`,
    );
  } else if (softBlocked.length) {
    lines.push(
      `Rationale: no viewport proves a deterministic failure, but PASS requires evidence that is missing at ` +
        `${softBlocked.map((m) => `${m.width}×${m.height}: ${m.gate.softBlockers.map((c) => c.code).join('+')}`).join('; ')}.`,
    );
  } else if (ctx.verdict === 'PASS') {
    lines.push('Rationale: every required viewport satisfies the full PASS list above with complete deterministic evidence.');
  } else {
    lines.push('Rationale: deterministic evidence proves mismatch beyond policy at one or more required viewports.');
  }
  return lines.join('\n');
}

function renderProofBoundaries(ctx) {
  const lines = ['## 15. What Is Actually Proven', ''];
  const verificationDocs = ctx.files.filter((d) => d.kind === 'verification');
  const unitProof = verificationDocs.length
    ? verificationDocs
        .map((d) => {
          const j = d.json;
          const t = firstDef(num(j.tests), num(j.total));
          const p = firstDef(num(j.pass), num(j.passed));
          const f = firstDef(num(j.fail), num(j.failed));
          return `${d.rel}: tests=${t ?? 'n/a'} pass=${p ?? 'n/a'} fail=${f ?? 'n/a'}`;
        })
        .join('\n')
    : 'NOT EVIDENCED IN THIS RUN — no persisted unit-test receipt under evidence/.';

  const runtimeLines = ctx.viewportModels.map(
    (m) =>
      `${m.width}×${m.height}: reference ${m.refSettle.complete ? 'settled' : 'NOT settled'} / clone ${m.cloneSettle.complete ? 'settled' : 'NOT settled'}` +
      `; rendered ${m.cloneSettle.imageCount ?? '?'} images, ${m.cloneSettle.brokenImages.length} broken, ${m.cloneSettle.pendingImages ?? '?'} pending`,
  );

  const pairModels = ctx.viewportModels.filter((m) => m.pair.present);
  const visualProof = pairModels.length
    ? pairModels
        .map((m) => {
          if (
            m.cmp.status === 'INCONCLUSIVE' ||
            m.cmp.verdict === 'INCONCLUSIVE' ||
            m.cmp.dimensionsMatch === false ||
            m.cmp.captureStateCompatible === false
          ) {
            return (
              `${m.width}×${m.height}: INCONCLUSIVE (unmeasured: ${m.cmp.reason || 'capture size mismatch'}` +
              ' — no pixel measurement produced; placeholder numeric excluded)'
            );
          }
          return `${m.width}×${m.height}: ${pct(m.cmp.mismatchPercentage)} mismatch over the authoritative atomic pair`;
        })
        .join('\n')
    : 'NONE — no authoritative atomic pair exists; standalone captures are independent continuity evidence only and were not promoted.';

  const structuralLines = ctx.viewportModels.map(
    (m) =>
      `${m.width}×${m.height}: ${m.structuralSections.length} matched sections, docHeight ${m.refMetrics.docHeight ?? '?'}→${m.cloneMetrics.docHeight ?? '?'}, ` +
      `cards ${m.refMetrics.productCardCount ?? '?'}→${m.cloneMetrics.productCardCount ?? '?'}, grids ${m.refMetrics.firstGrid?.columns ?? '?'}×${m.refMetrics.firstGrid?.rows ?? '?'}→${m.cloneMetrics.firstGrid?.columns ?? '?'}×${m.cloneMetrics.firstGrid?.rows ?? '?'}`,
  );

  const t = obj(ctx.telemetry);
  const integrity = arr(t.assetIntegrity);
  const assetProof = integrity.length
    ? `${integrity.length} localized assets, every one resolved and sha256-verified during generation; ` +
      `remote subresources in HTML ${Array.isArray(obj(t.bundle).remoteSubresources) ? obj(t.bundle).remoteSubresources.length : 'n/a'}`
    : 'NOT EVIDENCED IN THIS RUN.';

  lines.push(
    codeBlock([
      'UNIT-TEST PROOF',
      ...unitProof.split('\n').map((l) => `  ${l}`),
      '',
      'LIVE RUNTIME PROOF',
      ...runtimeLines.map((l) => `  ${l}`),
      '',
      'VISUAL PROOF',
      ...visualProof.split('\n').map((l) => `  ${l}`),
      '',
      'STRUCTURAL PROOF',
      ...structuralLines.map((l) => `  ${l}`),
      '',
      'ASSET PROOF',
      `  ${assetProof}`,
    ]),
  );
  lines.push('');
  lines.push(
    '`IMPLEMENTATION EXISTS`, `UNIT TESTS PASS`, and `LIVE CHROMIUM TEST PASS` are different claims. ' +
      'Only exercised live evidence can support the last claim; a missing unit-test receipt is reported as not evidenced rather than assumed.',
  );
  return lines.join('\n');
}

function renderNextAction(ctx) {
  const actions = [];
  const codes = new Set();
  for (const m of ctx.viewportModels) {
    for (const c of [...m.gate.failures, ...m.gate.blockers]) codes.add(c.code);
  }
  const allPairsPresent = ctx.viewportModels.every((m) => m.pair.present);
  if (codes.has('MISSING_AUTHORITATIVE_PAIR') || (!allPairsPresent && (codes.has('COMPARE_NOT_RUN') || codes.has('PAIR_ARTIFACTS_UNVERIFIED')))) {
    actions.push(
      'Complete the bounded compare transaction so one authoritative atomic pair exists per viewport. Do not promote standalone captures; they remain independent continuity evidence.',
    );
  } else if (codes.has('COMPARE_STATUS_NOT_RESULT') || codes.has('CAPTURE_STATE_INCOMPATIBLE')) {
    for (const m of ctx.viewportModels) {
      const hasMismatch = m.gate.blockers.some((b) => b.code === 'COMPARE_STATUS_NOT_RESULT' || b.code === 'CAPTURE_STATE_INCOMPATIBLE');
      if (!hasMismatch) continue;

      const refReceipt = m.pair?.refReceipt;
      const cloneReceipt = m.pair?.cloneReceipt;
      const refVp = obj(refReceipt?.cssViewport);
      const cloneVp = obj(cloneReceipt?.cssViewport);
      const refCap = obj(refReceipt?.cssCaptureSize);
      const cloneCap = obj(cloneReceipt?.cssCaptureSize);

      const refVpStr = isNum(num(refVp.width)) && isNum(num(refVp.height)) ? `${refVp.width}×${refVp.height}` : null;
      const cloneVpStr = isNum(num(cloneVp.width)) && isNum(num(cloneVp.height)) ? `${cloneVp.width}×${cloneVp.height}` : null;
      const vpMismatch = refVpStr && cloneVpStr && (Math.abs(num(refVp.width) - num(cloneVp.width)) > 1 || Math.abs(num(refVp.height) - num(cloneVp.height)) > 1);

      const refCapStr = isNum(num(refCap.width)) && isNum(num(refCap.height)) ? `${refCap.width}×${refCap.height}` : null;
      const cloneCapStr = isNum(num(cloneCap.width)) && isNum(num(cloneCap.height)) ? `${cloneCap.width}×${cloneCap.height}` : null;
      const capMismatch = refCapStr && cloneCapStr && (Math.abs(num(refCap.width) - num(cloneCap.width)) > 1 || Math.abs(num(refCap.height) - num(cloneCap.height)) > 1);

      const deltaHeight = isNum(m.docHeight?.delta) ? Math.abs(m.docHeight.delta) : null;
      const heightNote = deltaHeight !== null ? ` (${deltaHeight} px height delta)` : '';

      const overflow = m.cloneMetrics?.overflowX ?? 0;
      const overflowNote = overflow > 0 ? `, eliminate the ${overflow} px horizontal root overflow on the clone` : '';

      if (vpMismatch) {
        actions.push(
          `For ${m.width}×${m.height} (${m.label}): authoritative atomic pair was captured with incompatible viewport geometry (reference CSS viewport: ${refVpStr} vs clone: ${cloneVpStr}${capMismatch ? `, capture size: ${refCapStr} vs ${cloneCapStr}` : ''}${heightNote}). ` +
            `Resolve viewport / device emulation geometry${overflowNote}, recapture both sides under identical CSS viewport and capture mode, and rerun pixel comparison.`,
        );
      } else if (capMismatch) {
        actions.push(
          `For ${m.width}×${m.height} (${m.label}): authoritative atomic pair was captured with capture-height delta (reference capture: ${refCapStr} vs clone: ${cloneCapStr}${heightNote}). ` +
            `Identify and eliminate full-page capture-height / layout delta${overflowNote}, recapture both sides under identical geometry, and rerun pixel comparison.`,
        );
      } else {
        actions.push(
          `For ${m.width}×${m.height} (${m.label}): authoritative atomic pair was captured but comparison produced an INCONCLUSIVE verdict${heightNote}. ` +
            `Identify and eliminate full-page capture-height / layout delta${overflowNote}, recapture both sides under identical geometry, and rerun pixel comparison.`,
        );
      }
    }
  }
  if (codes.has('TARGET_STALE') || codes.has('QUARANTINE_WITHOUT_RECOVERY') || codes.has('EXCESSIVE_REFERENCE_DRIFT') || codes.has('REFERENCE_DRIFT_INCOHERENT') || codes.has('REFERENCE_DRIFT_MISSING')) {
    actions.push(
      'Recover and re-verify the bound target (typed drain/reset receipt) and re-capture under identical CSS viewport, DPR, zoom and capture mode before re-running the compare.',
    );
  }
  const structural = ctx.viewportModels.flatMap((m) => m.gate.failures).filter((c) => /HEIGHT|CARDINALITY|GRID|NAVIGATION|ORDER|TYPOGRAPHY|OVERFLOW|HERO|RESPONSIVE/.test(c.code));
  if (structural.length) {
    actions.push(
      `Root-cause the deterministic structural failures first (${[...new Set(structural.map((c) => c.code))].join(', ')}); they are proven from unmasked live geometry, not from pixel noise.`,
    );
  }
  const notAdjudicated = [...new Set(ctx.viewportModels.flatMap((m) => m.gate.notAdjudicated))];
  if (notAdjudicated.length) {
    actions.push(
      `Observed deltas (${notAdjudicated.join(', ')}) are not adjudicated because the viewport evidence is incomplete; ` +
        're-measure them under complete evidence before treating any as a clone defect.',
    );
  }
  if (codes.has('BROKEN_RENDERED_ASSETS') || codes.has('CARDINALITY_imageCount') || codes.has('ASSET_RENDER_MISMATCH')) {
    actions.push('Fix the localized asset render failures; re-verify every referenced asset hash after the fix.');
  }
  if (codes.has('REFERENCE_ORIGIN_REQUESTS') || codes.has('RUNTIME_AUDIT_MISSING')) {
    actions.push('Remove remaining reference-origin visual requests and re-run the runtime resource audit.');
  }
  if (codes.has('MASK_LEDGER_MISSING') || codes.has('IMPLICIT_MASK_STATE_UNRECORDED') || codes.has('IMPLICIT_DEFAULT_MASKS') || codes.has('USER_MASKS_REQUESTED') || codes.has('MASKING_TOO_BROAD')) {
    actions.push('Re-run the final compare with `useDefaultWidgetMasks: false` and zero user masks, and persist the full mask ledger with its ratio.');
  }
  if (actions.length === 0) {
    actions.push(
      'No corrective action is demonstrated by persisted evidence. Freeze this evidence set, archive the report, and re-run only if the reference or the pipeline changes.',
    );
  }
  return ['## 16. Next Action', '', ...actions.map((a, i) => `${i + 1}. ${a}`)].join('\n');
}

function renderReport(ctx) {
  const sections = [
    renderEnvironment(ctx),
    renderPipeline(ctx),
    renderReferenceCapture(ctx),
    renderAssetDiscovery(ctx),
    renderAssetLocalization(ctx),
    renderIndependentHtml(ctx),
    renderLiveChromium(ctx),
    renderStructuralFindings(ctx),
    renderVisualFindings(ctx),
    renderMaskAudit(ctx),
    renderRemoteDependencyAudit(ctx),
    renderRunComparison(ctx),
    renderRemainingFailures(ctx),
    renderFinalGate(ctx),
    renderProofBoundaries(ctx),
    renderNextAction(ctx),
  ];
  if (sections.length !== REQUIRED_SECTIONS.length) {
    throw new GenerationError(`internal error: rendered ${sections.length} sections, expected ${REQUIRED_SECTIONS.length}`);
  }
  sections.forEach((text, i) => {
    const expected = `## ${i + 1}. ${REQUIRED_SECTIONS[i]}`;
    if (!text.startsWith(expected)) {
      throw new GenerationError(`internal error: section ${i + 1} must start with "${expected}"`);
    }
  });
  const text = `${['# AntiFan Real Independent HTML Fidelity Canary — Recovery Report', '', ...sections].join('\n\n')}\n`;
  for (const m of ctx.viewportModels) {
    if (m.standalone.present && text.includes(`No standalone full-page capture lineage was persisted for ${m.width}×${m.height}`)) {
      throw new GenerationError(`contradiction in report: standalone captures present for ${m.width}×${m.height} but reported missing`);
    }
    if (m.drift.present && text.includes(`No reference self-drift pair was persisted for ${m.width}×${m.height}`)) {
      throw new GenerationError(`contradiction in report: self-drift present for ${m.width}×${m.height} but reported missing`);
    }
    if (m.runtime.present && text.includes(`No runtime asset/dependency audit was persisted for ${m.width}×${m.height}`)) {
      throw new GenerationError(`contradiction in report: runtime audit present for ${m.width}×${m.height} but reported missing`);
    }
  }
  if (text.includes('100.00% mismatch over the authoritative atomic pair') && text.includes('FINAL VERDICT: INCONCLUSIVE')) {
    throw new GenerationError('contradiction in report: placeholder 100% mismatch rendered as visual proof in inconclusive report');
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function resolveEvidenceRunId(files) {
  const candidates = new Set();
  for (const doc of files) {
    const json = doc.json;
    if (isStr(json?.runId)) candidates.add(json.runId);
    if (isStr(json?.session?.runId)) candidates.add(json.session.runId);
    if (isStr(json?.lease?.runId)) candidates.add(json.lease.runId);
    if (isStr(json?.artifactPreflight?.runId)) candidates.add(json.artifactPreflight.runId);
  }
  if (candidates.size === 0) {
    throw new GenerationError('no runId recorded across evidence files (runId must be present and unambiguous)');
  }
  if (candidates.size > 1) {
    throw new GenerationError(`conflicting run IDs found across evidence: ${Array.from(candidates).join(', ')}`);
  }
  return Array.from(candidates)[0];
}

function latestEvidenceTimestamp(files) {
  const stamps = [];
  for (const d of files) {
    for (const key of ['finishedAt', 'startedAt', 'generatedAt', 'timestamp']) {
      const v = d.json?.[key];
      if (isStr(v)) stamps.push(v);
    }
    const ts = num(d.json?.stages?.compare?.elapsedMs);
    void ts;
  }
  stamps.sort();
  return stamps.length ? stamps[stamps.length - 1] : null;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  try {
    const runBasename = path.basename(opts.runDir);
    if ((runBasename === 'run1' || runBasename === 'run2') && !process.argv.includes('--out') && !process.argv.includes('-o')) {
      throw new GenerationError(
        `refusing to write into immutable historical run ${relToRepo(opts.runDir)}: pass --out <file> explicitly`,
      );
    }

    const loaded = loadEvidence(opts.runDir, opts);
    const page = loaded.page;
    const telemetry = obj(loaded.telemetryDoc?.json);
    const derived = telemetryDerivedPaths(telemetry, page);
    const evidenceRunId = resolveEvidenceRunId(loaded.files);
    const publishedRun = resolvePublishedRun(page, evidenceRunId);
    const artifactIndex = new ArtifactIndex({
      // Relative references resolve inside the page's published artifact set, not
      // beside the page: a pointer page keeps its bundles in an attempt directory.
      refRootDir: page.artifactRootDir,
      evidenceDir: loaded.evidenceDir,
      cloneDir: derived.cloneDir,
      assetsDir: derived.assetsDir,
      artifactRoots: artifactRoots(opts.artifactRoot),
      runId: evidenceRunId,
      label: null,
    });

    // Fail closed: verify every referenced artifact in target-run evidence before building any verdict.
    for (const doc of loaded.files) {
      artifactIndex.ctx.label = doc.kind === 'viewport' ? (isStr(doc.json.label) ? doc.json.label : null) : null;
      // Asset references resolve against the bundle the document itself belongs to:
      // a viewport names the bundle it was served from, a telemetry document names the
      // bundle it generated. Resolving everything against one run-level bundle made a
      // desktop telemetry document fail against the mobile bundle and vice versa. On a
      // page that publishes an attempt, the declared bundle must be part of that attempt.
      const docCloneDir = assertPublishedBundle(docBundleDir(doc.json), page, doc.docId);
      artifactIndex.ctx.cloneDir = docCloneDir || derived.cloneDir;
      artifactIndex.ctx.assetsDir = artifactIndex.ctx.cloneDir ? path.join(artifactIndex.ctx.cloneDir, 'assets') : derived.assetsDir;
      artifactIndex.collect(doc.docId, doc.json);
      verifyReceiptConsistency(doc.docId, doc.json);
    }
    if (isStr(telemetry.bundle?.entryHtmlPath) && isStr(telemetry.bundle?.entrySha256)) {
      const entry = telemetry.bundle.entryHtmlPath;
      if (!fs.existsSync(entry)) {
        throw new GenerationError(`referenced bundle entry missing: ${relToRepo(entry)}`);
      }
      const actual = sha256File(entry);
      if (actual !== telemetry.bundle.entrySha256) {
        throw new GenerationError(
          `referenced bundle entry sha256 mismatch: ${relToRepo(entry)} is ${actual}, telemetry declares ${telemetry.bundle.entrySha256}`,
        );
      }
    }
    for (const file of arr(telemetry.generation?.result?.filesWritten)) {
      if (isStr(file) && !fs.existsSync(file)) {
        throw new GenerationError(`referenced generated file missing: ${relToRepo(file)}`);
      }
    }

    const viewportModels = [];
    for (const spec of REQUIRED_VIEWPORTS) {
      const key = viewportKey(spec.width, spec.height);
      const doc = loaded.viewportDocs.get(key) || null;
      const placeholder = {
        doc: { rel: `(missing ${key})`, docId: `(missing ${key})`, json: {} },
        spec,
        label: key,
        width: spec.width,
        height: spec.height,
        readiness: {},
        refSettle: settleFacts(null),
        cloneSettle: settleFacts(null),
        refMetrics: metricsFacts(null),
        cloneMetrics: metricsFacts(null),
        cmp: compareFacts({}),
        pair: pairFacts({}, compareFacts({})),
        standalone: standaloneFacts({}),
        mask: maskFacts({}, compareFacts({}), pairFacts({}, compareFacts({}))),
        structural: null,
        structuralSections: [],
        drift: driftFacts(null),
        runtime: runtimeAuditFacts({}, telemetry),
        telemetry,
        docHeight: { reference: null, clone: null, delta: null, ratio: null, source: 'none' },
        visual: {},
        artifactIndex,
        present: false,
      };
      const model = doc ? buildViewportModel(doc, spec, { files: loaded.files, telemetry, runBasename }) : placeholder;
      model.artifactIndex = artifactIndex;
      model.present = Boolean(doc);
      model.gate = evaluateGate(model);
      viewportModels.push(model);
    }

    const ctx = {
      runDir: loaded.runDir,
      runBasename: loaded.runBasename,
      evidenceDir: loaded.evidenceDir,
      page,
      publishedRun,
      files: loaded.files,
      telemetry,
      viewportModels,
      historical: loadHistorical(),
      generatedAt: opts.now || latestEvidenceTimestamp(loaded.files),
      artifactIndex,
    };
    ctx.verdict = viewportModels.some((m) => m.gate.status === 'FAIL')
      ? 'FAIL'
      : viewportModels.some((m) => m.gate.status === 'INCONCLUSIVE')
        ? 'INCONCLUSIVE'
        : 'PASS';

    const report = renderReport(ctx);
    const headingCount = (report.match(/^## /gm) || []).length;
    if (headingCount !== REQUIRED_SECTIONS.length) {
      throw new GenerationError(`internal error: report contains ${headingCount} section headings`);
    }
    if (!report.includes(`FINAL VERDICT: ${ctx.verdict}`)) {
      throw new GenerationError('internal error: verdict line missing from report');
    }

    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, report);

    process.stdout.write(
      [
        `run:        ${relToRepo(ctx.runDir)}`,
        `attempt:    ${ctx.page.attemptId || 'none (no attempt pointer)'}`,
        `provenance: ${ctx.page.provenance}${ctx.publishedRun.published ? `, run ${ctx.publishedRun.runId}` : ''}`,
        `evidence:   ${ctx.files.length} documents`,
        `viewports:  ${viewportModels.map((m) => `${m.width}×${m.height}=${m.gate.status}`).join(' ')}`,
        `verdict:    ${ctx.verdict}`,
        `written:    ${relToRepo(opts.out)}`,
      ].join('\n') + '\n',
    );
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            runDir: relToRepo(ctx.runDir),
            out: relToRepo(opts.out),
            attemptId: ctx.page.attemptId,
            provenance: ctx.page.provenance,
            provenanceReason: ctx.page.provenanceReason,
            runId: ctx.publishedRun.runId,
            runSource: ctx.publishedRun.source,
            verdict: ctx.verdict,
            viewports: viewportModels.map((m) => ({
              label: m.label,
              viewport: `${m.width}x${m.height}`,
              gate: m.gate.status,
              blockers: m.gate.blockers.map((c) => c.code),
              failures: m.gate.failures.map((c) => c.code),
            })),
            artifactsVerified: artifactIndex.verified.length,
          },
          null,
          2,
        )}\n`,
      );
    }
  } catch (e) {
    if (e instanceof GenerationError) {
      process.stderr.write(`report generation failed: ${e.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`report generation failed unexpectedly: ${e.stack || e.message}\n`);
    process.exit(1);
  }
}

main();
