// Parser and validator for worker reports ("leader-report/1").
//
// File layout: line 1 `STATUS: DONE|PENDING|NEEDS_INPUT|FAILED`, then free prose, and exactly
// one ```json fenced block holding the object below. Everything else is ignored.
//
//   { "schema":"leader-report/1", "status":"DONE",
//     "job":"<job dir name>", "key":"<slug>", "round":1,   // must match the round being validated
//     "guard":{"issueId","host","shop","sheetId"},          // copied from the prompt, must match job.json
//     "summary":"...",                                       // optional
//     "files":["..."], "pushed":["..."], "evidence":["..."],
//     "sheet":{"cells":[{"keyText":"<task text>","col":"<header>","expect":"<cell text>","occurrence":1}],
//              "skipped":[{"keyText":"...","reason":"..."}]},
//     "dashboard":{"commentsAdded":1,"stageBefore":"Feedback","stageAfter":"Feedback"},
//     "storefront":{"measurements":[{"probe","url","viewport","selector","value"}]},
//     "notChecked":["..."],                                  // REQUIRED when DONE
//     "needsInput":{"question":"...","options":["a","b"]}    // REQUIRED when NEEDS_INPUT (2-3 options)
//   }

import { normKey } from "./sheet-diff.mjs";

export const REPORT_SCHEMA = "leader-report/1";
export const STATUSES = ["DONE", "PENDING", "NEEDS_INPUT", "FAILED"];

const head = (s, n = 120) => (s.length > n ? `${s.slice(0, n)}...` : s);
const isStr = (v) => typeof v === "string";
const isNonEmptyStr = (v) => isStr(v) && v.trim() !== "";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);

/** @returns {{status:string|null, json:object|null, errors:string[]}} */
export function parseReport(text) {
  const errors = [];
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const m = /^STATUS:\s*(DONE|PENDING|NEEDS_INPUT|FAILED)\s*$/.exec(firstLine);
  let status = null;
  if (m) status = m[1];
  else errors.push(`first line must be "STATUS: DONE|PENDING|NEEDS_INPUT|FAILED", got ${JSON.stringify(head(firstLine))}`);

  const blocks = [...src.matchAll(/^[ \t]{0,3}```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]{0,3}```[ \t]*$/gm)];
  let json = null;
  if (blocks.length === 0) {
    errors.push("no fenced ```json block found (the report needs exactly one leader-report/1 object)");
  } else if (blocks.length > 1) {
    errors.push(`found ${blocks.length} fenced json blocks, expected exactly one`);
  } else {
    try {
      json = JSON.parse(blocks[0][1]);
    } catch (e) {
      errors.push(`fenced json block does not parse: ${e.message}`);
    }
  }
  return { status, json, errors };
}

/**
 * @param {{status:string|null,json:object|null}} parsed
 * @param {object} job job.json
 * @param {number} round round number the report belongs to
 */
