/**
 * Replay precondition for the build-report regression tests.
 *
 * Those tests hand `scripts/lib/build-report.mjs` a persisted canary run and assert on the
 * report it generates. Generation is fail-closed: every artifact, clone bundle entry and
 * generated file an evidence document names must be resolvable on disk, and the builder
 * verifies the declared sha256/byteLength. The evidence JSON under
 * `test/fixtures/canary-run/evidence` is a *copy* of a real run, so its documents still name
 * the artifact bytes and the clone tree that run produced. Those bytes live in a
 * machine-local store (`ANTIFAN_DATA_ROOT`, default `E:\Work\.antifan-canary`) which rotates
 * its run directories, so the replay is only executable where the run it describes is still
 * intact.
 *
 * This module answers that question from disk. A caller skips with the returned reason when
 * the evidence is absent and otherwise runs unchanged: an absent environment is reported as
 * an absent environment instead of as a report defect, and a real regression still fails,
 * because the builder only reaches the assertions once every referenced byte exists.
 *
 * The check mirrors the builder's resolution order (see `artifactRoots()` in
 * scripts/lib/build-report.mjs): explicit/env root, repo-local data dir, parent data dir,
 * parent canary dir, and the `ANTIFAN_DATA_ROOT` recorded by the canary instance env.
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const FIXTURE_EVIDENCE_DIR = path.join(HERE, 'evidence');
export const CANARY_RUN_DIR = path.join(REPO_ROOT, '.canary', 'run3');

const ARTIFACT_ID_RE = /^artifact-[0-9a-f-]{36}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

function artifactRoots() {
  const roots = [];
  const push = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!roots.includes(abs) && fs.existsSync(abs)) roots.push(abs);
  };
  push(process.env.ANTIFAN_ARTIFACT_ROOT);
  push(path.join(REPO_ROOT, '.antifan-data', 'control-plane-v2', 'artifacts'));
  push(path.join(REPO_ROOT, '..', '.antifan-data', 'control-plane-v2', 'artifacts'));
  push(path.join(REPO_ROOT, '..', '.antifan-canary', 'control-plane-v2', 'artifacts'));
  try {
    const instanceEnv = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.canary', 'state', 'instance-env.json'), 'utf8'));
    const dataRoot = instanceEnv?.env?.ANTIFAN_DATA_ROOT;
    if (dataRoot) push(path.join(dataRoot, 'control-plane-v2', 'artifacts'));
  } catch {
    // No canary instance env on this machine: the root simply is not a candidate.
  }
  return roots;
}

/** File names directly under a root and one level into its run directories. */
function indexRoot(root) {
  const names = new Set();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    names.add(entry.name);
    if (!entry.isDirectory()) continue;
    try {
      for (const nested of fs.readdirSync(path.join(root, entry.name))) names.add(nested);
    } catch {
      // An unreadable run directory contributes nothing.
    }
  }
  return names;
}

function collectRefs(node, refs, out) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (ARTIFACT_ID_RE.test(node)) refs.set(node, refs.get(node) || { id: node, sha256: null, sites: [] });
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs, out);
    return;
  }
  if (typeof node !== 'object') return;
  const id = typeof node.id === 'string' && ARTIFACT_ID_RE.test(node.id)
    ? node.id
    : typeof node.artifactId === 'string' && ARTIFACT_ID_RE.test(node.artifactId)
      ? node.artifactId
      : null;
  if (id) {
    const ref = refs.get(id) || { id, sha256: null, sites: [] };
    if (typeof node.sha256 === 'string' && SHA256_RE.test(node.sha256)) ref.sha256 = node.sha256.toLowerCase();
    if (typeof node.byteLength === 'number') ref.byteLength = node.byteLength;
    if (out) ref.sites.push(out);
    refs.set(id, ref);
  }
  for (const key of Object.keys(node)) collectRefs(node[key], refs, out ? `${out}.${key}` : key);
}

