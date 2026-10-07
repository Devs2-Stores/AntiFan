import { after, test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IssueRegister } from '../../src/main/session/issue-register';
import { StorageLocations } from '../../src/main/config/storage-locations';

/**
 * Reconciliation + isolation contract for IssueRegister (Issue F1/F4):
 * - ANTIFAN_ISSUE_REGISTER_DIR pins the issue log to an override directory so
 *   test lanes and harness runs never append into the live data root.
 * - autoReconcileKnownIssues resolves the FocusManager/MenuBar native-crash
 *   signature scoped to Electron <= 43.4.0, retires legacy unit-test fixture
 *   residue, and leaves unresolvable crash dumps OPEN.
 * - record() never serializes an explicit undefined errorCode.
 */

const originalDataRoot = process.env.ANTIFAN_DATA_ROOT;
const originalIssueRegisterDir = process.env.ANTIFAN_ISSUE_REGISTER_DIR;
const originalVerificationRegisterDir = process.env.ANTIFAN_VERIFICATION_REGISTER_DIR;
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-recon-'));
process.env.ANTIFAN_DATA_ROOT = scratchRoot;
process.env.ANTIFAN_ISSUE_REGISTER_DIR = scratchRoot;
process.env.ANTIFAN_VERIFICATION_REGISTER_DIR = scratchRoot;
StorageLocations.resetCache();

function resetSingleton() {
  (IssueRegister as unknown as { instance: IssueRegister | null }).instance = null;
}

