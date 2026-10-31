// install-managed-skills.test.mjs - behavioral tests for scripts/install-managed-skills.mjs
//
// Every case runs the real CLI against throwaway --source-root / --target-root directories;
// the real ~/.omp directory is never touched.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO, "scripts", "install-managed-skills.mjs");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "install-managed-skills-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const FRONTMATTER = (name) => `---\nname: ${name}\ndescription: "test skill ${name}"\n---\n\n`;

let counter = 0;
function sandbox() {
  counter += 1;
  const root = path.join(TEMP, `case-${counter}`);
  const sourceRoot = path.join(root, "repo-skills");
  const targetRoot = path.join(root, "managed-skills");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  return { sourceRoot, targetRoot };
}

function writeSkill(root, name, files) {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, name, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, "utf8");
  }
}

function cli(box, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("ANTIFAN_")) delete env[key];
  const result = spawnSync(
    process.execPath,
    [SCRIPT, ...args, "--source-root", box.sourceRoot, "--target-root", box.targetRoot],
    { encoding: "utf8", env },
  );
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const read = (box, name, rel) => fs.readFileSync(path.join(box.targetRoot, name, rel), "utf8");
const backupsOf = (box, name) => {
  const dir = path.join(box.targetRoot, ".antifan-skill-backups", name);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};

test("--check reports MISSING before install, --install copies every file, --check then reports MATCH", () => {
  const box = sandbox();
  writeSkill(box.sourceRoot, "demo", {
    "SKILL.md": `${FRONTMATTER("demo")}core\n`,
    "references/a.md": "reference a\n",
  });

  const before = cli(box, "--check");
  assert.equal(before.code, 1);
  assert.match(before.out, /MISSING\s+SKILL\.md/);
  assert.match(before.out, /MISSING\s+references\/a\.md/);

  const installed = cli(box, "--install");
  assert.equal(installed.code, 0, installed.err);
  assert.equal(read(box, "demo", "SKILL.md"), `${FRONTMATTER("demo")}core\n`);
  assert.equal(read(box, "demo", "references/a.md"), "reference a\n");
  assert.deepEqual(backupsOf(box, "demo"), [], "first install has nothing to back up");

  const after = cli(box, "--check");
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /MATCH\s+SKILL\.md/);
  assert.match(after.out, /MATCH\s+references\/a\.md/);
});

test("--check reports STALE for edited files and EXTRA for unknown installed files", () => {
  const box = sandbox();
  writeSkill(box.sourceRoot, "demo", { "SKILL.md": `${FRONTMATTER("demo")}v1\n` });
  assert.equal(cli(box, "--install").code, 0);
  fs.writeFileSync(path.join(box.targetRoot, "demo", "SKILL.md"), `${FRONTMATTER("demo")}edited by hand\n`);
  fs.writeFileSync(path.join(box.targetRoot, "demo", "stray.md"), "stray\n");

  const result = cli(box, "--check");
  assert.equal(result.code, 1);
  assert.match(result.out, /STALE\s+SKILL\.md/);
  assert.match(result.out, /EXTRA\s+stray\.md/);
});

test("a stub repo copy against a much larger installed skill is refused with exit 2 and nothing is written", () => {
  const box = sandbox();
  const big = `${FRONTMATTER("demo")}${"playbook line\n".repeat(1700)}`; // ~24 KB installed
  writeSkill(box.targetRoot, "demo", { "SKILL.md": big });
  writeSkill(box.sourceRoot, "demo", { "SKILL.md": `${FRONTMATTER("demo")}${"x".repeat(1900)}\n` }); // ~2 KB stub
  assert.ok(Buffer.byteLength(big) > 20000);

  const result = cli(box, "--install");
  assert.equal(result.code, 2);
  assert.match(result.err, /refused/);
  assert.match(result.err, /--force/);
  assert.equal(read(box, "demo", "SKILL.md"), big, "installed file must be unchanged");
  assert.deepEqual(backupsOf(box, "demo"), [], "a refused install writes no backup");
});

test("the size guard counts references: a small SKILL.md plus references that cover the old size is accepted", () => {
  const box = sandbox();
  writeSkill(box.targetRoot, "demo", { "SKILL.md": `${FRONTMATTER("demo")}${"y".repeat(20000)}\n` });
  writeSkill(box.sourceRoot, "demo", {
    "SKILL.md": `${FRONTMATTER("demo")}short core\n`,
    "references/one.md": "r".repeat(9000),
    "references/two.md": "s".repeat(6000),
  });

  const result = cli(box, "--install");
  assert.equal(result.code, 0, result.err);
  assert.equal(read(box, "demo", "SKILL.md"), `${FRONTMATTER("demo")}short core\n`);
  assert.equal(read(box, "demo", "references/one.md").length, 9000);
});

