import { setTimeout as delay } from 'node:timers/promises';
import { CapabilityError, type ArtifactRef } from '../../shared/control-plane-contracts';
import {
  DEVICE_ERROR_REMEDIATION,
  type DeviceActionResult,
  type DeviceBinding,
  type DeviceInfo,
  type DevicePoint,
  type DeviceSwipe,
  type DeviceTarget,
  type DeviceWaitCondition,
  type DeviceWaitResult,
} from '../../shared/device-control-contracts';
import type {
  DeviceArtifactRunContext,
  DeviceArtifactSink,
  DeviceControlPort,
  DeviceRegistryPort,
  DeviceStatusResult,
  WdaScreenInfo,
  WdaTransport,
} from './device-control-port';
import { IosSessionManager } from './ios-session-manager';
import { listUsbmuxDevices } from './usbmux-client';
import { createUsbmuxPortForwarder, type UsbmuxPortForwarder } from './usbmux-forwarder';
import { assertDeviceAutomationReady, evaluateDeviceReadiness } from './device-readiness';
import { createWdaTransport, describeWdaFailure, probeWdaCandidates, readWdaScreenInfo, readWdaStatus } from './wda-rest-client';

/**
 * iOS device adapter: the physical phone as a peer execution surface beside the browser port.
 *
 * Transport reality this adapter is built around (read from WebDriverAgent source, not assumed):
 *   - WDA is reached over plain HTTP, either through a host port forward or the device's own network
 *     address. No Appium server sits in this path.
 *   - `POST /session/:id/url` is a deep-link open with no load wait and no URL readback, so nothing
 *     here treats "navigate returned" as "page loaded".
 *   - WDA has no refresh route: `reload` re-opens the last URL this adapter navigated to and is
 *     refused outright when no such URL is known.
 *   - `/wda/screen` reports panel pixels and scale; Safari's live layout viewport is only measurable
 *     by the page itself, so the reported viewport is marked `panel-derived`.
 */

const DEFAULT_CANDIDATES = ['http://127.0.0.1:8100'];
const TRANSPORT_CACHE_MS = 30_000;
const SETTLE_SAMPLE_MS = 700;
const SETTLE_STABLE_DELTA = 0.01;
const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

export interface IosDeviceAdapterOptions {
  devices: DeviceRegistryPort;
  artifacts?: DeviceArtifactSink;
  /** WDA base URLs to try, in order. Defaults to ANTIFAN_WDA_URL / ANTIFAN_WDA_CANDIDATES, then localhost:8100. */
  candidates?: string[];
  /**
   * Port the runner listens on *on the phone*, bridged over usbmux when no candidate answers.
   * Defaults to ANTIFAN_WDA_DEVICE_PORT, then 8100.
   */
  wdaDevicePort?: number;
  defaultTimeoutMs?: number;
}

