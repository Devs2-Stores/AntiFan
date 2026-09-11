#!/usr/bin/env node
/**
 * theme-fidelity-run — the driver that runs the Haravan customize-workflow fidelity
 * pipeline in order, with the safety gates the plan requires.
 *
 *   node .canary/tools/theme-fidelity-run.mjs preflight  --out <dir> --theme <themeDir> --inventory <inventory.json>
 *   node .canary/tools/theme-fidelity-run.mjs references --out <dir> [--viewports 1440x900,1024x900,390x844]
 *   node .canary/tools/theme-fidelity-run.mjs serve      --out <dir> --theme <themeDir>
 *   node .canary/tools/theme-fidelity-run.mjs subject    --out <dir> [--viewports ...]
 *   node .canary/tools/theme-fidelity-run.mjs compare    --out <dir>
 *   node .canary/tools/theme-fidelity-run.mjs checks     --out <dir> --theme <themeDir>
 *   node .canary/tools/theme-fidelity-run.mjs report     --out <dir>
 *   node .canary/tools/theme-fidelity-run.mjs --help
 *
 * Exit codes: 0 the stage produced its artifact, 2 usage refusal, 3 the stage could not
 * produce its artifact, 4 a safety or provenance refusal.
 *
 * ── What this file is, and is not ────────────────────────────────────────────
 * It composes already-built capabilities and invents no measurement of its own:
 * `theme-fidelity.mjs capture|compare` renders and adjudicates, `theme-checks.mjs`
 * reads the theme source and the captured pages, and this driver derives the preview
 * URLs, supervises the one remote-writing process, keeps the command record and
 * assembles the report from persisted artifacts. A missing artifact is exit 3 — never
 * a PASS. Nothing here re-derives a verdict at report time, and nothing fills a gap
 * with a placeholder.
 *
 * ── Stage order and why it is the order ──────────────────────────────────────
 * `hrv theme dev` overwrites the theme copy with the local source, so the two
 * read-only references are pinned BEFORE the serve stage starts:
 *   preflight -> references (r1 = deployed copy, r2 = live production) -> serve
 *   -> subject -> compare -> checks -> report
 * `subject` captures the copy preview after the dev session uploaded the local source,
 * and records whether the served copy actually changed: that difference is the proof
 * the dev target is the copy. `references` never replaces a pin it already holds — a
 * pin that cannot be reused verbatim is exit 4, because re-capturing it after the dev
 * write would silently destroy the reference the whole run is measured against.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 * Each stage is independently invocable and re-runnable:
 *   - `preflight`, `references` (fresh sides only), `subject`, `compare`, `checks`,
 *     `report` overwrite their own artifacts; `subject` and each `compare` set replace
 *     their artifact directory so a stale document from an earlier run cannot be read
 *     as this run's evidence;
 *   - `references` reuses a complete, identically labelled/labelled-viewport pin and
 *     refuses (exit 4) instead of re-capturing when the existing pin disagrees;
 *   - `serve` refuses (exit 3) when the recorded dev session for this --out is still
 *     alive, so two writers never target the copy at once;
 *   - every stage appends exactly one record line to <out>/commands.jsonl.
 *
 * ── Safety rule (binding) ────────────────────────────────────────────────────
 * The authorised theme copy is 1001512581; -1 is live production, read-only. No other
 * theme id may be addressed by anything this driver spawns or derives: preflight
 * refuses (exit 4) an inventory that already names another id, the derived URLs only
 * ever carry 1001512581 or -1, the `serve` stage refuses (exit 4) unless the theme
 * workspace settings declare the copy, and `report` audits commands.jsonl and reports
 * zero commands addressing anything else. The store's live theme 1001510509 is never
 * requested and never named in a URL. The only remote-writing command this driver can
 * spawn is `hrv theme dev` in the theme workspace, as a supervised child it also stops;
 * no publish/deploy/push command exists in the pipeline and `report` proves that
 * absence from the record.
 *
 * ── A composed tool's refusal is a stage artifact failure ────────────────────
 * When capture/compare/theme-checks exits non-zero, the driver's own exit is 3 (the
 * stage could not produce its artifact) and the child's exit code plus its typed
 * refusal text are carried verbatim into commands.jsonl and the report. The driver's
 * own safety gates (theme id, an unusable pin, a publish verb in the record) are the
 * only exit-4 refusals it raises itself.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { HASH_CONTRACT, writeRecordAtomic, sha256Text, textDigest } from '../../scripts/lib/atomic-record.mjs';
import {
  DEFAULT_VIEWPORTS,
  Refusal,
  pairKey,
  parseViewportSpec,
  refuse,
  slugify,
  validateInventory,
} from './theme-fidelity.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Exit status contract. Nothing else may be returned from main(). */
export const EXIT = { OK: 0, USAGE: 2, NOT_MEASURABLE: 3, REFUSAL: 4 };

/** The pipeline stages, in the order they must run. */
export const STAGES = ['preflight', 'references', 'serve', 'subject', 'compare', 'checks', 'report'];

/** The authorised theme copy, and -1 (live production, read-only). */
export const COPY_THEME_ID = '1001512581';
export const LIVE_PREVIEW_THEME_ID = '-1';
export const ALLOWED_THEME_IDS = [LIVE_PREVIEW_THEME_ID, COPY_THEME_ID];
/** The store's live theme. It is never requested and never written: read-only reference only. */
export const LIVE_THEME_ID = '1001510509';

export const TOOLS = Object.freeze({
  harness: '.canary/tools/theme-fidelity.mjs',
  checks: 'scripts/theme-checks.mjs',
});

/**
 * The statuses the checks stage mints. The publish predicate allowlists `CLEAN` from this
 * set, so a status added here later refuses to publish until it is deliberately made
 * publishable — an unknown status can never fall through to a publish.
 */
export const CHECKS_STATUS = Object.freeze({ CLEAN: 'CLEAN', REFUSED: 'REFUSED', FAILED: 'FAILED' });

/** The one remote-writing command this pipeline may spawn. `hrv` resolves the theme from cwd. */
export const DEV_COMMAND = Object.freeze({ command: 'hrv', args: ['theme', 'dev'] });

export const ARTIFACTS = Object.freeze({
  preflight: 'preflight.json',
  references: 'references.json',
  serve: 'serve.json',
  devLog: 'hrv-theme-dev.log',
  inventories: 'inventories',
  r1: 'r1',
  r2: 'r2',
  subject: 'subject',
  drift: 'subject/drift.json',
  compare: 'compare',
  compareIndex: 'compare-index.json',
  structural: 'structural.json',
  checks: 'checks.json',
  report: 'report.json',
  reportMarkdown: 'report.md',
  current: 'current.json',
  commands: 'commands.jsonl',
  themeSettings: '.haravan-cli_local.json',
});

/** The two verdict sets the run publishes. */
export const COMPARE_SETS = Object.freeze([
  { name: 'r1-vs-subject', reference: 'r1', subject: 'subject', label: 'R1 deployed copy vs subject' },
  { name: 'r2-vs-subject', reference: 'r2', subject: 'subject', label: 'R2 live production vs subject' },
]);

/**
 * The tool set whose source decides what a verdict means: the harness that captures and
 * adjudicates, the settle contract it obeys, the copy-writer it supervises, this driver,
 * and the digest library that defines `sha256Text`/`HASH_CONTRACT`/`textDigest`. A change
 * to the digest semantics changes what every recorded digest means, so it must mint a new
 * revision just like a change to an adjudicating file. Two verdict generations produced by
 * different revisions of these files must not be readable as one campaign, so every JSON
 * artifact this driver mints carries the revision they hashed to.
 */
export const INSTRUMENT_FILES = Object.freeze([
  '.canary/tools/theme-fidelity.mjs',
  '.canary/tools/canary-settle.mjs',
  '.canary/tools/theme-fidelity-run.mjs',
  'scripts/lib/settle-contract.mjs',
  'scripts/lib/atomic-record.mjs',
]);

/**
 * The instrument identity of a document: the revision of the tool set that produced it,
 * plus the per-file digests that revision was computed from.
 *
 * Each file is hashed as text with CRLF normalised to LF, so the same tool source hashes
 * the same in a CRLF and an LF checkout; each entry names that contract, so a reader knows
 * a digest difference is a source change and not a line-ending translation. A file that
 * cannot be read is recorded as `sha256: null` with no contract and the revision is still
 * minted — a partially unknown instrument must be visible in the artifact, never thrown
 * over. The revision is the hash of the `path sha256` lines, so any change to any
 * instrument file mints a new revision.
 */
export function readInstrument({ repo = REPO, files = INSTRUMENT_FILES } = {}) {
  const entries = files.map((rel) => {
    try {
      return { path: rel, ...textDigest(fs.readFileSync(path.join(repo, rel), 'utf8')) };
    } catch {
      return { path: rel, sha256: null, hashContract: null };
    }
  });
  const revision = sha256Text(entries.map((entry) => `${entry.path} ${entry.sha256 ?? '<missing>'}`).join('\n'));
  return { revision, files: entries };
}

/** The `instrument` block for one artifact: its tool revision and the epoch it was minted at. */
function instrumentBlock(generatedAt) {
  return { ...readInstrument(), epoch: generatedAt ?? null };
}

let childInstrumentRevision = null;

/**
 * The environment every repo tool this driver spawns runs with: the ambient environment
 * plus the instrument revision, so a child that stamps its own artifacts names the tool
 * set that produced them. Minted once per process — the instrument cannot change mid-run.
 */
function childInstrumentEnv() {
  childInstrumentRevision ??= readInstrument().revision;
  return { ...process.env, CANARY_INSTRUMENT_REVISION: childInstrumentRevision };
}

/**
 * The pin of a JSON or text artifact this run wrote: its text digest with the contract it
 * was taken under, so a reader knows a mismatch here cannot be a line-ending translation.
 */
function artifactDigest(file) {
  return textDigest(fs.readFileSync(file, 'utf8'));
}

/**
 * Readiness log signals. They are the first signal only: the copy-preview HTTP probe
 * is mandatory in every case, and readiness is never declared from a log line alone.
 */
export const READY_LOG_PATTERNS = Object.freeze([
  /themeid=1001512581/i,
  /preview\s+(?:at|url)/i,
  /watching\s+for\s+changes/i,
  /\bready\b/i,
  /listening\s+on/i,
]);

const HARNESS_TIMEOUT_MS = Number(process.env.THEME_FIDELITY_TOOL_TIMEOUT_MS || 900_000);
const CHECKS_TIMEOUT_MS = Number(process.env.THEME_FIDELITY_CHECKS_TIMEOUT_MS || 300_000);
const SERVE_READY_BUDGET_MS = Number(process.env.THEME_FIDELITY_READY_TIMEOUT_MS || 180_000);
/** Share of the readiness budget spent waiting for the log signal before the probe. */
const SERVE_LOG_BUDGET_SHARE = 0.5;
const SERVE_PROBE_INTERVAL_MS = Number(process.env.THEME_FIDELITY_PROBE_INTERVAL_MS || 2_000);
/** Time granted to the dev session after readiness so its initial upload completes. */
const SERVE_SETTLE_MS = Number(process.env.THEME_FIDELITY_SETTLE_MS || 5_000);
const SERVE_STOP_GRACE_MS = Number(process.env.THEME_FIDELITY_STOP_GRACE_MS || 8_000);
const HTTP_PROBE_TIMEOUT_MS = Number(process.env.THEME_FIDELITY_PROBE_TIMEOUT_MS || 20_000);
const LOG_MAX_LINES = 400;
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_COMMAND_RE = /\b(publish|deploy|push)\b/i;

const STAGE_FLAGS = Object.freeze({
  preflight: { required: ['out', 'theme', 'inventory'], optional: [] },
  references: { required: ['out'], optional: ['viewports'] },
  serve: { required: ['out', 'theme'], optional: [] },
  subject: { required: ['out'], optional: ['viewports'] },
  compare: { required: ['out'], optional: [] },
  checks: { required: ['out', 'theme'], optional: [] },
  report: { required: ['out'], optional: [] },
});

export const USAGE = `theme-fidelity-run — orchestrator for the Haravan customize-theme fidelity pipeline

usage:
  node .canary/tools/theme-fidelity-run.mjs preflight  --out <dir> --theme <themeDir> --inventory <inventory.json>
  node .canary/tools/theme-fidelity-run.mjs references --out <dir> [--viewports 1440x900,1024x900,390x844]
  node .canary/tools/theme-fidelity-run.mjs serve      --out <dir> --theme <themeDir>
  node .canary/tools/theme-fidelity-run.mjs subject    --out <dir> [--viewports 1440x900,1024x900,390x844]
  node .canary/tools/theme-fidelity-run.mjs compare    --out <dir>
  node .canary/tools/theme-fidelity-run.mjs checks     --out <dir> --theme <themeDir>
  node .canary/tools/theme-fidelity-run.mjs report     --out <dir>
  node .canary/tools/theme-fidelity-run.mjs --help

stages:
  preflight   prove the theme workspace is the authorised copy (${COPY_THEME_ID}), derive the
              copy/live/subject capture URLs from the inventory and write the per-role
              inventories plus <out>/preflight.json
  references  capture R1 (deployed copy) and R2 (live production) read-only, BEFORE anything
              writes to the copy, into <out>/r1 and <out>/r2
  serve       start \`${DEV_COMMAND.command} ${DEV_COMMAND.args.join(' ')}\` in the theme workspace as a supervised
              child, wait for its log signal and for the copy preview to answer over HTTP,
              then stop the child it started
  subject     capture the dev-served copy into <out>/subject and record whether the served
              copy changed since the reference was pinned
  compare     adjudicate r1 vs subject and r2 vs subject into <out>/compare/<set>
  checks      run ${TOOLS.checks} over the theme source and every captured page into
              <out>/structural.json; a refusal (exit 3) is a finding, not a pipeline failure
  report      assemble <out>/report.json and <out>/report.md from persisted artifacts and the
              safety audit of <out>/commands.jsonl, then publish <out>/current.json

exit codes:
  0  the stage produced its artifact
  2  usage refusal: bad or missing arguments, unreadable inventory, a missing required
     inventory field (store, surfaces, unresolved)
  3  the stage could not produce its artifact: a composed tool refused, a prerequisite
     artifact is absent, or a verdict is missing — a missing artifact is never a PASS
  4  safety or provenance refusal: the theme workspace does not declare the authorised copy
     ${COPY_THEME_ID}, an inventory already addresses another theme, an existing reference pin
     cannot be reused verbatim, or the safety audit found a foreign theme id or a
     publish/deploy/push command

safety:
  Only ${COPY_THEME_ID} (the authorised copy) and ${LIVE_PREVIEW_THEME_ID} (live production, read-only) may be addressed.
  The store's live theme ${LIVE_THEME_ID} is never requested and never written. The only remote-writing
  command is \`${DEV_COMMAND.command} ${DEV_COMMAND.args.join(' ')}\` in the theme workspace, supervised as a child the
  serve stage also stops. Nothing in this pipeline publishes, deploys or pushes a theme.`;

// ── Typed refusals ────────────────────────────────────────────────────────────

const isRefusal = (e) => e instanceof Refusal;

/** Convert any thrown value into the typed refusal the stage reports. */
function asRefusal(e) {
  if (isRefusal(e)) return e;
  return refuse('STAGE_FAILED', EXIT.NOT_MEASURABLE, `unexpected failure: ${String((e && e.message) || e).slice(0, 400)}`, { stack: String((e && e.stack) || e).slice(0, 2000) });
}

