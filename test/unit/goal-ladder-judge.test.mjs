/**
 * The ladder is what certifies the whole goal, so its judge is the one place a bug
 * can turn "nothing was verified" into "everything passed". These cases pin the two
 * ways that happened on this revision's first run — a route whose every matched test
 * was skipped, and a route that exited non-zero under a clean TAP summary — plus the
 * placeholder guard that predates them, so none of the three can come back.
 */
import { test } from 'node:test';
import * as assert from 'node:assert';
import { parseTap, judgeTestRoute, item, spec, ITEM_COUNT } from '../../scripts/goal/ladder/p0-p1.mjs';
import { finalHoldsFor } from '../../scripts/goal/ladder/final.mjs';

const route = { kind: 'test', target: 'test/x.test.mjs', args: [] };

test('a skipped test is not a passing name', () => {
  const tap = parseTap(['ok 1 - real check', 'ok 2 - guarded check # SKIP no jsdom', '# tests 1', '# pass 1', '# fail 0', '# skipped 1'].join('\n'));
  assert.deepEqual(tap.names, ['real check', 'guarded check']);
  assert.equal(tap.skipped, 1);
  assert.equal(tap.pass, 1);
});

test('a route whose matches all skipped executed no assertion and cannot pass', () => {
  // The reproduced defect: `# pass 0` with a non-empty name list judged PASS, so a
  // route matched only by skip-guarded tests certified an item it never checked.
  const stdout = ['ok 1 - guarded check # SKIP jsdom absent', '# tests 1', '# pass 0', '# fail 0', '# skipped 1'].join('\n');
  const out = parseTap(stdout);
  const judged = judgeTestRoute(route, out, 0);
  assert.equal(judged?.verdict, 'FAIL');
  assert.equal(judged?.reason, 'ROUTE_EXECUTED_NO_ASSERTIONS');
});

test('a clean summary cannot carry a pass when the process exited non-zero', () => {
  // The second half of the defect: the judge read only TAP, so a route that printed
  // `# fail 0` and then died recorded PASS while its own receipt reported exit 1.
  const out = parseTap(['ok 1 - real check', '# tests 1', '# pass 1', '# fail 0'].join('\n'));
  const judged = judgeTestRoute(route, out, 1);
  assert.equal(judged?.verdict, 'FAIL');
  assert.equal(judged?.reason, 'ROUTE_NONZERO_EXIT');
});

test('a real run of real assertions passes', () => {
  const out = parseTap(['ok 1 - real check', 'ok 2 - another check', '# tests 2', '# pass 2', '# fail 0'].join('\n'));
  assert.equal(judgeTestRoute(route, out, 0), null);
});

test('a pattern that matched nothing still fails', () => {
  // The placeholder node --test emits for a fully filtered file: one passing test
  // named after the file itself. Guarded before this change and still guarded.
  const placeholder = { kind: 'test', target: 'test/x.test.mjs', args: [] };
  const out = parseTap(['ok 1 - test/x.test.mjs', '# tests 1', '# pass 1', '# fail 0'].join('\n'));
  const judged = judgeTestRoute(placeholder, out, 0);
  assert.equal(judged?.verdict, 'FAIL');
  assert.equal(judged?.reason, 'ROUTE_PATTERN_MATCHED_NOTHING');
});

test('a route with no TAP summary fails rather than passing silently', () => {
  const out = parseTap('not tap at all');
  const judged = judgeTestRoute(route, out, 0);
  assert.equal(judged?.verdict, 'FAIL');
  assert.equal(judged?.reason, 'ROUTE_PRODUCED_NO_TAP_SUMMARY');
});

test('an item that declares no route is not implemented, never a vacuous pass', async () => {
  // Left to the loop, an empty result set satisfies `worst === undefined` and mints a
  // PASS whose routeIdentity is the empty string — a bound-looking receipt for a check
  // that never ran.
  const bare = item({ itemId: 'x', label: 'bare', group: 'g', ownerPhase: 'p', routes: [] });
  const receipt = await bare.run({ artifactDir: process.cwd() });
  assert.equal(receipt.verdict, 'NOT_IMPLEMENTED');
  assert.equal(receipt.reason, 'NO_ROUTES_DECLARED');
  assert.equal(receipt.exit, null);
});

test('every declared item carries at least one route', () => {
  // The guard above fails closed at run time; this fails at test time, which is where
  // a spec typo should be caught.
  const items = spec.phases.flatMap((p) => p.items);
  assert.equal(items.length, ITEM_COUNT);
  assert.equal(ITEM_COUNT, 31);
  const bare = items.filter((i) => !i.routes || i.routes.length === 0).map((i) => i.itemId);
  assert.deepEqual(bare, [], `items declaring no route: ${bare.join(', ')}`);
});

test('Final refuses a tally that hides a failure behind a full pass count', () => {
  // A judged orphan FAIL survives a spec edit, so PASS == 31 can coexist with FAIL == 1.
  assert.equal(finalHoldsFor({ PASS: 31, FAIL: 0, NOT_IMPLEMENTED: 0, BLOCKED: 0 }, []), true);
  assert.equal(finalHoldsFor({ PASS: 31, FAIL: 1 }, []), false);
  assert.equal(finalHoldsFor({ PASS: 30, FAIL: 0 }, []), false);
  assert.equal(finalHoldsFor({ PASS: 31, NOT_IMPLEMENTED: 1 }, []), false);
  assert.equal(finalHoldsFor({ PASS: 31, BLOCKED: 1 }, []), false);
  assert.equal(finalHoldsFor({ PASS: 31 }, ['item-x']), false);
});
