// ask-dialog.test.mjs - the open `ask` dialog of a waiting_user worker is read from its OMP transcript, and the key
// lists that answer it follow the dialog's own rules (cursor starts on `recommended`, Enter selects).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { keysForOption, pendingAsk, pendingAskOf } from "../../scripts/leader/ask-dialog.mjs";
import { judgeWorker } from "../../scripts/leader/wait-workers.mjs";
import { status } from "../../scripts/leader/worker-status.mjs";

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "ask-dialog-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const OMP_ID = "01a1a24d-03e8-70d3-aa69-99aa7597166d";
const CWD = "E:\\Work\\apps\\AntiFan";

const assistantAsk = (id, questions) =>
  JSON.stringify({
    type: "message",
    id: `m-${id}`,
    timestamp: "2026-11-03T18:09:44.487Z",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "toolCall", id, name: "ask", arguments: { i: "intent", questions } }] },
  });
const askResult = (id, isError = false) =>
  JSON.stringify({ type: "message", id: `r-${id}`, message: { role: "toolResult", toolCallId: id, toolName: "ask", content: [{ type: "text", text: "User selected: A" }], isError } });
const startEvent = (id) => JSON.stringify({ type: "custom", customType: "tool_execution_start", data: { toolCallId: id, toolName: "ask", startedAt: "2026-11-03T18:09:44.774Z" } });

const restore = {
  id: "restore",
  question: "Restore node_modules how?",
  options: [{ label: "Reinstall 22 packages", description: "npm install --no-save" }, { label: "Clean copy elsewhere" }, { label: "Skip" }],
  recommended: 1,
};

describe("keysForOption", () => {
  test("the cursor starts on the recommended option (0 without one) and Enter selects", () => {
    assert.deepEqual(keysForOption({ options: [{}, {}, {}], recommended: 1 }, 1), ["enter"]);
    assert.deepEqual(keysForOption({ options: [{}, {}, {}], recommended: 1 }, 2), ["down", "enter"]);
    assert.deepEqual(keysForOption({ options: [{}, {}, {}], recommended: 1 }, 0), ["up", "enter"]);
    assert.deepEqual(keysForOption({ options: [{}, {}, {}], recommended: null }, 2), ["down", "down", "enter"]);
  });

  test("a recommended index outside the list clamps like the dialog, and an option outside the list throws", () => {
    assert.deepEqual(keysForOption({ options: [{}, {}], recommended: 9 }, 0), ["up", "enter"]);
    assert.throws(() => keysForOption({ options: [{}, {}], recommended: null }, 2), /option must be 0\.\.1/);
  });
});

describe("pendingAsk", () => {
  test("an ask call without a result is the open dialog, with answer keys per option", () => {
    const text = [assistantAsk("t1", [restore]), startEvent("t1")].join("\n");
    const ask = pendingAsk(text);
    assert.equal(ask.toolCallId, "t1");
    assert.equal(ask.answerable, true);
    const [q] = ask.questions;
    assert.equal(q.question, "Restore node_modules how?");
    assert.equal(q.recommended, 1);
    assert.deepEqual(q.options.map((o) => o.label), ["Reinstall 22 packages", "Clean copy elsewhere", "Skip"]);
    assert.deepEqual(q.answerKeys, [["up", "enter"], ["enter"], ["down", "enter"]]);
  });

  test("an answered or cancelled ask is not open, and a later ask replaces an earlier open one", () => {
    assert.equal(pendingAsk([assistantAsk("t1", [restore]), askResult("t1")].join("\n")), null);
    assert.equal(pendingAsk([assistantAsk("t1", [restore]), askResult("t1", true)].join("\n")), null);
    const second = pendingAsk([assistantAsk("t1", [restore]), askResult("t1"), assistantAsk("t2", [{ ...restore, question: "Second?" }])].join("\n"));
    assert.equal(second.toolCallId, "t2");
    assert.equal(second.questions[0].question, "Second?");
  });

  test("several questions need one more Enter on the Submit tab, one question submits by itself (checked against the real dialog component with ask-keys-probe.ts)", () => {
    assert.deepEqual(pendingAsk(assistantAsk("t1", [restore])).finishKeys, []);
    const two = pendingAsk(assistantAsk("t2", [restore, { ...restore, id: "second", question: "Second?", recommended: undefined }]));
    assert.deepEqual(two.finishKeys, ["enter"]);
    assert.equal(two.answerable, true);
    assert.deepEqual(two.questions[1].answerKeys[0], ["enter"], "no recommended: the cursor starts on the first option");
  });

  test("a multi-choice question has no answer keys and makes the dialog unanswerable by keys alone", () => {
    const ask = pendingAsk(assistantAsk("t1", [{ ...restore, multi: true }]));
    assert.equal(ask.questions[0].multi, true);
    assert.equal("answerKeys" in ask.questions[0], false);
    assert.equal(ask.answerable, false);
  });

  test("a cut first line of a tail read and unrelated lines are skipped", () => {
    const text = ['{"type":"message","id":"cut","message":{"role":"assistant","content":[{"type":"toolCall","name":"ask"', "not json at all", assistantAsk("t9", [restore])].join("\n");
    assert.equal(pendingAsk(text).toolCallId, "t9");
  });
});

