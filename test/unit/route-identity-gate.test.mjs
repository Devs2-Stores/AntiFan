/**
 * Route identity is a refusal class, never a fidelity verdict.
 *
 * The defect this guards: a capture of the storefront's `/cart` was redirected to
 * `/?openLogin=1`, measured against the cart's reference, and published as
 * `PASS / MATCH 1.81%` — a homepage-derived PASS presented as the cart's verdict. The
 * requested path was never compared with the path the tab actually reported, and a
 * route-refused case could still enter the pass tally.
 *
 * Every case below uses the URL pair measured in that investigation, so a future change
 * that relaxes path comparison (or lets a route refusal reach the tally) fails here
 * before it can publish a number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkObservedUrl } from '../../.canary/tools/theme-fidelity.mjs';
import {
  buildVerdictIndex,
  computeRunExit,
  hasMissingExpectation,
  pageRouteRefusal,
  renderHubHtml,
  renderPageStatus,
} from '../../scripts/lib/campaign-verdicts.mjs';

test('a requested route served as another route is refused with URL_PATH_MISMATCH', () => {
  const refusal = checkObservedUrl(
    { name: 'page-06-cart', url: 'https://hoplongtech.com/cart' },
    'https://hoplongtech.com/?openLogin=1'
  );
  assert.ok(refusal, 'the cart capture served from the homepage must be refused');
  assert.equal(refusal.code, 'URL_PATH_MISMATCH');
  assert.equal(refusal.exitCode, 4);
  assert.equal(refusal.detail.requestedPath, '/cart');
  assert.equal(refusal.detail.observedPath, '/');
});

test('a trailing slash is not a route change', () => {
  assert.equal(
    checkObservedUrl({ name: 'p', url: 'https://hoplongtech.com/cart/' }, 'https://hoplongtech.com/cart'),
    null
  );
});

test('a leg that keeps its theme id is never refused', () => {
  assert.equal(
    checkObservedUrl(
      { name: 'retained', url: 'https://hoplongtech.com/collections/all?themeid=1001512581' },
      'https://hoplongtech.com/collections/all?themeid=1001512581'
    ),
    null
  );
});

test('a theme id drift is refused with URL_THEME_MISMATCH', () => {
  const refusal = checkObservedUrl(
    { name: 'retained', url: 'https://hoplongtech.com/collections/all?themeid=1001512581' },
    'https://hoplongtech.com/collections/all?themeid=9999999'
  );
  assert.equal(refusal?.code, 'URL_THEME_MISMATCH');
});

test('a different host is refused with URL_HOST_MISMATCH', () => {
  const refusal = checkObservedUrl(
    { name: 'page-12', url: 'https://hoplongtech.com/collections/hot-sale' },
    'https://hoplong.com/gioi-thieu-ve-hop-long/'
  );
  assert.equal(refusal?.code, 'URL_HOST_MISMATCH');
});

test('the clone side is asserted against the loopback entry it is served from', () => {
  assert.equal(
    checkObservedUrl({ name: 'clone', url: 'http://127.0.0.1:7866/mobile/' }, 'http://127.0.0.1:7866/mobile/'),
    null
  );
});

test('a capture that carries no expectation is detectable and refuses at verdict minting', () => {
  assert.equal(hasMissingExpectation({ capture: { code: 'URL_EXPECTATION_MISSING' } }), true);
  assert.equal(hasMissingExpectation({ capture: { valid: true } }), false);

  assert.throws(
    () =>
      buildVerdictIndex({
        runId: 'run-missing-expectation',
        pageResults: {
          6: {
            slug: 'page-06-cart',
            viewports: { '1440x900': { verdict: 'PASS', capture: { code: 'URL_EXPECTATION_MISSING' } } },
          },
        },
      }),
    (err) => err.code === 'URL_EXPECTATION_MISSING' && err.exitCode === 4
  );
});

test('a page-level refusal renders as REFUSED, not as a metrics shortfall', () => {
  // Shape taken verbatim from the measured run: the page refused before any case
  // existed, so `overall` stays INCONCLUSIVE and the metrics are all absent.
  const pageResult = {
    status: 'REFUSED',
    overall: 'INCONCLUSIVE',
    causeCode: 'URL_PATH_MISMATCH',
    error: 'GIỎ HÀNG was requested at path /cart but the tab reports /',
    refusal: {
      code: 'URL_PATH_MISMATCH',
      reason: 'GIỎ HÀNG was requested at path /cart but the tab reports /',
      detail: {
        target: 'GIỎ HÀNG',
        requested: 'https://hoplongtech.com/cart',
        observed: 'https://hoplongtech.com/?openLogin=1',
        requestedPath: '/cart',
        observedPath: '/',
      },
    },
  };
  assert.equal(pageRouteRefusal(pageResult)?.code, 'URL_PATH_MISMATCH');
  const status = renderPageStatus(pageResult);
  assert.match(status, /^REFUSED \(URL_PATH_MISMATCH: requested \/cart, tab reported \/\)$/);
  assert.doesNotMatch(status, /Missing complete structural metrics/);
});

test('a page with no refusal keeps its fidelity outcome', () => {
  assert.equal(pageRouteRefusal({ overall: 'PASS', refusal: null }), null);
  assert.equal(renderPageStatus({ overall: 'PASS' }), 'PASS');
  assert.equal(renderPageStatus(undefined), 'NOT_TESTED');
  // A non-route refusal (a bundle that was never built) is not a route refusal.
  assert.equal(pageRouteRefusal({ status: 'REFUSED', refusal: { code: 'MOBILE_BUNDLE_ABSENT' } }), null);
});

test('the hub names a page-level refusal that minted no case', () => {
  const html = renderHubHtml(
    {
      runId: 'run-page-refusal',
      generatedAt: '2026-09-11T07:54:57.267Z',
      executiveVerdict: 'INCONCLUSIVE',
      tally: { PASS: 0, FAIL: 0, INCONCLUSIVE: 0, ROUTE_REFUSED: 0 },
      cases: [],
      refusals: [
        {
          pageId: 6,
          viewport: null,
          code: 'URL_PATH_MISMATCH',
          detail: {
            code: 'URL_PATH_MISMATCH',
            reason: 'GIỎ HÀNG was requested at path /cart but the tab reports /',
            detail: { requested: 'https://hoplongtech.com/cart', observed: 'https://hoplongtech.com/?openLogin=1', requestedPath: '/cart', observedPath: '/' },
          },
        },
      ],
      superseded: [],
      scope: { viewports: ['1440', '1024', '390'], excluded: [] },
    },
    { viewportLabels: ['1440', '1024', '390'] }
  );
  assert.match(html, /class="refused"/);
  assert.match(html, /URL_PATH_MISMATCH/);
  assert.match(html, /requested \/cart → tab reported \//);
});

test('a route-refused page makes the run exit REFUSAL', () => {
  const outcome = computeRunExit(
    {
      pageResults: { 6: { id: 6, slug: 'page-06-cart', status: 'REFUSED', overall: 'INCONCLUSIVE', viewports: {}, refusal: { code: 'URL_PATH_MISMATCH' } } },
      refusals: [{ pageId: 6, viewport: null, code: 'URL_PATH_MISMATCH', detail: { code: 'URL_PATH_MISMATCH' } }],
    },
    [6],
    { targetPages: [{ id: 6 }], viewportLabels: ['1440', '1024', '390'], excludedViewports: [] }
  );
  assert.equal(outcome.code, 4);
  assert.equal(outcome.reason, 'ROUTE_REFUSAL');
  assert.deepEqual(outcome.detail, ['URL_PATH_MISMATCH@page-6']);
});

test('a recorded route refusal makes the run exit REFUSAL', () => {
  const outcome = computeRunExit(
    { refusals: [{ pageId: 6, viewport: '1440x900', code: 'URL_PATH_MISMATCH' }], pageResults: {} },
    [6],
    { targetPages: [{ id: 6 }], viewportLabels: ['1440x900'], excludedViewports: [] }
  );
  assert.equal(outcome.code, 4);
  assert.equal(outcome.reason, 'ROUTE_REFUSAL');
});

test('a route-refused case is tallied ROUTE_REFUSED and never counts as a pass', () => {
  const index = buildVerdictIndex({
    runId: 'run-route-refused',
    pageResults: {
      6: {
        slug: 'page-06-cart',
        attemptId: 'attempt-1',
        evidenceRoot: 'evidence/attempt-1',
        viewports: {
          '1440x900': {
            verdict: 'INCONCLUSIVE',
            refusal: { code: 'URL_PATH_MISMATCH', reason: 'cart capture served from the homepage' },
            capture: { valid: true },
          },
        },
      },
    },
  });
  assert.equal(index.tally.PASS, 0);
  assert.equal(index.tally.ROUTE_REFUSED, 1);
  assert.equal(index.routeRefusals.length, 1);
  assert.equal(index.executiveVerdict, 'INCONCLUSIVE');
});
