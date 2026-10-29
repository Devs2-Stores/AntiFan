/**
 * A re-attached terminal host keeps running whatever the staged bundle says (replacing it would end
 * every live shell), but the gap between the running and the staged version must be reported so the
 * user can choose when to restart the daemon.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  daemonVersionStatus,
  ensureDaemon,
  resetDaemonVersionStateForTesting,
} from '../../src/main/terminal-daemon/daemon-spawner';

describe('daemon version reporting', () => {
  const previousDataRoot = process.env.ANTIFAN_DATA_ROOT;
  let root = '';
  let hostRoot = '';
  let server: WebSocketServer | undefined;

  /** A host that answers terminalHostPing, recorded in daemon.json as owned by this (live) process. */
  const attachHost = async (runningVersion: string): Promise<{ record: string; port: number }> => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as { id: string; method: string };
        socket.send(JSON.stringify({ id: frame.id, success: frame.method === 'terminalHostPing', data: {} }));
      });
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const record = JSON.stringify({ pid: process.pid, port, token: 't', version: runningVersion, handshakePath: '' });
    fs.writeFileSync(path.join(hostRoot, 'daemon.json'), record);
    return { record, port };
  };

  const stage = (version: string): void => {
    const entry = path.join(hostRoot, 'entry.js');
    fs.writeFileSync(entry, '// staged bundle');
    fs.writeFileSync(path.join(hostRoot, 'current.json'), JSON.stringify({ version, dir: hostRoot, entry }));
  };

  const logLines = (): string[] => {
    try {
      return fs.readFileSync(path.join(hostRoot, 'daemon.log'), 'utf8').split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-daemon-version-'));
    hostRoot = path.join(root, 'daemon-host');
    fs.mkdirSync(hostRoot, { recursive: true });
    process.env.ANTIFAN_DATA_ROOT = root;
    resetDaemonVersionStateForTesting();
  });

  afterEach(async () => {
    if (server) {
      for (const client of server.clients) client.terminate();
      server.close();
      server = undefined;
    }
    resetDaemonVersionStateForTesting();
    if (previousDataRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = previousDataRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('attaches to a live host older than the staged bundle, flags it outdated and leaves the host and its record alone', async () => {
    const { record } = await attachHost('v-old');
    stage('v-new');

    const result = await ensureDaemon();

    assert.equal(result.mode, 'attached', 'a healthy recorded host is never replaced');
    assert.equal(result.handle?.version, 'v-old');
    assert.equal(result.handle?.outdated, true);
    assert.deepEqual(daemonVersionStatus(), { running: 'v-old', staged: 'v-new', outdated: true });
    assert.equal(fs.readFileSync(path.join(hostRoot, 'daemon.json'), 'utf8'), record, 'daemon.json is untouched');
    const mismatch = logLines().filter((line) => line.includes('v-old') && line.includes('v-new'));
    assert.equal(mismatch.length, 1, 'the gap is written to daemon.log');

    await ensureDaemon();
    assert.equal(logLines().filter((line) => line.includes('v-old') && line.includes('v-new')).length, 1, 'the same pair is logged once per process');
  });

  it('reports a host on the staged version as current', async () => {
    await attachHost('v-same');
    stage('v-same');

    const result = await ensureDaemon();

    assert.equal(result.mode, 'attached');
    assert.equal(result.handle?.outdated, false);
    assert.deepEqual(daemonVersionStatus(), { running: 'v-same', staged: 'v-same', outdated: false });
    assert.deepEqual(logLines(), [], 'nothing is logged when the versions match');
  });

  it('is not outdated while no host was attached or nothing is staged', async () => {
    assert.deepEqual(daemonVersionStatus(), { outdated: false });

    await attachHost('v-old');
    const result = await ensureDaemon();
    assert.equal(result.handle?.outdated, false, 'with nothing staged there is nothing to be older than');
    assert.deepEqual(daemonVersionStatus(), { running: 'v-old', outdated: false });
  });
});
