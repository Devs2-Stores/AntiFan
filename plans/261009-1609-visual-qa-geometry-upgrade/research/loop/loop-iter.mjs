// One loop iteration: dev-corpora metric + live-store FP probe in parallel, then the guard.
// usage: node loop-iter.mjs <worktree> <label> <bestLabel>
// Prints METRIC, GUARD and LIVE lines; appends nothing (the controller records the decision).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [wt, label, best] = process.argv.slice(2);
const HERE = 'E:/Work/scratch/vqa-loop';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const run = (cmd, args, opts) => new Promise((resolve) => {
  const child = spawn(cmd, args, { cwd: wt, env, ...opts });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('exit', (code) => resolve({ code, log: log.replace(/\x1b\[[0-9;]*m/g, '') }));
});
const liveOut = path.join(HERE, 'live', label);
fs.rmSync(liveOut, { recursive: true, force: true });
const [metric, live] = await Promise.all([
  run(process.execPath, [path.join(HERE, 'loop-verify.mjs'), wt, label]),
  run(process.execPath, ['scripts/run-electron.cjs', 'scripts/probe-visual-qa-live-sites.cjs', `--out=${liveOut}`]),
]);
const mlines = metric.log.split(/\r?\n/).filter((l) => l.trim() && !/NO_COLOR|trace-warnings/.test(l));
console.log(`METRIC exit=${metric.code} ${mlines.slice(-2).join(' ')}`);
const score = JSON.parse(fs.readFileSync(path.join(HERE, 'runs', label, 'score.json'), 'utf8'));
const prev = JSON.parse(fs.readFileSync(path.join(HERE, 'runs', best, 'score.json'), 'utf8'));
const prevMissed = new Set(prev.missed.map((m) => m.split(' ')[0]));
const curMissed = new Set(score.missed.map((m) => m.split(' ')[0]));
console.log(`GAINED ${[...prevMissed].filter((k) => !curMissed.has(k)).join(', ') || '-'}`);
console.log(`MISSED ${score.missed.join(' | ') || '-'}`);
const guard = spawnSync(process.execPath, [path.join(HERE, 'loop-guard.mjs'), wt, label, best], { cwd: wt, env, encoding: 'utf8' });
console.log(`${(guard.stdout || '').trim()}${guard.stderr && guard.status !== 0 ? `\n${guard.stderr.trim().slice(-800)}` : ''}`);
const liveLines = live.log.split(/\r?\n/).filter((l) => /SUMMARY|crit=[1-9]| unmeasured /.test(l));
console.log(`LIVE exit=${live.code}`);
for (const l of liveLines) console.log(`  ${l.trim()}`);
try {
  const rows = JSON.parse(fs.readFileSync(path.join(liveOut, 'results.json'), 'utf8'));
  for (const row of rows) {
    const crit = (row.findings || row.integrity?.findings || []).filter((f) => f.severity === 'critical');
    for (const f of crit) console.log(`  CRIT ${row.id || row.site} ${f.kind} ${f.selector} :: ${f.details}`);
  }
} catch (e) {
  console.log(`  live results unreadable: ${e.message}`);
}