const log = (...args) => console.log('[theme-fidelity-run]', ...args);
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const trimmed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const relTo = (base, file) => path.relative(base, file).split(path.sep).join('/');
const mdCell = (v) => (v === null || v === undefined ? '' : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
const describeReference = (summary) => {
  if (!summary) return 'absent';
  const status = summary.status ?? summary.label ?? 'unknown';
  const counts = summary.captured === undefined || summary.captured === null ? '' : ` (${summary.captured}/${summary.requested ?? '?'} captured${summary.reused ? ', reused' : ''})`;
  return `${status}${counts}`;
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Append one themeid parameter with correct query joining, replacing one already present. */
export function withThemeId(url, themeId) {
  const parsed = new URL(String(url));
  parsed.searchParams.set('themeid', String(themeId));
  return parsed.toString();
}

/** Every themeid any URL in an inventory carries (surfaces, views and the preview bases). */
export function themeIdsFromInventory(inventory) {
  const ids = new Set();
  const urls = [];
  for (const entry of [...(inventory?.surfaces ?? []), ...(inventory?.views ?? [])]) {
    if (entry && typeof entry.url === 'string') urls.push(entry.url);
  }
  for (const base of [inventory?.livePreviewBase, inventory?.copyPreviewBase]) {
    if (typeof base === 'string' && base.trim()) urls.push(base);
  }
  for (const url of urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    for (const [key, value] of parsed.searchParams) {
      if (key.toLowerCase() === 'themeid') ids.add(String(value).trim());
    }
  }
  return Array.from(ids).sort();
}

/**
 * Validate the inventory fields the pipeline additionally requires: the report's
 * not-measured section is built from `unresolved`, so a missing or malformed entry is
 * a usage refusal (exit 2), never an empty section.
 */
export function validateUnresolved(raw, file) {
  const unresolved = raw?.unresolved;
  if (!Array.isArray(unresolved)) {
    throw refuse('INVENTORY_FIELD_MISSING', EXIT.USAGE, `inventory ${file} is missing a \`unresolved\` array, which the report requires to name what was not measured`, { file, field: 'unresolved' });
  }
  unresolved.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw refuse('INVENTORY_FIELD_MISSING', EXIT.USAGE, `inventory ${file} unresolved[${i}] is not an object`, { file, field: `unresolved[${i}]` });
    }
    if (!trimmed(entry.name)) {
      throw refuse('INVENTORY_FIELD_MISSING', EXIT.USAGE, `inventory ${file} is missing \`unresolved[${i}].name\``, { file, field: `unresolved[${i}].name` });
    }
    if (!trimmed(entry.reason)) {
      throw refuse('INVENTORY_FIELD_MISSING', EXIT.USAGE, `inventory ${file} is missing \`unresolved[${i}].reason\``, { file, field: `unresolved[${i}].reason` });
    }
  });
  return unresolved.map((entry) => ({ name: String(entry.name).trim(), reason: String(entry.reason).trim() }));
}

/**
 * Derive the three capture inventories from the resolved inventory: every surface and
 * view gets a copy URL (themeid=${COPY_THEME_ID}), a live URL (themeid=${LIVE_PREVIEW_THEME_ID}) and a
 * subject URL (the copy endpoint again — the subject is the local source as served by
 * the dev session onto that same copy). Pure: no filesystem access.
 */
export function deriveInventories(raw, { copyThemeId = COPY_THEME_ID, liveThemeId = LIVE_PREVIEW_THEME_ID, source = null } = {}) {
  const roles = [
    { role: 'copy', themeId: copyThemeId },
    { role: 'live', themeId: liveThemeId },
    { role: 'subject', themeId: copyThemeId },
  ];
  const nameOf = (entry) => String(entry.name).trim();
  const targets = [];
  const pushTargets = (entries, kind) => {
    for (const entry of entries) {
      targets.push({
        name: nameOf(entry),
        kind,
        slug: slugify(nameOf(entry)),
        template: trimmed(entry.template),
        source: trimmed(entry.source),
        sourceUrl: String(entry.url).trim(),
        urls: {
          copy: withThemeId(entry.url, copyThemeId),
          live: withThemeId(entry.url, liveThemeId),
          subject: withThemeId(entry.url, copyThemeId),
        },
      });
    }
  };
  pushTargets(raw.surfaces ?? [], 'surface');
  pushTargets(raw.views ?? [], 'view');

  const entriesFor = (role, kind, entries) => entries.map((entry) => {
    const derived = {
      name: nameOf(entry),
      url: withThemeId(entry.url, role.themeId),
      sourceUrl: String(entry.url).trim(),
    };
    const sourceField = trimmed(entry.source);
    const notes = trimmed(entry.notes);
    if (sourceField) derived.source = sourceField;
    if (notes) derived.notes = notes;
    if (kind === 'view') derived.template = trimmed(entry.template) ?? undefined;
    return derived;
  });

  const documents = {};
  for (const role of roles) {
    documents[role.role] = {
      kind: 'theme-fidelity-run-inventory',
      role: role.role,
      themeId: String(role.themeId),
      store: String(raw.store).trim(),
      derivedFrom: {
        file: source?.file ?? null,
        sha256: source?.sha256 ?? null,
        hashContract: source?.hashContract ?? null,
        store: String(raw.store).trim(),
        surfaces: (raw.surfaces ?? []).length,
        views: (raw.views ?? []).length,
        unresolved: (raw.unresolved ?? []).length,
        livePreviewBase: raw.livePreviewBase ?? null,
        copyPreviewBase: raw.copyPreviewBase ?? null,
      },
      surfaces: entriesFor(role, 'surface', raw.surfaces ?? []),
      views: entriesFor(role, 'view', raw.views ?? []),
    };
  }
  return { roles, targets, documents, copy: documents.copy, live: documents.live, subject: documents.subject };
}

/** The first surface, preferring `home`, used as the dev-session readiness probe target. */
export function probeTargetOf(derived) {
  const surfaces = derived.targets.filter((t) => t.kind === 'surface');
  const home = surfaces.find((t) => t.name.toLowerCase() === 'home');
  return home ?? surfaces[0] ?? derived.targets[0] ?? null;
}

/** The exact shape of one commands.jsonl record. One line per stage invocation. */
export function buildCommandRecord({
  stage,
  argv = [],
  commands = [],
  cwd = null,
  spawned = false,
  childPid = null,
  themeIds = [],
  themeIdsSource = null,
  writeTargets = [],
  readOnlyLivePreviews = [],
  readOnlyCopyPreviews = [],
  artifacts = [],
  stopMethod = null,
  startedAt = null,
  finishedAt = null,
  exitCode = EXIT.OK,
  refusal = null,
} = {}) {
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  return {
    kind: 'theme-fidelity-run-command',
    stage,
    argv: [...argv],
    commands: commands.map((command) => [...command]),
    cwd,
    spawned,
    childPid,
    themeIds: Array.from(new Set(themeIds.map((id) => String(id)))).sort(),
    themeIdsSource,
    writeTargets: Array.from(new Set(writeTargets.map((id) => String(id)))).sort(),
    readOnlyLivePreviews: Array.from(new Set(readOnlyLivePreviews)).sort(),
    readOnlyCopyPreviews: Array.from(new Set(readOnlyCopyPreviews)).sort(),
    artifacts: [...artifacts],
    stopMethod,
    startedAt,
    finishedAt,
    durationMs: Number.isFinite(start) && Number.isFinite(finish) ? finish - start : null,
    exitCode,
    refusal,
  };
}

/**
 * The safety audit of the run's own command record. `pass` requires that no command
 * addressed a theme other than -1 or the authorised copy, and that no command in the
 * record is a publish, deploy or push.
 */
export function auditCommands(records, { allowedThemeIds = ALLOWED_THEME_IDS } = {}) {
  const allowed = new Set(allowedThemeIds.map((id) => String(id)));
  const commands = (records ?? []).map((record, index) => {
    const themeIds = Array.isArray(record?.themeIds) ? record.themeIds.map((id) => String(id)) : [];
    const foreignThemeIds = themeIds.filter((id) => !allowed.has(id));
    return {
      index,
      stage: record?.stage ?? null,
      exitCode: record?.exitCode ?? null,
      durationMs: record?.durationMs ?? null,
      command: Array.isArray(record?.commands) && record.commands.length ? record.commands[0] : null,
      commands: Array.isArray(record?.commands) ? record.commands : [],
      themeIds,
      themeIdsSource: record?.themeIdsSource ?? null,
      foreignThemeIds,
      writeTargets: Array.isArray(record?.writeTargets) ? record.writeTargets : [],
      readOnlyLivePreviews: Array.isArray(record?.readOnlyLivePreviews) ? record.readOnlyLivePreviews : [],
      readOnlyCopyPreviews: Array.isArray(record?.readOnlyCopyPreviews) ? record.readOnlyCopyPreviews : [],
      stopMethod: record?.stopMethod ?? null,
      spawned: record?.spawned === true,
    };
  });

  const foreign = commands.filter((command) => command.foreignThemeIds.length).map((command) => ({
    stage: command.stage,
    themeIds: command.themeIds,
    foreignThemeIds: command.foreignThemeIds,
    command: command.command,
  }));

  const publishMatches = [];
  for (const command of commands) {
    const tokens = [command.stage, ...command.commands.flat()].filter((token) => typeof token === 'string');
    for (const token of tokens) {
      if (FORBIDDEN_COMMAND_RE.test(token)) publishMatches.push({ stage: command.stage, token });
    }
  }

  const dedupe = (values) => Array.from(new Set(values)).sort();
  const livePreviewReads = dedupe(commands.flatMap((command) => command.readOnlyLivePreviews));
  const copyPreviewReads = dedupe(commands.flatMap((command) => command.readOnlyCopyPreviews));
  const remoteWrites = commands.filter((command) => command.writeTargets.length).map((command) => ({
    stage: command.stage,
    writeTargets: command.writeTargets,
    command: command.command,
    stopMethod: command.stopMethod,
  }));

  return {
    kind: 'theme-fidelity-run-safety-audit',
    commands: commands.length,
    allowedThemeIds: Array.from(allowed).sort(),
    themeIds: dedupe(commands.flatMap((command) => command.themeIds)),
    foreignThemeIds: { count: foreign.length, entries: foreign },
    publishDeployPush: { absent: publishMatches.length === 0, matches: publishMatches },
    livePreviewReads,
    copyPreviewReads,
    remoteWrites,
    perCommand: commands,
    pass: foreign.length === 0 && publishMatches.length === 0,
  };
}

/** Parse the records in commands.jsonl; a malformed line makes the audit untrustworthy. */
export function parseCommandRecords(text, file) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      throw refuse('COMMAND_LOG_UNREADABLE', EXIT.REFUSAL, `${file} line ${i + 1} is not valid JSON: ${String((e && e.message) || e).slice(0, 200)}`, { file, line: i + 1 });
    }
  });
}

/**
 * Argument parsing. Unknown or duplicated flags, missing values and missing required
 * arguments are usage refusals (exit 2) naming the offending flag, and `--help` must
 * work without touching the filesystem, a session or a child process.
 */
export function parseArgs(argv) {
  const [stage, ...rest] = argv;
  if (!stage) throw refuse('STAGE_MISSING', EXIT.USAGE, `no stage given; expected one of ${STAGES.join(', ')}`);
  if (stage === '--help' || stage === '-h' || stage === 'help') return { stage: 'help', options: {} };
  if (!STAGES.includes(stage)) {
    throw refuse('STAGE_UNKNOWN', EXIT.USAGE, `unknown stage \`${stage}\`; expected one of ${STAGES.join(', ')}`, { stage });
  }
  const spec = STAGE_FLAGS[stage];
  const known = new Set([...spec.required, ...spec.optional]);
  const flags = new Map();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) throw refuse('ARG_UNEXPECTED', EXIT.USAGE, `unexpected positional argument \`${token}\``, { stage, argument: token });
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const value = eq === -1 ? rest[++i] : token.slice(eq + 1);
    if (value === undefined || value === '') throw refuse('ARG_VALUE_MISSING', EXIT.USAGE, `--${name} requires a value`, { stage, flag: name });
    if (flags.has(name)) throw refuse('ARG_DUPLICATE', EXIT.USAGE, `--${name} was given more than once`, { stage, flag: name });
    if (!known.has(name)) throw refuse('ARG_UNKNOWN', EXIT.USAGE, `--${name} is not a ${stage} option`, { stage, flag: name, known: Array.from(known) });
    flags.set(name, value);
  }
  const options = {};
  for (const name of spec.required) {
    const value = flags.get(name);
    if (value === undefined) throw refuse('ARG_REQUIRED_MISSING', EXIT.USAGE, `${stage} requires --${name}`, { stage, flag: name });
    options[name] = value;
  }
  for (const name of spec.optional) {
    if (flags.has(name)) options[name] = flags.get(name);
  }
  if (options.viewports !== undefined) options.viewportList = parseViewportSpec(options.viewports);
  return { stage, options };
}

// ── Filesystem helpers ────────────────────────────────────────────────────────

function readJsonArtifact(file, code, exitCode, what) {
  const resolved = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (e) {
    throw refuse(code, exitCode, `${what} ${resolved} is unreadable: ${String((e && e.message) || e).slice(0, 200)}`, { file: resolved });
  }
  try {
    return { value: JSON.parse(raw), file: resolved, ...textDigest(raw), bytes: Buffer.byteLength(raw) };
  } catch (e) {
    throw refuse(code, exitCode, `${what} ${resolved} is not valid JSON: ${String((e && e.message) || e).slice(0, 200)}`, { file: resolved });
  }
}

function writeJsonFile(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

/** Read an optional artifact: absent is null, present-but-unreadable is a refusal. */
function loadOptional(file, exitCode, what) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) return null;
  return readJsonArtifact(resolved, 'ARTIFACT_UNREADABLE', exitCode, what);
}

function requireArtifact(outDir, rel, stage, what = 'artifact') {
  const file = path.join(outDir, rel);
  if (!fs.existsSync(file)) {
    throw refuse('PREREQUISITE_MISSING', EXIT.NOT_MEASURABLE, `${file} does not exist; the ${stage} stage cannot run without the ${what} produced by an earlier stage`, { file, artifact: rel, stage });
  }
  return file;
}

function appendCommandRecord(outDir, record) {
  const file = path.join(path.resolve(outDir), ARTIFACTS.commands);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

/**
 * Read the append-only command log. The returned pin names both the contract and the
 * coverage: a text digest with CRLF normalised to LF, so the same bytes hash the same in a
 * CRLF and an LF checkout, over the whole log as it existed at read time — blank lines
 * included. `rawLines` is the number of raw lines that text contains and the argument a
 * verifier passes to `commandLogPrefix`; `lines` is the parser's record count and differs
 * when the log has blank lines. Every stage's own record is appended after this pin is
 * taken (see `commandLogPrefix`), so the file on disk is longer than the pin — `appendOnly`
 * says the growth is by design.
 */
export function readCommandRecords(file) {
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(file), 'utf8');
  } catch (e) {
    throw refuse('COMMAND_LOG_UNREADABLE', EXIT.REFUSAL, `${file} is unreadable: ${String((e && e.message) || e).slice(0, 200)}`, { file });
  }
  const records = parseCommandRecords(raw, path.resolve(file));
  // The pin digests the log as it existed at read time, blank lines included. `rawLines` is
  // the exact number of raw lines `commandLogPrefix(raw, rawLines)` must slice to reproduce
  // that text; `lines` is the parser's record count and is a different number on a log with
  // blank lines, so it must never be used as the slicing argument.
  return { records, ...textDigest(raw), bytes: Buffer.byteLength(raw), lines: records.length, rawLines: commandLogLines(raw).length, appendOnly: true };
}

/** The theme workspace settings, and the copy-theme gate every stage re-checks at use time. */
function readThemeSettings(themeDir) {
  const file = path.join(themeDir, ARTIFACTS.themeSettings);
  if (!isFile(file)) {
    throw refuse('THEME_ID_UNRESOLVED', EXIT.REFUSAL, `the theme workspace ${themeDir} has no ${ARTIFACTS.themeSettings}, so the theme it targets cannot be proven to be the authorised copy ${COPY_THEME_ID}`, { file });
  }
  const loaded = readJsonArtifact(file, 'THEME_SETTINGS_UNREADABLE', EXIT.REFUSAL, 'theme workspace settings');
  const declared = loaded.value && typeof loaded.value === 'object' ? loaded.value : {};
  const themeId = trimmed(declared.theme_id) ?? (declared.theme_id === undefined || declared.theme_id === null ? '' : String(declared.theme_id).trim());
  if (themeId !== COPY_THEME_ID) {
    throw refuse('THEME_ID_NOT_ALLOWED', EXIT.REFUSAL, `${file} declares theme_id ${themeId === '' ? '<missing>' : themeId}, not the authorised copy ${COPY_THEME_ID}`, {
      file,
      themeId: themeId === '' ? null : themeId,
      declared: declared.theme_id ?? null,
      expected: COPY_THEME_ID,
    });
  }
  return {
    file,
    sha256: loaded.sha256,
    hashContract: loaded.hashContract,
    bytes: loaded.bytes,
    themeId,
    orgId: trimmed(declared.org_id) ?? null,
    themeOrgId: trimmed(declared.theme_org_id) ?? null,
    themeName: trimmed(declared.theme_name) ?? null,
  };
}

/**
 * The typed refusal a composed tool reported, from its index when it wrote one and
 * from its stderr otherwise. The child's own exit code and refusal text are carried
 * verbatim: this driver never re-types or re-words a refusal it did not raise.
 */
