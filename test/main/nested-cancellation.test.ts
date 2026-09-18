import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { InvocationLedger } from '../../src/main/session/invocation-ledger';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import {
  AuthenticatedCapabilityContext,
  CapabilityError,
  ClientInvocationIntent,
  issueRuntimeLease,
  makeControlPlaneId,
} from '../../src/shared/control-plane-contracts';

/**
 * Regression coverage for nested-execution semantics:
 *  - a parent invocation's own deadline abort must reach an in-flight child
 *    through the unioned signal (not just caller-level aborts);
 *  - a dead parent must not mint new child work (admission gate);
 *  - the child must settle a terminal ledger receipt — never 'completed' under
 *    a dead parent.
 */

const CHILD_HANG = 'test.nested-cancel.hang-child';
const PARENT_TIMEOUT = 'test.nested-cancel.parent-timeout';
const PARENT_LATE_CHILD = 'test.nested-cancel.parent-late-child';

function basePolicy(overrides: Record<string, unknown> = {}) {
  return {
    effect: 'read',
    risk: 'read',
    requiresBrowserTarget: false,
    schedulerLane: 'unbounded',
    duplicateMode: 'in-process-join',
    recordedVisibility: 'public',
    receiptReadPermission: 'read',
    timeoutMs: 30_000,
    retentionPolicy: 'run-durable',
    ownerCancellationBehavior: 'abort-immediate',
    subscriberDisconnectBehavior: 'abort-when-unobserved',
    cancellationAckTimeoutMs: 100,
    policyVersion: 1,
    ...overrides,
  } as never;
}

