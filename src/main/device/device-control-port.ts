import type { ArtifactRef } from '../../shared/control-plane-contracts';
import type {
  DeviceActionResult,
  DeviceBinding,
  DeviceInfo,
  DevicePoint,
  DeviceReadinessReport,
  DeviceSwipe,
  DeviceTarget,
  DeviceWaitCondition,
  DeviceWaitResult,
} from '../../shared/device-control-contracts';

/**
 * Artifact staging for device evidence, mirroring `BrowserArtifactSink` so both execution surfaces
 * record evidence through the same store (a real-device screenshot lands in the ArtifactStore with
 * `kind: 'screenshot'`, next to Chromium captures, and is what makes Tier 2 evidence comparable).
 */
export interface DeviceArtifactStageInput {
  kind: ArtifactRef['kind'];
  mime: string;
  data: string | Buffer;
  runId: string;
  attemptId: string;
  projectId: string;
  workspaceId: string;
  leaseToken?: string;
  retentionPolicy?: ArtifactRef['retentionPolicy'];
  /** Declared byte ceiling for this artifact; the sink enforces it. */
  maxBytes?: number;
  /**
   * `reject` fails the stage before writing when the payload exceeds the ceiling. The artifact store's
   * own default is `truncate`, which for a screenshot means silently storing a corrupt PNG that still
   * claims `mime: 'image/png'` — device evidence stages with `reject` instead.
   */
  overflowMode?: 'truncate' | 'reject';
}

export interface DeviceArtifactSink {
  stage(input: DeviceArtifactStageInput): Promise<ArtifactRef> | ArtifactRef;
  /** Preferred when implemented: stages without blocking the main thread on large buffers. */
  stageAsync?(input: DeviceArtifactStageInput): Promise<ArtifactRef>;
}

export interface DeviceArtifactRunContext {
  runId: string;
  attemptId: string;
  projectId: string;
  workspaceId: string;
  leaseToken?: string;
}

/**
 * Physical attachment lifetime: what the adapter needs from device discovery. Kept as an interface
 * rather than the concrete manager so everything above discovery is testable without a phone
 * attached — discovery is the only part that needs the USB driver stack.
 */
export interface DeviceRegistryPort {
  list(): Promise<DeviceInfo[]>;
  refresh(): Promise<DeviceInfo[]>;
  getBinding(deviceId: string): DeviceBinding | undefined;
  getLiveBinding(): (DeviceBinding & { sessionId?: string }) | undefined;
  /**
   * Records which enumerated device this session works with. Two phones can be attached at once and
   * neither has a session yet, so "the live device" is ambiguous until someone names it; discovery
   * stays the authority on whether that device is actually present.
   */
  select(deviceId: string): void;
  /** Records the live automation session so target staleness can be judged against the host. */
  setSession(deviceId: string, sessionId: string, generation: number): void;
  /**
   * Forgets the automation session while keeping the attachment. The session manager loses a session
   * the moment WDA tears it down, and a record that still advertises that sessionId would let the
   * next capability call reuse a dead one instead of asking for `openSafari` again.
   */
  clearSession(deviceId: string): void;
}

export interface DeviceStatusResult {
  /**
   * Absent when no device is visible. `device.status` reports findings rather than throwing on
   * absence: a missing phone is a readiness result, not a failure of the call, and conflating the
   * two is how "not set up yet" gets misread as "hardware broken".
   */
  device?: DeviceInfo;
  readiness: DeviceReadinessReport;
  /**
   * Current binding for the device, including `sessionId` when a Safari session is live. This is the
   * rebind handle callers pass to every other device capability after a `DEVICE_TARGET_STALE`.
   */
  target?: DeviceTarget;
}

/**
 * The device execution surface: ten primitives, no more.
 *
 * Deliberately NOT a copy of `BrowserControlPort`. There is no `getDom`, `evaluate`, `inspectCss`,
 * `findElement` or `getNetwork` here, and there will not be: those need Safari's Web Inspector and
 * Remote Automation, which is a separate milestone with its own readiness gates. Copying the browser
 * interface would promise inspection the transport cannot yet deliver.
 */
export interface DeviceControlPort {
  /** Enumerate attached devices. No bound target required. */
  list(): Promise<DeviceInfo[]>;
  /** Readiness + current binding for one device. No bound target required. */
  status(deviceId: string): Promise<DeviceStatusResult>;
  /**
   * Establish the Safari automation surface: ensure Safari, ensure the session, return the bound
   * target. Takes a device id rather than a binding because the adapter owns binding resolution;
   * callers should never have to manufacture a `DeviceBinding`.
   */
  openSafari(deviceId: string, options?: { initialUrl?: string }): Promise<DeviceTarget>;
  /**
   * Operations take a `DeviceBinding` — identity plus session — not a full `DeviceTarget`. Geometry
   * (screen, viewport, safe area) is reporting data owned by `status`/`openSafari`; requiring it on
   * every operation would force callers to fabricate measurements the host never took.
   */
  navigate(target: DeviceBinding, url: string): Promise<DeviceActionResult>;
  reload(target: DeviceBinding): Promise<DeviceActionResult>;
  screenshot(target: DeviceBinding, context: DeviceArtifactRunContext): Promise<ArtifactRef>;
  tap(target: DeviceBinding, point: DevicePoint): Promise<DeviceActionResult>;
  swipe(target: DeviceBinding, gesture: DeviceSwipe): Promise<DeviceActionResult>;
  type(target: DeviceBinding, text: string): Promise<DeviceActionResult>;
  wait(target: DeviceBinding, condition: DeviceWaitCondition): Promise<DeviceWaitResult>;
}

/** Reply of one WebDriverAgent HTTP exchange. */
export interface WdaResponse {
  ok: boolean;
  httpStatus?: number;
  json: unknown;
  text: string;
  ms: number;
  /** Transport-level failure code (TIMEOUT / ECONNREFUSED / ...). Absent when the server replied. */
  error?: string;
}

/** Normalized `/status` payload. */
export interface WdaStatusPayload {
  ready: boolean;
  message?: string;
  device?: string;
  osVersion?: string;
  wifiIp?: string;
  wdaVersion?: string;
  raw: unknown;
}

export interface WdaTransport {
  readonly baseUrl: string;
  request(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown, timeoutMs?: number): Promise<WdaResponse>;
}

/** Screen metrics reported by `/wda/screen`; the Safari viewport follows from these plus the status bar. */
export interface WdaScreenInfo {
  width: number;
  height: number;
  scale: number;
  statusBarHeight: number;
}

/** One live automation session. `generation` is what capability targets are validated against. */
export interface DeviceSession {
  sessionId: string;
  generation: number;
  createdAt: number;
}
