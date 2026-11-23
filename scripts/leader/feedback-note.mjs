#!/usr/bin/env node
// Post, replace or remove ONE dev note on a feedback.f1genz.dev issue, addressed by its stable id.
//
// The whole decision runs inside one page evaluation on the dashboard origin: a fresh server read
// by id, the guard (id found once, host and shop equal to what the job names), the write, and a
// second fresh read that proves what changed. Nothing is addressed by row number or by a comment
// position the caller read earlier, so a list that moved between two calls cannot redirect the
// write to another issue or delete another comment.
//
// It needs an AntiFan session, so run it through the launcher:
//   node scripts/antifan-agent.cjs --project=<id|name> node scripts/leader/feedback-note.mjs \
//     post --id <issueId> --host <HOST> --shop <shop> --text-file note.txt [--replace-file old.txt] [--dry-run]
//   ... read   --id <issueId> --host <HOST> --shop <shop>
//   ... remove --id <issueId> --host <HOST> --shop <shop> --text-file exact.txt
//
// Exit codes: 0 done (posted, already there, removed, read, dry run) · 2 usage or no session ·
// 3 guard refused (nothing written) · 4 the write was sent but a check after it failed · 5 the
// dashboard or the tab could not be reached.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AntiFanMcpClient } from "../lib/antifan-mcp-client.mjs";

export const DASHBOARD_ORIGIN = "https://feedback.f1genz.dev";

/** Results after which nothing was written. */
export const REFUSED_RESULTS = new Set(["GUARD_NOT_FOUND", "GUARD_MULTIPLE", "GUARD_HOST", "GUARD_SHOP", "BAD_COMMENTS", "MATCH_0", "MATCH_MANY", "READ_FAILED"]);
/** Results that mean the requested end state holds. */
export const DONE_RESULTS = new Set(["POSTED", "REPLACED", "DUPLICATE", "REMOVED", "WOULD_POST", "WOULD_REPLACE", "WOULD_REMOVE", "READ"]);

/**
 * The page program. It only talks to the dashboard's own API and returns a JSON string; the comment
 * texts of other people never leave the page, only their count, so untrusted issue text is not
 * carried into the caller's context.
 */
