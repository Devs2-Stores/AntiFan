/**
 * The verification register is the program's durability boundary: a read must
 * answer from the file rather than from a per-process array, and a write must
 * never be able to empty or shrink it.
 *
 * Measured defect these tests pin down: `anti.verification.list` returned
 * `totalCount: 0` while the register file held 1,000 valid records, because both
 * the read and the write went through one in-memory array that was loaded once
 * per process.
 */
import { after, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IssueRegister } from '../../src/main/session/issue-register';
import { StorageLocations } from '../../src/main/config/storage-locations';

const originalDataRoot = process.env.ANTIFAN_DATA_ROOT;
const createdRoots: string[] = [];

/**
 * A data root no register instance is bound to yet: the env var, the location
 * cache and the singleton are reset together, so a test can stand in for a
 * second process.
 */
function useFreshDataRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdRoots.push(root);
  (IssueRegister as unknown as { instance: IssueRegister | null }).instance = null;
  process.env.ANTIFAN_DATA_ROOT = root;
  StorageLocations.resetCache();
  return root;
}

function registerPath(root: string): string {
  return path.join(root, 'issues', 'verification-register.jsonl');
}

/** Write a register file the way a *different* process would have left it. */
function seedRegister(root: string, ids: string[]): void {
  const file = registerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = ids.map((id) =>
    JSON.stringify({
      id,
      claim: `claim for ${id}`,
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: [],
      verdict: 'UNVERIFIED',
      timestamp: 1,
      timeFormatted: new Date(1).toISOString(),
    })
  );
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

/** The record ids actually present in the file — the register's own truth. */
function onDiskIds(root: string): string[] {
  return fs
    .readFileSync(registerPath(root), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line).id as string);
}

