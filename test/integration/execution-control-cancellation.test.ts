import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import {
  makeControlPlaneId,
  CapabilityEffectPolicyInput,
} from '../../src/shared/control-plane-contracts';

class TypedAbortError extends Error {
  readonly code = 'ABORTED';
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

describe('ExecutionControl & Cancellation Integration Suite (Phase 1)', () => {
  it('bridges AbortSignal end-to-end to capability context and classifies settlement truthfully', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-exec-cancellation-'));
    try {
      const projectId = makeControlPlaneId('project');
      const workspaceId = makeControlPlaneId('workspace');
      const projectDir = path.join(dataRoot, 'project-root');
      fs.mkdirSync(projectDir, { recursive: true });

      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        allowEval: false,
      });
      runtime.workspaces.ensureInitialWorkspace(projectId, workspaceId, projectDir, dataRoot);

      let handlerReceivedSignal = false;
      let handlerAbortedObserved = false;
      const { promise: handlerStarted, resolve: markHandlerStarted } = Promise.withResolvers<void>();

      const testReadPolicy: CapabilityEffectPolicyInput = {
        effect: 'read',
        risk: 'read',
        requiresBrowserTarget: false,
        schedulerLane: 'short-passive',
        duplicateMode: 'in-process-join',
        recordedVisibility: 'tenant-scoped',
        receiptReadPermission: 'read',
        timeoutMs: 30000,
        retentionPolicy: 'run-durable',
        ownerCancellationBehavior: 'abort-immediate',
        subscriberDisconnectBehavior: 'abort-when-unobserved',
        cancellationAckTimeoutMs: 5000,
        policyVersion: 1,
      };

      runtime.capabilities.register({
        name: 'test.cancellable_read',
        description: 'Test read capability that respects context.signal',
        risk: 'read',
        policy: testReadPolicy,
        inputSchema: { type: 'object' },
        execute: async (_params, context) => {
          if (context.signal) {
            handlerReceivedSignal = true;
          }
          const { promise, reject } = Promise.withResolvers<{ done: boolean }>();

          if (context.signal) {
            if (context.signal.aborted) {
              handlerAbortedObserved = true;
              reject(new TypedAbortError('Aborted immediately'));
              return promise;
            }
            context.signal.addEventListener('abort', () => {
              handlerAbortedObserved = true;
              reject(new TypedAbortError('Aborted in flight'));
            }, { once: true });
          }

          // Signal that handler is active and listening
          markHandlerStarted();
          return promise;
        },
      });

      const { promise: mutationStarted, resolve: markMutationStarted } = Promise.withResolvers<void>();

      const testInteractivePolicy: CapabilityEffectPolicyInput = {
        effect: 'interactive-effect',
        risk: 'write',
        requiresBrowserTarget: false,
        schedulerLane: 'unbounded',
        duplicateMode: 'reject-concurrent',
        recordedVisibility: 'tenant-scoped',
        receiptReadPermission: 'write',
        timeoutMs: 30000,
        retentionPolicy: 'run-durable',
        ownerCancellationBehavior: 'abort-immediate',
        subscriberDisconnectBehavior: 'abort-when-unobserved',
        cancellationAckTimeoutMs: 5000,
        policyVersion: 1,
      };

      runtime.capabilities.register({
        name: 'test.cancellable_interactive',
        description: 'Test interactive capability that commits partial effect before abortion',
        risk: 'write',
        policy: testInteractivePolicy,
        inputSchema: { type: 'object' },
        execute: async (_params, context) => {
          // Mark effect started (DOM mutation initiated)
          context.control?.setEffectStage('effect-started');
          markMutationStarted();

          const { promise, reject } = Promise.withResolvers<{ done: boolean }>();
          if (context.signal) {
            context.signal.addEventListener('abort', () => {
              reject(new TypedAbortError('Mutation interrupted mid-flight'));
            }, { once: true });
          }
          return promise;
        },
      });

      const transport = new CapabilityTransportAdapter(runtime.capabilities, runtime.runs.attachments);

      const session = await runtime.createCliSession({
        projectId,
        workspaceId,
        backendId: 'cli',
        grant: 'write',
      });

      const launch = session.launch;

      // ─── Test 1: In-flight Cancellation of Read (Settles as 'interrupted') ───
      const abortController1 = new AbortController();
      const dispatchPromise1 = transport.dispatchIntent(
        {
          requestId: makeControlPlaneId('request'),
          idempotencyKey: 'idem-cancel-in-flight-1',
          attachmentId: launch.attachmentId,
          attachmentSecret: launch.secret,
          authorityRevision: launch.authorityRevision,
          name: 'test.cancellable_read',
          params: {},
        },
        { signal: abortController1.signal }
      );

      await handlerStarted;
      abortController1.abort();

      const response1 = await dispatchPromise1;

      assert.strictEqual(response1.ok, false, 'Dispatched read intent should settle with ok: false when aborted');
      assert.strictEqual(handlerReceivedSignal, true, 'Handler must receive context.signal from transport');
      assert.strictEqual(handlerAbortedObserved, true, 'Handler must observe abort event on context.signal');
      assert.strictEqual(response1.error?.code, 'ABORTED', 'Error code must be ABORTED');

      // ─── Test 2: Pre-aborted Signal ───
      const preAbortedController = new AbortController();
      preAbortedController.abort();

      const preAbortedResponse = await transport.dispatchIntent(
        {
          requestId: makeControlPlaneId('request'),
          idempotencyKey: 'idem-cancel-pre-aborted-2',
          attachmentId: launch.attachmentId,
          attachmentSecret: launch.secret,
          authorityRevision: launch.authorityRevision,
          name: 'test.cancellable_read',
          params: {},
        },
        { signal: preAbortedController.signal }
      );
      assert.strictEqual(preAbortedResponse.ok, false, 'Pre-aborted intent must immediately fail');
      assert.strictEqual(preAbortedResponse.error?.code, 'ABORTED', 'Error code must be ABORTED for pre-aborted dispatch');
      // ─── Test 3: Interactive Mutation Aborted Mid-Effect (Settles with indeterminate state 'unknown') ───
      const abortController3 = new AbortController();
      const dispatchPromise3 = transport.dispatchIntent(
        {
          requestId: makeControlPlaneId('request'),
          idempotencyKey: 'idem-cancel-interactive-3',
          attachmentId: launch.attachmentId,
          attachmentSecret: launch.secret,
          authorityRevision: launch.authorityRevision,
          name: 'test.cancellable_interactive',
          params: {},
        },
        { signal: abortController3.signal }
      );

      await mutationStarted;
      abortController3.abort();

      const response3 = await dispatchPromise3;

      assert.strictEqual(response3.ok, false, 'Aborted interactive mutation must fail');
      assert.strictEqual(response3.error?.code, 'ABORTED');
      assert.ok(
        response3.error?.message.includes('indeterminate effect state'),
        'Error message must indicate indeterminate effect state to prevent blind retries'
      );
    } finally {
      try {
        fs.rmSync(dataRoot, { recursive: true, force: true });
      } catch {}
    }
  });
});
