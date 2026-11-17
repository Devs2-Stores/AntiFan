import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { resolveWrangler, SAFE_ARG, summarizeTail, tailArgs } from "../../scripts/leader/cf-tail-count.mjs";
import { SAFE_BIN } from "../../scripts/leader/hrv-whoiam-find.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cf-tail-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ev = (over) => JSON.stringify({ outcome: "ok", eventTimestamp: 1_700_000_000_000, logs: [], exceptions: [], event: { request: { url: "https://w.example/api/x?orgid=111", method: "GET" }, response: { status: 200 } }, ...over });

const LINES = [
  ev({}),
  ev({}),
  ev({ event: { request: { url: "https://w.example/api/y?orgid=222", method: "POST" }, response: { status: 500 } }, outcome: "exception", exceptions: [{ name: "TypeError", message: "boom" }], eventEndTimestamp: 1 }),
  ev({ event: { request: { url: "https://w.example/hook", method: "POST" }, response: { status: 200 } }, logs: [{ level: "error", message: ["sync failed", { orgid: "333" }] }], eventTimestamp: 1_700_000_060_000 }),
  "not json",
  "",
];

describe("summarizeTail", () => {
  test("counts outcomes, statuses, routes, orgs, exceptions and error logs", () => {
    const s = summarizeTail(LINES);
    assert.equal(s.events, 4);
    assert.equal(s.skipped, 1);
    assert.equal(s.exceptions, 1);
    assert.deepEqual(s.outcome, { ok: 3, exception: 1 });
    assert.deepEqual(s.status, { 200: 3, 500: 1 });
    assert.deepEqual(s.topRoutes[0], { key: "GET /api/x", count: 2 });
    assert.deepEqual(s.topOrgs.map((o) => o.key).sort(), ["111", "222", "333"]);
    assert.equal(s.topOrgs.find((o) => o.key === "111").count, 2);
    assert.ok(s.topErrors.some((e) => e.key.startsWith("exception: TypeError: boom")));
    assert.ok(s.topErrors.some((e) => e.key.startsWith("log: sync failed")));
    assert.deepEqual(s.window, { from: new Date(1_700_000_000_000).toISOString(), to: new Date(1_700_000_060_000).toISOString() });
  });

  test("--org filters every counter but still lists all orgs seen", () => {
    const s = summarizeTail(LINES, { org: "222" });
    assert.equal(s.matched, 1);
    assert.deepEqual(s.status, { 500: 1 });
    assert.equal(s.topOrgs.length, 3);
  });

  test("the CLI reads a file and prints one JSON line; bad arguments exit 2", () => {
    const file = path.join(TMP, "tail.jsonl");
    fs.writeFileSync(file, LINES.join("\n"));
    const script = path.resolve("scripts/leader/cf-tail-count.mjs");
    const ok = spawnSync(process.execPath, [script, "--file", file, "--org", "111"], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).matched, 2);
    const bad = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(bad.status, 2);
  });
});

const INJECTIONS = ["x & calc", "x && calc", "x | more", "x; id", 'x"y', "x\ny", "$(id)", "`id`", "--format", "-x", "a b", "%PATH%", "x>out", ""];

describe("no shell reaches the child processes", () => {
  const script = path.resolve("scripts/leader/cf-tail-count.mjs");
  test("SAFE_ARG accepts worker names and refuses every injection string", () => {
    for (const ok of ["f1genz-multilanguage", "worker_1.v2", "123"]) assert.ok(SAFE_ARG.test(ok), ok);
    for (const bad of INJECTIONS) assert.ok(!SAFE_ARG.test(bad), JSON.stringify(bad));
  });
  test("--worker and --org injections exit 2 before anything is spawned", () => {
    for (const bad of INJECTIONS.filter((b) => b)) {
      for (const flag of ["--worker", "--org"]) {
        const r = spawnSync(process.execPath, [script, flag, bad, ...(flag === "--org" ? ["--stdin"] : [])], { encoding: "utf8", input: "" });
        assert.equal(r.status, 2, `${flag} ${JSON.stringify(bad)} ${r.stderr}`);
        assert.match(r.stderr, /must match/);
        assert.equal(r.stdout, "");
      }
    }
  });
  test("tailArgs refuses an unsafe name and returns an argv array, never a command line string", () => {
    assert.deepEqual(tailArgs("my-worker", "W.js"), ["W.js", "tail", "my-worker", "--format", "json"]);
    for (const bad of INJECTIONS) assert.throws(() => tailArgs(bad, "W.js"), /must match/);
  });
  test("resolveWrangler reports a missing install instead of falling back to PATH or a shell", () => {
    assert.throws(() => resolveWrangler(TMP), /wrangler is not installed/);
  });
  test("hrv-whoiam-find only lets a plain path reach cmd.exe (SAFE_BIN)", () => {
    for (const ok of ["hrv", "C:\\Program Files\\hrv\\hrv.cmd", "C:/tools/hrv.cmd"]) assert.ok(SAFE_BIN.test(ok), ok);
    for (const bad of ['x"&calc&"y.cmd', "x|y.cmd", "x^y.cmd", "%COMSPEC%.cmd", "x\ny.cmd", "x>y.cmd", "`id`.cmd"]) assert.ok(!SAFE_BIN.test(bad), JSON.stringify(bad));
  });
  test("hrv-whoiam-find refuses an injected HRV_BIN before spawning (win32)", { skip: process.platform !== "win32" }, () => {
    const r = spawnSync(process.execPath, [path.resolve("scripts/leader/hrv-whoiam-find.mjs"), "123456"], { encoding: "utf8", env: { ...process.env, HRV_BIN: 'x" & echo pwned & "y.cmd' } });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /plain path/);
  });
});