export function validateReportObject(parsed, job, round) {
  const errors = [];
  const j = parsed.json;
  if (j === null) return errors;
  if (!isObj(j)) {
    errors.push("json block must be an object");
    return errors;
  }
  if (j.schema !== REPORT_SCHEMA) errors.push(`schema must be "${REPORT_SCHEMA}", got ${JSON.stringify(j.schema)}`);
  if (parsed.status && j.status !== parsed.status) {
    errors.push(`json status ${JSON.stringify(j.status)} differs from STATUS line ${JSON.stringify(parsed.status)}`);
  }
  if (j.job !== job.job) errors.push(`job mismatch: report ${JSON.stringify(j.job)} vs job ${JSON.stringify(job.job)}`);
  if (j.round !== round) errors.push(`round mismatch: report ${JSON.stringify(j.round)} vs round ${round}`);
  if (j.key !== undefined && job.slug && j.key !== job.slug) errors.push(`key mismatch: report ${JSON.stringify(j.key)} vs job ${JSON.stringify(job.slug)}`);
  if (j.summary !== undefined && !isStr(j.summary)) errors.push("summary must be a string");

  const g = j.guard;
  if (!isObj(g)) {
    errors.push("guard object missing (issueId, host, shop, sheetId)");
  } else {
    const want = { issueId: String(job.subject.issueId), host: job.subject.host, shop: job.subject.shop, sheetId: job.subject.sheetId };
    for (const [k, v] of Object.entries(want)) {
      const got = g[k] === undefined || g[k] === null ? "" : String(g[k]).trim();
      if (got !== String(v).trim()) errors.push(`guard.${k} mismatch: report ${JSON.stringify(got)} vs job ${JSON.stringify(v)}`);
    }
  }

  for (const k of ["files", "pushed", "evidence"]) {
    if (j[k] !== undefined && !isStrArray(j[k])) errors.push(`${k} must be an array of strings`);
  }
  if (j.dashboard !== undefined) {
    if (!isObj(j.dashboard)) errors.push("dashboard must be an object");
    else if (j.dashboard.commentsAdded !== undefined && !(Number.isInteger(j.dashboard.commentsAdded) && j.dashboard.commentsAdded >= 0)) {
      errors.push("dashboard.commentsAdded must be an integer >= 0");
    }
  }
  if (j.storefront !== undefined) {
    if (!isObj(j.storefront)) errors.push("storefront must be an object");
    else if (j.storefront.measurements !== undefined && !(Array.isArray(j.storefront.measurements) && j.storefront.measurements.every(isObj))) {
      errors.push("storefront.measurements must be an array of objects");
    }
  }

  if (j.sheet !== undefined) {
    if (!isObj(j.sheet)) {
      errors.push("sheet must be an object");
    } else {
      const scope = job.scope?.keys ? new Set(job.scope.keys.map(normKey)) : null;
      const outside = (at, k) => {
        if (scope && isStr(k) && !scope.has(normKey(k))) errors.push(`${at}.keyText ${JSON.stringify(head(normKey(k), 80))} is outside scope.keys`);
      };
      const cells = j.sheet.cells;
      if (cells !== undefined && !Array.isArray(cells)) {
        errors.push("sheet.cells must be an array");
      } else {
        (cells ?? []).forEach((c, i) => {
          const at = `sheet.cells[${i}]`;
          if (!isObj(c)) {
            errors.push(`${at} must be an object`);
            return;
          }
          if (!isNonEmptyStr(c.keyText)) errors.push(`${at}.keyText must be the task text of the row`);
          if (!isNonEmptyStr(c.col)) errors.push(`${at}.col must be a header text`);
          if (!isStr(c.expect)) errors.push(`${at}.expect must be the string expected in the cell`);
          if (c.occurrence !== undefined && !(Number.isInteger(c.occurrence) && c.occurrence >= 1)) errors.push(`${at}.occurrence must be an integer >= 1`);
          outside(at, c.keyText);
        });
      }
      const skipped = j.sheet.skipped;
      if (skipped !== undefined) {
        if (!Array.isArray(skipped)) errors.push("sheet.skipped must be an array");
        else
          skipped.forEach((s, i) => {
            const at = `sheet.skipped[${i}]`;
            if (!isObj(s) || !isNonEmptyStr(s.keyText) || !isNonEmptyStr(s.reason)) errors.push(`${at} must be {keyText, reason} with non-empty strings`);
            else outside(at, s.keyText);
          });
      }
    }
  }

  const status = parsed.status ?? j.status;
  if (status === "DONE" && !Array.isArray(j.notChecked)) errors.push("DONE report must carry a notChecked array (what was NOT verified)");
  if (j.notChecked !== undefined && !isStrArray(j.notChecked)) errors.push("notChecked must be an array of strings");
  if (status === "NEEDS_INPUT") {
    const n = j.needsInput;
    if (!isObj(n)) errors.push("NEEDS_INPUT report must carry needsInput {question, options}");
    else {
      if (!isNonEmptyStr(n.question)) errors.push("needsInput.question must be a non-empty string");
      if (!(Array.isArray(n.options) && n.options.length >= 2 && n.options.length <= 3 && n.options.every(isNonEmptyStr))) {
        errors.push("needsInput.options must be 2 or 3 non-empty strings");
      }
    }
  }
  return errors;
}

/** Everything but the filesystem mtime check. */
export function validateReportText(text, job, round) {
  const parsed = parseReport(text);
  const errors = [...parsed.errors, ...validateReportObject(parsed, job, round)];
  return { status: parsed.status, json: parsed.json, errors };
}

/** Sheet cells a valid report claims, in verify-sheet's shape. */
export function claimedCells(json) {
  return (json?.sheet?.cells ?? []).map((c) => ({ key: c.keyText, col: c.col, expect: c.expect, occurrence: c.occurrence }));
}