async function waitForTerminalRecord(
  ledger: InvocationLedger,
  invocationId: string,
  timeoutMs = 4_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = ledger.getRecord(invocationId);
    if (rec && ['completed', 'failed', 'interrupted', 'unknown'].includes(rec.state)) {
      return rec.state;
    }
    if (Date.now() > deadline) {
      return rec ? `nonterminal:${rec.state}` : 'missing';
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('nested invocation cancellation', () => {
  it('parent deadline aborts the in-flight child and the child settles interrupted/unknown', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-nested-cancel-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });

    let childInvocationId: string | undefined;
    let childSawAbort = false;

    catalogue.register({
      name: CHILD_HANG,
      description: 'Hangs until its execution signal aborts',
      risk: 'read',
      requiresBrowserTarget: false,
      inputSchema: { type: 'object', properties: {} },
      policy: basePolicy(),
      execute: async (_params, rawContext) => {
        const context = rawContext as AuthenticatedCapabilityContext;
        childInvocationId = context.invocationId;
        await new Promise<never>((_resolve, reject) => {
          const signal = context.signal;
          if (!signal) return; // never resolves — regression: child would hang forever
          if (signal.aborted) {
            childSawAbort = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              childSawAbort = true;
              reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
            },
            { once: true }
          );
        });
        return { unreachable: true };
      },
    });

    catalogue.register({
      name: PARENT_TIMEOUT,
      description: 'Dispatches one hanging child; its own budget expires while the child is in flight',
      risk: 'write',
      requiresBrowserTarget: false,
      inputSchema: { type: 'object', properties: {} },
      policy: basePolicy({
        effect: 'idempotent-write',
        risk: 'write',
        // The scenario is "the parent deadline aborts an in-flight child", so the only
        // requirement is that the child dispatch lands before the budget expires. A tight
        // budget measured wall-clock scheduling instead: under the lane's parallel file
        // execution the handler was still awaiting its turn at 150ms, so the child was never
        // dispatched and the test failed on load rather than on behavior.
        timeoutMs: 1_500,
      }),
      execute: async (_params, rawContext) => {
        const context = rawContext as AuthenticatedCapabilityContext;
        const resp = await context.dispatchChildIntent!({
          stepId: 's1',
          attempt: 0,
          intent: { name: CHILD_HANG, params: {} } as unknown as ClientInvocationIntent,
        });
        if (!resp.ok) {
          throw new CapabilityError(
            (resp.error?.code as never) || 'EXECUTION_ERROR',
            resp.error?.message || 'child failed'
          );
        }
        return resp.data;
      },
    });

    const registry = new AttachmentRegistry(undefined, root);
    const ledger = new InvocationLedger({ dataRoot: root });
    await ledger.initialize();
    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      grant: 'write',
      lease,
      leaseToken: lease.token,
    });

    const resp = await transport.dispatchIntent({
      requestId: makeControlPlaneId('request'),
      idempotencyKey: `test:${makeControlPlaneId('request')}`,
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
      name: PARENT_TIMEOUT,
      params: {},
    });

    // The parent must not report success: either the deadline classified it or
    // the response is the bounded pending-cleanup receipt.
    assert.strictEqual(resp.ok, false, `parent must not succeed, got ${JSON.stringify(resp)}`);
    assert.ok(
      ['EXECUTION_TIMEOUT', 'EXECUTION_TIMEOUT_PENDING_CLEANUP', 'ABORTED', 'TRANSACTION_CONFLICT'].includes(
        resp.error?.code || ''
      ),
      `unexpected parent error code ${resp.error?.code}`
    );

    // The child must have been dispatched, must have observed the abort through
    // the unioned signal, and must settle a terminal receipt — never completed.
    assert.ok(childInvocationId, 'child was never dispatched');
    assert.ok(childSawAbort, 'child never observed the parent deadline abort');
    await ledger.drain();
    const childState = await waitForTerminalRecord(ledger, childInvocationId!);
    assert.ok(
      childState === 'interrupted' || childState === 'unknown',
      `child settled '${childState}', expected interrupted|unknown`
    );
  });

  it('dead parent cannot mint new child work after abort (admission gate)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-nested-gate-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });

    let childRan = false;
    let lateDispatchError: string | undefined;

    catalogue.register({
      name: CHILD_HANG,
      description: 'Marks if it ever runs',
      risk: 'read',
      requiresBrowserTarget: false,
      inputSchema: { type: 'object', properties: {} },
      policy: basePolicy(),
      execute: async () => {
        childRan = true;
        return { ran: true };
      },
    });

    catalogue.register({
      name: PARENT_LATE_CHILD,
      description: 'Waits for its own abort, then tries to mint a child',
      risk: 'write',
      requiresBrowserTarget: false,
      inputSchema: { type: 'object', properties: {} },
      policy: basePolicy({
        effect: 'idempotent-write',
        risk: 'write',
        // Same headroom as the sibling case: the handler has to be running when its own
        // deadline fires, and that is a scheduling fact, not the behavior under test.
        timeoutMs: 1_200,
      }),
      execute: async (_params, rawContext) => {
        const context = rawContext as AuthenticatedCapabilityContext;
        // Wait until the parent deadline fires.
        const { promise: abortSeen, resolve: markAbortSeen } = Promise.withResolvers<void>();
        const signal = context.signal;
        if (!signal || signal.aborted) markAbortSeen();
        else signal.addEventListener('abort', () => markAbortSeen(), { once: true });
        await abortSeen;
        // Parent is dead — this must be refused by the admission gate.
        try {
          await context.dispatchChildIntent!({
            stepId: 'late',
            attempt: 0,
            intent: { name: CHILD_HANG, params: {} } as unknown as ClientInvocationIntent,
          });
        } catch (err) {
          lateDispatchError = (err as { code?: string }).code || String(err);
        }
        throw new CapabilityError('EXECUTION_ERROR', 'parent finished after abort');
      },
    });

    const registry = new AttachmentRegistry(undefined, root);
    const ledger = new InvocationLedger({ dataRoot: root });
    await ledger.initialize();
    const transport = new CapabilityTransportAdapter(catalogue, registry, ledger);

    const { launch } = await registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      grant: 'write',
      lease,
      leaseToken: lease.token,
    });

    const resp = await transport.dispatchIntent({
      requestId: makeControlPlaneId('request'),
      idempotencyKey: `test:${makeControlPlaneId('request')}`,
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
      name: PARENT_LATE_CHILD,
      params: {},
    });

    assert.strictEqual(resp.ok, false);
    assert.strictEqual(
      lateDispatchError,
      'TRANSACTION_CONFLICT',
      `late child dispatch must be refused, got ${lateDispatchError}`
    );
    assert.strictEqual(childRan, false, 'a dead parent minted new child work');
    await ledger.drain();
  });
});