export function buildNoteExpression({ mode, id, host, shop, text = "", replaceText = "", dryRun = false }) {
  if (!["post", "read", "remove"].includes(mode)) throw new Error(`mode must be post, read or remove, got ${JSON.stringify(mode)}`);
  for (const [name, value] of Object.entries({ id, host, shop })) {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  }
  if (mode !== "read" && text.trim() === "") throw new Error("the note text is empty");
  const params = { mode, id: id.trim(), host: host.trim(), shop: shop.trim(), text: text.trim(), replaceText: replaceText.trim(), dryRun: dryRun === true };
  return `(async () => {
  const P = ${JSON.stringify(params)};
  const out = (result, extra) => JSON.stringify(Object.assign({ result, id: P.id }, extra || {}));
  const read = async () => {
    const response = await fetch('/api/getDashboardData?_=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) return { error: 'HTTP_' + response.status };
    const data = await response.json();
    const rows = (Array.isArray(data && data.feedback) ? data.feedback : []).filter((row) => String(row.id) === P.id);
    return { rows };
  };
  const post = async (action, body) => {
    const response = await fetch('/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try { return await response.json(); } catch (_) { return { success: false, message: 'HTTP_' + response.status }; }
  };
  const textsOf = (row) => {
    try {
      const list = JSON.parse(row.devNote || '[]');
      return Array.isArray(list) ? list.map((c) => String((c && c.text) || '')) : null;
    } catch (_) { return null; }
  };
  const rest = (row) => { const copy = Object.assign({}, row); delete copy.devNote; delete copy.comments; return copy; };
  const changedKeys = (a, b) => Object.keys(Object.assign({}, a, b)).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  const guarded = async () => {
    const got = await read();
    if (got.error) return { stop: out('READ_FAILED', { detail: got.error }) };
    if (got.rows.length === 0) return { stop: out('GUARD_NOT_FOUND') };
    if (got.rows.length > 1) return { stop: out('GUARD_MULTIPLE', { matches: got.rows.length }) };
    const row = got.rows[0];
    if (String(row.host || '') !== P.host) return { stop: out('GUARD_HOST', { rowNumber: row.rowNumber }) };
    if (String(row.shop || '') !== P.shop) return { stop: out('GUARD_SHOP', { rowNumber: row.rowNumber }) };
    const texts = textsOf(row);
    if (texts === null) return { stop: out('BAD_COMMENTS', { rowNumber: row.rowNumber }) };
    return { row, texts };
  };
  const indexesOf = (texts, wanted) => texts.map((t, i) => (t === wanted ? i : -1)).filter((i) => i >= 0);

  const first = await guarded();
  if (first.stop) return first.stop;
  const rowNumber = Number(first.row.rowNumber);
  const base = { rowNumber, stage: first.row.stage, commentsBefore: first.texts.length };
  if (P.mode === 'read') {
    return out('READ', Object.assign(base, { hasText: P.text ? indexesOf(first.texts, P.text).length : undefined }));
  }

  const sent = [];
  const removeExact = async (wanted) => {
    // The delete is by position, so the position comes from a read made in this same call.
    const now = await guarded();
    if (now.stop) return { stop: now.stop };
    const hits = indexesOf(now.texts, wanted);
    if (hits.length !== 1) return { hits: hits.length };
    const answer = await post('deleteComment', { rowNumber: Number(now.row.rowNumber), commentIndex: hits[0] });
    sent.push('deleteComment');
    return { hits: 1, ok: answer && answer.success === true, message: answer && answer.message };
  };
  const finish = async (result, expected, extra) => {
    const last = await guarded();
    if (last.stop) return out('VERIFY_FAILED', Object.assign(base, extra, { sent, detail: 'the issue could not be read back' }));
    const same = last.texts.length === expected.length && last.texts.every((t, i) => t === expected[i]);
    const moved = changedKeys(rest(first.row), rest(last.row));
    if (!same) return out('VERIFY_FAILED', Object.assign(base, extra, { sent, commentsAfter: last.texts.length, detail: 'the comments are not the expected list' }));
    return out(result, Object.assign(base, extra, { sent, commentsAfter: last.texts.length, otherFieldsChanged: moved }));
  };

  if (P.mode === 'remove') {
    const hits = indexesOf(first.texts, P.text);
    if (hits.length === 0) return out('MATCH_0', base);
    if (hits.length > 1) return out('MATCH_MANY', Object.assign(base, { matches: hits.length }));
    if (P.dryRun) return out('WOULD_REMOVE', base);
    const removed = await removeExact(P.text);
    if (removed.stop) return removed.stop;
    if (removed.hits !== 1 || !removed.ok) return out('VERIFY_FAILED', Object.assign(base, { sent, detail: 'delete refused: ' + String(removed.message || removed.hits) }));
    return finish('REMOVED', first.texts.filter((_, i) => i !== hits[0]), { commentsRemoved: 1 });
  }

  const already = indexesOf(first.texts, P.text).length;
  const oldHits = P.replaceText ? indexesOf(first.texts, P.replaceText).length : 0;
  if (P.replaceText && P.replaceText === P.text) return out('DUPLICATE', Object.assign(base, { commentsAdded: 0, commentsRemoved: 0 }));
  if (P.replaceText && (oldHits > 1 || (already === 0 && oldHits === 0))) return out(oldHits === 0 ? 'MATCH_0' : 'MATCH_MANY', Object.assign(base, { matches: oldHits }));
  if (already > 1) return out('MATCH_MANY', Object.assign(base, { matches: already }));
  if (P.dryRun) return out(already === 1 && oldHits === 0 ? 'DUPLICATE' : (P.replaceText ? 'WOULD_REPLACE' : 'WOULD_POST'), Object.assign(base, { commentsAdded: 0, commentsRemoved: 0 }));

  let expected = first.texts.slice();
  let added = 0;
  if (already === 0) {
    // The new note goes first, so a failure never leaves the issue without a note.
    const answer = await post('addComment', { rowNumber, commentText: P.text });
    sent.push('addComment');
    if (!answer || answer.success !== true) return out('VERIFY_FAILED', Object.assign(base, { sent, detail: 'post refused: ' + String(answer && answer.message) }));
    expected = expected.concat([P.text]);
    added = 1;
  }
  if (!P.replaceText || oldHits === 0) {
    return finish(added === 1 ? 'POSTED' : 'DUPLICATE', expected, { commentsAdded: added, commentsRemoved: 0 });
  }
  const removed = await removeExact(P.replaceText);
  if (removed.stop) return removed.stop;
  if (removed.hits !== 1 || !removed.ok) return out('VERIFY_FAILED', Object.assign(base, { sent, commentsAdded: added, detail: 'old note not removed: ' + String(removed.message || removed.hits) }));
  const at = expected.indexOf(P.replaceText);
  expected.splice(at, 1);
  return finish('REPLACED', expected, { commentsAdded: added, commentsRemoved: 1 });
})()`;
}

