// leader-copy-first.test.mjs - copy-first for live themes (owner Tài, 24/11/2026): a work/followup round on the LIVE theme's folder
// pushes only to the shop's staging theme, the Leader QAs staging, and the close round pushes exactly the QA'd files to live.
// Driven through the real CLI; the hrv token probe is a fake that answers by folder (live folder: main, "-staging" folder: from env).

import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { TEMP, cleanup, cli, initJob, settle, world } from "./leader-job-cli-helpers.mjs";

after(cleanup);

const LIVE_ID = "111";
const STAGING_ID = "222";

let counter = 0;
const PROBE = path.join(TEMP, "fake-probe.mjs");
fs.writeFileSync(
  PROBE,
  [
    'const staging = process.cwd().replace(/\\\\/g, "/").endsWith("-staging");',
    `const body = staging ? JSON.parse(process.env.FAKE_STAGING ?? "{}") : { ok: true, themeId: "${LIVE_ID}", orgId: "9", role: "main" };`,
    "process.stdout.write(JSON.stringify(body));",
    "process.exit(body.ok === true ? 0 : 1);",
  ].join("\n"),
);
const STAGING_UNPUBLISHED = JSON.stringify({ ok: true, themeId: STAGING_ID, orgId: "9", role: "unpublished" });
const probeEnv = (staging) => ({ LEADER_TOKEN_PROBE: PROBE, ...(staging ? { FAKE_STAGING: staging } : {}) });

/** A live theme folder (bound, role main by the fake probe), optionally with its bound staging sibling. */
function folders(w, { staging = false } = {}) {
  const live = path.join(w.root, `shop-${++counter}`);
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, ".haravan-cli_local.json"), JSON.stringify({ org_id: 9, theme_id: Number(LIVE_ID) }));
  const stagingDir = `${live}-staging`;
  if (staging) {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, ".haravan-cli_local.json"), JSON.stringify({ org_id: 9, theme_id: Number(STAGING_ID) }));
  }
  return { live: live.replace(/\\/g, "/"), staging: stagingDir.replace(/\\/g, "/") };
}

const copyJob = (w) => initJob(w, "cf", "1", { leaderQa: true });

function workDispatch(w, j, f, env = probeEnv(STAGING_UNPUBLISHED), kind = "work") {
  const n = j.job().rounds.length + 1;
  const file = path.join(w.root, `prompt-cf-${n}.md`);
  fs.writeFileSync(file, `Việc của vòng ${n}. issue 1 host Taiz shop s.example.\nGhi report vào {{REPORT_PATH}}\n`);
  return cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", file, "--kind", kind, "--cwd", f.live], env);
}

/** backup/manifest.json for the files, each with a real copy and its sha256. */
function backupFor(w, files) {
  const dir = path.join(w.root, `backup-${++counter}`);
  fs.mkdirSync(path.join(dir, "r1"), { recursive: true });
  const entries = files.map((p) => {
    const rel = `r1/${p.replace(/\//g, "_")}`;
    const bytes = Buffer.from(`old ${p}`);
    fs.writeFileSync(path.join(dir, rel), bytes);
    return { path: p, backup: rel, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), source: "remote-fetch" };
  });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schema: "leader-backup/1", files: entries }));
  return dir.replace(/\\/g, "/");
}

function report(job, round, over = {}) {
  const json = {
    schema: "leader-report/1",
    status: "DONE",
    job: job.job,
    key: job.slug,
    round,
    guard: { issueId: job.subject.issueId, host: job.subject.host, shop: job.subject.shop, sheetId: job.subject.sheetId },
    summary: "ok",
    dashboard: { commentsAdded: 0, stageBefore: "Feedback", stageAfter: "Feedback" },
    themeRole: "main",
    notChecked: ["nothing else"],
    ...over,
  };
  return `STATUS: ${json.status}\n\nprose\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
}

/** The report of a correct copy-first work round: staged on STAGING_ID, URLs of the staging theme, one smoke per push. */
function stagedReport(w, job, f, round = 1, over = {}) {
  const files = ["sections/x.liquid"];
  return report(job, round, {
    files,
    pushed: [`hrv theme push --only sections/x.liquid --nodelete (theme ${STAGING_ID}, cwd ${f.staging})`],
    staging: { themeId: STAGING_ID, folder: f.staging, role: "unpublished", synced: files, created: false },
    handover: { checks: [{ url: `https://s.example/?themeid=${STAGING_ID}`, viewport: "375x812", selector: ".x", expect: "x visible" }], backup: backupFor(w, files), risks: [] },
    storefront: { measurements: [{ probe: "smoke", url: `https://s.example/?themeid=${STAGING_ID}`, viewport: "375x812", selector: ".x", value: "HTTP 200" }] },
    ...over,
  });
}

