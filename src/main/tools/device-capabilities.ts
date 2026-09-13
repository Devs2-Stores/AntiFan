import {
  CapabilityEffectPolicyInput,
  CapabilityError,
  CapabilityRequestContext,
  CapabilityRisk,
  type DeviceBinding,
} from '../../shared/control-plane-contracts';
import type { DeviceControlPort } from '../device/device-control-port';
import type { CapabilityCatalogue } from './capability-catalogue';

/**
 * Device capability family: ten primitives, the whole Tier-2 surface.
 *
 * Scope is deliberate. There is no `device.dom`, `device.eval`, `device.css`, `device.console` or
 * `device.network`: those require Safari's Web Inspector plus Remote Automation, which is a separate
 * milestone with its own readiness gates. Publishing them now would promise inspection the transport
 * cannot deliver, and a confident empty answer is worse than a refusal.
 *
 * Transport reality encoded here (verified against WebDriverAgent source, not assumed):
 *   - `navigate` is a deep-link open that never waits for load. `wait` therefore reports a rendering
 *     heuristic, not a load guarantee, and no URL predicate exists because there is no URL readback.
 *   - `reload` re-opens the last URL this adapter navigated to, because WDA exposes no refresh route.
 *   - `screenshot` is a real-device capture (WebDriverAgent renders it in-process), which is the whole
 *     point of a Tier-2 gate: it is the same pixels a human would see on the panel.
 */

function makeDevicePolicy(options: {
  effect: CapabilityEffectPolicyInput['effect'];
  risk: CapabilityRisk;
  requiresDeviceTarget?: boolean;
  lane?: CapabilityEffectPolicyInput['schedulerLane'];
  timeoutMs?: number;
  duplicateMode?: CapabilityEffectPolicyInput['duplicateMode'];
}): CapabilityEffectPolicyInput {
  // Every capability in this family acts on the device surface, so the device requirement defaults ON
  // and only `device.list` opts out (enumeration must work before anything is bound). Getting this
  // backwards is not cosmetic: the catalogue refuses to register a definition whose policy disagrees.
  const requiresDeviceTarget = options.requiresDeviceTarget !== false;
  const defaultLane = requiresDeviceTarget ? (options.risk === 'read' ? 'short-passive' : 'viewport-gate') : 'unbounded';
  const timeoutMs = options.timeoutMs || 30_000;
  return {
    effect: options.effect,
    risk: options.risk,
    requiresBrowserTarget: false,
    requiresDeviceTarget,
    schedulerLane: options.lane || defaultLane,
    duplicateMode: options.duplicateMode || 'in-process-join',
    recordedVisibility: 'tenant-scoped',
    receiptReadPermission: options.risk,
    timeoutMs,
    retentionPolicy: 'run-durable',
    ownerCancellationBehavior: options.effect === 'read' ? 'abort-immediate' : 'drain-and-persist',
    subscriberDisconnectBehavior: options.effect === 'read' ? 'abort-when-unobserved' : 'detach-and-continue',
    cancellationAckTimeoutMs: Math.min(timeoutMs, 5_000),
    policyVersion: 1,
  };
}

/** The catalogue resolves this from the adapter's live binding; it is never caller-supplied. */
function requireOperation(context: CapabilityRequestContext, capability: string): DeviceBinding {
  const operation = context.deviceOperation;
  if (!operation) {
    throw new CapabilityError('TARGET_REQUIRED', `${capability} has no resolved device operation binding; register a device adapter and retry`, {
      canRebind: true,
    });
  }
  return operation;
}

function numberParam(value: unknown, capability: string, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CapabilityError('INVALID_ARGUMENT', `${capability} requires a finite numeric '${name}'`);
  }
  return value;
}

function stringParam(value: unknown, capability: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CapabilityError('INVALID_ARGUMENT', `${capability} requires a non-empty '${name}'`);
  }
  return value.trim();
}

