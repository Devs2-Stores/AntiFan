/**
 * The campaign's run-level decisions: exit status, verdict index, hub rendering.
 *
 * These decide whether a live run's output counts and what an operator sees, so
 * they are asserted here directly instead of being discovered after a 45-case run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePagesFilter,
  validatePagesFilter,
  buildVerdictIndex,
  computeRunExit,
  renderHubHtml,
} from '../../scripts/lib/campaign-verdicts.mjs';

const TARGET_PAGES = [
  { id: 1, slug: 'page-01-home', name: 'HOME' },
  { id: 2, slug: 'page-02-brands', name: 'BRANDS' },
  { id: 3, slug: 'page-03-products', name: 'PRODUCTS' },
];
const VIEWPORT_LABELS = ['1440', '1024', '390'];

/** A page result shaped like the orchestrator's, with the parts a decision reads. */
const page = (id, name, slug, verdicts) => ({
  id,
  name,
  slug,
  attemptId: `attempt-${id}`,
  evidenceRoot: `E:/attempts/${slug}`,
  status: 'COMPLETED',
  bundle: { entrySha256: `sha-${id}`, attemptId: `attempt-${id}` },
  viewports: Object.fromEntries(
    Object.entries(verdicts).map(([label, verdict]) => [
      label,
      {
        viewport: `${label === '390' ? '390x844' : `${label}x900`}`,
        status: 'COMPLETED',
        overall: verdict,
        causeCode: verdict === 'PASS' ? 'MATCH' : 'STRUCTURAL_PARITY_MISMATCH',
        visual: { verdict, mismatchPercentage: verdict === 'PASS' ? 0.2 : 4.1 },
        capture: { valid: true, reference: { sha256: 'r' }, clone: { sha256: 'c' } },
        structure: { refDocH: 100, cloneDocH: 101, refSections: 5, cloneSections: 5, refCards: 2, cloneCards: 2 },
      },
    ])
  ),
});

const summary = (pageResults, extra = {}) => ({
  runId: 'campaign-test',
  startedAt: '2026-09-10T00:00:00.000Z',
  instance: { pid: 1234, processStartToken: 'tok' },
  refusals: [],
  pageResults,
  ...extra,
});

test('parsePagesFilter accepts single ids, ranges and lists', () => {
  assert.deepEqual(parsePagesFilter('3'), [3]);
  assert.deepEqual(parsePagesFilter('1-3'), [1, 2, 3]);
  assert.deepEqual(parsePagesFilter('1,4-5,9'), [1, 4, 5, 9]);
  assert.equal(parsePagesFilter(null), null);
  assert.deepEqual(parsePagesFilter('nonsense'), []);
});

test('a fidelity FAIL is valid output: the run exits 0', () => {
  const s = summary({
    1: page(1, 'HOME', 'page-01-home', { 1440: 'PASS', 1024: 'FAIL', 390: 'PASS' }),
    2: page(2, 'BRANDS', 'page-02-brands', { 1440: 'PASS', 1024: 'PASS', 390: 'PASS' }),
    3: page(3, 'PRODUCTS', 'page-03-products', { 1440: 'PASS', 1024: 'PASS', 390: 'PASS' }),
  });
  const exit = computeRunExit(s, null, { targetPages: TARGET_PAGES, viewportLabels: VIEWPORT_LABELS });
  assert.equal(exit.code, 0);
  assert.equal(exit.reason, 'OK');
  assert.equal(exit.adjudicableCases, 9);
});

test('a case that ran and yielded a cause-coded INCONCLUSIVE still exits 0', () => {
  // The reconciliation phase owns explaining these; they are output, not a run
  // failure, and conflating the two would make the exit status meaningless.
  const s = summary({ 1: page(1, 'HOME', 'page-01-home', { 1440: 'INCONCLUSIVE', 1024: 'PASS', 390: 'PASS' }) });
  const exit = computeRunExit(s, [1], { targetPages: TARGET_PAGES, viewportLabels: VIEWPORT_LABELS });
  assert.equal(exit.code, 0);
  assert.equal(exit.inconclusiveCases, 1);
});

