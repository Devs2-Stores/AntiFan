import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { dispositionFor } from '../../src/main/qa/qa-state';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';
import { ThemeQaWorkflow, type ThemeQaWorkflowPorts } from '../../src/main/qa/theme-qa-workflow';

describe('ANTI_BOT_CHALLENGE classification', () => {
  const challenge = new CapabilityError('ANTI_BOT_CHALLENGE', 'The site answered with a bot-verification page', { host: 'shopee.vn', path: '/verify/traffic' });

  it('is a hard block on read surfaces, never retried, rebound or degraded', () => {
    assert.strictEqual(dispositionFor(challenge, 'read'), 'HARD_BLOCK');
  });

  it('stays a hard block on write surfaces', () => {
    assert.strictEqual(dispositionFor(challenge, 'write'), 'HARD_BLOCK');
  });

  it('is not folded into the stale-target recovery class', () => {
    const stale = new CapabilityError('TARGET_STALE', 'stale', { cause: 'navigated-away', canRebind: true });
    assert.strictEqual(dispositionFor(stale, 'read'), 'AUTO_RECOVER');
    assert.notStrictEqual(dispositionFor(challenge, 'read'), dispositionFor(stale, 'read'));
  });

  it('aborts a QA run instead of grading the challenge page as a storefront', async () => {
    const target: BrowserTarget = {
      projectId: 'proj-test',
      workspaceId: 'ws-test',
      runtimeId: 'rt-test',
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };
    const browser: Record<string, unknown> = {
      dom: async () => '<html><body>verify</body></html>',
      screenshot: async () => ({ artifactRef: { id: 'art-screenshot', kind: 'screenshot' }, envelope: {} }),
      eval: async () => {
        throw challenge;
      },
      diagnostics: () => ({ console: [], failures: [] }),
      listTabs: () => [{ id: 'tab-1', url: 'https://shopee.vn/verify/traffic' }],
      getDocumentGeneration: () => 1,
      settleCapture: async () => ({
        settleComplete: true,
        gates: { network: true, fonts: true, images: true, dom: true },
        timingsMs: { network: 1, fonts: 1, images: 1, dom: 1, total: 4 },
        brokenImages: [],
      }),
    };
    const ports: ThemeQaWorkflowPorts = {
      browser: browser as unknown as ThemeQaWorkflowPorts['browser'],
      artifacts: {
        stage: (item: { kind: string; data: Buffer | string }) => ({ id: `art-${item.kind}`, kind: item.kind, bytes: 1, createdAt: Date.now() }),
        readBytesById: () => ({ data: Buffer.from('<html></html>') }),
      } as unknown as ThemeQaWorkflowPorts['artifacts'],
      reload: async (t: BrowserTarget) => ({ reloaded: true, target: t }),
    };
    await assert.rejects(
      new ThemeQaWorkflow(ports).validate({
        runId: 'run-bot',
        attemptId: 'att-bot',
        workspaceRoot: 'E:/Work/test-theme',
        target,
        profile: 'audit',
      }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ANTI_BOT_CHALLENGE',
    );
  });
});
