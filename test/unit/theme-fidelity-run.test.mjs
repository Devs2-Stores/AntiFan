import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Refusal } from '../../.canary/tools/theme-fidelity.mjs';
import {
  ALLOWED_THEME_IDS,
  COPY_THEME_ID,
  EXIT,
  LIVE_PREVIEW_THEME_ID,
  STAGES,
  auditCommands,
  buildCommandRecord,
  deriveInventories,
  parseArgs,
  parseChildRefusal,
  parseCommandRecords,
  probeTargetOf,
  refusalFromCaptureIndex,
  themeIdsFromInventory,
  validateUnresolved,
  withThemeId,
} from '../../.canary/tools/theme-fidelity-run.mjs';

const refusalOf = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof Refusal, `expected a typed Refusal, got ${e}`);
    return e;
  }
  throw new Error('expected the call to refuse');
};

const INVENTORY = {
  store: 'https://phukienmaymoc.com/',
  livePreviewBase: 'https://phukienmaymoc.com/?themeid=-1&view=',
  copyPreviewBase: 'https://phukienmaymoc.com/?themeid=1001512581&view=',
  surfaces: [
    { name: 'home', url: 'https://phukienmaymoc.com/', source: 'storefront-html' },
    { name: 'search', url: 'https://phukienmaymoc.com/search?q=laser', source: 'storefront-html' },
    { name: '404', url: 'https://phukienmaymoc.com/khong-ton-tai-404-probe-xyz', source: 'constructed' },
  ],
  views: [
    { name: 'll-index-marquee', template: 'templates/index.ll-index-marquee.liquid', url: 'https://phukienmaymoc.com/?themeid=1001512581&view=ll-index-marquee' },
  ],
  unresolved: [{ name: 'member', reason: 'auth-gated' }],
};

describe('stage parsing', () => {
  it('lists the seven stages in pipeline order', () => {
    assert.deepEqual(STAGES, ['preflight', 'references', 'serve', 'subject', 'compare', 'checks', 'report']);
  });

  it('treats --help as a no-argument help request', () => {
    assert.deepEqual(parseArgs(['--help']), { stage: 'help', options: {} });
    assert.deepEqual(parseArgs(['help']), { stage: 'help', options: {} });
  });

  it('refuses an unknown stage with exit 2', () => {
    const refusal = refusalOf(() => parseArgs(['fidelity']));
    assert.equal(refusal.code, 'STAGE_UNKNOWN');
    assert.equal(refusal.exitCode, EXIT.USAGE);
  });

  it('refuses a missing required flag, naming it', () => {
    const refusal = refusalOf(() => parseArgs(['preflight', '--out', 'x', '--theme', 't']));
    assert.equal(refusal.code, 'ARG_REQUIRED_MISSING');
    assert.equal(refusal.exitCode, EXIT.USAGE);
    assert.match(refusal.message, /--inventory/);
  });

  it('refuses an unknown, duplicated or valueless flag', () => {
    assert.equal(refusalOf(() => parseArgs(['compare', '--out', 'x', '--viewports', '1440x900'])).code, 'ARG_UNKNOWN');
    assert.equal(refusalOf(() => parseArgs(['compare', '--out', 'x', '--out', 'y'])).code, 'ARG_DUPLICATE');
    assert.equal(refusalOf(() => parseArgs(['compare', '--out'])).code, 'ARG_VALUE_MISSING');
    assert.equal(refusalOf(() => parseArgs(['compare', 'x'])).code, 'ARG_UNEXPECTED');
  });

  it('accepts --flag=value and validates the viewport spec', () => {
    const parsed = parseArgs(['subject', '--out=run', '--viewports=1440x900,390x844']);
    assert.equal(parsed.stage, 'subject');
    assert.equal(parsed.options.out, 'run');
    assert.deepEqual(parsed.options.viewportList.map((v) => v.label), ['1440x900', '390x844']);
    assert.equal(parsed.options.viewportList[1].mobile, true);
    const refusal = refusalOf(() => parseArgs(['subject', '--out', 'run', '--viewports', 'wide']));
    assert.equal(refusal.code, 'VIEWPORT_SPEC_INVALID');
    assert.equal(refusal.exitCode, EXIT.USAGE);
  });

  it('does not accept a flag that belongs to another stage', () => {
    const refusal = refusalOf(() => parseArgs(['report', '--out', 'run', '--theme', 'E:/work']));
    assert.equal(refusal.code, 'ARG_UNKNOWN');
  });
});

