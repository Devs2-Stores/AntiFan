import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { AuthenticatedCapabilityContext, BrowserTarget, CapabilityRequestContext, ArtifactRef, issueRuntimeLease } from '../../src/shared/control-plane-contracts';
import { IssueRegister } from '../../src/main/session/issue-register';
import { ReceiptStore } from '../../src/main/session/receipt-store';
import type { VerificationRecord } from '../../src/main/verification/verification-contract';
describe('Verification Capabilities & Anti-Hallucination Barrier Suite (Phase 2)', () => {
  const dummyTarget: BrowserTarget = {
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    runtimeId: 'rt-1',
    tabId: 'tab-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };

  const createMockHost = (overrides: Partial<BrowserHostPort> = {}): any => ({
    getTabList: () => [
      { id: 'tab-1', url: 'https://store.example.com/', title: 'Storefront', alias: '@storefront', role: 'storefront' },
    ],
    hasTab: (id: string) => id === 'tab-1',
    switchTab: () => true,
    getDom: async () => '<html><body><button class="cta">Buy Now</button></body></html>',
    inspectStyles: async () => ({
      color: 'rgb(0, 128, 0)',
      fontSize: '16px',
      display: 'inline-block',
    }),
    getDocumentGeneration: () => 1,
    ...overrides,
  });

  test('anti.verification.record_claim persists claim strictly as UNVERIFIED', async () => {
    const catalogue = new CapabilityCatalogue({ runtime: { allowEval: true } as any, projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'rt-1' });
    const host = createMockHost();
    const port = new BrowserControlPort(host);
    registerBrowserCapabilities(catalogue, port);

    const recordClaimCap = catalogue.get('anti.verification.record_claim');
    assert.ok(recordClaimCap, 'anti.verification.record_claim must be registered');

    const result = (await recordClaimCap.execute(
      {
        claim: 'Hero banner is rendered and styled',
        category: 'CUSTOM',
        tabId: 'tab-1',
        selector: '.hero',
        proofObligations: [{ id: 'obl-1', metric: 'style.display', expected: 'block' }],
      },
      { browserTarget: dummyTarget } as any
    )) as any;

    assert.ok(result.id.startsWith('CLM-') || result.id.startsWith('VER-'));
    assert.strictEqual(result.verdict, 'UNVERIFIED', 'All claims must enter register strictly as UNVERIFIED');
    assert.strictEqual(result.stalemateState, 'ACTIVE');
  });

  test('anti.verification.verify_claim rejects claim when computed style mismatches expected value', async () => {
    const catalogue = new CapabilityCatalogue({ runtime: { allowEval: true } as any, projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'rt-1' });
    // Live mock host has color = 'rgb(0, 128, 0)' (green)
    const host = createMockHost({
      inspectStyles: async () => ({
        color: 'rgb(0, 128, 0)',
        fontSize: '16px',
      }),
    });
    const port = new BrowserControlPort(host);
    registerBrowserCapabilities(catalogue, port);

    const register = IssueRegister.getInstance();
    const claim = register.recordVerification({
      claim: 'CTA button is red',
      actor: 'agent',
      scope: { tabId: 'tab-1', selector: '.cta' },
      proofObligations: [
        // Obligation expects red, but live element is green
        { id: 'obl-color', metric: 'style.color', expected: 'rgb(255, 0, 0)', critical: true },
      ],
      verdict: 'UNVERIFIED',
    });

    const verifyCap = catalogue.get('anti.verification.verify_claim');
    assert.ok(verifyCap, 'anti.verification.verify_claim must be registered');

    const verifyResult = (await verifyCap.execute(
      { claimId: claim.id },
      { browserTarget: dummyTarget } as any
    )) as any;

    assert.strictEqual(verifyResult.verdict, 'REJECTED', 'Mismatched computed style must be evaluated as REJECTED');
    assert.ok(verifyResult.proofProfile.violations.length >= 1);
    assert.strictEqual(verifyResult.proofProfile.violations[0].metric, 'style.color');
  });

  test('anti.verification.verify_claim verifies DOM selector presence via live wait probe without touching filesystem', async () => {
    const catalogue = new CapabilityCatalogue({ runtime: { allowEval: true } as any, projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'rt-1' });
    const host = createMockHost({
      inspectStyles: async () => ({
        color: 'rgb(255, 0, 0)',
        display: 'block',
      }),
    });
    const port = new BrowserControlPort(host);

    // Mock port.wait to return satisfied for matching selector, not satisfied otherwise
    port.wait = async (_target, params) => {
      const satisfied = params.selector === '.modal';
      return {
        satisfied,
        condition: params.condition,
        durationMs: 10,
        documentGeneration: 1,
      };
    };

    registerBrowserCapabilities(catalogue, port);

    const register = IssueRegister.getInstance();

    // Case A: Existing selector and matching style -> VERIFIED
    const validClaim = register.recordVerification({
      claim: 'Modal element exists and has display block',
      actor: 'agent',
      scope: { tabId: 'tab-1', selector: '.modal' },
      proofObligations: [
        { id: 'obl-dom', metric: 'dom.exists', expected: true, critical: true },
        { id: 'obl-style', metric: 'style.display', expected: 'block', critical: true },
      ],
      verdict: 'UNVERIFIED',
    });

    const verifyCap = catalogue.get('anti.verification.verify_claim');
    assert.ok(verifyCap);

    const verifyResult = (await verifyCap.execute(
      { claimId: validClaim.id },
      { browserTarget: dummyTarget } as any
    )) as any;

    assert.strictEqual(verifyResult.verdict, 'VERIFIED', 'Valid selector and matching styles must evaluate to VERIFIED');
    assert.strictEqual(verifyResult.proofProfile.completeness, 'FULL');
    assert.strictEqual(verifyResult.proofProfile.violations.length, 0);

    // Case B: Non-existent selector -> REJECTED
    const missingClaim = register.recordVerification({
      claim: 'Missing banner exists',
      actor: 'agent',
      scope: { tabId: 'tab-1', selector: '.missing-banner' },
      proofObligations: [
        { id: 'obl-dom', metric: 'dom.exists', expected: true, critical: true },
      ],
      verdict: 'UNVERIFIED',
    });

    const missingResult = (await verifyCap.execute(
      { claimId: missingClaim.id },
      { browserTarget: dummyTarget } as any
    )) as any;

    assert.strictEqual(missingResult.verdict, 'REJECTED', 'Missing selector probe must evaluate to REJECTED');
    assert.ok(missingResult.proofProfile.violations.length >= 1);
  });

  test('cursor actions and keyboard press abort immediately when context.signal is cancelled', async () => {
    const catalogue = new CapabilityCatalogue({ runtime: { allowEval: true } as any, projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'rt-1' });
    const host = createMockHost({
      agentClick: async () => true,
      sendKeyboardPress: async () => ({ success: true, key: 'Enter', modifiers: [] }),
    });
    const port = new BrowserControlPort(host);
    registerBrowserCapabilities(catalogue, port);

    const clickCap = catalogue.get('browser.agent-click');
    assert.ok(clickCap);

    const abortController = new AbortController();
    abortController.abort(new Error('User cancelled action'));

    await assert.rejects(
      async () => {
        await clickCap.execute(
          { selector: '.btn', tabId: 'tab-1' },
          { browserTarget: dummyTarget, signal: abortController.signal } as any
        );
      },
      (err: any) => {
        return err.name === 'CapabilityError' || err.message.includes('abort') || err.message.includes('cancel');
      },
      'Action must abort when execution signal is cancelled'
    );
  });

  test('anti.verification.verify_claim aborts with WAIT_ABORTED when signal is aborted', async () => {
    const catalogue = new CapabilityCatalogue({ runtime: { allowEval: true } as any, projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'rt-1' });
    const host = createMockHost();
    const port = new BrowserControlPort(host);
    registerBrowserCapabilities(catalogue, port);

    const register = IssueRegister.getInstance();
    const claim = register.recordVerification({
      claim: 'Test claim for cancellation',
      actor: 'agent',
      scope: { tabId: 'tab-1' },
      proofObligations: [{ id: 'obl-1', metric: 'element.exists' }],
      verdict: 'UNVERIFIED',
    });

    const verifyCap = catalogue.get('anti.verification.verify_claim');
    assert.ok(verifyCap);

    const abortController = new AbortController();
    abortController.abort();

    await assert.rejects(
      async () => {
        await verifyCap.execute(
          { claimId: claim.id },
          { browserTarget: dummyTarget, signal: abortController.signal } as any
        );
      },
      (err: any) => {
        return err.code === 'WAIT_ABORTED';
      },
      'verify_claim must throw WAIT_ABORTED when signal is aborted'
    );
  });

  test('anti.verification.record_claim rejects blank claim and bounds obligations to max 50', async () => {
    const catalogue = new CapabilityCatalogue({ runtime: { allowEval: true } as any, projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'rt-1' });
    const host = createMockHost();
    const port = new BrowserControlPort(host);
    registerBrowserCapabilities(catalogue, port);

    const recordClaimCap = catalogue.get('anti.verification.record_claim');
    assert.ok(recordClaimCap);

    // 1. Rejects empty claim
    await assert.rejects(
      async () => {
        await recordClaimCap.execute(
          { claim: '   ', tabId: 'tab-1', category: 'CUSTOM' },
          { browserTarget: dummyTarget } as any
        );
      },
      (err: any) => err.code === 'INVALID_ARGUMENT' && err.message.includes('Claim description cannot be empty')
    );

    // 2. Rejects > 50 obligations
    const tooManyObligations = Array.from({ length: 51 }, (_, i) => ({
      id: `obl-${i}`,
      metric: `metric.${i}`,
    }));

    await assert.rejects(
      async () => {
        await recordClaimCap.execute(
          { claim: 'Valid claim with too many obligations', tabId: 'tab-1', category: 'CUSTOM', proofObligations: tooManyObligations },
          { browserTarget: dummyTarget } as any
        );
      },
      (err: any) => err.code === 'INVALID_ARGUMENT' && err.message.includes('Exceeded maximum of 50')
    );

    // 3. Rejects CUSTOM claims with only element_present checks (Anti-Gaming Invariant)
    await assert.rejects(
      async () => {
        await recordClaimCap.execute(
          {
            claim: 'Tautological claim',
            tabId: 'tab-1',
            category: 'CUSTOM',
            proofObligations: [{ id: 'obl-1', metric: 'element_present:body' }],
          },
          { browserTarget: dummyTarget } as any
        );
      },
      (err: any) => err.code === 'INVALID_ARGUMENT' && err.message.includes('pure DOM presence checks')
    );

    // 3b. Rejects CUSTOM claims with element.exists or dom.exists
    await assert.rejects(
      async () => {
        await recordClaimCap.execute(
          {
            claim: 'Tautological element.exists claim',
            tabId: 'tab-1',
            category: 'CUSTOM',
            proofObligations: [{ id: 'obl-1', metric: 'element.exists' }],
          },
          { browserTarget: dummyTarget } as any
        );
      },
      (err: any) => err.code === 'INVALID_ARGUMENT' && err.message.includes('pure DOM presence checks')
    );
    // 4. Rejects LAYOUT claims without expectedHeight
    await assert.rejects(
      async () => {
        await recordClaimCap.execute(
          {
            claim: 'Layout claim without height baseline',
            tabId: 'tab-1',
            category: 'LAYOUT',
          },
          { browserTarget: dummyTarget } as any
        );
      },
      (err: any) => err.code === 'INVALID_ARGUMENT' && err.message.includes('expectedHeight')
    );

    // 5. Rejects record_claim without authorized browserTarget
    await assert.rejects(
      async () => {
        await recordClaimCap.execute(
          {
            claim: 'Unbound claim',
            tabId: 'tab-1',
            category: 'CUSTOM',
            proofObligations: [{ id: 'obl-1', metric: 'element.exists' }],
          },
          {} as any
        );
      },
      (err: any) => err.code === 'TARGET_MISMATCH'
    );
  });

  test('end-to-end INTERACTION: baseline capture + differential probe rejects unchanged post-state and verifies genuine state transition', async () => {
    const catalogue = new CapabilityCatalogue({ runtime: { allowEval: true } as any, projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'rt-1' });

    let currentMutationRev = 1;
    let evalJsResponse: any = {
      selector: '.menu-toggle',
      hasActive: false,
      hasOverlay: false,
      classSnapshot: 'menu-toggle',
      url: 'https://store.example.com/',
    };

    const host = createMockHost({
      evalJs: async (expr: string) => {
        if (expr.includes('document.documentElement.scrollWidth')) return 0;
        return evalJsResponse;
      },
      getMutationRevision: () => currentMutationRev,
      bumpMutationRevision: () => ++currentMutationRev,
    });
    const port = new BrowserControlPort(host);
    port.wait = async () => ({ satisfied: true, condition: 'selector', durationMs: 5, documentGeneration: 1 });

    registerBrowserCapabilities(catalogue, port);

    const recordClaimCap = catalogue.get('anti.verification.record_claim');
    const verifyCap = catalogue.get('anti.verification.verify_claim');
    assert.ok(recordClaimCap && verifyCap);

    // 1. Record INTERACTION claim with authorized target
    // At record time: evalJs returns baseline with hasActive: false, classSnapshot: 'menu-toggle'
    const recordResult = (await recordClaimCap.execute(
      {
        claim: 'Menu toggle opens drawer',
        category: 'INTERACTION',
        tabId: 'tab-1',
        selector: '.menu-toggle',
      },
      { browserTarget: dummyTarget } as any
    )) as any;

    assert.ok(recordResult.id);
    assert.strictEqual(recordResult.targetMutationRevision, 2);
    assert.ok(recordResult.interactionBaseline);
    assert.strictEqual(recordResult.interactionBaseline.hasActive, false);
    assert.strictEqual(recordResult.interactionBaseline.classSnapshot, 'menu-toggle');

    // 2. Case A: Mutation revision advances, but DOM state is UNCHANGED from baseline
    currentMutationRev = 2; // Revision advanced, but click was a no-op
    evalJsResponse = {
      selector: '.menu-toggle',
      hasActive: false,
      hasOverlay: false,
      classSnapshot: 'menu-toggle',
      url: 'https://store.example.com/',
    };

    const unChangedResult = (await verifyCap.execute(
      { claimId: recordResult.id },
      { browserTarget: dummyTarget } as any
    )) as any;

    assert.strictEqual(unChangedResult.verdict, 'REJECTED', 'Unchanged DOM state must be REJECTED even if revision advanced');
    assert.match(
      unChangedResult.proofProfile.violations[0]?.message || '',
      /identical to pre-action baseline/
    );

    // 3. Case B: Mutation revision advances AND DOM state transitioned to active / open
    currentMutationRev = 2;
    evalJsResponse = {
      selector: '.menu-toggle',
      hasActive: true,
      hasOverlay: true,
      classSnapshot: 'menu-toggle active open',
      url: 'https://store.example.com/',
    };

    const changedResult = (await verifyCap.execute(
      { claimId: recordResult.id },
      { browserTarget: dummyTarget } as any
    )) as any;

    assert.strictEqual(changedResult.verdict, 'VERIFIED', 'Genuine state transition matching canonical obligations must be VERIFIED');
    assert.strictEqual(changedResult.proofProfile.completeness, 'FULL');
    assert.strictEqual(changedResult.proofProfile.violations.length, 0);
  });

  test('receipt-enabled verification requires invocation identity and records non-pass as completed execution', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-verification-receipts-'));
    const receipts = new ReceiptStore({ filePath: path.join(root, 'receipts.jsonl') });
    const projectId = 'project-12345678901234567890';
    const workspaceId = 'workspace-12345678901234567890';
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1 });
    const target = { ...dummyTarget, projectId, workspaceId, runtimeId: lease.runtimeId };
    const port = new BrowserControlPort(createMockHost({ inspectStyles: async () => ({ color: 'green' }) }));
    registerBrowserCapabilities(catalogue, port, undefined, () => root, receipts);
    const claim = IssueRegister.getInstance().recordVerification({
      claim: 'Receipt rejection remains a completed capability execution',
      actor: 'agent',
      scope: { tabId: 'tab-1', selector: '.cta' },
      proofObligations: [{ id: 'color', metric: 'style.color', expected: 'red', critical: true }],
      verdict: 'UNVERIFIED',
    });
    const capability = catalogue.get('anti.verification.verify_claim')!;

    const trustedContext: CapabilityRequestContext = {
      lease,
      leaseToken: lease.token,
      projectId,
      workspaceId,
      runId: 'run-receipt',
      attemptId: 'attempt-receipt',
      browserTarget: target,
      grant: 'write',
    };
    await assert.rejects(
      async () => capability.execute({ claimId: claim.id }, trustedContext),
      (err: unknown) => err instanceof Error && 'code' in err && err.code === 'MCP_CONTEXT_REQUIRED'
    );

    const makeContext = (invocationId: string): AuthenticatedCapabilityContext => ({
      attachmentId: 'binding-receipt-test',
      runId: 'run-receipt',
      attemptId: 'attempt-receipt',
      projectId,
      workspaceId,
      backendId: 'test-backend',
      hostEpoch: 1,
      invocationId,
      lease,
      leaseToken: lease.token,
      browserTarget: target,
      grant: 'write',
    });
    const first = await capability.execute({ claimId: claim.id }, makeContext('invocation-rejected-1')) as VerificationRecord;
    assert.strictEqual(first.verdict, 'REJECTED');
    assert.strictEqual(first.lifecycle?.repairAttempts, 1);
    assert.strictEqual(receipts.findByCommand('invocation-rejected-1')?.state, 'completed');
    assert.strictEqual(receipts.findByCommand('invocation-rejected-1')?.deliveryState, 'accepted-exact');

    const second = await capability.execute({ claimId: claim.id }, makeContext('invocation-rejected-2')) as VerificationRecord;
    assert.strictEqual(second.lifecycle?.repairAttempts, 2);
    assert.ok(receipts.findByCommand('invocation-rejected-1'));
    assert.ok(receipts.findByCommand('invocation-rejected-2'));
  });
});
