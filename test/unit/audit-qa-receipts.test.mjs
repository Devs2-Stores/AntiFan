import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'audit-qa-receipts.mjs');
const { auditDirectory, classifyReceipt, receiptDirsFor } = await import(pathToFileURL(SCRIPT).href);

const COMPARE = { desktop: 'compare-receipt', tablet: 'compare-receipt', mobile: 'compare-receipt' };

function workspaceWith(receipts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-qa-receipts-'));
  const dir = path.join(root, '.antifan', 'qa-receipts');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(receipts)) {
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  }
  return { root, dir };
}

test('classifyReceipt flags only CERTIFIED receipts that cannot prove their baseline numbers', () => {
  assert.equal(classifyReceipt({ certification: 'STRUCTURAL' }), null);
  assert.equal(classifyReceipt({ certification: 'CERTIFIED_SCOPED', certificationBasis: 'baseline' }), null);
  assert.equal(classifyReceipt({ certification: 'CERTIFIED', certificationBasis: 'greenfield' }), null);
  assert.equal(classifyReceipt({ certification: 'CERTIFIED', certificationBasis: 'baseline', baselineProvenance: COMPARE }), null);
  assert.equal(classifyReceipt({ certification: 'CERTIFIED', certificationBasis: 'baseline' })?.code, 'NO_PROVENANCE');
  assert.equal(
    classifyReceipt({ certification: 'CERTIFIED', certificationBasis: 'baseline', baselineProvenance: { ...COMPARE, tablet: 'caller-asserted' } })?.code,
    'CALLER_ASSERTED'
  );
  assert.match(
    classifyReceipt({ certification: 'CERTIFIED', certificationBasis: 'baseline', baselineProvenance: { desktop: 'compare-receipt' } })?.detail ?? '',
    /tablet, mobile/
  );
  assert.equal(classifyReceipt({ certification: 'CERTIFIED' })?.code, 'BASIS_UNRECORDED');
  assert.equal(classifyReceipt(null), null);
  assert.equal(classifyReceipt('CERTIFIED'), null);
});

test('auditDirectory reports flagged receipts and unreadable files without touching them', () => {
  const { root, dir } = workspaceWith({
    'a-old.json': { certification: 'CERTIFIED', certificationBasis: 'baseline', runId: 'run-1', timestamp: '2026-10-01T00:00:00.000Z' },
    'b-good.json': { certification: 'CERTIFIED', certificationBasis: 'baseline', baselineProvenance: COMPARE },
    'c-structural.json': { certification: 'STRUCTURAL' },
    'd-broken.json': '{ not json',
    'e-note.txt': 'ignored',
  });
  try {
    const before = fs.readdirSync(dir).sort();
    const result = auditDirectory(dir);
    assert.equal(result.scanned, 3);
    assert.equal(result.unreadable, 1);
    assert.equal(result.flagged.length, 1);
    assert.equal(result.flagged[0].code, 'NO_PROVENANCE');
    assert.equal(result.flagged[0].runId, 'run-1');
    assert.equal(result.flagged[0].timestamp, '2026-10-01T00:00:00.000Z');
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'the audit never writes or deletes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('receiptDirsFor accepts a workspace root, a qa-receipts directory, or a parent of workspaces', () => {
  const a = workspaceWith({ 'x.json': { certification: 'STRUCTURAL' } });
  try {
    assert.deepEqual(receiptDirsFor(a.root), [a.dir]);
    assert.deepEqual(receiptDirsFor(a.dir), [a.dir]);
    assert.deepEqual(receiptDirsFor(path.dirname(a.root)).includes(a.dir), true);
    assert.deepEqual(receiptDirsFor(path.join(a.root, 'does-not-exist')), []);
  } finally {
    fs.rmSync(a.root, { recursive: true, force: true });
  }
});

test('the command exits 1 and lists the flagged receipt, exits 0 when none is flagged, 2 without arguments', () => {
  const flagged = workspaceWith({ 'old.json': { certification: 'CERTIFIED', certificationBasis: 'baseline' } });
  const clean = workspaceWith({ 'ok.json': { certification: 'CERTIFIED', certificationBasis: 'baseline', baselineProvenance: COMPARE } });
  try {
    const bad = spawnSync(process.execPath, [SCRIPT, flagged.root], { encoding: 'utf8' });
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stdout, /NO_PROVENANCE\s+old\.json/);
    const json = spawnSync(process.execPath, [SCRIPT, flagged.root, '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(json.stdout).flaggedTotal, 1);
    const good = spawnSync(process.execPath, [SCRIPT, clean.root], { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(none.status, 2);
    const missing = spawnSync(process.execPath, [SCRIPT, path.join(flagged.root, 'nowhere')], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
  } finally {
    fs.rmSync(flagged.root, { recursive: true, force: true });
    fs.rmSync(clean.root, { recursive: true, force: true });
  }
});
