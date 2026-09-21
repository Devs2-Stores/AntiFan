/**
 * Soak launch args — `SOAK_APP_ARGS` to the app's argv, graded against the real parser.
 *
 * The passthrough exists so a diagnosis run can attach from outside the app (an open DevTools
 * endpoint is what `scripts/probe-renderer-retention-class.cjs` reads). Two failures it must not
 * have:
 *
 *  - a switch that silently reaches the app on a *measurement* run, because whichever numbers
 *    such a run produces are then read as a clean baseline;
 *  - a value the parser mangles into a different argv than the operator wrote, which would read
 *    as "the flag did nothing" while the app actually launched with something else.
 *
 * The parser is required from `scripts/benchmark-real-soak-8h.cjs` rather than re-implemented: a
 * copy of the rule certifies nothing about the run.
 */
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
// Requiring the module must not start a run; its entry point is guarded.
const { parseExtraAppArgs, EXTRA_APP_ARGS, parseRunArgs } = require('../../scripts/benchmark-real-soak-8h.cjs');

describe('soak launch args — SOAK_APP_ARGS', () => {
  it('passes nothing when unset, empty or whitespace', () => {
    for (const raw of [undefined, '', '   ', '\t\n']) {
      assert.deepStrictEqual(parseExtraAppArgs(raw), []);
    }
  });

  it('splits switches in order, without inventing or dropping one', () => {
    assert.deepStrictEqual(parseExtraAppArgs('--remote-debugging-port=0'), ['--remote-debugging-port=0']);
    assert.deepStrictEqual(parseExtraAppArgs('  --remote-debugging-port=0   --disable-gpu  '), [
      '--remote-debugging-port=0',
      '--disable-gpu',
    ]);
    // A switch that takes a separate value keeps both tokens, in the order given.
    assert.deepStrictEqual(parseExtraAppArgs('--js-flags --expose-gc'), ['--js-flags', '--expose-gc']);
  });

  it('refuses to guess at a quoted value instead of splitting it into two tokens', () => {
    // Whitespace splitting cannot represent `--user-data-dir="E:/a b"`; the parser warns and
    // returns tokens verbatim rather than silently moving a quote into a path. The warning is
    // what makes the mangling visible in the run log.
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => void warnings.push(args.join(' '));
    try {
      const parsed = parseExtraAppArgs('--user-data-dir="E:/a b"');
      assert.deepStrictEqual(parsed, ['--user-data-dir="E:/a', 'b"']);
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0], /SOAK_APP_ARGS contains a quote/);
    } finally {
      console.warn = original;
    }
  });

  it('is empty on a measurement run', () => {
    // This test process sets no SOAK_APP_ARGS, so the module-level value is the empty case: a
    // measurement run must not carry switches nobody asked for. That the value reaches the
    // payload is asserted where the payload is built (soak-payload-contract.test.mjs).
    assert.deepStrictEqual(EXTRA_APP_ARGS, []);
    assert.deepStrictEqual(parseExtraAppArgs(process.env.SOAK_APP_ARGS ?? ''), []);
  });
});