function seedAndReopen(rows: Array<Record<string, unknown>>): IssueRegister {
  fs.writeFileSync(
    path.join(scratchRoot, 'issue-register.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  );
  resetSingleton();
  return IssueRegister.getInstance();
}

function crashRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `ISS-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    timeFormatted: new Date().toISOString(),
    severity: 'P0',
    toolName: 'runtime.process',
    errorCode: 'NATIVE_CRASH',
    errorMessage:
      'browser died with STATUS_BREAKPOINT (0x80000003) at electron.exe+0x0000000000e22b52 (dump reports/aaa.dmp)',
    notes:
      '{"dump":"reports/aaa.dmp","occurredAt":"2026-10-07T09:19:40.912Z","processType":"browser","pid":17972,"electronVersion":"43.4.0"}',
    status: 'OPEN',
    ...overrides,
  };
}

after(() => {
  resetSingleton();
  if (originalDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
  else process.env.ANTIFAN_DATA_ROOT = originalDataRoot;
  if (originalIssueRegisterDir === undefined) delete process.env.ANTIFAN_ISSUE_REGISTER_DIR;
  else process.env.ANTIFAN_ISSUE_REGISTER_DIR = originalIssueRegisterDir;
  StorageLocations.resetCache();
  if (originalVerificationRegisterDir === undefined) delete process.env.ANTIFAN_VERIFICATION_REGISTER_DIR;
  else process.env.ANTIFAN_VERIFICATION_REGISTER_DIR = originalVerificationRegisterDir;
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe('IssueRegister env override + reconciliation', () => {
  test('ANTIFAN_ISSUE_REGISTER_DIR routes the issue log away from the data root', () => {
    const issueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-issue-override-'));
    try {
      process.env.ANTIFAN_ISSUE_REGISTER_DIR = issueDir;
      resetSingleton();
      const register = IssueRegister.getInstance();
      register.record({ toolName: 'test.tool', errorMessage: 'routed-row', severity: 'P3' });
      assert.ok(fs.existsSync(path.join(issueDir, 'issue-register.jsonl')), 'issue log must land in the override dir');
      // The data root sibling gets only the verification register, not the issue log.
      assert.ok(!fs.existsSync(path.join(scratchRoot, 'issues', 'issue-register.jsonl')));
    } finally {
      process.env.ANTIFAN_ISSUE_REGISTER_DIR = scratchRoot;
      resetSingleton();
      fs.rmSync(issueDir, { recursive: true, force: true });
    }
  });

  test('autoReconcile resolves the 43.4.0 STATUS_BREAKPOINT crash signature', () => {
    const register = seedAndReopen([crashRow({})]);
    const open = register.list({ status: 'OPEN' });
    assert.strictEqual(open.length, 0, 'fixed crash signature must auto-resolve');
  });

  test('autoReconcile leaves non-signature crashes OPEN', () => {
    const variants = [
      crashRow({ notes: '{"electronVersion":"43.4.0"}', errorMessage: 'browser died with ACCESS_VIOLATION at electron.exe+0x0517a7ed' }),
      crashRow({ notes: '{"electronVersion":"43.7.9"}' }), // post-fix binary: not eligible
      crashRow({ notes: '{"pid":17972}' }),                // no version signature: stays open
    ];
    const register = seedAndReopen(variants);
    assert.strictEqual(register.list({ status: 'OPEN' }).length, 3);
  });

  test('autoReconcile retires legacy test-fixture residue', () => {
    const register = seedAndReopen([
      {
        id: 'ISS-fixture-1',
        timestamp: Date.now(),
        timeFormatted: new Date().toISOString(),
        severity: 'P1',
        toolName: 'anti.agent.cursor.type',
        errorMessage: 'Element obscured by modal overlay',
        status: 'OPEN',
      },
    ]);
    assert.strictEqual(register.list({ status: 'OPEN' }).length, 0);
  });

  test('record() never serializes an undefined errorCode', () => {
    // Seed an empty file first so the assertion reads only this test's rows.
    seedAndReopen([]);
    const register = IssueRegister.getInstance();
    register.record({ toolName: 'test.tool', errorMessage: 'no-code-row', errorCode: undefined, severity: 'P3' });
    const lines = fs.readFileSync(path.join(scratchRoot, 'issue-register.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const row = lines.find((l) => l.errorMessage === 'no-code-row');
    assert.ok(row, 'row must persist');
    assert.strictEqual(lines.length, 1, 'file must contain only the recorded row');
    assert.ok(!('errorCode' in row), 'errorCode key must not serialize as undefined');
  });

  test('autoReconcile-stamped resolvedAt persists across repeated init', () => {
    seedAndReopen([crashRow({})]);
    // Reopen without rewriting the file: the resolved row must persist and keep
    // its stamped resolvedAt across the second init pass.
    resetSingleton();
    const again = IssueRegister.getInstance();
    const resolved = again.list({ status: 'RESOLVED' });
    assert.ok(resolved.length >= 1);
    assert.ok(resolved[0]?.resolvedAt, 'resolvedAt must be stamped');
  });
});

describe('CapabilityTransportAdapter issue telemetry', () => {
  test('recordTransportIssue rate-limits rows and skips benign codes', async () => {
    seedAndReopen([]);
    const { CapabilityTransportAdapter } = await import('../../src/main/tools/capability-transport.js');
    // Private-by-convention; exercised directly to verify the rate-limit window
    // and benign filter without needing a full dispatch pipeline.
    const adapter = new CapabilityTransportAdapter(undefined as never, undefined as never);
    const intent = { name: 'test.cap' };
    const recordIssue = adapter['recordTransportIssue'].bind(adapter) as (i: unknown, c: { state: string; code: string; message: string }) => void;

    recordIssue(intent, { state: 'failed', code: 'EXECUTION_TIMEOUT', message: 'op timed out' });
    recordIssue(intent, { state: 'failed', code: 'EXECUTION_TIMEOUT', message: 'op timed out' }); // rate-limited duplicate
    recordIssue(intent, { state: 'interrupted', code: 'ABORTED', message: 'aborted' }); // skipped
    recordIssue(intent, { state: 'failed', code: 'POLICY_DENIED', message: 'policy denied' }); // benign

    const register = IssueRegister.getInstance();
    const rows = register.list({ status: 'OPEN' });
    const timeoutRows = rows.filter((r) => r.errorCode === 'EXECUTION_TIMEOUT');
    assert.strictEqual(timeoutRows.length, 1, 'one rate-limited EXECUTION_TIMEOUT row');
    assert.ok(!rows.some((r) => r.errorCode === 'ABORTED'), 'aborted rows must not be recorded');
    assert.ok(!rows.some((r) => r.errorCode === 'POLICY_DENIED'), 'benign codes must not be recorded');
  });
});