export function parseChildRefusal(stderr, indexRefusal) {
  if (indexRefusal && typeof indexRefusal === 'object') {
    return { code: indexRefusal.code ?? null, exitCode: indexRefusal.exitCode ?? null, message: String(indexRefusal.message ?? '').slice(0, 600) };
  }
  const text = String(stderr || '');
  const line = text.split(/\r?\n/).find((l) => /REFUSED\s+\S+/.test(l)) ?? null;
  if (!line) return null;
  const match = /REFUSED\s+(\S+)\s*\(exit\s+(\d+)\)\s*:\s*(.*)$/.exec(line.trim());
  if (!match) return { code: null, exitCode: null, message: line.trim().slice(0, 600) };
  return { code: match[1], exitCode: Number(match[2]), message: match[3].slice(0, 600) };
}

/**
 * The typed reason a capture index already holds when it measured every leg it could and
 * could not measure the rest. That capture exits 3 with `status: INCOMPLETE` and no thrown
 * refusal, so nothing lands on `index.refusal` and the reason exists only per target: without
 * this the driver reports "no typed refusal text" for a run that named every failure. Returns
 * null for anything that is not an incomplete capture, so a completed side is never re-typed.
 */
export function refusalFromCaptureIndex(index) {
  if (!index || typeof index !== 'object' || index.status !== 'INCOMPLETE') return null;
  const failures = (Array.isArray(index.targets) ? index.targets : [])
    .filter((t) => t && t.status && t.status !== 'CAPTURED')
    .map((t) => ({
      surface: t.surface ?? null,
      viewport: t.viewport ?? null,
      code: t.failure?.code ?? t.status ?? null,
      reason: t.failure?.reason ?? null,
    }));
  if (!failures.length) return null;
  const codes = Array.from(new Set(failures.map((f) => f.code).filter(Boolean)));
  const first = failures[0];
  const where = [first.surface ?? '?', first.viewport ?? ''].join(' ').trim();
  return {
    code: codes.length === 1 ? codes[0] : 'CAPTURE_INCOMPLETE',
    exitCode: EXIT.NOT_MEASURABLE,
    message: `${index.label ?? 'capture'} is INCOMPLETE: ${index.totals?.captured ?? '?'}/${index.totals?.requested ?? '?'} captured, ${failures.length} not measurable (${codes.join(', ') || 'unnamed'}); first: ${where} — ${first.reason ?? 'no reason recorded'}`.slice(0, 600),
    failures,
  };
}

const tailOf = (text, lines = 40) => String(text || '').trim().split(/\r?\n/).slice(-lines);

// ── Child processes ───────────────────────────────────────────────────────────

/** Run a repo tool to completion, capturing its output. Never used for long-lived processes. */
function execTool({ argv, timeoutMs, cwd = REPO }) {
  const command = process.execPath;
  const args = [path.resolve(REPO, argv[0]), ...argv.slice(1)];
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, { cwd, env: childInstrumentEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    const finish = ({ exitCode = null, signal = null, spawnError = null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command: [command, ...args], exitCode, signal, spawnError, timedOut, stdout, stderr, durationMs: Date.now() - started });
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (e) => finish({ spawnError: String((e && e.message) || e).slice(0, 400) }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal, timedOut }));
  });
}

/**
 * Stop a long-lived child this driver started. SIGTERM first, then the platform's
 * hard stop; on Windows the shell wrapper is killed with its tree so the dev session's
 * own node process cannot outlive the stage.
 */
export async function stopChild(child, graceMs = SERVE_STOP_GRACE_MS) {
  if (!child || child.exitCode !== null || child.signalCode) return 'exited';
  const exited = new Promise((resolve) => child.once('close', () => resolve(true)));
  const settle = async (ms) => Promise.race([exited, sleep(ms).then(() => false)]);
  try { child.kill('SIGTERM'); } catch {}
  if (await settle(graceMs)) return 'sigterm';
  if (process.platform === 'win32') {
    const killed = await runOnce('taskkill', ['/PID', String(child.pid), '/T', '/F'], 20_000);
    return (await settle(5_000)) ? 'taskkill-tree' : `taskkill-unconfirmed:${String(killed.stderr || killed.stdout || '').trim().slice(0, 120)}`;
  }
  try { child.kill('SIGKILL'); } catch {}
  return (await settle(5_000)) ? 'sigkill' : 'sigkill-unconfirmed';
}

function runOnce(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (e) => { stderr += String((e && e.message) || e); finish(null); });
    child.on('close', (code) => finish(code));
  });
}

function isProcessAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// ── HTTP probe ────────────────────────────────────────────────────────────────

/** One plain HTTP read of a preview URL. Any 2xx/3xx response means the preview answers. */
export function probePreview(url, { timeoutMs = HTTP_PROBE_TIMEOUT_MS, maxRedirects = 3, copyThemeId = COPY_THEME_ID, maxBodyBytes = 512 * 1024 } = {}) {
  const started = Date.now();
  const assetRe = new RegExp(`themes/\\d+/${copyThemeId}/`);
  return new Promise((resolve) => {
    const attempt = (target, redirectsLeft) => {
      let parsed;
      let mod;
      try {
        parsed = new URL(target);
        mod = parsed.protocol === 'http:' ? http : https;
      } catch (e) {
        resolve({ ok: false, url: String(target), status: null, error: `unparsable probe URL: ${String((e && e.message) || e).slice(0, 200)}`, elapsedMs: Date.now() - started });
        return;
      }
      const req = mod.request({
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        headers: { accept: 'text/html', 'user-agent': 'theme-fidelity-run/1.0', 'cache-control': 'no-cache' },
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          attempt(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
          return;
        }
        let body = '';
        let bytes = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes <= maxBodyBytes) body += chunk;
        });
        res.on('end', () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          url: target,
          status: res.statusCode,
          bodyBytes: bytes,
          bodyCarriesCopyThemeId: assetRe.test(body),
          elapsedMs: Date.now() - started,
        }));
        res.on('error', (e) => resolve({ ok: false, url: target, status: res.statusCode ?? null, error: String((e && e.message) || e).slice(0, 200), elapsedMs: Date.now() - started }));
      });
      req.on('timeout', () => req.destroy(new Error(`no HTTP response within ${timeoutMs}ms`)));
      req.on('error', (e) => resolve({ ok: false, url: target, status: null, error: String((e && e.message) || e).slice(0, 200), elapsedMs: Date.now() - started }));
      req.end();
    };
    attempt(String(url), maxRedirects);
  });
}

// ── preflight ─────────────────────────────────────────────────────────────────

async function preflightWork(options, record) {
  const outDir = path.resolve(options.out);
  const themeDir = path.resolve(options.theme);
  const inventoryFile = path.resolve(options.inventory);
  if (!isDir(themeDir)) throw refuse('THEME_DIR_UNREADABLE', EXIT.USAGE, `--theme ${themeDir} is not a directory`, { themeDir });
  if (!isFile(inventoryFile)) throw refuse('INVENTORY_UNREADABLE', EXIT.USAGE, `--inventory ${inventoryFile} does not exist`, { file: inventoryFile });

  const settings = readThemeSettings(themeDir);
  const loaded = readJsonArtifact(inventoryFile, 'INVENTORY_UNREADABLE', EXIT.USAGE, 'inventory');
  const inventory = validateInventory(loaded.value, { file: loaded.file });
  const unresolved = validateUnresolved(loaded.value, loaded.file);

  const observed = themeIdsFromInventory(loaded.value);
  const foreign = observed.filter((id) => !ALLOWED_THEME_IDS.includes(id));
  if (foreign.length) {
    throw refuse('THEME_ID_NOT_ALLOWED', EXIT.REFUSAL, `inventory ${loaded.file} addresses themeid=${foreign.join(', ')}, which is neither ${LIVE_PREVIEW_THEME_ID} (live, read-only) nor the authorised copy ${COPY_THEME_ID}`, {
      file: loaded.file,
      foreignThemeIds: foreign,
      allowedThemeIds: ALLOWED_THEME_IDS,
    });
  }

  const derived = deriveInventories(loaded.value, { source: { file: loaded.file, sha256: loaded.sha256, hashContract: loaded.hashContract } });
  const inventoryDir = path.join(outDir, ARTIFACTS.inventories);
  const inventoryFiles = {};
  for (const role of ['copy', 'live', 'subject']) {
    inventoryFiles[role] = writeJsonFile(path.join(inventoryDir, `${role}.json`), derived.documents[role]);
  }
  const probe = probeTargetOf(derived);
  if (!probe) throw refuse('INVENTORY_FIELD_MISSING', EXIT.USAGE, `inventory ${loaded.file} resolved no capture target, so there is nothing to probe or capture`, { file: loaded.file });

  const preflight = {
    kind: 'theme-fidelity-run-preflight',
    stage: 'preflight',
    status: 'OK',
    generatedAt: nowIso(),
    outDir,
    store: inventory.store,
    copyThemeId: COPY_THEME_ID,
    livePreviewThemeId: LIVE_PREVIEW_THEME_ID,
    liveThemeIdNeverAddressed: LIVE_THEME_ID,
    allowedThemeIds: ALLOWED_THEME_IDS,
    theme: {
      dir: themeDir,
      settingsFile: settings.file,
      settingsSha256: settings.sha256,
      hashContract: settings.hashContract,
      settingsBytes: settings.bytes,
      themeId: settings.themeId,
      orgId: settings.orgId,
      themeOrgId: settings.themeOrgId,
      themeName: settings.themeName,
    },
    inventory: {
      file: loaded.file,
      sha256: loaded.sha256,
      hashContract: loaded.hashContract,
      bytes: loaded.bytes,
      surfaces: derived.targets.filter((t) => t.kind === 'surface').length,
      views: derived.targets.filter((t) => t.kind === 'view').length,
      unresolved,
      livePreviewBase: inventory.livePreviewBase,
      copyPreviewBase: inventory.copyPreviewBase,
      themeIdsObserved: observed,
    },
    previewBases: { copy: inventory.copyPreviewBase, live: inventory.livePreviewBase, subject: inventory.copyPreviewBase },
    probe: { url: probe.urls.copy, surface: probe.name, themeId: COPY_THEME_ID },
    targets: derived.targets,
    inventories: Object.fromEntries(Object.entries(inventoryFiles).map(([role, file]) => [role, { file: relTo(outDir, file), absolute: file, ...artifactDigest(file) }])),
    generatedBy: { script: relTo(REPO, fileURLToPath(import.meta.url)), node: process.version },
  };
  preflight.instrument = instrumentBlock(preflight.generatedAt);
  writeJsonFile(path.join(outDir, ARTIFACTS.preflight), preflight);

  record.themeIds = Array.from(new Set([COPY_THEME_ID, LIVE_PREVIEW_THEME_ID, ...observed]));
  record.themeIdsSource = `${relTo(outDir, inventoryFiles.copy)} + ${relTo(outDir, inventoryFiles.live)} (derived URL parameters; no command spawned)`;
  record.spawned = false;
  record.artifacts = [
    ARTIFACTS.preflight,
    ...Object.values(inventoryFiles).map((file) => relTo(outDir, file)),
  ];
  log(`preflight OK: store=${inventory.store} theme=${settings.themeId} org=${settings.orgId ?? '<none>'} targets=${derived.targets.length} probe=${probe.urls.copy}`);
  return { exitCode: EXIT.OK };
}

// ── references ────────────────────────────────────────────────────────────────

/** Classify an existing pin: reusable verbatim, absent, or a conflict that must not be overwritten. */
function inspectPin(outDir, side, label, spec) {
  const dir = path.join(outDir, side);
  const indexFile = path.join(dir, 'index.json');
  if (!fs.existsSync(indexFile)) {
    if (fs.existsSync(dir)) {
      return { state: 'conflict', indexFile, reason: `${dir} exists without an index.json (residue of an interrupted capture); a fresh --out is required` };
    }
    return { state: 'absent', indexFile };
  }
  const loaded = readJsonArtifact(indexFile, 'SIDE_INDEX_UNREADABLE', EXIT.REFUSAL, `${side} pin index`);
  const index = loaded.value;
  if (!index || typeof index !== 'object' || index.kind !== 'theme-fidelity-capture-index') {
    return { state: 'conflict', indexFile, reason: `${indexFile} is not a theme-fidelity capture index (kind=${index?.kind ?? null})` };
  }
  const pinnedSpec = Array.isArray(index.viewports) ? index.viewports.map((v) => v.label).join(',') : null;
  if (index.label !== label || index.role !== 'reference' || pinnedSpec !== spec) {
    return {
      state: 'conflict',
      indexFile,
      reason: `the existing pin records label=${index.label ?? '<none>'} role=${index.role ?? '<none>'} viewports=${pinnedSpec ?? '<none>'}, not label=${label} role=reference viewports=${spec}`,
    };
  }
  if (index.status !== 'COMPLETE') {
    return { state: 'conflict', indexFile, reason: `the existing pin status is ${index.status}; a partial pin cannot serve as a reference` };
  }
  return {
    state: 'reusable',
    indexFile,
    summary: {
      label,
      role: 'reference',
      status: index.status,
      reused: true,
      indexFile: relTo(outDir, indexFile),
      indexSha256: loaded.sha256,
      hashContract: loaded.hashContract,
      captured: index.totals?.captured ?? null,
      requested: index.totals?.requested ?? null,
      viewports: spec,
    },
  };
}

function summarizeCaptureIndex(side, loaded) {
  const index = loaded.value;
  const targets = Array.isArray(index.targets) ? index.targets : [];
  return {
    side,
    label: index.label ?? null,
    role: index.role ?? null,
    status: index.status ?? null,
    indexFile: loaded.file,
    indexSha256: loaded.sha256,
    hashContract: loaded.hashContract,
    captured: index.totals?.captured ?? null,
    requested: index.totals?.requested ?? null,
    viewports: Array.isArray(index.viewports) ? index.viewports.map((v) => v.label).join(',') : null,
    store: index.store ?? null,
    failures: targets.filter((t) => t.status !== 'CAPTURED').map((t) => ({
      surface: t.surface ?? null,
      viewport: t.viewport ?? null,
      status: t.status ?? null,
      code: t.failure?.code ?? null,
      reason: t.failure?.reason ?? null,
    })),
    refusal: index.refusal ?? null,
    instance: index.instance ?? null,
    run: index.run ?? null,
  };
}

