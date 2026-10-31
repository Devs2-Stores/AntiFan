import { after, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  COMPARE_RECEIPT_MAX_PER_WORKSPACE,
  mintCompareReceipt,
  readCompareReceipt,
  type CompareReceiptInput,
} from '../../src/main/qa/compare-receipt-store';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-compare-receipts-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const input = (overrides: Partial<CompareReceiptInput> = {}): CompareReceiptInput => ({
  workspaceId: 'workspace-a',
  projectId: 'project-a',
  origin: 'https://store.example.com',
  url: 'https://store.example.com/',
  pathname: '/',
  tabId: 'tab-1',
  paneId: 'desktop',
  comparisonKind: 'baseline',
  baselineRef: 'vbase_abc',
  viewport: { width: 1440, height: 900 },
  fullPage: false,
  clipped: false,
  selector: null,
  maskedAreaRatio: 0,
  mismatchPercentage: 0.4,
  match: true,
  tolerancePercent: 1,
  settleComplete: true,
  ...overrides,
});

const fileFor = (workspaceId: string, id: string): string => path.join(root, workspaceId, 'compares', `${id}.json`);

describe('compare receipt store', () => {
  it('mints a record the same workspace can read back unchanged', () => {
    const record = mintCompareReceipt(input(), { root });
    assert.match(record.id, /^vcmp_\d+_[0-9a-f]{12}$/);
    assert.match(record.bodySha256, /^[0-9a-f]{64}$/);
    const read = readCompareReceipt(record.id, { workspaceId: 'workspace-a', root });
    assert.deepStrictEqual(read, record);
    assert.strictEqual(read?.mismatchPercentage, 0.4);
    assert.strictEqual(read?.match, true);
  });

  it('stamps createdAt from the injected clock so age checks are deterministic', () => {
    const record = mintCompareReceipt(input(), { root, now: () => Date.UTC(2026, 9, 31, 12, 0, 0) });
    assert.strictEqual(record.createdAt, '2026-10-31T12:00:00.000Z');
    assert.ok(record.id.startsWith(`vcmp_${Date.UTC(2026, 9, 31, 12, 0, 0)}_`));
  });

  it('returns null for a record that does not exist', () => {
    assert.strictEqual(readCompareReceipt('vcmp_1790000000000_aaaaaaaaaaaa', { workspaceId: 'workspace-a', root }), null);
  });

  it('returns null for ids that are not receipt ids, including path traversal', () => {
    for (const id of ['', 'vbase_abc', '../workspace-a/compares/x', 'vcmp_../../etc_aaaaaaaaaaaa', 'vcmp_1_zzzzzzzzzzzz']) {
      assert.strictEqual(readCompareReceipt(id, { workspaceId: 'workspace-a', root }), null, id);
    }
  });

  it('refuses a receipt minted for another workspace', () => {
    const record = mintCompareReceipt(input({ workspaceId: 'workspace-a' }), { root });
    assert.strictEqual(readCompareReceipt(record.id, { workspaceId: 'workspace-b', root }), null);
  });

  it('refuses a receipt copied into another workspace folder', () => {
    const record = mintCompareReceipt(input({ workspaceId: 'workspace-a' }), { root });
    fs.mkdirSync(path.join(root, 'workspace-c', 'compares'), { recursive: true });
    fs.copyFileSync(fileFor('workspace-a', record.id), fileFor('workspace-c', record.id));
    assert.strictEqual(readCompareReceipt(record.id, { workspaceId: 'workspace-c', root }), null);
  });

  it('refuses a record whose numbers were edited after minting', () => {
    const record = mintCompareReceipt(input({ mismatchPercentage: 7.5, match: false }), { root });
    const file = fileFor('workspace-a', record.id);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    stored.mismatchPercentage = 0;
    stored.match = true;
    fs.writeFileSync(file, JSON.stringify(stored), 'utf8');
    assert.strictEqual(readCompareReceipt(record.id, { workspaceId: 'workspace-a', root }), null);
  });

  it('refuses a record whose viewport or origin was edited after minting', () => {
    const record = mintCompareReceipt(input(), { root });
    const file = fileFor('workspace-a', record.id);
    const original = fs.readFileSync(file, 'utf8');
    const stored = JSON.parse(original) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...stored, viewport: { width: 320, height: 568 } }), 'utf8');
    assert.strictEqual(readCompareReceipt(record.id, { workspaceId: 'workspace-a', root }), null);
    fs.writeFileSync(file, JSON.stringify({ ...stored, origin: 'https://other.example.com' }), 'utf8');
    assert.strictEqual(readCompareReceipt(record.id, { workspaceId: 'workspace-a', root }), null);
    fs.writeFileSync(file, original, 'utf8');
    assert.ok(readCompareReceipt(record.id, { workspaceId: 'workspace-a', root }), 'the untouched record reads again');
  });

  it('refuses a hand-written record that carries a plausible hash of the wrong body', () => {
    const record = mintCompareReceipt(input(), { root });
    const forgedId = 'vcmp_1790000000001_bbbbbbbbbbbb';
    fs.writeFileSync(fileFor('workspace-a', forgedId), JSON.stringify({ ...record, id: forgedId }), 'utf8');
    assert.strictEqual(readCompareReceipt(forgedId, { workspaceId: 'workspace-a', root }), null);
  });

  it('refuses unparseable and truncated files', () => {
    const record = mintCompareReceipt(input(), { root });
    const file = fileFor('workspace-a', record.id);
    fs.writeFileSync(file, '{"id":', 'utf8');
    assert.strictEqual(readCompareReceipt(record.id, { workspaceId: 'workspace-a', root }), null);
  });

  it('rejects invalid input instead of storing it', () => {
    assert.throws(() => mintCompareReceipt(input({ mismatchPercentage: Number.NaN }), { root }));
    assert.throws(() => mintCompareReceipt(input({ mismatchPercentage: -1 }), { root }));
    assert.throws(() => mintCompareReceipt(input({ workspaceId: '../escape' }), { root }));
    assert.throws(() => mintCompareReceipt(input({ viewport: { width: 0, height: 900 } }), { root }));
    assert.throws(() => mintCompareReceipt(input({ comparisonKind: 'other' as unknown as 'baseline' }), { root }));
  });

  it('keeps a missing viewport as null so the resolver can refuse it by name', () => {
    const record = mintCompareReceipt(input({ viewport: null }), { root });
    assert.strictEqual(readCompareReceipt(record.id, { workspaceId: 'workspace-a', root })?.viewport, null);
  });

  it('binds the compared scope: a stored pathname, pane, scope or mask ratio cannot be edited afterwards', () => {
    const record = mintCompareReceipt(input({ pathname: '/products/demo', paneId: 'mobile', fullPage: true, selector: '.hero', maskedAreaRatio: 0.02 }), { root });
    const file = fileFor('workspace-a', record.id);
    const original = fs.readFileSync(file, 'utf8');
    const stored = JSON.parse(original) as Record<string, unknown>;
    assert.strictEqual(stored.pathname, '/products/demo');
    assert.strictEqual(stored.paneId, 'mobile');
    assert.strictEqual(stored.fullPage, true);
    assert.strictEqual(stored.selector, '.hero');
    for (const edit of [{ pathname: '/' }, { paneId: 'desktop' }, { fullPage: false }, { clipped: true }, { selector: null }, { maskedAreaRatio: 0 }]) {
      fs.writeFileSync(file, JSON.stringify({ ...stored, ...edit }), 'utf8');
      assert.strictEqual(readCompareReceipt(record.id, { workspaceId: 'workspace-a', root }), null, JSON.stringify(edit));
    }
    fs.writeFileSync(file, original, 'utf8');
    assert.ok(readCompareReceipt(record.id, { workspaceId: 'workspace-a', root }));
  });

  it('refuses a record minted before the compared scope was recorded', () => {
    const record = mintCompareReceipt(input(), { root });
    const file = fileFor('workspace-a', record.id);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const key of ['pathname', 'paneId', 'fullPage', 'clipped', 'selector', 'maskedAreaRatio']) delete stored[key];
    fs.writeFileSync(file, JSON.stringify(stored), 'utf8');
    assert.strictEqual(readCompareReceipt(record.id, { workspaceId: 'workspace-a', root }), null);
  });

  it('rejects a mask ratio outside 0..1 and an unknown pane', () => {
    assert.throws(() => mintCompareReceipt(input({ maskedAreaRatio: 1.5 }), { root }));
    assert.throws(() => mintCompareReceipt(input({ paneId: 'tablet' as unknown as 'desktop' }), { root }));
  });

  it('prunes the oldest records beyond the per-workspace cap', () => {
    const cappedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-compare-prune-'));
    try {
      const ids: string[] = [];
      for (let i = 0; i < COMPARE_RECEIPT_MAX_PER_WORKSPACE + 3; i++) {
        const record = mintCompareReceipt(input({ workspaceId: 'workspace-p' }), { root: cappedRoot, now: () => Date.now() });
        ids.push(record.id);
        const file = path.join(cappedRoot, 'workspace-p', 'compares', `${record.id}.json`);
        const stamp = new Date(Date.now() - (COMPARE_RECEIPT_MAX_PER_WORKSPACE + 3 - i) * 1000);
        fs.utimesSync(file, stamp, stamp);
      }
      const remaining = fs.readdirSync(path.join(cappedRoot, 'workspace-p', 'compares')).filter((name) => name.endsWith('.json'));
      assert.ok(remaining.length <= COMPARE_RECEIPT_MAX_PER_WORKSPACE, `kept ${remaining.length}`);
      const [oldest] = ids;
      const newest = ids.at(-1);
      assert.ok(oldest && newest, 'ids were minted');
      assert.strictEqual(readCompareReceipt(oldest, { workspaceId: 'workspace-p', root: cappedRoot }), null, 'the oldest is pruned');
      assert.ok(readCompareReceipt(newest, { workspaceId: 'workspace-p', root: cappedRoot }), 'the newest survives');
    } finally {
      fs.rmSync(cappedRoot, { recursive: true, force: true });
    }
  });
});
