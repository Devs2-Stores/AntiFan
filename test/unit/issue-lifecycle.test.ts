/**
 * IssueRegister lifecycle, first-class refs, and QA semantics tests (Audit #30 + #32 / P1-3 + P1-4).
 * Covers:
 * 1. Legal lifecycle transition chain: OPEN -> TRIAGED -> ROOT_CAUSE_FOUND -> REPAIRING -> VERIFYING -> RESOLVED
 * 2. Terminal transitions: any active state -> WONT_FIX | DUPLICATE | BYPASSED; terminal states locked unless forced
 * 3. Illegal transitions rejected (throws Error)
 * 4. First-class references recorded via record() and updateIssue()
 * 5. QA semantics import with Path A pass/FAIL, Path B true/false, Path C ok/error, Path D missing=PASS
 * 6. Claim linkage via linkVerification and verdict reflection (RESOLVED on VERIFIED, keep OPEN/TRIAGED otherwise)
 */
import { after, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  IssueRegister,
  IssueStatus,
  mapQaSemantics,
} from '../../src/main/session/issue-register';
import { StorageLocations } from '../../src/main/config/storage-locations';

const originalDataRoot = process.env.ANTIFAN_DATA_ROOT;
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-issue-lifecycle-'));
process.env.ANTIFAN_DATA_ROOT = dataRoot;
StorageLocations.resetCache();

