import assert from "node:assert/strict";
import { test } from "node:test";
import { crossCheck, indexTranscript } from "../../scripts/leader/evidence-xcheck.mjs";
import { validateReportObject } from "../../scripts/leader/report.mjs";
import { buildOutcome } from "../../scripts/leader/learn.mjs";

const call = (id, name, args, ts = "2026-11-17T01:00:00Z") =>
  JSON.stringify({ timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
const result = (id, name, isError = false) => JSON.stringify({ timestamp: "2026-11-17T01:00:01Z", message: { role: "toolResult", toolCallId: id, toolName: name, isError } });

test("claimed file with a matching edit call is corroborated; untouched file is not", () => {
  const t = [call("1", "edit", { input: "[E:/Work/themes/x/a.liquid#AB12]\nPUT 1" }), result("1", "edit")].join("\n");
  const x = crossCheck({ files: ["E:/Work/themes/x/a.liquid", "E:/Work/themes/x/never-touched.liquid"] }, indexTranscript(t), { status: "DONE" });
  assert.deepEqual(x.corroborated, ["files: E:/Work/themes/x/a.liquid"]);
  assert.deepEqual(x.uncorroborated, ["files: E:/Work/themes/x/never-touched.liquid"]);
  assert.deepEqual(x.contradicted, []);
});

test("DONE with only bookkeeping tool calls is contradicted; review and adhoc-without-files are exempt", () => {
  const t = [call("1", "todo_write", {}), result("1", "todo_write")].join("\n");
  const idx = indexTranscript(t);
  assert.equal(crossCheck({ files: [] }, idx, { status: "DONE" }).contradicted.length, 1);
  assert.equal(crossCheck({ files: [] }, idx, { status: "DONE", kind: "review" }).contradicted.length, 0);
  assert.equal(crossCheck({ files: [] }, idx, { status: "DONE", adhoc: true }).contradicted.length, 0);
});

test("unreadable transcript is unknown, never contradicted", () => {
  const x = crossCheck({ files: ["a.liquid"] }, indexTranscript("not json\n"), { status: "DONE" });
  assert.deepEqual(x.contradicted, []);
  assert.equal(x.unknown.length, 1);
});

test("a failed edit does not corroborate; pushed needs a successful hrv theme push", () => {
  const t = [call("1", "edit", { input: "a.liquid" }), result("1", "edit", true), call("2", "bash", { command: "hrv theme push --nodelete" }), result("2", "bash")].join("\n");
  const x = crossCheck({ files: ["a.liquid"], pushed: ["a.liquid"] }, indexTranscript(t), { status: "DONE" });
  assert.equal(x.uncorroborated.includes("files: a.liquid"), true);
  assert.equal(x.corroborated.includes("pushed: a.liquid"), true);
});

const job = { subject: { kind: "adhoc" } };
const base = { status: "DONE", notChecked: [], summary: "x" };

test("verify[].expect must be distinctive; node --check may omit it", () => {
  const bad = validateReportObject({ status: "DONE", json: { ...base, verify: [{ cmd: "rg -n -e a E:/Work/x", expect: "" }] } }, job, 1);
  assert.ok(bad.some((e) => /verify\[0\]\.expect must be a non-empty distinctive string/.test(e)), bad.join("|"));
  const ok = validateReportObject({ status: "DONE", json: { ...base, verify: [{ cmd: "node --check E:/Work/x.mjs", expect: "" }, { cmd: "rg -n -e a E:/Work/x", expect: "abc" }] } }, job, 1);
  assert.ok(!ok.some((e) => /verify\[/.test(e)), ok.join("|"));
});

test("buildOutcome never puts a file path in verificationRef", () => {
  const o = buildOutcome({ job: "j", rounds: [{ n: 1, report: { valid: true }, reportPath: "E:/nope/r.md" }], receiptId: "rcpt-123" }, { ANTIFAN_CORE_PACK_ID: "pack-9" });
  assert.equal(o.verificationRef, "rcpt-123");
  assert.deepEqual(o.packIds, ["pack-9"]);
  const none = buildOutcome({ job: "j", rounds: [{ n: 1, report: { valid: true }, reportPath: "E:/nope/r.md" }] }, {});
  assert.equal(none.verificationRef, null);
});
