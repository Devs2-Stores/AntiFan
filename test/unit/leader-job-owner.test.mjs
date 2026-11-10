// dispatch reads the owner terminal.create recorded for a worker: a worker filed under no AntiFan project is refused.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { cleanup, dispatch, initJob, world } from "./leader-job-cli-helpers.mjs";

after(cleanup);

const writeRegistry = (w, workers) =>
  fs.writeFileSync(path.join(w.config, "leader-terminals.json"), JSON.stringify({ schema: 1, leaders: ["terminal-1"], workers }));
const record = (extra = {}) => ({ leaderId: "terminal-1", assignedAt: 1, ...extra });

describe("dispatch owner check", () => {
  test("a worker the registry records under no project is refused with the fix, and nothing is appended", () => {
    const w = world();
    const j = initJob(w);
    writeRegistry(w, { "terminal-7": record({ ownerKey: "unassigned" }) });
    const r = dispatch(w, j, "terminal-7", "work");
    assert.equal(r.code, 4);
    assert.match(r.stderr, /terminal-7/);
    assert.match(r.stderr, /no AntiFan project/);
    assert.match(r.stderr, /close-worker\.mjs terminal-7/);
    assert.match(r.stderr, /E:\/Work\/customizes/);
    assert.match(r.stderr, /--allow-no-owner/);
    assert.equal(j.job().rounds.length, 0, "a refused dispatch appends nothing");
  });

  test("a project owner passes with ownerCheck ok", () => {
    const w = world();
    const j = initJob(w);
    writeRegistry(w, { "terminal-7": record({ ownerKey: "project:p9" }) });
    const r = dispatch(w, j, "terminal-7", "work");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.last.ownerCheck, "ok");
  });

  test("a record without the field, a worker missing from the registry and a missing registry are unknown, not refused", () => {
    const w = world();
    const j = initJob(w);
    writeRegistry(w, { "terminal-7": record() });
    const noField = dispatch(w, j, "terminal-7", "work");
    assert.equal(noField.code, 0, noField.stderr);
    assert.equal(noField.last.ownerCheck, "unknown");

    const noRecord = dispatch(w, j, "terminal-8", "followup");
    assert.equal(noRecord.code, 0, noRecord.stderr);
    assert.equal(noRecord.last.ownerCheck, "unknown");

    fs.rmSync(path.join(w.config, "leader-terminals.json"));
    const noFile = dispatch(w, j, "terminal-9", "followup");
    assert.equal(noFile.code, 0, noFile.stderr);
    assert.equal(noFile.last.ownerCheck, "unknown");

    fs.writeFileSync(path.join(w.config, "leader-terminals.json"), "{not json");
    const broken = dispatch(w, j, "terminal-9", "followup");
    assert.equal(broken.code, 0, broken.stderr);
    assert.equal(broken.last.ownerCheck, "unknown");
  });

  test("--allow-no-owner lets a no-owner worker through and says so", () => {
    const w = world();
    const j = initJob(w);
    writeRegistry(w, { "terminal-7": record({ ownerKey: "unassigned" }) });
    const r = dispatch(w, j, "terminal-7", "work", "", ["--allow-no-owner"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.last.ownerCheck, "allowed");
    assert.equal(j.job().rounds.length, 1);
  });

  test("the flag does not change a worker that has a project", () => {
    const w = world();
    const j = initJob(w);
    writeRegistry(w, { "terminal-7": record({ ownerKey: "project:p9" }) });
    const r = dispatch(w, j, "terminal-7", "work", "", ["--allow-no-owner"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.last.ownerCheck, "ok");
  });
});