async function referencesWork(options, record) {
  const outDir = path.resolve(options.out);
  const viewportList = options.viewportList ?? parseViewportSpec(DEFAULT_VIEWPORTS);
  const spec = viewportList.map((v) => v.label).join(',');
  const copyFile = requireArtifact(outDir, path.join(ARTIFACTS.inventories, 'copy.json'), 'references', 'copy inventory');
  const liveFile = requireArtifact(outDir, path.join(ARTIFACTS.inventories, 'live.json'), 'references', 'live inventory');

  const sides = [
    { side: 'r1', label: 'r1-copy', role: 'reference', inventory: copyFile, themeIds: [COPY_THEME_ID] },
    { side: 'r2', label: 'r2-live', role: 'reference', inventory: liveFile, themeIds: [LIVE_PREVIEW_THEME_ID] },
  ];
  const summaries = {};
  const livePreviews = [];
  for (const side of sides) {
    const pin = inspectPin(outDir, side.side, side.label, spec);
    if (pin.state === 'conflict') {
      throw refuse('REFERENCE_PIN_CONFLICT', EXIT.REFUSAL, `the pinned reference ${side.side} at ${pin.indexFile} cannot be reused or replaced: ${pin.reason}. Re-pinning after a dev write would destroy the reference the run is measured against; use a fresh --out`, { side: side.side, indexFile: pin.indexFile, reason: pin.reason });
    }
    if (pin.state === 'reusable') {
      summaries[side.side] = pin.summary;
      log(`references ${side.side}: reusing the complete pin at ${pin.indexFile} (${pin.summary.captured}/${pin.summary.requested} captured)`);
      continue;
    }
    fs.rmSync(path.join(outDir, side.side), { recursive: true, force: true });
    const argv = [TOOLS.harness, 'capture', '--role', side.role, '--label', side.label, '--inventory', side.inventory, '--out', path.join(outDir, side.side), '--viewports', spec, '--allow-theme', COPY_THEME_ID];
    log(`references ${side.side}: ${side.label} capture over ${spec}`);
    const run = await execTool({ argv, timeoutMs: HARNESS_TIMEOUT_MS });
    record.commands.push(run.command);
    const indexFile = path.join(outDir, side.side, 'index.json');
    const indexLoaded = isFile(indexFile) ? readJsonArtifact(indexFile, 'SIDE_INDEX_UNREADABLE', EXIT.NOT_MEASURABLE, `${side.side} capture index`) : null;
    const childRefusal = parseChildRefusal(run.stderr, indexLoaded?.value?.refusal ?? null) ?? refusalFromCaptureIndex(indexLoaded?.value ?? null);
    if (run.spawnError) {
      throw refuse('CAPTURE_NOT_MEASURABLE', EXIT.NOT_MEASURABLE, `${side.label} capture could not be spawned: ${run.spawnError}`, { side: side.side, command: run.command, spawnError: run.spawnError });
    }
    if (run.timedOut) {
      throw refuse('CAPTURE_TIMED_OUT', EXIT.NOT_MEASURABLE, `${side.label} capture exceeded ${HARNESS_TIMEOUT_MS}ms and was killed`, { side: side.side, command: run.command, childExitCode: run.exitCode, stderrTail: tailOf(run.stderr) });
    }
    if (run.exitCode !== 0) {
      const text = childRefusal ? `${childRefusal.code ?? 'REFUSED'}${childRefusal.exitCode !== null ? ` (exit ${childRefusal.exitCode})` : ''}: ${childRefusal.message}` : `no typed refusal text; stderr tail: ${tailOf(run.stderr, 12).join(' | ')}`;
      throw refuse('CAPTURE_REFUSED', EXIT.NOT_MEASURABLE, `${side.label} capture exited ${run.exitCode}: ${text}`, {
        side: side.side,
        childExitCode: run.exitCode,
        childRefusal,
        safetyRefusal: run.exitCode === EXIT.REFUSAL,
        indexFile: isFile(indexFile) ? indexFile : null,
        stderrTail: tailOf(run.stderr, 20),
        stdoutTail: tailOf(run.stdout, 20),
      });
    }
    if (!indexLoaded) {
      throw refuse('CAPTURE_INDEX_ABSENT', EXIT.NOT_MEASURABLE, `${side.label} capture exited 0 but wrote no index at ${indexFile}`, { side: side.side, command: run.command, indexFile });
    }
    const summary = summarizeCaptureIndex(side.side, indexLoaded);
    if (summary.status !== 'COMPLETE') {
      const derived = refusalFromCaptureIndex(indexLoaded.value);
      throw refuse('CAPTURE_INCOMPLETE', EXIT.NOT_MEASURABLE, `${side.label} capture status is ${summary.status}: ${summary.captured ?? '?'}/${summary.requested ?? '?'} captured${summary.refusal ? ` (refused ${summary.refusal.code})` : derived ? ` — ${derived.message}` : ''}`, { side: side.side, indexFile, summary });
    }
    // A capture that measured a different store would make every verdict unattributable.
    const preflight = readJsonArtifact(path.join(outDir, ARTIFACTS.preflight), 'PREFLIGHT_UNREADABLE', EXIT.NOT_MEASURABLE, 'preflight record');
    if (summary.store !== null && String(summary.store) !== String(preflight.value?.store)) {
      throw refuse('STORE_MISMATCH', EXIT.REFUSAL, `${side.label} measured store ${summary.store}, not the preflight store ${preflight.value?.store}`, { side: side.side, measured: summary.store, expected: preflight.value?.store ?? null });
    }
    summaries[side.side] = { label: side.label, role: side.role, status: summary.status, reused: false, indexFile: relTo(outDir, indexFile), indexSha256: summary.indexSha256, hashContract: summary.hashContract, captured: summary.captured, requested: summary.requested, viewports: summary.viewports ?? spec };
  }

  const liveInventory = readJsonArtifact(liveFile, 'INVENTORY_UNREADABLE', EXIT.NOT_MEASURABLE, 'live inventory');
  for (const entry of [...(liveInventory.value.surfaces ?? []), ...(liveInventory.value.views ?? [])]) {
    if (typeof entry?.url === 'string') livePreviews.push(entry.url);
  }

  const references = {
    kind: 'theme-fidelity-run-references',
    stage: 'references',
    status: 'OK',
    generatedAt: nowIso(),
    viewportSpec: spec,
    viewports: viewportList,
    reusePolicy: 'a complete pin is reused verbatim; an existing pin that does not match the requested label/role/viewports is exit 4, never replaced',
    copy: summaries.r1,
    live: summaries.r2,
    r1: summaries.r1,
    r2: summaries.r2,
    livePreviewReads: livePreviews,
    inventories: { copy: relTo(outDir, copyFile), live: relTo(outDir, liveFile) },
  };
  references.instrument = instrumentBlock(references.generatedAt);
  writeJsonFile(path.join(outDir, ARTIFACTS.references), references);

  record.themeIds = [COPY_THEME_ID, LIVE_PREVIEW_THEME_ID];
  record.themeIdsSource = `${relTo(outDir, copyFile)} (themeid=${COPY_THEME_ID}) + ${relTo(outDir, liveFile)} (themeid=${LIVE_PREVIEW_THEME_ID})`;
  record.spawned = record.commands.length > 0;
  record.readOnlyLivePreviews = livePreviews;
  record.artifacts = [ARTIFACTS.references, summaries.r1?.indexFile, summaries.r2?.indexFile].filter(Boolean);
  log(`references OK: r1=${summaries.r1?.status}/${summaries.r1?.captured} r2=${summaries.r2?.status}/${summaries.r2?.captured} viewports=${spec}`);
  return { exitCode: EXIT.OK };
}

// ── serve ─────────────────────────────────────────────────────────────────────

function appendLogChunk(state, chunk) {
  const text = String(chunk);
  state.bytes += Buffer.byteLength(text);
  if (state.bytes <= LOG_MAX_BYTES) {
    state.fileBytes += Buffer.byteLength(text);
    try { fs.appendFileSync(state.file, text); } catch { state.writeError = true; }
  } else {
    state.truncated = true;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    state.lines.push(line);
    if (state.lines.length > LOG_MAX_LINES) state.lines.shift();
    if (!state.logSignal) {
      const pattern = READY_LOG_PATTERNS.find((re) => re.test(line));
      if (pattern) state.logSignal = { pattern: String(pattern), line: line.slice(0, 300), at: nowIso() };
    }
  }
}

async function serveWork(options, record) {
  const outDir = path.resolve(options.out);
  const themeDir = path.resolve(options.theme);
  if (!isDir(themeDir)) throw refuse('THEME_DIR_UNREADABLE', EXIT.USAGE, `--theme ${themeDir} is not a directory`, { themeDir });
  const preflightFile = requireArtifact(outDir, ARTIFACTS.preflight, 'serve', 'preflight record');
  const preflight = readJsonArtifact(preflightFile, 'PREFLIGHT_UNREADABLE', EXIT.NOT_MEASURABLE, 'preflight record');
  if (preflight.value?.kind !== 'theme-fidelity-run-preflight') {
    throw refuse('PREFLIGHT_UNREADABLE', EXIT.NOT_MEASURABLE, `${preflightFile} is not a theme-fidelity run preflight record (kind=${preflight.value?.kind ?? null})`, { file: preflightFile });
  }
  const probeUrl = trimmed(preflight.value.probe?.url);
  if (!probeUrl) throw refuse('PREFLIGHT_INCOMPLETE', EXIT.NOT_MEASURABLE, `${preflightFile} carries no probe URL for the copy preview`, { file: preflightFile });

  const settings = readThemeSettings(themeDir);

  const serveFile = path.join(outDir, ARTIFACTS.serve);
  if (fs.existsSync(serveFile)) {
    const prior = loadOptional(serveFile, EXIT.NOT_MEASURABLE, 'serve record');
    const priorPid = prior?.value?.pid ?? prior?.value?.child?.pid ?? null;
    if (priorPid && isProcessAlive(priorPid)) {
      throw refuse('DEV_SESSION_ALREADY_RUNNING', EXIT.NOT_MEASURABLE, `a supervised dev session is already recorded for ${outDir} (pid ${priorPid}, started ${prior?.value?.startedAt ?? 'unknown'}); stop it before starting another`, { pid: priorPid, file: serveFile });
    }
  }

  const logFile = path.join(outDir, ARTIFACTS.devLog);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(logFile, '');
  const state = { file: logFile, fileBytes: 0, bytes: 0, lines: [], truncated: false, writeError: false, logSignal: null, exit: null };

  const command = [DEV_COMMAND.command, ...DEV_COMMAND.args];
  const startedAt = nowIso();
  let child;
  try {
    child = spawn(DEV_COMMAND.command, DEV_COMMAND.args, {
      cwd: themeDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });
  } catch (e) {
    throw refuse('DEV_SESSION_NOT_STARTED', EXIT.NOT_MEASURABLE, `\`${command.join(' ')}\` could not be spawned in ${themeDir}: ${String((e && e.message) || e).slice(0, 300)}`, { command, cwd: themeDir });
  }
  const facts = { pid: child.pid ?? null, startedAt, readyAt: null, readyMs: null, stopMethod: null, stoppedAt: null, exitCode: null, signal: null, exitedBeforeReady: false, logSignal: null, probe: null, settleMs: null, refusal: null };
  child.stdout.on('data', (chunk) => appendLogChunk(state, chunk));
  child.stderr.on('data', (chunk) => appendLogChunk(state, chunk));
  child.on('error', (e) => { state.exit = { error: String((e && e.message) || e).slice(0, 300), at: nowIso() }; });
  child.on('close', (code, signal) => { state.exit = state.exit ?? { exitCode: code, signal, at: nowIso() }; });

  log(`serve: ${command.join(' ')} (cwd ${themeDir}) pid=${facts.pid} probe=${probeUrl} budget=${SERVE_READY_BUDGET_MS}ms`);

  try {
    const deadline = Date.now() + SERVE_READY_BUDGET_MS;
    const logBudget = Math.max(1_000, Math.floor(SERVE_READY_BUDGET_MS * SERVE_LOG_BUDGET_SHARE));
    const logDeadline = Date.now() + logBudget;
    while (!state.logSignal && !state.exit && Date.now() < logDeadline) await sleep(250);
    facts.logSignal = state.logSignal;

    if (state.exit) {
      facts.exitedBeforeReady = true;
      throw refuse('DEV_SESSION_EXITED', EXIT.NOT_MEASURABLE, `\`${command.join(' ')}\` exited before reporting readiness (${state.exit.error ? `error ${state.exit.error}` : `exit ${state.exit.exitCode}${state.exit.signal ? ` signal ${state.exit.signal}` : ''}`})`, {
        command, cwd: themeDir, exit: state.exit, logTail: state.lines.slice(-40), logFile,
      });
    }
    if (!state.logSignal) {
      facts.probe = await probePreview(probeUrl);
      throw refuse('DEV_SESSION_NOT_READY', EXIT.NOT_MEASURABLE, `\`${command.join(' ')}\` printed no readiness pattern (${READY_LOG_PATTERNS.map(String).join(' | ')}) within ${logBudget}ms`, {
        command, cwd: themeDir, logBudgetMs: logBudget, probe: facts.probe, logTail: state.lines.slice(-40), logFile,
      });
    }

    // The copy preview is served remotely, so it can answer after a one-shot dev
    // command has already exited: probe the full budget and only report the exit
    // when the preview never answered.
    let probe = null;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      probe = await probePreview(probeUrl);
      if (probe.ok) break;
      await sleep(Math.min(SERVE_PROBE_INTERVAL_MS, Math.max(250, deadline - Date.now())));
    }
    facts.probe = { ...(probe ?? { ok: false, url: probeUrl, status: null, error: 'the readiness budget expired before the first probe' }), attempts };
    if (!facts.probe.ok) {
      if (state.exit) {
        facts.exitedBeforeReady = true;
        throw refuse('DEV_SESSION_EXITED', EXIT.NOT_MEASURABLE, `\`${command.join(' ')}\` exited (${state.exit.error ? `error ${state.exit.error}` : `exit ${state.exit.exitCode}${state.exit.signal ? ` signal ${state.exit.signal}` : ''}`}) and the copy preview ${probeUrl} never answered (last: ${facts.probe.status ?? facts.probe.error ?? 'no response'})`, {
          command, cwd: themeDir, exit: state.exit, probeUrl, attempts, probe: facts.probe, logTail: state.lines.slice(-40), logFile,
        });
      }
      throw refuse('DEV_PREVIEW_UNREACHABLE', EXIT.NOT_MEASURABLE, `the copy preview ${probeUrl} did not answer with 2xx/3xx within the readiness budget (${SERVE_READY_BUDGET_MS}ms; last: ${facts.probe.status ?? facts.probe.error ?? 'no response'})`, {
        command, probeUrl, attempts, budgetMs: SERVE_READY_BUDGET_MS, probe: facts.probe, logTail: state.lines.slice(-40), logFile,
      });
    }
    facts.readyAt = nowIso();
    facts.readyMs = Date.now() - Date.parse(startedAt);
    facts.settleMs = SERVE_SETTLE_MS;
    await sleep(SERVE_SETTLE_MS);
    log(`serve ready in ${facts.readyMs}ms: probe ${facts.probe.status} (copy assets: ${facts.probe.bodyCarriesCopyThemeId ? 'seen' : 'not seen'}), settled ${SERVE_SETTLE_MS}ms`);
  } catch (e) {
    facts.refusal = asRefusal(e);
    throw facts.refusal;
  } finally {
    facts.stopMethod = await stopChild(child);
    facts.stoppedAt = nowIso();
    facts.exitCode = child.exitCode ?? null;
    facts.signal = child.signalCode ?? null;
    const serveRecord = {
      kind: 'theme-fidelity-run-serve',
      stage: 'serve',
      status: facts.refusal ? 'REFUSED' : 'SERVED',
      themeDir,
      command,
      cwd: themeDir,
      pid: facts.pid,
      pidAlive: isProcessAlive(facts.pid),
      startedAt,
      readyAt: facts.readyAt,
      readyMs: facts.readyMs,
      stoppedAt: facts.stoppedAt,
      stopMethod: facts.stopMethod,
      settleMs: facts.settleMs,
      readOnlyCopyPreviewProbe: { url: probeUrl, themeId: COPY_THEME_ID },
      readiness: { budgetMs: SERVE_READY_BUDGET_MS, logSignal: facts.logSignal, probe: facts.probe, patterns: READY_LOG_PATTERNS.map(String) },
      child: { pid: facts.pid, exitCode: facts.exitCode, signal: facts.signal, exitedBeforeReady: facts.exitedBeforeReady },
      theme: { settingsFile: settings.file, settingsSha256: settings.sha256, hashContract: settings.hashContract, themeId: settings.themeId, orgId: settings.orgId, themeName: settings.themeName },
      preflight: { file: relTo(outDir, preflightFile), sha256: preflight.sha256, hashContract: preflight.hashContract },
      log: { file: relTo(outDir, logFile), bytes: state.fileBytes, truncated: state.truncated, writeError: state.writeError, ...textDigest(fs.readFileSync(logFile, 'utf8')), tail: state.lines.slice(-40) },
      refusal: facts.refusal ? { code: facts.refusal.code, exitCode: facts.refusal.exitCode, message: facts.refusal.message, detail: facts.refusal.detail } : null,
      finishedAt: nowIso(),
    };
    writeJsonFile(serveFile, serveRecord);
    record.commands.push([DEV_COMMAND.command, ...DEV_COMMAND.args]);
    record.spawned = true;
    record.childPid = facts.pid;
    record.stopMethod = facts.stopMethod;
    record.themeIds = [COPY_THEME_ID];
    record.themeIdsSource = `${ARTIFACTS.themeSettings} theme_id=${settings.themeId} (the dev session's write target)`;
    record.writeTargets = [COPY_THEME_ID];
    record.readOnlyCopyPreviews = [probeUrl];
    record.artifacts = [ARTIFACTS.serve, ARTIFACTS.devLog];
  }
  if (record.stopMethod !== 'sigterm' && record.stopMethod !== 'exited') {
    log(`serve: child stop method ${record.stopMethod}`);
  }
  return { exitCode: EXIT.OK };
}

// ── subject ───────────────────────────────────────────────────────────────────

