// Loop metric: run the lane harness of <worktree> on the dev corpora, score against blind ground truth.
// usage: node loop-verify.mjs <worktree> <label>
// stdout last line: the single metric (caught defect viewport-rows). Details: runs/<label>/score.json
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const [wt, label] = process.argv.slice(2);
const HERE = 'E:/Work/scratch/vqa-loop';
const GT = JSON.parse(fs.readFileSync(path.join(HERE, 'ground-truth/ground-truth.json'), 'utf8'));
// holdout-4 (fresh blind corpus, added at iteration 10 when the first three saturated) lives outside
// the worktree with its own blind ground truth; holdout-3 stays reserved for the close-out.
const CORPORA = ['fixtures', 'holdout', 'holdout-2', 'holdout-4'];
const corpusFile = (corpus) => corpus === 'holdout-4'
  ? path.join(HERE, 'holdout-4', 'holdout-4.cjs')
  : path.join(wt, 'test/fixtures/visual-qa', `${corpus}.cjs`);
GT['holdout-4.cjs'] = fs.existsSync(path.join(HERE, 'holdout-4', 'ground-truth.json'))
  ? JSON.parse(fs.readFileSync(path.join(HERE, 'holdout-4', 'ground-truth.json'), 'utf8'))
  : undefined;
const runDir = path.join(HERE, 'runs', label);
fs.rmSync(runDir, { recursive: true, force: true });
fs.mkdirSync(runDir, { recursive: true });

const score = { label, caught: 0, defectRows: 0, fp: 0, cleanCrit: 0, gaps: 0, laneExit: {}, missed: [], fps: [], gapRows: [], cleanCritRows: [], scanMsTotal: 0, scanMsMax: 0 };
for (const corpus of CORPORA) {
  const file = corpusFile(corpus);
  const out = path.join(runDir, corpus);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(process.execPath, ['scripts/run-electron.cjs', 'test/e2e/visual-qa-fixtures-probe.cjs', `--corpus=${file}`, `--out=${out}`],
    { cwd: wt, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(runDir, `${corpus}.log`), `${run.stdout || ''}${run.stderr || ''}`, 'utf8');
  score.laneExit[corpus] = run.status;
  if (run.status !== 0 && run.status !== 1) { console.error(`lane crashed on ${corpus} (exit ${run.status})`); process.exit(2); }
  const rows = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  delete require.cache[require.resolve(file)];
  const byId = Object.fromEntries(require(file).map((f) => [f.id, f]));
  const truth = GT[`${corpus}.cjs`];
  for (const row of rows) {
    const fx = byId[row.id];
    const key = `${corpus}:${row.vp}:${row.id}`;
    const findings = row.integrity.findings || [];
    const crit = findings.filter((f) => f.severity === 'critical');
    const warn = findings.filter((f) => f.severity === 'warning');
    const ms = row.integrity.stats?.durationMs ?? row.wallMs;
    score.scanMsTotal += ms;
    score.scanMsMax = Math.max(score.scanMsMax, row.wallMs);
    const st = row.integrity.stats || {};
    if (row.integrity.measured !== true || st.truncated === true || (st.failedDetectors || []).length || !row.restored || row.wallMs > 3000) {
      score.gaps++; score.gapRows.push(`${key} ${row.reasons.join('; ')}`);
    }
    if (fx.expect.control) {
      const bad = crit.length || (warn.length && !fx.expect.allowWarning) || (row.overflow.hasOverflow && !fx.expect.allowOverflow);
      if (bad) { score.fp++; score.fps.push(`${key} ${findings.map((f) => `${f.severity[0]}:${f.kind}`).join(',')} ovf=${row.overflow.hasOverflow}`); }
      continue;
    }
    const present = truth?.[row.id]?.[row.vp];
    if (present === undefined) throw new Error(`no ground truth for ${key}`);
    if (present) {
      score.defectRows++;
      const hit = fx.expect.documentOverflow
        ? row.overflow.hasOverflow === true
        : findings.some((f) => fx.expect.kinds.includes(f.kind) && (f.severity === 'critical' || fx.expect.allowWarning));
      if (hit) score.caught++;
      else score.missed.push(`${key} got=${findings.map((f) => `${f.severity[0]}:${f.kind}`).join(',') || '-'}`);
    } else if (crit.length) {
      score.cleanCrit++; score.cleanCritRows.push(`${key} ${crit.map((f) => f.kind).join(',')}`);
    }
  }
}
fs.writeFileSync(path.join(runDir, 'score.json'), JSON.stringify(score, null, 2), 'utf8');
console.log(JSON.stringify({ caught: score.caught, of: score.defectRows, fp: score.fp, cleanCrit: score.cleanCrit, gaps: score.gaps, laneExit: score.laneExit, scanMsTotal: score.scanMsTotal, scanMsMax: score.scanMsMax }));
console.log(score.caught);
