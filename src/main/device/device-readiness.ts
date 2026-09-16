import { CapabilityError } from '../../shared/control-plane-contracts';
import {
  DEVICE_AUTOMATION_GATES,
  DEVICE_ERROR_REMEDIATION,
  DEVICE_INSPECTION_GATES,
  type DeviceErrorCode,
  type DeviceInfo,
  type DeviceReadinessGate,
  type DeviceReadinessReport,
} from '../../shared/device-control-contracts';
import type { WdaStatusPayload } from './device-control-port';

/**
 * Gate-name to device error code map for automation gates.
 */
export const DEVICE_GATE_ERROR_CODES: Readonly<Record<(typeof DEVICE_AUTOMATION_GATES)[number], DeviceErrorCode>> = {
  physical: 'DEVICE_NOT_CONNECTED',
  trusted: 'DEVICE_NOT_TRUSTED',
  developerMode: 'DEVICE_DEVELOPER_MODE_REQUIRED',
  uiAutomation: 'DEVICE_UI_AUTOMATION_REQUIRED',
  wda: 'DEVICE_WDA_NOT_READY',
} as const;

/**
 * Raw host telemetry and probe results used to evaluate readiness gates.
 */
export interface DeviceReadinessObservation {
  device?: DeviceInfo;
  wdaStatus?: WdaStatusPayload;
  transportFailure?: { code: string; detail: string };
  sessionFailure?: string;
}

const TRUST_FAILURE_RE = /trust|untrusted|pair/i;
const DEV_MODE_FAILURE_RE = /developer mode/i;
const UI_AUTO_FAILURE_RE = /ui automation/i;

const ALL_GATE_NAMES = [
  'physical',
  'trusted',
  'developerMode',
  'uiAutomation',
  'webInspector',
  'remoteAutomation',
  'wda',
] as const;

/**
 * Evaluates host observations into tri-state readiness gates.
 *
 * Unknown is a first-class answer: several iOS prerequisites are lazy provisioning
 * states that only reveal themselves when an automation session is attempted.
 */
export function evaluateDeviceReadiness(observation: DeviceReadinessObservation): DeviceReadinessReport {
  const failureTexts: string[] = [];
  if (observation.transportFailure) {
    if (observation.transportFailure.code) failureTexts.push(observation.transportFailure.code);
    if (observation.transportFailure.detail) failureTexts.push(observation.transportFailure.detail);
  }
  if (observation.sessionFailure) {
    failureTexts.push(observation.sessionFailure);
  }
  if (observation.wdaStatus?.message) {
    failureTexts.push(observation.wdaStatus.message);
  }
  const combinedFailureText = failureTexts.join(' ');

  // 1. physical gate
  let physical: DeviceReadinessGate;
  if (observation.device) {
    const id = observation.device.deviceId;
    const name = observation.device.name;
    const conn = observation.device.connection;
    const desc = name ? `"${name}" (${id})` : id;
    physical = {
      status: 'pass',
      reason: `Device ${desc} is connected via ${conn}`,
    };
  } else if (observation.transportFailure) {
    const detail = observation.transportFailure.detail || observation.transportFailure.code;
    physical = {
      status: 'fail',
      reason: detail ? `No device connected: ${detail}` : 'No device connected and transport failure observed',
      action: DEVICE_ERROR_REMEDIATION.DEVICE_NOT_CONNECTED,
    };
  } else {
    physical = {
      status: 'unknown',
      reason: 'No device enumerated and no transport failure observed',
    };
  }

  // 2. trusted gate
  let trusted: DeviceReadinessGate;
  if (combinedFailureText && TRUST_FAILURE_RE.test(combinedFailureText)) {
    const matchingText = failureTexts.find((t) => TRUST_FAILURE_RE.test(t)) ?? combinedFailureText;
    trusted = {
      status: 'fail',
      reason: matchingText,
      action: DEVICE_ERROR_REMEDIATION.DEVICE_NOT_TRUSTED,
    };
  } else if (observation.device?.trusted === true) {
    trusted = {
      status: 'pass',
      reason: 'Device trust is confirmed',
    };
  } else {
    trusted = {
      status: 'unknown',
      reason: observation.device
        ? 'Device enumerated but trust has not been exercised (resolves lazily on first session attempt)'
        : 'Device trust status is unknown without connected device',
    };
  }

  // 3. developerMode gate
  let developerMode: DeviceReadinessGate;
  if (combinedFailureText && DEV_MODE_FAILURE_RE.test(combinedFailureText)) {
    const matchingText = failureTexts.find((t) => DEV_MODE_FAILURE_RE.test(t)) ?? combinedFailureText;
    developerMode = {
      status: 'fail',
      reason: matchingText,
      action: DEVICE_ERROR_REMEDIATION.DEVICE_DEVELOPER_MODE_REQUIRED,
    };
  } else {
    developerMode = {
      status: 'unknown',
      reason: 'Developer Mode cannot be observed passively (resolves on automation attempt)',
    };
  }

  // 4. uiAutomation gate
  let uiAutomation: DeviceReadinessGate;
  if (combinedFailureText && UI_AUTO_FAILURE_RE.test(combinedFailureText)) {
    const matchingText = failureTexts.find((t) => UI_AUTO_FAILURE_RE.test(t)) ?? combinedFailureText;
    uiAutomation = {
      status: 'fail',
      reason: matchingText,
      action: DEVICE_ERROR_REMEDIATION.DEVICE_UI_AUTOMATION_REQUIRED,
    };
  } else {
    uiAutomation = {
      status: 'unknown',
      reason: 'UI Automation cannot be observed passively (resolves on automation attempt)',
    };
  }

  // 5. wda gate
  let wda: DeviceReadinessGate;
  if (observation.wdaStatus?.ready === true) {
    wda = {
      status: 'pass',
      reason: observation.wdaStatus.message || 'WebDriverAgent runner is ready',
    };
  } else if (
    observation.transportFailure !== undefined ||
    (observation.wdaStatus !== undefined && !observation.wdaStatus.ready)
  ) {
    const reason = observation.transportFailure
      ? (observation.transportFailure.detail
        ? `${observation.transportFailure.code}: ${observation.transportFailure.detail}`
        : observation.transportFailure.code)
      : (observation.wdaStatus?.message || 'WebDriverAgent status reported not ready');
    wda = {
      status: 'fail',
      reason,
      action: DEVICE_ERROR_REMEDIATION.DEVICE_WDA_NOT_READY,
    };
  } else {
    wda = {
      status: 'unknown',
      reason: 'WebDriverAgent status has not been probed',
    };
  }

  // 6. webInspector gate (Phase 3)
  const webInspector: DeviceReadinessGate = {
    status: 'unknown',
    reason: 'Web Inspector is only needed for DOM/CSS/console/network inspection (Phase 3)',
  };

  // 7. remoteAutomation gate (Phase 3)
  const remoteAutomation: DeviceReadinessGate = {
    status: 'unknown',
    reason: 'Remote Automation is only needed for DOM/CSS/console/network inspection (Phase 3)',
  };

  const reportGates: Record<(typeof DEVICE_AUTOMATION_GATES)[number] | (typeof DEVICE_INSPECTION_GATES)[number], DeviceReadinessGate> = {
    physical,
    trusted,
    developerMode,
    uiAutomation,
    wda,
    webInspector,
    remoteAutomation,
  };

  const automationReady =
    physical.status === 'pass' &&
    wda.status === 'pass' &&
    DEVICE_AUTOMATION_GATES.every((gateName) => reportGates[gateName].status !== 'fail');

  const inspectionReady =
    automationReady &&
    DEVICE_INSPECTION_GATES.every((gateName) => reportGates[gateName].status === 'pass');

  return {
    physical,
    trusted,
    developerMode,
    uiAutomation,
    webInspector,
    remoteAutomation,
    wda,
    automationReady,
    inspectionReady,
  };
}