async function subjectWork(options, record) {
  const outDir = path.resolve(options.out);
  requireArtifact(outDir, ARTIFACTS.preflight, 'subject', 'preflight record');
  const subjectInventory = requireArtifact(outDir, path.join(ARTIFACTS.inventories, 'subject.json'), 'subject', 'subject inventory');
  const r1Index = requireArtifact(outDir, path.join(ARTIFACTS.r1, 'index.json'), 'subject', 'pinned R1 reference index');
  const serveFile = requireArtifact(outDir, ARTIFACTS.serve, 'subject', 'serve record');
  const serveRecord = readJsonArtifact(serveFile, 'ARTIFACT_UNREADABLE', EXIT.NOT_MEASURABLE, 'serve record');
  if (serveRecord.value?.status !== 'SERVED') {
    throw refuse('DEV_SESSION_NOT_SERVED', EXIT.NOT_MEASURABLE, `${serveFile} records status ${serveRecord.value?.status ?? '<none>'}; the subject must be captured after the dev session served the local source`, { file: serveFile });
  }

  const pinned = readJsonArtifact(r1Index, 'SIDE_INDEX_UNREADABLE', EXIT.NOT_MEASURABLE, 'pinned R1 reference index');
  const pinnedLabels = Array.isArray(pinned.value?.viewports) ? pinned.value.viewports.map((v) => v.label) : [];
  if (!pinnedLabels.length) throw refuse('SIDE_INDEX_UNREADABLE', EXIT.NOT_MEASURABLE, `${r1Index} carries no pinned viewport set`, { file: r1Index });
  const viewportList = options.viewportList ?? parseViewportSpec(pinnedLabels.join(','));
  const spec = viewportList.map((v) => v.label).join(',');
  if (spec !== pinnedLabels.join(',')) {
    throw refuse('VIEWPORT_SET_MISMATCH', EXIT.NOT_MEASURABLE, `the subject would capture ${spec} but the pinned R1 reference holds ${pinnedLabels.join(',')}; a pair set that cannot be paired is refused before any capture`, {
      requested: spec,
      pinned: pinnedLabels.join(','),
      file: r1Index,
    });
  }

  fs.rmSync(path.join(outDir, ARTIFACTS.subject), { recursive: true, force: true });
  const argv = [TOOLS.harness, 'capture', '--role', 'subject', '--label', 's1-subject', '--inventory', subjectInventory, '--out', path.join(outDir, ARTIFACTS.subject), '--viewports', spec, '--allow-theme', COPY_THEME_ID];
  log(`subject: s1-subject capture over ${spec}`);
  const run = await execTool({ argv, timeoutMs: HARNESS_TIMEOUT_MS });
  record.commands.push(run.command);
  const indexFile = path.join(outDir, ARTIFACTS.subject, 'index.json');
  const indexLoaded = isFile(indexFile) ? readJsonArtifact(indexFile, 'SIDE_INDEX_UNREADABLE', EXIT.NOT_MEASURABLE, 'subject capture index') : null;
  const childRefusal = parseChildRefusal(run.stderr, indexLoaded?.value?.refusal ?? null) ?? refusalFromCaptureIndex(indexLoaded?.value ?? null);
  if (run.spawnError) throw refuse('CAPTURE_NOT_MEASURABLE', EXIT.NOT_MEASURABLE, `subject capture could not be spawned: ${run.spawnError}`, { command: run.command, spawnError: run.spawnError });
  if (run.timedOut) throw refuse('CAPTURE_TIMED_OUT', EXIT.NOT_MEASURABLE, `subject capture exceeded ${HARNESS_TIMEOUT_MS}ms and was killed`, { command: run.command, childExitCode: run.exitCode, stderrTail: tailOf(run.stderr) });
  if (run.exitCode !== 0) {
    const text = childRefusal ? `${childRefusal.code ?? 'REFUSED'}: ${childRefusal.message}` : `no typed refusal text; stderr tail: ${tailOf(run.stderr, 12).join(' | ')}`;
    throw refuse('CAPTURE_REFUSED', EXIT.NOT_MEASURABLE, `subject capture exited ${run.exitCode}: ${text}`, { childExitCode: run.exitCode, childRefusal, safetyRefusal: run.exitCode === EXIT.REFUSAL, indexFile: isFile(indexFile) ? indexFile : null, stderrTail: tailOf(run.stderr, 20) });
  }
  if (!indexLoaded) throw refuse('CAPTURE_INDEX_ABSENT', EXIT.NOT_MEASURABLE, `subject capture exited 0 but wrote no index at ${indexFile}`, { indexFile });
  const summary = summarizeCaptureIndex('subject', indexLoaded);
  if (summary.status !== 'COMPLETE') {
    const derived = refusalFromCaptureIndex(indexLoaded.value);
    throw refuse('CAPTURE_INCOMPLETE', EXIT.NOT_MEASURABLE, `subject capture status is ${summary.status}: ${summary.captured ?? '?'}/${summary.requested ?? '?'} captured${summary.refusal ? ` (refused ${summary.refusal.code})` : derived ? ` — ${derived.message}` : ''}`, { indexFile, summary });
  }

  const preflight = readJsonArtifact(path.join(outDir, ARTIFACTS.preflight), 'PREFLIGHT_UNREADABLE', EXIT.NOT_MEASURABLE, 'preflight record');
  const derived = deriveInventories({
    store: preflight.value?.store,
    surfaces: (preflight.value?.targets ?? []).filter((t) => t.kind === 'surface').map((t) => ({ name: t.name, url: t.sourceUrl, template: t.template ?? undefined, source: t.source ?? undefined })),
    views: (preflight.value?.targets ?? []).filter((t) => t.kind === 'view').map((t) => ({ name: t.name, url: t.sourceUrl, template: t.template ?? undefined, source: t.source ?? undefined })),
  });
  const home = probeTargetOf(derived);
  if (!home) throw refuse('PREFLIGHT_INCOMPLETE', EXIT.NOT_MEASURABLE, 'the preflight record resolved no surface to compare for served drift', { file: path.join(outDir, ARTIFACTS.preflight) });

  const driftViewports = [];
  for (const viewport of viewportList) {
    const slug = pairKey(home.slug, viewport.label);
    const referenceFile = path.join(outDir, ARTIFACTS.r1, `${slug}.json`);
    const subjectFile = path.join(outDir, ARTIFACTS.subject, `${slug}.json`);
    const reference = loadOptional(referenceFile, EXIT.NOT_MEASURABLE, `pinned R1 capture for ${home.name}@${viewport.label}`);
    const subject = loadOptional(subjectFile, EXIT.NOT_MEASURABLE, `subject capture for ${home.name}@${viewport.label}`);
    if (!reference || !subject) {
      throw refuse('DRIFT_EVIDENCE_ABSENT', EXIT.NOT_MEASURABLE, `the served-drift proof needs both ${referenceFile} and ${subjectFile}; a missing capture is not an unchanged copy`, {
        surface: home.name,
        viewport: viewport.label,
        referenceFile: isFile(referenceFile) ? referenceFile : null,
        subjectFile: isFile(subjectFile) ? subjectFile : null,
      });
    }
    const referenceDigest = reference.value?.provenance?.domDigest ?? reference.value?.dom?.sha256 ?? null;
    const subjectDigest = subject.value?.provenance?.domDigest ?? subject.value?.dom?.sha256 ?? null;
    if (!referenceDigest || !subjectDigest) {
      throw refuse('DRIFT_EVIDENCE_UNREADABLE', EXIT.NOT_MEASURABLE, `the captured DOM digests for ${home.name}@${viewport.label} are absent, so the served change cannot be recorded`, { referenceFile, subjectFile });
    }
    driftViewports.push({
      viewport: viewport.label,
      changed: referenceDigest !== subjectDigest,
      referenceDomDigest: referenceDigest,
      subjectDomDigest: subjectDigest,
      referenceFile: relTo(outDir, referenceFile),
      subjectFile: relTo(outDir, subjectFile),
      referenceCapturedAt: reference.value?.provenance?.capturedAt ?? null,
      subjectCapturedAt: subject.value?.provenance?.capturedAt ?? null,
    });
  }

  const drift = {
    kind: 'theme-fidelity-run-served-drift',
    stage: 'subject',
    store: preflight.value?.store ?? null,
    homeSurface: home.name,
    viewportSpec: spec,
    anyChanged: driftViewports.some((v) => v.changed),
    changedViewports: driftViewports.filter((v) => v.changed).map((v) => v.viewport),
    note: 'the dev session uploads the local source onto the theme copy; a subject DOM digest equal to the pinned reference digest means the served copy did not change, so the dev target is not proven to be the copy',
    devSession: { file: relTo(outDir, serveFile), pid: serveRecord.value?.pid ?? null, readyAt: serveRecord.value?.readyAt ?? null, stopMethod: serveRecord.value?.stopMethod ?? null },
    reference: { indexFile: relTo(outDir, r1Index), indexSha256: pinned.sha256, hashContract: pinned.hashContract },
    viewports: driftViewports,
    generatedAt: nowIso(),
  };
  drift.instrument = instrumentBlock(drift.generatedAt);
  writeJsonFile(path.join(outDir, ARTIFACTS.drift), drift);

  record.themeIds = [COPY_THEME_ID];
  record.themeIdsSource = `${relTo(outDir, subjectInventory)} (themeid=${COPY_THEME_ID})`;
  record.spawned = true;
  record.artifacts = [relTo(outDir, indexFile), ARTIFACTS.drift, ...driftViewports.map((v) => v.subjectFile)];
  log(`subject OK: ${summary.captured}/${summary.requested} captured; served change on ${home.name}: ${drift.anyChanged ? `yes (${drift.changedViewports.join(', ')})` : 'no viewport changed'}`);
  return { exitCode: EXIT.OK };
}

// ── compare ───────────────────────────────────────────────────────────────────

/**
 * Stamp the instrument identity into a child-produced verdict set index, returning the
 * instrument block written. The parent owns aggregation and pins the set index digest into
 * compare-index.json, so the stamp must land here — before that digest is taken — or a set
 * produced by a different tool revision would still read as a homogeneous campaign. The
 * epoch is the index's own finish time, so the block describes when that set was minted.
 */
export function stampVerdictSetIndex(file, what = 'verdict index') {
  const staged = readJsonArtifact(file, 'VERDICT_INDEX_UNREADABLE', EXIT.NOT_MEASURABLE, what);
  if (!staged.value || typeof staged.value !== 'object') return null;
  staged.value.instrument = instrumentBlock(staged.value.finishedAt ?? staged.value.startedAt ?? null);
  writeJsonFile(file, staged.value);
  return staged.value.instrument;
}

async function compareWork(options, record) {
  const outDir = path.resolve(options.out);
  const subjectDir = path.join(outDir, ARTIFACTS.subject);
  const referenceDirs = { r1: path.join(outDir, ARTIFACTS.r1), r2: path.join(outDir, ARTIFACTS.r2) };
  const indexes = {};
  for (const side of ['r1', 'r2', 'subject']) {
    const rel = side === 'subject' ? path.join(ARTIFACTS.subject, 'index.json') : path.join(ARTIFACTS[side], 'index.json');
    const file = requireArtifact(outDir, rel, 'compare', `${side} capture index`);
    indexes[side] = readJsonArtifact(file, 'SIDE_INDEX_UNREADABLE', EXIT.NOT_MEASURABLE, `${side} capture index`);
    if (indexes[side].value?.kind !== 'theme-fidelity-capture-index') {
      throw refuse('SIDE_INDEX_UNREADABLE', EXIT.NOT_MEASURABLE, `${file} is not a theme-fidelity capture index (kind=${indexes[side].value?.kind ?? null})`, { side, file });
    }
  }

  const keysOf = (index) => (Array.isArray(index.value?.targets) ? index.value.targets : []).filter((t) => t.surface && t.viewport).map((t) => pairKey(t.surface, t.viewport));
  const subjectKeys = new Set(keysOf(indexes.subject));
  const incomplete = [];
  for (const side of ['r1', 'r2']) {
    const referenceKeys = new Set(keysOf(indexes[side]));
    const referenceOnly = [...referenceKeys].filter((k) => !subjectKeys.has(k)).sort();
    const subjectOnly = [...subjectKeys].filter((k) => !referenceKeys.has(k)).sort();
    if (referenceOnly.length || subjectOnly.length) {
      const describe = (keys) => keys.map((k) => k.replace('__', '@')).join(', ');
      const parts = [];
      if (referenceOnly.length) parts.push(`only in ${side}: ${describe(referenceOnly)}`);
      if (subjectOnly.length) parts.push(`only in subject: ${describe(subjectOnly)}`);
      incomplete.push({ set: `${side}-vs-subject`, side, referenceOnly, subjectOnly, reason: parts.join('; ') });
    }
  }
  if (incomplete.length) {
    const setNames = Array.from(new Set(incomplete.map((i) => i.set)));
    throw refuse('PAIR_SET_INCOMPLETE', EXIT.NOT_MEASURABLE, `the ${setNames.join(' and ')} pair set is incomplete: ${incomplete.map((i) => i.reason).join(' | ')}`, { incomplete });
  }

  const sets = {};
  let failed = null;
  for (const set of COMPARE_SETS) {
    const setDir = path.join(outDir, ARTIFACTS.compare, set.name);
    fs.rmSync(setDir, { recursive: true, force: true });
    const argv = [TOOLS.harness, 'compare', '--reference', referenceDirs[set.reference], '--subject', subjectDir, '--out', setDir];
    log(`compare ${set.name}: ${set.label}`);
    const run = await execTool({ argv, timeoutMs: HARNESS_TIMEOUT_MS });
    record.commands.push(run.command);
    const indexFile = path.join(setDir, 'index.json');
    // The parent owns aggregation, so the instrument identity of this set's generation is
    // stamped here — before the set index digest is pinned into compare-index.json — so a
    // set index minted by a different tool revision than its sibling is visible in the bytes
    // the compare index records, not only inside the child's own document.
    if (isFile(indexFile)) stampVerdictSetIndex(indexFile, `${set.name} verdict index`);
    const indexLoaded = isFile(indexFile) ? readJsonArtifact(indexFile, 'VERDICT_INDEX_UNREADABLE', EXIT.NOT_MEASURABLE, `${set.name} verdict index`) : null;
    const childRefusal = parseChildRefusal(run.stderr, indexLoaded?.value?.refusal ?? null);
    const verdicts = (indexLoaded?.value?.pairs ?? []).map((pair) => ({
      surface: pair.surface,
      viewport: pair.viewport,
      status: pair.status ?? null,
      verdict: pair.verdict ?? null,
      mechanism: pair.mechanism ?? null,
      mismatchPercentage: pair.mismatchPercentage ?? null,
      referenceHeight: pair.referenceHeight ?? null,
      subjectHeight: pair.subjectHeight ?? null,
      file: pair.file ?? null,
      path: pair.file ? relTo(outDir, path.join(setDir, pair.file)) : null,
    }));
    sets[set.name] = {
      name: set.name,
      label: set.label,
      referenceDir: relTo(outDir, referenceDirs[set.reference]),
      subjectDir: relTo(outDir, subjectDir),
      out: relTo(outDir, setDir),
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      status: indexLoaded?.value?.status ?? null,
      indexFile: indexLoaded ? relTo(outDir, indexFile) : null,
      indexSha256: indexLoaded?.sha256 ?? null,
      hashContract: indexLoaded?.hashContract ?? null,
      totals: indexLoaded?.value?.totals ?? null,
      reference: indexLoaded?.value?.reference ?? null,
      subject: indexLoaded?.value?.subject ?? null,
      strictParams: indexLoaded?.value?.strictParams ?? null,
      verdicts,
      childRefusal,
      refusal: indexLoaded?.value?.refusal ?? null,
      stderrTail: run.exitCode === 0 ? null : tailOf(run.stderr, 20),
    };
    if (run.spawnError || run.timedOut || run.exitCode !== 0 || !indexLoaded) {
      const why = run.spawnError ? `could not be spawned: ${run.spawnError}` : run.timedOut ? `exceeded ${HARNESS_TIMEOUT_MS}ms` : `exited ${run.exitCode}`;
      const text = childRefusal ? `${childRefusal.code ?? 'REFUSED'}: ${childRefusal.message}` : indexLoaded?.value?.refusal?.message ?? null;
      failed = failed ?? { set: set.name, reason: `${set.name} ${why}${text ? ` (${text})` : ''}`, setDir };
    }
  }

  const compareIndex = {
    kind: 'theme-fidelity-run-compare-index',
    stage: 'compare',
    status: failed ? 'INCOMPLETE' : 'COMPLETE',
    generatedAt: nowIso(),
    viewportSet: indexes.r1.value.viewports?.map((v) => v.label) ?? null,
    pairCount: subjectKeys.size,
    sets,
    referenceIndexes: Object.fromEntries(['r1', 'r2'].map((side) => [side, { file: relTo(outDir, indexes[side].file), sha256: indexes[side].sha256, hashContract: indexes[side].hashContract, label: indexes[side].value.label ?? null, status: indexes[side].value.status ?? null }])),
    subjectIndex: { file: relTo(outDir, indexes.subject.file), sha256: indexes.subject.sha256, hashContract: indexes.subject.hashContract, label: indexes.subject.value.label ?? null, status: indexes.subject.value.status ?? null },
    refusal: null,
  };
  compareIndex.instrument = instrumentBlock(compareIndex.generatedAt);
  writeJsonFile(path.join(outDir, ARTIFACTS.compareIndex), compareIndex);

  record.themeIds = Array.from(new Set([COPY_THEME_ID, LIVE_PREVIEW_THEME_ID]));
  record.themeIdsSource = `${relTo(outDir, indexes.r1.file)}/index (themeid=${COPY_THEME_ID}), ${relTo(outDir, indexes.r2.file)}/index (themeid=${LIVE_PREVIEW_THEME_ID}), ${relTo(outDir, indexes.subject.file)} (themeid=${COPY_THEME_ID})`;
  record.spawned = true;
  record.artifacts = [ARTIFACTS.compareIndex, ...COMPARE_SETS.map((s) => path.posix.join(ARTIFACTS.compare, s.name, 'index.json'))];

  if (failed) {
    throw refuse('VERDICT_SET_INCOMPLETE', EXIT.NOT_MEASURABLE, `${failed.reason}; the verdict set is incomplete`, { set: failed.set, setDir: relTo(outDir, failed.setDir), sets: Object.fromEntries(Object.entries(sets).map(([name, s]) => [name, { exitCode: s.exitCode, status: s.status, totals: s.totals, refusal: s.refusal }])) });
  }
  log(`compare OK: ${COMPARE_SETS.map((s) => `${s.name}=${sets[s.name].verdicts.length}`).join(' ')} verdict document(s)`);
  return { exitCode: EXIT.OK };
}

