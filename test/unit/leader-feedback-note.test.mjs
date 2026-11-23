// The page program of feedback-note.mjs, run against an in-memory dashboard that answers like the
// real API (comments appended at the end, delete by position, list read by GET).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildNoteExpression, exitCodeFor } from "../../scripts/leader/feedback-note.mjs";

function dashboard(rows) {
  const calls = [];
  const state = rows.map((row) => ({ ...row, comments: [...(row.comments ?? [])] }));
  const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
  const fetch = async (url, init = {}) => {
    const action = String(url).replace(/^\/api\//, "").replace(/\?.*$/, "");
    if (!init.method) {
      calls.push(action);
      return json({ feedback: state.map(({ comments, ...row }) => ({ ...row, devNote: JSON.stringify(comments.map((text) => ({ text, time: "t", author: "User" }))) })) });
    }
    const body = JSON.parse(init.body);
    calls.push(`${action}:${JSON.stringify(body)}`);
    const row = state.find((r) => r.rowNumber === Number(body.rowNumber));
    if (!row) return json({ success: false, message: "Row not found" });
    if (action === "addComment") {
      row.comments.push(String(body.commentText).trim());
      return json({ success: true });
    }
    if (action === "deleteComment") {
      if (body.commentIndex < 0 || body.commentIndex >= row.comments.length) return json({ success: false, message: "Invalid comment index" });
      row.comments.splice(body.commentIndex, 1);
      return json({ success: true });
    }
    return json({ success: false, message: "unknown" });
  };
  return { fetch, calls, state, writes: () => calls.filter((c) => c.includes(":")) };
}

async function run(db, args) {
  const raw = await vm.runInNewContext(buildNoteExpression(args), { fetch: db.fetch, Date, JSON, Object, String, Number, Array });
  return JSON.parse(raw);
}

const ISSUE = { id: "1795141927160", host: "Taiz", shop: "zesta.myharavan.com", rowNumber: 344, stage: "Fixed", tags: "haravan", updatedAt: "u1" };
const NOTE = "Em đã fix ạ:\n- Đã thêm mục ảnh cho tab thứ 5.";
const OLD = "Em đã fix ạ:\n- Bản ghi chú cũ.";
const CUSTOMER = "Shop vẫn chưa thấy ảnh";
const target = { id: ISSUE.id, host: ISSUE.host, shop: ISSUE.shop };

test("a wrong host, shop or id writes nothing", async () => {
  for (const [args, result] of [
    [{ ...target, host: "Tuan" }, "GUARD_HOST"],
    [{ ...target, shop: "other.myharavan.com" }, "GUARD_SHOP"],
    [{ ...target, id: "1" }, "GUARD_NOT_FOUND"],
  ]) {
    const db = dashboard([{ ...ISSUE, comments: [CUSTOMER] }]);
    const out = await run(db, { mode: "post", ...args, text: NOTE });
    assert.equal(out.result, result);
    assert.equal(exitCodeFor(out.result), 3);
    assert.deepEqual(db.writes(), []);
  }
  const twins = dashboard([{ ...ISSUE }, { ...ISSUE, rowNumber: 345 }]);
  assert.equal((await run(twins, { mode: "post", ...target, text: NOTE })).result, "GUARD_MULTIPLE");
  assert.deepEqual(twins.writes(), []);
});

test("post appends the note once, by the row the fresh read named, and a second run is a no-op", async () => {
  const db = dashboard([{ ...ISSUE, rowNumber: 7 }, { ...ISSUE, id: "2", rowNumber: 344, comments: ["other issue"] }]);
  db.state[0].comments.push(CUSTOMER);
  const out = await run(db, { mode: "post", ...target, text: `  ${NOTE}\n` });
  assert.equal(out.result, "POSTED");
  assert.deepEqual([out.rowNumber, out.commentsBefore, out.commentsAfter, out.commentsAdded, out.otherFieldsChanged], [7, 1, 2, 1, []]);
  assert.deepEqual(db.state[0].comments, [CUSTOMER, NOTE]);
  assert.deepEqual(db.state[1].comments, ["other issue"], "the issue that owns row 344 is untouched");

  const again = await run(db, { mode: "post", ...target, text: NOTE });
  assert.equal(again.result, "DUPLICATE");
  assert.equal(exitCodeFor(again.result), 0);
  assert.equal(db.writes().length, 1);
});

test("replace posts the new note first, then removes exactly the old one", async () => {
  const db = dashboard([{ ...ISSUE, comments: [OLD, CUSTOMER] }]);
  const out = await run(db, { mode: "post", ...target, text: NOTE, replaceText: OLD });
  assert.equal(out.result, "REPLACED");
  assert.deepEqual(out.sent, ["addComment", "deleteComment"]);
  assert.deepEqual(db.state[0].comments, [CUSTOMER, NOTE]);

  // A run that died between the two writes is finished by the next one without posting twice.
  const half = dashboard([{ ...ISSUE, comments: [OLD, CUSTOMER, NOTE] }]);
  const resumed = await run(half, { mode: "post", ...target, text: NOTE, replaceText: OLD });
  assert.equal(resumed.result, "REPLACED");
  assert.deepEqual(resumed.sent, ["deleteComment"]);
  assert.deepEqual(half.state[0].comments, [CUSTOMER, NOTE]);
});

test("replace refuses before writing when the old note is absent or ambiguous", async () => {
  const absent = dashboard([{ ...ISSUE, comments: [CUSTOMER] }]);
  assert.equal((await run(absent, { mode: "post", ...target, text: NOTE, replaceText: OLD })).result, "MATCH_0");
  assert.deepEqual(absent.writes(), []);
  const twice = dashboard([{ ...ISSUE, comments: [OLD, OLD] }]);
  assert.equal((await run(twice, { mode: "post", ...target, text: NOTE, replaceText: OLD })).result, "MATCH_MANY");
  assert.deepEqual(twice.writes(), []);
});

test("remove deletes one exact text and never a comment that only resembles it", async () => {
  const db = dashboard([{ ...ISSUE, comments: [CUSTOMER, NOTE, `${NOTE} `] }]);
  const out = await run(db, { mode: "remove", ...target, text: NOTE });
  assert.equal(out.result, "REMOVED");
  assert.deepEqual(db.state[0].comments, [CUSTOMER, `${NOTE} `]);
  assert.equal((await run(db, { mode: "remove", ...target, text: NOTE })).result, "MATCH_0");
  assert.equal(db.writes().length, 1);
});

test("a dry run and a read send no write", async () => {
  const db = dashboard([{ ...ISSUE, comments: [OLD] }]);
  assert.equal((await run(db, { mode: "post", ...target, text: NOTE, dryRun: true })).result, "WOULD_POST");
  assert.equal((await run(db, { mode: "post", ...target, text: NOTE, replaceText: OLD, dryRun: true })).result, "WOULD_REPLACE");
  assert.equal((await run(db, { mode: "remove", ...target, text: OLD, dryRun: true })).result, "WOULD_REMOVE");
  const read = await run(db, { mode: "read", ...target });
  assert.deepEqual([read.result, read.rowNumber, read.stage, read.commentsBefore], ["READ", 344, "Fixed", 1]);
  assert.deepEqual(db.writes(), []);
  assert.ok(!JSON.stringify(read).includes("Bản ghi chú cũ"), "comment text of the issue is not returned");
});

test("a write the dashboard did not keep is reported, not assumed", async () => {
  const db = dashboard([{ ...ISSUE, comments: [] }]);
  const realFetch = db.fetch;
  db.fetch = async (url, init = {}) => {
    if (init.method && String(url).includes("addComment")) return { ok: true, status: 200, json: async () => ({ success: true }) };
    return realFetch(url, init);
  };
  const out = await run(db, { mode: "post", ...target, text: NOTE });
  assert.equal(out.result, "VERIFY_FAILED");
  assert.equal(exitCodeFor(out.result), 4);
});

test("the builder refuses an empty note and a missing guard value", () => {
  assert.throws(() => buildNoteExpression({ mode: "post", ...target, text: "  " }), /empty/);
  assert.throws(() => buildNoteExpression({ mode: "post", id: ISSUE.id, host: "", shop: ISSUE.shop, text: NOTE }), /host is required/);
  assert.throws(() => buildNoteExpression({ mode: "edit", ...target, text: NOTE }), /mode must be/);
});