export function registerDeviceCapabilities(catalogue: CapabilityCatalogue, device: DeviceControlPort): void {
  catalogue.register({
    name: 'device.list',
    description: 'List iOS devices attached to this host (enumerated live over the USB multiplexer)',
    risk: 'read',
    requiresDeviceTarget: false,
    policy: makeDevicePolicy({ effect: 'read', risk: 'read', requiresDeviceTarget: false }),
    inputSchema: { type: 'object', properties: {} },
    execute: () => device.list(),
  });

  catalogue.register({
    name: 'device.status',
    description: 'Read device readiness gates (attachment, trust, Developer Mode, UI Automation, WebDriverAgent) and the current binding; never fails on absence so it can distinguish "not set up" from "broken"',
    risk: 'read',
    // Diagnostic entry point: it must answer precisely when nothing is attached, which is the only time
    // the answer matters. A supplied deviceTarget is still validated against the live binding.
    requiresDeviceTarget: false,
    allowMissingDeviceSession: true,
    policy: makeDevicePolicy({ effect: 'read', risk: 'read', requiresDeviceTarget: false, lane: 'unbounded' }),
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string', description: 'Device UDID; omit when exactly one device is attached' } },
    },
    execute: (params: { deviceId?: string }) => device.status(params?.deviceId?.trim() ?? ''),
  });

  catalogue.register({
    name: 'device.open_safari',
    description: 'Establish the Safari automation surface on the device (ensure the WebDriverAgent session) and return the bound device target; optionally deep-link to a url',
    risk: 'write',
    // Resolves its own device from enumeration, so a host with no phone attached gets the adapter's
    // DEVICE_NOT_CONNECTED (with USB remediation) instead of a target complaint.
    requiresDeviceTarget: false,
    allowMissingDeviceSession: true,
    policy: makeDevicePolicy({ effect: 'idempotent-write', risk: 'write', requiresDeviceTarget: false, duplicateMode: 'reject-concurrent', timeoutMs: 120_000 }),
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device UDID; omit when exactly one device is attached' },
        url: { type: 'string', description: 'Optional url to open on the device (deep-link; no load wait)' },
      },
    },
    execute: async (params: { deviceId?: string; url?: string }) => device.openSafari(params?.deviceId?.trim() ?? '', params?.url ? { initialUrl: params.url } : undefined),
  });

  catalogue.register({
    name: 'device.navigate',
    description: 'Open a url on the real device in Safari (WebDriverAgent deep-link: returns immediately, never waits for load; follow with device.wait when a settled page matters)',
    risk: 'write',
    requiresDeviceTarget: true,
    policy: makeDevicePolicy({ effect: 'idempotent-write', risk: 'write' }),
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    execute: (params: { url?: string }, context) => device.navigate(requireOperation(context, 'device.navigate'), stringParam(params?.url, 'device.navigate', 'url')),
  });

  catalogue.register({
    name: 'device.reload',
    description: 'Re-open the last url this adapter navigated to (WebDriverAgent exposes no refresh route and no URL readback, so reload is refused when no url is remembered)',
    risk: 'write',
    requiresDeviceTarget: true,
    policy: makeDevicePolicy({ effect: 'idempotent-write', risk: 'write' }),
    inputSchema: { type: 'object', properties: {} },
    execute: (_params: Record<string, unknown>, context) => device.reload(requireOperation(context, 'device.reload')),
  });

  catalogue.register({
    name: 'device.screenshot',
    description: 'Capture real-device screenshot evidence (the actual panel pixels a human would see) and stage it in the artifact store as a Tier-2 receipt',
    risk: 'read',
    requiresDeviceTarget: true,
    policy: makeDevicePolicy({ effect: 'read', risk: 'read' }),
    inputSchema: { type: 'object', properties: {} },
    execute: (_params: Record<string, unknown>, context) =>
      device.screenshot(requireOperation(context, 'device.screenshot'), {
        runId: context.runId || 'run-unbound',
        attemptId: context.attemptId || 'attempt-unbound',
        projectId: context.projectId,
        workspaceId: context.workspaceId,
        // No leaseToken: this is unleased staging, matching browser.screenshot. An exclusive evidence
        // lease is held only when a caller explicitly acquired one (artifact.preflight) and threads
        // its token — the runtime lease token is a different authority and must never be forwarded
        // here, because the artifact store would (correctly) reject it as an expired evidence lease.
      }),
  });

  catalogue.register({
    name: 'device.tap',
    description: 'Tap a point on the device panel (coordinates are CSS points, the same space as the device viewport, not raw pixels)',
    risk: 'write',
    requiresDeviceTarget: true,
    policy: makeDevicePolicy({ effect: 'interactive-effect', risk: 'write' }),
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
    execute: (params: { x?: number; y?: number }, context) =>
      device.tap(requireOperation(context, 'device.tap'), {
        x: numberParam(params?.x, 'device.tap', 'x'),
        y: numberParam(params?.y, 'device.tap', 'y'),
      }),
  });

  catalogue.register({
    name: 'device.swipe',
    description: 'Swipe on the device panel with a native gesture (the device produces real momentum scrolling; nothing is emulated)',
    risk: 'write',
    requiresDeviceTarget: true,
    policy: makeDevicePolicy({ effect: 'interactive-effect', risk: 'write' }),
    inputSchema: {
      type: 'object',
      properties: {
        x1: { type: 'number' },
        y1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        durationMs: { type: 'number' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
    execute: (params: { x1?: number; y1?: number; x2?: number; y2?: number; durationMs?: number }, context) =>
      device.swipe(requireOperation(context, 'device.swipe'), {
        x1: numberParam(params?.x1, 'device.swipe', 'x1'),
        y1: numberParam(params?.y1, 'device.swipe', 'y1'),
        x2: numberParam(params?.x2, 'device.swipe', 'x2'),
        y2: numberParam(params?.y2, 'device.swipe', 'y2'),
        durationMs: typeof params?.durationMs === 'number' ? params.durationMs : undefined,
      }),
  });

  catalogue.register({
    name: 'device.type',
    description: 'Type text through the native keyboard into the currently focused field (tap the input first; WebDriverAgent types into the active element)',
    risk: 'write',
    requiresDeviceTarget: true,
    policy: makeDevicePolicy({ effect: 'interactive-effect', risk: 'write' }),
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: (params: { text?: string }, context) =>
      device.type(requireOperation(context, 'device.type'), stringParam(params?.text, 'device.type', 'text')),
  });

  catalogue.register({
    name: 'device.wait',
    description: "Wait for a real device: 'timeout' sleeps, 'page_loaded'/'stable' sample frames until rendering stops changing (a rendering heuristic — this transport has no network-idle signal and no URL readback)",
    risk: 'read',
    requiresDeviceTarget: true,
    policy: makeDevicePolicy({ effect: 'read', risk: 'read', lane: 'event-wait', timeoutMs: 60_000 }),
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['timeout', 'page_loaded', 'stable'] },
        value: { type: 'number', description: "Milliseconds for type 'timeout'" },
        timeoutMs: { type: 'number' },
      },
      required: ['type'],
    },
    execute: (params: { type?: 'timeout' | 'page_loaded' | 'stable'; value?: number; timeoutMs?: number }, context) => {
      const binding = requireOperation(context, 'device.wait');
      if (params?.type === 'timeout') {
        return device.wait(binding, { type: 'timeout', value: numberParam(params?.value, 'device.wait', 'value') });
      }
      if (params?.type === 'page_loaded' || params?.type === 'stable') {
        return device.wait(binding, { type: params.type, timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined });
      }
      throw new CapabilityError('INVALID_ARGUMENT', "device.wait requires type 'timeout', 'page_loaded' or 'stable'");
    },
  });
}
