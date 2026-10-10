// Throwaway close-out mutant run: does the fixture lane go red when one detector of the CURRENT
// engine is silenced or downgraded? usage: node close-mutants.cjs <worktree>
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require(path.join(process.argv[2], 'node_modules', 'esbuild'));

const wt = process.argv[2];
const HERE = 'E:/Work/scratch/vqa-loop';
const dir = path.join(HERE, 'close-mutants');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const bundle = path.join(dir, 'engine.cjs');
esbuild.buildSync({ entryPoints: [path.join(wt, 'src/main/qa/scanners/layout-integrity-engine.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: bundle });
const { LayoutIntegrityEngine } = require(bundle);
const RETURN = 'findings: out, stats: stats';
const base = LayoutIntegrityEngine.getBrowserScanScript('__VIEWPORT_NAME__').replace('"__VIEWPORT_NAME__"', "'__VIEWPORT_NAME__'");
if (!base.includes("'__VIEWPORT_NAME__'")) throw new Error('viewport placeholder missing');
if (base.split(RETURN).length !== 2) throw new Error('return anchor not unique');

const kinds = ['overlap', 'clipping', 'occlusion', 'offscreen', 'zero-size', 'sticky-obstruction', 'layout-shift'];
const mutants = [['M00_identity', base]];
for (const k of kinds) mutants.push([`K_${k}_silenced`, base.replace(RETURN, `findings: out.filter((f) => f.kind !== '${k}'), stats: stats`)]);
mutants.push(['S_all_downgraded_warning', base.replace(RETURN, `findings: out.map((f) => Object.assign({}, f, { severity: 'warning' })), stats: stats`)]);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const rows = [];
for (const [name, script] of mutants) {
  const file = path.join(dir, `${name}.js`);
  fs.writeFileSync(file, script, 'utf8');
  const failed = [];
  let exits = [];
  for (const corpus of ['fixtures', 'holdout', 'holdout-2']) {
    const out = path.join(dir, name, corpus);
    const run = spawnSync(process.execPath, ['scripts/run-electron.cjs', 'test/e2e/visual-qa-fixtures-probe.cjs', `--corpus=test/fixtures/visual-qa/${corpus}.cjs`, `--scan-file=${file}`, `--out=${out}`],
      { cwd: wt, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    exits.push(run.status);
    const m = /SUMMARY [^\n]*failed=([^\s]*)/.exec(run.stdout || '');
    if (m && m[1]) failed.push(...m[1].split(',').map((x) => `${corpus}:${x}`));
  }
  const killed = name === 'M00_identity' ? exits.every((e) => e === 0) : exits.some((e) => e === 1);
  rows.push({ name, exits, killed, failedCount: failed.length, failed: failed.slice(0, 6) });
  console.log(`${name.padEnd(28)} exits=${exits.join('/')} ${name === 'M00_identity' ? (killed ? 'CLEAN' : 'NOT-CLEAN') : (killed ? 'KILLED' : 'SURVIVED')} failed=${failed.length} ${failed.slice(0, 4).join(',')}`);
}
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(rows, null, 2), 'utf8');
