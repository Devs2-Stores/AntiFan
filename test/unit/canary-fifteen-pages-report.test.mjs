import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReport, TARGET_PAGES, VIEWPORTS } from '../../.canary/tools/fifteen-pages-run.mjs';

const vp = () => ({
  status: 'COMPLETED',
  overall: 'PASS',
  structure: { refDocH: 100, cloneDocH: 100, refSections: 1, cloneSections: 1, refCards: 1, cloneCards: 1, refOverflowX: 0, cloneOverflowX: 0 },
  network: { verdict: 'PASS', referenceRequests: 0 },
  capture: { valid: true, reference: { bytes: 10, exists: true }, clone: { bytes: 10, exists: true } },
  visual: { verdict: 'PASS', mismatchPercentage: 0 },
});

const page = (labels) => ({
  id: 1,
  name: 'HOME',
  url: 'https://hoplongtech.com/',
  finalUrl: 'https://hoplongtech.com/',
  status: 'COMPLETED',
  overall: 'PASS',
  phases: {
    discovery: { ok: true, sectionsCount: 1, productCards: 1, articles: 0, images: 1, docW: 100, docH: 200, overflowX: 0 },
    cloneGeneration: { ok: true },
  },
  errors: [],
  viewports: Object.fromEntries(labels.map((l) => [l, vp()])),
});

const base = { runId: 'test-run', generatedAt: '2026-09-11T00:00:00.000Z' };
const fullRun = { ...base, pageResults: { 1: page(['1440', '1024', '390']) } };
const reducedRun = {
  ...base,
  scope: { viewports: ['1440', '1024'], excluded: [{ label: '390', mobile: true, reason: 'not selected' }], mobileUnverified: true },
  pageResults: { 1: page(['1440', '1024']) },
};
const refusedPage = (code = 'URL_PATH_MISMATCH') => ({
  id: 1,
  name: 'HOME',
  url: 'https://hoplongtech.com/',
  finalUrl: 'https://hoplongtech.com/refused',
  status: 'REFUSED',
  overall: 'INCONCLUSIVE',
  causeCode: code,
  refusal: { code, reason: `route refused with ${code}`, detail: { requestedPath: '/', observedPath: '/refused' } },
  phases: {},
  errors: [],
  viewports: {},
});
const refusedOnlyRun = { ...base, pageResults: { 1: refusedPage() } };

test('a full run reports every viewport as measured', () => {
  const md = generateReport(fullRun);
  assert.match(md, /RENDER CASES RUN {2}: 3 \/ 45/);
  assert.ok(!md.includes('EXCLUDED'), 'nothing is excluded when the whole viewport set is measured');
});

