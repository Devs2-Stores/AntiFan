import { after, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { COMPARE_DEFAULT_TOLERANCE_PERCENT, mintCompareReceipt, type CompareReceiptInput } from '../../src/main/qa/compare-receipt-store';
import {
  BASELINE_MAX_MASKED_AREA_RATIO,
  BASELINE_RECEIPT_TTL_MS,
  parseBaselineViewportsInput,
  resolveBaselineViewports,
  viewportNameForWidth,
} from '../../src/main/qa/baseline-provenance';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-baseline-provenance-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ORIGIN = 'https://store.example.com';
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

const mint = (overrides: Partial<CompareReceiptInput> = {}, at: number = NOW) =>
  mintCompareReceipt(
    {
      workspaceId: 'workspace-a',
      origin: ORIGIN,
      url: `${ORIGIN}/`,
      pathname: '/',
      paneId: 'desktop',
      fullPage: false,
      clipped: false,
      selector: null,
      maskedAreaRatio: null,
      tolerancePercent: 1,
      comparisonKind: 'baseline',
      viewport: { width: 1440, height: 900 },
      mismatchPercentage: 0.3,
      match: true,
      settleComplete: true,
      ...overrides,
    },
    { root, now: () => at }
  );

const resolve = (input: Parameters<typeof resolveBaselineViewports>[0], origin: string | null = ORIGIN, pathname: string | null = '/') =>
  resolveBaselineViewports(input, { workspaceId: 'workspace-a', origin, pathname, now: NOW + 60_000, root });

describe('parseBaselineViewportsInput', () => {
  it('accepts receipt ids and legacy numbers per viewport', () => {
    const parsed = parseBaselineViewportsInput(
      { desktop: { compareReceiptId: ' vcmp_1_aaaaaaaaaaaa ' }, mobile: { mismatchPercent: 1, passed: true } },
      'baselineViewports'
    );
    assert.deepStrictEqual(parsed, { desktop: { compareReceiptId: 'vcmp_1_aaaaaaaaaaaa' }, mobile: { mismatchPercent: 1, passed: true } });
  });

  it('returns undefined for an absent value', () => {
    assert.strictEqual(parseBaselineViewportsInput(undefined, 'baselineViewports'), undefined);
  });

  it('prefers the receipt id when an entry carries both', () => {
    const parsed = parseBaselineViewportsInput({ desktop: { compareReceiptId: 'vcmp_1_aaaaaaaaaaaa', mismatchPercent: 0, passed: true } }, 'x');
    assert.deepStrictEqual(parsed, { desktop: { compareReceiptId: 'vcmp_1_aaaaaaaaaaaa' } });
  });

  it('refuses bad shapes with INVALID_ARGUMENT naming the label', () => {
    const bad: unknown[] = [
      null,
      [],
      'desktop',
      { watch: { mismatchPercent: 0, passed: true } },
      { desktop: null },
      { desktop: { passed: true } },
      { desktop: { mismatchPercent: '1', passed: true } },
      { desktop: { mismatchPercent: Number.NaN, passed: true } },
      { desktop: { mismatchPercent: 1, passed: 'yes' } },
      { desktop: { compareReceiptId: '' } },
      { desktop: { compareReceiptId: 7 } },
    ];
    for (const value of bad) {
      assert.throws(
        () => parseBaselineViewportsInput(value, 'baselineViewports'),
        (error: unknown) => error instanceof CapabilityError && error.code === 'INVALID_ARGUMENT' && error.message.includes('baselineViewports'),
        JSON.stringify(value)
      );
    }
  });
});

describe('viewportNameForWidth', () => {
  it('maps widths to the standard band: below 768 mobile, 768 to 1100 tablet, above desktop', () => {
    assert.strictEqual(viewportNameForWidth(320), 'mobile');
    assert.strictEqual(viewportNameForWidth(767), 'mobile');
    assert.strictEqual(viewportNameForWidth(768), 'tablet');
    assert.strictEqual(viewportNameForWidth(1024), 'tablet');
    assert.strictEqual(viewportNameForWidth(1100), 'tablet');
    assert.strictEqual(viewportNameForWidth(1101), 'desktop');
    assert.strictEqual(viewportNameForWidth(1440), 'desktop');
  });
});

describe('resolveBaselineViewports', () => {
  it('reads the numbers from the ledger record, never from the caller', () => {
    const record = mint({ mismatchPercentage: 2.5, match: false });
    const resolved = resolve({ desktop: { compareReceiptId: record.id } });
    assert.deepStrictEqual(resolved.viewports, { desktop: { mismatchPercent: 2.5, passed: false } });
    assert.deepStrictEqual(resolved.provenance, { desktop: 'compare-receipt' });
    assert.deepStrictEqual(resolved.rejections, []);
  });

  it('resolves all three bands from their own receipts', () => {
    const desktop = mint({ viewport: { width: 1440, height: 900 } });
    const tablet = mint({ viewport: { width: 768, height: 1024 } });
    const mobile = mint({ viewport: { width: 375, height: 667 } });
    const resolved = resolve({ desktop: { compareReceiptId: desktop.id }, tablet: { compareReceiptId: tablet.id }, mobile: { compareReceiptId: mobile.id } });
    assert.deepStrictEqual(resolved.provenance, { desktop: 'compare-receipt', tablet: 'compare-receipt', mobile: 'compare-receipt' });
    assert.deepStrictEqual(resolved.rejections, []);
  });

  it('labels legacy raw numbers caller-asserted and keeps them', () => {
    const resolved = resolve({ desktop: { mismatchPercent: 0.5, passed: true } });
    assert.deepStrictEqual(resolved.viewports, { desktop: { mismatchPercent: 0.5, passed: true } });
    assert.deepStrictEqual(resolved.provenance, { desktop: 'caller-asserted' });
    assert.deepStrictEqual(resolved.rejections, []);
  });

  it('returns an empty resolution for no input', () => {
    assert.deepStrictEqual(resolve(undefined), { provenance: {}, rejections: [] });
  });

  it('rejects a receipt id that is not in the ledger and leaves the viewport unmeasured', () => {
    const resolved = resolve({ desktop: { compareReceiptId: 'vcmp_1790000000000_cccccccccccc' } });
    assert.strictEqual(resolved.viewports, undefined);
    assert.deepStrictEqual(resolved.provenance, {});
    assert.strictEqual(resolved.rejections[0]?.code, 'RECEIPT_NOT_FOUND');
    assert.strictEqual(resolved.rejections[0]?.viewport, 'desktop');
  });

  it('rejects a receipt from another workspace as not found', () => {
    const foreign = mintCompareReceipt(
      { workspaceId: 'workspace-z', origin: ORIGIN, url: `${ORIGIN}/`, pathname: '/', paneId: 'desktop', fullPage: false, clipped: false, selector: null, maskedAreaRatio: null, comparisonKind: 'baseline', viewport: { width: 1440, height: 900 }, mismatchPercentage: 0, match: true, tolerancePercent: 1 },
      { root, now: () => NOW }
    );
    assert.strictEqual(resolve({ desktop: { compareReceiptId: foreign.id } }).rejections[0]?.code, 'RECEIPT_NOT_FOUND');
  });

  it('rejects a receipt measured on another origin', () => {
    const record = mint({ origin: 'https://other.example.com' });
    const resolved = resolve({ desktop: { compareReceiptId: record.id } });
    assert.strictEqual(resolved.rejections[0]?.code, 'ORIGIN_MISMATCH');
    assert.strictEqual(resolved.viewports, undefined);
  });

  it('rejects every receipt when the QA tab origin is unknown', () => {
    const record = mint();
    assert.strictEqual(resolve({ desktop: { compareReceiptId: record.id } }, null).rejections[0]?.code, 'ORIGIN_UNKNOWN');
  });

  it('rejects a receipt filed under the wrong width band', () => {
    const record = mint({ viewport: { width: 375, height: 667 } });
    const resolved = resolve({ desktop: { compareReceiptId: record.id } });
    assert.strictEqual(resolved.rejections[0]?.code, 'VIEWPORT_MISMATCH');
    assert.match(resolved.rejections[0]?.detail ?? '', /375px/);
    assert.match(resolved.rejections[0]?.detail ?? '', /mobile/);
  });

  it('rejects a receipt that recorded no viewport', () => {
    const record = mint({ viewport: null });
    assert.strictEqual(resolve({ desktop: { compareReceiptId: record.id } }).rejections[0]?.code, 'VIEWPORT_MISSING');
  });

  it('rejects a comparison between two live tabs as baseline evidence', () => {
    const record = mint({ comparisonKind: 'live-tab' });
    assert.strictEqual(resolve({ desktop: { compareReceiptId: record.id } }).rejections[0]?.code, 'NOT_A_BASELINE_COMPARE');
  });

  it('rejects a comparison captured before the page settled', () => {
    const record = mint({ settleComplete: false });
    assert.strictEqual(resolve({ desktop: { compareReceiptId: record.id } }).rejections[0]?.code, 'SETTLE_INCOMPLETE');
  });

  it('accepts a receipt whose settle state was not recorded', () => {
    const record = mint({ settleComplete: null });
    assert.deepStrictEqual(resolve({ desktop: { compareReceiptId: record.id } }).provenance, { desktop: 'compare-receipt' });
  });

  it('rejects a stale receipt and honours an explicit ttl', () => {
    const record = mint();
    const late = resolveBaselineViewports({ desktop: { compareReceiptId: record.id } }, { workspaceId: 'workspace-a', origin: ORIGIN, pathname: '/', now: NOW + BASELINE_RECEIPT_TTL_MS + 1000, root });
    assert.strictEqual(late.rejections[0]?.code, 'RECEIPT_STALE');
    const generous = resolveBaselineViewports(
      { desktop: { compareReceiptId: record.id } },
      { workspaceId: 'workspace-a', origin: ORIGIN, pathname: '/', now: NOW + BASELINE_RECEIPT_TTL_MS + 1000, ttlMs: BASELINE_RECEIPT_TTL_MS * 2, root }
    );
    assert.deepStrictEqual(generous.rejections, []);
  });

  it('rejects a receipt dated in the future beyond the clock skew', () => {
    const record = mint({}, NOW + 10 * 60_000);
    assert.strictEqual(resolve({ desktop: { compareReceiptId: record.id } }).rejections[0]?.code, 'RECEIPT_FROM_FUTURE');
  });

  it('judges each viewport independently: one bad receipt does not demote the others', () => {
    const good = mint({ viewport: { width: 1440, height: 900 } });
    const resolved = resolve({
      desktop: { compareReceiptId: good.id },
      tablet: { compareReceiptId: 'vcmp_1790000000000_dddddddddddd' },
      mobile: { mismatchPercent: 1, passed: true },
    });
    assert.deepStrictEqual(resolved.provenance, { desktop: 'compare-receipt', mobile: 'caller-asserted' });
    assert.deepStrictEqual(resolved.rejections.map((r) => [r.viewport, r.code]), [['tablet', 'RECEIPT_NOT_FOUND']]);
    assert.deepStrictEqual(Object.keys(resolved.viewports ?? {}).sort(), ['desktop', 'mobile']);
  });

  it('rejects a receipt taken on another route than the QA tab', () => {
    const record = mint({ pathname: '/collections/all' });
    const resolved = resolve({ desktop: { compareReceiptId: record.id } });
    assert.strictEqual(resolved.rejections[0]?.code, 'PATH_MISMATCH');
    assert.strictEqual(resolved.viewports, undefined);
  });

  it('accepts the same route and refuses a different product route', () => {
    const home = mint({ pathname: '/' });
    assert.deepStrictEqual(resolve({ desktop: { compareReceiptId: home.id } }, ORIGIN, '/').rejections, []);
    const product = mint({ pathname: '/products/demo' });
    assert.strictEqual(resolve({ desktop: { compareReceiptId: product.id } }, ORIGIN, '/products/other').rejections[0]?.code, 'PATH_MISMATCH');
  });

  it('refuses every receipt when the QA tab route or the recorded route is unknown', () => {
    const record = mint();
    assert.strictEqual(resolve({ desktop: { compareReceiptId: record.id } }, ORIGIN, null).rejections[0]?.code, 'PATH_UNKNOWN');
    const unrouted = mint({ pathname: null });
    assert.strictEqual(resolve({ desktop: { compareReceiptId: unrouted.id } }).rejections[0]?.code, 'PATH_UNKNOWN');
  });

  it('rejects a compare scoped to a clip rectangle or an element as whole-page evidence', () => {
    const clipped = mint({ clipped: true });
    assert.strictEqual(resolve({ desktop: { compareReceiptId: clipped.id } }).rejections[0]?.code, 'PARTIAL_COMPARE');
    const element = mint({ selector: '.hero' });
    assert.strictEqual(resolve({ desktop: { compareReceiptId: element.id } }).rejections[0]?.code, 'PARTIAL_COMPARE');
  });

  it('rejects a compare whose masks hid more than the allowed share of the page', () => {
    const heavy = mint({ maskedAreaRatio: BASELINE_MAX_MASKED_AREA_RATIO + 0.01 });
    assert.strictEqual(resolve({ desktop: { compareReceiptId: heavy.id } }).rejections[0]?.code, 'MASK_RATIO_TOO_HIGH');
    const light = mint({ maskedAreaRatio: BASELINE_MAX_MASKED_AREA_RATIO });
    assert.deepStrictEqual(resolve({ desktop: { compareReceiptId: light.id } }).rejections, []);
  });

  it('rejects a compare that used a looser tolerance than the default, or recorded none', () => {
    const loose = mint({ tolerancePercent: COMPARE_DEFAULT_TOLERANCE_PERCENT + 1 });
    assert.strictEqual(resolve({ desktop: { compareReceiptId: loose.id } }).rejections[0]?.code, 'TOLERANCE_TOO_LOOSE');
    const none = mint({ tolerancePercent: null });
    assert.strictEqual(resolve({ desktop: { compareReceiptId: none.id } }).rejections[0]?.code, 'TOLERANCE_TOO_LOOSE');
    const strict = mint({ tolerancePercent: 0.5 });
    assert.deepStrictEqual(resolve({ desktop: { compareReceiptId: strict.id } }).rejections, []);
  });

  it('rejects a mobile-pane compare as evidence for the desktop or tablet size', () => {
    const mobilePane = mint({ paneId: 'mobile', viewport: { width: 1440, height: 900 } });
    assert.strictEqual(resolve({ desktop: { compareReceiptId: mobilePane.id } }).rejections[0]?.code, 'PANE_MISMATCH');
    const mobileOk = mint({ paneId: 'mobile', viewport: { width: 375, height: 667 } });
    assert.deepStrictEqual(resolve({ mobile: { compareReceiptId: mobileOk.id } }).rejections, []);
  });
});
