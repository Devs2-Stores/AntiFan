/**
 * Pure unit tests for the theme-fidelity harness: argument parsing, inventory and
 * viewport validation, the themeid safety gate, identity comparison, pair pairing,
 * the comparator's terminal mapping, the replay <base> injection and provenance
 * resolution. Nothing here touches the browser instance, a session file or the
 * filesystem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ALLOWED_THEMES,
  DOC_HEIGHT_TOLERANCE_PX,
  EXIT,
  compareIdentityFields,
  evaluateUrlSafety,
  formatPairLine,
  injectBaseHref,
  isMeasurableIdentity,
  mapVisualVerdict,
  pairArtifacts,
  parseArgs,
  parseViewportSpec,
  projectGeometry,
  resolveRunProvenance,
  slugify,
  themeIdFromParameter,
  checkServedTheme,
  validateInventory,
} from '../../.canary/tools/theme-fidelity.mjs';

const refusal = (fn, code, exitCode) => {
  let caught = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, `expected a refusal ${code}`);
  assert.equal(caught.name, 'Refusal', `expected a Refusal, got ${caught.name}: ${caught.message}`);
  assert.equal(caught.code, code);
  if (exitCode !== undefined) assert.equal(caught.exitCode, exitCode);
  return caught;
};

const inventory = (overrides = {}) => ({
  store: 'phukienmaymoc.com',
  livePreviewBase: 'https://phukienmaymoc.com/?themeid=-1',
  copyPreviewBase: 'https://phukienmaymoc.com/?themeid=1001512581',
  surfaces: [
    { name: 'home', url: 'https://phukienmaymoc.com/?themeid=1001512581', source: 'route', notes: '' },
    { name: 'cart', url: 'https://phukienmaymoc.com/cart?themeid=1001512581', source: 'route', notes: '' },
  ],
  ...overrides,
});

test('parseArgs reads both modes and refuses everything it cannot name', () => {
  const capture = parseArgs(['capture', '--role', 'reference', '--label', 'r1', '--inventory', 'inv.json', '--out', 'out']);
  assert.equal(capture.mode, 'capture');
  assert.equal(capture.options.role, 'reference');
  assert.equal(capture.options.label, 'r1');
  assert.equal(capture.options.viewports, '1440x900,1024x900,390x844');
  assert.deepEqual(capture.options.allowThemes, DEFAULT_ALLOWED_THEMES);

  const subject = parseArgs(['capture', '--role=subject', '--label', 's1', '--inventory', 'inv.json', '--out=out', '--allow-theme', '1001512581,42', '--viewports', '1440x900']);
  assert.equal(subject.options.role, 'subject');
  assert.deepEqual(subject.options.allowThemes, ['1001512581', '42']);
  assert.equal(subject.options.viewports, '1440x900');

  const compare = parseArgs(['compare', '--reference', 'ref', '--subject', 'sub', '--out', 'verd']);
  assert.deepEqual(compare.options, { reference: 'ref', subject: 'sub', out: 'verd' });

  assert.equal(parseArgs(['--help']).mode, 'help');
  assert.equal(parseArgs(['-h']).mode, 'help');

  refusal(() => parseArgs([]), 'MODE_MISSING', EXIT.USAGE);
  refusal(() => parseArgs(['snapshot']), 'MODE_UNKNOWN', EXIT.USAGE);
  refusal(() => parseArgs(['capture', '--role', 'reference', '--label', 'x', '--inventory', 'i', '--out', 'o', '--colour', 'red']), 'ARG_UNKNOWN', EXIT.USAGE);
  refusal(() => parseArgs(['compare', '--reference', 'ref', '--subject', 'sub']), 'ARG_REQUIRED_MISSING', EXIT.USAGE);
  refusal(() => parseArgs(['compare', '--reference', 'ref', '--subject', 'sub', '--out']), 'ARG_VALUE_MISSING', EXIT.USAGE);
  refusal(() => parseArgs(['capture', '--role', 'reference', '--role', 'subject', '--label', 'x', '--inventory', 'i', '--out', 'o']), 'ARG_DUPLICATE', EXIT.USAGE);
  refusal(() => parseArgs(['capture', '--role', 'clone', '--label', 'x', '--inventory', 'i', '--out', 'o']), 'ROLE_INVALID', EXIT.USAGE);
  refusal(() => parseArgs(['compare', 'ref', '--subject', 's', '--out', 'o']), 'ARG_UNEXPECTED', EXIT.USAGE);
});

test('parseViewportSpec derives the tier geometry the harness compares with', () => {
  const tiers = parseViewportSpec('1440x900,1024x900,390x844');
  assert.deepEqual(tiers.map((t) => t.label), ['1440x900', '1024x900', '390x844']);
  assert.deepEqual(tiers.map((t) => t.mobile), [false, false, true]);
  assert.deepEqual(tiers.map((t) => t.dpr), [1, 1, 1]);
  assert.equal(tiers[2].width, 390);
  assert.equal(tiers[2].height, 844);

  const single = parseViewportSpec(' 768x1024 ');
  assert.equal(single.length, 1);
  assert.equal(single[0].mobile, false, '768 is the first non-mobile tier');

  refusal(() => parseViewportSpec('1440'), 'VIEWPORT_SPEC_INVALID', EXIT.USAGE);
  refusal(() => parseViewportSpec('1440x'), 'VIEWPORT_SPEC_INVALID', EXIT.USAGE);
  refusal(() => parseViewportSpec('0x900'), 'VIEWPORT_SPEC_INVALID', EXIT.USAGE);
  refusal(() => parseViewportSpec('1440x900,1440x900'), 'VIEWPORT_SPEC_DUPLICATE', EXIT.USAGE);
  refusal(() => parseViewportSpec('  '), 'VIEWPORT_SPEC_INVALID', EXIT.USAGE);
});

test('validateInventory requires surfaces and names the missing field by path', () => {
  const ok = validateInventory(inventory(), { file: 'inv.json' });
  assert.equal(ok.store, 'phukienmaymoc.com');
  assert.equal(ok.targets.length, 2);
  assert.deepEqual(ok.targets.map((t) => t.kind), ['surface', 'surface']);

  const withViews = validateInventory(inventory({ views: [{ name: 'collection-brand', template: 'collection.brand.liquid', url: 'https://phukienmaymoc.com/?themeid=1001512581&view=brand' }] }), { file: 'inv.json' });
  assert.equal(withViews.targets.length, 3);
  assert.equal(withViews.targets[2].kind, 'view');
  assert.equal(withViews.targets[2].template, 'collection.brand.liquid');

  refusal(() => validateInventory(null, { file: 'inv.json' }), 'INVENTORY_UNREADABLE', EXIT.USAGE);
  const noStore = refusal(() => validateInventory(inventory({ store: '' }), { file: 'inv.json' }), 'INVENTORY_FIELD_MISSING', EXIT.USAGE);
  assert.equal(noStore.detail.field, 'store');
  refusal(() => validateInventory(inventory({ surfaces: [] }), { file: 'inv.json' }), 'INVENTORY_FIELD_MISSING', EXIT.USAGE);
  refusal(() => validateInventory(inventory({ surfaces: undefined }), { file: 'inv.json' }), 'INVENTORY_FIELD_MISSING', EXIT.USAGE);
  const noUrl = refusal(() => validateInventory(inventory({ surfaces: [{ name: 'home' }] }), { file: 'inv.json' }), 'INVENTORY_FIELD_MISSING', EXIT.USAGE);
  assert.equal(noUrl.detail.field, 'surfaces[0].url');
  refusal(() => validateInventory(inventory({ surfaces: [{ url: 'https://x/' }] }), { file: 'inv.json' }), 'INVENTORY_FIELD_MISSING', EXIT.USAGE);
  const relative = refusal(() => validateInventory(inventory({ surfaces: [{ name: 'home', url: '/cart' }] }), { file: 'inv.json' }), 'INVENTORY_URL_INVALID', EXIT.USAGE);
  assert.equal(relative.detail.url, '/cart');
  refusal(() => validateInventory(inventory({ surfaces: [{ name: 'home', url: 'ftp://x/' }] }), { file: 'inv.json' }), 'INVENTORY_URL_INVALID', EXIT.USAGE);
  refusal(() => validateInventory(inventory({ surfaces: [{ name: 'home', url: 'https://x/?a=1' }, { name: 'HOME', url: 'https://x/?a=2' }] }), { file: 'inv.json' }), 'INVENTORY_NAME_COLLISION', EXIT.USAGE);
  refusal(() => validateInventory(inventory({ views: { name: 'x' } }), { file: 'inv.json' }), 'INVENTORY_FIELD_MISSING', EXIT.USAGE);
  refusal(() => validateInventory(inventory({ views: [{ name: 'v', url: 'https://x/?view=v' }] }), { file: 'inv.json' }), 'INVENTORY_FIELD_MISSING', EXIT.USAGE);
});

test('the themeid gate allows -1 and the authorised copy, and refuses anything else by name', () => {
  const { targets } = validateInventory(inventory({
    surfaces: [
      { name: 'live', url: 'https://phukienmaymoc.com/?themeid=-1&view=home' },
      { name: 'copy', url: 'https://phukienmaymoc.com/?themeid=1001512581&view=home' },
      { name: 'bare', url: 'https://phukienmaymoc.com/cart' },
      { name: 'other', url: 'https://phukienmaymoc.com/?themeid=999&view=home' },
    ],
  }), { file: 'inv.json' });

  const safety = evaluateUrlSafety(targets, DEFAULT_ALLOWED_THEMES);
  assert.deepEqual(safety.allowedThemes, ['-1', '1001512581']);
  assert.equal(safety.gates[0].themeId, -1);
  assert.equal(safety.gates[0].allowed, true);
  assert.equal(safety.gates[1].themeId, 1001512581);
  assert.equal(safety.gates[1].allowed, true);
  assert.equal(safety.gates[2].themeId, null);
  assert.equal(safety.gates[2].parameter, null);
  assert.equal(safety.gates[2].allowed, true, 'a URL without themeid is allowed and recorded as carrying none');
  assert.match(safety.gates[2].reason, /no themeid/);
  assert.equal(safety.gates[3].allowed, false);
  assert.equal(safety.refusals.length, 1);
  assert.equal(safety.refusals[0].code, 'THEME_ID_NOT_ALLOWED');
  assert.equal(safety.refusals[0].url, 'https://phukienmaymoc.com/?themeid=999&view=home');
  assert.equal(safety.refusals[0].value, '999');
});

test('the themeid gate reads the parameter case-insensitively and refuses any offending value', () => {
  const { targets } = validateInventory(inventory({
    surfaces: [
      { name: 'upper', url: 'https://phukienmaymoc.com/?themeId=1001512581' },
      { name: 'twice', url: 'https://phukienmaymoc.com/?themeid=1001512581&themeid=7' },
    ],
  }), { file: 'inv.json' });
  const safety = evaluateUrlSafety(targets, DEFAULT_ALLOWED_THEMES);
  assert.equal(safety.gates[0].allowed, true);
  assert.equal(safety.gates[0].themeId, 1001512581);
  assert.equal(safety.gates[1].allowed, false);
  assert.equal(safety.refusals.length, 1);
  assert.equal(safety.refusals[0].value, '7');

  const extended = evaluateUrlSafety(targets, ['1001512581', '7']);
  assert.equal(extended.refusals.length, 0);
  assert.equal(extended.gates[1].allowed, true);
  // -1 stays allowed whatever the list says; the list replaces the default copy id.
  const narrowed = evaluateUrlSafety(targets, ['7']);
  assert.deepEqual(narrowed.refusals.map((r) => r.value), ['1001512581', '1001512581']);
});

test('identity comparison withholds on any field disagreement and tolerates only height rounding', () => {
  const pinned = { device: 'web', ua: 'Mozilla/5.0', innerWidth: 1024, innerHeight: 900, dpr: 1, docHeight: 5426, sections: 11, widgetNodes: 30 };
  assert.equal(compareIdentityFields(pinned, { ...pinned }).agree, true);

  const rounded = compareIdentityFields(pinned, { ...pinned, docHeight: pinned.docHeight + DOC_HEIGHT_TOLERANCE_PX });
  assert.equal(rounded.agree, true, 'a two-pixel rounding difference is within the measured tolerance');

  const drifted = compareIdentityFields(pinned, { ...pinned, docHeight: pinned.docHeight + DOC_HEIGHT_TOLERANCE_PX + 1 });
  assert.equal(drifted.agree, false);
  assert.deepEqual(drifted.differences.map((d) => d.field), ['docHeight']);
  assert.equal(drifted.differences[0].pinned, 5426);
  assert.equal(drifted.differences[0].measured, 5429);

  const device = compareIdentityFields(pinned, { ...pinned, device: 'mobile' });
  assert.equal(device.agree, false);
  assert.deepEqual(device.differences.map((d) => d.field), ['device']);

  const sections = compareIdentityFields(pinned, { ...pinned, sections: 12 });
  assert.equal(sections.agree, false);
  assert.deepEqual(sections.differences.map((d) => d.field), ['sections']);

  assert.equal(isMeasurableIdentity(null), false);
  const unreadable = compareIdentityFields(pinned, { device: 'web' });
  assert.equal(unreadable.agree, false);
  assert.equal(unreadable.unmeasurable, 'measured');
  const noPin = compareIdentityFields(null, { ...pinned });
  assert.equal(noPin.agree, false);
  assert.equal(noPin.unmeasurable, 'pinned');
});

test('pairArtifacts pairs by surface and viewport and names every unpaired side', () => {
  const reference = [
    { surface: 'home', viewport: '1440x900' },
    { surface: 'home', viewport: '390x844' },
    { surface: 'cart', viewport: '1440x900' },
  ];
  const subject = [
    { surface: 'home', viewport: '1440x900' },
    { surface: 'home', viewport: '390x844' },
    { surface: 'search', viewport: '1440x900' },
  ];
  const { pairs, referenceOnly, subjectOnly } = pairArtifacts(reference, subject);
  assert.deepEqual(pairs.map((p) => p.key), ['home__1440x900', 'home__390x844']);
  assert.deepEqual(referenceOnly, ['cart__1440x900']);
  assert.deepEqual(subjectOnly, ['search__1440x900']);

  const perfect = pairArtifacts(reference, reference);
  assert.equal(perfect.pairs.length, 3);
  assert.deepEqual(perfect.referenceOnly, []);
  assert.deepEqual(perfect.subjectOnly, []);
});

test('the comparator terminal mapping withholds an unmapped tool verdict instead of promoting it', () => {
  assert.equal(mapVisualVerdict({ dimensionsMatch: true, match: true, mismatchPercentage: 0.02 }).verdict, 'PASS');
  assert.equal(mapVisualVerdict({ dimensionsMatch: true, match: false, mismatchPercentage: 7.35 }).verdict, 'FAIL');
  const truncated = mapVisualVerdict({ dimensionsMatch: false, verdict: 'STRUCTURAL_TRUNCATION_DETECTED', mismatchPercentage: 100 });
  assert.equal(truncated.verdict, 'INCONCLUSIVE');
  assert.equal(truncated.unmapped, 'STRUCTURAL_TRUNCATION_DETECTED');
  assert.equal(mapVisualVerdict({ dimensionsMatch: false, status: 'INCONCLUSIVE' }).verdict, 'INCONCLUSIVE');
  assert.equal(mapVisualVerdict({}).verdict, 'INCONCLUSIVE');
  assert.equal(mapVisualVerdict({ dimensionsMatch: false, verdict: 'INCONCLUSIVE' }).unmapped, null);
});

test('a pair line carries surface, viewport, verdict, percentage and both heights', () => {
  assert.equal(
    formatPairLine({ surface: 'home', viewport: '1440x900', verdict: 'PASS', mismatchPercentage: 0.02, referenceHeight: 5432, subjectHeight: 5432 }),
    'surface=home viewport=1440x900 verdict=PASS mismatch=0.02% referenceHeight=5432px subjectHeight=5432px'
  );
  assert.match(
    formatPairLine({ surface: 'home', viewport: '390x844', verdict: 'INCONCLUSIVE', mismatchPercentage: null, referenceHeight: null, subjectHeight: 4533 }),
    /^surface=home viewport=390x844 verdict=INCONCLUSIVE mismatch=n\/a referenceHeight=n\/a subjectHeight=4533px$/
  );
});

test('geometry projection keeps the measurable fields and drops the bulk arrays', () => {
  const geometry = projectGeometry({
    url: 'https://phukienmaymoc.com/?themeid=1001512581',
    docHeight: 5426,
    clientWidth: 1024,
    scrollWidth: 1024,
    overflowX: 0,
    sectionCount: 11,
    productCardCount: 83,
    articleCardCount: 4,
    navItemCount: 12,
    linkCount: 300,
    imageCount: 90,
    brokenImages: ['a', 'b'],
    textNodes: 120,
    hasMenuMobile: false,
    hasBottomNav: false,
    headerRect: { x: 0, y: 0, w: 1024, h: 90 },
    sections: [{ tag: 'section', cls: 'banner', rect: { x: 0, y: 90, w: 1024, h: 400 } }],
    fonts: { body: { family: 'Arial', size: '14px' } },
    images: [{ src: 'x', rendered: [1, 1] }],
    cardRects: [{ x: 0, y: 0, w: 1, h: 1 }],
  });
  assert.equal(geometry.docHeight, 5426);
  assert.equal(geometry.overflowX, 0);
  assert.equal(geometry.brokenImageCount, 2);
  assert.deepEqual(geometry.sections, [{ tag: 'section', cls: 'banner', rect: { x: 0, y: 90, w: 1024, h: 400 } }]);
  assert.equal(geometry.headerRect.h, 90);
  assert.equal('images' in geometry, false);
  assert.equal('cardRects' in geometry, false);
  assert.equal(projectGeometry(null), null);
});

test('the replay base href is inserted, or repaired when the document declares one', () => {
  const captured = 'https://phukienmaymoc.com/products/x?themeid=1001512581';
  const inserted = injectBaseHref('<!DOCTYPE html><html><head><link href="assets/a.css"></head><body></body></html>', captured);
  assert.equal(inserted.mode, 'inserted');
  assert.equal(inserted.baseHref, captured);
  assert.match(inserted.html, /<head><base href="https:\/\/phukienmaymoc\.com\/products\/x\?themeid=1001512581"><link href="assets\/a\.css">/);

  const repaired = injectBaseHref('<html><head><base href="/"><link href="assets/a.css"></head></html>', captured);
  assert.equal(repaired.mode, 'repaired');
  assert.equal(repaired.baseHref, 'https://phukienmaymoc.com/');
  assert.match(repaired.html, /<base href="https:\/\/phukienmaymoc\.com\/">/);
  assert.equal((repaired.html.match(/<base\b/g) || []).length, 1, 'a second base tag would be ignored by the browser');

  const headless = injectBaseHref('<html><body>x</body></html>', captured);
  assert.equal(headless.mode, 'inserted-head');
  assert.match(headless.html, /<html><head><base href=/);

  const upper = injectBaseHref('<!DOCTYPE html><HTML><HEAD></HEAD><BODY></BODY></HTML>', captured);
  assert.equal(upper.mode, 'inserted');
});

test('provenance that cannot be resolved is refused instead of filled with a placeholder', () => {
  const instance = { attachmentId: 'att-1', pid: 4242, startedAt: '2026-09-11T00:00:00.000Z', runId: 'run-1', attemptId: 'att-1' };
  const boot = { attachmentId: 'att-1', runId: 'run-1', tabId: 'tab-1', port: 20131, authorityRevision: 'rev_1', mintedAt: '2026-09-11T00:00:00.000Z' };
  const resolved = resolveRunProvenance(boot, instance, { label: 'r1', role: 'reference' });
  assert.equal(resolved.attachmentId, 'att-1');
  assert.equal(resolved.runId, 'run-1');
  assert.equal(resolved.primaryTabId, 'tab-1');
  assert.equal(resolved.label, 'r1');
  assert.equal(resolved.instancePid, 4242);

  const missingRun = refusal(() => resolveRunProvenance({ ...boot, runId: undefined }, instance), 'PROVENANCE_UNRESOLVED', EXIT.REFUSAL);
  assert.deepEqual(missingRun.detail.missing, ['runId']);
  refusal(() => resolveRunProvenance(null, instance), 'PROVENANCE_UNRESOLVED', EXIT.REFUSAL);
  const noInstance = refusal(() => resolveRunProvenance(boot, null), 'PROVENANCE_UNRESOLVED', EXIT.REFUSAL);
  assert.equal(noInstance.detail.field, 'instance');
});

test('artifact slugs and theme id parameters stay filesystem- and comparison-safe', () => {
  assert.equal(slugify('collection brand/v2'), 'collection-brand-v2');
  assert.equal(slugify('  home  '), 'home');
  assert.equal(slugify('***'), 'surface');
  assert.equal(themeIdFromParameter('1001512581'), 1001512581);
  assert.equal(themeIdFromParameter('-1'), -1);
  assert.equal(themeIdFromParameter('abc'), 'abc');
});

test('the served theme is read from the document, not from the requested parameter', () => {
  const copy = '<link href="https://cdn.hstatic.net/themes/200001207485/1001512581/theme.css"><img src="//cdn.hstatic.net/themes/200001207485/1001512581/x.png">';
  // An unknown id answers 200 while serving the live theme; the assets are the only proof.
  const substituted = '<link href="https://cdn.hstatic.net/themes/200001207485/1001510509/theme.css"><img src="//cdn.hstatic.net/themes/200001207485/1001510509/x.png">';
  const matching = checkServedTheme(copy, 1001512581);
  assert.equal(matching.refusal, null);
  assert.deepEqual(matching.ids.map((i) => i.themeId), [1001512581]);
  assert.equal(matching.ids[0].occurrences, 2);
  const caught = checkServedTheme(substituted, 1001512581);
  assert.equal(caught.refusal.code, 'SERVED_THEME_MISMATCH');
  assert.equal(caught.refusal.exitCode, EXIT.REFUSAL);
  assert.equal(caught.refusal.detail.requestedThemeId, 1001512581);
  // A few foreign urls inside an otherwise-correct theme are a finding, not a substitution.
  const majority = checkServedTheme(copy + copy + substituted, 1001512581);
  assert.equal(majority.refusal, null);
  assert.deepEqual(majority.ids.map((i) => i.themeId), [1001512581, 1001510509]);
  // The live preview has no id to compare against, and a document with no theme assets
  // cannot be adjudicated either way - both are recorded without a refusal.
  assert.equal(checkServedTheme(substituted, -1).refusal, null);
  assert.equal(checkServedTheme(substituted, null).refusal, null);
  assert.equal(checkServedTheme('<html></html>', 1001512581).refusal, null);
  assert.equal(checkServedTheme('<html></html>', 1001512581).ids.length, 0);
});
