/**
 * Close-admission seam: a page whose close is reserved accepts no new work.
 *
 * The seam is injected (never imported) by the composition root, so every path that
 * can bind a tab — attachment mint, rebind, adopter rotation — and every path that can
 * admit work — capability dispatch, the port's background pools — is exercised here
 * against a recording implementation: what a refused admission does to existing state,
 * and what an admitted operation does to the counter a close measures.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { AttachmentRegistry, type PageCloseAdmission } from '../../src/main/run/attachment-registry';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { BrowserControlPort, PassiveExecutionPool, WaitRegistry, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import {
  CapabilityError,
  CapabilityRequestContext,
  ClientInvocationIntent,
  issueRuntimeLease,
  makeControlPlaneId,
} from '../../src/shared/control-plane-contracts';

/**
 * Recording stand-in for the close coordinator. `reserved` names the pages whose close
 * is already reserved; every admitted operation is counted, and the release decrements
 * that count, so a double release would show as a negative in-flight count rather than
 * being masked.
 */
function recordingAdmission(options?: { reserved?: string[]; applicationReserved?: boolean; refuseAdmission?: Error; throwOnRelease?: boolean }) {
  const reserved = new Set(options?.reserved ?? []);
  const counter = { began: 0, cleared: 0, inFlight: 0 };
  const admission: PageCloseAdmission = {
    // Application admission is read before the per-page reservation, so a test that is
    // about page reservation must answer `false` here to reach its own subject.
    isApplicationAdmissionReserved: () => options?.applicationReserved ?? false,
    isPageReserved: (tabId: string) => reserved.has(tabId),
    beginAdmittedOperation: () => {
      if (options?.refuseAdmission) throw options.refuseAdmission;
      counter.began++;
      counter.inFlight++;
      return () => {
        counter.cleared++;
        counter.inFlight--;
        if (options?.throwOnRelease) throw new Error('release failed');
      };
    },
  };
  return { admission, counter };
}

/** Mint an attachment bound to `tabId`, so a test only names the page it targets. */
async function mint(registry: AttachmentRegistry, tabId: string) {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
  return await registry.issueAttachment(makeControlPlaneId('run'), makeControlPlaneId('attempt'), projectId, workspaceId, {
    backendId: 'test-backend',
    lease,
    leaseToken: lease.token,
    tabId,
  });
}

/** Capture the refusal a mutation raised, so its code and details can both be asserted. */
async function refusalOf(work: () => Promise<unknown>): Promise<{ code?: string; details?: Record<string, unknown> }> {
  let refusal: { code?: string; details?: Record<string, unknown> } | undefined;
  await assert.rejects(work, (err: unknown) => {
    if (err instanceof CapabilityError) {
      refusal = { code: err.code, details: err.details };
      return true;
    }
    return false;
  });
  assert.ok(refusal, 'the refused work must fail with a typed CapabilityError');
  return refusal;
}