// ── checks ────────────────────────────────────────────────────────────────────

async function checksWork(options, record) {
  const outDir = path.resolve(options.out);
  const themeDir = path.resolve(options.theme);
  if (!isDir(themeDir)) throw refuse('THEME_DIR_UNREADABLE', EXIT.USAGE, `--theme ${themeDir} is not a directory`, { themeDir });
  const domDir = path.join(outDir, ARTIFACTS.subject, 'dom');
  if (!isDir(domDir)) {
    throw refuse('SUBJECT_HTML_ABSENT', EXIT.NOT_MEASURABLE, `${domDir} does not exist; the checks stage needs the captured HTML dumps the subject stage writes`, { domDir });
  }
  const htmlFiles = fs.readdirSync(domDir).filter((name) => name.toLowerCase().endsWith('.html')).sort().map((name) => path.join(domDir, name));
  if (!htmlFiles.length) {
    throw refuse('SUBJECT_HTML_ABSENT', EXIT.NOT_MEASURABLE, `${domDir} contains no captured HTML dump, so no rendered page can be checked`, { domDir });
  }

  const structuralFile = path.join(outDir, ARTIFACTS.structural);
  const argv = [TOOLS.checks, '--theme', themeDir, ...htmlFiles.flatMap((file) => ['--html', file]), '--out', structuralFile];
  log(`checks: ${htmlFiles.length} captured page(s) over ${themeDir}`);
  const run = await execTool({ argv, timeoutMs: CHECKS_TIMEOUT_MS });
  record.commands.push(run.command);

  let structural = null;
  let structuralLoaded = null;
  if (isFile(structuralFile)) {
    try {
      structuralLoaded = readJsonArtifact(structuralFile, 'ARTIFACT_UNREADABLE', EXIT.NOT_MEASURABLE, 'structural report');
      structural = structuralLoaded.value;
    } catch (e) {
      if (!isRefusal(e)) throw e;
      structuralLoaded = null;
    }
  }
  const childRefusal = parseChildRefusal(run.stderr, null);
  const status = run.exitCode === 0 ? CHECKS_STATUS.CLEAN : (run.exitCode === 3 && structural ? CHECKS_STATUS.REFUSED : CHECKS_STATUS.FAILED);
  const checks = {
    kind: 'theme-fidelity-run-checks',
    stage: 'checks',
    status,
    themeDir,
    generatedAt: nowIso(),
    childExitCode: run.exitCode,
    childTimedOut: run.timedOut,
    childSpawnError: run.spawnError,
    childRefusal,
    htmlInputs: htmlFiles.map((file) => relTo(outDir, file)),
    structural: structuralLoaded ? {
      file: relTo(outDir, structuralFile),
      sha256: structuralLoaded.sha256,
      hashContract: structuralLoaded.hashContract,
      ok: structural.ok ?? null,
      generatedAt: structural.generatedAt ?? null,
      refusalCount: Array.isArray(structural.refusals) ? structural.refusals.length : null,
      refusals: structural.refusals ?? null,
      counts: { schemas: structural.schemas?.failures?.length ?? null, settingsBinding: structural.settingsBinding?.failures?.length ?? null, assets: structural.assets?.localMissing?.length ?? null, renders: Array.isArray(structural.renders) ? structural.renders.length : null },
    } : null,
    stdoutTail: tailOf(run.stdout, 20),
    stderrTail: tailOf(run.stderr, 20),
  };
  checks.instrument = instrumentBlock(checks.generatedAt);
  writeJsonFile(path.join(outDir, ARTIFACTS.checks), checks);

  record.themeIds = [];
  record.themeIdsSource = `${TOOLS.checks} reads the local theme source; it addresses no theme id`;
  record.spawned = true;
  record.artifacts = [ARTIFACTS.checks, isFile(structuralFile) ? ARTIFACTS.structural : null].filter(Boolean);

  if (status === CHECKS_STATUS.FAILED) {
    throw refuse('CHECKS_FAILED', EXIT.NOT_MEASURABLE, `${TOOLS.checks} exited ${run.exitCode}${run.timedOut ? ' (timeout)' : ''} without a readable ${ARTIFACTS.structural}`, { childExitCode: run.exitCode, childRefusal, stderrTail: tailOf(run.stderr, 20) });
  }
  const refusalCount = checks.structural?.refusalCount ?? 0;
  log(`checks ${status}: ${refusalCount} refusal(s) carried into the report`);
  return { exitCode: EXIT.OK };
}

// ── report ────────────────────────────────────────────────────────────────────

/**
 * The pinned digest of a DOM dump. HTML is text, so the harness digests it with CRLF
 * normalised to LF; this projection must carry that contract rather than relabel it
 * byte-exact, or the same dump reads as tampered on a CRLF checkout. The child's declared
 * contract wins; the fallback only covers a document that predates the field.
 */
function domPin(dom) {
  if (!dom) return null;
  return {
    file: dom.file ?? null,
    sha256: dom.sha256 ?? null,
    hashContract: dom.hashContract ?? HASH_CONTRACT.LF_NORMALIZED,
    bytes: dom.bytes ?? null,
    observedUrl: dom.observedUrl ?? null,
  };
}

/** The pinned digest of a PNG. PNG is binary, so it is byte-exact; the child's declared contract wins. */
function pngPin(png) {
  if (!png) return null;
  return { file: png.file ?? null, sha256: png.sha256 ?? null, hashContract: png.hashContract ?? HASH_CONTRACT.BYTE_EXACT, bytes: png.bytes ?? null };
}

/** Project one capture document into the report shape, naming each recorded digest contract. */
export function projectCaptureDoc(loaded, side) {
  const doc = loaded.value;
  if (!doc || typeof doc !== 'object' || doc.kind !== 'theme-fidelity-capture') {
    throw refuse('CAPTURE_DOC_UNREADABLE', EXIT.NOT_MEASURABLE, `${loaded.file} is not a capture document (kind=${doc?.kind ?? null})`, { side, file: loaded.file });
  }
  const provenance = doc.provenance ?? null;
  return {
    side,
    file: loaded.file,
    sha256: loaded.sha256,
    hashContract: loaded.hashContract,
    status: doc.status ?? null,
    capturedAt: provenance?.capturedAt ?? null,
    url: doc.url ?? provenance?.url ?? null,
    themeId: provenance?.themeId ?? null,
    themeIdParameter: provenance?.themeIdParameter ?? null,
    domDigest: provenance?.domDigest ?? doc.dom?.sha256 ?? null,
    dom: domPin(doc.dom),
    png: pngPin(doc.png),
    geometry: provenance?.geometry ? { docHeight: provenance.geometry.docHeight ?? null, sectionCount: provenance.geometry.sectionCount ?? null } : null,
    tabIdentity: provenance?.tabIdentity ? { device: provenance.tabIdentity.device ?? null, innerWidth: provenance.tabIdentity.innerWidth ?? null, innerHeight: provenance.tabIdentity.innerHeight ?? null } : null,
    instance: provenance?.instance ?? null,
    run: provenance?.run ?? null,
    failure: doc.failure ?? null,
  };
}

export function projectVerdictDoc(loaded, setDir, outDir) {
  const doc = loaded.value;
  if (!doc || typeof doc !== 'object' || doc.kind !== 'theme-fidelity-verdict') {
    throw refuse('VERDICT_DOC_UNREADABLE', EXIT.NOT_MEASURABLE, `${loaded.file} is not a verdict document (kind=${doc?.kind ?? null})`, { file: loaded.file });
  }
  const side = (p) => (p ? {
    url: p.url ?? null,
    themeId: p.themeId ?? null,
    label: p.label ?? null,
    role: p.role ?? null,
    capturedAt: p.capturedAt ?? null,
    domDigest: p.domDigest ?? p.dom?.sha256 ?? null,
    dom: domPin(p.dom),
    png: pngPin(p.png),
    geometry: p.geometry ? { docHeight: p.geometry.docHeight ?? null, sectionCount: p.geometry.sectionCount ?? null } : null,
  } : null);
  return {
    file: relTo(outDir, loaded.file),
    sha256: loaded.sha256,
    hashContract: loaded.hashContract,
    status: doc.status ?? null,
    verdict: doc.verdict ?? null,
    mechanism: doc.mechanism ?? null,
    reason: doc.reason ?? null,
    mismatchPercentage: doc.compare?.mismatchPercentage ?? null,
    strictParams: doc.strictParams ?? null,
    identity: doc.identity ?? null,
    measurement: doc.measurement ? {
      reference: { docHeight: doc.measurement.reference?.docHeight ?? null, geometrySha256: doc.measurement.reference?.geometrySha256 ?? null },
      subject: { docHeight: doc.measurement.subject?.docHeight ?? null, geometrySha256: doc.measurement.subject?.geometrySha256 ?? null },
    } : null,
    reference: side(doc.provenance?.reference),
    subject: side(doc.provenance?.subject),
    finishedAt: doc.finishedAt ?? null,
    printLine: doc.printLine ?? null,
    // Leg-generation evidence the child minted: a leg produced by a different instrument
    // revision than its set index, or one adjudicated despite a recorded provenance drift or
    // a withheld cross-side identity, must survive into the report rather than be projected away.
    instrumentRevision: doc.instrumentRevision ?? null,
    provenanceDrift: doc.provenanceDrift ?? null,
    crossSideIdentity: doc.crossSideIdentity ?? null,
    settlePasses: doc.settlePasses ?? null,
    setDir: relTo(outDir, setDir),
  };
}

/** Read one optional capture side and the per-target documents the report cites. */
function readSideCapture(outDir, side, exitCode) {
  const dir = path.join(outDir, side);
  const indexFile = path.join(dir, 'index.json');
  if (!fs.existsSync(indexFile)) return null;
  const loaded = readJsonArtifact(indexFile, 'SIDE_INDEX_UNREADABLE', exitCode, `${side} capture index`);
  if (loaded.value?.kind !== 'theme-fidelity-capture-index') {
    throw refuse('SIDE_INDEX_UNREADABLE', exitCode, `${indexFile} is not a theme-fidelity capture index (kind=${loaded.value?.kind ?? null})`, { side, file: indexFile });
  }
  return { side, dir, file: indexFile, sha256: loaded.sha256, hashContract: loaded.hashContract, index: loaded.value, targets: Array.isArray(loaded.value.targets) ? loaded.value.targets : [] };
}

function readVerdictSet(outDir, name, exitCode) {
  const dir = path.join(outDir, ARTIFACTS.compare, name);
  const indexFile = path.join(dir, 'index.json');
  if (!fs.existsSync(indexFile)) return null;
  const loaded = readJsonArtifact(indexFile, 'VERDICT_INDEX_UNREADABLE', exitCode, `${name} verdict index`);
  if (loaded.value?.kind !== 'theme-fidelity-verdict-index') {
    throw refuse('VERDICT_INDEX_UNREADABLE', exitCode, `${indexFile} is not a theme-fidelity verdict index (kind=${loaded.value?.kind ?? null})`, { name, file: indexFile });
  }
  return { name, dir, file: indexFile, sha256: loaded.sha256, hashContract: loaded.hashContract, index: loaded.value, pairs: Array.isArray(loaded.value.pairs) ? loaded.value.pairs : [] };
}