describe('preview URL derivation', () => {
  it('joins the themeid parameter onto an existing query instead of clobbering it', () => {
    assert.equal(
      withThemeId('https://phukienmaymoc.com/search?q=laser', COPY_THEME_ID),
      `https://phukienmaymoc.com/search?q=laser&themeid=${COPY_THEME_ID}`,
    );
    assert.equal(withThemeId('https://phukienmaymoc.com/', LIVE_PREVIEW_THEME_ID), `https://phukienmaymoc.com/?themeid=${LIVE_PREVIEW_THEME_ID}`);
  });

  it('replaces a themeid the inventory already carries and preserves the rest', () => {
    assert.equal(
      withThemeId('https://phukienmaymoc.com/?themeid=1001512581&view=ll-index-marquee', LIVE_PREVIEW_THEME_ID),
      `https://phukienmaymoc.com/?themeid=${LIVE_PREVIEW_THEME_ID}&view=ll-index-marquee`,
    );
  });

  it('collects every themeid an inventory declares, including the preview bases', () => {
    assert.deepEqual(themeIdsFromInventory(INVENTORY), ['-1', '1001512581']);
  });

  it('derives copy, live and subject URLs for every surface and view', () => {
    const derived = deriveInventories(INVENTORY, { source: { file: 'inv.json', sha256: 'abc' } });
    assert.deepEqual(Object.keys(derived.documents), ['copy', 'live', 'subject']);
    assert.equal(derived.targets.length, 4);
    const search = derived.targets.find((t) => t.name === 'search');
    assert.equal(search.urls.copy, `https://phukienmaymoc.com/search?q=laser&themeid=${COPY_THEME_ID}`);
    assert.equal(search.urls.live, `https://phukienmaymoc.com/search?q=laser&themeid=${LIVE_PREVIEW_THEME_ID}`);
    assert.equal(search.urls.subject, search.urls.copy);
    assert.equal(search.sourceUrl, 'https://phukienmaymoc.com/search?q=laser');
    const view = derived.documents.subject.views[0];
    assert.equal(view.url, `https://phukienmaymoc.com/?themeid=${COPY_THEME_ID}&view=ll-index-marquee`);
    assert.equal(view.template, 'templates/index.ll-index-marquee.liquid');
    assert.equal(derived.documents.copy.derivedFrom.sha256, 'abc');
    assert.equal(derived.documents.copy.kind, 'theme-fidelity-run-inventory');
    assert.equal(derived.documents.live.themeId, LIVE_PREVIEW_THEME_ID);
  });

  it('probes the home surface when the inventory has one', () => {
    const derived = deriveInventories(INVENTORY);
    assert.equal(probeTargetOf(derived).name, 'home');
  });
});

describe('inventory unresolved section', () => {
  it('refuses an inventory without the unresolved array the report needs', () => {
    const refusal = refusalOf(() => validateUnresolved({ store: 'x' }, 'inv.json'));
    assert.equal(refusal.code, 'INVENTORY_FIELD_MISSING');
    assert.equal(refusal.exitCode, EXIT.USAGE);
    assert.match(refusal.message, /unresolved/);
  });

  it('refuses an unresolved entry without a reason', () => {
    const refusal = refusalOf(() => validateUnresolved({ unresolved: [{ name: 'member' }] }, 'inv.json'));
    assert.match(refusal.message, /unresolved\[0\]\.reason/);
  });

  it('normalizes a valid unresolved list', () => {
    assert.deepEqual(validateUnresolved({ unresolved: [{ name: ' member ', reason: ' auth ' }] }, 'inv.json'), [{ name: 'member', reason: 'auth' }]);
  });
});

