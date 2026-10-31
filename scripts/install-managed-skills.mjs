#!/usr/bin/env node
/**
 * Install the repo-owned OMP managed skills (`skills/<name>/**`) into the user's
 * managed-skills directory.
 *
 * The managed-skills directory is live for every OMP session on this machine and is
 * not under git (a managed-skill tool once overwrote the Leader playbook with a 2 KB
 * stub). The repo copy is the source of truth; this script is the only writer:
 * it backs up what it replaces, refuses suspiciously small replacements, and can
 * prove what is installed (`--check`) or undo the last install (`--rollback`).
 *
 *   node scripts/install-managed-skills.mjs --check      # per-file MATCH / STALE / MISSING / EXTRA, no writes
 *   node scripts/install-managed-skills.mjs --install    # backup, then make the installed dir equal the repo dir
 *   node scripts/install-managed-skills.mjs --rollback   # restore the latest backup
 *
 * Options:
 *   --skill NAME        limit to one skill (default: every skills/<name>/ holding a SKILL.md)
 *   --target-root DIR   managed-skills directory (default: ~/.omp/agent/managed-skills)
 *   --source-root DIR   skills source directory (default: <repo>/skills)
 *   --force             `--install` only: skip the size guard
 *
 * Size guard: `--install` is refused (exit 2, nothing written for any skill) when the repo
 * skill (all files) totals less than 60% of the bytes currently installed for that skill.
 *
 * Exit codes: 0 ok / in sync, 1 `--check` found drift, 2 refused or failed.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZE_GUARD_RATIO = 0.6;
const BACKUP_DIR_NAME = ".antifan-skill-backups";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Relative posix paths of every file below `dir`, sorted. A missing dir yields []. */
function listFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

function totalBytes(dir) {
  return listFiles(dir).reduce((sum, rel) => sum + fs.statSync(path.join(dir, rel)).size, 0);
}

function parseArgs(argv) {
  const options = { mode: "check", skill: null, targetRoot: null, sourceRoot: null, force: false };
  const valueOf = (arg, name, index) => {
    if (arg === name) return [argv[index + 1], 1];
    if (arg.startsWith(`${name}=`)) return [arg.slice(name.length + 1), 0];
    return null;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--install") options.mode = "install";
    else if (arg === "--rollback") options.mode = "rollback";
    else if (arg === "--check") options.mode = "check";
    else if (arg === "--force") options.force = true;
    else {
      let matched = false;
      for (const [name, key] of [
        ["--skill", "skill"],
        ["--target-root", "targetRoot"],
        ["--source-root", "sourceRoot"],
      ]) {
        const hit = valueOf(arg, name, i);
        if (hit === null) continue;
        if (!hit[0]) throw new Error(`${name} needs a value`);
        options[key] = hit[0];
        i += hit[1];
        matched = true;
        break;
      }
      if (!matched) throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function discoverSkills(sourceRoot, only) {
  if (!fs.existsSync(sourceRoot)) throw new Error(`skills source directory not found: ${sourceRoot}`);
  const names = fs
    .readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(sourceRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
  if (only !== null) {
    if (!names.includes(only)) throw new Error(`no skill "${only}" with a SKILL.md under ${sourceRoot}`);
    return [only];
  }
  if (names.length === 0) throw new Error(`no skill with a SKILL.md under ${sourceRoot}`);
  return names;
}

function frontmatterName(skillMd) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  const line = match?.[1].split(/\r?\n/).find((l) => /^name:\s*/.test(l));
  return line ? line.replace(/^name:\s*/, "").trim().replace(/^["']|["']$/g, "") : null;
}

/** Per-file comparison of repo dir against installed dir. */
function compareSkill(sourceDir, targetDir) {
  const sourceFiles = listFiles(sourceDir);
  const targetFiles = new Set(listFiles(targetDir));
  const rows = [];
  for (const rel of sourceFiles) {
    if (!targetFiles.has(rel)) {
      rows.push({ rel, state: "MISSING" });
      continue;
    }
    const same = sha256(fs.readFileSync(path.join(sourceDir, rel))) === sha256(fs.readFileSync(path.join(targetDir, rel)));
    rows.push({ rel, state: same ? "MATCH" : "STALE" });
    targetFiles.delete(rel);
  }
  for (const rel of [...targetFiles].sort()) rows.push({ rel, state: "EXTRA" });
  return rows;
}

function writeAtomic(target, buffer) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, target);
}

function pruneEmptyDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    pruneEmptyDirs(child);
    if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
  }
}

/** Make `targetDir` byte-equal to `sourceDir`: copy new/changed files, delete extras. */
function syncDir(sourceDir, targetDir) {
  const sourceFiles = listFiles(sourceDir);
  const wanted = new Set(sourceFiles);
  for (const rel of listFiles(targetDir)) {
    if (!wanted.has(rel)) fs.rmSync(path.join(targetDir, rel));
  }
  for (const rel of sourceFiles) {
    const from = fs.readFileSync(path.join(sourceDir, rel));
    const to = path.join(targetDir, rel);
    if (fs.existsSync(to) && sha256(fs.readFileSync(to)) === sha256(from)) continue;
    writeAtomic(to, from);
  }
  if (fs.existsSync(targetDir)) pruneEmptyDirs(targetDir);
}

function backupRoot(targetRoot, name) {
  return path.join(targetRoot, BACKUP_DIR_NAME, name);
}

/** Lexicographically sortable timestamp; a counter keeps same-millisecond backups distinct. */
function newBackupDir(targetRoot, name) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const base = backupRoot(targetRoot, name);
  let candidate = path.join(base, stamp);
  for (let n = 1; fs.existsSync(candidate); n += 1) candidate = path.join(base, `${stamp}-${String(n).padStart(3, "0")}`);
  return candidate;
}

