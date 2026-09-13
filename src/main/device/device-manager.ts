import { CapabilityError } from '../../shared/control-plane-contracts';
import { DEVICE_ERROR_REMEDIATION, type DeviceBinding, type DeviceInfo } from '../../shared/device-control-contracts';
import type { DeviceRegistryPort } from './device-control-port';
import { listUsbmuxDevicesEnriched, type UsbmuxDevice } from './usbmux-client';

/**
 * Device discovery and binding state.
 *
 * Two lifetimes are tracked separately and must never be collapsed:
 *   - `deviceEpoch` — physical attachment. Bumped only when a device appears again after being
 *     absent. Monotonic per UDID, so a re-plug never reuses an epoch and a stale target cannot be
 *     accidentally validated by a device that happens to be plugged back in.
 *   - `sessionGeneration` — automation session. Owned by the session manager; a WebDriverAgent crash
 *     on a still-attached phone bumps this and NOT the epoch, because the phone never moved.
 *
 * Enumeration failures are never reported as "no device": a missing USB driver stack is a transport
 * observation, and usbmuxd not answering tells us nothing about what is plugged in.
 */

export interface DeviceManagerOptions {
  projectId: string;
  workspaceId: string;
  runtimeId: string;
  /**
   * Discovery seam. The USB driver stack is the one dependency that cannot exist off-hardware, so it
   * is injectable: everything above it stays testable without a phone attached.
   */
  enumerate?: () => Promise<UsbmuxDevice[]>;
}

interface DeviceRecord {
  info: DeviceInfo;
  deviceNumber: number;
  deviceEpoch: number;
  sessionId?: string;
  sessionGeneration: number;
}

function toDeviceInfo(device: UsbmuxDevice): DeviceInfo {
  return {
    deviceId: device.deviceId,
    name: device.name || device.model || device.deviceId,
    model: device.model,
    osVersion: device.osVersion,
    connection: device.connection,
    // usbmuxd only lists devices it holds a pairing record for.
    paired: true,
    // Trust is not observable from enumeration: it surfaces on the first session attempt.
    trusted: false,
    // WebDriverAgent readiness is probed separately and never assumed from attachment.
    automationReady: false,
  };
}

export class DeviceManager implements DeviceRegistryPort {
  private readonly projectId: string;
  private readonly workspaceId: string;
  private readonly runtimeId: string;
  private readonly enumerate: () => Promise<UsbmuxDevice[]>;
  private readonly records = new Map<string, DeviceRecord>();
  /** Highest epoch ever assigned per UDID, retained across removals so epochs never recycle. */
  private readonly epochs = new Map<string, number>();
  private selectedDeviceId?: string;

  constructor(options: DeviceManagerOptions) {
    this.projectId = options.projectId;
    this.workspaceId = options.workspaceId;
    this.runtimeId = options.runtimeId;
    this.enumerate = options.enumerate ?? (() => listUsbmuxDevicesEnriched());
  }

  /** Last enumerated view. Use `refresh()` to observe the host now. */
  async list(): Promise<DeviceInfo[]> {
    return [...this.records.values()].map((record) => record.info);
  }