function validate(w, j, round, text) {
  fs.writeFileSync(j.job().rounds[round - 1].reportPath, text);
  return cli(w, ["validate-report", "--job", j.dir, "--round", String(round)]);
}

function workRoundDone(w, j, f, over) {
  const d = workDispatch(w, j, f);
  assert.equal(d.code, 0, d.stderr);
  settle(w, j, "terminal-7", 1);
  const v = validate(w, j, 1, stagedReport(w, j.job(), f, 1, over));
  assert.equal(v.code, 0, `${v.stderr}`);
}

describe("init", () => {
  test("a haravan feedback job carries the copyFirst marker, a sheet-only job and an ad-hoc job do not", () => {
    const w = world();
    assert.equal(copyJob(w).job().copyFirst, 1);
    const sheetOnly = cli(w, ["init", "--slug", "so", "--issue-id", "2", "--shop", "s.example", "--no-sheet", "--profile", "sheet-only"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sheetOnly.last.jobDir, "job.json"), "utf8")).copyFirst, undefined);
    const adhoc = cli(w, ["init", "--kind", "adhoc", "--slug", "ad"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(adhoc.last.jobDir, "job.json"), "utf8")).copyFirst, undefined);
  });
});

describe("dispatch of a work round on the live folder", () => {
  test("a bound staging folder is probed and named in the prompt and on the round", () => {
    const w = world();
    const j = copyJob(w);
    const f = folders(w, { staging: true });
    const d = workDispatch(w, j, f);
    assert.equal(d.code, 0, d.stderr);
    assert.equal(d.last.liveTheme, true);
    assert.equal(d.last.copyFirst.stagingThemeId, STAGING_ID);
    assert.equal(d.last.copyFirst.stagingFolder, f.staging);
    const text = fs.readFileSync(d.last.promptPath, "utf8");
    assert.match(text, /# COPY-FIRST: theme live/);
    assert.ok(text.includes(f.staging));
    assert.match(text, /Staging ĐÃ CÓ: theme 222/);
    assert.match(d.stderr, /copy-first applies/);
    assert.equal(j.job().rounds[0].copyFirst.stagingThemeId, STAGING_ID);
  });

  test("no staging folder yet: the prompt tells the worker to create it once, within the owner's scope", () => {
    const w = world();
    const j = copyJob(w);
    const f = folders(w);
    const d = workDispatch(w, j, f, probeEnv());
    assert.equal(d.code, 0, d.stderr);
    assert.equal(d.last.copyFirst.stagingExists, false);
    const text = fs.readFileSync(d.last.promptPath, "utf8");
    assert.match(text, /Staging CHƯA CÓ/);
    assert.match(text, /không publish, không xoá theme nào/);
  });

  test("a staging folder bound to the live theme is refused, and so is one whose role is main", () => {
    const w = world();
    const j = copyJob(w);
    const f = folders(w, { staging: true });
    const same = workDispatch(w, j, f, probeEnv(JSON.stringify({ ok: true, themeId: LIVE_ID, orgId: "9", role: "unpublished" })));
    assert.equal(same.code, 4, same.stderr);
    assert.match(same.last.error, /is the LIVE theme/);
    const main = workDispatch(w, j, f, probeEnv(JSON.stringify({ ok: true, themeId: "333", orgId: "9", role: "main" })));
    assert.equal(main.code, 4, main.stderr);
    assert.equal(j.job().rounds.length, 0, "a refused dispatch records no round");
  });

  test("a job without the marker gets no staging, no block and the old live warning", () => {
    const w = world();
    const j = initJob(w, "old", "1");
    const f = folders(w, { staging: true });
    const d = workDispatch(w, j, f);
    assert.equal(d.code, 0, d.stderr);
    assert.equal(d.last.copyFirst, undefined);
    assert.doesNotMatch(fs.readFileSync(d.last.promptPath, "utf8"), /COPY-FIRST/);
    assert.match(d.stderr, /started before copy-first/);
  });
});

describe("validate-report of a work round on a live copy-first job", () => {
  test("a push that names the live theme or folder is refused", () => {
    const w = world();
    const j = copyJob(w);
    const f = folders(w, { staging: true });
    assert.equal(workDispatch(w, j, f).code, 0);
    settle(w, j, "terminal-7", 1);
    const toLive = validate(w, j, 1, stagedReport(w, j.job(), f, 1, { pushed: [`hrv theme push --only sections/x.liquid --nodelete (theme ${LIVE_ID}, cwd ${f.live})`] }));
    assert.equal(toLive.code, 1);
    assert.match(toLive.last.errors.join("\n"), /names the LIVE theme or its folder/);
    assert.equal(j.job().state, "settled", "the round stays unaccepted");
  });

  test("a push that names neither staging folder nor id, a missing staging block and a live staging id are refused", () => {
    const w = world();
    const j = copyJob(w);
    const f = folders(w, { staging: true });
    assert.equal(workDispatch(w, j, f).code, 0);
    settle(w, j, "terminal-7", 1);
    const vague = validate(w, j, 1, stagedReport(w, j.job(), f, 1, { pushed: ["hrv theme push --only sections/x.liquid --nodelete"] }));
    assert.match(vague.last.errors.join("\n"), /names neither the staging folder/);
    const none = validate(w, j, 1, stagedReport(w, j.job(), f, 1, { staging: undefined }));
    assert.match(none.last.errors.join("\n"), /must carry "staging"/);
    const asLive = validate(w, j, 1, stagedReport(w, j.job(), f, 1, { staging: { themeId: LIVE_ID, folder: f.staging, role: "unpublished" } }));
    assert.match(asLive.last.errors.join("\n"), /is the LIVE theme/);
    const other = validate(w, j, 1, stagedReport(w, j.job(), f, 1, { staging: { themeId: "999", folder: f.staging, role: "unpublished" } }));
    assert.match(other.last.errors.join("\n"), /is not the staging theme 222/);
  });

  test("handover URLs must be ?themeid=<staging id>", () => {
    const w = world();
    const j = copyJob(w);
    const f = folders(w, { staging: true });
    assert.equal(workDispatch(w, j, f).code, 0);
    settle(w, j, "terminal-7", 1);
    const live = validate(w, j, 1, stagedReport(w, j.job(), f, 1, { handover: { checks: [{ url: `https://s.example/?themeid=${LIVE_ID}`, viewport: "375x812", selector: ".x", expect: "x" }], backup: backupFor(w, ["sections/x.liquid"]), risks: [] } }));
    assert.equal(live.code, 1);
    assert.match(live.last.errors.join("\n"), /handover.checks\[0\].url must be \?themeid=222/);
  });

  test("a correct staging report is accepted without a rollback statement; a NEEDS_INPUT that already pushed to live is not", () => {
    const w = world();
    const j = copyJob(w);
    const f = folders(w, { staging: true });
    workRoundDone(w, j, f);
    assert.equal(j.job().state, "reported");
    assert.deepEqual(j.job().rounds[0].report.required.sort(), ["dashboard", "storefront"]);

    const w2 = world();
    const j2 = copyJob(w2);
    const f2 = folders(w2, { staging: true });
    assert.equal(workDispatch(w2, j2, f2).code, 0);
    settle(w2, j2, "terminal-7", 1);
    const bad = validate(w2, j2, 1, report(j2.job(), 1, { status: "NEEDS_INPUT", needsInput: { question: "q?", options: ["a", "b"] }, pushed: [`hrv theme push --only a.liquid --nodelete (theme ${LIVE_ID})`] }));
    assert.equal(bad.code, 1);
    assert.match(bad.last.errors.join("\n"), /must carry "staging"|names the LIVE theme/);
  });

  test("a job without the marker keeps the live rules: a live push is valid with a smoke and a rollback statement", () => {
    const w = world();
    const j = initJob(w, "old", "1");
    const f = folders(w, { staging: true });
    assert.equal(workDispatch(w, j, f).code, 0);
    settle(w, j, "terminal-7", 1);
    const files = ["sections/x.liquid"];
    const text = report(j.job(), 1, {
      files,
      pushed: [`hrv theme push --only sections/x.liquid --nodelete (theme ${LIVE_ID})`],
      handover: { checks: [{ url: `https://s.example/?themeid=${LIVE_ID}`, viewport: "375x812", selector: ".x", expect: "x" }], backup: backupFor(w, files), risks: [] },
      storefront: { measurements: [{ probe: "smoke", url: "u", viewport: "375x812", selector: ".x", value: "HTTP 200" }] },
      rollback: { ran: false, note: "clean" },
      dashboard: { commentsAdded: 1, stageBefore: "Feedback", stageAfter: "Feedback" },
    });
    const v = validate(w, j, 1, text);
    assert.equal(v.code, 0, v.stderr);
  });
});

describe("the close round of a live copy-first job", () => {
  /** A job whose work round was accepted and that the owner approved: the close round can be dispatched. */
  function approved(w, f) {
    const j = copyJob(w);
    workRoundDone(w, j, f);
    j.patch((job) => {
      job.state = "user-approved";
      job.approvedAt = Date.now();
      job.approval = { at: Date.now(), closeToken: "TOK-1", tokenUsedAt: null };
    });
    return j;
  }
  const closeReport = (w, j, f, over = {}) => {
    const files = ["sections/x.liquid"];
    return report(j.job(), 2, {
      closeToken: "TOK-1",
      dashboard: { commentsAdded: 1, commentText: "Em đã fix ạ: xong", stageBefore: "Feedback", stageAfter: "Done" },
      files,
      pushed: [`hrv theme push --only sections/x.liquid --nodelete (theme ${LIVE_ID}, cwd ${f.live})`],
      handover: { checks: [], backup: backupFor(w, files), risks: [] },
      storefront: { measurements: [{ probe: "smoke", url: "https://s.example/", viewport: "375x812", selector: ".x", value: "HTTP 200, no Liquid error" }] },
      rollback: { ran: false, note: "clean" },
      ...over,
    });
  };
  const dispatchClose = (w, j, f) => {
    const d = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--kind", "close"], probeEnv(STAGING_UNPUBLISHED));
    assert.equal(d.code, 0, d.stderr);
    settle(w, j, "terminal-7", 2);
    return d;
  };

  test("the prompt carries the live-ship step with the QA'd files and both theme ids", () => {
    const w = world();
    const f = folders(w, { staging: true });
    const j = approved(w, f);
    const d = dispatchClose(w, j, f);
    const text = fs.readFileSync(d.last.promptPath, "utf8");
    assert.match(text, /BƯỚC 0 \(CHỈ vòng này/);
    assert.ok(text.includes("sections/x.liquid"), "the QA'd files are listed");
    assert.ok(text.includes(f.live));
    assert.match(text, /staging 222/);
    assert.match(text, /LIVE 111/);
    assert.match(d.stderr, /this close round pushes the files you QA'd on staging/);
  });

  test("a close DONE report with the exact push, a backup, a smoke and a rollback statement is accepted and asks for a storefront QA on live", () => {
    const w = world();
    const f = folders(w, { staging: true });
    const j = approved(w, f);
    dispatchClose(w, j, f);
    const v = validate(w, j, 2, closeReport(w, j, f));
    assert.equal(v.code, 0, `${v.stderr}`);
    assert.deepEqual(j.job().rounds[1].report.required.sort(), ["dashboard", "storefront"]);
  });

  test("a close DONE report without the live push, with another file set, or without smoke/rollback/backup is refused", () => {
    const w = world();
    const f = folders(w, { staging: true });
    const j = approved(w, f);
    dispatchClose(w, j, f);
    const none = validate(w, j, 2, closeReport(w, j, f, { pushed: undefined, files: undefined }));
    assert.equal(none.code, 1);
    assert.match(none.last.errors.join("\n"), /lists no `pushed` command/);
    const extra = validate(w, j, 2, closeReport(w, j, f, { pushed: [`hrv theme push --only sections/x.liquid sections/y.liquid --nodelete (theme ${LIVE_ID})`] }));
    assert.match(extra.last.errors.join("\n"), /never QA'd on staging: sections\/y\.liquid/);
    const missing = validate(w, j, 2, closeReport(w, j, f, { pushed: [`hrv theme push --only sections/z.liquid --nodelete (theme ${LIVE_ID})`] }));
    assert.match(missing.last.errors.join("\n"), /QA'd file\(s\) not pushed to live: sections\/x\.liquid/);
    const toStaging = validate(w, j, 2, closeReport(w, j, f, { pushed: [`hrv theme push --only sections/x.liquid --nodelete (theme ${STAGING_ID})`] }));
    assert.match(toStaging.last.errors.join("\n"), /names the staging theme 222/);
    const bare = validate(w, j, 2, closeReport(w, j, f, { storefront: undefined, rollback: undefined, handover: { checks: [], risks: [] } }));
    const text = bare.last.errors.join("\n");
    assert.match(text, /only 0 storefront\.measurements/);
    assert.match(text, /"rollback"/);
    assert.match(text, /handover\.backup is missing/);
  });

  test("config/settings_data.json must come with the re-applied keys, never as a whole-file copy", () => {
    const w = world();
    const f = folders(w, { staging: true });
    const j = copyJob(w);
    workRoundDone(w, j, f, {
      files: ["config/settings_data.json"],
      pushed: [`hrv theme push --only config/settings_data.json --nodelete (theme ${STAGING_ID}, cwd ${f.staging})`],
      handover: { checks: [{ url: `https://s.example/?themeid=${STAGING_ID}`, viewport: "375x812", selector: ".x", expect: "x" }], backup: backupFor(w, ["config/settings_data.json"]), risks: [] },
      settingsKeys: ["header_height"],
    });
    j.patch((job) => {
      job.state = "user-approved";
      job.approvedAt = Date.now();
      job.approval = { at: Date.now(), closeToken: "TOK-1", tokenUsedAt: null };
    });
    const d = dispatchClose(w, j, f);
    assert.match(fs.readFileSync(d.last.promptPath, "utf8"), /header_height/);
    const files = ["config/settings_data.json"];
    const base = { files, pushed: [`hrv theme push --only config/settings_data.json --nodelete (theme ${LIVE_ID})`], handover: { checks: [], backup: backupFor(w, files), risks: [] } };
    const without = validate(w, j, 2, closeReport(w, j, f, base));
    assert.match(without.last.errors.join("\n"), /settingsReapply/);
    const withKeys = validate(w, j, 2, closeReport(w, j, f, { ...base, settingsReapply: { keys: ["header_height"] } }));
    assert.equal(withKeys.code, 0, withKeys.stderr);
  });

  test("a job without the marker closes as before: no live-ship step, no live push demanded", () => {
    const w = world();
    const j = initJob(w, "old", "1");
    const f = folders(w, { staging: true });
    assert.equal(workDispatch(w, j, f).code, 0);
    settle(w, j, "terminal-7", 1);
    j.patch((job) => {
      job.state = "user-approved";
      job.approvedAt = Date.now();
      job.approval = { at: Date.now(), closeToken: "TOK-1", tokenUsedAt: null };
    });
    const d = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--kind", "close"], probeEnv(STAGING_UNPUBLISHED));
    assert.equal(d.code, 0, d.stderr);
    assert.doesNotMatch(fs.readFileSync(d.last.promptPath, "utf8"), /BƯỚC 0 \(CHỈ vòng này/);
  });
});