describe('Close admission — attachment bindings', () => {
  it('refuses to mint an attachment onto a page reserved for close', async () => {
    const registry = new AttachmentRegistry();
    registry.setCloseAdmission(recordingAdmission({ reserved: ['tab-closing'] }).admission);

    const refusal = await refusalOf(() => mint(registry, 'tab-closing'));

    assert.strictEqual(refusal.code, 'TARGET_STALE', 'a reserved page uses the existing error vocabulary');
    assert.strictEqual(refusal.details?.reservedForClose, true, 'the refusal names the reservation as its cause');
    assert.strictEqual(registry.getActiveRecordIds().size, 0, 'the refusal leaves no half-minted attachment behind');
  });

  it('mints an attachment whose page is not reserved', async () => {
    const registry = new AttachmentRegistry();
    const { admission } = recordingAdmission({ reserved: ['tab-closing'] });
    registry.setCloseAdmission(admission);

    const { record } = await mint(registry, 'tab-live');

    assert.strictEqual(record.tabId, 'tab-live');
    assert.strictEqual(registry.getActiveRecordIds().size, 1, 'the admitted binding is recorded');
  });

  it('refuses to rebind onto a page reserved for close and leaves the binding where it was', async () => {
    const registry = new AttachmentRegistry();
    const { launch } = await mint(registry, 'tab-live');
    registry.setCloseAdmission(recordingAdmission({ reserved: ['tab-closing'] }).admission);

    const refusal = await refusalOf(() => registry.updateAttachmentTab(launch.attachmentId, 'tab-closing'));

    assert.strictEqual(refusal.code, 'TARGET_STALE');
    assert.strictEqual(
      registry.getAttachment(launch.attachmentId)?.tabId,
      'tab-live',
      'the refused rebind must not move the binding onto the closing page'
    );
  });

  it('refuses to adopt authority onto a page reserved for close', async () => {
    const registry = new AttachmentRegistry();
    const { launch } = await mint(registry, 'tab-live');
    const before = registry.getAttachment(launch.attachmentId)!.authorityRevision;
    registry.setCloseAdmission(recordingAdmission({ reserved: ['tab-closing'] }).admission);

    const refusal = await refusalOf(() => registry.rotateAuthorityRevision(launch.attachmentId, { tabId: 'tab-closing' }));

    assert.strictEqual(refusal.code, 'TARGET_STALE');
    assert.strictEqual(
      registry.getAttachment(launch.attachmentId)!.authorityRevision,
      before,
      'the refused adoption must not advance authority onto the closing page'
    );
  });

  it('still settles a generation advance on the page the attachment already holds', async () => {
    // The reservation gates *new* bindings. A record already bound to the page must be
    // able to record what an already-admitted read observed, or a real operation's
    // result would turn into a refusal after the fact.
    const registry = new AttachmentRegistry();
    const { launch } = await mint(registry, 'tab-live');
    registry.setCloseAdmission(recordingAdmission({ reserved: ['tab-live'] }).admission);

    const advanced = await registry.updateAttachmentTab(launch.attachmentId, 'tab-live', 7);

    assert.ok(advanced, 'a same-page generation advance is not a new binding');
    assert.strictEqual(registry.getAttachment(launch.attachmentId)!.documentGeneration, 7);
  });

  it('refuses a binding it cannot clear when the reservation source fails', async () => {
    // An unreadable reservation is not permission to bind: the page may be mid-unload,
    // so the refusal is raised with the read failure as its reason instead of admitting
    // authority that a closing page would take with it.
    const registry = new AttachmentRegistry();
    registry.setCloseAdmission({
      isApplicationAdmissionReserved: () => false,
      isPageReserved: () => {
        throw new Error('close coordinator unavailable');
      },
      beginAdmittedOperation: () => () => {},
    });

    const refusal = await refusalOf(() => mint(registry, 'tab-live'));

    assert.strictEqual(refusal.code, 'TARGET_STALE');
    assert.strictEqual(refusal.details?.closeReservationUnreadable, true);
    assert.strictEqual(registry.getActiveRecordIds().size, 0);
  });

  it('keeps every binding path unchanged when no close admission is injected', async () => {
    const registry = new AttachmentRegistry();

    const { launch } = await mint(registry, 'tab-closing');
    const rebound = await registry.updateAttachmentTab(launch.attachmentId, 'tab-also-closing');
    const rotated = await registry.rotateAuthorityRevision(launch.attachmentId, { tabId: 'tab-third-closing' });

    assert.ok(rebound, 'rebind keeps its previous behaviour without an injected admission');
    assert.ok(rotated, 'rotation keeps its previous behaviour without an injected admission');
    assert.strictEqual(registry.getAttachment(launch.attachmentId)!.tabId, 'tab-third-closing');
  });
});