after(() => {
  (IssueRegister as unknown as { instance: IssueRegister | null }).instance = null;
  if (originalDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
  else process.env.ANTIFAN_DATA_ROOT = originalDataRoot;
  StorageLocations.resetCache();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('IssueRegister lifecycle & QA semantics (P1-3 + P1-4)', () => {
  let reg: IssueRegister;

  beforeEach(() => {
    (IssueRegister as unknown as { instance: IssueRegister | null }).instance = null;
    reg = IssueRegister.getInstance();
  });

  describe('Lifecycle transition enforcement', () => {
    it('enforces the complete forward legal transition chain', () => {
      const issue = reg.record({
        toolName: 'theme.qa_validate',
        errorMessage: 'Mobile nav overflow',
        errorCode: 'LAYOUT_OVERFLOW',
        severity: 'P1',
      });
      assert.strictEqual(issue.status, 'OPEN');

      // OPEN -> TRIAGED
      const triaged = reg.transitionIssue(issue.id, 'TRIAGED', { notes: 'Assigned to theme specialist' });
      assert.strictEqual(triaged.status, 'TRIAGED');
      assert.ok(triaged.notes?.includes('Assigned to theme specialist'));

      // TRIAGED -> ROOT_CAUSE_FOUND
      const rootCause = reg.transitionIssue(issue.id, 'ROOT_CAUSE_FOUND', { notes: 'Root cause: flex-wrap missing' });
      assert.strictEqual(rootCause.status, 'ROOT_CAUSE_FOUND');

      // ROOT_CAUSE_FOUND -> REPAIRING
      const repairing = reg.transitionIssue(issue.id, 'REPAIRING', { notes: 'Applying CSS fix' });
      assert.strictEqual(repairing.status, 'REPAIRING');

      // REPAIRING -> VERIFYING
      const verifying = reg.transitionIssue(issue.id, 'VERIFYING', { notes: 'Evaluating in browser viewport' });
      assert.strictEqual(verifying.status, 'VERIFYING');

      // VERIFYING -> RESOLVED
      const resolved = reg.transitionIssue(issue.id, 'RESOLVED', { notes: 'Verification confirmed' });
      assert.strictEqual(resolved.status, 'RESOLVED');

      // Persisted correctly
      const fetched = reg.getIssue(issue.id);
      assert.strictEqual(fetched?.status, 'RESOLVED');
    });

    it('allows loopback from VERIFYING to REPAIRING on test failure', () => {
      const issue = reg.record({
        toolName: 'browser.evaluate',
        errorMessage: 'Button click ignored',
        severity: 'P2',
      });
      reg.transitionIssue(issue.id, 'TRIAGED');
      reg.transitionIssue(issue.id, 'ROOT_CAUSE_FOUND');
      reg.transitionIssue(issue.id, 'REPAIRING');
      reg.transitionIssue(issue.id, 'VERIFYING');

      // Failure in verification loop -> return to REPAIRING
      const returned = reg.transitionIssue(issue.id, 'REPAIRING', { notes: 'Verification failed, retrying repair' });
      assert.strictEqual(returned.status, 'REPAIRING');
    });

    it('allows transitioning from any active status to terminal states (WONT_FIX, DUPLICATE, BYPASSED)', () => {
      const statusesToTest: Array<{ from: IssueStatus; to: IssueStatus }> = [
        { from: 'OPEN', to: 'WONT_FIX' },
        { from: 'TRIAGED', to: 'DUPLICATE' },
        { from: 'ROOT_CAUSE_FOUND', to: 'BYPASSED' },
        { from: 'REPAIRING', to: 'WONT_FIX' },
        { from: 'VERIFYING', to: 'BYPASSED' },
      ];

      for (const { from, to } of statusesToTest) {
        const issue = reg.record({
          toolName: 'test.tool',
          errorMessage: `Testing ${from} -> ${to}`,
          severity: 'P3',
        });

        // Advance to 'from' status if not OPEN
        if (from === 'TRIAGED' || from === 'ROOT_CAUSE_FOUND' || from === 'REPAIRING' || from === 'VERIFYING') {
          reg.transitionIssue(issue.id, 'TRIAGED');
        }
        if (from === 'ROOT_CAUSE_FOUND' || from === 'REPAIRING' || from === 'VERIFYING') {
          reg.transitionIssue(issue.id, 'ROOT_CAUSE_FOUND');
        }
        if (from === 'REPAIRING' || from === 'VERIFYING') {
          reg.transitionIssue(issue.id, 'REPAIRING');
        }
        if (from === 'VERIFYING') {
          reg.transitionIssue(issue.id, 'VERIFYING');
        }

        assert.strictEqual(reg.getIssue(issue.id)?.status, from);
        const transitioned = reg.transitionIssue(issue.id, to, { notes: `Moved to ${to}` });
        assert.strictEqual(transitioned.status, to);
      }
    });

    it('rejects illegal transitions with an informative Error', () => {
      const issue = reg.record({
        toolName: 'browser.evaluate',
        errorMessage: 'Syntax error',
        severity: 'P2',
      });

      // OPEN -> RESOLVED is illegal (must go through lifecycle)
      assert.throws(
        () => reg.transitionIssue(issue.id, 'RESOLVED'),
        /Illegal issue status transition from 'OPEN' to 'RESOLVED'/
      );

      // OPEN -> REPAIRING is illegal
      assert.throws(
        () => reg.transitionIssue(issue.id, 'REPAIRING'),
        /Illegal issue status transition from 'OPEN' to 'REPAIRING'/
      );

      // OPEN -> VERIFYING is illegal
      assert.throws(
        () => reg.transitionIssue(issue.id, 'VERIFYING'),
        /Illegal issue status transition from 'OPEN' to 'VERIFYING'/
      );

      // Advance to TRIAGED
      reg.transitionIssue(issue.id, 'TRIAGED');

      // TRIAGED -> RESOLVED is illegal
      assert.throws(
        () => reg.transitionIssue(issue.id, 'RESOLVED'),
        /Illegal issue status transition from 'TRIAGED' to 'RESOLVED'/
      );

      // Advance to WONT_FIX (terminal)
      reg.transitionIssue(issue.id, 'WONT_FIX');

      // From terminal WONT_FIX, further transitions are rejected
      assert.throws(
        () => reg.transitionIssue(issue.id, 'OPEN'),
        /Illegal issue status transition from 'WONT_FIX' to 'OPEN'/
      );
      assert.throws(
        () => reg.transitionIssue(issue.id, 'REPAIRING'),
        /Illegal issue status transition from 'WONT_FIX' to 'REPAIRING'/
      );
    });

    it('allows administrative bypass when force: true is provided', () => {
      const issue = reg.record({
        toolName: 'browser.evaluate',
        errorMessage: 'Trivial typo',
        severity: 'P3',
      });

      // Forced jump directly to RESOLVED
      const forced = reg.transitionIssue(issue.id, 'RESOLVED', { force: true, notes: 'Admin override' });
      assert.strictEqual(forced.status, 'RESOLVED');

      // Forced reopen from terminal RESOLVED to OPEN
      const reopened = reg.transitionIssue(issue.id, 'OPEN', { force: true, notes: 'Reopened by QA' });
      assert.strictEqual(reopened.status, 'OPEN');
    });
  });

  describe('First-class references', () => {
    it('records first-class references on creation and lists by them', () => {
      const issue = reg.record({
        toolName: 'theme.qa_validate',
        errorMessage: 'Missing product description metafield',
        errorCode: 'DATA_DEFECT',
        severity: 'P1',
        taskRunId: 'run-8821',
        invocationId: 'inv-4432',
        receiptId: 'rcpt-9912',
        evidenceId: 'evid-1234',
        contextPackId: 'pack-555',
        claimId: 'claim-theme-77',
        regressionId: 'regr-001',
      });

      assert.strictEqual(issue.taskRunId, 'run-8821');
      assert.strictEqual(issue.invocationId, 'inv-4432');
      assert.strictEqual(issue.receiptId, 'rcpt-9912');
      assert.strictEqual(issue.evidenceId, 'evid-1234');
      assert.strictEqual(issue.contextPackId, 'pack-555');
      assert.strictEqual(issue.claimId, 'claim-theme-77');
      assert.strictEqual(issue.regressionId, 'regr-001');

      // claimId automatically tracked in affected
      assert.ok(issue.affected?.includes('claim-theme-77'));

      // Filter by taskRunId
      const byRun = reg.list({ taskRunId: 'run-8821' });
      assert.strictEqual(byRun.length, 1);
      assert.strictEqual(byRun[0]?.id, issue.id);

      // Filter by invocationId
      const byInv = reg.list({ invocationId: 'inv-4432' });
      assert.strictEqual(byInv.length, 1);

      // Filter by receiptId
      const byRcpt = reg.list({ receiptId: 'rcpt-9912' });
      assert.strictEqual(byRcpt.length, 1);

      // Filter by claimId
      const byClaim = reg.list({ claimId: 'claim-theme-77' });
      assert.strictEqual(byClaim.length, 1);
    });

    it('updates first-class references via updateIssue()', () => {
      const issue = reg.record({
        toolName: 'bridge.hook',
        errorMessage: 'Context bridge latency spike',
        severity: 'P2',
      });

      assert.strictEqual(issue.taskRunId, undefined);
      assert.strictEqual(issue.receiptId, undefined);

      const updated = reg.updateIssue(issue.id, {
        taskRunId: 'run-updated-01',
        invocationId: 'inv-updated-02',
        receiptId: 'rcpt-updated-03',
        evidenceId: 'evid-updated-04',
        claimId: 'claim-updated-05',
        regressionId: 'regr-updated-06',
        notes: 'Updated references after triage',
      });

      assert.strictEqual(updated.taskRunId, 'run-updated-01');
      assert.strictEqual(updated.invocationId, 'inv-updated-02');
      assert.strictEqual(updated.receiptId, 'rcpt-updated-03');
      assert.strictEqual(updated.evidenceId, 'evid-updated-04');
      assert.strictEqual(updated.claimId, 'claim-updated-05');
      assert.strictEqual(updated.regressionId, 'regr-updated-06');
      assert.ok(updated.notes?.includes('Updated references after triage'));
      assert.ok(updated.affected?.includes('claim-updated-05'));
    });
  });

  describe('QA semantics import (Path A, B, C, D)', () => {
    it('maps Path A (pass/FAIL string)', () => {
      const pass = mapQaSemantics({ pathA: 'PASS' });
      assert.strictEqual(pass.pathA, 'PASS');
      assert.strictEqual(pass.pathB, true);
      assert.strictEqual(pass.pathC, 'ok');
      assert.strictEqual(pass.pathD, 'PASS');
      assert.strictEqual(pass.effectiveVerdict, 'PASS');

      const fail = mapQaSemantics({ pathA: 'fail' });
      assert.strictEqual(fail.pathA, 'FAIL');
      assert.strictEqual(fail.pathB, false);
      assert.strictEqual(fail.pathC, 'error');
      assert.strictEqual(fail.pathD, 'FAIL');
      assert.strictEqual(fail.effectiveVerdict, 'FAIL');
    });

    it('maps Path B (boolean true/false)', () => {
      const pass = mapQaSemantics({ pathB: true });
      assert.strictEqual(pass.effectiveVerdict, 'PASS');
      assert.strictEqual(pass.pathB, true);

      const fail = mapQaSemantics({ pathB: false });
      assert.strictEqual(fail.effectiveVerdict, 'FAIL');
      assert.strictEqual(fail.pathB, false);
    });

    it('maps Path C (ok/error string)', () => {
      const pass = mapQaSemantics({ pathC: 'ok' });
      assert.strictEqual(pass.effectiveVerdict, 'PASS');
      assert.strictEqual(pass.pathC, 'ok');

      const fail = mapQaSemantics({ pathC: 'error' });
      assert.strictEqual(fail.effectiveVerdict, 'FAIL');
      assert.strictEqual(fail.pathC, 'error');
    });

    it('maps Path D (missing = PASS contract)', () => {
      // Omitted input altogether defaults to PASS
      const empty = mapQaSemantics({});
      assert.strictEqual(empty.effectiveVerdict, 'PASS');
      assert.strictEqual(empty.pathD, 'PASS');

      // Explicit undefined pathD defaults to PASS
      const undef = mapQaSemantics({ pathD: undefined });
      assert.strictEqual(undef.effectiveVerdict, 'PASS');
      assert.strictEqual(undef.pathD, 'PASS');

      // Explicit false or FAIL pathD evaluates to FAIL
      const explicitFail = mapQaSemantics({ pathD: 'FAIL' });
      assert.strictEqual(explicitFail.effectiveVerdict, 'FAIL');
    });

    it('importQaSemantics attaches semantics to issue and resolves if VERIFYING', () => {
      const issue = reg.record({
        toolName: 'theme.qa_validate',
        errorMessage: 'Testing QA semantics import',
        severity: 'P2',
      });
      reg.transitionIssue(issue.id, 'TRIAGED');
      reg.transitionIssue(issue.id, 'ROOT_CAUSE_FOUND');
      reg.transitionIssue(issue.id, 'REPAIRING');
      reg.transitionIssue(issue.id, 'VERIFYING');

      const imported = reg.importQaSemantics(issue.id, {
        pathA: 'PASS',
        claimId: 'claim-sem-1',
      });

      assert.ok(imported.qaSemantics);
      assert.strictEqual(imported.qaSemantics.effectiveVerdict, 'PASS');
      assert.strictEqual(imported.qaSemantics.pathA, 'PASS');
      assert.strictEqual(imported.qaSemantics.pathB, true);
      assert.strictEqual(imported.qaSemantics.pathC, 'ok');
      assert.strictEqual(imported.qaSemantics.pathD, 'PASS');
      // In VERIFYING status with PASS verdict -> reflects to RESOLVED
      assert.strictEqual(imported.status, 'RESOLVED');
    });
  });

  describe('Claim linkage & verification reflection', () => {
    it('linkVerification links claimId, affects list, and reflects terminal VERIFIED verdict to RESOLVED', () => {
      const issue = reg.record({
        toolName: 'theme.qa_validate',
        errorMessage: 'Layout break in desktop view',
        severity: 'P1',
      });
      assert.strictEqual(issue.status, 'OPEN');

      // Record a VERIFIED verification record
      reg.recordVerification({
        id: 'claim-desktop-layout',
        claim: 'Desktop layout is within bounds',
        actor: 'agent',
        scope: { tabId: 'tab-1' },
        proofObligations: [],
        verdict: 'VERIFIED',
      });

      // Link claim to issue
      const linked = reg.linkVerification(issue.id, 'claim-desktop-layout');
      assert.strictEqual(linked.claimId, 'claim-desktop-layout');
      assert.ok(linked.affected?.includes('claim-desktop-layout'));
      // VERIFIED verdict reflects to RESOLVED
      assert.strictEqual(linked.status, 'RESOLVED');

      // Verification record updated with linkedIssueId
      const verif = reg.getVerification('claim-desktop-layout');
      assert.strictEqual(verif?.linkedIssueId, issue.id);
    });

    it('linkVerification keeps OPEN/TRIAGED when claim verdict is REJECTED', () => {
      const issue = reg.record({
        toolName: 'theme.qa_validate',
        errorMessage: 'Missing cart items count',
        severity: 'P1',
      });
      reg.transitionIssue(issue.id, 'TRIAGED');
      assert.strictEqual(issue.status, 'TRIAGED');

      // Record a REJECTED verification record
      reg.recordVerification({
        id: 'claim-cart-count',
        claim: 'Cart badge displays count',
        actor: 'agent',
        scope: { tabId: 'tab-1' },
        proofObligations: [],
        verdict: 'REJECTED',
      });

      // Link claim to issue
      const linked = reg.linkVerification(issue.id, 'claim-cart-count');
      assert.strictEqual(linked.claimId, 'claim-cart-count');
      // Status MUST remain TRIAGED (not resolved)
      assert.strictEqual(linked.status, 'TRIAGED');
    });

    it('reflects verdict update from updateVerificationVerdict to linked issue', () => {
      const issue = reg.record({
        toolName: 'theme.qa_validate',
        errorMessage: 'Responsive hamburger toggle failure',
        severity: 'P0',
      });
      reg.transitionIssue(issue.id, 'TRIAGED');

      // Record initially UNVERIFIED claim
      reg.recordVerification({
        id: 'claim-hamburger',
        claim: 'Hamburger opens drawer',
        actor: 'agent',
        scope: { tabId: 'tab-1' },
        proofObligations: [],
        verdict: 'UNVERIFIED',
        linkedIssueId: issue.id,
      });

      reg.linkVerification(issue.id, 'claim-hamburger');
      assert.strictEqual(reg.getIssue(issue.id)?.status, 'TRIAGED');

      // Evaluator updates verdict to VERIFIED
      reg.updateVerificationVerdict('claim-hamburger', 'VERIFIED');

      // Linked issue is reflected to RESOLVED
      const updatedIssue = reg.getIssue(issue.id);
      assert.strictEqual(updatedIssue?.status, 'RESOLVED');
      assert.ok(updatedIssue?.notes?.includes('VERIFIED via claim claim-hamburger'));
    });
  });
});
