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
  mintVerdict,
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

test('producer-emitted envelope with expectationMarker is detected and well-formed envelope is not refused', () => {
  // Shape emitted by browser-control-port.ts:1864-1868, :1922-1932 and visual-capture.ts:873-888
  // when expectedUrl is null/missing (routeCheck.status === 'URL_EXPECTATION_MISSING'):
  // 1. Canonicalized shape emitted by updated port (browser-control-port.ts:1866-1867, :1930-1931, :4521-4523)
  // when expectedUrl is null/missing:
  const canonicalMissingEnvelope = {
    ok: true,
    artifactRef: 'artifact://screenshot-cart-missing',
    receipt: {
      backend: 'cdp',
      dpr: 1,
      zoom: 1,
      cssViewport: { width: 1440, height: 900 },
      cssCaptureSize: { width: 1440, height: 2400 },
      rasterSize: { width: 1440, height: 2400 },
      captureMode: 'full-page',
      timestamp: 1710000000000,
      expectedUrl: null,
      expectationMarker: 'URL_EXPECTATION_MISSING',
      missingExpectation: true,
      routeAssertion: {
        ok: true,
        status: 'URL_EXPECTATION_MISSING',
        requestedUrl: null,
        expectedUrl: null,
        observedUrl: 'https://hoplongtech.com/cart',
        redirectChain: [],
        code: 'URL_EXPECTATION_MISSING',
        reason: 'No expected URL was supplied for route identity assertion',
      },
    },
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    byteLength: 4096,
    routeAssertion: {
      ok: true,
      status: 'URL_EXPECTATION_MISSING',
      requestedUrl: null,
      expectedUrl: null,
      observedUrl: 'https://hoplongtech.com/cart',
      redirectChain: [],
      code: 'URL_EXPECTATION_MISSING',
      reason: 'No expected URL was supplied for route identity assertion',
    },
    expectedUrl: null,
    expectationMarker: 'URL_EXPECTATION_MISSING',
    missingExpectation: true,
  };

  // 2. Uncanonicalized/persisted shape carrying only expectationMarker and routeAssertion:
  const markerOnlyMissingEnvelope = {
    ok: true,
    artifactRef: 'artifact://screenshot-cart-missing-legacy',
    expectedUrl: null,
    expectationMarker: 'URL_EXPECTATION_MISSING',
    routeAssertion: {
      ok: true,
      status: 'URL_EXPECTATION_MISSING',
      requestedUrl: null,
      expectedUrl: null,
      observedUrl: 'https://hoplongtech.com/cart',
      redirectChain: [],
      code: 'URL_EXPECTATION_MISSING',
      reason: 'No expected URL was supplied for route identity assertion',
    },
  };

  // Shape emitted when expectedUrl is provided and matches (checkRouteIdentity returns MATCH):
  const wellFormedEnvelope = {
    ok: true,
    artifactRef: 'artifact://screenshot-cart-ok',
    receipt: {
      backend: 'cdp',
      dpr: 1,
      zoom: 1,
      cssViewport: { width: 1440, height: 900 },
      cssCaptureSize: { width: 1440, height: 2400 },
      rasterSize: { width: 1440, height: 2400 },
      captureMode: 'full-page',
      timestamp: 1710000000000,
      expectedUrl: 'https://hoplongtech.com/cart',
      routeAssertion: {
        ok: true,
        status: 'MATCH',
        requestedUrl: 'https://hoplongtech.com/cart',
        expectedUrl: 'https://hoplongtech.com/cart',
        observedUrl: 'https://hoplongtech.com/cart',
        redirectChain: [],
      },
    },
    sha256: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    byteLength: 4096,
    routeAssertion: {
      ok: true,
      status: 'MATCH',
      requestedUrl: 'https://hoplongtech.com/cart',
      expectedUrl: 'https://hoplongtech.com/cart',
      observedUrl: 'https://hoplongtech.com/cart',
      redirectChain: [],
    },
    expectedUrl: 'https://hoplongtech.com/cart',
  };

  // 1. Detection via hasMissingExpectation
  assert.equal(hasMissingExpectation(canonicalMissingEnvelope), true);
  assert.equal(hasMissingExpectation({ capture: canonicalMissingEnvelope }), true);
  assert.equal(hasMissingExpectation(markerOnlyMissingEnvelope), true);
  assert.equal(hasMissingExpectation({ capture: markerOnlyMissingEnvelope }), true);
  assert.equal(hasMissingExpectation(wellFormedEnvelope), false);
  assert.equal(hasMissingExpectation({ capture: wellFormedEnvelope }), false);

  // 2. Refusal at verdict minting
  assert.throws(
    () => mintVerdict({ overall: 'PASS', capture: canonicalMissingEnvelope }),
    (err) => err.code === 'URL_EXPECTATION_MISSING' && err.exitCode === 4
  );
  const minted = mintVerdict({ overall: 'PASS', capture: wellFormedEnvelope });
  assert.equal(minted.verdict, 'PASS');
  assert.equal(minted.expectedUrl, 'https://hoplongtech.com/cart');

  // 3. Refusal at verdict indexing
  assert.throws(
    () =>
      buildVerdictIndex({
        runId: 'run-producer-missing-expectation',
        pageResults: {
          6: {
            slug: 'page-06-cart',
            viewports: { '1440x900': { verdict: 'PASS', capture: canonicalMissingEnvelope } },
          },
        },
      }),
    (err) => err.code === 'URL_EXPECTATION_MISSING' && err.exitCode === 4
  );

  const index = buildVerdictIndex({
    runId: 'run-producer-well-formed',
    pageResults: {
      6: {
        slug: 'page-06-cart',
        viewports: { '1440x900': { overall: 'PASS', capture: wellFormedEnvelope } },
      },
    },
  });
  assert.equal(index.cases.length, 1);
  assert.equal(index.cases[0].verdict, 'PASS');
  assert.equal(index.cases[0].expectedUrl, 'https://hoplongtech.com/cart');
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
            // PASS-shaped on purpose, and in the field the tally reads: a leg the harness
            // refused must not be publishable by whatever else stamped a verdict on it. The
            // INCONCLUSIVE spelling this fixture used to carry could not catch that leak.
            overall: 'PASS',
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
  assert.equal(index.tally.INCONCLUSIVE + index.tally.FAIL, 0, 'a refused leg is counted once, under its own class');
  assert.equal(index.routeRefusals.length, 1);
  assert.equal(index.executiveVerdict, 'INCONCLUSIVE');

  // The hub derives its counts from the case verdicts; the tally from the same field. One
  // fact, one reading: the refused case is neither a measurement nor a pass.
  const hub = renderHubHtml(index, { viewportLabels: ['1440x900'] });
  assert.match(hub, /0 PASS \/ 0 FAIL \/ 0 INCONCLUSIVE/);
  assert.match(hub, /ROUTE_REFUSED/);
});
