import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import type { TerminalManager } from '../../src/main/browser/terminal-manager';
import {
  registerTerminalCapabilities,
  planTerminalWaitTimeout,
  TERMINAL_WAIT_BUDGET_MS,
  TERMINAL_WAIT_MAX_TIMEOUT_MS,
  type TerminalOwnershipPort,
  type TerminalWaitTimedOutResult,
} from '../../src/main/tools/terminal-capabilities';
import { CapabilityError, issueRuntimeLease, type TerminalWaitInput, type TerminalWaitResult } from '../../src/shared/control-plane-contracts';

const projectId = 'project-22222222-2222-4222-8222-222222222222';
const workspaceId = 'workspace-22222222-2222-4222-8222-222222222222';
const lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);

const unboundContext = { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' as const };
const attachmentContext = {
  attachmentId: 'att-1',
  runId: 'run-1',
  attemptId: 'att-run-1',
  projectId,
  workspaceId,
  backendId: 'backend-1',
  hostEpoch: 1,
  invocationId: 'inv-1',
  lease,
  leaseToken: lease.token,
  grant: 'write' as const,
};

const newCatalogue = () => new CapabilityCatalogue({
  runtime: { mode: 'standalone', lifecycle: 'active' },
  projectId,
  workspaceId,
  runtimeId: lease.runtimeId,
  hostEpoch: 1,
  getActiveLease: () => lease,
});

/** The members of the terminal manager the wait and create capabilities touch. */
function facadeWith(members: Record<string, unknown>): TerminalManager {
  return { getSession: () => undefined, ...members } as unknown as TerminalManager;
}

describe('terminal.wait stays inside its invocation budget', () => {
  it('plans the call deadline below the execution deadline and reports when the request was shortened', () => {
    assert.ok(TERMINAL_WAIT_MAX_TIMEOUT_MS < TERMINAL_WAIT_BUDGET_MS);
    assert.deepEqual(planTerminalWaitTimeout(undefined), { timeoutMs: TERMINAL_WAIT_MAX_TIMEOUT_MS, clamped: false });
    assert.deepEqual(planTerminalWaitTimeout(5_000), { timeoutMs: 5_000, clamped: false });
    assert.deepEqual(planTerminalWaitTimeout(TERMINAL_WAIT_MAX_TIMEOUT_MS), { timeoutMs: TERMINAL_WAIT_MAX_TIMEOUT_MS, clamped: false });
    assert.deepEqual(planTerminalWaitTimeout(120_000), { timeoutMs: TERMINAL_WAIT_MAX_TIMEOUT_MS, clamped: true });
  });

  it('declares the execution budget plus the cancellation ack as the capability policy', () => {
    const catalogue = newCatalogue();
    registerTerminalCapabilities(catalogue, facadeWith({}));
    const policy = catalogue.getPolicy('terminal.wait');
    const ack = policy?.cancellationAckTimeoutMs as number;
    assert.ok(ack > 0);
    assert.equal(policy?.timeoutMs, TERMINAL_WAIT_BUDGET_MS + ack);
    // The transport aborts a call at policy.timeoutMs - cancellationAckTimeoutMs: the wait's own maximum must finish before that.
    assert.ok(TERMINAL_WAIT_MAX_TIMEOUT_MS < (policy?.timeoutMs as number) - ack);
  });

  it('gives terminal.create an execution deadline as long as the queued-reuse wait it hides behind', () => {
    const catalogue = newCatalogue();
    registerTerminalCapabilities(catalogue, facadeWith({}));
    const policy = catalogue.getPolicy('terminal.create');
    const deadline = (policy?.timeoutMs as number) - (policy?.cancellationAckTimeoutMs as number);
    assert.equal(deadline, 15_000);
  });

  it('shortens a longer request and answers timedOut with the cursor instead of an error', async () => {
    const seen: TerminalWaitInput[] = [];
    const facade = facadeWith({
      waitTerminal: async (input: TerminalWaitInput): Promise<TerminalWaitResult> => {
        seen.push(input);
        throw new CapabilityError('WAIT_TIMEOUT', `Terminal wait timed out after ${input.timeoutMs}ms`, {
          sessionId: input.sessionId,
          lastSeq: 42,
          sessionGeneration: 3,
          outputTail: 'still building',
        });
      },
    });
    const catalogue = newCatalogue();
    registerTerminalCapabilities(catalogue, facade);
    const capability = catalogue.get('terminal.wait');
    assert.ok(capability);
    const result = (await capability.execute({ sessionId: 's1', condition: 'output-match', pattern: 'done', timeoutMs: 300_000 }, unboundContext)) as TerminalWaitTimedOutResult;
    assert.equal(seen[0]!.timeoutMs, TERMINAL_WAIT_MAX_TIMEOUT_MS, 'the manager must run with the shortened deadline so it answers before the platform aborts');
    assert.equal(result.satisfied, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.lastSeq, 42);
    assert.equal(result.sessionGeneration, 3);
    assert.equal(result.requestedTimeoutMs, 300_000);
    assert.equal(result.maxTimeoutMs, TERMINAL_WAIT_MAX_TIMEOUT_MS);
    assert.equal(result.outputTail, 'still building');
    assert.ok(result.message.includes(String(TERMINAL_WAIT_MAX_TIMEOUT_MS)), result.message);
    assert.ok(result.message.includes('afterSeq=42'), result.message);
  });

  it('a deadline inside the cap that elapses is still the caller\'s own WAIT_TIMEOUT', async () => {
    const facade = facadeWith({
      waitTerminal: async (input: TerminalWaitInput) => {
        throw new CapabilityError('WAIT_TIMEOUT', `Terminal wait timed out after ${input.timeoutMs}ms`, { lastSeq: 1 });
      },
    });
    const catalogue = newCatalogue();
    registerTerminalCapabilities(catalogue, facade);
    const capability = catalogue.get('terminal.wait');
    assert.ok(capability);
    await assert.rejects(
      () => Promise.resolve(capability.execute({ sessionId: 's1', condition: 'exit', timeoutMs: 1_000 }, unboundContext)),
      (error: unknown) => error instanceof CapabilityError && error.code === 'WAIT_TIMEOUT'
    );
  });

  it('a satisfied wait passes through untouched', async () => {
    const facade = facadeWith({
      waitTerminal: async (input: TerminalWaitInput): Promise<TerminalWaitResult> => ({ satisfied: true, sessionGeneration: 1, lastSeq: 7, outputTail: input.pattern }),
    });
    const catalogue = newCatalogue();
    registerTerminalCapabilities(catalogue, facade);
    const capability = catalogue.get('terminal.wait');
    assert.ok(capability);
    const result = (await capability.execute({ sessionId: 's1', condition: 'output-match', pattern: 'ok', timeoutMs: 90_000 }, unboundContext)) as TerminalWaitResult;
    assert.equal(result.satisfied, true);
    assert.equal(result.lastSeq, 7);
  });
});

describe('terminal.create on a dead bound tab', () => {
  it('names the cause and the way to rebind', async () => {
    const facade = facadeWith({
      getSession: (id: string) => (id === 'terminal-home' ? { id, state: 'running' } : undefined),
      createSplitSession: async () => {
        throw new Error('no pane may be created for a dead tab');
      },
    });
    const ownership: TerminalOwnershipPort = {
      ownerTabId: () => 'tab-dead',
      homeTerminalId: () => 'terminal-home',
      isHomeSplit: () => false,
      tabAffiliation: () => ({ live: false }),
    };
    const catalogue = newCatalogue();
    registerTerminalCapabilities(catalogue, facade, ownership);
    const capability = catalogue.get('terminal.create');
    assert.ok(capability);
    await assert.rejects(
      () => Promise.resolve(capability.execute({}, attachmentContext)),
      (error: unknown) => {
        assert.ok(error instanceof CapabilityError);
        assert.equal(error.code, 'TARGET_STALE');
        assert.equal(error.details?.tabId, 'tab-dead');
        assert.equal(error.details?.cause, 'unowned');
        assert.equal(error.details?.canRebind, true);
        assert.equal(error.details?.recovery, 'anti.browser.tabs.list then anti.browser.rebind_target');
        return true;
      }
    );
  });
});
