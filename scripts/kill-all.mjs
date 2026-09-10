#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — Scoped Process Reaper
 *
 * `taskkill /F /IM electron.exe` kills every Electron application on the machine:
 * VS Code, Slack, Discord, and every other repo's dev session. For a local-only
 * tool that shares a workstation with unrelated work, that is an unacceptable
 * blast radius.
 *
 * Default behaviour: kill only processes that demonstrably belong to THIS repo —
 * an Electron binary launched out of `<repo>/node_modules/electron/dist`, or any
 * process whose command line names the repo root. Also drops the dev-watcher lock
 * when its owner is already dead, so a stale lock cannot block `npm run dev`.
 *
 * `--all` restores the old machine-wide behaviour for the rare case where an
 * orphan cannot be attributed (pass it deliberately).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = path.join(ROOT, 'node_modules', '.cache', 'antifan-dev.pid');
const killEverything = process.argv.includes('--all');

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function taskkill(pid, tree) {
  const args = ['/F'];
  if (tree) args.push('/T');
  args.push('/PID', String(pid));
  try {
    execFileSync('taskkill', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** @returns {Array<{pid:number, executablePath:string, commandLine:string}>} */
function listElectronProcesses() {
  if (process.platform !== 'win32') {
    const out = run('pgrep', ['-af', 'electron']);
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(' ');
        return { pid: Number(line.slice(0, idx)), executablePath: '', commandLine: line.slice(idx + 1) };
      })
      .filter((p) => Number.isSafeInteger(p.pid) && p.pid > 0);
  }

  const out = run('powershell', [
    '-NoProfile',
    '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
  ]);
  if (!out) return [];
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => row && Number.isSafeInteger(row.ProcessId) && row.ProcessId > 0)
    .map((row) => ({
      pid: row.ProcessId,
      executablePath: row.ExecutablePath || '',
      commandLine: row.CommandLine || '',
    }));
}

function normalize(value) {
  return String(value).replace(/\//g, '\\').toLowerCase();
}

function belongsToRepo(proc) {
  const exe = normalize(proc.executablePath);
  const distRoot = normalize(path.join(ROOT, 'node_modules', 'electron', 'dist'));
  if (exe && exe.startsWith(distRoot)) return true;
  return normalize(proc.commandLine).includes(normalize(ROOT));
}

let killed = 0;
let skipped = 0;

if (killEverything) {
  try {
    execFileSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' });
    console.log('[kill-all] --all: terminated every electron.exe on this machine.');
  } catch {
    console.log('[kill-all] --all: no electron.exe processes to terminate.');
  }
} else {
  const processes = listElectronProcesses();
  if (processes.length === 0) {
    console.log('[kill-all] no electron processes found.');
  }
  for (const proc of processes) {
    if (belongsToRepo(proc)) {
      if (taskkill(proc.pid, true)) killed += 1;
    } else {
      skipped += 1;
    }
  }
  console.log(`[kill-all] terminated ${killed} AntiFan electron process(es); left ${skipped} unrelated electron process(es) alone.`);
  if (skipped > 0) {
    console.log('[kill-all] if an unrelated process is misattributed to this repo, run: node scripts/kill-all.mjs --all');
  }
}

// Drop a stale dev-watcher lock so it cannot refuse the next `npm run dev`.
try {
  const raw = fs.readFileSync(LOCK_PATH, 'utf8').trim();
  const record = JSON.parse(raw);
  const pid = Number(record.pid ?? record);
  if (Number.isSafeInteger(pid) && pid > 0 && !pidAlive(pid)) {
    fs.rmSync(LOCK_PATH, { force: true });
    console.log(`[kill-all] removed stale dev lock (dead pid ${pid}).`);
  }
} catch {
  /* no lock, or unreadable — nothing to reconcile */
}