describe('command record and safety audit', () => {
  const record = (overrides = {}) => buildCommandRecord({
    stage: 'references',
    argv: ['references', '--out', 'run'],
    commands: [['node', 'theme-fidelity.mjs', 'capture']],
    spawned: true,
    themeIds: [COPY_THEME_ID, LIVE_PREVIEW_THEME_ID, COPY_THEME_ID],
    readOnlyLivePreviews: ['https://phukienmaymoc.com/?themeid=-1'],
    readOnlyCopyPreviews: ['https://phukienmaymoc.com/?themeid=1001512581'],
    startedAt: '2026-09-11T00:00:00.000Z',
    finishedAt: '2026-09-11T00:00:02.500Z',
    ...overrides,
  });

  it('builds one deterministic record shape with deduplicated sorted theme ids', () => {
    const built = record();
    assert.equal(built.kind, 'theme-fidelity-run-command');
    assert.deepEqual(built.themeIds, ['-1', COPY_THEME_ID]);
    assert.equal(built.durationMs, 2500);
    assert.deepEqual(built.commands, [['node', 'theme-fidelity.mjs', 'capture']]);
    assert.equal(built.exitCode, EXIT.OK);
    assert.equal(built.refusal, null);
  });

  it('copies the command arrays so a later mutation cannot rewrite the record', () => {
    const commands = [['node', 'tool']];
    const built = buildCommandRecord({ stage: 'checks', commands });
    commands[0].push('--mutated');
    commands.push(['node', 'other']);
    assert.deepEqual(built.commands, [['node', 'tool']]);
  });

  it('passes a record whose commands only address the copy and the live preview', () => {
    const audit = auditCommands([record(), record({ stage: 'preflight', commands: [], themeIds: [COPY_THEME_ID] })]);
    assert.equal(audit.commands, 2);
    assert.equal(audit.pass, true);
    assert.equal(audit.foreignThemeIds.count, 0);
    assert.equal(audit.publishDeployPush.absent, true);
    assert.deepEqual(audit.allowedThemeIds, [...ALLOWED_THEME_IDS].sort());
    assert.deepEqual(audit.livePreviewReads, ['https://phukienmaymoc.com/?themeid=-1']);
    assert.equal(audit.remoteWrites.length, 0);
  });

  it('fails the audit and names the command when a theme outside -1 or the copy was addressed', () => {
    const audit = auditCommands([record({ stage: 'serve', themeIds: [COPY_THEME_ID, '1001510509'], writeTargets: [COPY_THEME_ID] })]);
    assert.equal(audit.pass, false);
    assert.equal(audit.foreignThemeIds.count, 1);
    assert.deepEqual(audit.foreignThemeIds.entries[0].foreignThemeIds, ['1001510509']);
    assert.equal(audit.remoteWrites.length, 1);
    assert.deepEqual(audit.remoteWrites[0].writeTargets, [COPY_THEME_ID]);
  });

  it('fails the audit when a publish, deploy or push command appears in the record', () => {
    const audit = auditCommands([record({ stage: 'references', commands: [['node', 'hrv', 'theme', 'push']] })]);
    assert.equal(audit.pass, false);
    assert.equal(audit.publishDeployPush.absent, false);
    assert.ok(audit.publishDeployPush.matches.some((m) => m.token === 'push'));
  });

  it('refuses a malformed command log line with exit 4', () => {
    const refusal = refusalOf(() => parseCommandRecords('{"stage":"preflight"}\nnot json\n', 'commands.jsonl'));
    assert.equal(refusal.code, 'COMMAND_LOG_UNREADABLE');
    assert.equal(refusal.exitCode, EXIT.REFUSAL);
    assert.match(refusal.message, /line 2/);
  });

  it('carries a composed tool\'s own exit code and typed refusal text verbatim', () => {
    const fromIndex = parseChildRefusal('', { code: 'THEME_ID_NOT_ALLOWED', exitCode: 4, message: 'url carries themeid=999' });
    assert.deepEqual(fromIndex, { code: 'THEME_ID_NOT_ALLOWED', exitCode: 4, message: 'url carries themeid=999' });
    const fromStderr = parseChildRefusal('noise\n[theme-fidelity] REFUSED ARTIFACT_DIGEST_MISMATCH (exit 4): reference dom artifact hashes to a, not the pinned b\nmore noise\n', null);
    assert.deepEqual(fromStderr, { code: 'ARTIFACT_DIGEST_MISMATCH', exitCode: 4, message: 'reference dom artifact hashes to a, not the pinned b' });
    assert.equal(parseChildRefusal('capture failed with no typed text', null), null);
  });

  it('parses every well-formed command log line', () => {
    const records = parseCommandRecords(`${JSON.stringify({ stage: 'preflight' })}\n\n${JSON.stringify({ stage: 'report' })}\n`, 'commands.jsonl');
    assert.deepEqual(records.map((r) => r.stage), ['preflight', 'report']);
  });
});

