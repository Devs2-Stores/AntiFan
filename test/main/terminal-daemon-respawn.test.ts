/**
 * Terminal host respawn: when the daemon dies, the GUI's proxy brings up a replacement instead of
 * reconnecting to a closed port forever — but only on evidence the old host is gone, and never by
 * replacing a host that is alive and still holds shells.
 */
import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DaemonTerminalProxy,
  MAX_DAEMON_RESPAWNS,
  type DaemonClientTransport,
  type DaemonEndpoint,
} from '../../src/main/terminal-daemon/daemon-client';
import { ensureDaemon, type DaemonSpawnResult } from '../../src/main/terminal-daemon/daemon-spawner';

type ConnectOutcome = 'refused' | 'timeout' | 'ok';

/** Scripted transport: each connect() consumes the next outcome; an empty script keeps refusing. */
class ScriptedTransport implements DaemonClientTransport {
  readonly endpoints: DaemonEndpoint[] = [];
  connectCalls = 0;
  private readonly closeHandlers: Array<() => void> = [];
  private connectWaiter: { atLeast: number; resolve: () => void } | null = null;

  constructor(private readonly script: ConnectOutcome[]) {}

  async connect(): Promise<void> {
    this.connectCalls++;
    if (this.connectWaiter && this.connectCalls >= this.connectWaiter.atLeast) {
      this.connectWaiter.resolve();
      this.connectWaiter = null;
    }
    const outcome = this.script.shift() ?? 'refused';
    if (outcome === 'ok') return;
    const err = new Error(outcome) as Error & { code?: string };
    if (outcome === 'refused') err.code = 'ECONNREFUSED';
    throw err;
  }

  async call<T>(): Promise<T> {
    return {} as T;
  }

  onEvent(): () => void {
    return () => {};
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  updateEndpoint(endpoint: DaemonEndpoint): void {
    this.endpoints.push(endpoint);
  }

  close(): void {}

  /** The socket to the old host dropped. */
  drop(): void {
    for (const handler of this.closeHandlers) handler();
  }

  /** Resolves once connect() has been attempted at least `atLeast` times. */
  untilConnectCalls(atLeast: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.connectWaiter = { atLeast, resolve };
    return promise;
  }
}

const proxies: DaemonTerminalProxy[] = [];
function makeProxy(transport: ScriptedTransport, respawn: () => Promise<DaemonSpawnResult>): DaemonTerminalProxy {
  const proxy = new DaemonTerminalProxy({ port: 1, token: 'old' }, {
    client: transport,
    respawn,
    reconnectMinMs: 1,
    reconnectMaxMs: 2,
  });
  proxies.push(proxy);
  return proxy;
}

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.dispose();
});

describe('DaemonTerminalProxy respawn', () => {
  it('respawns after three consecutive refused connects and reconnects to the new host', { timeout: 5000 }, async (t) => {
    t.mock.method(console, 'warn', () => {});
    const transport = new ScriptedTransport(['refused', 'refused', 'refused', 'ok']);
    let respawns = 0;
    const proxy = makeProxy(transport, async () => {
      respawns++;
      return { mode: 'wmi', handle: { mode: 'wmi', pid: 4242, port: 5151, token: 'new', version: 'v2' } };
    });

    const reconnected = once(proxy, 'reconnected');
    transport.drop();
    await reconnected;

    assert.equal(respawns, 1, 'one respawn replaces the dead host');
    assert.deepEqual(transport.endpoints, [{ port: 5151, token: 'new' }], 'the next connect targets the replacement host');
    assert.equal(transport.connectCalls, 4);
  });

  it('never respawns on timeouts, and a non-refused failure resets the refused streak', { timeout: 5000 }, async (t) => {
    t.mock.method(console, 'warn', () => {});
    const transport = new ScriptedTransport([
      'timeout', 'timeout', 'timeout', 'timeout',
      'refused', 'refused', 'timeout', 'refused', 'refused',
      'ok',
    ]);
    let respawns = 0;
    const proxy = makeProxy(transport, async () => {
      respawns++;
      return { mode: 'in-process', reason: 'unexpected' };
    });

    const reconnected = once(proxy, 'reconnected');
    transport.drop();
    await reconnected;

    assert.equal(respawns, 0, 'a busy host (timeouts) or a broken refused streak is never replaced');
    assert.deepEqual(transport.endpoints, []);
    assert.equal(transport.connectCalls, 10);
  });

  it('keeps the old endpoint when respawn is refused, and the circuit breaker caps respawns', { timeout: 5000 }, async (t) => {
    t.mock.method(console, 'warn', () => {});
    const transport = new ScriptedTransport([]);
    let respawns = 0;
    const capReached = Promise.withResolvers<void>();
    makeProxy(transport, async () => {
      respawns++;
      if (respawns === MAX_DAEMON_RESPAWNS) capReached.resolve();
      return { mode: 'in-process', reason: 'respawn refused: daemon pid 7 is alive but not answering' };
    });

    transport.drop();
    await capReached.promise;
    await transport.untilConnectCalls(transport.connectCalls + 10);

    assert.equal(respawns, MAX_DAEMON_RESPAWNS, 'no respawn past the cap inside the window');
    assert.deepEqual(transport.endpoints, [], 'a refused respawn never repoints the transport');
  });
});

describe('ensureDaemon({ onlyIfDead })', () => {
  const previousDataRoot = process.env.ANTIFAN_DATA_ROOT;
  afterEach(() => {
    if (previousDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = previousDataRoot;
  });

  it('refuses to replace a recorded host whose process is alive but not answering', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-daemon-respawn-'));
    process.env.ANTIFAN_DATA_ROOT = root;
    const server = net.createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const closedPort = (server.address() as net.AddressInfo).port;
    server.close();
    await once(server, 'close');
    const recordPath = path.join(root, 'daemon-host', 'daemon.json');
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    // This test process stands in for a live-but-silent host: its pid is alive, nothing answers the port.
    const record = { pid: process.pid, port: closedPort, token: 't', version: 'v1', handshakePath: '' };
    fs.writeFileSync(recordPath, JSON.stringify(record));

    try {
      const result = await ensureDaemon({ onlyIfDead: true });

      assert.equal(result.handle, undefined, 'no replacement host is brought up');
      assert.match(result.reason ?? '', /respawn refused: daemon pid \d+ is alive but not answering/);
      assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, 'utf8')), record, 'the live record is left for the host that still owns it');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