test('an excluded viewport is rendered as EXCLUDED, never as NOT_TESTED and never as a pass', () => {
  const md = generateReport(reducedRun);
  const first = TARGET_PAGES[0];
  assert.match(md, /\| 390 \(EXCLUDED\) \|/, 'the matrix column declares the exclusion');
  assert.match(md, /EXECUTIVE VERDICT : \w+ — SCOPE-REDUCED \(not a whole-clone verdict\)/);
  assert.match(md, /SCOPE {13}: 1440\/1024 measured \| 390 EXCLUDED \(unverified, not passing\)/);
  assert.match(md, /RENDER CASES RUN {2}: 2 \/ 30/, 'the denominator is the selected set, not the full 45');

  const row = md.split('\n').find((line) => line.startsWith(`| ${first.id}. ${first.name} `));
  assert.ok(row, 'the executed page has a matrix row');
  assert.deepEqual(row.split('|').map((c) => c.trim()).slice(3, 6), ['PASS', 'PASS', 'EXCLUDED'], 'the viewport cells follow the declared scope');

  assert.match(md, /#### 390px \(Mobile\) — EXCLUDED/);
  assert.ok(!/#### 390px \(Mobile\)\n- \*\*Navigation\*\*/.test(md), 'an excluded viewport gets no measured block');
  assert.match(md, /\* 390px DocHeight: EXCLUDED/);
});

test('an aggregate names its evidence instead of one live session', () => {
  // The aggregate is read back from what many runs published, so rendering the session that
  // happened to regenerate it as "the test environment" asserts provenance the report does not
  // have, and makes its bytes depend on that session rather than on the evidence.
  const aggregate = { ...fullRun, aggregate: true, completedAt: '2026-09-11T00:18:04.503Z' };
  const md = generateReport(aggregate);
  assert.match(md, /Evidence Source {4}: aggregated from 1 published page attempts/);
  for (const field of ['AntiFan Port', 'Attachment ID', 'Run ID ', 'Primary Tab ID']) {
    assert.ok(!md.includes(field), `an aggregate must not print ${field} as the environment`);
  }
  assert.ok(md.includes('COMPLETION DATE   : 2026-09-11T00:18:04.503Z'), 'the completion date still comes from the evidence');
  assert.match(md, /Required Viewports : 1440x900 \(1440\), 1024x900 \(1024\), 390x844 \(390\)/, 'the pinned viewport set survives aggregation');

  const live = generateReport(fullRun);
  assert.match(live, /AntiFan Port {7}: \d+/, 'a live run still reports the session that produced it');
});

test('any excluded label keeps the matrix aligned and marks its own column', () => {
  // The operator can exclude any viewport, not only mobile, and pages 2..15 never ran:
  // the header, an executed row and an unexecuted row must keep the same column count,
  // and the excluded column must read EXCLUDED on every row instead of NOT_TESTED.
  for (const excluded of VIEWPORTS.map((v) => v.label)) {
    const measured = VIEWPORTS.map((v) => v.label).filter((label) => label !== excluded);
    const full = VIEWPORTS.map((v) => v.label);
    const report = generateReport({
      ...base,
      scope: {
        viewports: measured,
        excluded: [{ label: excluded, mobile: VIEWPORTS.find((v) => v.label === excluded).mobile, reason: 'not selected' }],
        mobileUnverified: excluded === '390',
      },
      pageResults: { 1: page(measured) },
    });
    const lines = report.split('\n');
    const column = (row) => row.split('|').map((c) => c.trim());

    const header = column(lines.find((l) => l.startsWith('| Page | URL |')));
    const executed = column(lines.find((l) => l.startsWith(`| ${TARGET_PAGES[0].id}. ${TARGET_PAGES[0].name} `)));
    const unexecuted = column(lines.find((l) => l.startsWith(`| ${TARGET_PAGES[1].id}. ${TARGET_PAGES[1].name} `)));

    assert.equal(header.length, executed.length, `${excluded}: header and executed row agree`);
    assert.equal(header.length, unexecuted.length, `${excluded}: header and unexecuted row agree`);
    assert.equal(header.filter((c) => c.endsWith('(EXCLUDED)')).length, 1, `${excluded}: exactly one column declares the exclusion`);

    const index = header.findIndex((c) => c.endsWith('(EXCLUDED)'));
    assert.equal(executed[index], 'EXCLUDED', `${excluded}: the executed row marks the excluded column`);
    assert.equal(unexecuted[index], 'EXCLUDED', `${excluded}: a never-executed row still marks the excluded column`);
    assert.ok(!report.includes('[object Object]'), `${excluded}: scope entries are never stringified raw`);
    assert.ok(report.includes(`RENDER CASES RUN  : 2 / ${TARGET_PAGES.length * full.filter((l) => l !== excluded).length}`), `${excluded}: the denominator follows the measured set`);
  }
});

test('a refused-only run renders rows A, C, and D as NOT_RUN and claims no PASS or FAIL', () => {
  const md = generateReport(refusedOnlyRun);
  const lines = md.split('\n');
  const rowA = lines.find((l) => l.startsWith('| A. Discovery '));
  const rowC = lines.find((l) => l.startsWith('| C. Asset Family '));
  const rowD = lines.find((l) => l.startsWith('| D. Typography '));

  assert.ok(rowA, 'row A exists in section 15 table');
  assert.ok(rowC, 'row C exists in section 15 table');
  assert.ok(rowD, 'row D exists in section 15 table');

  const cell = (row, index) => row.split('|').map((c) => c.trim())[index];
  assert.equal(cell(rowA, 2), 'NOT_RUN', 'row A status must be NOT_RUN');
  assert.equal(cell(rowC, 2), 'NOT_RUN', 'row C status must be NOT_RUN');
  assert.equal(cell(rowD, 2), 'NOT_RUN', 'row D status must be NOT_RUN');

  for (const [name, row] of [['Row A', rowA], ['Row C', rowC], ['Row D', rowD]]) {
    const status = cell(row, 2);
    assert.notEqual(status, 'PASS', `${name} must not claim PASS`);
    assert.notEqual(status, 'FAIL', `${name} must not claim FAIL`);
  }

  assert.ok(!rowA.includes('0/1 pages passed'), 'row A must not claim 0/1 pages passed');
  assert.match(rowA, /route-refused before build; pipeline never ran/);
});
