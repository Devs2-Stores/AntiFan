import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { evaluateDeviceReadiness } from '../../src/main/device/device-readiness';
import {
  assertExactDeviceTarget,
  CapabilityEffectPolicyInput,
  CapabilityError,
  CapabilityRequestContext,
  issueRuntimeLease,
  makeControlPlaneId,
  type DeviceBinding,
} from '../../src/shared/control-plane-contracts';
import type { DeviceInfo, DeviceTarget } from '../../src/shared/device-control-contracts';

/**
 * Invariants that make the device surface safe to expose:
 *   1. a device target is validated against the HOST's live binding, so a stale epoch (attachment
 *      changed) or a stale session generation (session recreated) fails closed instead of driving
 *      the wrong device state;
 *   2. the two staleness kinds stay distinguishable, because they need different recovery;
 *   3. a rendering-surface capability may gate on a device target, not only on a browser tab;
 *   4. unknown readiness never blocks automation, a failed gate always does.
 */

function devicePolicy(overrides: Partial<CapabilityEffectPolicyInput> = {}): CapabilityEffectPolicyInput {
  return {
    effect: 'interactive-effect',
    risk: 'write',
    requiresBrowserTarget: false,
    requiresDeviceTarget: true,
    schedulerLane: 'viewport-gate',
    duplicateMode: 'in-process-join',
    recordedVisibility: 'tenant-scoped',
    receiptReadPermission: 'write',
    timeoutMs: 15_000,
    retentionPolicy: 'run-durable',
    ownerCancellationBehavior: 'drain-and-persist',
    subscriberDisconnectBehavior: 'detach-and-continue',
    cancellationAckTimeoutMs: 5_000,
    policyVersion: 1,
    ...overrides,
  };
}

const DEVICE_MODEL: DeviceInfo = {
  deviceId: 'UDID-1',
  name: 'Test iPhone',
  model: 'iPhone15,3',
  osVersion: '18.5',
  connection: 'usb',
  paired: true,
  trusted: false,
  automationReady: true,
};

function deviceTarget(overrides: Partial<DeviceTarget> = {}): DeviceTarget {
  const binding: DeviceBinding = {
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    runtimeId: 'runtime-1',
    deviceId: 'UDID-1',
    deviceEpoch: 3,
    sessionId: 'SESSION-1',
    sessionGeneration: 2,
  };
  return {
    ...binding,
    platform: 'ios',
    osVersion: '18.5',
    model: 'iPhone15,3',
    connection: 'usb',
    screen: { width: 1179, height: 2556, scale: 3 },
    viewport: { width: 393, height: 852, scale: 3 },
    viewportSource: 'panel-derived',
    ...overrides,
  };
}

