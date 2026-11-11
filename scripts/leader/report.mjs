// Parser and validator for worker reports ("leader-report/1").
//
// File layout: line 1 `STATUS: DONE|PENDING|NEEDS_INPUT|FAILED`, then free prose, and exactly
// one ```json fenced block holding the object below. Everything else is ignored.
//
//   { "schema":"leader-report/1", "status":"DONE",
//     "job":"<job dir name>", "key":"<slug>", "round":1,   // must match the round being validated
//     "guard":{"issueId","host","shop","sheetId"},          // copied from the prompt, must match job.json (ad-hoc jobs: omit it)
//     "summary":"...",                                       // optional
//     "files":["..."], "pushed":["..."], "evidence":["..."],
//     "sheet":{"cells":[{"keyText":"<task text>","col":"<header>","expect":"<cell text>","occurrence":1}],
//              "skipped":[{"keyText":"...","reason":"..."}]},
//     "dashboard":{"commentsAdded":1,"commentsRemoved":0,"removedTexts":["..."],"commentText":"...","stageBefore":"Feedback","stageAfter":"Feedback"},
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
export function validateReportObject(parsed, job, round, ctx = {}) {
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
  if (job.subject?.kind === "adhoc") {
    // An ad-hoc job has no issue, shop or sheet: a guard block is optional and must not claim any of them.
    if (g !== undefined) {
      if (!isObj(g)) errors.push("guard must be an object when present");
      else {
        for (const k of ["issueId", "host", "shop", "sheetId"]) {
          if (g[k] !== undefined && g[k] !== null && String(g[k]).trim() !== "") errors.push(`guard.${k} claims a feedback field but this job is ad-hoc (no issue, shop or sheet)`);
        }
      }
    }
  } else if (!isObj(g)) {
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
    else {
      for (const k of ["commentsAdded", "commentsRemoved"]) {
        if (j.dashboard[k] !== undefined && !(Number.isInteger(j.dashboard[k]) && j.dashboard[k] >= 0)) errors.push(`dashboard.${k} must be an integer >= 0`);
      }
      if (j.dashboard.removedTexts !== undefined && !isStrArray(j.dashboard.removedTexts)) errors.push("dashboard.removedTexts must be an array of strings");
      if ((j.dashboard.commentsRemoved ?? 0) > 0 && (j.dashboard.removedTexts?.length ?? 0) !== j.dashboard.commentsRemoved) {
        errors.push("dashboard.removedTexts must hold the exact text of every removed comment (one per commentsRemoved)");
      }
      if (j.dashboard.commentText !== undefined && !isStr(j.dashboard.commentText)) errors.push("dashboard.commentText must be a string");
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
          if (!isNonEmptyStr(c.col) && !(c.colLetter !== undefined && /^[A-Z]{1,3}$/.test(String(c.colLetter)))) errors.push(`${at}.col must be a header text (a column with no header: col "" plus colLetter "A", or col "colA")`);
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
  if (j.review !== undefined) {
    const r = j.review;
    if (!isObj(r)) errors.push("review must be an object {verdict, findings}");
    else {
      if (!REVIEW_VERDICTS.includes(r.verdict)) errors.push(`review.verdict must be one of ${REVIEW_VERDICTS.join(", ")}`);
      if (!isStrArray(r.findings)) errors.push("review.findings must be an array of strings");
    }
  } else if (ctx.kind === "review") {
    errors.push("review round report must carry review {verdict, findings}");
  }
  // Only a DONE close report claims the close; NEEDS_INPUT / FAILED close reports (e.g. a guard mismatch) validate normally.
  if (ctx.kind === "close" && status === "DONE") {
    const want = ctx.closeToken;
    if (!isNonEmptyStr(want)) {
      errors.push("job has no close token (the Leader must run approve before the close round)");
    } else if (!isNonEmptyStr(j.closeToken) || j.closeToken !== want) {
      errors.push("close report must echo the APPROVAL_TOKEN of the close prompt as top-level closeToken (missing or wrong)");
    } else if (ctx.tokenUsedAt != null && ctx.tokenUsedRound !== round) {
      errors.push("close token was already used by another report");
    }
  }
  return errors;
}

const asciiLower = (s) =>
  String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();

// Topics only the user can decide or perform; an answer from the Leader would be a guess.
const ONLY_USER_TOPICS = [
  ["login/credential", /\b(log ?in|sign ?in|dang nhap|otp|2fa|two[- ]?factor|xac thuc|mat khau|password|passcode|credentials?|tokens?|secrets?|api[- ]?keys?)\b/],
  ["payment", /\b(payments?|thanh toan|billing|refund|hoan tien|invoice|hoa don|charge|tra phi)\b/],
  ["publish", /\b(publish\w*|xuat ban|go live|dang len)\b/],
  ["delete", /\b(delet\w*|xoa|destroy\w*)\b/],
  ["force/prune", /(--force|--prune|\bforce\b|\bprune\b)/],
  ["another theme id", /(theme\s*(id)?\s*(khac|other|another|different)|(khac|other|another|different)\s+theme|theme\s*id\s*\d)/],
  ["user's own account", /(tai khoan (cua )?(anh|toi|minh|ban)|(your|my)( own)? account|account (cua )?(anh|minh))/],
];

/** True when the question is about something only the user may decide (login, payment, publish, delete, ...). */
export function classifyNeedsInput(question, options = []) {
  const text = asciiLower([question, ...(Array.isArray(options) ? options : [])].filter((v) => typeof v === "string").join("\n"));
  const reasons = ONLY_USER_TOPICS.filter(([, re]) => re.test(text)).map(([name]) => name);
  return { onlyUser: reasons.length > 0, reasons };
}

/**
 * Everything but the filesystem mtime check.
 * `ctx` describes the round: { kind, closeToken, tokenUsedAt, tokenUsedRound }. A close round must echo the
 * job's one-time close token; a review round must carry a review verdict.
 */
export function validateReportText(text, job, round, ctx = {}) {
  const parsed = parseReport(text);
  const errors = [...parsed.errors, ...validateReportObject(parsed, job, round, ctx)];
  const n = parsed.json?.needsInput;
  const needsInput = parsed.status === "NEEDS_INPUT" && isObj(n) && isStr(n.question) ? { ...n, ...classifyNeedsInput(n.question, n.options) } : null;
  return { status: parsed.status, json: parsed.json, errors, needsInput };
}

export const REVIEW_VERDICTS = ["PASS", "CONCERNS", "FAIL"];

/** Sheet cells a valid report claims, in verify-sheet's shape. */
export function claimedCells(json) {
  return (json?.sheet?.cells ?? []).map((c) => ({ key: c.keyText, col: isNonEmptyStr(c.col) ? c.col : `col${c.colLetter}`, expect: c.expect, occurrence: c.occurrence }));
}
