// leader-report/1 dashboard block: a worker that replaces an earlier note must say what it removed.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { validateReportObject } from "../../scripts/leader/report.mjs";

const job = { job: "j", slug: "k", subject: { kind: "feedback", issueId: "1", host: "Taiz", shop: "s.example", sheetId: "" } };

const errorsFor = (dashboard) =>
  validateReportObject(
    {
      status: "DONE",
      json: {
        schema: "leader-report/1",
        status: "DONE",
        job: "j",
        key: "k",
        round: 1,
        guard: { issueId: "1", host: "Taiz", shop: "s.example", sheetId: "" },
        dashboard,
        notChecked: [],
      },
    },
    job,
    1,
  );

describe("report dashboard block", () => {
  test("a replaced note is accepted when every removed comment is quoted", () => {
    assert.deepEqual(errorsFor({ commentsAdded: 1, commentsRemoved: 1, removedTexts: ["Em cần anh/chị xác nhận thêm ạ:\n- ..."], commentText: "Em đã fix ạ:\n- ..." }), []);
    assert.deepEqual(errorsFor({ commentsAdded: 1, stageBefore: "Feedback", stageAfter: "Feedback" }), [], "a report that removed nothing needs no new field");
  });

  test("a removal without the exact text of each removed comment is rejected", () => {
    assert.match(errorsFor({ commentsAdded: 1, commentsRemoved: 1 }).join("\n"), /removedTexts/);
    assert.match(errorsFor({ commentsAdded: 1, commentsRemoved: 2, removedTexts: ["only one"] }).join("\n"), /removedTexts/);
  });

  test("wrong types are rejected by field name", () => {
    assert.match(errorsFor({ commentsRemoved: -1 }).join("\n"), /dashboard\.commentsRemoved/);
    assert.match(errorsFor({ commentsRemoved: 1.5, removedTexts: ["a"] }).join("\n"), /dashboard\.commentsRemoved/);
    assert.match(errorsFor({ removedTexts: [1] }).join("\n"), /dashboard\.removedTexts/);
    assert.match(errorsFor({ commentText: 5 }).join("\n"), /dashboard\.commentText/);
  });
});
