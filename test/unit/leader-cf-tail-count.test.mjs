import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { summarizeTail } from "../../scripts/leader/cf-tail-count.mjs";

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
