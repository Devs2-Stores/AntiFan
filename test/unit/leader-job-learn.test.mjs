// Learning wiring: close stores a lesson (fail-open), `lessons` lists PENDING candidates.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { REPO, TEMP, cleanup, cli, initJob, world } from "./leader-job-cli-helpers.mjs";

after(cleanup);

describe("close -> lesson", () => {
  test("LEADER_LEARN=off never spawns Core: no db is created and the close still succeeds", () => {
    const db = path.join(TEMP, "off", "core.db");
    const w = world({ LEADER_LEARN: "off", SUPER_CORE_DB: db });
    const j = initJob(w);
    const c = cli(w, ["close", "--job", j.dir, "--force"]);
    assert.equal(c.code, 0, c.stderr);
    assert.equal(c.last.state, "closed");
    assert.equal(c.last.lesson.ok, false);
    assert.equal(c.last.lesson.error, "disabled");
    assert.equal(j.job().lesson.error, "disabled");
    assert.equal(fs.existsSync(db), false);
    assert.equal(fs.existsSync(path.dirname(db)), false);
    const l = cli(w, ["lessons"]);
    assert.equal(l.last.ok, false);
    assert.equal(l.last.error, "disabled");
  });

  const core = process.env.LEADER_CORE_SCRIPT || path.join(REPO, "scripts", "antifan-core.cjs");
  const built = fs.existsSync(path.join(path.dirname(core), "..", "packages", "super-core", "dist", "index.js"));
  test("with a temp SUPER_CORE_DB, close writes exactly one PENDING candidate and `lessons` lists it", { skip: built ? false : "super-core is not built (packages/super-core/dist)" }, () => {
    const dir = path.join(TEMP, "on");
    fs.mkdirSync(dir, { recursive: true });
    const w = world({ LEADER_LEARN: "on", SUPER_CORE_DB: path.join(dir, "core.db") });
    const j = initJob(w, "learnme");
    const c = cli(w, ["close", "--job", j.dir, "--force"]);
    assert.equal(c.code, 0, c.stderr);
    assert.equal(c.last.lesson.ok, true, JSON.stringify(c.last.lesson));
    assert.ok(c.last.lesson.caseId && c.last.lesson.candidateId);
    const stored = j.job().lesson;
    assert.equal(stored.ok, true);
    assert.equal(stored.candidateId, c.last.lesson.candidateId);
    assert.equal(j.job().state, "closed");

    const l = cli(w, ["lessons"]);
    assert.equal(l.code, 0, l.stderr);
    assert.equal(l.last.ok, true);
    assert.equal(l.last.candidates.length, 1);
    assert.equal(l.last.candidates[0].status, "PENDING");
    assert.ok(JSON.stringify(l.last.candidates[0]).includes("learnme"));
  });

  test("a Core that cannot run never blocks the close", () => {
    const blocker = path.join(TEMP, "blocker");
    fs.writeFileSync(blocker, "a file, so the db path below can never be created");
    const w = world({ LEADER_LEARN: "on", SUPER_CORE_DB: path.join(blocker, "core.db") });
    const j = initJob(w, "failopen");
    const c = cli(w, ["close", "--job", j.dir, "--force"]);
    assert.equal(c.code, 0, c.stderr);
    assert.equal(c.last.ok, true);
    assert.equal(c.last.lesson.ok, false);
    assert.ok(c.last.lesson.error);
    assert.equal(j.job().state, "closed");
  });
});