function renderReportMarkdown(report) {
  const lines = [];
  lines.push(`# Haravan customize-theme fidelity run — ${mdCell(report.provenance.store)}`);
  lines.push('');
  lines.push(`- status: **${report.status}**`);
  lines.push(`- generated: ${report.generatedAt}`);
  lines.push(`- out: \`${mdCell(report.outDir)}\``);
  lines.push(`- verdicts expected: ${report.expectedPairCount} (${report.targets.length} target(s) x ${report.viewports.length} viewport(s))`);
  lines.push('');
  lines.push('## Provenance');
  lines.push('');
  lines.push(`- store: ${mdCell(report.provenance.store)}`);
  lines.push(`- copy theme: ${mdCell(report.provenance.copyThemeId)} (org ${mdCell(report.provenance.theme.orgId)}) \`${mdCell(report.provenance.theme.themeName)}\``);
  lines.push(`- live preview (read-only): ${mdCell(report.provenance.livePreviewThemeId)}; live theme never addressed: ${mdCell(report.provenance.liveThemeIdNeverAddressed)}`);
  lines.push(`- theme settings: \`${mdCell(report.provenance.theme.file)}\` sha256 ${mdCell(report.provenance.theme.sha256)}`);
  lines.push(`- inventory: \`${mdCell(report.provenance.inventory.file)}\` sha256 ${mdCell(report.provenance.inventory.sha256)} (${report.provenance.inventory.surfaces} surface(s), ${report.provenance.inventory.views} view(s), ${report.provenance.inventory.unresolved} unresolved)`);
  lines.push(`- references: R1 ${mdCell(describeReference(report.provenance.references?.r1))} / R2 ${mdCell(describeReference(report.provenance.references?.r2))}`);
  lines.push(`- dev session: pid ${mdCell(report.provenance.devSession?.pid)} ready ${mdCell(report.provenance.devSession?.readyAt)} stop ${mdCell(report.provenance.devSession?.stopMethod)}`);
  lines.push(`- structural checks: ${mdCell(report.provenance.checks?.status)} (${mdCell(report.provenance.checks?.structural?.refusalCount)} refusal(s))`);
  lines.push('');
  lines.push('## Verdicts');
  lines.push('');
  lines.push('| surface | viewport | r1 vs subject | mismatch % | r2 vs subject | mismatch % |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of report.surfaceMatrix) {
    for (const viewport of row.viewports) {
      const r1 = viewport.verdicts[COMPARE_SETS[0].name];
      const r2 = viewport.verdicts[COMPARE_SETS[1].name];
      lines.push(`| ${mdCell(row.name)} | ${mdCell(viewport.viewport)} | ${mdCell(r1?.verdict ?? `NOT MEASURED (${r1?.reason ?? 'no verdict document'})`)} | ${mdCell(r1?.mismatchPercentage)} | ${mdCell(r2?.verdict ?? `NOT MEASURED (${r2?.reason ?? 'no verdict document'})`)} | ${mdCell(r2?.mismatchPercentage)} |`);
    }
  }
  lines.push('');
  lines.push('## Reference identity');
  lines.push('');
  lines.push('| surface | viewport | reference | method | status | pinned height | measured height | drift px | dom digest |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of report.surfaceMatrix) {
    for (const viewport of row.viewports) {
      for (const key of ['r1', 'r2']) {
        const identity = viewport.referenceIdentity[key];
        lines.push(`| ${mdCell(row.name)} | ${mdCell(viewport.viewport)} | ${key} | ${mdCell(identity.method)} | ${mdCell(identity.status)} | ${mdCell(identity.pinnedDocHeight)} | ${mdCell(identity.measuredDocHeight)} | ${mdCell(identity.driftPx)} | ${mdCell(identity.domDigest)} |`);
      }
    }
  }
  lines.push('');
  lines.push('## Served drift (proof the dev target is the copy)');
  lines.push('');
  if (report.provenance.subjectDrift) {
    lines.push(`- home surface: ${mdCell(report.provenance.subjectDrift.homeSurface)}; changed: ${report.provenance.subjectDrift.anyChanged ? 'yes' : 'no'}${report.provenance.subjectDrift.changedViewports?.length ? ` (${mdCell(report.provenance.subjectDrift.changedViewports.join(', '))})` : ''}`);
  } else {
    lines.push('- not recorded: the subject drift artifact is absent');
  }
  lines.push('');
  lines.push('## Structural findings');
  lines.push('');
  const structural = report.structuralFindings;
  lines.push(`- checks: ${mdCell(structural.checksStatus)}; structural report: ${structural.structuralFile ? `\`${mdCell(structural.structuralFile)}\`` : 'absent'}`);
  lines.push(`- refusal list (${structural.refusals.length}):`);
  for (const refusal of structural.refusals.slice(0, 40)) {
    lines.push(`  - ${mdCell(refusal.check ?? refusal.rule ?? 'check')}${refusal.file ? ` (${mdCell(refusal.file)})` : ''}: ${mdCell(JSON.stringify(refusal.failures ?? refusal).slice(0, 300))}`);
  }
  lines.push('');
  lines.push('## Safety audit');
  lines.push('');
  const audit = report.safetyAudit;
  lines.push(`- commands recorded: ${audit.commands}`);
  lines.push(`- allowed theme ids: ${mdCell(audit.allowedThemeIds.join(', '))}`);
  lines.push(`- theme ids addressed: ${mdCell(audit.themeIds.join(', ') || '<none>')}`);
  lines.push(`- commands addressing anything other than -1 or ${mdCell(report.provenance.copyThemeId)}: **${audit.foreignThemeIds.count}** (must be zero)`);
  lines.push(`- publish/deploy/push commands: ${audit.publishDeployPush.absent ? 'absent (audited)' : `PRESENT: ${mdCell(audit.publishDeployPush.matches.map((m) => m.token).join(', '))}`}`);
  lines.push(`- read-only live-preview reads (${audit.livePreviewReads.length}):`);
  for (const url of audit.livePreviewReads.slice(0, 60)) lines.push(`  - ${mdCell(url)}`);
  lines.push(`- read-only copy-preview reads (${audit.copyPreviewReads.length}):`);
  for (const url of audit.copyPreviewReads.slice(0, 60)) lines.push(`  - ${mdCell(url)}`);
  lines.push(`- remote writes (${audit.remoteWrites.length}):`);
  for (const write of audit.remoteWrites) lines.push(`  - ${mdCell(write.stage)} -> theme ${mdCell(write.writeTargets.join(', '))} (${mdCell(write.stopMethod)})`);
  lines.push('');
  lines.push('## Not measured');
  lines.push('');
  for (const item of report.notMeasured) lines.push(`- ${mdCell(item.source)}${item.surface ? ` ${mdCell(item.surface)}${item.viewport ? `@${mdCell(item.viewport)}` : ''}` : ''}: ${mdCell(item.reason)}`);
  if (!report.notMeasured.length) lines.push('- none recorded');
  lines.push('');
  lines.push('## Verdict gaps');
  lines.push('');
  for (const gap of report.gaps) lines.push(`- ${mdCell(gap.surface)}@${mdCell(gap.viewport)} ${mdCell(gap.set)}: ${mdCell(gap.reason)}`);
  if (!report.gaps.length) lines.push('- none');
  lines.push('');
  lines.push('## Publication');
  lines.push('');
  lines.push(`- published: ${report.publication.published ? 'yes' : 'no'}${report.publication.reason ? ` (${mdCell(report.publication.reason)})` : ''}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * The publish predicate: a verdict may only be published when every leg of the campaign
 * completed, the structural checks came back clean, and no gap was recorded against the
 * captured evidence.
 *
 * The checks status is an allowlist, not a denylist: publish requires exactly `CLEAN`, the
 * one status the checks stage mints for a clean run. A `REFUSED`, `FAILED`, or any status a
 * future producer adds (`TIMEOUT`, `ABORTED`, …) refuses — an unrecognised status must fail
 * closed rather than fall through to a publish.
 *
 * Pure by construction — every input is a value and nothing is read from disk — so the
 * gate can be exercised without running a campaign. The defaults are fail-closed: an
 * omitted input must not publish.
 */
export function isPublishComplete({
  capturesComplete = false,
  compareSetsComplete = false,
  missingVerdicts = 0,
  checksPresent = false,
  checksStatus = null,
  structuralPresent = false,
  structuralRefused = false,
  structuralRefusalCount = 0,
  checksGaps = 0,
  driftPresent = false,
} = {}) {
  if (structuralRefused === true || structuralRefusalCount > 0) return false;
  if (!checksPresent || checksStatus !== CHECKS_STATUS.CLEAN) return false;
  if (!capturesComplete || !compareSetsComplete || missingVerdicts > 0) return false;
  if (!structuralPresent || checksGaps > 0 || !driftPresent) return false;
  return true;
}

/**
 * The final status of a campaign report.
 *
 * A structural refusal is not only a non-empty refusal list: the checks stage mints status
 * `REFUSED` precisely when it refused, so a refused checks document whose structural report
 * is missing or whose refusal list is empty must still refuse the run — never fall through
 * to a bare `INCOMPLETE`, which does not name the refusal the V6 requirement is about.
 */
export function runStatus({ auditPass = true, complete = false, checksStatus = null, structuralRefused = false } = {}) {
  if (auditPass === false) return 'REFUSED';
  if (complete) return 'COMPLETE';
  return structuralRefused || checksStatus === CHECKS_STATUS.REFUSED ? 'REFUSED_STRUCTURAL' : 'INCOMPLETE';
}

/**
 * The raw lines of a command log, each keeping its terminator, split exactly the way the
 * pinned prefix is sliced. `readCommandRecords` and `commandLogPrefix` both derive their
 * numbers from this one function, so the recorded raw-line count and the slice cannot
 * disagree.
 */
function commandLogLines(text) {
  const raw = String(text);
  return raw === '' ? [] : raw.split(/(?<=\n)/);
}

/**
 * The command log is append-only and is read before this stage appends its own record, so
 * the digest a report pins can never equal the final file. This returns the exact prefix
 * that pin covers — the first `lines` raw lines with their terminators. The argument is the
 * raw-line count (`rawLines` in the pin), not the parser's record count: blank lines are
 * part of the text the digest covers even though the parser ignores them, so slicing by
 * records makes an unchanged file read as tampered.
 */
export function commandLogPrefix(text, lines) {
  if (!Number.isFinite(lines) || lines <= 0) return '';
  return commandLogLines(text).slice(0, lines).join('');
}

async function reportWork(options, record) {
  const outDir = path.resolve(options.out);
  const preflightFile = requireArtifact(outDir, ARTIFACTS.preflight, 'report', 'preflight record');
  const commandsFile = requireArtifact(outDir, ARTIFACTS.commands, 'report', 'command record');
  const inventoryFiles = {};
  for (const role of ['copy', 'live', 'subject']) {
    const rel = path.join(ARTIFACTS.inventories, `${role}.json`);
    inventoryFiles[role] = requireArtifact(outDir, rel, 'report', `${role} inventory`);
  }

  const preflightLoaded = readJsonArtifact(preflightFile, 'PREFLIGHT_UNREADABLE', EXIT.NOT_MEASURABLE, 'preflight record');
  const preflight = preflightLoaded.value;
  if (preflight?.kind !== 'theme-fidelity-run-preflight') {
    throw refuse('PREFLIGHT_UNREADABLE', EXIT.NOT_MEASURABLE, `${preflightFile} is not a theme-fidelity run preflight record (kind=${preflight?.kind ?? null})`, { file: preflightFile });
  }
  const commandLog = readCommandRecords(commandsFile);
  const audit = auditCommands(commandLog.records, { allowedThemeIds: ALLOWED_THEME_IDS });

  const references = loadOptional(path.join(outDir, ARTIFACTS.references), EXIT.NOT_MEASURABLE, 'references record');
  const sides = {
    r1: readSideCapture(outDir, ARTIFACTS.r1, EXIT.NOT_MEASURABLE),
    r2: readSideCapture(outDir, ARTIFACTS.r2, EXIT.NOT_MEASURABLE),
    subject: readSideCapture(outDir, ARTIFACTS.subject, EXIT.NOT_MEASURABLE),
  };
  const sets = {};
  for (const set of COMPARE_SETS) sets[set.name] = readVerdictSet(outDir, set.name, EXIT.NOT_MEASURABLE);
  const drift = loadOptional(path.join(outDir, ARTIFACTS.drift), EXIT.NOT_MEASURABLE, 'served-drift record');
  const checks = loadOptional(path.join(outDir, ARTIFACTS.checks), EXIT.NOT_MEASURABLE, 'checks record');
  const structural = loadOptional(path.join(outDir, ARTIFACTS.structural), EXIT.NOT_MEASURABLE, 'structural report');
  const serve = loadOptional(path.join(outDir, ARTIFACTS.serve), EXIT.NOT_MEASURABLE, 'serve record');

  const viewportLabels = (() => {
    const fromReferences = references?.value?.viewports?.map((v) => v.label) ?? null;
    if (fromReferences && fromReferences.length) return fromReferences;
    const fromR1 = sides.r1?.index?.viewports?.map((v) => v.label) ?? null;
    if (fromR1 && fromR1.length) return fromR1;
    const fromSubject = sides.subject?.index?.viewports?.map((v) => v.label) ?? null;
    if (fromSubject && fromSubject.length) return fromSubject;
    const fromSet = Array.from(new Set((sets[COMPARE_SETS[0].name]?.pairs ?? []).map((p) => p.viewport).filter(Boolean)));
    if (fromSet.length) return fromSet;
    return [];
  })();

  const targets = Array.isArray(preflight.targets) ? preflight.targets : [];
  const notMeasured = [];
  const gaps = [];
  for (const entry of preflight.inventory?.unresolved ?? []) {
    notMeasured.push({ source: 'inventory', surface: entry.name ?? null, viewport: null, code: 'UNRESOLVED_SURFACE', reason: entry.reason ?? null });
  }
  for (const [side, capture] of Object.entries(sides)) {
    if (!capture) {
      notMeasured.push({ source: `capture:${side}`, surface: null, viewport: null, code: 'STAGE_ARTIFACT_ABSENT', reason: `${path.join(outDir, side, 'index.json')} does not exist, so nothing was captured on the ${side} side` });
      continue;
    }
    if (capture.index.refusal) {
      notMeasured.push({ source: `capture:${side}`, surface: null, viewport: null, code: capture.index.refusal.code ?? 'CAPTURE_REFUSED', reason: `the ${side} capture refused: ${capture.index.refusal.message ?? ''}` });
    }
    for (const target of capture.targets.filter((t) => t.status !== 'CAPTURED')) {
      notMeasured.push({
        source: `capture:${side}`,
        surface: target.surface ?? null,
        viewport: target.viewport ?? null,
        code: target.failure?.code ?? 'NOT_CAPTURED',
        reason: target.failure?.reason ?? `status ${target.status}`,
      });
    }
  }
  for (const set of COMPARE_SETS) {
    const record_ = sets[set.name];
    if (!record_) {
      notMeasured.push({ source: `compare:${set.name}`, surface: null, viewport: null, code: 'STAGE_ARTIFACT_ABSENT', reason: `${path.join(outDir, ARTIFACTS.compare, set.name, 'index.json')} does not exist, so no verdict was produced for ${set.name}` });
      continue;
    }
    if (record_.index.refusal) {
      notMeasured.push({ source: `compare:${set.name}`, surface: null, viewport: null, code: record_.index.refusal.code ?? 'COMPARE_REFUSED', reason: `the ${set.name} comparison refused: ${record_.index.refusal.message ?? ''}` });
    }
  }
  if (!checks) {
    notMeasured.push({ source: 'checks', surface: null, viewport: null, code: 'STAGE_ARTIFACT_ABSENT', reason: `${path.join(outDir, ARTIFACTS.checks)} does not exist, so no structural finding was produced` });
  }

  const verdictDocs = new Map();
  for (const set of COMPARE_SETS) {
    const capture = sets[set.name];
    if (!capture) continue;
    for (const pair of capture.pairs) {
      if (!pair?.file) continue;
      const file = path.join(capture.dir, pair.file);
      if (!isFile(file)) continue;
      verdictDocs.set(`${set.name}|${pairKey(pair.surface, pair.viewport)}`, projectVerdictDoc(readJsonArtifact(file, 'VERDICT_DOC_UNREADABLE', EXIT.NOT_MEASURABLE, `${set.name} verdict document`), capture.dir, outDir));
    }
  }

  const renderFindings = new Map();
  for (const render of structural?.value?.renders ?? []) {
    if (render?.file) renderFindings.set(render.file, render);
  }

  const surfaceMatrix = [];
  for (const target of targets) {
    const row = { name: target.name, kind: target.kind, template: target.template ?? null, sourceUrl: target.sourceUrl ?? null, urls: target.urls ?? null, viewports: [] };
    for (const viewport of viewportLabels) {
      const slug = pairKey(target.slug ?? slugify(target.name), viewport);
      const cell = { viewport, verdicts: {}, referenceIdentity: {}, structural: null, captureProvenance: {} };
      for (const key of ['r1', 'r2']) {
        const file = path.join(outDir, key, `${slug}.json`);
        const loaded = isFile(file) ? readJsonArtifact(file, 'CAPTURE_DOC_UNREADABLE', EXIT.NOT_MEASURABLE, `${key} capture document`) : null;
        const projection = loaded ? projectCaptureDoc(loaded, key) : { side: key, status: 'ABSENT', file, capturedAt: null, url: null, themeId: null, domDigest: null, dom: null, png: null, geometry: null, failure: null };
        if (!loaded) gaps.push({ surface: target.name, viewport, set: null, side: key, reason: `${file} is absent, so the pinned ${key} reference identity is unknown` });
        if (loaded && projection.status !== 'CAPTURED') gaps.push({ surface: target.name, viewport, set: null, side: key, reason: `the ${key} capture status is ${projection.status}: ${projection.failure?.code ?? 'no failure code'}` });
        cell.captureProvenance[key] = { status: projection.status, capturedAt: projection.capturedAt, instancePid: projection.instance?.pid ?? null, runId: projection.run?.runId ?? null, url: projection.url, themeId: projection.themeId };
        cell.referenceIdentity[key] = {
          status: projection.status,
          method: 'pinned capture',
          capturedAt: projection.capturedAt,
          url: projection.url,
          themeId: projection.themeId,
          domDigest: projection.domDigest,
          domDigestHashContract: projection.dom?.hashContract ?? HASH_CONTRACT.LF_NORMALIZED,
          pinnedDocHeight: projection.geometry?.docHeight ?? null,
          measuredDocHeight: null,
          driftPx: null,
          pngSha256: projection.png?.sha256 ?? null,
          pngHashContract: projection.png?.hashContract ?? HASH_CONTRACT.BYTE_EXACT,
          file: relTo(outDir, file),
        };
      }
      const subjectFile = path.join(outDir, ARTIFACTS.subject, `${slug}.json`);
      const subjectLoaded = isFile(subjectFile) ? readJsonArtifact(subjectFile, 'CAPTURE_DOC_UNREADABLE', EXIT.NOT_MEASURABLE, 'subject capture document') : null;
      cell.captureProvenance.subject = subjectLoaded ? (() => { const p = projectCaptureDoc(subjectLoaded, 'subject'); return { status: p.status, capturedAt: p.capturedAt, instancePid: p.instance?.pid ?? null, runId: p.run?.runId ?? null, url: p.url, themeId: p.themeId }; })() : { status: 'ABSENT' };
      if (!subjectLoaded) gaps.push({ surface: target.name, viewport, set: null, side: 'subject', reason: `${subjectFile} is absent` });

      for (const set of COMPARE_SETS) {
        const projected = verdictDocs.get(`${set.name}|${slug}`) ?? null;
        if (!projected) {
          const setRecord = sets[set.name];
          const reason = setRecord ? (setRecord.index.refusal ? `the verdict set refused (${setRecord.index.refusal.code})` : 'the verdict set produced no document for this pair') : 'the verdict set artifact is absent';
          cell.verdicts[set.name] = { verdict: null, status: 'NOT_MEASURED', mechanism: null, mismatchPercentage: null, file: null, reason };
          gaps.push({ surface: target.name, viewport, set: set.name, side: null, reason });
          continue;
        }
        cell.verdicts[set.name] = {
          verdict: projected.verdict,
          status: projected.status,
          mechanism: projected.mechanism,
          reason: projected.reason,
          mismatchPercentage: projected.mismatchPercentage,
          file: projected.file,
          sha256: projected.sha256,
          hashContract: projected.hashContract,
          printLine: projected.printLine,
          identity: projected.identity,
          reference: projected.reference,
          subject: projected.subject,
          measurement: projected.measurement,
          strictParams: projected.strictParams,
          instrumentRevision: projected.instrumentRevision,
          provenanceDrift: projected.provenanceDrift,
          crossSideIdentity: projected.crossSideIdentity,
          settlePasses: projected.settlePasses,
        };
        const isReferenceSide = set.reference === 'r1' ? 'r1' : 'r2';
        const identity = cell.referenceIdentity[isReferenceSide];
        if (projected.reference?.geometry?.docHeight !== null && projected.reference?.geometry?.docHeight !== undefined) {
          identity.measuredDocHeight = projected.reference.geometry.docHeight;
          if (identity.pinnedDocHeight !== null) {
            identity.driftPx = projected.reference.geometry.docHeight - identity.pinnedDocHeight;
            identity.method = 'pinned capture + compare-time re-measurement';
          }
        }
      }

      const render = renderFindings.get(`${slug}.html`) ?? null;
      if (render) cell.structural = { file: `${slug}.html`, ok: render.ok ?? null, failures: render.failures ?? [] };
      else gaps.push({ surface: target.name, viewport, set: null, side: 'checks', reason: `no captured HTML input for ${slug}.html appears in the structural report` });

      row.viewports.push(cell);
    }
    surfaceMatrix.push(row);
  }

  const expectedPairCount = targets.length * viewportLabels.length;
  const verdictCounts = {};
  for (const set of COMPARE_SETS) {
    const pairs = [...verdictDocs.entries()].filter(([key]) => key.startsWith(`${set.name}|`)).map(([, doc]) => doc);
    verdictCounts[set.name] = {
      documents: pairs.length,
      pass: pairs.filter((p) => p.verdict === 'PASS').length,
      fail: pairs.filter((p) => p.verdict === 'FAIL').length,
      inconclusive: pairs.filter((p) => p.verdict === 'INCONCLUSIVE').length,
      notMeasured: pairs.filter((p) => p.verdict !== 'PASS' && p.verdict !== 'FAIL' && p.verdict !== 'INCONCLUSIVE').length,
      missing: Math.max(0, expectedPairCount - pairs.length),
      setStatus: sets[set.name]?.index?.status ?? null,
      indexFile: sets[set.name] ? relTo(outDir, sets[set.name].file) : null,
      indexSha256: sets[set.name]?.sha256 ?? null,
      hashContract: sets[set.name]?.hashContract ?? null,
    };
  }

  const refusals = Array.isArray(structural?.value?.refusals) ? structural.value.refusals : [];
  const structuralFindings = {
    checksStatus: checks?.value?.status ?? null,
    structuralFile: structural ? relTo(outDir, structural.file) : null,
    structuralSha256: structural?.sha256 ?? null,
    hashContract: structural?.hashContract ?? null,
    refused: refusals.length > 0,
    refusals,
    htmlInputs: checks?.value?.htmlInputs ?? [],
    counts: checks?.value?.structural?.counts ?? null,
    childExitCode: checks?.value?.childExitCode ?? null,
  };

  // A structural refusal is a gap in its own right: the report must name it even when no
  // capture failed and every verdict document exists, so a refusal never reads as a gap-free run.
  for (const refusal of refusals) {
    const failureCount = Array.isArray(refusal?.failures) ? refusal.failures.length : null;
    gaps.push({
      surface: null,
      viewport: null,
      set: null,
      side: 'checks',
      reason: `the structural checks refused (${refusal?.check ?? 'unknown check'}${failureCount === null ? '' : `, ${failureCount} failure(s)`})${refusal?.file ? ` in ${refusal.file}` : ''}`,
    });
  }

  const instances = [];
  const seenInstances = new Set();
  for (const [side, capture] of Object.entries(sides)) {
    if (!capture?.index?.instance) continue;
    const key = JSON.stringify(capture.index.instance);
    if (seenInstances.has(key)) continue;
    seenInstances.add(key);
    instances.push({ source: `${side} capture index`, ...capture.index.instance });
  }
  for (const set of COMPARE_SETS) {
    const instance = sets[set.name]?.index?.instance ?? null;
    if (!instance) continue;
    const key = JSON.stringify(instance);
    if (seenInstances.has(key)) continue;
    seenInstances.add(key);
    instances.push({ source: `${set.name} verdict index`, ...instance });
  }

  const complete = isPublishComplete({
    capturesComplete: sides.r1?.index?.status === 'COMPLETE' && sides.r2?.index?.status === 'COMPLETE' && sides.subject?.index?.status === 'COMPLETE',
    compareSetsComplete: COMPARE_SETS.every((set) => sets[set.name]?.index?.status === 'COMPLETE'),
    missingVerdicts: COMPARE_SETS.reduce((sum, set) => sum + (verdictCounts[set.name]?.missing ?? 0), 0),
    checksPresent: Boolean(checks),
    checksStatus: structuralFindings.checksStatus,
    structuralPresent: Boolean(structural),
    structuralRefused: structuralFindings.refused,
    structuralRefusalCount: refusals.length,
    checksGaps: gaps.filter((gap) => gap.side === 'checks').length,
    driftPresent: Boolean(drift),
  });
  const status = runStatus({
    auditPass: audit.pass,
    complete,
    checksStatus: structuralFindings.checksStatus,
    structuralRefused: structuralFindings.refused,
  });

  const report = {
    kind: 'theme-fidelity-run-report',
    stage: 'report',
    status,
    generatedAt: nowIso(),
    outDir,
    exitPolicy: {
      complete: 'exit 0 and publish current.json',
      incomplete: 'exit 3, report written, current.json not published',
      structuralRefused: 'exit 3 on a structural refusal (checks status REFUSED or a structural refusal list), report written, current.json not published',
      refused: 'exit 4 on a safety failure, current.json not published',
    },
    provenance: {
      store: preflight.store ?? null,
      copyThemeId: preflight.copyThemeId ?? COPY_THEME_ID,
      livePreviewThemeId: preflight.livePreviewThemeId ?? LIVE_PREVIEW_THEME_ID,
      liveThemeIdNeverAddressed: preflight.liveThemeIdNeverAddressed ?? LIVE_THEME_ID,
      theme: {
        dir: preflight.theme?.dir ?? null,
        file: preflight.theme?.settingsFile ?? null,
        sha256: preflight.theme?.settingsSha256 ?? null,
        hashContract: preflight.theme?.hashContract ?? null,
        themeId: preflight.theme?.themeId ?? null,
        orgId: preflight.theme?.orgId ?? null,
        themeOrgId: preflight.theme?.themeOrgId ?? null,
        themeName: preflight.theme?.themeName ?? null,
      },
      inventory: {
        file: preflight.inventory?.file ?? null,
        sha256: preflight.inventory?.sha256 ?? null,
        hashContract: preflight.inventory?.hashContract ?? null,
        surfaces: preflight.inventory?.surfaces ?? null,
        views: preflight.inventory?.views ?? null,
        unresolved: Array.isArray(preflight.inventory?.unresolved) ? preflight.inventory.unresolved.length : 0,
        themeIdsObserved: preflight.inventory?.themeIdsObserved ?? null,
      },
      derivedInventories: preflight.inventories ?? null,
      previewBases: preflight.previewBases ?? null,
      probe: preflight.probe ?? null,
      references: {
        file: references ? relTo(outDir, references.file) : null,
        sha256: references?.sha256 ?? null,
        hashContract: references?.hashContract ?? null,
        viewportSpec: references?.value?.viewportSpec ?? null,
        r1: references?.value?.r1 ?? null,
        r2: references?.value?.r2 ?? null,
      },
      captureSources: Object.fromEntries(Object.entries(sides).map(([side, capture]) => [side, capture ? { dir: relTo(outDir, capture.dir), indexFile: relTo(outDir, capture.file), indexSha256: capture.sha256, hashContract: capture.hashContract, label: capture.index.label ?? null, role: capture.index.role ?? null, status: capture.index.status ?? null, viewports: capture.index.viewports?.map((v) => v.label) ?? null } : null])),
      instances,
      devSession: serve ? {
        file: relTo(outDir, serve.file),
        status: serve.value?.status ?? null,
        pid: serve.value?.pid ?? null,
        readyAt: serve.value?.readyAt ?? null,
        readyMs: serve.value?.readyMs ?? null,
        stopMethod: serve.value?.stopMethod ?? null,
        stoppedAt: serve.value?.stoppedAt ?? null,
        command: serve.value?.command ?? null,
        probe: serve.value?.readiness?.probe ?? null,
        logFile: serve.value?.log?.file ?? null,
        logSha256: serve.value?.log?.sha256 ?? null,
        hashContract: serve.value?.log?.hashContract ?? null,
      } : null,
      subjectDrift: drift?.value ?? null,
      checks: checks?.value ?? null,
      structural: structural ? { file: relTo(outDir, structural.file), sha256: structural.sha256, hashContract: structural.hashContract, ok: structural.value?.ok ?? null, generatedAt: structural.value?.generatedAt ?? null } : null,
    },
    viewports: viewportLabels,
    targets: targets.map((t) => ({ name: t.name, kind: t.kind, slug: t.slug, template: t.template ?? null, sourceUrl: t.sourceUrl ?? null, urls: t.urls ?? null })),
    expectedPairCount,
    surfaceMatrix,
    verdictCounts,
    structuralFindings,
    safetyAudit: {
      ...audit,
      commandLog: {
        file: relTo(outDir, commandsFile),
        sha256: commandLog.sha256,
        hashContract: commandLog.hashContract,
        bytes: commandLog.bytes,
        lines: commandLog.lines,
        rawLines: commandLog.rawLines,
        appendOnly: commandLog.appendOnly,
        pinnedPrefix: 'the digest covers the whole command log as it existed when the report was built, blank lines included; every stage appends its own record after its artifact is written, so re-hash commandLogPrefix(file, rawLines) — the raw-line count, never `lines` (the parser\'s record count, which ignores blank lines) and never the whole grown file',
      },
      targetsOutsideAllowed: { mustBeZero: 0, count: audit.foreignThemeIds.count },
    },
    notMeasured,
    gaps,
    publication: { published: false, reason: null, current: null },
  };
  report.instrument = instrumentBlock(report.generatedAt);

  const reportFile = path.join(outDir, ARTIFACTS.report);
  writeRecordAtomic(reportFile, report);
  const markdownFile = path.join(outDir, ARTIFACTS.reportMarkdown);
  writeRecordAtomic(markdownFile, renderReportMarkdown(report));
  record.artifacts = [ARTIFACTS.report, ARTIFACTS.reportMarkdown];
  record.themeIds = [];
  record.themeIdsSource = 'the report reads persisted artifacts and commands.jsonl; it addresses no theme id';
  record.spawned = false;

  if (status === 'REFUSED') {
    log(`report REFUSED: ${audit.foreignThemeIds.count} command(s) addressed a theme outside ${ALLOWED_THEME_IDS.join('/')}${audit.publishDeployPush.matches.length ? `; forbidden command token(s): ${audit.publishDeployPush.matches.map((m) => m.token).join(', ')}` : ''}`);
    throw refuse('SAFETY_AUDIT_FAILED', EXIT.REFUSAL, `the safety audit failed: ${audit.foreignThemeIds.count} command(s) addressed a theme other than ${ALLOWED_THEME_IDS.join(' / ')}${audit.publishDeployPush.matches.length ? `, and a publish/deploy/push command appears in the record (${audit.publishDeployPush.matches.map((m) => m.token).join(', ')})` : ''}; ${ARTIFACTS.current} was not published`, {
      foreignThemeIds: audit.foreignThemeIds,
      publishDeployPush: audit.publishDeployPush,
      report: relTo(outDir, reportFile),
    });
  }
  if (status === 'INCOMPLETE') {
    const missingSets = COMPARE_SETS.filter((set) => (verdictCounts[set.name].missing ?? 0) > 0).map((set) => `${set.name} missing ${verdictCounts[set.name].missing}`);
    throw refuse('RUN_INCOMPLETE', EXIT.NOT_MEASURABLE, `the run is incomplete: ${missingSets.length ? missingSets.join('; ') : `${gaps.length} gap(s) recorded`}; the report names every gap and ${ARTIFACTS.current} was not published`, {
      report: relTo(outDir, reportFile),
      gaps: gaps.slice(0, 40),
      notMeasured: notMeasured.slice(0, 40),
    });
  }

  if (status === 'REFUSED_STRUCTURAL') {
    log(`report REFUSED_STRUCTURAL: checks status ${structuralFindings.checksStatus} with ${refusals.length} structural refusal(s)`);
    throw refuse('RUN_STRUCTURALLY_REFUSED', EXIT.NOT_MEASURABLE, `the structural checks refused (checks status ${structuralFindings.checksStatus}, ${refusals.length} refusal(s) in ${structuralFindings.structuralFile ?? ARTIFACTS.structural}): ${refusals.map((r) => `${r?.check ?? 'unknown check'}${r?.file ? `:${r.file}` : ''}`).join(', ')}; the report names every refusal and ${ARTIFACTS.current} was not published`, {
      report: relTo(outDir, reportFile),
      checksStatus: structuralFindings.checksStatus,
      refusals: refusals.slice(0, 40),
      gaps: gaps.slice(0, 40),
    });
  }

  // The report and its markdown are written in their final form before the published pointer
  // pins them. The pointer carries their digests; the report names the pointer without a
  // digest of it, because a digest of current.json can only exist once current.json is
  // written and rewriting the report to embed it would invalidate the digest the pointer just
  // pinned. Pinning stays one-directional so every recorded digest is true of the bytes on disk.
  const currentFile = path.join(outDir, ARTIFACTS.current);
  report.publication = { published: true, reason: null, current: { file: relTo(outDir, currentFile) } };
  writeRecordAtomic(reportFile, report);
  writeRecordAtomic(markdownFile, renderReportMarkdown(report));

  const current = {
    kind: 'theme-fidelity-run-current',
    generatedAt: nowIso(),
    status: 'PUBLISHED',
    store: report.provenance.store,
    copyThemeId: report.provenance.copyThemeId,
    report: { file: relTo(outDir, reportFile), ...artifactDigest(reportFile), bytes: fs.statSync(reportFile).size },
    reportMarkdown: { file: relTo(outDir, markdownFile), ...artifactDigest(markdownFile), bytes: fs.statSync(markdownFile).size },
    viewports: viewportLabels,
    expectedPairCount,
    verdictCounts,
    structuralFindings: { checksStatus: structuralFindings.checksStatus, refused: structuralFindings.refused, refusalCount: structuralFindings.refusals.length },
    safetyAudit: { commands: audit.commands, foreignThemeIds: audit.foreignThemeIds.count, publishDeployPushAbsent: audit.publishDeployPush.absent, livePreviewReads: audit.livePreviewReads.length, remoteWrites: audit.remoteWrites },
    notMeasuredCount: notMeasured.length,
  };
  current.instrument = instrumentBlock(current.generatedAt);
  const publishedFile = writeRecordAtomic(currentFile, current);
  log(`report COMPLETE -> ${publishedFile}`);
  return { exitCode: EXIT.OK };
}

// ── entry point ───────────────────────────────────────────────────────────────

const STAGE_RUNNERS = {
  preflight: preflightWork,
  references: referencesWork,
  serve: serveWork,
  subject: subjectWork,
  compare: compareWork,
  checks: checksWork,
  report: reportWork,
};

function reportRefusal(refusal) {
  console.error(`[theme-fidelity-run] REFUSED ${refusal.code} (exit ${refusal.exitCode}): ${refusal.message}`);
  if (refusal.detail) console.error(`[theme-fidelity-run] detail: ${JSON.stringify(refusal.detail).slice(0, 1600)}`);
  return refusal.exitCode;
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    return reportRefusal(asRefusal(e));
  }
  if (parsed.stage === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }

  const startedAt = nowIso();
  const record = buildCommandRecord({ stage: parsed.stage, argv: [...argv], startedAt });
  let result;
  try {
    result = await STAGE_RUNNERS[parsed.stage](parsed.options, record);
  } catch (e) {
    const refusal = asRefusal(e);
    if (!isRefusal(e)) console.error(`[theme-fidelity-run] ${parsed.stage} crashed: ${String((e && e.stack) || e)}`);
    result = { exitCode: refusal.exitCode, refusal };
  }

  record.finishedAt = nowIso();
  const finished = buildCommandRecord({ ...record, finishedAt: record.finishedAt, exitCode: result.exitCode, refusal: result.refusal ? { code: result.refusal.code, exitCode: result.refusal.exitCode, message: result.refusal.message, detail: result.refusal.detail ?? null } : null });
  try {
    appendCommandRecord(parsed.options.out, finished);
  } catch (e) {
    console.error(`[theme-fidelity-run] could not append the command record: ${String((e && e.message) || e)}`);
    if (result.exitCode === EXIT.OK) result = { exitCode: EXIT.NOT_MEASURABLE, refusal: refuse('COMMAND_LOG_UNWRITABLE', EXIT.NOT_MEASURABLE, `the command record under ${path.resolve(parsed.options.out)} could not be written: ${String((e && e.message) || e).slice(0, 300)}`, { out: path.resolve(parsed.options.out) }) };
  }

  log(`${parsed.stage} exit ${result.exitCode}${result.refusal ? ` (${result.refusal.code})` : ''} in ${finished.durationMs}ms`);
  if (result.refusal) reportRefusal(result.refusal);
  return result.exitCode;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(await main());
