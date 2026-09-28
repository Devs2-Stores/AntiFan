import * as net from 'node:net';
import { CapabilityError } from '../../shared/control-plane-contracts';
import { connectDevicePort } from './usbmux-client';

/**
 * How long a loopback port-forwarder server close may wait for connections to drain.
 *
 * Measured on this platform: a clean loopback server close once tracked sockets are
 * destroyed finishes in 0-5ms. This deadline sits far above that sub-5ms round trip so a
 * draining server is never cut short, and sits far below user-patience and device-teardown
 * timeouts (10-15s), so an un-tracked, half-open, or stalled peer socket cannot block
 * device teardown indefinitely.
 */
export const USBMUX_FORWARDER_CLOSE_DEADLINE_MS = 1_500;

/**
 * Close a net.Server with a bounded wait for existing connections to drain.
 *
 * `net.Server.close(cb)` stops accepting immediately, but defers calling `cb` and
 * emitting 'close' until every connection has ended. A lingering or untracked connection
 * would therefore make an unbounded wait hang forever.
 *
 * Calls `server.closeAllConnections?.()` (Node 18.2+) before closing to proactively terminate
 * lingering connections, and bounds the wait on the platform confirmation.
 *
 * Returns `true` if the server confirmed close before the deadline, or `false` if the bound
 * expired while connections remained open.
 */
export async function closeServerWithinBound(
  server: net.Server,
  boundMs: number = USBMUX_FORWARDER_CLOSE_DEADLINE_MS
): Promise<boolean> {
  const deferred = Promise.withResolvers<boolean>();
  let settled = false;
  let outcomeTimer: NodeJS.Timeout | null = null;

  const finish = (confirmed: boolean): void => {
    if (settled) return;
    settled = true;
    if (outcomeTimer !== null) {
      clearTimeout(outcomeTimer);
      outcomeTimer = null;
    }
    server.removeListener('close', onClose);
    deferred.resolve(confirmed);
  };

  const onClose = (): void => finish(true);
  server.once('close', onClose);

  // Armed before the request, because a close the platform never confirms emits nothing:
  // a bound that waited for an event would never start.
  outcomeTimer = setTimeout(() => {
    finish(false);
  }, Math.max(1, boundMs));
  outcomeTimer.unref?.();

  try {
    // Proactively end lingering connections on servers that support closeAllConnections (Node 18.2+)
    (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close((err) => {
      if (err) {
        // If the server was already not running / stopped, it is effectively closed.
        const code = (err as NodeJS.ErrnoException).code;
        finish(code === 'ERR_SERVER_NOT_RUNNING');
      } else {
        finish(true);
      }
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    finish(code === 'ERR_SERVER_NOT_RUNNING');
  }

  return deferred.promise;
}

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
  close(boundMs?: number): Promise<boolean>;
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
    let device: net.Socket | undefined;
    const release = (outcome: 'completed' | 'failed') => {
      if (settled) return;
      settled = true;
      if (outcome === 'completed') stats.completed += 1;
      else stats.failed += 1;
      stats.active -= 1;
      openSockets.delete(client);
      if (device) openSockets.delete(device);
    };
    const abort = (outcome: 'completed' | 'failed') => {
      release(outcome);
      client.destroy();
      device?.destroy();
    };

    // Both ends are guarded BEFORE the handshake starts. `connectDevicePort` can take seconds, and a
    // client that resets in that window would emit 'error' on a socket with no listener — an unhandled
    // 'error' on a net.Socket is thrown, and in this process that is the Electron main process. So the
    // handlers go on first and the device side is attached the moment it exists.
    client.on('error', () => abort('failed'));
    client.on('close', () => abort('completed'));

    connectDevicePort(options.deviceNumber, options.devicePort, connectTimeoutMs)
      .then(({ socket }) => {
        if (settled) {
          // The client already left while usbmuxd was connecting: close the device side instead of
          // piping into a destroyed socket.
          socket.destroy();
          return;
        }
        device = socket;
        openSockets.add(device);
        client.on('data', (chunk) => {
          stats.bytesToDevice += chunk.length;
        });
        device.on('data', (chunk) => {
          stats.bytesFromDevice += chunk.length;
        });
        device.on('error', () => abort('failed'));
        device.on('close', () => abort('completed'));
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
    close: async (boundMs?: number): Promise<boolean> => {
      for (const socket of [...openSockets]) socket.destroy();
      openSockets.clear();
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      return closeServerWithinBound(server, boundMs ?? USBMUX_FORWARDER_CLOSE_DEADLINE_MS);
    },
  };
}