describe('a capture that measured the legs it could and could not measure the rest', () => {
  const index = (overrides = {}) => ({
    kind: 'theme-fidelity-capture-index',
    label: 'r1-copy',
    status: 'INCOMPLETE',
    refusal: null,
    totals: { requested: 21, documents: 21, captured: 14, notMeasurable: 7 },
    targets: [
      { surface: 'home', viewport: '1440x900', status: 'CAPTURED', failure: null },
      { surface: 'product', viewport: '1440x900', status: 'NOT_MEASURABLE', failure: { code: 'FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY', reason: 'Requested full-page capture region 1440x17229 CSS px is outside the supported 1..16384 range' } },
    ],
    ...overrides,
  });

  it('names the failure the index recorded instead of reporting no typed text', () => {
    const derived = refusalFromCaptureIndex(index());
    assert.equal(derived.code, 'FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY');
    assert.equal(derived.exitCode, EXIT.NOT_MEASURABLE);
    assert.match(derived.message, /INCOMPLETE: 14\/21 captured, 1 not measurable/);
    assert.match(derived.message, /product 1440x900/);
    assert.match(derived.message, /16384/);
    assert.deepEqual(derived.failures.map((f) => f.surface), ['product']);
  });

  it('summarises the set rather than picking one when the legs failed differently', () => {
    const derived = refusalFromCaptureIndex(index({
      targets: [
        { surface: 'home', viewport: '1440x900', status: 'NOT_MEASURABLE', failure: { code: 'FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY', reason: 'too tall' } },
        { surface: 'home', viewport: '390x844', status: 'NOT_MEASURABLE', failure: { code: 'CAPTURE_NOT_MEASURABLE', reason: 'no document' } },
      ],
    }));
    assert.equal(derived.code, 'CAPTURE_INCOMPLETE');
    assert.match(derived.message, /FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY, CAPTURE_NOT_MEASURABLE/);
  });

  it('leaves a complete capture and a refused capture to their own paths', () => {
    assert.equal(refusalFromCaptureIndex(index({ status: 'COMPLETE', targets: [] })), null);
    assert.equal(refusalFromCaptureIndex(index({ status: 'REFUSED', refusal: { code: 'THEME_ID_NOT_ALLOWED' } })), null);
    assert.equal(refusalFromCaptureIndex(null), null);
  });

  it('never invents a reason an incomplete index did not record', () => {
    assert.equal(refusalFromCaptureIndex(index({ targets: [{ surface: 'home', viewport: '1440x900', status: 'CAPTURED' }] })), null);
  });
});
