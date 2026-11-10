// hrv-token-probe.mjs: one JSON line that says why the bound theme cannot be read, and never a token.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "leader", "hrv-token-probe.mjs");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "hrv-probe-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const OPAQUE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijklmnopqrstuvwxyz0123456789";
const HELPER = path.join(TEMP, "helper.mjs");
fs.writeFileSync(
  HELPER,
  `export default { async get(route) { if (process.env.STUB_OK) return { theme: { role: "main" }, route }; throw new Error("Token hết hạn và không refresh được. ${OPAQUE}"); } };\n`,
);

function project(binding) {
  const dir = fs.mkdtempSync(path.join(TEMP, "p-"));
  if (binding) fs.writeFileSync(path.join(dir, ".haravan-cli_local.json"), JSON.stringify(binding));
  return dir;
}

function probe(cwd, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8", env: { ...process.env, HRV_CLI_HELPER: HELPER, ...env } });
  return { code: r.status, out: JSON.parse(r.stdout.trim().split("\n").at(-1)), raw: r.stdout };
}

const BOUND = { org_id: "200000000001", theme_id: "1000000001" };

describe("hrv-token-probe", () => {
  test("a refused token exits 1 with the helper's message and masks an opaque string", () => {
    const r = probe(project(BOUND));
    assert.equal(r.code, 1);
    assert.equal(r.out.ok, false);
    assert.equal(r.out.themeId, "1000000001");
    assert.equal(r.out.orgId, "200000000001");
    assert.match(r.out.error, /Token hết hạn và không refresh được/);
    assert.ok(!r.raw.includes(OPAQUE), "the opaque string never reaches stdout");
  });

  test("a readable theme exits 0 with its role and nothing else of the response", () => {
    const r = probe(project(BOUND), { STUB_OK: "1" });
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, { ok: true, themeId: "1000000001", orgId: "200000000001", role: "main" });
  });

  test("no binding, a binding without a numeric theme id and a missing helper exit 2", () => {
    assert.equal(probe(project(null)).code, 2);
    assert.equal(probe(project({ org_id: "1", theme_id: "abc" })).code, 2);
    const noHelper = probe(project(BOUND), { HRV_CLI_HELPER: path.join(TEMP, "absent.mjs") });
    assert.equal(noHelper.code, 2);
    assert.match(noHelper.out.error, /cannot load the Haravan CLI helper/);
  });
});
