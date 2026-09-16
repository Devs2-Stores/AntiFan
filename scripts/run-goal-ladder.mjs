/**
 * Run the P0-A -> P1 acceptance ladder end to end and report the verdict tally.
 *
 * The ladder is executed by the goal runner, which supplies the checkpoint,
 * watchdog, health bounds and named abort reasons. This entrypoint adds the two
 * things the runner must not own: the build preflight (a route whose target is
 * not compiled would otherwise be indistinguishable from an unimplemented item)
 * and the Final evaluation.
 *
 * Final is `PASS == 31 AND FAIL == 0 AND NOT_IMPLEMENTED == 0 AND BLOCKED == 0`
 * with every PASS carrying a revision-bound receipt, and it is evaluated by
 * `finalHoldsFor` so the condition can be tested without running a ladder. There
 * is no clock in this model, so elapsing time cannot produce a pass. The criteria
 * text is the ladder definition file itself: editing the denominator invalidates
 * the checkpoint and the drift detector aborts the resume.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGoal } from './goal/runner.mjs';
import { spec, ITEM_COUNT } from './goal/ladder/p0-p1.mjs';
import { finalHoldsFor } from './goal/ladder/final.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const DEFAULT_CRITERIA = path.join(REPO, 'plans', '260915-1658-goal-p0-retrieval-bridge-completion', 'reports', 'ladder-31-items.md');
const REPORTS_DIR = path.join(REPO, 'plans', '260915-1658-goal-p0-retrieval-bridge-completion', 'reports');

function parseArgs(argv) {
  const out = { preflight: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-preflight') out.preflight = false;
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--criteria') out.criteriaFile = argv[++i];
    else if (a === '--summary-out') out.summaryOut = argv[++i];
    else if (a === '--help') out.help = true;
  }
  return out;
}

function usage() {
  console.log(
    'usage: node scripts/run-goal-ladder.mjs [--run-id <id>] [--dir <runDir>] [--criteria <file>] [--summary-out <file>] [--no-preflight]\n' +
      'Runs the 31-item P0-A -> P1 acceptance ladder and exits 0 only when Final holds.',
  );
}

/**
 * Run a preflight command line.
 *
 * On Windows `npm` is a `.cmd` shim, and Node refuses to exec a `.cmd` without a
 * shell. The command line is a constant built here, never interpolated from input,
 * and a single string (rather than an args array) keeps the shell from having to
 * re-split arguments.
 */
function build(step, commandLine) {
  process.stdout.write(`[ladder] preflight: ${step} ... `);
  try {
    execFileSync(commandLine, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    console.log('ok');
    return true;
  } catch (err) {
    console.log('FAILED');
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    console.error(out.split(/\r?\n/).slice(-15).join('\n'));
    return false;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}

const runId = args.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.resolve(args.dir ?? path.join(REPO, '.goal-runs', runId));
const criteriaFile = path.resolve(args.criteriaFile ?? DEFAULT_CRITERIA);

if (ITEM_COUNT !== 31) {
  console.error(`[ladder] spec has ${ITEM_COUNT} items but the denominator of 100% is 31; refusing to run`);
  process.exit(2);
}
if (!fs.existsSync(criteriaFile)) {
  console.error(`[ladder] criteria (ladder definition) not found: ${criteriaFile}`);
  process.exit(2);
}

if (args.preflight) {
  const okCompile = build('npm run compile', 'npm run compile');
  const okCore = build('super-core build', 'npm --prefix packages/super-core run build');
  if (!okCompile || !okCore) {
    console.error('[ladder] preflight failed; a route target would be absent for build reasons, not for implementation reasons');
    process.exit(2);
  }
} else {
  console.log('[ladder] preflight skipped: the caller asserts .compiled/** and packages/super-core/dist are current');
}

fs.mkdirSync(runDir, { recursive: true });
console.log(`[ladder] run dir: ${runDir}`);
console.log(`[ladder] criteria: ${path.relative(REPO, criteriaFile)}`);

const criteria = fs.readFileSync(criteriaFile, 'utf8');
const started = Date.now();
const result = await runGoal({
  dir: runDir,
  spec,
  runId,
  criteria,
  onEvent: (e) => {
    if (e.type === 'unit-verdict') console.log(`[ladder] ${e.phaseId}/${e.itemId} -> ${e.verdict}`);
    else if (e.type === 'phase-complete') console.log(`[ladder] phase ${e.phaseId} complete`);
  },
});

const units = result.checkpoint?.ladder ?? [];
const tally = units.reduce((acc, u) => {
  const key = u.verdict ?? 'PENDING';
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

const missingReceiptFields = units
  .filter((u) => u.verdict === 'PASS')
  .filter((u) => {
    const r = u.lastReceipt ?? {};
    return r.routeIdentity == null || r.exit == null || r.finishedAt == null || r.gitSha == null;
  })
  .map((u) => u.itemId);

// Final holds only when every item was judged, none failed, and every PASS carries a
// revision-bound receipt. The FAIL term is not redundant with PASS == 31: mergeLadder
// retains a judged unit whose spec item vanished, so a FAIL can outlive the item it
// belonged to and still be counted while 31 fresh items pass.
const finalHolds = finalHoldsFor(tally, missingReceiptFields);

const summary = {
  runId,
  runDir,
  status: result.status,
  abortReason: result.reason ?? null,
  abortDetail: result.detail ?? null,
  finalHolds,
  pass: tally.PASS ?? 0,
  denominator: 31,
  tally,
  unboundPasses: missingReceiptFields,
  durationMs: Date.now() - started,
  items: units.map((u) => ({
    phaseId: u.phaseId,
    itemId: u.itemId,
    label: u.label ?? null,
    verdict: u.verdict ?? 'PENDING',
    routeIdentity: u.lastReceipt?.routeIdentity ?? null,
    exit: u.lastReceipt?.exit ?? null,
    finishedAt: u.lastReceipt?.finishedAt ?? null,
    gitSha: u.lastReceipt?.gitSha ?? null,
    reason: u.lastReceipt?.reason ?? null,
  })),
};

const summaryOut = path.resolve(args.summaryOut ?? path.join(REPORTS_DIR, `ladder-run-${runId}.json`));
fs.mkdirSync(path.dirname(summaryOut), { recursive: true });
fs.writeFileSync(summaryOut, `${JSON.stringify(summary, null, 2)}\n`);

console.log('');
console.log('[ladder] verdicts');
for (const u of summary.items) {
  console.log(`  ${u.verdict.padEnd(15)} ${u.phaseId}/${u.itemId}${u.reason ? `  (${u.reason})` : ''}`);
}
console.log('');
console.log(`[ladder] runner status: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
console.log(`[ladder] tally: ${JSON.stringify(tally)}`);
if (missingReceiptFields.length) console.log(`[ladder] PASS without a revision-bound receipt: ${missingReceiptFields.join(', ')}`);
console.log(`[ladder] ${finalHolds ? 'FINAL HOLDS' : 'FINAL NOT REACHED'} — ${tally.PASS ?? 0}/31 PASS`);
console.log(`[ladder] summary: ${path.relative(REPO, summaryOut)}`);

if (result.status !== 'completed') process.exit(2);
process.exit(finalHolds ? 0 : 1);
