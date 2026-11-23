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
//     "storefront":{"measurements":[{"probe","url","viewport","selector","value"}]},      // worker smoke numbers only; the Leader's own QA is what verifies
//     "handover":{"checks":[{"url":"...?themeid=...","viewport":"375x812","selector":"...","expect":"..."}],"backup":"<path>","risks":["..."]},
//         // REQUIRED on a DONE work/followup report of a job started under the Leader-QA model (job.leaderQa); older jobs only get a warning
//     "verify":[{"cmd":"rg -n foo E:/Work/x.txt","expect":"foo"}],  // optional, ad-hoc only use: read-only commands for leader-job verify-adhoc
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

const HANDOVER_VIEWPORT_RE = /^\d{2,4}x\d{2,4}$/;

/**
 * The worker's handover to the Leader's own QA (user, 23/11/2026: "Worker chỉ sửa và bàn giao, Leader mới là người
 * review/QA lại"): what to measure, where the backup is, what could still be wrong. Work/followup rounds of a feedback
 * job started under the Leader-QA model (`job.leaderQa`) must carry it on DONE, make no dashboard write and leave the
 * Stage alone; jobs started before it get warnings instead of refusals, so their reports stay valid.
 */
function validateHandover(j, status, job, ctx, errors) {
  const workRound = (ctx.kind === "work" || ctx.kind === "followup") && job.subject?.kind !== "adhoc";
  // A sheet-only job has no theme and no storefront to QA: it hands over nothing, but it still writes nothing on the dashboard.
  const themeJob = job.profile !== "sheet-only";
  const strict = workRound && job.leaderQa === 1;
  const warn = (m) => ctx.warnings?.push(m);
  const h = j.handover;
  if (h !== undefined) {
    if (!isObj(h)) {
      errors.push("handover must be an object {checks, backup, risks}");
    } else {
      if (!Array.isArray(h.checks)) errors.push("handover.checks must be an array of {url, viewport, selector, expect}");
      else
        h.checks.forEach((c, i) => {
          const at = `handover.checks[${i}]`;
          if (!isObj(c) || !isNonEmptyStr(c.url) || !isNonEmptyStr(c.selector) || !isNonEmptyStr(c.expect)) errors.push(`${at} must be {url, viewport, selector, expect} with non-empty url, selector and expect strings`);
          else if (!isStr(c.viewport) || !c.viewport.split("|").every((v) => HANDOVER_VIEWPORT_RE.test(v.trim()))) errors.push(`${at}.viewport must be WIDTHxHEIGHT (several joined by "|"), e.g. 375x812|1440x900`);
        });
      if (h.backup !== undefined && !isStr(h.backup)) errors.push("handover.backup must be a string (path of the pre-change backup)");
      if (h.risks !== undefined && !isStrArray(h.risks)) errors.push("handover.risks must be an array of strings");
      const shipped = (Array.isArray(j.files) && j.files.length > 0) || (Array.isArray(j.pushed) && j.pushed.length > 0);
      if (status === "DONE" && shipped && Array.isArray(h.checks) && h.checks.length === 0) {
        const m = "handover.checks is empty although the report lists files or pushes: the Leader has nothing to QA";
        if (strict) errors.push(m);
        else warn(m);
      }
    }
  } else if (workRound && themeJob && status === "DONE") {
    const m = "DONE work report carries no handover {checks, backup, risks}: the Leader QAs from handover.checks";
    if (strict) errors.push(m);
    else warn(`${m} (job started before the Leader-QA model: accepted)`);
  }
  if (!strict) return; // a job started under the old header may still comment and set Pending itself
  const d = j.dashboard;
  if (isObj(d)) {
    if ((d.commentsAdded ?? 0) > 0 || (d.commentsRemoved ?? 0) > 0) {
      errors.push("a work/followup round makes no dashboard comment (the Leader QAs first; the close round posts the note)");
    }
    if (isStr(d.stageBefore) && isStr(d.stageAfter) && d.stageBefore !== d.stageAfter) {
      errors.push(`a work/followup round never changes the Stage (stageBefore ${JSON.stringify(d.stageBefore)}, stageAfter ${JSON.stringify(d.stageAfter)}): only the close round does`);
    }
  }
  if (status === "PENDING") warn("PENDING is not used in the Leader-QA model: report NEEDS_INPUT with a question and 2-3 options instead of asking the customer");
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
  if (j.verify !== undefined) {
    if (!Array.isArray(j.verify)) errors.push("verify must be an array of {cmd, expect}");
    else
      j.verify.forEach((v, i) => {
        if (!isObj(v) || !isNonEmptyStr(v.cmd) || !isStr(v.expect)) errors.push(`verify[${i}] must be {cmd, expect} with a non-empty cmd string and an expect string`);
        // An empty expect passes on any stdout. `node --check` prints nothing (its exit code is the proof), and `rg -c` prints a bare count.
        else if (v.expect.trim().length < 3 && !/^\s*node\s+--check\s/.test(v.cmd) && !(/^\d+$/.test(v.expect.trim()) && /\s(-c|--count)(\s|$)/.test(v.cmd))) errors.push(`verify[${i}].expect must be a non-empty distinctive string (at least 3 characters)`);
      });
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
  validateHandover(j, status, job, ctx, errors);
  if (status === "NEEDS_INPUT") {
    const n = j.needsInput;
    if (!isObj(n)) errors.push("NEEDS_INPUT report must carry needsInput {question, options}");
    else {
      if (!isNonEmptyStr(n.question)) errors.push("needsInput.question must be a non-empty string");
      if (!(Array.isArray(n.options) && n.options.length >= 2 && n.options.length <= 3 && n.options.every(isNonEmptyStr))) {
        const got = JSON.stringify(n.options === undefined ? null : n.options);
        errors.push(`needsInput.options must be an array of 2 or 3 non-empty strings (for example ["<option 1>", "<option 2>"]), got ${head(got, 160)}`);
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
  if (ctx.caps && (ctx.caps.limits || ctx.caps.forbid)) errors.push(...validateCapsEcho(j.caps, ctx.caps, status));
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

/**
 * The round's side-effect caps (dispatch --cap name=value / --forbid text) against the worker's own `caps` echo:
 * { used: {name: number}, forbiddenDone: [] }. Usage above a cap, a missing counter or any forbidden action listed is an error.
 * A NEEDS_INPUT report may omit the echo or list only some counters (it can be written mid-run), but any value present is still checked.
 */
export function validateCapsEcho(echo, caps, status) {
  const errors = [];
  const limits = caps.limits ?? {};
  const forbid = caps.forbid ?? [];
  const partial = status === "NEEDS_INPUT";
  if (echo === undefined) {
    if (!partial) {
      const want = [...Object.keys(limits).map((k) => `used.${k}`), ...(forbid.length ? ["forbiddenDone"] : [])].join(", ");
      errors.push(`this round has side-effect caps: the report must carry caps {used, forbiddenDone} (${want})`);
    }
    return errors;
  }
  if (!isObj(echo)) return ["caps must be an object {used: {name: number}, forbiddenDone: []}"];
  const names = Object.keys(limits);
  if (names.length) {
    if (echo.used !== undefined && !isObj(echo.used)) errors.push("caps.used must be an object of counters, one per cap");
    else if (echo.used === undefined) {
      if (!partial) errors.push("caps.used must be an object of counters, one per cap");
    } else {
      for (const name of names) {
        const v = echo.used[name];
        if (v === undefined && partial) continue;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) errors.push(`caps.used.${name} must be a non-negative number (cap ${limits[name]})`);
        else if (v > limits[name]) errors.push(`cap exceeded: ${name} used ${v}, cap ${limits[name]}`);
      }
    }
  }
  if (forbid.length) {
    if (echo.forbiddenDone === undefined && partial) return errors;
    if (!isStrArray(echo.forbiddenDone)) errors.push("caps.forbiddenDone must be an array of strings (forbidden actions you did; [] when none)");
    else if (echo.forbiddenDone.length) errors.push(`forbidden action reported done: ${echo.forbiddenDone.join(", ")}`);
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
  const warnings = [];
  const errors = [...parsed.errors, ...validateReportObject(parsed, job, round, { ...ctx, warnings })];
  const n = parsed.json?.needsInput;
  const needsInput = parsed.status === "NEEDS_INPUT" && isObj(n) && isStr(n.question) ? { ...n, ...classifyNeedsInput(n.question, n.options) } : null;
  return { status: parsed.status, json: parsed.json, errors, warnings, needsInput };
}

export const REVIEW_VERDICTS = ["PASS", "CONCERNS", "FAIL"];

/** Sheet cells a valid report claims, in verify-sheet's shape. */
export function claimedCells(json) {
  return (json?.sheet?.cells ?? []).map((c) => ({ key: c.keyText, col: isNonEmptyStr(c.col) ? c.col : `col${c.colLetter}`, expect: c.expect, occurrence: c.occurrence }));
}
