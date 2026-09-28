import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as net from 'node:net';

import {
  closeServerWithinBound,
  createUsbmuxPortForwarder,
  USBMUX_FORWARDER_CLOSE_DEADLINE_MS,
} from '../../src/main/device/usbmux-forwarder';

describe('usbmux-forwarder closeServerWithinBound', () => {
  it('deadline constant is upper snake case, > 5ms roundtrip, and < 15s patience', () => {
    assert.strictEqual(typeof USBMUX_FORWARDER_CLOSE_DEADLINE_MS, 'number');
    assert.ok(USBMUX_FORWARDER_CLOSE_DEADLINE_MS > 5);
    assert.ok(USBMUX_FORWARDER_CLOSE_DEADLINE_MS <= 15_000);
  });

  it('resolves false at bound when client connection remains open (does not hang indefinitely)', { timeout: 1_000 }, async () => {
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as net.AddressInfo;

    const client = net.connect(address.port, '127.0.0.1');
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));

    const boundMs = 60;
    const start = Date.now();
    const confirmed = await closeServerWithinBound(server, boundMs);
    const elapsed = Date.now() - start;

    assert.strictEqual(confirmed, false, 'lingering connection must report false on timeout, not hang or fake success');
    assert.ok(elapsed >= boundMs - 15, `elapsed ${elapsed}ms should be at least near bound ${boundMs}ms`);

    // Clean up lingering socket so server can cleanly terminate
    client.destroy();
  });

  it('resolves true promptly when client connection is closed', { timeout: 1_000 }, async () => {
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as net.AddressInfo;

    const client = net.connect(address.port, '127.0.0.1');
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));

    // Close client before or synchronously with close
    client.destroy();
    await new Promise<void>((resolve) => client.once('close', () => resolve()));

    const start = Date.now();
    const confirmed = await closeServerWithinBound(server, 1_000);
    const elapsed = Date.now() - start;

    assert.strictEqual(confirmed, true, 'server with no active connections must confirm close');
    assert.ok(elapsed < 200, `clean close should take < 200ms on loopback, took ${elapsed}ms`);
  });

  it('resolves true promptly when client connection ends mid-wait before bound expires', { timeout: 2_000 }, async () => {
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as net.AddressInfo;

    const client = net.connect(address.port, '127.0.0.1');
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));

    // Schedule client termination after 40ms
    setTimeout(() => client.destroy(), 40);

    const start = Date.now();
    const confirmed = await closeServerWithinBound(server, 2_000);
    const elapsed = Date.now() - start;

    assert.strictEqual(confirmed, true, 'closing client mid-wait must trigger close confirmation');
    assert.ok(elapsed < 500, `should resolve promptly once client ends, took ${elapsed}ms`);
  });

  it('resolves true when server is already stopped or not running', { timeout: 1_000 }, async () => {
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const confirmed = await closeServerWithinBound(server, 200);
    assert.strictEqual(confirmed, true, 'already stopped server is confirmed closed');
  });

  it('forwarder.close() confirms clean shutdown with no open connections', { timeout: 1_000 }, async () => {
    const forwarder = await createUsbmuxPortForwarder({
      deviceNumber: 99_998,
      devicePort: 8100,
    });
    const confirmed = await forwarder.close(500);
    assert.strictEqual(confirmed, true, 'idle forwarder closes cleanly and returns true');
  });
});