after(() => {
  (IssueRegister as unknown as { instance: IssueRegister | null }).instance = null;
  if (originalDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
  else process.env.ANTIFAN_DATA_ROOT = originalDataRoot;
  StorageLocations.resetCache();
  for (const root of createdRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe('verification register durability', () => {
  test('a live instance sees records another process wrote after it started', () => {
    const root = useFreshDataRoot('antifan-register-live-');
    const register = IssueRegister.getInstance();

    // The instance exists before the records do: this is the reported state
    // where the answering process was not the writing process.
    seedRegister(root, ['seed-1', 'seed-2', 'seed-3']);

    const list = register.listVerifications();
    assert.deepStrictEqual(
      list.map((v) => v.id).sort(),
      ['seed-1', 'seed-2', 'seed-3'],
      'list answers from the file, not from the array loaded at startup'
    );
    assert.strictEqual(list.length, onDiskIds(root).length);
  });

  test('filters and limit apply over the on-disk set', () => {
    const root = useFreshDataRoot('antifan-register-filters-');
    const register = IssueRegister.getInstance();
    seedRegister(root, ['seed-1', 'seed-2', 'seed-3']);
    fs.appendFileSync(
      registerPath(root),
      JSON.stringify({
        id: 'seed-verified',
        claim: 'verified elsewhere',
        actor: 'user',
        scope: { tabId: 'tab-2' },
        proofObligations: [],
        verdict: 'VERIFIED',
        timestamp: 2,
        timeFormatted: new Date(2).toISOString(),
      }) + '\n',
      'utf8'
    );

    assert.strictEqual(register.listVerifications().length, 4);
    assert.strictEqual(register.listVerifications({ verdict: 'VERIFIED' }).length, 1);
    assert.strictEqual(register.listVerifications({ tabId: 'tab-2' }).length, 1);
    assert.strictEqual(register.listVerifications({ actor: 'user' }).length, 1);
    assert.strictEqual(register.listVerifications({ limit: 2 }).length, 2);
  });

  test('an append from another process is visible without a restart', () => {
    const root = useFreshDataRoot('antifan-register-append-');
    const register = IssueRegister.getInstance();
    seedRegister(root, ['seed-1', 'seed-2']);
    assert.strictEqual(register.listVerifications().length, 2);

    fs.appendFileSync(
      registerPath(root),
      JSON.stringify({
        id: 'seed-3',
        claim: 'appended by a peer',
        actor: 'agent',
        scope: { tabId: 'tab-1' },
        proofObligations: [],
        verdict: 'UNVERIFIED',
        timestamp: 3,
        timeFormatted: new Date(3).toISOString(),
      }) + '\n',
      'utf8'
    );

    assert.strictEqual(register.listVerifications().length, 3);
    assert.ok(register.getVerification('seed-3'), 'getVerification resolves peer records');
  });

  test('a mutation keeps every record it does not touch', () => {
    const root = useFreshDataRoot('antifan-register-mutation-');
    const register = IssueRegister.getInstance();
    seedRegister(root, ['seed-1', 'seed-2', 'seed-3']);
    const bytesBefore = fs.statSync(registerPath(root)).size;

    assert.strictEqual(register.updateVerificationStalemate('seed-2', 'STALEMATE'), true);
    assert.strictEqual(register.updateVerificationVerdict('seed-1', 'VERIFIED')?.verdict, 'VERIFIED');

    assert.deepStrictEqual(
      onDiskIds(root).sort(),
      ['seed-1', 'seed-2', 'seed-3'],
      'rewriting one record never drops the others'
    );
    assert.ok(fs.statSync(registerPath(root)).size > 0);
    assert.notStrictEqual(fs.statSync(registerPath(root)).size, bytesBefore);
    assert.strictEqual(register.getVerification('seed-2')?.stalemateState, 'STALEMATE');
  });

  test('recording a claim appends to the file and survives a later rewrite', () => {
    const root = useFreshDataRoot('antifan-register-record-');
    const register = IssueRegister.getInstance();
    seedRegister(root, ['seed-1']);

    const recorded = register.recordVerification({
      claim: 'recorded by this process',
      actor: 'agent',
      scope: { tabId: 'tab-9' },
      proofObligations: [{ id: 'obl-1', metric: 'test.metric' }],
      verdict: 'UNVERIFIED',
    });

    assert.ok(onDiskIds(root).includes(recorded.id), 'the record reached the file');
    assert.ok(register.listVerifications().some((v) => v.id === recorded.id));

    register.updateVerificationStalemate(recorded.id, 'STALEMATE');
    assert.deepStrictEqual(onDiskIds(root).sort(), ['seed-1', recorded.id].sort());
  });

  test('an empty view is refused instead of overwriting a populated register', () => {
    const root = useFreshDataRoot('antifan-register-guard-');
    const register = IssueRegister.getInstance();
    seedRegister(root, ['seed-1', 'seed-2', 'seed-3']);
    const bytesBefore = fs.statSync(registerPath(root)).size;

    // Driven at the writer seam on purpose: no public path can produce an empty
    // caller set any more, and this guard is the last line of defence for a
    // caller that still holds one.
    const writer = register as unknown as {
      rewriteVerificationsFile(records: unknown[]): void;
    };
    assert.throws(
      () => writer.rewriteVerificationsFile([]),
      (err: Error) => err.name === 'DURABILITY_FAILED',
      'emptying a populated register is refused'
    );

    assert.strictEqual(fs.statSync(registerPath(root)).size, bytesBefore);
    assert.deepStrictEqual(onDiskIds(root).sort(), ['seed-1', 'seed-2', 'seed-3']);
  });

  test('an unreadable register raises instead of reporting zero records', () => {
    const root = useFreshDataRoot('antifan-register-unreadable-');
    fs.mkdirSync(registerPath(root), { recursive: true });
    const register = IssueRegister.getInstance();

    assert.throws(
      () => register.listVerifications(),
      (err: Error) => err.name === 'REGISTER_READ_FAILED',
      'an unreadable register is an error, never an empty register'
    );
  });

  test('a register that already carries duplicate id lines still accepts writes', () => {
    const root = useFreshDataRoot('antifan-register-dupes-');
    const register = IssueRegister.getInstance();
    // A register left by an older writer whose append was not id-aware: five
    // lines, four ids. Measured live: 1002 lines / 998 ids, with one id five
    // times over, which a line-counting shrink guard reads as a loss on every
    // later write and refuses forever.
    seedRegister(root, ['seed-1', 'dup-1', 'dup-1', 'dup-1', 'seed-2']);
    assert.strictEqual(onDiskIds(root).length, 5);

    assert.strictEqual(register.updateVerificationVerdict('seed-1', 'VERIFIED')?.verdict, 'VERIFIED');

    const ids = onDiskIds(root);
    assert.deepStrictEqual(
      [...new Set(ids)].sort(),
      ['dup-1', 'seed-1', 'seed-2'],
      'collapsing duplicate lines never drops a record id'
    );
    assert.strictEqual(
      ids.filter((id) => id === 'dup-1').length,
      1,
      'the duplicate lines collapse to one record per id'
    );
    assert.strictEqual(register.getVerification('seed-1')?.verdict, 'VERIFIED');
  });
});
