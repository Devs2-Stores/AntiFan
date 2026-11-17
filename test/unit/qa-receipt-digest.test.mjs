import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { digestInputs, checkIntegrity, isStale, receiptBodySha256, RECEIPT_HASH_VERSION } = require('../../.compiled/src/main/qa/receipt-digest.js');
const compare = require('../../.compiled/src/main/qa/compare-receipt-store.js');

const sealed = (inputs, extra = {}) => {
  const rec = { id: 'VER-1', claim: 'header ok', actor: 'agent', scope: { tabId: 't1' }, timestamp: 1, inputs, ...extra };
  return { ...rec, hashVersion: RECEIPT_HASH_VERSION, bodySha256: receiptBodySha256(rec) };
};

test('a receipt goes stale when one byte of a certified input changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpt-'));
  const f = path.join(dir, 'a.liquid');
  fs.writeFileSync(f, 'hello');
  const inputs = digestInputs([f]);
  assert.equal(inputs.length, 1);
  assert.equal(isStale(inputs), false);
  fs.writeFileSync(f, 'hellp');
  assert.equal(isStale(inputs), true);
  fs.rmSync(f);
  assert.equal(isStale(inputs), true, 'a missing input is stale too');
});

test('altering the record is reported as tampered; unversioned records are not accused', () => {
  const rec = sealed([]);
  assert.equal(checkIntegrity(rec), 'ok');
  assert.equal(checkIntegrity({ ...rec, claim: 'edited' }), 'tampered');
  assert.equal(checkIntegrity({ id: 'old', claim: 'x' }), 'unversioned');
});

test('mutable lifecycle fields are outside the hash', () => {
  const rec = sealed([]);
  assert.equal(checkIntegrity({ ...rec, verdict: 'REJECTED', stalemateState: 'RESOLVED' }), 'ok');
});

test('compare receipts: v1 round-trips, v0 (no hashVersion) still verifies, tampering is rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
  const input = { workspaceId: 'ws1', origin: 'https://x.test', url: 'https://x.test/', pathname: '/', paneId: 'desktop', comparisonKind: 'baseline', viewport: { width: 1440, height: 900 }, fullPage: true, clipped: false, selector: null, maskedAreaRatio: null, mismatchPercentage: 0.5, match: true };
  const rec = compare.mintCompareReceipt(input, { root });
  assert.equal(rec.hashVersion, 1);
  assert.equal(compare.readCompareReceipt(rec.id, { workspaceId: 'ws1', root })?.id, rec.id);
  // Re-write the file as a v0 record (no hashVersion) with the old bare-array hash.
  const file = path.join(root, 'ws1', 'compares', `${rec.id}.json`);
  const { hashVersion, bodySha256, ...body } = rec;
  const fields = [body.id, body.workspaceId, body.projectId ?? null, body.origin, body.url, body.tabId ?? null, body.comparisonKind, body.baselineRef ?? null, body.viewport ? [body.viewport.width, body.viewport.height] : null, body.mismatchPercentage, body.match, body.tolerancePercent ?? null, body.settleComplete ?? null, body.createdAt, body.pathname ?? null, body.paneId ?? null, body.fullPage ?? null, body.clipped ?? null, body.selector ?? null, body.maskedAreaRatio ?? null];
  fs.writeFileSync(file, JSON.stringify({ ...body, bodySha256: crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex') }));
  assert.equal(compare.readCompareReceipt(rec.id, { workspaceId: 'ws1', root })?.id, rec.id, 'v0 record verifies');
  fs.writeFileSync(file, JSON.stringify({ ...rec, mismatchPercentage: 0.1 }));
  assert.equal(compare.readCompareReceipt(rec.id, { workspaceId: 'ws1', root }), null, 'edited record reads as missing');
});
