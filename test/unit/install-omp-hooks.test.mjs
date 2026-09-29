// install-omp-hooks.test.mjs - behavior of the user-scope hook installer
//
// The installer is exercised with PI_CODING_AGENT_DIR pointed at a temp agent dir,
// so no test run ever touches the live ~/.omp/agent/hooks directory.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "install-omp-hooks.mjs");

function makeAgentDir({ legacyGate = null } = {}) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-"));
  fs.mkdirSync(path.join(agentDir, "hooks", "post"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "hooks", "pre"), { recursive: true });
  if (legacyGate !== null) {
    fs.writeFileSync(path.join(agentDir, "hooks", "post", "theme-qa-gate.ts"), legacyGate, "utf8");
  }
  return agentDir;
}

function run(agentDir, flag) {
  const result = spawnSync(process.execPath, [SCRIPT, flag], {
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

const hookPath = (agentDir, phase, name) => path.join(agentDir, "hooks", phase, name);

test("install bundles each hook, supersedes the legacy .ts, and records a manifest", () => {
  const agentDir = makeAgentDir({ legacyGate: "// legacy gate\n" });
  const installed = run(agentDir, "--install");
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(installed.stdout.includes("edit-guard"));
  assert.ok(installed.stdout.includes("run-state"));
  assert.ok(installed.stdout.includes("theme-qa-gate"));

  const guard = hookPath(agentDir, "pre", "antifan-edit-guard.js");
  const runState = hookPath(agentDir, "pre", "antifan-run-state.js");
  const gate = hookPath(agentDir, "post", "antifan-theme-qa-gate.js");
  assert.ok(fs.existsSync(guard), "antifan-edit-guard.js installed");
  assert.ok(fs.existsSync(runState), "antifan-run-state.js installed");
  assert.ok(fs.existsSync(gate), "antifan-theme-qa-gate.js installed");

  const guardSource = fs.readFileSync(guard, "utf8");
  assert.ok(guardSource.startsWith("/* AntiFan hook"), "generated banner present");
  assert.ok(guardSource.includes("editGuardHook"), "bundled hook body present");
  assert.ok(!guardSource.includes('from "./edit-mode"'), "siblings are bundled, not imported");

  // The installed file must be an ESM factory. omp's extension runner imports it and takes
  // `typeof mod === "function" ? mod : mod.default`; a bundled CJS module does not survive that
  // path - installed live it fails with "Extension does not export a valid factory function"
  // even though the same bytes hand-imported in Bun expose a function `default`.
  assert.ok(/export\s*\{[^}]*as default/.test(guardSource), "factory is an ESM default export");
  assert.ok(!guardSource.includes("module.exports"), "no CJS export shape in the installed hook");
  assert.ok(!/^\s*(?:const|var)\s+\w+\s*=\s*require\(/m.test(guardSource), "no require() in the bundle");


  const runStateSource = fs.readFileSync(runState, "utf8");
  assert.ok(runStateSource.startsWith("/* AntiFan hook"), "generated banner present");
  assert.ok(runStateSource.includes("runStateHook"), "bundled hook body present");
  assert.ok(/export\s*\{[^}]*as default/.test(runStateSource), "factory is an ESM default export");
  assert.ok(!runStateSource.includes("module.exports"), "no CJS export shape in the installed hook");
  assert.ok(!/^\s*(?:const|var)\s+\w+\s*=\s*require\(/m.test(runStateSource), "no require() in the bundle");
  // The legacy user-scope .ts is parked, not deleted: discovery must not load both.
  assert.equal(fs.existsSync(hookPath(agentDir, "post", "theme-qa-gate.ts")), false);
  assert.ok(fs.existsSync(hookPath(agentDir, "post", "theme-qa-gate.ts.bak")));
  assert.equal(fs.readFileSync(hookPath(agentDir, "post", "theme-qa-gate.ts.bak"), "utf8"), "// legacy gate\n");

  // run-state is now part of the required installed set.
  assert.equal(installed.stdout.includes("SKIPPED_ABSENT"), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(agentDir, "hooks", ".antifan-hooks.json"), "utf8"));
  assert.equal(manifest.schema, 1);
  assert.deepEqual(
    manifest.hooks.map((entry) => entry.id).sort(),
    ["edit-guard", "run-state", "theme-qa-gate"],
  );
  for (const entry of manifest.hooks) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(entry.path));
  }
});

test("check reports IN_SYNC after install, STALE after a hand edit, MISSING when absent", () => {
  const agentDir = makeAgentDir();
  const fresh = run(agentDir, "--check");
  assert.equal(fresh.status, 1, "nothing installed yet is drift");
  assert.ok(fresh.stdout.includes("MISSING"));

  assert.equal(run(agentDir, "--install").status, 0);
  const inSync = run(agentDir, "--check");
  assert.equal(inSync.status, 0, inSync.stdout);
  assert.equal(inSync.stdout.includes("STALE"), false);
  assert.ok(inSync.stdout.includes("IN_SYNC"));

  const guard = hookPath(agentDir, "pre", "antifan-edit-guard.js");
  fs.appendFileSync(guard, "// hand edit\n");
  const stale = run(agentDir, "--check");
  assert.equal(stale.status, 1);
  assert.ok(stale.stdout.includes("STALE"));

  assert.equal(run(agentDir, "--install").status, 0);
  assert.equal(run(agentDir, "--check").status, 0);
});

test("install writes through a temp file and fails loudly instead of half-installing", () => {
  const agentDir = makeAgentDir();
  assert.equal(run(agentDir, "--install").status, 0);
  const debris = (phase) =>
    fs.readdirSync(path.join(agentDir, "hooks", phase)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(debris("pre"), [], "temp file renamed, not left behind");
  assert.deepEqual(debris("post"), [], "temp file renamed, not left behind");

  // `hooks` exists as a file here, so the hooks dir cannot be created: the installer must report a
  // failure and leave no manifest rather than record a partial set.
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-blocked-"));
  fs.writeFileSync(path.join(blocked, "hooks"), "not a directory\n", "utf8");
  const failed = run(blocked, "--install");
  assert.notEqual(failed.status, 0, "a blocked target is not a success");
  assert.ok(failed.stderr.includes("[install-omp-hooks]"), failed.stderr);
  assert.equal(fs.existsSync(path.join(blocked, "hooks", ".antifan-hooks.json")), false);
});

test("rollback restores the previous files and the legacy .ts", () => {
  const agentDir = makeAgentDir({ legacyGate: "// legacy gate\n" });
  assert.equal(run(agentDir, "--install").status, 0);
  const guard = hookPath(agentDir, "pre", "antifan-edit-guard.js");
  const runState = hookPath(agentDir, "pre", "antifan-run-state.js");
  const gate = hookPath(agentDir, "post", "antifan-theme-qa-gate.js");

  // A previous version of each hook must come back byte-identical.
  fs.writeFileSync(`${guard}.bak`, "// previous guard\n", "utf8");
  fs.writeFileSync(`${runState}.bak`, "// previous run-state\n", "utf8");
  fs.writeFileSync(`${gate}.bak`, "// previous gate\n", "utf8");

  const rolled = run(agentDir, "--rollback");
  assert.equal(rolled.status, 0, rolled.stderr);
  assert.equal(fs.readFileSync(guard, "utf8"), "// previous guard\n");
  assert.equal(fs.readFileSync(runState, "utf8"), "// previous run-state\n");
  assert.equal(fs.readFileSync(gate, "utf8"), "// previous gate\n");
  assert.equal(fs.readFileSync(hookPath(agentDir, "post", "theme-qa-gate.ts"), "utf8"), "// legacy gate\n");

  // With no backup at all the installer parks the file instead of deleting it.
  const bare = makeAgentDir();
  assert.equal(run(bare, "--install").status, 0);
  const parked = run(bare, "--rollback");
  assert.equal(parked.status, 0);
  assert.ok(parked.stdout.includes("DISCARDED"));
  assert.ok(fs.existsSync(hookPath(bare, "pre", "antifan-edit-guard.js.discarded")));
  assert.ok(fs.existsSync(hookPath(bare, "pre", "antifan-run-state.js.discarded")));
});
