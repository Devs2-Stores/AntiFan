import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget, ArtifactRef } from '../../src/shared/control-plane-contracts';
import { IssueRegister } from '../../src/main/session/issue-register';

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
        tabId: 'tab-1',
        selector: '.hero',
        proofObligations: [{ id: 'obl-1', metric: 'element.exists' }],
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
          { claim: '   ', tabId: 'tab-1' },
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
          { claim: 'Valid claim with too many obligations', tabId: 'tab-1', proofObligations: tooManyObligations },
          { browserTarget: dummyTarget } as any
        );
      },
      (err: any) => err.code === 'INVALID_ARGUMENT' && err.message.includes('Exceeded maximum of 50')
    );
  });
});