/**
 * Asserts that the report satisfies all requirements for automation primitives.
 *
 * Throws CapabilityError with the first blocking gate's device code and remediation.
 */
export function assertDeviceAutomationReady(report: DeviceReadinessReport): void {
  if (report.automationReady) {
    return;
  }

  for (const gateName of DEVICE_AUTOMATION_GATES) {
    const gate = report[gateName];
    if (gate.status === 'fail') {
      const code = DEVICE_GATE_ERROR_CODES[gateName];
      const remediation = DEVICE_ERROR_REMEDIATION[code];
      const message = gate.reason ? `${remediation} (${gate.reason})` : remediation;
      throw new CapabilityError(code, message, {
        gate: gateName,
        status: gate.status,
        reason: gate.reason,
        remediation,
      });
    }
  }

  if (report.physical.status !== 'pass') {
    const code = DEVICE_GATE_ERROR_CODES.physical;
    const remediation = DEVICE_ERROR_REMEDIATION[code];
    const message = report.physical.reason ? `${remediation} (${report.physical.reason})` : remediation;
    throw new CapabilityError(code, message, {
      gate: 'physical',
      status: report.physical.status,
      reason: report.physical.reason,
      remediation,
    });
  }

  if (report.wda.status !== 'pass') {
    const code = DEVICE_GATE_ERROR_CODES.wda;
    const remediation = DEVICE_ERROR_REMEDIATION[code];
    const message = report.wda.reason ? `${remediation} (${report.wda.reason})` : remediation;
    throw new CapabilityError(code, message, {
      gate: 'wda',
      status: report.wda.status,
      reason: report.wda.reason,
      remediation,
    });
  }

  const fallbackCode = DEVICE_GATE_ERROR_CODES.physical;
  const fallbackRemediation = DEVICE_ERROR_REMEDIATION[fallbackCode];
  throw new CapabilityError(fallbackCode, fallbackRemediation, {
    gate: 'physical',
    status: report.physical.status,
    reason: report.physical.reason,
    remediation: fallbackRemediation,
  });
}