describe('Close admission — capability dispatch', () => {
  const LIVE_TABS = new Set(['tab-live']);

  async function transportFixture(
    handler: (params: Record<string, unknown>, context: CapabilityRequestContext) => unknown | Promise<unknown>,
    tabId: string = 'tab-live'
  ) {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      resolveTabId: (tabIdOrIdentifier) => (LIVE_TABS.has(tabIdOrIdentifier) ? tabIdOrIdentifier : undefined),
    });
    catalogue.register({
      name: 'test.action',
      description: 'test action',
      risk: 'read',
      inputSchema: { type: 'object' },
      policy: {
        effect: 'read',
        risk: 'read',
        requiresBrowserTarget: false,
        timeoutMs: 5_000,
        policyVersion: 1,
        schedulerLane: 'short-passive',
        duplicateMode: 'in-process-join',
        recordedVisibility: 'public',
        receiptReadPermission: 'read',
        retentionPolicy: 'run-durable',
        ownerCancellationBehavior: 'abort-immediate',
        subscriberDisconnectBehavior: 'abort-when-unobserved',
        cancellationAckTimeoutMs: 1_000,
      },
      execute: handler,
    });
    const registry = new AttachmentRegistry();
    const transport = new CapabilityTransportAdapter(catalogue, registry);
    const { launch } = await registry.issueAttachment(makeControlPlaneId('run'), makeControlPlaneId('attempt'), projectId, workspaceId, {
      backendId: 'test-backend',
      lease,
      leaseToken: lease.token,
      tabId,
      grant: 'read',
    });
    const intent: ClientInvocationIntent = {
      requestId: `req-${makeControlPlaneId('invocation')}`,
      idempotencyKey: `idem-${makeControlPlaneId('invocation')}`,
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
      name: 'test.action',
      params: {},
    };
    return { transport, intent, registry, launch };
  }

  it('registers an admitted dispatch and clears it exactly once on success', async () => {
    const { transport, intent } = await transportFixture(() => ({ value: 'executed' }));
    const { admission, counter } = recordingAdmission();
    transport.setCloseAdmission(admission);

    const response = await transport.dispatchIntent(intent);

    assert.strictEqual(response.ok, true);
    assert.deepStrictEqual(response.data, { value: 'executed' });
    assert.strictEqual(counter.began, 1, 'the dispatch registers itself with the admission gate');
    assert.strictEqual(counter.cleared, 1, 'the dispatch clears the counter exactly once');
    assert.strictEqual(counter.inFlight, 0, 'nothing is left in flight after the operation settles');
  });

  it('holds the admission while the operation runs, not only around it', async () => {
    const { admission, counter } = recordingAdmission();
    let observedDuringWork = -1;
    const { transport, intent } = await transportFixture(() => {
      observedDuringWork = counter.inFlight;
      return { value: 'executed' };
    });
    transport.setCloseAdmission(admission);

    await transport.dispatchIntent(intent);

    assert.strictEqual(observedDuringWork, 1, 'the work runs while its operation is counted as in flight');
    assert.strictEqual(counter.inFlight, 0, 'and is released when the operation settles');
  });

  it('clears the counter exactly once when the operation throws', async () => {
    const { transport, intent } = await transportFixture(() => {
      throw new CapabilityError('EXECUTION_ERROR', 'handler exploded');
    });
    const { admission, counter } = recordingAdmission();
    transport.setCloseAdmission(admission);

    const response = await transport.dispatchIntent(intent);

    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error?.code, 'EXECUTION_ERROR');
    assert.strictEqual(counter.began, 1);
    assert.strictEqual(counter.cleared, 1, 'a throwing operation still releases its admission');
    assert.strictEqual(counter.inFlight, 0);
  });

  it('clears the counter exactly once when the caller cancels the operation', async () => {
    const { transport, intent } = await transportFixture((_params, context) => {
      const aborted = Promise.withResolvers<unknown>();
      context.signal?.addEventListener('abort', () => {
        const abortErr = new Error('aborted by caller');
        abortErr.name = 'AbortError';
        aborted.reject(abortErr);
      });
      return aborted.promise;
    });
    const { admission, counter } = recordingAdmission();
    transport.setCloseAdmission(admission);
    const controller = new AbortController();

    const pending = transport.dispatchIntent(intent, { signal: controller.signal });
    await yieldToLoop();
    controller.abort();
    const response = await pending;

    assert.strictEqual(response.ok, false, 'a cancelled dispatch reports the cancellation');
    assert.strictEqual(counter.began, 1);
    assert.strictEqual(counter.cleared, 1, 'cancellation is an exit path like any other');
    assert.strictEqual(counter.inFlight, 0);
  });

  it('refuses the dispatch when the gate refuses admission', async () => {
    let handlerRan = false;
    const { transport, intent } = await transportFixture(() => {
      handlerRan = true;
      return { value: 'executed' };
    });
    const { admission, counter } = recordingAdmission({
      refuseAdmission: new CapabilityError('POLICY_DENIED', 'application admission is reserved for quit'),
    });
    transport.setCloseAdmission(admission);

    const response = await transport.dispatchIntent(intent);

    assert.strictEqual(response.ok, false, 'a refused admission is a refusal, not a success');
    assert.strictEqual(response.error?.code, 'POLICY_DENIED', 'the gate owns the refusal code');
    assert.strictEqual(handlerRan, false, 'no handler work is admitted after a refusal');
    assert.strictEqual(counter.began, 0, 'a refused admission never becomes an admitted operation');
    assert.strictEqual(counter.cleared, 0, 'a refused admission has no counter to clear');
  });

  it('refuses to dispatch against a page reserved for close', async () => {
    let handlerRan = false;
    const { transport, intent } = await transportFixture(() => {
      handlerRan = true;
      return { value: 'executed' };
    });
    transport.setCloseAdmission(recordingAdmission({ reserved: ['tab-live'] }).admission);

    const response = await transport.dispatchIntent(intent);

    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error?.code, 'TARGET_STALE');
    assert.strictEqual(handlerRan, false, 'the closing page never sees the work');
  });

  it('refuses to dispatch when the page reservation cannot be read', async () => {
    let handlerRan = false;
    const { transport, intent } = await transportFixture(() => {
      handlerRan = true;
      return { value: 'executed' };
    });
    transport.setCloseAdmission({
      isApplicationAdmissionReserved: () => false,
      isPageReserved: () => {
        throw new Error('close coordinator unavailable');
      },
      beginAdmittedOperation: () => () => {},
    });

    const response = await transport.dispatchIntent(intent);

    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error?.code, 'TARGET_STALE');
    assert.strictEqual(handlerRan, false, 'an unreadable reservation never admits the work');
  });

  it('keeps the operation result when releasing the admission itself fails', async () => {
    const { transport, intent } = await transportFixture(() => ({ value: 'executed' }));
    const { admission, counter } = recordingAdmission({ throwOnRelease: true });
    transport.setCloseAdmission(admission);

    const response = await transport.dispatchIntent(intent);

    assert.strictEqual(response.ok, true, 'a failing release must not rewrite the operation outcome');
    assert.deepStrictEqual(response.data, { value: 'executed' });
    assert.strictEqual(counter.cleared, 1);
  });

  it('leaves dispatch unchanged when no close admission is injected', async () => {
    const { transport, intent } = await transportFixture(() => ({ value: 'executed' }));

    const response = await transport.dispatchIntent(intent);

    assert.strictEqual(response.ok, true);
    assert.deepStrictEqual(response.data, { value: 'executed' });
  });
});