test('cases that never produced an adjudication make the run incomplete', () => {
  const blankBuild = summary({ 1: page(1, 'HOME', 'page-01-home', {}) });
  blankBuild.pageResults[1].viewports = {
    1440: { viewport: '1440x900', label: '1440', status: 'BLOCKED_BY_BUILD', overall: 'INCONCLUSIVE' },
    1024: { viewport: '1024x900', label: '1024', status: 'BLOCKED_BY_BUILD', overall: 'INCONCLUSIVE' },
    390: { viewport: '390x844', label: '390', status: 'BLOCKED_BY_BUILD', overall: 'INCONCLUSIVE' },
  };
  const blocked = computeRunExit(blankBuild, [1], { targetPages: TARGET_PAGES, viewportLabels: VIEWPORT_LABELS });
  assert.equal(blocked.code, 1);
  assert.equal(blocked.reason, 'INCOMPLETE_CASES');
  assert.equal(blocked.detail.length, 3);

  const missingCase = summary({ 1: page(1, 'HOME', 'page-01-home', { 1440: 'PASS' }) });
  const absent = computeRunExit(missingCase, [1], { targetPages: TARGET_PAGES, viewportLabels: VIEWPORT_LABELS });
  assert.equal(absent.reason, 'INCOMPLETE_CASES');
  assert.deepEqual(absent.detail, ['CASE_NOT_RUN@page-1:1024', 'CASE_NOT_RUN@page-1:390']);

  const notRun = summary({});
  assert.equal(computeRunExit(notRun, [1], { targetPages: TARGET_PAGES, viewportLabels: VIEWPORT_LABELS }).reason, 'INCOMPLETE_CASES');

  // Readiness / rasterization refusals stopped before the compare: no adjudication
  // was produced, so the requested case did not happen.
  const refused = summary({ 1: page(1, 'HOME', 'page-01-home', { 1440: 'PASS', 1024: 'PASS', 390: 'PASS' }) });
  refused.pageResults[1].viewports[1440] = { viewport: '1440x900', label: '1440', status: 'REFUSED', overall: 'INCONCLUSIVE', causeCode: 'RASTERIZATION_UNSTABLE' };
  const refusedExit = computeRunExit(refused, [1], { targetPages: TARGET_PAGES, viewportLabels: VIEWPORT_LABELS });
  assert.equal(refusedExit.code, 1);
  assert.equal(refusedExit.reason, 'INCOMPLETE_CASES');
  assert.deepEqual(refusedExit.detail, ['RASTERIZATION_UNSTABLE@page-1:1440']);
});

test('a viewport case that threw is a runner error, not an absence', () => {
  const s = summary({ 1: page(1, 'HOME', 'page-01-home', { 1440: 'PASS', 1024: 'PASS', 390: 'PASS' }) });
  s.pageResults[1].viewports[1024] = { viewport: '1024x900', label: '1024', status: 'ERROR', overall: 'INCONCLUSIVE', causeCode: 'VIEWPORT_RUN_ERROR' };
  const exit = computeRunExit(s, [1], { targetPages: TARGET_PAGES, viewportLabels: VIEWPORT_LABELS });
  assert.equal(exit.code, 1);
  assert.equal(exit.reason, 'RUNNER_ERROR');
  assert.deepEqual(exit.detail, ['VIEWPORT_RUN_ERROR@page-1:1024']);
});

test('an unexecuted requested page fails the run, a filtered-out page does not', () => {
  const partial = summary({ 1: page(1, 'HOME', 'page-01-home', { 1440: 'PASS' }) });
  const full = computeRunExit(partial, null, { targetPages: TARGET_PAGES, viewportLabels: VIEWPORT_LABELS });
  assert.equal(full.code, 1);
  assert.equal(full.reason, 'INCOMPLETE_CASES');
  assert.ok(full.detail.some((d) => d.startsWith('PAGE_NOT_RUN@page-2')));

  const filtered = computeRunExit(partial, [1], { targetPages: TARGET_PAGES, viewportLabels: VIEWPORT_LABELS });
  assert.equal(filtered.code, 1, 'the filtered page still lacks its 1024 and 390 cases');
  assert.ok(filtered.detail.every((d) => !d.includes('page-2') && !d.includes('page-3')));
});

test('provenance refusals and declared case absences fail the run', () => {
  const identity = summary(
    { 1: page(1, 'HOME', 'page-01-home', { 1440: 'PASS' }) },
    { refusals: [{ pageId: 1, viewport: '1440', code: 'BUNDLE_IDENTITY_MISMATCH' }] }
  );
  const mismatch = computeRunExit(identity, [1], { targetPages: TARGET_PAGES });
  assert.equal(mismatch.code, 1);
  assert.equal(mismatch.reason, 'PROVENANCE_REFUSAL');
  assert.deepEqual(mismatch.detail, ['BUNDLE_IDENTITY_MISMATCH@page-1:1440']);

  // A 390 case that is declared impossible still did not run, so the requested
  // case set is incomplete and the exit status must not report success.
  const mobileRefusal = summary(
    { 1: page(1, 'HOME', 'page-01-home', { 1440: 'PASS' }) },
    { refusals: [{ pageId: 1, viewport: '390', code: 'MOBILE_BUNDLE_ABSENT' }] }
  );
  const absence = computeRunExit(mobileRefusal, [1], { targetPages: TARGET_PAGES });
  assert.equal(absence.code, 1);
  assert.equal(absence.reason, 'INCOMPLETE_CASES');
  assert.deepEqual(absence.detail, ['MOBILE_BUNDLE_ABSENT@page-1:390']);
});

