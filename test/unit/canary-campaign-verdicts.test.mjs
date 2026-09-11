/**
 * The campaign's run-level decisions: exit status, verdict index, hub rendering.
 *
 * These decide whether a live run's output counts and what an operator sees, so
 * they are asserted here directly instead of being discovered after a 45-case run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {

  validatePagesFilter,
  selectViewports,
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

test('--pages is parsed and validated in one place', () => {
  const ids = TARGET_PAGES.map((p) => p.id); // 1..3
  assert.deepEqual(validatePagesFilter('3', ids).ids, [3]);
  assert.deepEqual(validatePagesFilter('1-3', ids).ids, [1, 2, 3]);
  assert.deepEqual(validatePagesFilter('1,3', ids).ids, [1, 3]);
  assert.equal(validatePagesFilter(undefined, ids).ids, null, 'no filter means every page');
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

test('a page filter that names anything unreadable or unknown is refused, not partially run', () => {
  const ids = TARGET_PAGES.map((p) => p.id);

  // The parsed list hid the evidence: '1,nonsense' and '1,5-3' both parse to [1],
  // so the run would have covered page 1 and silently dropped what was asked for.
  assert.match(validatePagesFilter('home', ids).reason, /cannot read 'home'/);
  assert.match(validatePagesFilter('1,nonsense', ids).reason, /cannot read 'nonsense'/);
  assert.match(validatePagesFilter('1,5-3', ids).reason, /cannot read the range '5-3'/);
  assert.match(validatePagesFilter('1,,3', ids).reason, /empty entry/);
  assert.match(validatePagesFilter('1-2-3', ids).reason, /cannot read '1-2-3'/);
  assert.match(validatePagesFilter('9', ids).reason, /outside 1-3/);
  assert.match(validatePagesFilter('1,9', ids).reason, /outside 1-3/, 'one unknown id refuses the whole filter');
  // A numeric cast would read '-1' as a range and '1e2' as page 100.
  assert.match(validatePagesFilter('-1', ids).reason, /cannot read '-1'/);
  assert.match(validatePagesFilter('1e2', ids).reason, /cannot read '1e2'/);
  assert.match(validatePagesFilter('1.0', ids).reason, /cannot read '1.0'/);
  assert.match(validatePagesFilter('1-999999999', ids).reason, /outside 1-3/, 'a huge range refuses without expanding');

  assert.equal(validatePagesFilter('1,2-3', ids).ok, true);
});

const ALL_VIEWPORTS = [
  { label: '1440', width: 1440, height: 900, mobile: false },
  { label: '1024', width: 1024, height: 900, mobile: false },
  { label: '390', width: 390, height: 844, mobile: true },
];

test('a viewport scope is selected and declared, never silently shrunk', () => {
  const all = selectViewports(ALL_VIEWPORTS, undefined);
  assert.deepEqual(all.viewports.map((v) => v.label), ['1440', '1024', '390']);
  assert.deepEqual(all.excluded, []);
  assert.equal(all.mobileUnverified, false);

  const reduced = selectViewports(ALL_VIEWPORTS, '1440,1024');
  assert.deepEqual(reduced.viewports.map((v) => v.label), ['1440', '1024']);
  assert.deepEqual(reduced.excluded.map((e) => e.label), ['390']);
  assert.equal(reduced.mobileUnverified, true, 'an excluded mobile viewport is unverified');
  assert.equal(selectViewports(ALL_VIEWPORTS, '1440, 1024').ok, true, 'whitespace is trimmed');
  assert.deepEqual(selectViewports(ALL_VIEWPORTS, '1440,1440').viewports.map((v) => v.label), ['1440'], 'a repeated label selects once');

  // Same refusal posture as --pages: a typo must stop the run, not shrink it.
  assert.match(selectViewports(ALL_VIEWPORTS, '1440,,1024').reason, /empty entry/);
  assert.match(selectViewports(ALL_VIEWPORTS, '1440,999').reason, /names '999'/);
  assert.match(selectViewports(ALL_VIEWPORTS, 'desktop').reason, /names 'desktop'/);
});

test('an excluded viewport is unverified, not a failing case and not a green one', () => {
  // The reduced run measured 1440 and 1024 only; page 1 has no 390 case at all, and
  // a stale mobile refusal from an earlier scope is still recorded on the summary.
  const s = summary(
    { 1: page(1, 'HOME', 'page-01-home', { 1440: 'PASS', 1024: 'PASS' }) },
    {
      scope: { viewports: ['1440', '1024'], excluded: [{ label: '390', mobile: true, reason: 'not selected' }], mobileUnverified: true },
      refusals: [{ pageId: 1, viewport: '390', code: 'MOBILE_BUNDLE_ABSENT' }],
    }
  );
  const reduced = computeRunExit(s, [1], { targetPages: TARGET_PAGES, viewportLabels: ['1440', '1024'], excludedViewports: ['390'] });
  assert.equal(reduced.code, 0);
  assert.equal(reduced.reason, 'OK_SCOPE_REDUCED', 'the status names the reduced scope instead of a bare OK');
  assert.deepEqual(reduced.unverifiedViewports, ['390']);
  assert.equal(reduced.adjudicableCases, 2);

  // Nothing was waived: had 390 been requested, the same summary is incomplete, and
  // the declared mobile absence is named rather than dropped.
  const full = computeRunExit(s, [1], { targetPages: TARGET_PAGES, viewportLabels: VIEWPORT_LABELS });
  assert.equal(full.code, 1);
  assert.equal(full.reason, 'INCOMPLETE_CASES');
  assert.ok(full.detail.includes('CASE_NOT_RUN@page-1:390'));
  assert.ok(full.detail.includes('MOBILE_BUNDLE_ABSENT@page-1:390'));

  const index = buildVerdictIndex(s);
  assert.deepEqual(index.scope.excluded.map((e) => e.label), ['390']);
  assert.equal(index.scope.mobileUnverified, true);

  const html = renderHubHtml(index, { viewportLabels: ['1440', '1024'] });
  assert.ok(html.includes('NOT VERIFIED 390'), 'the hub states the unverified viewport');
  assert.ok(html.includes('not passing'), 'an exclusion is never presented as a pass');
  assert.ok(html.includes('scope-reduced'), 'the verdict line names the reduced scope');
  assert.ok(html.includes('ADJUDICATED: 2 of 2'), 'the hub states how many cases were actually adjudicated');
});

test('a reduced scope that adjudicated nothing is not a success', () => {
  // Replayed from the recorded campaign: 1440 and 1024 completed but their capture was
  // invalid, so neither carried a verdict. Dropping 390 from the scope cannot convert
  // that into a completed verification.
  const s = summary({ 1: page(1, 'HOME', 'page-01-home', { 1440: 'INCONCLUSIVE', 1024: 'INCONCLUSIVE' }) });
  s.pageResults[1].viewports[1440].causeCode = 'CAPTURE_INVALID';
  s.pageResults[1].viewports[1024].causeCode = 'CAPTURE_INVALID';
  // The page still carries the excluded viewport's refusal (recorded before the scope was
  // declared, or replayed from an earlier run): it must not count as a measured case nor
  // be offered as the reason the run failed.
  s.pageResults[1].viewports[390] = { status: 'REFUSED', overall: 'INCONCLUSIVE', causeCode: 'MOBILE_BUNDLE_ABSENT' };
  s.scope = { viewports: ['1440', '1024'], excluded: [{ label: '390', mobile: true, reason: 'not selected' }], mobileUnverified: true };
  const exit = computeRunExit(s, [1], { targetPages: TARGET_PAGES, viewportLabels: ['1440', '1024'], excludedViewports: ['390'] });
  assert.equal(exit.code, 1);
  assert.equal(exit.reason, 'NO_ADJUDICATED_CASE');
  assert.deepEqual(exit.detail, ['CAPTURE_INVALID'], 'the reason names why nothing was adjudicated');
  assert.equal(exit.adjudicableCases, 0);
  assert.equal(exit.inconclusiveCases, 2);
  assert.deepEqual(exit.unverifiedViewports, ['390'], 'the excluded viewport is still declared');
  assert.ok(
    renderHubHtml(buildVerdictIndex(s), { viewportLabels: ['1440', '1024'] }).includes('ADJUDICATED: 0 of 2'),
    'the hub counts the readable rank of measured cases, not the excluded viewport\'s record'
  );

  // The exclusion alone is enough to scope the tally: a caller that declares viewports
  // out of scope without restating the measured set still must not count them.
  const exclusionOnly = computeRunExit(s, [1], { targetPages: TARGET_PAGES, excludedViewports: ['390'] });
  assert.equal(exclusionOnly.code, 1);
  assert.equal(exclusionOnly.reason, 'NO_ADJUDICATED_CASE');
  assert.equal(exclusionOnly.inconclusiveCases, 2);
  assert.deepEqual(exclusionOnly.detail, ['CAPTURE_INVALID']);

  // One adjudicated case is enough for the reduced batch to be output.
  s.pageResults[1].viewports[1024].overall = 'FAIL';
  s.pageResults[1].viewports[1024].causeCode = 'STRUCTURAL_PARITY_MISMATCH';
  const withVerdict = computeRunExit(s, [1], { targetPages: TARGET_PAGES, viewportLabels: ['1440', '1024'], excludedViewports: ['390'] });
  assert.equal(withVerdict.code, 0);
  assert.equal(withVerdict.reason, 'OK_SCOPE_REDUCED');
  assert.equal(withVerdict.adjudicableCases, 1);
});

test('a route-refused case never enters the pass tally or the run verdict', () => {
  // The refused leg carries a PASS-shaped verdict here on purpose: the refusal is the
  // fact, and a caller that also stamped a verdict must not be able to publish it.
  const refused = page(1, 'HOME', 'page-01-home', { 1440: 'PASS' });
  refused.status = 'REFUSED';
  refused.viewports['1440'].status = 'REFUSED';
  refused.viewports['1440'].causeCode = 'URL_PATH_MISMATCH';
  refused.viewports['1440'].refusal = {
    code: 'URL_PATH_MISMATCH',
    requested: 'https://hoplongtech.com/',
    observed: 'https://hoplongtech.com/?openLogin=1',
  };
  refused.viewports['1440'].capture.expectedUrl = 'https://hoplongtech.com/';

  const index = buildVerdictIndex(summary({ 1: refused }));

  assert.equal(index.tally.ROUTE_REFUSED, 1, 'the refused case is counted under its own code');
  assert.equal(index.tally.PASS, 0, 'a route-refused case is never a pass');
  assert.equal(index.tally.INCONCLUSIVE + index.tally.PASS + index.tally.FAIL, 0, 'the tally buckets do not double-count the refused case');
  assert.notEqual(index.executiveVerdict, 'PASS', 'a run whose only case was refused is not a pass');
  assert.equal(index.routeRefusals.length, 1, 'the refusal is still reported as a refusal');

  // The hub derives its counts from the case verdicts, the tally from the same field:
  // a refused case must not read as an INCONCLUSIVE measurement in one place and as
  // nothing in the other.
  const hub = renderHubHtml(index, { viewportLabels: VIEWPORT_LABELS });
  assert.match(hub, /0 of 0 measured case\(s\)/, 'a refused case is not a measurement');
  assert.match(hub, /0 PASS \/ 0 FAIL \/ 0 INCONCLUSIVE/, 'the hub counts and the tally agree');
  assert.match(hub, /ROUTE_REFUSED/, 'the case table names the typed refusal class');
});

test('a refusal carried only by the refused case still exits as a refusal, not as an incomplete run', () => {
  const refused = page(1, 'HOME', 'page-01-home', { 1440: 'INCONCLUSIVE' });
  refused.status = 'REFUSED';
  refused.viewports['1440'].status = 'REFUSED';
  refused.viewports['1440'].causeCode = 'URL_PATH_MISMATCH';
  refused.viewports['1440'].refusal = { code: 'URL_PATH_MISMATCH' };
  refused.viewports['1440'].capture.expectedUrl = 'https://hoplongtech.com/';

  // The run summary records no refusal at all: the case record is the only witness.
  const res = computeRunExit(summary({ 1: refused }), [1], { targetPages: TARGET_PAGES, viewportLabels: ['1440'] });

  assert.equal(res.code, 4, 'a typed route refusal is exit 4');
  assert.equal(res.reason, 'ROUTE_REFUSAL');
  assert.deepEqual(res.detail, ['URL_PATH_MISMATCH@page-1:1440']);
});
