// lint-report: the report-file checks of validate-report without a settled round and without writing job state.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { cleanup, cli, dispatch, initJob, reportText, world } from "./leader-job-cli-helpers.mjs";

after(cleanup);

const reportFile = (w, text, name) => {
  const file = path.join(w.root, name);
  fs.writeFileSync(file, text);
  return file;
};
const fenced = (obj) => `\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;

describe("lint-report", () => {
  test("a valid report lints clean without --job and writes nothing", () => {
    const w = world();
    const j = initJob(w);
    const before = fs.readFileSync(path.join(j.dir, "job.json"), "utf8");
    const file = reportFile(w, reportText(j.job(), 1), "ok.md");
    const r = cli(w, ["lint-report", "--file", file]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.last.cmd, "lint-report");
    assert.equal(r.last.valid, true);
    assert.equal(r.last.kind, "work");
    assert.deepEqual(r.last.errors, []);
    assert.equal(fs.readFileSync(path.join(j.dir, "job.json"), "utf8"), before, "no job state written");
  });

  test("every shape error is listed: field arrays, verify expect, extra json block, first line", () => {
    const w = world();
    const job = initJob(w, "shape").job();
    const cases = [
      [reportText(job, 1, { pushed: ["ok", 3] }), /pushed must be an array of strings/],
      [reportText(job, 1, { notChecked: "no" }), /notChecked must be an array of strings/],
      [reportText(job, 1, { evidence: "nope" }), /evidence must be an array of strings/],
      [reportText(job, 1, { verify: [{ cmd: "rg -n x E:/Work/y.txt", expect: "ab" }] }), /verify\[0\]\.expect/],
      [`DONE\n${fenced({ schema: "leader-report/1", status: "DONE" })}`, /first line must be "STATUS:/],
      [`STATUS: DONE\n${fenced({ schema: "leader-report/1", status: "DONE" })}${fenced({})}`, /found 2 fenced json blocks, expected exactly one/],
      ["STATUS: DONE\n\nprose without a block\n", /no fenced ```json block found/],
    ];
    cases.forEach(([text, re], i) => {
      const file = reportFile(w, text, `bad-${i}.md`);
      const r = cli(w, ["lint-report", "--file", file]);
      assert.equal(r.code, 1, `${re}: ${r.stdout}`);
      assert.equal(r.last.valid, false);
      assert.ok(r.last.errors.some((e) => re.test(e)), `${re} in ${JSON.stringify(r.last.errors)}`);
    });
  });

  test("needsInput.options names the exact accepted shape", () => {
    const w = world();
    const job = initJob(w, "asks").job();
    const file = reportFile(w, reportText(job, 1, { status: "NEEDS_INPUT", needsInput: { question: "Chọn?", options: ["chỉ một"] } }), "asks.md");
    const r = cli(w, ["lint-report", "--file", file]);
    assert.equal(r.code, 1);
    const msg = r.last.errors.find((e) => /needsInput\.options/.test(e));
    assert.ok(msg, JSON.stringify(r.last.errors));
    assert.match(msg, /array of 2 or 3 non-empty strings/);
    assert.match(msg, /\["<option 1>", "<option 2>"\]/);
    assert.match(msg, /got \["chỉ một"\]/);
  });

  test("--job checks the guard values, the round and the handover rules of that job; it still writes no state", () => {
    const w = world();
    const j = initJob(w, "job", "1", { leaderQa: true });
    assert.equal(dispatch(w, j, "terminal-7", "work").code, 0);
    const round = j.job().rounds[0];
    // DONE work report without handover: refused by the Leader-QA model.
    fs.writeFileSync(round.reportPath, reportText(j.job(), 1, { dashboard: { commentsAdded: 0, stageBefore: "Feedback", stageAfter: "Feedback" } }));
    const bad = cli(w, ["lint-report", "--file", round.reportPath, "--job", j.dir]);
    assert.equal(bad.code, 1, bad.stdout);
    assert.ok(bad.last.errors.some((e) => /handover/.test(e)), JSON.stringify(bad.last.errors));
    assert.equal(j.job().state, "dispatched", "lint-report never settles or validates the round");
    assert.equal(j.job().rounds[0].settledAt, null);
    assert.equal(j.job().rounds[0].report, null);

    // The same file without --job only gets the pre-model warning: the job-dependent rules were not checked.
    const loose = cli(w, ["lint-report", "--file", round.reportPath]);
    assert.equal(loose.code, 0, loose.stdout);
    assert.match(JSON.stringify(loose.last.warnings), /handover/);
    assert.match(loose.last.note, /no --job/);

    // A guard mismatch is caught against the real job.
    fs.writeFileSync(
      round.reportPath,
      reportText(j.job(), 1, {
        guard: { issueId: "999", host: j.job().subject.host, shop: j.job().subject.shop, sheetId: "" },
        dashboard: { commentsAdded: 0, stageBefore: "Feedback", stageAfter: "Feedback" },
        handover: { checks: [{ url: "https://s.example/?themeid=1", viewport: "375x812", selector: ".x", expect: "present" }], backup: "E:/b", risks: [] },
      }),
    );
    const guard = cli(w, ["lint-report", "--file", round.reportPath, "--job", j.dir]);
    assert.equal(guard.code, 1);
    assert.match(guard.last.errors.join("\n"), /guard\.issueId mismatch/);

    // A complete Leader-QA report lints clean.
    fs.writeFileSync(
      round.reportPath,
      reportText(j.job(), 1, {
        dashboard: { commentsAdded: 0, stageBefore: "Feedback", stageAfter: "Feedback" },
        handover: { checks: [{ url: "https://s.example/?themeid=1", viewport: "375x812|1440x900", selector: ".buy", expect: "visible" }], backup: "E:/b", risks: ["menu on tablet"] },
      }),
    );
    const ok = cli(w, ["lint-report", "--file", round.reportPath, "--job", j.dir]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.last.job, j.job().job);
  });

  test("--kind review makes the review block required; a missing file and a bad --kind exit 2", () => {
    const w = world();
    const job = initJob(w, "kinds").job();
    const plain = reportFile(w, reportText(job, 1), "plain.md");
    const needs = cli(w, ["lint-report", "--file", plain, "--kind", "review"]);
    assert.equal(needs.code, 1);
    assert.match(needs.last.errors.join("\n"), /review round report must carry review/);
    const review = reportFile(w, reportText(job, 1, { review: { verdict: "PASS", findings: [] } }), "rev.md");
    assert.equal(cli(w, ["lint-report", "--file", review, "--kind", "review"]).code, 0);
    assert.equal(cli(w, ["lint-report", "--file", path.join(w.root, "missing.md")]).code, 2);
    assert.equal(cli(w, ["lint-report", "--file", plain, "--kind", "nope"]).code, 2);
  });
});