test('a completed case that names no bundle or instance is not publishable', () => {
  const s = summary({ 1: page(1, 'HOME', 'page-01-home', { 1440: 'PASS', 1024: 'PASS', 390: 'PASS' }) });
  const vp = s.pageResults[1].viewports;
  vp[1440].bundle = { entrySha256: 'sha-1', attemptId: 'attempt-1' };
  vp[1024].bundle = null;
  s.pageResults[1].bundle = null; // the index's fallback, so 1024 has nothing to inherit
  vp[390].bundle = { entrySha256: 'sha-1', attemptId: 'attempt-1' };
  const exit = computeRunExit(s, [1], { targetPages: TARGET_PAGES, viewportLabels: VIEWPORT_LABELS });
  assert.equal(exit.code, 1);
  assert.equal(exit.reason, 'PROVENANCE_INCOMPLETE');
  assert.deepEqual(exit.detail, ['NO_PROVENANCE@page-1:1024']);

  // Provenance that is inherited rather than carried per case is acceptable: the
  // index resolves it the same way, so it must not be reported as missing.
  s.pageResults[1].bundle = { entrySha256: 'sha-1', attemptId: 'attempt-1' };
  assert.equal(computeRunExit(s, [1], { targetPages: TARGET_PAGES, viewportLabels: VIEWPORT_LABELS }).code, 0);
});

test('losing the run lock fails closed before any other consideration', () => {
  const s = summary(
    { 1: page(1, 'HOME', 'page-01-home', { 1440: 'PASS' }) },
    { lockLost: { at: '2026-09-10T00:10:00.000Z', pageId: 1, reason: 'LOCK_LOST' } }
  );
  const exit = computeRunExit(s, [1], { targetPages: TARGET_PAGES });
  assert.equal(exit.code, 1);
  assert.equal(exit.reason, 'LOCK_LOST');
});

test('the index carries provenance per case and reports a superseded page', () => {
  const s = summary({ 1: page(1, 'HOME', 'page-01-home', { 1440: 'PASS' }) });
  s.finishedAt = '2026-09-10T00:20:00.000Z';
  const index = buildVerdictIndex(s, { supersededSlugs: ['page-02-brands'] });

  assert.equal(index.cases.length, 1);
  const c = index.cases[0];
  assert.equal(c.attemptId, 'attempt-1');
  assert.equal(c.bundle.entrySha256, 'sha-1');
  assert.equal(c.instance.pid, 1234);
  assert.equal(c.artifacts.referencePng, 'r');
  assert.equal(c.geometry.reference.docHeight, 100);
  assert.equal(index.executiveVerdict, 'PASS');
  assert.deepEqual(index.superseded, [{ slug: 'page-02-brands', reason: 'evidence predates any attempt pointer' }]);

  const failing = summary({
    1: page(1, 'HOME', 'page-01-home', { 1440: 'PASS' }),
    2: page(2, 'BRANDS', 'page-02-brands', { 1440: 'FAIL' }),
  });
  assert.equal(buildVerdictIndex(failing).executiveVerdict, 'FAIL');

  const inconclusive = summary({ 1: page(1, 'HOME', 'page-01-home', { 1440: 'INCONCLUSIVE' }) });
  assert.equal(buildVerdictIndex(inconclusive).executiveVerdict, 'INCONCLUSIVE');
});

test('the hub shows every page and viewport, and escapes page-controlled text', () => {
  const s = summary({
    1: page(1, '<img src=x onerror=alert(1)>', 'page-01-home', { 1440: 'PASS', 1024: 'FAIL' }),
  });
  const index = buildVerdictIndex(s, { supersededSlugs: ['page-09-tai-lieu'] });
  const html = renderHubHtml(index, { viewportLabels: VIEWPORT_LABELS });

  assert.ok(html.includes('<td class="v-PASS">PASS'));
  assert.ok(html.includes('<td class="v-FAIL">FAIL'));
  assert.ok(html.includes('<td class="v-missing">'), 'a viewport with no case renders as absent');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'page text is escaped');
  assert.ok(!html.includes('<img src=x'), 'no raw page text reaches the hub');
  assert.ok(html.includes('page-09-tai-lieu'), 'a superseded page is named');
  assert.ok(html.includes('>attempt-1<'), 'the hub names the attempt a case came from');
  assert.equal((html.match(/<th>1 /g) || []).length, 1);
});

test('a page filter that names nothing runnable is refused before anything is acquired', () => {
  const ids = TARGET_PAGES.map((p) => p.id);

  // A typo parses to an empty list: without this check the loop would skip every
  // page while the exit classifier still expected the pages the operator named.
  assert.equal(parsePagesFilter('home').length, 0);
  const typo = validatePagesFilter('home', parsePagesFilter('home'), ids);
  assert.equal(typo.ok, false);
  assert.match(typo.reason, /names no page/);

  const outOfRange = validatePagesFilter('9', parsePagesFilter('9'), ids);
  assert.equal(outOfRange.ok, false);
  assert.match(outOfRange.reason, /outside 1-3/);

  const mixed = validatePagesFilter('1,9', parsePagesFilter('1,9'), ids);
  assert.equal(mixed.ok, false, 'one unknown id refuses the whole filter');

  assert.equal(validatePagesFilter('2', parsePagesFilter('2'), ids).ok, true);
  assert.equal(validatePagesFilter('1-2', parsePagesFilter('1-2'), ids).ok, true);
  assert.equal(validatePagesFilter(undefined, parsePagesFilter(undefined), ids).ok, true);
});
