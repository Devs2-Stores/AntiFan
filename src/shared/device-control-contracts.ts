import type { CapabilityErrorCode } from './control-plane-contracts';

/**
 * Real-device (Phone Adapter) contracts.
 *
 * Boundary invariant: no Chromium concept lives below this line. `tabId`, `browserEpoch`,
 * `documentGeneration`, `paneId` and CDP all belong to `BrowserControlPort`; a physical phone is a
 * peer execution surface under the control plane, not a mobile pane of the browser port. Sharing
 * those fields would browser-ify the device abstraction and force every device change through the
 * browser host's lifecycle.
 *
 * Three lifetimes are deliberately distinct and must never be collapsed:
 *   physical attachment  -> `deviceEpoch`       (bumped on unplug/replug/reboot)
 *   automation session   -> `sessionGeneration` (bumped when WDA restarts while the phone stays attached)
 *   rendering surface    -> derived from `DeviceTarget` (screen / viewport / safe area)
 * A phone that is still plugged in after WDA crashed is NOT a removed device; conflating the two
 * turns a recoverable session restart into a bogus "device lost" error.
 */

export type DevicePlatform = 'ios' | 'android';

/** Transport the host uses to reach the device. USB needs a host driver stack; network does not. */
export type DeviceConnection = 'usb' | 'network';

/**
 * Tri-state gate result. `unknown` is a first-class answer: several device prerequisites are
 * provisioning state that only reveals itself when a specific operation is attempted, and forcing
 * them into true/false would report a failure the host cannot actually observe.
 */
export type DeviceGateStatus = 'pass' | 'fail' | 'unknown';

export interface DeviceBinding {
  projectId: string;
  workspaceId: string;
  runtimeId: string;
  /** Physical device identity (iOS: UDID). */
  deviceId: string;
  /** Bumped whenever the physical attachment changes (unplug/replug, device reboot). */
  deviceEpoch: number;
  /** Automation session identity (iOS: WebDriverAgent session). Absent before the first session. */
  sessionId?: string;
  /** Bumped when the automation session is recreated while the device stays attached. */
  sessionGeneration: number;
}

export interface DeviceScreenMetrics {
  width: number;
  height: number;
  scale: number;
}

/** Notch / Dynamic Island / home-indicator insets in CSS points. */
export interface DeviceSafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DeviceTarget extends DeviceBinding {
  platform: DevicePlatform;
  osVersion: string;
  model: string;
  connection: DeviceConnection;
  /** Physical panel size in device pixels. */
  screen: DeviceScreenMetrics;
  /**
   * Safari's layout viewport in CSS points. This is the number that matters for `100vh` / `100dvh`
   * work and it changes while the URL bar collapses, which is exactly what Chromium emulation
   * cannot reproduce.
   */
  viewport: DeviceScreenMetrics;
  /**
   * Provenance of `viewport`. Without Web Inspector we can only derive it from the panel
   * (`panel-derived`, i.e. panel pixels / scale); a real measurement of Safari's live layout area
   * needs the page itself, so the field is populated as `page-measured` only in the inspection
   * milestone. Callers must not treat a derived viewport as a measurement.
   */
  viewportSource: 'panel-derived' | 'page-measured';
  safeArea?: DeviceSafeArea;
}

export interface DeviceInfo {
  deviceId: string;
  name: string;
  model: string;
  osVersion: string;
  connection: DeviceConnection;
  paired: boolean;
  trusted: boolean;
  automationReady: boolean;
}

export interface DevicePoint {
  x: number;
  y: number;
}

export interface DeviceSwipe {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  durationMs?: number;
}

/**
 * Semantic wait conditions for a real device.
 *
 * There is deliberately no `url` condition: on the direct WebDriverAgent path `POST
 * /session/:id/url` is a deep-link open (`XCUIDevice fb_openUrl:`) and WDA exposes no URL readback
 * route, so a URL predicate could never be evaluated. Page readiness on this path is a rendering
 * heuristic, not a network-idle signal.
 */
export type DeviceWaitCondition =
  | { type: 'timeout'; value: number }
  | { type: 'page_loaded'; timeoutMs?: number }
  | { type: 'stable'; timeoutMs?: number };

export interface DeviceWaitResult {
  type: DeviceWaitCondition['type'];
  waitedMs: number;
  settled: boolean;
  /** Names the observation used, so callers never mistake a heuristic for a load guarantee. */
  heuristic: string;
}

export interface DeviceActionResult {
  ok: true;
  ms: number;
  note?: string;
}

export interface DeviceReadinessGate {
  status: DeviceGateStatus;
  /** Why the gate holds its status; raw observation, not interpretation. */
  reason?: string;
  /** What the operator must do to move a `fail` forward. */
  action?: string;
}

