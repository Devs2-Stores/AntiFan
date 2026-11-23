// pendingLessons on needs-me and status: the WHOLE Core PENDING queue, counted from the same source `lessons` reads.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { TEMP, cleanup, cli, initJob, world } from "./leader-job-cli-helpers.mjs";

after(cleanup);

let n = 0;
const DAY = 24 * 3600 * 1000;
/** A fake Core CLI: `candidates` prints the given rows, so the ledger sees a queue of exactly that age and size. */
function fakeCore(rows) {
  const file = path.join(TEMP, `core-${++n}.cjs`);
  fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(JSON.stringify(rows))});\n`);
  return file;
}
const rows = (count, ageDays) =>
  Array.from({ length: count }, (_, i) => ({ candidateId: `cand-${i}`, status: "PENDING", createdAt: new Date(Date.now() - ageDays * DAY).toISOString() }));

describe("pendingLessons", () => {
  test("needs-me and status carry the whole queue, and a big or old one prints one line", () => {
    const w = world();
    initJob(w);
    const env = { LEADER_LEARN: "on", LEADER_CORE_SCRIPT: fakeCore(rows(30, 5)) };

    const board = cli(w, ["needs-me"], env);
    assert.equal(board.code, 0, board.stderr);
    assert.equal(board.last.pendingLessons.count, 30);
    assert.equal(board.last.pendingLessons.oldestDays, 5);
    assert.match(board.last.pendingLessons.message, /30 PENDING candidates/);
    assert.match(board.last.pendingLessons.message, /oldest 5 days/);

    const text = cli(w, ["needs-me", "--text"], env);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Lessons: 30 PENDING candidates in AntiFan Core, oldest 5 days/);

    const status = cli(w, ["status"], env);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.last.pendingLessons.count, 30);
    assert.equal(status.last.pendingLessons.oldestDays, 5);
    assert.match(status.stderr, /Lessons: 30 PENDING candidates/);
  });

  test("a small, fresh queue stays quiet", () => {
    const w = world();
    const env = { LEADER_LEARN: "on", LEADER_CORE_SCRIPT: fakeCore(rows(2, 0)) };
    const board = cli(w, ["needs-me"], env);
    assert.equal(board.last.pendingLessons.count, 2);
    assert.equal(board.last.pendingLessons.oldestDays, 0);
    assert.equal(board.last.pendingLessons.message, undefined);
    const text = cli(w, ["needs-me", "--text"], env);
    assert.doesNotMatch(text.stdout, /Lessons:/);
    const status = cli(w, ["status"], env);
    assert.doesNotMatch(status.stderr, /Lessons:/);
  });

  test("an unreadable Core reports a null count, never a zero, and never fails the command", () => {
    const w = world();
    const dead = path.join(TEMP, `core-dead-${++n}.cjs`);
    fs.writeFileSync(dead, "console.error('boom');\nprocess.exit(1);\n");
    const board = cli(w, ["needs-me"], { LEADER_LEARN: "on", LEADER_CORE_SCRIPT: dead });
    assert.equal(board.code, 0, board.stderr);
    assert.equal(board.last.pendingLessons.count, null);
    assert.equal(board.last.pendingLessons.oldestDays, null);
    assert.ok(board.last.pendingLessons.error);
    assert.equal(board.last.pendingLessons.message, undefined);
    // LEADER_LEARN=off (the default of these tests) keeps Core unspawned: the same null reading, error "disabled".
    const off = cli(w, ["needs-me"]);
    assert.equal(off.last.pendingLessons.count, null);
    assert.equal(off.last.pendingLessons.error, "disabled");
  });
});
