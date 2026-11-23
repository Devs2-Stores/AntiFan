// worker-model.mjs - which model a Leader worker's OMP runs, and what that model means for the round about to be spent.
//
// A worker pane starts as a bare shell and takes the `omp "@<prompt>"` line the ledger printed, so a fresh round has
// no OMP session yet and the best evidence of its model is the configured `modelRoles.default` that a new OMP resolves.
// A follow-up pane is already inside OMP, whose transcript records the model it started with as a `model_change` row
// near its head and a new row on every switch. `model_usage` rows name the model per call without its provider (they
// read `cc/claude-haiku-5-5` where the route is `9router/cc/claude-haiku-5-5`), so a usage row is only the last resort:
// the route is exactly what decides whether the pane can name an MCP tool at all.
//
// Shared by worker-status.mjs and leader-job.mjs dispatch so the progress line and the pre-round refusal never
// disagree about a worker's model. Read-only: it opens the OMP agent DB read-only and never selects credential data.

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { findSessionFile } from "./worker-liveness.mjs";

const require = createRequire(import.meta.url);

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 1_000_000;
/** Model routes that name MCP tools with an `_ide` suffix, which the runtime rejects as "Tool not found". */
const IDE_TOOL_SUFFIX_ROUTE = /^(?:9router\/)?cc\//i;

/** `~/.omp/agent/config.yml`: the roles a new OMP resolves its model from. OMP_CONFIG_FILE overrides it. */
export function defaultConfigFile() {
  return process.env.OMP_CONFIG_FILE || path.join(os.homedir(), ".omp", "agent", "config.yml");
}

/** The OMP auth DB holding `auth_credential_blocks`; it sits beside the config unless OMP_AUTH_DB names another file. */
export function defaultAuthDb(configFile = defaultConfigFile()) {
  return process.env.OMP_AUTH_DB || path.join(path.dirname(configFile), "agent.db");
}

/** The `model` field of every model row in a transcript block, newest row winning per kind. */
function scanModels(text) {
  let changed = null;
  let used = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"model"')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof ev?.model !== "string" || !ev.model) continue;
    if (ev.type === "model_change") changed = ev.model;
    else if (ev.type === "model_usage") used = ev.model;
  }
  return { changed, used };
}

function readRange(file, start, length) {
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString("utf8");
}

/**
 * The model a transcript names, from its head plus its tail: a long session switches model far past the head, and the
 * newest `model_change` anywhere wins over the bare `model_usage` names that follow it. `evidence` reports which row
 * kind answered so a caller can tell a full route from a provider-less usage name. Null when neither row kind appears
 * (a file that cannot be read, or a session that recorded no model).
 */
export function transcriptModel(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  if (size <= 0) return null;
  const blocks =
    size <= HEAD_BYTES
      ? [readRange(file, 0, size)]
      : [readRange(file, 0, HEAD_BYTES), readRange(file, Math.max(0, size - TAIL_BYTES), Math.min(TAIL_BYTES, size))];
  let changed = null;
  let used = null;
  for (const text of blocks) {
    const scan = scanModels(text);
    if (scan.changed) changed = scan.changed;
    if (scan.used) used = scan.used;
  }
  if (changed) return { model: changed, evidence: "model_change" };
  if (used) return { model: used, evidence: "model_usage" };
  return null;
}

/** A model value without its `:thinkingLevel` suffix, so config and transcript spell the same route the same way. */
export function stripThinkingLevel(value) {
  return String(value ?? "").replace(/:(?:max|xhigh|high|medium|low|minimal|none|off|auto)$/i, "");
}

/**
 * The model a new OMP starts with on this machine: `modelRoles.default` of the OMP config. Only that role describes a
 * worker pane (a top-level OMP); `task` is what a subagent gets, and the other roles are not a session's model. Null
 * when the file or the role is missing, so the caller reports an unknown model instead of guessing one.
 */
export function readConfiguredDefaultModel(configFile = defaultConfigFile()) {
  let text;
  try {
    text = fs.readFileSync(configFile, "utf8");
  } catch {
    return null;
  }
  let inRoles = false;
  let configured = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (raw.length === line.length) {
      inRoles = /^modelRoles\s*:\s*$/.test(line);
      continue;
    }
    if (!inRoles || raw.length - line.length !== 2) continue;
    const m = /^default\s*:\s*(.+)$/.exec(line);
    if (m) configured = m[1].replace(/\s+#.*$/, "").trim().replace(/^['"]|['"]$/g, "").trim();
  }
  const model = stripThinkingLevel(configured);
  return model ? { model, role: "default", configured } : null;
}

/**
 * The model of the worker in `run` (the parsed run file, or null when the pane has none yet): the model_change rows of
 * that terminal's OMP transcript when the pane already runs OMP, else the configured default role of a fresh OMP.
 * `source` is "transcript" or "config" so a refusal can say where the verdict came from; null when neither answers.
 */
