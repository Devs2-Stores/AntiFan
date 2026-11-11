// A sheet column with no header text is named col<Letter> by the sheet parser; a report may claim it with colLetter.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { claimedCells, validateReportObject } from "../../scripts/leader/report.mjs";

const job = { job: "j", slug: "s", subject: { issueId: "1", host: "Taiz", shop: "s.example", sheetId: "S" } };
const report = (cell) => ({
  schema: "leader-report/1",
  status: "DONE",
  job: "j",
  key: "s",
  round: 1,
  guard: { issueId: "1", host: "Taiz", shop: "s.example", sheetId: "S" },
  summary: "ok",
  sheet: { cells: [cell] },
  dashboard: { commentsAdded: 1, stageBefore: "Feedback", stageAfter: "Feedback" },
  notChecked: ["nothing else"],
});
const errorsFor = (cell) => validateReportObject({ status: "DONE", json: report(cell) }, job, 1, {});

describe("headerless sheet column", () => {
  test("col \"\" with colLetter is accepted and claimed as col<Letter>", () => {
    const cell = { keyText: "task text", col: "", colLetter: "A", expect: "Fixed" };
    assert.ok(!JSON.stringify(errorsFor(cell)).includes("col must be a header text"));
    assert.equal(claimedCells(report(cell))[0].col, "colA");
  });

  test("an empty col without a valid letter is still refused", () => {
    for (const bad of [{ col: "" }, { col: "", colLetter: "a1" }]) {
      const cell = { keyText: "task text", expect: "Fixed", ...bad };
      assert.match(JSON.stringify(errorsFor(cell)), /col must be a header text/);
    }
  });
});