  /**
   * Enumerates the host and reconciles records.
   *
   * On transport failure the previous records are kept: an unreachable usbmuxd means "unknown", and
   * clearing the map would silently convert an unknown into a definitive "no device attached".
   */
  async refresh(): Promise<DeviceInfo[]> {
    let enumerated: UsbmuxDevice[];
    try {
      enumerated = await this.enumerate();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new CapabilityError('DEVICE_TRANSPORT_UNREACHABLE', `Device enumeration failed: ${detail}`, {
        remediation: DEVICE_ERROR_REMEDIATION.DEVICE_TRANSPORT_UNREACHABLE,
      });
    }

    const present = new Set<string>();
    for (const device of enumerated) {
      present.add(device.deviceId);
      const existing = this.records.get(device.deviceId);
      if (existing) {
        // A different `deviceNumber` for the same UDID is a re-attachment, even though the UDID never
        // left the map (a fast re-plug is not observed as an absence). usbmux retires the old device
        // number, so the epoch must advance and the session must be dropped: any target or forwarder
        // minted for the previous attachment is now driving a handle the port stack no longer owns.
        if (existing.deviceNumber !== device.deviceNumber) {
          const deviceEpoch = (this.epochs.get(device.deviceId) ?? 0) + 1;
          this.epochs.set(device.deviceId, deviceEpoch);
          existing.deviceEpoch = deviceEpoch;
          existing.sessionId = undefined;
          existing.sessionGeneration = 0;
        }
        existing.info = toDeviceInfo(device);
        existing.deviceNumber = device.deviceNumber;
        continue;
      }
      const deviceEpoch = (this.epochs.get(device.deviceId) ?? 0) + 1;
      this.epochs.set(device.deviceId, deviceEpoch);
      this.records.set(device.deviceId, {
        info: toDeviceInfo(device),
        deviceNumber: device.deviceNumber,
        deviceEpoch,
        sessionGeneration: 0,
      });
    }

    for (const deviceId of [...this.records.keys()]) {
      if (present.has(deviceId)) continue;
      // A detached device takes its automation session with it; the epoch is retained so a re-plug
      // cannot satisfy a target minted before the removal.
      this.records.delete(deviceId);
      if (this.selectedDeviceId === deviceId) this.selectedDeviceId = undefined;
    }

    return this.list();
  }

  getBinding(deviceId: string): DeviceBinding | undefined {
    const record = this.records.get(deviceId);
    return record ? this.bindingOf(record) : undefined;
  }

  /**
   * The device this session is working with.
   *
   * Resolution order is explicit selection, then the session holder, then the only attached device.
   * With two phones attached and no session yet there is no unambiguous answer, so it stays
   * undefined and callers must name a device rather than having one guessed for them.
   */
  getLiveBinding(): (DeviceBinding & { sessionId?: string }) | undefined {
    const selected = this.selectedDeviceId ? this.records.get(this.selectedDeviceId) : undefined;
    if (selected) return this.bindingOf(selected);
    const withSession = [...this.records.values()].find((record) => record.sessionId);
    if (withSession) return this.bindingOf(withSession);
    if (this.records.size === 1) {
      const only = [...this.records.values()][0];
      if (only) return this.bindingOf(only);
    }
    return undefined;
  }

  select(deviceId: string): void {
    // Discovery stays the authority: a session may only select a device the host actually enumerated.
    if (this.records.has(deviceId)) this.selectedDeviceId = deviceId;
  }

  setSession(deviceId: string, sessionId: string, generation: number): void {
    const record = this.records.get(deviceId);
    if (!record) {
      throw new CapabilityError('DEVICE_NOT_CONNECTED', `Device '${deviceId}' is no longer attached; cannot bind session ${sessionId}`, {
        remediation: DEVICE_ERROR_REMEDIATION.DEVICE_NOT_CONNECTED,
      });
    }
    record.sessionId = sessionId;
    record.sessionGeneration = generation;
    this.selectedDeviceId = deviceId;
  }

  /**
   * Drops the recorded session and keeps the attachment. `sessionGeneration` returns to 0 because the
   * binding carries no session at all: generation is only meaningful next to a sessionId, and a
   * leftover generation would compare equal to a target minted for the session that just died.
   */
  clearSession(deviceId: string): void {
    const record = this.records.get(deviceId);
    if (!record) return;
    record.sessionId = undefined;
    record.sessionGeneration = 0;
  }

  /** Device numbers are only meaningful to the USB stack (port forwarding); kept for that use. */
  getDeviceNumber(deviceId: string): number | undefined {
    return this.records.get(deviceId)?.deviceNumber;
  }

  private bindingOf(record: DeviceRecord): DeviceBinding {
    return {
      projectId: this.projectId,
      workspaceId: this.workspaceId,
      runtimeId: this.runtimeId,
      deviceId: record.info.deviceId,
      deviceEpoch: record.deviceEpoch,
      sessionId: record.sessionId,
      sessionGeneration: record.sessionGeneration,
    };
  }
}