export function resolveWorkerModel({ run = null, sessionsDir, configFile = defaultConfigFile() } = {}) {
  const transcript = run && !run.unreadable ? findSessionFile(sessionsDir, run) : null;
  const found = transcript ? transcriptModel(transcript) : null;
  if (found) return { model: found.model, source: "transcript", evidence: found.evidence, transcript };
  const configured = readConfiguredDefaultModel(configFile);
  if (configured) return { model: configured.model, source: "config", evidence: "modelRoles.default", transcript };
  return { model: null, source: null, evidence: null, transcript };
}

/** A model on the `9router/cc/` route names every MCP tool with an `_ide` suffix the runtime answers "Tool not found". */
export function isIdeSuffixRoute(model) {
  return typeof model === "string" && IDE_TOOL_SUFFIX_ROUTE.test(model);
}

/**
 * What a Leader must know about a worker's model: a model on the `9router/cc/` route fails every MCP tool it needs while
 * its run file looks healthy.
 */
export function modelWarnings(model) {
  if (!isIdeSuffixRoute(model)) return [];
  return [
    {
      code: "IDE_TOOL_SUFFIX_MODEL",
      model,
      note: `${model} names tools with an _ide suffix and every call fails as "Tool not found": run the worker on a model outside the 9router/cc route`,
    },
  ];
}

/** The provider of a `provider/model` name (`anthropic` for `anthropic/claude-sonnet-5-5`), lowercased; null otherwise. */
export function providerOf(model) {
  if (typeof model !== "string") return null;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash).toLowerCase() : null;
}

let sqliteModule = null;
let sqliteWarningFiltered = false;
/**
 * `node:sqlite`, without its ExperimentalWarning: the warning lands on stderr of a CLI whose output is read as JSON.
 * Node queues the warning for the next tick, so the listener has to stay installed; only the SQLite experimental
 * warning is dropped and every other warning goes to the listeners Node already had.
 */
function loadSqlite() {
  if (sqliteModule) return sqliteModule;
  if (!sqliteWarningFiltered) {
    sqliteWarningFiltered = true;
    const saved = process.listeners("warning");
    process.removeAllListeners("warning");
    process.on("warning", (warning) => {
      if (warning?.name === "ExperimentalWarning" && /sqlite/i.test(String(warning.message))) return;
      for (const listener of saved) listener(warning);
    });
  }
  sqliteModule = require("node:sqlite");
  return sqliteModule;
}

/**
 * The active credential block of the provider that serves `model`, or null. The block table keeps one row per
 * (credential, provider_key, block_scope) with the time the block lifts; a scope narrows it to part of a provider, so a
 * row matches when its provider_key names that provider and its scope is empty or appears in the model name. Anything
 * that keeps the DB from answering (no OMP, a locked or absent file, a schema this OMP does not have) is "no block
 * known": the caller must print nothing rather than guess at quota. Credential data is never selected.
 */
export function providerBlock(authDbFile, model, now = Date.now()) {
  const provider = providerOf(model);
  if (!provider) return null;
  let db = null;
  try {
    if (!fs.existsSync(authDbFile)) return null;
    const { DatabaseSync } = loadSqlite();
    db = new DatabaseSync(authDbFile, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT b.provider_key, b.block_scope, b.blocked_until_ms, (c.disabled_cause IS NOT NULL) AS credential_disabled
           FROM auth_credential_blocks b
           LEFT JOIN auth_credentials c ON c.id = b.credential_id
          WHERE b.blocked_until_ms > ?`,
      )
      .all(now);
    const hits = rows
      .filter((row) => typeof row.provider_key === "string" && row.provider_key.split(":")[0].trim().toLowerCase() === provider)
      .filter((row) => {
        const scope = typeof row.block_scope === "string" ? row.block_scope.trim() : "";
        return !scope || model.toLowerCase().includes(scope.toLowerCase());
      })
      .sort((a, b) => Number(b.blocked_until_ms) - Number(a.blocked_until_ms));
    const row = hits[0];
    if (!row) return null;
    return {
      provider,
      providerKey: row.provider_key,
      scope: typeof row.block_scope === "string" && row.block_scope.trim() ? row.block_scope.trim() : null,
      untilMs: Number(row.blocked_until_ms),
      until: new Date(Number(row.blocked_until_ms)).toISOString(),
      credentialDisabled: row.credential_disabled === 1,
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/**
 * The one wording of a provider block warning: provider, why it is blocked and the time it lifts. Both the dispatch
 * warning and any caller that lists warnings print this, so the two never describe the same block differently.
 */
export function blockWarning(block) {
  const scope = block.scope ? `scope ${block.scope}` : "provider-wide";
  const reason = block.credentialDisabled ? "its credential is disabled" : "OMP recorded no reason";
  return {
    code: "PROVIDER_CREDENTIAL_BLOCK",
    provider: block.provider,
    providerKey: block.providerKey,
    scope: block.scope,
    until: block.until,
    reason,
    note: `${block.provider} is under an active credential block (${block.providerKey}, ${scope}) until ${block.until}: ${reason}, so a worker on this model may have every call rejected until it lifts`,
  };
}