/**
 * Readiness is split into two independent milestones so the MVP surface stays small:
 * automation (open, navigate, screenshot, tap, swipe, type) and web inspection (DOM, CSS, console,
 * network), which additionally requires Safari's Web Inspector + Remote Automation.
 */
export interface DeviceReadinessReport {
  physical: DeviceReadinessGate;
  trusted: DeviceReadinessGate;
  developerMode: DeviceReadinessGate;
  uiAutomation: DeviceReadinessGate;
  webInspector: DeviceReadinessGate;
  remoteAutomation: DeviceReadinessGate;
  wda: DeviceReadinessGate;
  automationReady: boolean;
  inspectionReady: boolean;
}

/** Gates that must pass before any automation primitive may run. */
export const DEVICE_AUTOMATION_GATES = ['physical', 'trusted', 'developerMode', 'uiAutomation', 'wda'] as const;

/** Gates that must additionally pass before DOM/CSS/console/network inspection may run. */
export const DEVICE_INSPECTION_GATES = ['webInspector', 'remoteAutomation'] as const;

/**
 * Device failure codes. Every device capability fails with one of these instead of leaking a raw
 * transport exception (a multi-thousand-line Appium stack tells an agent nothing actionable).
 */
export type DeviceErrorCode =
  | 'DEVICE_TRANSPORT_UNREACHABLE'
  | 'DEVICE_NOT_CONNECTED'
  | 'DEVICE_NOT_TRUSTED'
  | 'DEVICE_DEVELOPER_MODE_REQUIRED'
  | 'DEVICE_UI_AUTOMATION_REQUIRED'
  | 'DEVICE_WDA_NOT_READY'
  | 'DEVICE_SESSION_FAILED'
  | 'DEVICE_OPERATION_UNSUPPORTED'
  | 'DEVICE_TARGET_STALE';

/** Operator-facing remediation for each device failure code. */
export const DEVICE_ERROR_REMEDIATION: Record<DeviceErrorCode, string> = {
  DEVICE_TRANSPORT_UNREACHABLE:
    'No transport reaches WebDriverAgent. Start the WDA runner on the device and forward its port (go-ios "ios forward 8100 8100", pymobiledevice3 "usbmux forward 8100 8100"), or point the adapter at the device Wi-Fi address.',
  DEVICE_NOT_CONNECTED:
    'No device is visible to the host. Connect it by USB and install Apple Mobile Device Support (standalone iTunes for Windows), or reach it over the network.',
  DEVICE_NOT_TRUSTED:
    "The device is locked or untrusted. Unlock it and tap 'Trust This Computer'.",
  DEVICE_DEVELOPER_MODE_REQUIRED:
    'Developer Mode is off. Enable it in Settings > Privacy & Security > Developer Mode, then restart the device.',
  DEVICE_UI_AUTOMATION_REQUIRED:
    'UI Automation is off. Enable it in Settings > Developer > Enable UI Automation.',
  DEVICE_WDA_NOT_READY:
    'The WebDriverAgent runner is not answering. Launch it on the device and confirm its provisioning profile is trusted.',
  DEVICE_SESSION_FAILED:
    'The automation session could not be created. Confirm Safari is installed and that the device screen is unlocked.',
  DEVICE_OPERATION_UNSUPPORTED:
    'This operation is not available on the connected device/profile; use the Chromium surface for this step.',
  DEVICE_TARGET_STALE:
    'The device target is stale: the attachment changed (deviceEpoch) or the automation session was recreated (sessionGeneration). Re-read device.status and rebind.',
};

/** Compile-time proof that every device code is a legal control-plane capability error code. */
const DEVICE_CODE_BRIDGE: Record<DeviceErrorCode, CapabilityErrorCode> = {
  DEVICE_TRANSPORT_UNREACHABLE: 'DEVICE_TRANSPORT_UNREACHABLE',
  DEVICE_NOT_CONNECTED: 'DEVICE_NOT_CONNECTED',
  DEVICE_NOT_TRUSTED: 'DEVICE_NOT_TRUSTED',
  DEVICE_DEVELOPER_MODE_REQUIRED: 'DEVICE_DEVELOPER_MODE_REQUIRED',
  DEVICE_UI_AUTOMATION_REQUIRED: 'DEVICE_UI_AUTOMATION_REQUIRED',
  DEVICE_WDA_NOT_READY: 'DEVICE_WDA_NOT_READY',
  DEVICE_SESSION_FAILED: 'DEVICE_SESSION_FAILED',
  DEVICE_OPERATION_UNSUPPORTED: 'DEVICE_OPERATION_UNSUPPORTED',
  DEVICE_TARGET_STALE: 'DEVICE_TARGET_STALE',
};
void DEVICE_CODE_BRIDGE;
