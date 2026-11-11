import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRegistry } from "../../scripts/leader/fleet-watch.mjs";

describe("readRegistry (the Leader registry reader shared by fleet-watch, close-worker and leader-job)", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "leader-registry-read-"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (text) => fs.writeFileSync(path.join(dir, "leader-terminals.json"), text);

  it("returns the object, and null for a missing, malformed or non-object file", () => {
    assert.equal(readRegistry(dir), null, "missing file");
    write("{bad");
    assert.equal(readRegistry(dir), null, "malformed");
    write('"str"');
    assert.equal(readRegistry(dir), null, "string");
    write("null");
    assert.equal(readRegistry(dir), null, "null literal");
    write('{"leaders":{"terminal-7":{}}}');
    assert.deepEqual(readRegistry(dir), { leaders: { "terminal-7": {} } });
  });
});