/**
 * @param {{ evidenceDir?: string }} [opts]
 * @returns {{ available: boolean, reason: string|null, missing: string[], evidenceDir: string, checkedRefs: number, roots: string[] }}
 */
export function assessCanaryReplay(opts = {}) {
  const evidenceDir = path.resolve(opts.evidenceDir || FIXTURE_EVIDENCE_DIR);
  const missing = [];
  const roots = artifactRoots();

  if (!fs.existsSync(evidenceDir)) {
    return {
      available: false,
      reason: `canary replay needs the persisted evidence directory ${path.relative(REPO_ROOT, evidenceDir) || evidenceDir}, which is not present`,
      missing: [path.relative(REPO_ROOT, evidenceDir) || evidenceDir],
      evidenceDir,
      checkedRefs: 0,
      roots,
    };
  }

  const documents = [];
  for (const name of fs.readdirSync(evidenceDir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(evidenceDir, name);
    try {
      documents.push({ name, json: JSON.parse(fs.readFileSync(file, 'utf8')) });
    } catch (err) {
      missing.push(`${name} is not readable JSON (${err.message})`);
    }
  }
  if (documents.length === 0) {
    return {
      available: false,
      reason: `canary replay needs the persisted evidence documents in ${path.relative(REPO_ROOT, evidenceDir) || evidenceDir}, and none are present`,
      missing: [path.relative(REPO_ROOT, evidenceDir) || evidenceDir],
      evidenceDir,
      checkedRefs: 0,
      roots,
    };
  }

  const refs = new Map();
  for (const doc of documents) collectRefs(doc.json, refs, doc.name);

  const telemetry = documents.find((d) => d.name.startsWith('build-telemetry') && !d.name.includes('mobile')) || documents[0];
  const entryHtmlPath = telemetry?.json?.bundle?.entryHtmlPath;
  if (typeof entryHtmlPath === 'string' && entryHtmlPath && !fs.existsSync(entryHtmlPath)) {
    missing.push(`clone bundle entry ${entryHtmlPath}`);
  }
  for (const written of telemetry?.json?.generation?.result?.filesWritten || []) {
    if (typeof written === 'string' && written && !fs.existsSync(written)) {
      missing.push(`generated file ${written}`);
      if (missing.length > 12) break;
    }
  }

  const indexes = roots.map((root) => ({ root, names: indexRoot(root) }));
  for (const ref of refs.values()) {
    const found = indexes.some(({ names }) =>
      names.has(ref.id) ||
      names.has(`${ref.id}.png`) ||
      (ref.sha256 !== null && (names.has(ref.sha256) || names.has(`${ref.sha256}.artifact`))),
    );
    if (!found) {
      const sha = ref.sha256 ? ` sha256=${ref.sha256}` : '';
      const declared = typeof ref.byteLength === 'number' ? ` ${ref.byteLength}B` : '';
      missing.push(`artifact ${ref.id}${declared}${sha}`);
    }
  }

  if (missing.length > 0) {
    const rootsLabel = roots.length > 0 ? roots.map((r) => path.relative(REPO_ROOT, r) || r).join(', ') : 'no artifact store found';
    return {
      available: false,
      reason:
        `canary replay cannot run on this machine: ${missing.length} prerequisite(s) of the persisted run are absent ` +
        `(${missing.slice(0, 3).join('; ')}${missing.length > 3 ? `; +${missing.length - 3} more` : ''}). ` +
        `Searched artifact stores: ${rootsLabel}. Restore the run (or the artifact bytes) to execute this replay.`,
      missing,
      evidenceDir,
      checkedRefs: refs.size,
      roots,
    };
  }

  return { available: true, reason: null, missing: [], evidenceDir, checkedRefs: refs.size, roots };
}

/** Names the missing prerequisites, or null when the replay can run. */
export function canaryReplaySkipReason(opts = {}) {
  const assessment = assessCanaryReplay(opts);
  return assessment.available ? null : assessment.reason;
}
