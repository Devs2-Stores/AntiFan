import { after, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  listPromotedBaselineIds,
  originOfUrl,
  summarizeBaselineIds,
  GREENFIELD_BASELINE_ID_LIMIT,
} from '../../src/main/tools/browser-capabilities';
import type { BrowserControlPort } from '../../src/main/tools/browser-control-port';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-greenfield-scope-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const WORKSPACE = 'workspace-1';

/** Only the baseline store seam `listPromotedBaselineIds` reads; the rest of the port is irrelevant to it. */
const portOver = (dir: string): BrowserControlPort => {
  const port = { baselineAuthority: { getBaselineDir: () => dir } };
  return port as unknown as BrowserControlPort;
};

const freshStore = (): string => fs.mkdtempSync(path.join(root, 'store-'));

const writeBaseline = (dir: string, id: string, manifest: Record<string, unknown>): void => {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, workspaceId: WORKSPACE, ...manifest }), 'utf8');
};

const observedAt = (url: string) => ({ captureStateMini: { observedUrl: url } });

describe('greenfield baseline scope', () => {
  it('a baseline recorded for another origin does not block a greenfield run on this origin', () => {
    const dir = freshStore();
    writeBaseline(dir, 'vbase_a1', observedAt('https://shop-a.example.com/products/x'));
    const forB = listPromotedBaselineIds(portOver(dir), { workspaceId: WORKSPACE, origin: originOfUrl('https://shop-b.example.com/') });
    assert.deepEqual(forB, []);
  });

  it('a baseline recorded for the same origin still blocks, whatever the path', () => {
    const dir = freshStore();
    writeBaseline(dir, 'vbase_a1', observedAt('https://shop-a.example.com/products/x'));
    const forA = listPromotedBaselineIds(portOver(dir), { workspaceId: WORKSPACE, origin: originOfUrl('https://shop-a.example.com/collections/all') });
    assert.deepEqual(forA, ['vbase_a1']);
  });

  it('a baseline with no recorded origin could be for any origin and keeps blocking', () => {
    const dir = freshStore();
    writeBaseline(dir, 'vbase_legacy', {});
    writeBaseline(dir, 'vbase_blank', observedAt('about:blank'));
    const forB = listPromotedBaselineIds(portOver(dir), { workspaceId: WORKSPACE, origin: 'https://shop-b.example.com' });
    assert.deepEqual(forB, ['vbase_blank', 'vbase_legacy']);
  });

  it('without a known origin the whole workspace is checked, as before', () => {
    const dir = freshStore();
    writeBaseline(dir, 'vbase_a1', observedAt('https://shop-a.example.com/'));
    assert.deepEqual(listPromotedBaselineIds(portOver(dir), { workspaceId: WORKSPACE, origin: null }), ['vbase_a1']);
    assert.deepEqual(listPromotedBaselineIds(portOver(dir), { workspaceId: WORKSPACE }), ['vbase_a1']);
  });

  it('an unreadable manifest is never read as absence', () => {
    const dir = freshStore();
    fs.writeFileSync(path.join(dir, 'vbase_broken.json'), '{not json', 'utf8');
    assert.deepEqual(listPromotedBaselineIds(portOver(dir), { workspaceId: WORKSPACE, origin: 'https://shop-b.example.com' }), ['vbase_broken']);
  });

  it('a baseline of another workspace never counts', () => {
    const dir = freshStore();
    writeBaseline(dir, 'vbase_other', { workspaceId: 'workspace-2', ...observedAt('https://shop-a.example.com/') });
    assert.deepEqual(listPromotedBaselineIds(portOver(dir), { workspaceId: WORKSPACE, origin: 'https://shop-a.example.com' }), []);
  });

  it('originOfUrl gives the origin of a page and nothing for an opaque or missing URL', () => {
    assert.equal(originOfUrl('https://shop-a.example.com/a?b=1#c'), 'https://shop-a.example.com');
    assert.equal(originOfUrl('about:blank'), null);
    assert.equal(originOfUrl('not a url'), null);
    assert.equal(originOfUrl(''), null);
    assert.equal(originOfUrl(undefined), null);
  });

  it('a refusal lists at most three baseline ids and carries the total', () => {
    const ids = ['vbase_1', 'vbase_2', 'vbase_3', 'vbase_4', 'vbase_5'];
    const summary = summarizeBaselineIds(ids);
    assert.equal(GREENFIELD_BASELINE_ID_LIMIT, 3);
    assert.deepEqual(summary.baselineIds, ['vbase_1', 'vbase_2', 'vbase_3']);
    assert.equal(summary.total, 5);
    assert.ok(summary.listed.includes('2 more'));
    assert.ok(!summary.listed.includes('vbase_4'));
    const few = summarizeBaselineIds(['vbase_1']);
    assert.deepEqual(few.baselineIds, ['vbase_1']);
    assert.equal(few.total, 1);
    assert.equal(few.listed, 'vbase_1');
  });
});