describe('soak run args — the entry argv', () => {
  const HARNESS = require.resolve('../../scripts/benchmark-real-soak-8h.cjs');
  // Every spawn below is either refused before `main()` or is the `--print-legs` dry path,
  // which returns before it — so no case here can launch an Electron child or bind a port.
  const runHarness = (argv, env = {}) =>
    spawnSync(process.execPath, [HARNESS, ...argv], {
      encoding: 'utf8',
      env: { ...process.env, SOAK_LEGS: '', SOAK_DURATION_MINUTES: '', ...env },
    });

  it('refuses a token it does not implement instead of silently ignoring it', () => {
    // `--minutes` used to reach the harness's argv and do nothing: a request for 12 minutes
    // launched the 480-minute default, and the artifact then carried a schedule nobody chose.
    const refused = runHarness(['--minutes']);
    assert.strictEqual(refused.status, 1);
    assert.match(refused.stderr, /--minutes needs a positive number of minutes/);

    const unknown = runHarness(['--duration', '12']);
    assert.strictEqual(unknown.status, 1);
    assert.match(unknown.stderr, /unknown argument "--duration"/);
    // The refusal names what *is* accepted, so the operator is not left guessing.
    assert.match(unknown.stderr, /--print-legs \| --minutes <n>/);
  });

  it('resolves the requested duration from argv, and argv outranks the environment', () => {
    assert.deepStrictEqual(parseRunArgs([]), { printLegs: false, durationMinutes: null });
    assert.deepStrictEqual(parseRunArgs(['--minutes', '12']), { printLegs: false, durationMinutes: 12 });
    assert.deepStrictEqual(parseRunArgs(['--minutes=45']), { printLegs: false, durationMinutes: 45 });

    const dry = runHarness(['--minutes', '12', '--print-legs'], { SOAK_DURATION_MINUTES: '240' });
    assert.strictEqual(dry.status, 0);
    assert.match(dry.stdout, /Requested duration: 12 min \(argv --minutes\)/);
    // The requested 12 minutes cannot hold warmup 30 + recovery 30, so the schedule's own
    // length differs from the request — the wiring is proven by the request reaching the
    // schedule computation, not by the run being 12 minutes long.
    assert.match(dry.stdout, /run 60\.1 min = warmup 30 \+ workload 0\.1 \+ recovery 30/);
  });

  it('reads the duration from the environment when no argument sets it', () => {
    const dry = runHarness(['--print-legs'], { SOAK_DURATION_MINUTES: '240' });
    assert.strictEqual(dry.status, 0);
    assert.match(dry.stdout, /Requested duration: 240 min \(env SOAK_DURATION_MINUTES\)/);
    assert.match(dry.stdout, /run 240 min = warmup 30 \+ workload 180 \+ recovery 30/);
  });
});

/**
 * Bundle preflight — a graded run must not measure a tree that is about to be recompiled.
 *
 * The launcher compiles a stale bundle before the app starts (`main.cjs` -> `npm run compile`),
 * so a run launched on a stale tree measures the old code for its first seconds and the new code
 * after that, and reports one number. The refusal is the only thing standing between that and an
 * artifact that reads as a single measurement, so both polarities are pinned against the real
 * launcher guard rather than a stub.
 */
describe('soak bundle preflight — refuse to grade a tree the app will recompile', () => {
  const { bundlePreflight } = require('../../scripts/benchmark-real-soak-8h.cjs');
  const { inspectCompiledBundle } = require('../../scripts/launch-guard.cjs');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  it('refuses a missing bundle, naming the state and the command that fixes it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-preflight-'));
    try {
      const verdict = inspectCompiledBundle({
        bundlePath: path.join(dir, '.compiled', 'src', 'main', 'index.js'),
        buildInfoPath: path.join(dir, '.compiled', '.tsbuildinfo'),
        sourceRoots: [path.join(dir, 'src')],
        configFiles: [path.join(dir, 'tsconfig.json')],
      });
      assert.strictEqual(verdict.state, 'missing');
      const preflight = bundlePreflight(verdict);
      assert.strictEqual(preflight.ok, false);
      assert.match(preflight.message, /missing/);
      assert.match(preflight.message, /npm run compile/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a current bundle and fails closed when there is no verdict', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-preflight-'));
    try {
      const bundlePath = path.join(dir, '.compiled', 'src', 'main', 'index.js');
      fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
      fs.writeFileSync(bundlePath, 'module.exports = {};\n');
      const verdict = inspectCompiledBundle({
        bundlePath,
        buildInfoPath: path.join(dir, '.compiled', '.tsbuildinfo'),
        sourceRoots: [path.join(dir, 'src')],
        configFiles: [path.join(dir, 'tsconfig.json')],
      });
      assert.strictEqual(verdict.state, 'fresh', 'no source inputs to compare against');
      assert.strictEqual(bundlePreflight(verdict).ok, true);
      // A guard that cannot report is not a passing guard.
      assert.strictEqual(bundlePreflight(undefined).ok, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