test("--force overrides the size guard and backs up the larger installed skill", () => {
  const box = sandbox();
  const big = `${FRONTMATTER("demo")}${"z".repeat(20000)}\n`;
  writeSkill(box.targetRoot, "demo", { "SKILL.md": big });
  const small = `${FRONTMATTER("demo")}tiny\n`;
  writeSkill(box.sourceRoot, "demo", { "SKILL.md": small });

  assert.equal(cli(box, "--install").code, 2);
  const forced = cli(box, "--install", "--force");
  assert.equal(forced.code, 0, forced.err);
  assert.equal(read(box, "demo", "SKILL.md"), small);
  const [backup] = backupsOf(box, "demo");
  assert.ok(backup, "a backup directory exists");
  assert.equal(fs.readFileSync(path.join(box.targetRoot, ".antifan-skill-backups", "demo", backup, "SKILL.md"), "utf8"), big);
});

test("the previous SKILL.md is backed up before it is replaced, and an unchanged re-install makes no new backup", () => {
  const box = sandbox();
  writeSkill(box.sourceRoot, "demo", { "SKILL.md": `${FRONTMATTER("demo")}version one\n` });
  assert.equal(cli(box, "--install").code, 0);

  writeSkill(box.sourceRoot, "demo", { "SKILL.md": `${FRONTMATTER("demo")}version two\n` });
  assert.equal(cli(box, "--install").code, 0);
  const backups = backupsOf(box, "demo");
  assert.equal(backups.length, 1);
  assert.equal(
    fs.readFileSync(path.join(box.targetRoot, ".antifan-skill-backups", "demo", backups[0], "SKILL.md"), "utf8"),
    `${FRONTMATTER("demo")}version one\n`,
  );
  assert.equal(read(box, "demo", "SKILL.md"), `${FRONTMATTER("demo")}version two\n`);

  const again = cli(box, "--install");
  assert.equal(again.code, 0);
  assert.match(again.out, /IN_SYNC/);
  assert.equal(backupsOf(box, "demo").length, 1);
});

test("--rollback restores the previous bytes, removes files the install added, and is repeatable", () => {
  const box = sandbox();
  writeSkill(box.sourceRoot, "demo", {
    "SKILL.md": `${FRONTMATTER("demo")}version one\n`,
    "references/old.md": "old reference\n",
  });
  assert.equal(cli(box, "--install").code, 0);

  fs.rmSync(path.join(box.sourceRoot, "demo", "references"), { recursive: true });
  writeSkill(box.sourceRoot, "demo", {
    "SKILL.md": `${FRONTMATTER("demo")}version two\n`,
    "references/new.md": "new reference\n",
  });
  assert.equal(cli(box, "--install").code, 0);
  assert.equal(read(box, "demo", "SKILL.md"), `${FRONTMATTER("demo")}version two\n`);
  assert.ok(!fs.existsSync(path.join(box.targetRoot, "demo", "references", "old.md")));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rolled = cli(box, "--rollback");
    assert.equal(rolled.code, 0, rolled.err);
    assert.equal(read(box, "demo", "SKILL.md"), `${FRONTMATTER("demo")}version one\n`);
    assert.equal(read(box, "demo", "references/old.md"), "old reference\n");
    assert.ok(!fs.existsSync(path.join(box.targetRoot, "demo", "references", "new.md")));
  }
});

test("--rollback with no backup exits 2 and leaves the installed skill alone", () => {
  const box = sandbox();
  writeSkill(box.sourceRoot, "demo", { "SKILL.md": `${FRONTMATTER("demo")}only version\n` });
  assert.equal(cli(box, "--install").code, 0);
  const result = cli(box, "--rollback");
  assert.equal(result.code, 2);
  assert.match(result.err, /NO_BACKUP/);
  assert.equal(read(box, "demo", "SKILL.md"), `${FRONTMATTER("demo")}only version\n`);
});

test("a SKILL.md whose frontmatter name differs from its directory is refused", () => {
  const box = sandbox();
  writeSkill(box.sourceRoot, "demo", { "SKILL.md": `${FRONTMATTER("other-name")}body\n` });
  const result = cli(box, "--install");
  assert.equal(result.code, 2);
  assert.match(result.err, /frontmatter name/);
  assert.ok(!fs.existsSync(path.join(box.targetRoot, "demo")));
});

test("--skill limits the run and unknown arguments or skills exit 2", () => {
  const box = sandbox();
  writeSkill(box.sourceRoot, "one", { "SKILL.md": `${FRONTMATTER("one")}1\n` });
  writeSkill(box.sourceRoot, "two", { "SKILL.md": `${FRONTMATTER("two")}2\n` });
  assert.equal(cli(box, "--install", "--skill", "one").code, 0);
  assert.ok(fs.existsSync(path.join(box.targetRoot, "one", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(box.targetRoot, "two")));
  assert.equal(cli(box, "--install", "--skill", "missing").code, 2);
  assert.equal(cli(box, "--bogus").code, 2);
});

test("the repo's antifan-leader skill is installable and passes its own check", () => {
  const box = { sourceRoot: path.join(REPO, "skills"), targetRoot: path.join(TEMP, "repo-install") };
  fs.mkdirSync(box.targetRoot, { recursive: true });
  const installed = cli(box, "--install", "--skill", "antifan-leader");
  assert.equal(installed.code, 0, installed.err);
  const checked = cli(box, "--check", "--skill", "antifan-leader");
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /MATCH\s+SKILL\.md/);
  assert.match(checked.out, /MATCH\s+references\/feedback-case\.md/);
  assert.match(checked.out, /MATCH\s+references\/leader-discipline\.md/);
});
