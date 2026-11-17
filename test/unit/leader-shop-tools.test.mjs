// scripts/leader/hrv-whoiam-find.mjs, shop-org-resolve.mjs, shop-folder-index.mjs: read-only lookups with fake inputs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { find, parseWhoiam } from "../../scripts/leader/hrv-whoiam-find.mjs";
import { main as resolveMain, parseStorefront } from "../../scripts/leader/shop-org-resolve.mjs";

const LEADER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "leader");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "leader-shop-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const row = (id, user, org) => `${id.padEnd(14)}${user.padEnd(43)}${org.padEnd(43)}`;
const WHOIAM = [
  "(node:1) Warning: something noisy",
  "",
  row("orgId", "user", "orgName"),
  row("─────────────", "──────────────────────────────────────────", "──────────────────────────────────────────"),
  row("1000000001", "Fake User", "ALPHA SHOP"),
  row("1000000002", "Nguyễn  Văn Đạt Fake", "Cửa hàng Bê Ta  Việt Nam"),
  row("1000000003", "Third", "Beta Store Hanoi"),
  row("1000000004", "Fourth Person", "Cửa hàng Bê Ta Huế"),
].join("\n");

describe("hrv-whoiam-find", () => {
  const orgs = parseWhoiam(WHOIAM);
  test("parses the table and ignores warnings and borders", () => {
    assert.equal(orgs.length, 4);
    assert.deepEqual(orgs[0], { orgId: "1000000001", name: "ALPHA SHOP" });
    assert.deepEqual(orgs[1], { orgId: "1000000002", name: "Cửa hàng Bê Ta  Việt Nam" });
  });
  test("finds by id, by unique name (orgName column only), reports ambiguity and absence", () => {
    assert.deepEqual(find(orgs, "1000000002"), { found: true, orgId: "1000000002", name: "Cửa hàng Bê Ta  Việt Nam" });
    assert.deepEqual(find(orgs, "alpha"), { found: true, orgId: "1000000001", name: "ALPHA SHOP" });
    assert.equal(find(orgs, "Fake User").found, false, "a user name is not matched");
    assert.equal(find(orgs, "Huế").orgId, "1000000004");
    const amb = find(orgs, "cửa hàng");
    assert.equal(amb.found, false);
    assert.equal(amb.matches.length, 2);
    assert.deepEqual(find(orgs, "9999999999"), { found: false, orgId: "9999999999" });
  });
  test("the CLI runs the listing as a child process and prints one line; a missing binary is {error}", () => {
    const fake = path.join(TEMP, "fake-hrv.cmd");
    const body = `process.stdout.write(${JSON.stringify(WHOIAM)})`;
    const js = path.join(TEMP, "fake-hrv.js");
    fs.writeFileSync(js, body);
    fs.writeFileSync(fake, process.platform === "win32" ? `@echo off\r\nnode "${js}" %*\r\n` : `#!/bin/sh\nnode "${js}" "$@"\n`, { mode: 0o755 });
    const run = (bin, q) => spawnSync(process.execPath, [path.join(LEADER, "hrv-whoiam-find.mjs"), q], { encoding: "utf8", env: { ...process.env, HRV_BIN: bin } });
    const ok = run(fake, "1000000003");
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout.trim()), { found: true, orgId: "1000000003", name: "Beta Store Hanoi" });
    const bad = run(path.join(TEMP, "absent-binary"), "1");
    assert.equal(bad.status, 1);
    assert.match(JSON.parse(bad.stdout.trim()).error, /cannot run|whoiam exited/);
  });
});

describe("shop-org-resolve", () => {
  const HTML = `<script>Haravan.shop = 'demo.myharavan.com'; Haravan.theme = {"name":"T 1","id":1000123456,"role":"main"};</script>`;
  const headers = new Map([["x-shopid", "1000200300"]]);
  test("reads shop id, live theme and role from a storefront response", () => {
    assert.deepEqual(parseStorefront(HTML, headers, "https://www.demo.com/"), {
      domainFinal: "www.demo.com",
      shopId: "1000200300",
      liveThemeId: "1000123456",
      liveThemeRole: "main",
      myharavanDomain: "demo.myharavan.com",
    });
  });
  test("main follows the final url and takes the org id only from what it is given", async () => {
    const lines = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => (lines.push(String(s)), true);
    try {
      const fetchImpl = async () => ({ ok: true, status: 200, url: "https://www.demo.com/", headers, text: async () => HTML });
      assert.equal(await resolveMain(["demo.myharavan.com", "--admin-url", "https://accounts.haravan.com/login?orgid=200001&state=x"], fetchImpl), 0);
      assert.equal(await resolveMain(["demo.myharavan.com"], fetchImpl), 0);
      assert.equal(await resolveMain(["not a domain"], fetchImpl), 2);
    } finally {
      process.stdout.write = write;
    }
    assert.equal(JSON.parse(lines[0]).orgIdFromAdminRedirect, "200001");
    assert.ok(!("orgIdFromAdminRedirect" in JSON.parse(lines[1])));
    assert.match(JSON.parse(lines[2]).error, /usage/);
  });
});

describe("shop-folder-index", () => {
  test("lists first-level folders, bindings and optimize folders for a shop, never scratch by default", () => {
    const root = path.join(TEMP, "Work");
    for (const d of ["customizes/Atoha Theme", "customizes/Other", "themes/atoha-main", "tools/Pagespeed/optimize2026-11_atoha", "scratch/leader/job-atoha"]) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, "customizes/Atoha Theme/.haravan-cli_local.json"), JSON.stringify({ org_id: "1000000001", theme_id: "1000999999", shop_domain: "atoha.myharavan.com" }));
    const run = (extra = []) => {
      const r = spawnSync(process.execPath, [path.join(LEADER, "shop-folder-index.mjs"), "atoha", ...extra], { encoding: "utf8", env: { ...process.env, WORK_ROOT: root } });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.trim().split("\n").at(-1));
    };
    const out = run();
    assert.deepEqual(out.customizes.map((c) => c.folder), ["Atoha Theme"]);
    assert.deepEqual(out.customizes[0].binding, { org_id: "1000000001", theme_id: "1000999999", shop_domain: "atoha.myharavan.com" });
    assert.deepEqual(out.themes.map((c) => c.folder), ["atoha-main"]);
    assert.deepEqual(out.pagespeed.map((c) => c.folder), ["optimize2026-11_atoha"]);
    assert.equal(out.scratch, undefined);
    assert.deepEqual(run(["--scratch"]).scratch.map((c) => c.folder), ["job-atoha"]);
  });
});