/** Exit code for a result object returned by the page program. */
export function exitCodeFor(result) {
  if (DONE_RESULTS.has(result)) return 0;
  if (REFUSED_RESULTS.has(result)) return 3;
  return 4;
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg.startsWith("--") && i + 1 < rest.length) flags[arg.slice(2)] = rest[++i];
    else throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
  }
  return { mode, flags };
}

const readText = (file) => fs.readFileSync(path.resolve(file), "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();

function fail(code, payload) {
  console.log(JSON.stringify({ cmd: "feedback-note", ok: false, ...payload }));
  process.exit(code);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(2, { error: error.message });
  }
  const { mode, flags } = parsed;
  let expression;
  let text = "";
  try {
    text = flags["text-file"] ? readText(flags["text-file"]) : (flags.text ?? "").trim();
    expression = buildNoteExpression({
      mode,
      id: flags.id,
      host: flags.host,
      shop: flags.shop,
      text,
      replaceText: flags["replace-file"] ? readText(flags["replace-file"]) : "",
      dryRun: flags.dryRun === true,
    });
  } catch (error) {
    fail(2, { error: error.message, usage: "feedback-note.mjs post|read|remove --id ID --host HOST --shop SHOP [--text-file F] [--replace-file F] [--dry-run]" });
  }

  let bootstrap;
  try {
    bootstrap = JSON.parse(process.env.ANTIFAN_MCP_BOOTSTRAP || "");
  } catch {
    fail(2, {
      error: "no AntiFan session in the environment",
      next: `node scripts/antifan-agent.cjs --project=<id|name> node scripts/leader/feedback-note.mjs ${process.argv.slice(2).map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`,
    });
  }

  // The client resolves the proxy script against the working directory.
  process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const client = new AntiFanMcpClient({ bootstrap, timeoutMs: 60_000 });
  let tabId = null;
  try {
    const created = await client.callTool("anti.browser.tabs.create", { url: `${DASHBOARD_ORIGIN}/`, activate: false, bind: true });
    tabId = created?.tabId ?? created?.id ?? created?.tab?.tabId ?? created?.tab?.id ?? null;
    if (!tabId) throw new Error(`tabs.create returned no tab id: ${JSON.stringify(created).slice(0, 200)}`);
    // The dashboard sits behind an access wall: a tab that landed anywhere else cannot reach the API.
    let origin = "";
    for (let attempt = 0; attempt < 20 && origin !== DASHBOARD_ORIGIN; attempt += 1) {
      const where = await client.callTool("anti.browser.evaluate", { tabId, expression: "location.origin", allowDegradedSurface: true }).catch(() => null);
      origin = typeof where?.value === "string" ? where.value : "";
      if (origin !== DASHBOARD_ORIGIN) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (origin !== DASHBOARD_ORIGIN) {
      throw new Error(`the tab is on ${JSON.stringify(origin)}, not on ${DASHBOARD_ORIGIN}: sign in to the dashboard in this project's browser profile first`);
    }
    const answer = await client.callTool("anti.browser.evaluate", { tabId, expression, allowDegradedSurface: true, timeoutMs: 29_000 });
    const raw = typeof answer?.value === "string" ? answer.value : JSON.stringify(answer?.value ?? null);
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      throw new Error(`the page returned no result: ${raw.slice(0, 200)}`);
    }
    const code = exitCodeFor(result.result);
    console.log(JSON.stringify({
      cmd: "feedback-note",
      ok: code === 0,
      mode,
      host: flags.host,
      shop: flags.shop,
      ...result,
      ...(mode === "read" ? {} : { commentText: text }),
    }));
    process.exitCode = code;
  } catch (error) {
    console.log(JSON.stringify({ cmd: "feedback-note", ok: false, error: String(error?.message ?? error).slice(0, 400) }));
    process.exitCode = 5;
  } finally {
    if (tabId) await client.callTool("anti.browser.tabs.close", { tabId }).catch(() => {});
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
