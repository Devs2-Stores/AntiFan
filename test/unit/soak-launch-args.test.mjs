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

const require = createRequire(import.meta.url);
// Requiring the module must not start a run; its entry point is guarded.
const { parseExtraAppArgs, EXTRA_APP_ARGS } = require('../../scripts/benchmark-real-soak-8h.cjs');

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