function readCandidateEnv(): string[] {
  const configured = process.env.ANTIFAN_WDA_URL || process.env.ANTIFAN_WDA_CANDIDATES || '';
  const parsed = configured.split(',').map((value) => value.trim()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_CANDIDATES;
}

function isPng(buffer: Buffer): boolean {
  if (buffer.length < 24) return false;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

function elementIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const jsonwp = record.ELEMENT;
  const w3c = record['element-6066-11e4-a52e-4f735466cecf'];
  if (typeof jsonwp === 'string' && jsonwp) return jsonwp;
  if (typeof w3c === 'string' && w3c) return w3c;
  return undefined;
}

function sessionIsGone(message: string): boolean {
  return /invalid session|session is either terminated|not started|no such session/i.test(message);
}

export class IosDeviceAdapter implements DeviceControlPort {
  private readonly devices: DeviceRegistryPort;
  private readonly artifacts?: DeviceArtifactSink;
  private readonly candidates: string[];
  /**
   * Bridging the device port is a self-contained default, never a second guess: it applies only while the
   * candidate list is this adapter's own default. An explicit list — or ANTIFAN_WDA_URL / _CANDIDATES —
   * means the caller has decided how to reach the runner, so a failure there is reported as a failure.
   */
  private readonly allowBridge: boolean;
  private readonly defaultTimeoutMs: number;
  private readonly wdaDevicePort: number;
  private readonly sessions = new IosSessionManager();
  private cachedTransport?: { baseUrl: string; transport: WdaTransport; checkedAt: number };
  private bridgedForwarder?: UsbmuxPortForwarder;
  private lastUrl?: string;
  /** Per-device work chains: a physical panel executes one operation at a time. */
  private readonly deviceLocks = new Map<string, Promise<unknown>>();

  constructor(options: IosDeviceAdapterOptions) {
    this.devices = options.devices;
    this.artifacts = options.artifacts;
    this.candidates = options.candidates && options.candidates.length ? options.candidates : readCandidateEnv();
    const envConfigured = Boolean(process.env.ANTIFAN_WDA_URL || process.env.ANTIFAN_WDA_CANDIDATES);
    this.allowBridge = !(options.candidates && options.candidates.length) && !envConfigured;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    const envPort = Number(process.env.ANTIFAN_WDA_DEVICE_PORT ?? '');
    this.wdaDevicePort = options.wdaDevicePort ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : 8100);
  }

  async list(): Promise<DeviceInfo[]> {
    return this.devices.refresh();
  }

  async status(deviceId: string): Promise<DeviceStatusResult> {
    let devices: DeviceInfo[];
    let enumerationFailure: { code: string; detail: string } | undefined;
    try {
      devices = await this.devices.refresh();
    } catch (err) {
      devices = [];
      enumerationFailure = { code: 'DEVICE_TRANSPORT_UNREACHABLE', detail: err instanceof Error ? err.message : String(err) };
    }

    const info = deviceId ? devices.find((entry) => entry.deviceId === deviceId) : devices[0];
    if (deviceId && !info) {
      throw new CapabilityError('DEVICE_NOT_CONNECTED', `Device '${deviceId}' is not visible to the host (usbmuxd enumerated ${devices.length} device(s))`, {
        remediation: DEVICE_ERROR_REMEDIATION.DEVICE_NOT_CONNECTED,
      });
    }
    if (info) this.devices.select(info.deviceId);

    let transportFailure = enumerationFailure;
    if (!info && !transportFailure) {
      transportFailure = { code: 'DEVICE_NOT_CONNECTED', detail: `usbmuxd enumerated ${devices.length} device(s)` };
    }

    let statusPayload;
    let screen: WdaScreenInfo | undefined;
    if (info) {
      try {
        const transport = await this.resolveTransport();
        statusPayload = await readWdaStatus(transport, this.defaultTimeoutMs);
        screen = await readWdaScreenInfo(transport, this.defaultTimeoutMs);
      } catch (err) {
        transportFailure = { code: 'DEVICE_TRANSPORT_UNREACHABLE', detail: err instanceof Error ? err.message : String(err) };
      }
    }

    const readiness = evaluateDeviceReadiness({ device: info, wdaStatus: statusPayload, transportFailure });
    if (!info) return { readiness };

    // A target is returned even without a session: it is the rebind handle that lets a caller ask for
    // Safari automation on this device, and it carries the attachment epoch that makes staleness
    // detectable. Only its `sessionId` is absent until `openSafari` establishes one.
    const binding = this.devices.getBinding(info.deviceId);
    return { device: info, readiness, target: binding ? this.buildTarget(info, screen, binding) : undefined };
  }

  async openSafari(deviceId: string, options?: { initialUrl?: string }): Promise<DeviceTarget> {
    // Resolve the concrete device BEFORE locking so session establishment and every later operation on
    // that device share one work chain. Locking on `''`/a wildcard would let an auto-targeted call and
    // an explicitly targeted one run concurrently, which is exactly how a second `POST /session` would
    // kill the first caller's session.
    const resolvedDeviceId = await this.resolveDeviceId(deviceId);
    return this.withDeviceLock(resolvedDeviceId, () => this.establishSafariSession(resolvedDeviceId, options));
  }

  /** Names the device a call is about, or fails with the accurate absence error. */
  private async resolveDeviceId(deviceId: string): Promise<string> {
    const devices = await this.devices.refresh();
    const info = deviceId ? devices.find((entry) => entry.deviceId === deviceId) : devices[0];
    if (!info) {
      throw new CapabilityError('DEVICE_NOT_CONNECTED', `No device to open Safari on (usbmuxd enumerated ${devices.length} device(s))`, {
        remediation: DEVICE_ERROR_REMEDIATION.DEVICE_NOT_CONNECTED,
      });
    }
    this.devices.select(info.deviceId);
    return info.deviceId;
  }

  private async establishSafariSession(deviceId: string, options?: { initialUrl?: string }): Promise<DeviceTarget> {
    // Re-read enumeration inside the lock: the attachment can change while waiting for it.
    const devices = await this.devices.refresh();
    const info = devices.find((entry) => entry.deviceId === deviceId);
    if (!info) {
      throw new CapabilityError('DEVICE_NOT_CONNECTED', `Device '${deviceId}' disappeared before Safari could be opened`, {
        remediation: DEVICE_ERROR_REMEDIATION.DEVICE_NOT_CONNECTED,
      });
    }
    this.devices.select(info.deviceId);

    const transport = await this.resolveTransport();
    const statusPayload = await readWdaStatus(transport, this.defaultTimeoutMs);
    assertDeviceAutomationReady(evaluateDeviceReadiness({ device: info, wdaStatus: statusPayload }));

    const screen = await readWdaScreenInfo(transport, this.defaultTimeoutMs);
    const session = await this.sessions.ensureSafariSession(transport, { initialUrl: options?.initialUrl, osVersion: info.osVersion });
    if (options?.initialUrl) this.lastUrl = options.initialUrl;
    this.devices.setSession(info.deviceId, session.sessionId, session.generation);
    console.log(`[antifan:device] Safari session ${session.sessionId} (generation ${session.generation}) on ${info.model || info.deviceId}`);

    const binding = this.devices.getBinding(info.deviceId);
    if (!binding) {
      throw new CapabilityError('DEVICE_NOT_CONNECTED', `Device '${info.deviceId}' disappeared while opening Safari`, {
        remediation: DEVICE_ERROR_REMEDIATION.DEVICE_NOT_CONNECTED,
      });
    }
    return this.buildTarget(info, screen, binding);
  }

  async navigate(target: DeviceBinding, url: string): Promise<DeviceActionResult> {
    const startedAt = Date.now();
    await this.sendToSession(target, 'POST', '/url', { url });
    this.lastUrl = url;
    return {
      ok: true,
      ms: Date.now() - startedAt,
      note: 'deep-link open: WebDriverAgent does not wait for load and exposes no URL readback, follow with device.wait when a settled page matters',
    };
  }

  async reload(target: DeviceBinding): Promise<DeviceActionResult> {
    if (!this.lastUrl) {
      throw new CapabilityError(
        'DEVICE_OPERATION_UNSUPPORTED',
        'WebDriverAgent exposes no refresh route and no URL readback, so reload needs a URL this adapter navigated to earlier; open Safari with a url (device.open_safari) or call device.navigate first',
        { remediation: DEVICE_ERROR_REMEDIATION.DEVICE_OPERATION_UNSUPPORTED }
      );
    }
    const startedAt = Date.now();
    await this.sendToSession(target, 'POST', '/url', { url: this.lastUrl });
    return { ok: true, ms: Date.now() - startedAt, note: `re-opened ${this.lastUrl} (no refresh route exists on this transport)` };
  }

  async screenshot(target: DeviceBinding, context: DeviceArtifactRunContext): Promise<ArtifactRef> {
    return this.withDeviceLock(target.deviceId, () => this.screenshotLocked(target, context));
  }

  private async screenshotLocked(target: DeviceBinding, context: DeviceArtifactRunContext): Promise<ArtifactRef> {
    const sessionId = this.requireSession(target);
    const transport = await this.transportFor(target);
    const response = await transport.request('GET', `/session/${sessionId}/screenshot`, undefined, this.defaultTimeoutMs);
    if (!response.ok) {
      const message = describeWdaFailure(response);
      this.noteFailure(message);
      throw new CapabilityError('DEVICE_SESSION_FAILED', `Real-device screenshot failed: ${message}`, {
        remediation: DEVICE_ERROR_REMEDIATION.DEVICE_SESSION_FAILED,
      });
    }
    const base64 = (response.json as { value?: unknown } | undefined)?.value;
    if (typeof base64 !== 'string' || base64.length === 0) {
      throw new CapabilityError('DEVICE_SESSION_FAILED', 'Real-device screenshot payload was empty');
    }
    const buffer = Buffer.from(base64, 'base64');
    if (!isPng(buffer)) {
      throw new CapabilityError('DEVICE_SESSION_FAILED', `Real-device screenshot payload was not a PNG (${buffer.length} bytes)`);
    }
    if (!this.artifacts) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', 'device artifact sink unavailable: cannot stage real-device evidence');
    }
    const input = {
      kind: 'screenshot' as const,
      mime: 'image/png',
      data: buffer,
      runId: context.runId,
      attemptId: context.attemptId,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      leaseToken: context.leaseToken,
      // A device panel PNG *is* the evidence: refuse an oversized payload rather than storing a
      // truncated file that still claims `mime: 'image/png'`. 32 MiB clears a 3x Retina capture of a
      // long page with headroom and stays inside the store's per-artifact ceiling.
      maxBytes: 32 * 1024 * 1024,
      overflowMode: 'reject' as const,
    };
    return this.artifacts.stageAsync ? this.artifacts.stageAsync(input) : this.artifacts.stage(input);
  }

  async tap(target: DeviceBinding, point: DevicePoint): Promise<DeviceActionResult> {
    const startedAt = Date.now();
    await this.sendToSession(target, 'POST', '/actions', {
      actions: [{
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: point.x, y: point.y },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 80 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    return { ok: true, ms: Date.now() - startedAt };
  }

  async swipe(target: DeviceBinding, gesture: DeviceSwipe): Promise<DeviceActionResult> {
    const startedAt = Date.now();
    await this.sendToSession(target, 'POST', '/actions', {
      actions: [{
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: gesture.x1, y: gesture.y1 },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 40 },
          { type: 'pointerMove', duration: gesture.durationMs ?? 300, x: gesture.x2, y: gesture.y2 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    return { ok: true, ms: Date.now() - startedAt, note: 'native gesture: momentum scrolling is produced by the device, not emulated' };
  }

  async type(target: DeviceBinding, text: string): Promise<DeviceActionResult> {
    return this.withDeviceLock(target.deviceId, () => this.typeLocked(target, text));
  }

  private async typeLocked(target: DeviceBinding, text: string): Promise<DeviceActionResult> {
    const sessionId = this.requireSession(target);
    const transport = await this.transportFor(target);
    const active = await transport.request('GET', `/session/${sessionId}/element/active`, undefined, this.defaultTimeoutMs);
    const focused = active.ok ? elementIdOf((active.json as { value?: unknown } | undefined)?.value) : undefined;
    if (!focused) {
      throw new CapabilityError(
        'DEVICE_OPERATION_UNSUPPORTED',
        'No focused field on the device: WebDriverAgent types into the active element, so tap the input first (device.tap)',
        { remediation: DEVICE_ERROR_REMEDIATION.DEVICE_OPERATION_UNSUPPORTED }
      );
    }
    const startedAt = Date.now();
    const response = await transport.request('POST', `/session/${sessionId}/element/${focused}/value`, { value: [text] }, this.defaultTimeoutMs);
    if (!response.ok) {
      const message = describeWdaFailure(response);
      this.noteFailure(message);
      throw new CapabilityError('DEVICE_SESSION_FAILED', `Typing on the device failed: ${message}`);
    }
    return { ok: true, ms: Date.now() - startedAt, note: 'typed through the native keyboard into the focused element' };
  }

  async wait(target: DeviceBinding, condition: DeviceWaitCondition): Promise<DeviceWaitResult> {
    return this.withDeviceLock(target.deviceId, () => this.waitLocked(target, condition));
  }

  private async waitLocked(target: DeviceBinding, condition: DeviceWaitCondition): Promise<DeviceWaitResult> {
    if (condition.type === 'timeout') {
      const ms = Math.max(0, condition.value);
      await delay(ms);
      return { type: 'timeout', waitedMs: ms, settled: true, heuristic: 'explicit delay' };
    }

    const budgetMs = Math.max(1_000, condition.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
    const deadline = Date.now() + budgetMs;
    let previousBytes: number | undefined;
    let previousDelta = Number.POSITIVE_INFINITY;

    while (Date.now() < deadline) {
      const sessionId = this.requireSession(target);
      const transport = await this.transportFor(target);
      const response = await transport.request('GET', `/session/${sessionId}/screenshot`, undefined, this.defaultTimeoutMs);
      if (!response.ok) {
        const message = describeWdaFailure(response);
        this.noteFailure(message);
        throw new CapabilityError('DEVICE_SESSION_FAILED', `Cannot sample the device render: ${message}`);
      }
      const base64 = (response.json as { value?: unknown } | undefined)?.value;
      const bytes = typeof base64 === 'string' ? base64.length : 0;
      if (previousBytes !== undefined) {
        previousDelta = Math.abs(bytes - previousBytes) / Math.max(previousBytes, 1);
        // Two consecutive near-identical frames mean the paint stopped changing. This is a rendering
        // heuristic, not a load signal: this transport has no network-idle observation.
        if (previousDelta <= SETTLE_STABLE_DELTA) {
          return {
            type: condition.type,
            waitedMs: budgetMs - Math.max(0, deadline - Date.now()),
            settled: true,
            heuristic: `frame size stable within ${(SETTLE_STABLE_DELTA * 100).toFixed(1)}% across two samples`,
          };
        }
      }
      previousBytes = bytes;
      await delay(SETTLE_SAMPLE_MS);
    }

    return {
      type: condition.type,
      waitedMs: budgetMs,
      settled: false,
      heuristic: `frames still changing after ${budgetMs}ms (last delta ${Number.isFinite(previousDelta) ? (previousDelta * 100).toFixed(1) : 'n/a'}%)`,
    };
  }

  /**
   * Serializes work per device.
   *
   * WebDriverAgent tears down the active session when a new one is created (`POST /session` kills the
   * previous session and waits for teardown), so two concurrent session-establishing calls would leave
   * the first caller driving a dead sessionId. `schedulerLane` and `duplicateMode` are policy metadata
   * that nothing in the dispatcher enforces — the browser side takes its real mutual exclusion from
   * `ViewportGate.withLock`, and the device side must own its own.
   */
  private withDeviceLock<T>(deviceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.deviceLocks.get(deviceId) ?? Promise.resolve();
    // Run `work` whichever way the previous op settled: one failed tap must not wedge the device.
    const next = previous.then(work, work);
    const settled = next.then(() => undefined, () => undefined);
    this.deviceLocks.set(deviceId, settled);
    void settled.then(() => {
      // Release the chain when this is still the tail, so the map does not grow per device forever.
      if (this.deviceLocks.get(deviceId) === settled) this.deviceLocks.delete(deviceId);
    });
    return next;
  }

  private requireSession(binding: DeviceBinding): string {
    if (!binding.sessionId) {
      throw new CapabilityError('DEVICE_SESSION_FAILED', 'Device binding has no automation session; call device.open_safari first', {
        remediation: DEVICE_ERROR_REMEDIATION.DEVICE_SESSION_FAILED,
        canRebind: true,
      });
    }
    const current = this.sessions.current;
    if (current && current.sessionId !== binding.sessionId) {
      // A recreated session on a still-attached phone is a generation change, not a lost device.
      throw new CapabilityError(
        'DEVICE_TARGET_STALE',
        `Device automation session was recreated: binding session ${binding.sessionId} is not the live session ${current.sessionId}`,
        { remediation: DEVICE_ERROR_REMEDIATION.DEVICE_TARGET_STALE, canRebind: true }
      );
    }
    return binding.sessionId;
  }

  private noteFailure(message: string): void {
    if (!sessionIsGone(message)) return;
    this.sessions.markLost();
    this.releaseBridgedTransport();
  }

  /** A lost session invalidates the bridge too: the next call re-resolves it against live hardware. */
  private releaseBridgedTransport(): void {
    this.cachedTransport = undefined;
    const forwarder = this.bridgedForwarder;
    this.bridgedForwarder = undefined;
    if (forwarder) void forwarder.close();
  }

  private async sendToSession(target: DeviceBinding, method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown): Promise<void> {
    await this.withDeviceLock(target.deviceId, async () => {
      const sessionId = this.requireSession(target);
      const transport = await this.transportFor(target);
      const response = await transport.request(method, `/session/${sessionId}${route}`, body, this.defaultTimeoutMs);
      if (!response.ok) {
        const message = describeWdaFailure(response);
        this.noteFailure(message);
        throw new CapabilityError('DEVICE_SESSION_FAILED', `Device command ${route} failed: ${message}`, {
          remediation: DEVICE_ERROR_REMEDIATION.DEVICE_SESSION_FAILED,
        });
      }
    });
  }

  /** Second gate for direct callers: a binding minted before a re-plug must not drive the new attachment. */
  private async transportFor(binding: DeviceBinding): Promise<WdaTransport> {
    const live = this.devices.getBinding(binding.deviceId);
    if (live && live.deviceEpoch !== binding.deviceEpoch) {
      // The bridge pins a usbmux deviceNumber, so a re-plug invalidates it: drop it before reporting, so
      // the next call re-resolves against the device that is actually attached.
      this.releaseBridgedTransport();
      throw new CapabilityError('DEVICE_TARGET_STALE', `Device attachment changed: binding epoch ${binding.deviceEpoch} does not match live epoch ${live.deviceEpoch}`, {
        expectedDeviceEpoch: live.deviceEpoch,
        actualDeviceEpoch: binding.deviceEpoch,
        canRebind: true,
      });
    }
    return this.resolveTransport();
  }

  private async resolveTransport(): Promise<WdaTransport> {
    const cached = this.cachedTransport;
    if (cached && Date.now() - cached.checkedAt < TRANSPORT_CACHE_MS) return cached.transport;

    const probed = await probeWdaCandidates(this.candidates);
    if (probed) {
      const transport = createWdaTransport(probed.baseUrl, this.defaultTimeoutMs);
      this.cachedTransport = { baseUrl: probed.baseUrl, transport, checkedAt: Date.now() };
      return transport;
    }

    // Nothing answered: bridge the phone's own runner port over usbmux before giving up. This is what
    // removes the external `iproxy` / `go-ios forward` dependency from the device path.
    const bridgedBaseUrl = this.allowBridge ? await this.bridgeDeviceWdaPort() : undefined;
    if (bridgedBaseUrl) {
      const transport = createWdaTransport(bridgedBaseUrl, this.defaultTimeoutMs);
      this.cachedTransport = { baseUrl: bridgedBaseUrl, transport, checkedAt: Date.now() };
      return transport;
    }

    const attempts = this.candidates.map((candidate) => `${candidate}: no WebDriverAgent /status`).join(' | ');
    throw new CapabilityError('DEVICE_TRANSPORT_UNREACHABLE', `No transport reached WebDriverAgent (${attempts})`, {
      remediation: DEVICE_ERROR_REMEDIATION.DEVICE_TRANSPORT_UNREACHABLE,
    });
  }

  /**
   * Bridges the runner's device-side port to loopback with the in-process usbmux forwarder and only
   * publishes it once WebDriverAgent answers there. Returns undefined when there is no attached device,
   * no usbmuxd host service, or no runner listening - all of which are "not reachable yet", never a
   * transport fault, so the caller keeps its candidate-list error.
   */
  private async bridgeDeviceWdaPort(): Promise<string | undefined> {
    try {
      const attached = await listUsbmuxDevices(5_000);
      const cached = this.bridgedForwarder;
      if (cached) {
        const cachedBaseUrl = `http://${cached.localHost}:${cached.localPort}`;
        // The loopback listener outlives the device socket, so a cached bridge keeps accepting TCP while
        // every Connect targets a deviceNumber a re-plug already retired. The establishment probe is the
        // only check that covers the whole chain (listener, device socket, runner), so reuse the cached
        // bridge only while its own device is still attached *and* still answers there; otherwise drop it
        // and rebuild rather than publish a URL that cannot serve a request.
        const pinnedStillAttached = attached.some((entry) => entry.deviceNumber === cached.deviceNumber);
        if (pinnedStillAttached && (await probeWdaCandidates([cachedBaseUrl]))) return cachedBaseUrl;
        this.releaseBridgedTransport();
        console.log('[antifan:device] released the usbmux bridge: its device was re-attached or the runner stopped answering');
      }
      if (!attached.length) return undefined;
      const liveDeviceId = this.devices.getLiveBinding()?.deviceId;
      const device =
        (liveDeviceId ? attached.find((entry) => entry.deviceId === liveDeviceId) : undefined) ??
        (attached.length === 1 ? attached[0] : undefined);
      if (!device) return undefined;

      const forwarder = await createUsbmuxPortForwarder({ deviceNumber: device.deviceNumber, devicePort: this.wdaDevicePort });
      const baseUrl = `http://${forwarder.localHost}:${forwarder.localPort}`;
      if (!(await probeWdaCandidates([baseUrl]))) {
        await forwarder.close();
        return undefined;
      }
      this.bridgedForwarder = forwarder;
      console.log(`[antifan:device] bridged device port ${this.wdaDevicePort} over usbmux to ${baseUrl} (no iproxy/go-ios needed)`);
      return baseUrl;
    } catch {
      return undefined;
    }
  }

  private buildTarget(info: DeviceInfo, screen: WdaScreenInfo | undefined, binding: DeviceBinding): DeviceTarget {
    const scale = screen && screen.scale > 0 ? screen.scale : 1;
    const width = screen?.width ?? 0;
    const height = screen?.height ?? 0;
    return {
      projectId: binding.projectId,
      workspaceId: binding.workspaceId,
      runtimeId: binding.runtimeId,
      deviceId: info.deviceId,
      deviceEpoch: binding.deviceEpoch,
      sessionId: binding.sessionId,
      sessionGeneration: binding.sessionGeneration,
      platform: 'ios',
      osVersion: info.osVersion,
      model: info.model,
      connection: info.connection,
      screen: { width, height, scale },
      // Panel pixels to CSS points. Safari's live layout viewport is not observable from here, so the
      // provenance is recorded rather than implied.
      viewport: { width: width ? width / scale : 0, height: height ? height / scale : 0, scale },
      viewportSource: 'panel-derived',
    };
  }
}