describe('Close admission — port in-flight accounting', () => {
  it('refuses pool work on a reserved page and admits it on a free page', async () => {
    const pool = new PassiveExecutionPool();
    const { admission, counter } = recordingAdmission({ reserved: ['tab-closing'] });
    pool.setCloseAdmission(admission);
    let ran = false;

    const refusal = await refusalOf(() =>
      pool.execute('tab-closing', async () => {
        ran = true;
        return 'done';
      })
    );

    assert.strictEqual(refusal.code, 'TARGET_STALE');
    assert.strictEqual(refusal.details?.reservedForClose, true);
    assert.strictEqual(ran, false, 'the refusal happens before the work is admitted');
    assert.strictEqual(pool.getGlobalActiveCount(), 0, 'a refused operation is never counted as in flight');
    assert.strictEqual(counter.began, 0, 'a refused operation never registers');

    const result = await pool.execute('tab-live', async () => 'done');
    assert.strictEqual(result, 'done');
    assert.strictEqual(counter.began, 1);
    assert.strictEqual(counter.cleared, 1);
    assert.strictEqual(counter.inFlight, 0);
  });

  it('clears the passive pool counter exactly once on the throwing path too', async () => {
    const pool = new PassiveExecutionPool();
    const { admission, counter } = recordingAdmission();
    pool.setCloseAdmission(admission);
    let countedDuringThrowingWork = -1;

    await pool.execute('tab-live', async () => 'ok');
    await assert.rejects(
      () =>
        pool.execute('tab-live', async () => {
          countedDuringThrowingWork = pool.getGlobalActiveCount();
          throw new CapabilityError('EXECUTION_ERROR', 'pool action failed');
        }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'EXECUTION_ERROR'
    );

    assert.strictEqual(countedDuringThrowingWork, 1, 'the pool counts the work while it runs');
    assert.strictEqual(counter.began, 2);
    assert.strictEqual(counter.cleared, 2, 'every admitted operation releases its own admission');
    assert.strictEqual(counter.inFlight, 0);
    assert.strictEqual(pool.getGlobalActiveCount(), 0, 'the pool counters agree with the admission counter');
    assert.strictEqual(pool.getActiveTabCount('tab-live'), 0);
  });

  it('accounts for wait-registry work and releases it when the wait aborts', async () => {
    const registry = new WaitRegistry();
    const { admission, counter } = recordingAdmission({ reserved: ['tab-closing'] });
    registry.setCloseAdmission(admission);

    const refusal = await refusalOf(() => registry.execute('tab-closing', async () => 'waited'));
    assert.strictEqual(refusal.code, 'TARGET_STALE');

    const controller = new AbortController();
    const pending = registry.execute(
      'tab-live',
      (signal) => {
        const aborted = Promise.withResolvers<string>();
        signal.addEventListener('abort', () => aborted.reject(new CapabilityError('WAIT_ABORTED', 'wait aborted')));
        return aborted.promise;
      },
      { signal: controller.signal }
    );
    controller.abort();

    await assert.rejects(pending, (err: unknown) => err instanceof CapabilityError && err.code === 'WAIT_ABORTED');
    assert.strictEqual(counter.began, 1, 'only the admitted wait registered');
    assert.strictEqual(counter.cleared, 1, 'the aborted wait released its admission');
    assert.strictEqual(counter.inFlight, 0);
    assert.strictEqual(registry.getGlobalActiveCount(), 0);
  });

  it('governs the port pools with the admission injected on the port', async () => {
    const host: BrowserHostPort = {
      getTabList: () => [],
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => '',
      evalJs: async () => null,
    };
    const port = new BrowserControlPort(host);
    const { admission } = recordingAdmission({ reserved: ['tab-closing'] });
    port.setCloseAdmission(admission);

    await assert.rejects(
      () => port.passivePool.execute('tab-closing', async () => 'never'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );

    const portWithoutAdmission = new BrowserControlPort(host);
    assert.strictEqual(
      await portWithoutAdmission.passivePool.execute('tab-closing', async () => 'admitted'),
      'admitted',
      'without an injected admission the port keeps its previous behaviour'
    );
  });
});
