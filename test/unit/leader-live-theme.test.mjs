// leader-live-theme.test.mjs - a worker on a LIVE theme pushes straight to the bound theme (owner 03/11/2026): no staging probe, no
// COPY-FIRST block, no live-ship step in the close round. A job.json that still carries the retired `copyFirst` marker (and rounds that
// carry `round.copyFirst`) is treated as if it did not. Driven through the real CLI; the hrv token probe is a fake (live theme, role main).

import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { TEMP, cleanup, cli, initJob, settle, world } from "./leader-job-cli-helpers.mjs";

after(cleanup);

const LIVE_ID = "111";

let counter = 0;
const PROBE = path.join(TEMP, "fake-live-probe.mjs");
fs.writeFileSync(
  PROBE,
  [`const body = { ok: true, themeId: "${LIVE_ID}", orgId: "9", role: "main" };`, "process.stdout.write(JSON.stringify(body));", "process.exit(0);"].join("\n"),
);
const probeEnv = { LEADER_TOKEN_PROBE: PROBE };

/** A bound theme folder (role main by the fake probe) with a sibling `-staging` folder that the Leader must ignore. */
function folders(w) {
  const live = path.join(w.root, `shop-${++counter}`);
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, ".haravan-cli_local.json"), JSON.stringify({ org_id: 9, theme_id: Number(LIVE_ID) }));
  const staging = `${live}-staging`;
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, ".haravan-cli_local.json"), JSON.stringify({ org_id: 9, theme_id: 222 }));
  return { live: live.replace(/\\/g, "/") };
}

function workDispatch(w, j, f, kind = "work") {
  const n = j.job().rounds.length + 1;
  const file = path.join(w.root, `prompt-live-${n}.md`);
  fs.writeFileSync(file, `Việc của vòng ${n}. issue 1 host Taiz shop s.example.\nGhi report vào {{REPORT_PATH}}\n`);
  return cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--prompt", file, "--kind", kind, "--cwd", f.live], probeEnv);
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

/** The report of a live push: the bound theme itself, a backup manifest, one smoke per push and a rollback statement. */
function liveReport(w, job, round = 1, over = {}) {
  const files = ["sections/x.liquid"];
  return report(job, round, {
    files,
    pushed: [`hrv theme push --only sections/x.liquid --nodelete (theme ${LIVE_ID})`],
    handover: { checks: [{ url: `https://s.example/?themeid=${LIVE_ID}`, viewport: "375x812", selector: ".x", expect: "x visible" }], backup: backupFor(w, files), risks: [] },
    storefront: { measurements: [{ probe: "smoke", url: `https://s.example/?themeid=${LIVE_ID}`, viewport: "375x812", selector: ".x", value: "HTTP 200" }] },
    rollback: { ran: false, note: "clean" },
    ...over,
  });
}

function validate(w, j, round, text) {
  fs.writeFileSync(j.job().rounds[round - 1].reportPath, text);
  return cli(w, ["validate-report", "--job", j.dir, "--round", String(round)]);
}

/** A job started under the retired copy-first rule: the marker is still in job.json. */
const legacyJob = (w) => {
  const j = initJob(w, "lv", "1", { leaderQa: true });
  j.patch((job) => {
    job.copyFirst = 1;
  });
  return j;
};

describe("init", () => {
  test("a haravan feedback job carries no copyFirst marker", () => {
    const w = world();
    assert.equal(initJob(w, "fresh", "1", { leaderQa: true }).job().copyFirst, undefined);
  });
});

describe("dispatch of a work round on the live folder", () => {
  test("no staging probe, no COPY-FIRST block, and the warning says the worker pushes to the live theme", () => {
    const w = world();
    const j = legacyJob(w);
    const f = folders(w);
    const d = workDispatch(w, j, f);
    assert.equal(d.code, 0, d.stderr);
    assert.equal(d.last.liveTheme, true);
    assert.equal(d.last.copyFirst, undefined);
    assert.doesNotMatch(fs.readFileSync(d.last.promptPath, "utf8"), /COPY-FIRST/);
    assert.match(d.stderr, /pushes straight to what customers see now/);
    assert.equal(j.job().rounds[0].copyFirst, undefined);
  });
});

describe("validate-report of a work round on a live theme", () => {
  test("a push to the bound live theme with a backup, a smoke and a rollback statement is accepted, whatever a legacy marker says", () => {
    const w = world();
    const j = legacyJob(w);
    const f = folders(w);
    assert.equal(workDispatch(w, j, f).code, 0);
    settle(w, j, "terminal-7", 1);
    // A round record that still carries the retired block must not change the verdict.
    j.patch((job) => {
      job.rounds[0].copyFirst = { liveFolder: f.live, stagingFolder: `${f.live}-staging`, stagingThemeId: "222" };
    });
    const v = validate(w, j, 1, liveReport(w, j.job(), 1));
    assert.equal(v.code, 0, v.stderr);
    assert.deepEqual(j.job().rounds[0].report.required.sort(), ["dashboard", "storefront"]);
  });

  test("the live-theme gates stay: a live push without a rollback statement or a smoke is refused", () => {
    const w = world();
    const j = legacyJob(w);
    const f = folders(w);
    assert.equal(workDispatch(w, j, f).code, 0);
    settle(w, j, "terminal-7", 1);
    const bare = validate(w, j, 1, liveReport(w, j.job(), 1, { rollback: undefined, storefront: undefined }));
    assert.equal(bare.code, 1);
    const text = bare.last.errors.join("\n");
    assert.match(text, /only 0 storefront\.measurements/);
    assert.match(text, /"rollback"/);
    assert.doesNotMatch(text, /staging/);
  });
});

describe("the close round", () => {
  test("a job with a legacy marker closes with the dashboard steps only: no live-ship step and no push demanded", () => {
    const w = world();
    const j = legacyJob(w);
    const f = folders(w);
    assert.equal(workDispatch(w, j, f).code, 0);
    settle(w, j, "terminal-7", 1);
    assert.equal(validate(w, j, 1, liveReport(w, j.job(), 1)).code, 0);
    j.patch((job) => {
      job.state = "user-approved";
      job.approvedAt = Date.now();
      job.approval = { at: Date.now(), closeToken: "TOK-1", tokenUsedAt: null };
    });
    const d = cli(w, ["dispatch", "--job", j.dir, "--worker", "terminal-7", "--kind", "close"], probeEnv);
    assert.equal(d.code, 0, d.stderr);
    const text = fs.readFileSync(d.last.promptPath, "utf8");
    assert.doesNotMatch(text, /BƯỚC 0/);
    assert.doesNotMatch(text, /staging/i);
    settle(w, j, "terminal-7", 2);
    const close = validate(
      w,
      j,
      2,
      report(j.job(), 2, {
        closeToken: "TOK-1",
        dashboard: { commentsAdded: 1, commentText: "Em đã fix ạ: xong", stageBefore: "Feedback", stageAfter: "Done" },
      }),
    );
    assert.equal(close.code, 0, close.stderr);
    assert.deepEqual(j.job().rounds[1].report.required, ["dashboard"]);
  });
});