/** One run file + transcript pair with `lines` as the transcript. */
function fixture(lines, patch = {}) {
  const runsDir = fs.mkdtempSync(path.join(TEMP, "runs-"));
  const sessionsDir = fs.mkdtempSync(path.join(TEMP, "sessions-"));
  const run = { schema: 1, terminalSessionId: "terminal-t", ompSessionId: OMP_ID, pid: process.pid, cwd: CWD, state: "waiting_user", runSeq: 2, lastEventAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000, ...patch };
  fs.writeFileSync(path.join(runsDir, "terminal-t.json"), JSON.stringify(run));
  const slug = `--${CWD.replace(/[\\/:]/g, "-")}--`;
  fs.mkdirSync(path.join(sessionsDir, slug), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, slug, `2026-11-03T18-00-00-000Z_${OMP_ID}.jsonl`), `${lines.join("\n")}\n`);
  return { run, runsDir, sessionsDir };
}

describe("the open ask reaches the Leader's tools", () => {
  test("worker-status prints the question and options of a waiting_user worker, read from its real transcript file", () => {
    const { runsDir, sessionsDir } = fixture([assistantAsk("t1", [restore]), startEvent("t1")]);
    const { out } = status({ terminal: "terminal-t", runsDir, sessionsDir, tools: 3 }, 1_800_000_030_000);
    assert.equal(out.state, "waiting_user");
    assert.equal(out.ask.questions[0].question, "Restore node_modules how?");
    assert.deepEqual(out.ask.questions[0].answerKeys[2], ["down", "enter"]);
  });

  test("worker-status carries no ask for a worker that is not waiting", () => {
    const { runsDir, sessionsDir } = fixture([assistantAsk("t1", [restore])], { state: "idle" });
    const { out } = status({ terminal: "terminal-t", runsDir, sessionsDir, tools: 3 }, 1_800_000_030_000);
    assert.equal("ask" in out, false);
  });

  test("pendingAskOf is null for a run in another state, with no transcript, or after the dialog was answered", () => {
    const open = fixture([assistantAsk("t1", [restore])]);
    assert.notEqual(pendingAskOf(open.sessionsDir, open.run), null);
    assert.equal(pendingAskOf(open.sessionsDir, { ...open.run, state: "idle" }), null);
    assert.equal(pendingAskOf(fs.mkdtempSync(path.join(TEMP, "empty-")), open.run), null);
    const answered = fixture([assistantAsk("t1", [restore]), askResult("t1")]);
    assert.equal(pendingAskOf(answered.sessionsDir, answered.run), null);
  });

  test("a waiting_user worker still settles in wait-workers (the Leader is the one who answers it)", () => {
    const { run } = fixture([assistantAsk("t1", [restore])]);
    const row = judgeWorker({ terminal: "terminal-t", writtenAt: 1_799_999_000_000, minRunSeq: 1, report: null }, run, null, null, { pidAlive: true, now: 1_800_000_030_000, staleMs: 90 * 60_000 });
    assert.equal(row.settled, true);
    assert.equal(row.state, "waiting_user");
  });
});
