import * as net from 'node:net';
import { CapabilityError } from '../../shared/control-plane-contracts';
import { connectDevicePort } from './usbmux-client';

/**
 * AntiFan in-process usbmuxd port forwarder.
 *
 * Apple's Windows usbmuxd hands the device-port stream back on the *same* socket
 * (`via: 'same-socket'`), so a forwarder is only: accept on loopback, bridge one usbmux Connect per
 * accepted connection, pipe both directions. That removes the external `iproxy` / `go-ios forward`
 * dependency from the device path — any client that speaks TCP to the phone's port works unchanged.
 *
 * What this is NOT: an RemoteXPC tunnel. A port the device only exposes through its developer
 * services (iOS 17+ and later) stays unreachable over usbmux; this forwards a port the device itself
 * listens on, which is exactly what a running WebDriverAgent runner provides.
 */

export interface UsbmuxPortForwarderStats {
  accepted: number;
  active: number;
  completed: number;
  failed: number;
  bytesToDevice: number;
  bytesFromDevice: number;
}

export interface UsbmuxPortForwarder {
  readonly localHost: string;
  readonly localPort: number;
  readonly deviceNumber: number;
  readonly devicePort: number;
  stats(): UsbmuxPortForwarderStats;
  close(): Promise<void>;
}

export async function createUsbmuxPortForwarder(options: {
  deviceNumber: number;
  devicePort: number;
  localHost?: string;
  localPort?: number;
  connectTimeoutMs?: number;
}): Promise<UsbmuxPortForwarder> {
  const localHost = options.localHost ?? '127.0.0.1';
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  const stats: UsbmuxPortForwarderStats = {
    accepted: 0,
    active: 0,
    completed: 0,
    failed: 0,
    bytesToDevice: 0,
    bytesFromDevice: 0,
  };
  const openSockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    stats.accepted += 1;
    stats.active += 1;
    openSockets.add(client);
    let settled = false;
    const release = (outcome: 'completed' | 'failed') => {
      if (settled) return;
      settled = true;
      if (outcome === 'completed') stats.completed += 1;
      else stats.failed += 1;
      stats.active -= 1;
      openSockets.delete(client);
    };

    connectDevicePort(options.deviceNumber, options.devicePort, connectTimeoutMs)
      .then(({ socket: device }) => {
        openSockets.add(device);
        client.on('data', (chunk) => {
          stats.bytesToDevice += chunk.length;
        });
        device.on('data', (chunk) => {
          stats.bytesFromDevice += chunk.length;
        });
        device.on('error', () => {
          release('failed');
          device.destroy();
          client.destroy();
        });
        client.on('error', () => {
          release('failed');
          client.destroy();
          device.destroy();
        });
        device.on('close', () => {
          release('completed');
          openSockets.delete(device);
          client.destroy();
        });
        client.on('close', () => {
          release('completed');
          openSockets.delete(device);
          device.destroy();
        });
        client.pipe(device);
        device.pipe(client);
      })
      .catch((err: unknown) => {
        release('failed');
        client.destroy();
        const detail = err instanceof Error ? err.message : String(err);
        console.log(`[antifan:device] forward to device port ${options.devicePort} failed: ${detail}`);
      });
  });

  const binding = Promise.withResolvers<net.AddressInfo>();
  server.once('error', (err) => binding.reject(err));
  server.listen(options.localPort ?? 0, localHost, () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      binding.reject(
        new CapabilityError('DEVICE_TRANSPORT_UNREACHABLE', 'usbmux forwarder did not bind a loopback TCP port', {
          deviceNumber: options.deviceNumber,
          devicePort: options.devicePort,
        })
      );
      return;
    }
    binding.resolve(address);
  });
  const address = await binding.promise;
  console.log(
    `[antifan:device] forwarding ${localHost}:${address.port} -> device ${options.deviceNumber} port ${options.devicePort}`
  );

  return {
    localHost,
    localPort: address.port,
    deviceNumber: options.deviceNumber,
    devicePort: options.devicePort,
    stats: () => ({ ...stats }),
    close: async () => {
      for (const socket of [...openSockets]) socket.destroy();
      openSockets.clear();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}