describe('device target authority', () => {
  it('rejects a target whose attachment epoch is behind the host binding, and says it is rebindable', () => {
    const stale = deviceTarget({ deviceEpoch: 2 });
    assert.throws(
      () => assertExactDeviceTarget(stale, { projectId: 'project-1', workspaceId: 'workspace-1', runtimeId: 'runtime-1', deviceId: 'UDID-1', deviceEpoch: 3, sessionGeneration: 2, sessionId: 'SESSION-1' }),
      (error: unknown) => {
        assert.ok(error instanceof CapabilityError);
        assert.equal(error.code, 'DEVICE_TARGET_STALE');
        assert.equal((error.details as Record<string, unknown>)?.expectedDeviceEpoch, 3);
        assert.equal((error.details as Record<string, unknown>)?.actualDeviceEpoch, 2);
        assert.equal((error.details as Record<string, unknown>)?.canRebind, true);
        return true;
      }
    );
  });

  it('reports a recreated session separately from a changed attachment', () => {
    const staleSession = deviceTarget({ sessionGeneration: 1 });
    assert.throws(
      () => assertExactDeviceTarget(staleSession, { projectId: 'project-1', workspaceId: 'workspace-1', runtimeId: 'runtime-1', deviceId: 'UDID-1', deviceEpoch: 3, sessionGeneration: 2, sessionId: 'SESSION-1' }),
      (error: unknown) => {
        assert.ok(error instanceof CapabilityError);
        const details = error.details as Record<string, unknown>;
        // The device epoch matched, so only the session dimension may be reported: a WDA restart on
        // an attached phone must not be reported as a lost device.
        assert.equal(details?.expectedDeviceEpoch, undefined);
        assert.equal(details?.expectedSessionGeneration, 2);
        assert.equal(details?.actualSessionGeneration, 1);
        return true;
      }
    );
  });

  it('requires a session for operations that act on one, and allows a sessionless target only when asked', () => {
    const sessionless = deviceTarget({ sessionId: undefined });
    const ownership = { projectId: 'project-1', workspaceId: 'workspace-1', runtimeId: 'runtime-1', deviceId: 'UDID-1' };
    assert.throws(() => assertExactDeviceTarget(sessionless, ownership), (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_REQUIRED');
    assert.equal(assertExactDeviceTarget(sessionless, ownership, { allowMissingSession: true }), sessionless);
    assert.throws(() => assertExactDeviceTarget(undefined, ownership), (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_REQUIRED');
    assert.throws(
      () => assertExactDeviceTarget(deviceTarget({ workspaceId: 'other-workspace' }), ownership, { allowMissingSession: true }),
      (error: unknown) => error instanceof CapabilityError && error.code === 'WORKSPACE_MISMATCH'
    );
  });

  it('refuses a target that names a different device on the same host', () => {
    const ownership = { projectId: 'project-1', workspaceId: 'workspace-1', runtimeId: 'runtime-1', deviceId: 'UDID-1' };
    // Same epoch, same generation, same tenant — only the physical identity differs, which is exactly
    // the two-phones-attached case that per-device epochs cannot catch on their own.
    assert.throws(
      () => assertExactDeviceTarget(deviceTarget({ deviceId: 'UDID-2' }), { ...ownership, deviceId: 'UDID-1', deviceEpoch: 3, sessionGeneration: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof CapabilityError);
        assert.equal(error.code, 'DEVICE_TARGET_STALE');
        assert.equal((error.details as Record<string, unknown>)?.expectedDeviceId, 'UDID-1');
        assert.equal((error.details as Record<string, unknown>)?.actualDeviceId, 'UDID-2');
        return true;
      }
    );
    assert.equal(
      assertExactDeviceTarget(deviceTarget(), { ...ownership, deviceId: 'UDID-1', deviceEpoch: 3, sessionGeneration: 2 }).deviceId,
      'UDID-1'
    );
  });

  it('refuses a stale device target at dispatch time and runs the capability on the live one', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const live: DeviceBinding = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      deviceId: 'UDID-1',
      deviceEpoch: 3,
      sessionId: 'SESSION-1',
      sessionGeneration: 2,
    };
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getDeviceBinding: () => live,
    });

    const taps: Array<{ x: number; y: number }> = [];
    catalogue.register({
      name: 'device.tap',
      description: 'test double for the device tap capability',
      risk: 'write',
      requiresDeviceTarget: true,
      policy: devicePolicy(),
      inputSchema: { type: 'object' },
      execute: (params: { x: number; y: number }) => {
        taps.push(params);
        return { ok: true };
      },
    });

    const base = { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' as const };
    const liveTarget = deviceTarget({ projectId, workspaceId, runtimeId: lease.runtimeId });
    await assert.rejects(
      () => catalogue.dispatch('device.tap', { x: 10, y: 20 }, { ...base, deviceTarget: { ...liveTarget, deviceEpoch: 2 } } as CapabilityRequestContext),
      (error: unknown) => error instanceof CapabilityError && error.code === 'DEVICE_TARGET_STALE'
    );
    await assert.rejects(
      () => catalogue.dispatch('device.tap', { x: 10, y: 20 }, { ...base, deviceTarget: { ...liveTarget, sessionGeneration: 1 } } as CapabilityRequestContext),
      (error: unknown) => error instanceof CapabilityError && error.code === 'DEVICE_TARGET_STALE'
    );

    const result = await catalogue.dispatch('device.tap', { x: 10, y: 20 }, { ...base, deviceTarget: liveTarget } as CapabilityRequestContext);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(taps, [{ x: 10, y: 20 }]);
  });

  it('permits a sessionless target only for the capability that establishes the session', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const live: DeviceBinding = { projectId, workspaceId, runtimeId: lease.runtimeId, deviceId: 'UDID-1', deviceEpoch: 1, sessionGeneration: 0 };
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getDeviceBinding: () => live,
    });
    let opened = 0;
    catalogue.register({
      name: 'device.open_safari',
      description: 'test double for the session-establishing capability',
      risk: 'write',
      requiresDeviceTarget: true,
      allowMissingDeviceSession: true,
      policy: devicePolicy({ duplicateMode: 'reject-concurrent' }),
      inputSchema: { type: 'object' },
      execute: () => { opened += 1; return { ok: true }; },
    });
    catalogue.register({
      name: 'device.navigate',
      description: 'test double for a session-bound capability',
      risk: 'write',
      requiresDeviceTarget: true,
      policy: devicePolicy({ effect: 'idempotent-write' }),
      inputSchema: { type: 'object' },
      execute: () => ({ ok: true }),
    });

    const base = { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' as const };
    const sessionless = deviceTarget({ projectId, workspaceId, runtimeId: lease.runtimeId, deviceEpoch: 1, sessionGeneration: 0, sessionId: undefined });

    assert.deepEqual(await catalogue.dispatch('device.open_safari', {}, { ...base, deviceTarget: sessionless } as CapabilityRequestContext), { ok: true });
    assert.equal(opened, 1);
    await assert.rejects(
      () => catalogue.dispatch('device.navigate', { url: 'https://example.com' }, { ...base, deviceTarget: sessionless } as CapabilityRequestContext),
      (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_REQUIRED'
    );
  });

  it('gates a rendering-surface capability on a device target while still refusing one with no authority at all', () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1 });

    catalogue.register({
      name: 'device.tap',
      description: 'device capability on the viewport gate',
      risk: 'write',
      requiresDeviceTarget: true,
      policy: devicePolicy(),
      inputSchema: { type: 'object' },
      execute: () => ({ ok: true }),
    });
    assert.equal(catalogue.getPolicy('device.tap')?.requiresDeviceTarget, true);

    assert.throws(
      () => catalogue.register({
        name: 'broken.viewport-gate',
        description: 'viewport-gate with neither a browser nor a device target',
        risk: 'write',
        policy: devicePolicy({ requiresDeviceTarget: false }),
        inputSchema: { type: 'object' },
        execute: () => ({ ok: true }),
      }),
      /requires neither a browser nor a device target/
    );

    assert.throws(
      () => catalogue.register({
        name: 'broken.device-mismatch',
        description: 'definition and policy disagree about the device authority',
        risk: 'write',
        requiresDeviceTarget: true,
        policy: devicePolicy({ requiresDeviceTarget: false, schedulerLane: 'unbounded' }),
        inputSchema: { type: 'object' },
        execute: () => ({ ok: true }),
      }),
      /requiresDeviceTarget 'true' does not match policy 'false'/
    );
  });
});