function latestBackup(targetRoot, name) {
  const base = backupRoot(targetRoot, name);
  if (!fs.existsSync(base)) return null;
  const dirs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return dirs.length === 0 ? null : path.join(base, dirs[dirs.length - 1]);
}

function check(skills, sourceRoot, targetRoot, log) {
  let drifted = 0;
  for (const name of skills) {
    const rows = compareSkill(path.join(sourceRoot, name), path.join(targetRoot, name));
    const bad = rows.filter((row) => row.state !== "MATCH").length;
    drifted += bad;
    log(`${name.padEnd(20)} ${bad === 0 ? "MATCH" : "STALE"}  (${rows.length} file(s), ${bad} differ)`);
    for (const row of rows) log(`  ${row.state.padEnd(8)} ${row.rel}`);
  }
  if (drifted > 0) log(`\n${drifted} file(s) differ - run: node scripts/install-managed-skills.mjs --install`);
  return drifted === 0 ? 0 : 1;
}

function install(skills, sourceRoot, targetRoot, force, log, err) {
  for (const name of skills) {
    const declared = frontmatterName(fs.readFileSync(path.join(sourceRoot, name, "SKILL.md"), "utf8"));
    if (declared !== name) {
      err(`refused: skills/${name}/SKILL.md frontmatter name is ${JSON.stringify(declared)}, expected "${name}"`);
      return 2;
    }
  }
  if (!force) {
    for (const name of skills) {
      const repoBytes = totalBytes(path.join(sourceRoot, name));
      const installedBytes = totalBytes(path.join(targetRoot, name));
      if (installedBytes > 0 && repoBytes < installedBytes * SIZE_GUARD_RATIO) {
        err(
          `refused: ${name} in the repo is ${repoBytes} bytes (SKILL.md + references) but ${installedBytes} bytes are installed ` +
            `(${Math.round((repoBytes / installedBytes) * 100)}% < ${SIZE_GUARD_RATIO * 100}%). The repo copy looks like a stub or lost content. ` +
            `Nothing was written. Restore the repo copy, or pass --force if the shrink is intended.`,
        );
        return 2;
      }
    }
  }
  for (const name of skills) {
    const sourceDir = path.join(sourceRoot, name);
    const targetDir = path.join(targetRoot, name);
    const rows = compareSkill(sourceDir, targetDir);
    if (rows.every((row) => row.state === "MATCH")) {
      log(`${name.padEnd(20)} IN_SYNC (no backup, no write)`);
      continue;
    }
    if (fs.existsSync(targetDir) && listFiles(targetDir).length > 0) {
      const backup = newBackupDir(targetRoot, name);
      syncDir(targetDir, backup);
      log(`${name.padEnd(20)} BACKUP    ${backup}`);
    }
    syncDir(sourceDir, targetDir);
    log(`${name.padEnd(20)} INSTALLED ${targetDir}  (${rows.filter((row) => row.state !== "MATCH").length} file(s) changed)`);
  }
  return 0;
}

function rollback(skills, targetRoot, log, err) {
  let failed = 0;
  for (const name of skills) {
    const backup = latestBackup(targetRoot, name);
    if (backup === null) {
      err(`${name.padEnd(20)} NO_BACKUP under ${backupRoot(targetRoot, name)}`);
      failed += 1;
      continue;
    }
    syncDir(backup, path.join(targetRoot, name));
    log(`${name.padEnd(20)} RESTORED  from ${backup}`);
  }
  return failed > 0 ? 2 : 0;
}

/** CLI entry. Returns the exit code; never calls process.exit. */
export function run(argv, io = {}) {
  const log = io.log ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  try {
    const options = parseArgs(argv);
    const sourceRoot = path.resolve(options.sourceRoot ?? path.join(ROOT, "skills"));
    const targetRoot = path.resolve(options.targetRoot ?? path.join(os.homedir(), ".omp", "agent", "managed-skills"));
    const skills = discoverSkills(sourceRoot, options.skill);
    if (options.mode === "install") return install(skills, sourceRoot, targetRoot, options.force, log, err);
    if (options.mode === "rollback") return rollback(skills, targetRoot, log, err);
    return check(skills, sourceRoot, targetRoot, log);
  } catch (error) {
    err(`[install-managed-skills] failed: ${error?.message ?? error}`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exit(run(process.argv.slice(2)));
}
