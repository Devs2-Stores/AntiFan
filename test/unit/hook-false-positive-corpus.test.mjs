/**
 * Replay corpus of the refusals the 2026-11-12..17 OMP chat audit measured (P0-1, P0-2), plus the
 * four theme-push-policy false positives the 2026-11-15..23 audit found after the 17/11 fix: every
 * `fp` entry was refused although it runs no theme command and writes no theme file, and must now
 * pass; every `tp` entry carries a real theme-CLI use, a theme write or a budgeted investigation and
 * must stay refused, including the inline-program spawner forms next to the new `fp` rows. The
 * entries are in test/fixtures/theme-policy/audit-261117-corpus.json.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(REPO, "src", "omp-hooks");
const CORPUS = JSON.parse(fs.readFileSync(path.join(REPO, "test", "fixtures", "theme-policy", "audit-261117-corpus.json"), "utf8"));

// The hooks import their siblings by extensionless specifier: run them from a temp copy as .mts.
const UNIT = ["edit-mode", "theme-paths", "edit-guard-policy", "theme-push-policy", "leader-guard"];
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "hook-corpus-"));
const SPECIFIER_RE = new RegExp(`from "\\./(${UNIT.join("|")})"`, "g");
for (const name of UNIT) {
  fs.writeFileSync(path.join(TEMP, `${name}.mts`), fs.readFileSync(path.join(SRC, `${name}.ts`), "utf8").replace(SPECIFIER_RE, 'from "./$1.mts"'));
}
const policy = await import(pathToFileURL(path.join(TEMP, "theme-push-policy.mts")).href);
const guard = await import(pathToFileURL(path.join(TEMP, "leader-guard.mts")).href);

let themeRoot;
let plainDir;
let jobsRoot;

before(() => {
  themeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hook-corpus-theme-"));
  for (const dir of ["layout", "templates", "sections", "snippets", "assets", "config"]) fs.mkdirSync(path.join(themeRoot, dir), { recursive: true });
  fs.writeFileSync(path.join(themeRoot, "sections", "hero.liquid"), "<div></div>\n");
  fs.writeFileSync(path.join(themeRoot, "snippets", "optimize_head.liquid"), "x\n");
  plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-corpus-plain-"));
  jobsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hook-corpus-jobs-"));
});

after(() => {
  for (const dir of [TEMP, themeRoot, plainDir, jobsRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

const slash = (value) => value.replace(/\\/g, "/");
const fill = (text) => text.replaceAll("{THEME}", slash(themeRoot)).replaceAll("{PLAIN}", slash(plainDir));

function themeLineVerdict(text) {
  const plan = policy.classifyThemeLine(text);
  if (plan.decision === "block") return `block:${plan.code}`;
  if (plan.decision === "commands") return `commands:${plan.commands.map((cmd) => cmd.action).join(",")}`;
  return "none";
}

function leaderVerdict(entry) {
  const env = { LEADER_JOBS_ROOT: jobsRoot };
  const text = fill(entry.text);
  const refusal = guard.planLeaderToolCall(
    { toolName: entry.kind === "leader-eval" ? "eval" : "bash", input: entry.kind === "leader-eval" ? { code: text } : { command: text }, cwd: plainDir },
    env,
  );
  return refusal === null ? "allow" : refusal.code;
}

function investigateVerdict(entry) {
  const label = guard.investigationLabel({ toolName: entry.tool, input: entry.input, cwd: plainDir }, { LEADER_JOBS_ROOT: jobsRoot });
  return label === null ? "free" : "counted";
}

test("the corpus carries both classes and every kind, with unique ids", () => {
  const ids = CORPUS.entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const cls of ["fp", "tp"]) assert.ok(CORPUS.entries.some((entry) => entry.class === cls), cls);
  for (const kind of ["theme-line", "theme-eval", "leader-bash", "leader-eval", "leader-investigate"]) {
    assert.ok(CORPUS.entries.some((entry) => entry.kind === kind), kind);
  }
});

for (const entry of CORPUS.entries) {
  test(`${entry.class === "fp" ? "passes" : "stays refused"}: ${entry.id} (${entry.audit})`, () => {
    if (entry.kind === "theme-line") {
      const verdict = themeLineVerdict(entry.text);
      if (entry.expect === "not-none") assert.notEqual(verdict, "none");
      else assert.equal(verdict, entry.expect);
    } else if (entry.kind === "theme-eval") {
      assert.equal(policy.planEvalThemeCode(entry.text).decision, entry.expect);
    } else if (entry.kind === "leader-bash" || entry.kind === "leader-eval") {
      assert.equal(leaderVerdict(entry), entry.expect);
    } else {
      assert.equal(investigateVerdict(entry), entry.expect);
    }
  });
}

test("a refusal says what to do instead", () => {
  const complex = policy.classifyThemeLine("(hrv theme push --only a.liquid)");
  assert.equal(complex.decision, "block");
  assert.match(complex.reason, /Instead: run each theme command alone as one plain bash command/);
  const edit = guard.planLeaderToolCall({ toolName: "bash", input: { command: fill("echo x > {THEME}/sections/hero.liquid") }, cwd: plainDir }, { LEADER_JOBS_ROOT: jobsRoot });
  assert.match(edit.reason, /Instead: have a worker make the change/);
  const cli = guard.planLeaderToolCall({ toolName: "bash", input: { command: "hrv theme push --only a.liquid" }, cwd: plainDir }, { LEADER_JOBS_ROOT: jobsRoot });
  assert.match(cli.reason, /Instead: have a worker run it/);
});

test("an inline program is data only while no statement of it can start a process", () => {
  const report = `node -e "\nconst fs=require('fs');const r={pushed:[]};r.pushed.push('theme 1001: hrv theme push --only a.liquid');fs.writeFileSync('r.md',JSON.stringify(r));\n"`;
  assert.equal(policy.classifyThemeLine(report).decision, "none");
  // Every way the program text reaches a process keeps the quoted CLI visible and the line refused.
  for (const text of [
    `node -e "require('child_process').execSync('hrv theme push')"`,
    `node -e "const {execFileSync}=require('child_process');execFileSync('hrv',['theme','push'])"`,
    `node -e "const m='child_'+'process';require(m).execSync('hrv theme push')"`,
    `node -e "eval('hrv theme push')"`,
    `node -e "require('fs').writeFileSync('probe.mjs','hrv theme push')"`,
    `bun -e "require('child_process').execSync('hrv theme push')"`,
  ]) {
    assert.equal(policy.classifyThemeLine(text).code, "REFUSED_THEME_COMPLEX", text);
  }
});

test("an eval cell hands the CLI over only from a statement that starts a process", () => {
  const store = [
    "import subprocess",
    "r = {'pushed': [], 'evidence': []}",
    'r["pushed"].append("theme 1001: hrv theme push --only a.liquid")',
    'r["evidence"].insert(0, "hrv theme fetch --only a.scss")',
    'r["notChecked"] = ["hrv theme dev not used (live theme)"]',
    "print(r)",
  ].join("\n");
  assert.equal(policy.planEvalThemeCode(store).decision, "allow");
  // The same text handed to a process - or a record field handed on - is refused.
  assert.equal(policy.planEvalThemeCode(`${store}\nsubprocess.run(['hrv', 'theme', 'push'])`).decision, "block");
  assert.equal(policy.planEvalThemeCode("import os\nos.system('hrv theme publish 1')").decision, "block");
});