describe('device readiness milestones', () => {
  it('lets unknown gates through and blocks on a failed gate', () => {
    const ready = evaluateDeviceReadiness({ device: DEVICE_MODEL, wdaStatus: { ready: true, raw: {} } });
    // developerMode / uiAutomation are not passively observable, so they stay unknown; that must not
    // block the automation milestone, or every working device would report as unusable.
    assert.equal(ready.developerMode.status, 'unknown');
    assert.equal(ready.uiAutomation.status, 'unknown');
    assert.equal(ready.automationReady, true);
    assert.equal(ready.inspectionReady, false, 'inspection must not be claimed without an inspector probe');

    const wdaDown = evaluateDeviceReadiness({ device: DEVICE_MODEL, transportFailure: { code: 'ECONNREFUSED', detail: 'nothing answered 127.0.0.1:8100' } });
    assert.equal(wdaDown.wda.status, 'fail');
    assert.equal(wdaDown.automationReady, false);
    assert.ok(wdaDown.wda.action, 'a failed gate must carry an operator action');
  });

  it('reports a device-less host as not connected rather than hardware-broken', () => {
    const noDevice = evaluateDeviceReadiness({ transportFailure: { code: 'DEVICE_NOT_CONNECTED', detail: 'usbmuxd enumerated 0 device(s)' } });
    assert.equal(noDevice.physical.status, 'fail');
    assert.equal(noDevice.automationReady, false);
    assert.match(String(noDevice.physical.action), /USB|network/i);
  });
});
