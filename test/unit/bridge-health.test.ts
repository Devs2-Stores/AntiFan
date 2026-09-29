/**
 * Unit tests for Bridge Health Surface (Component 2)
 *
 * Covers:
 * - Absent record (HEALTH_RECORD_ABSENT)
 * - Corrupt record (HEALTH_RECORD_CORRUPT)
 * - Legacy record with live pid => degraded (HEALTH_RECORD_LEGACY)
 * - Legacy record with dead pid => down (HEALTH_PID_DEAD)
 * - Stale record (> 3 * heartbeatMs) => down (HEALTH_STALE)
 * - Fresh record => record's own health
 * - Custom heartbeatMs honored for staleness
 * - isPidAlive behavior (live pid, dead pid, invalid pid)
 * - Client failure journal tail reader (window filtering, torn last line, oversized file > 32KB)
 * - Report composition & honesty rules:
 *   - Same pid => prefers live memory
 *   - Different or absent pid => record rules
 *   - Deferred start window (BridgeServer not constructed yet) => never throws
 * - Module-level subscription channel
 * - Path resolvers with explicit override and env vars
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BRIDGE_HEALTH_HEARTBEAT_MS,
  BRIDGE_FAILURE_RECENCY_MS,
  BRIDGE_HEALTH_STALE_MULTIPLIER,
  BRIDGE_CLIENT_FAILURE_WINDOW_MS,
  BRIDGE_CLIENT_FAILURE_JOURNAL_MAX_BYTES,
  BRIDGE_CLIENT_FAILURE_TAIL_BYTES,
  bridgeInfoPath,
  bridgeClientFailuresPath,
  readBridgeInfo,
  isPidAlive,
  evaluateBridgeHealth,
  readRecentClientFailures,
  buildBridgeHealthReport,
  subscribeBridgeHealth,
  emitBridgeHealthChanged,
  setMockBridgeServer,
  type LiveBridgeServerLike,
} from '../../src/main/bridge/bridge-health';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

const DEAD_PID = 2147483640;

describe('Bridge Health Constants', () => {
  test('constants match specification values', () => {
    assert.strictEqual(BRIDGE_HEALTH_HEARTBEAT_MS, 5000);
    assert.strictEqual(BRIDGE_FAILURE_RECENCY_MS, 120_000);
    assert.strictEqual(BRIDGE_HEALTH_STALE_MULTIPLIER, 3);
    assert.strictEqual(BRIDGE_CLIENT_FAILURE_WINDOW_MS, 120_000);
    assert.strictEqual(BRIDGE_CLIENT_FAILURE_JOURNAL_MAX_BYTES, 256 * 1024);
    assert.strictEqual(BRIDGE_CLIENT_FAILURE_TAIL_BYTES, 32 * 1024);
  });
});

describe('Bridge Path Resolvers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir('bridge-paths-');
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('bridgeInfoPath accepts explicit override', () => {
    const custom = path.join(tmpDir, 'custom-bridge.json');
    assert.strictEqual(bridgeInfoPath(custom), custom);
  });

  test('bridgeClientFailuresPath accepts explicit override', () => {
    const custom = path.join(tmpDir, 'custom-failures.jsonl');
    assert.strictEqual(bridgeClientFailuresPath(custom), custom);
  });

  test('bridgeInfoPath respects ANTIFAN_CONFIG_DIR env var', () => {
    const oldEnv = process.env.ANTIFAN_CONFIG_DIR;
    try {
      process.env.ANTIFAN_CONFIG_DIR = tmpDir;
      const resolved = bridgeInfoPath();
      assert.ok(resolved.startsWith(tmpDir));
    } finally {
      if (oldEnv !== undefined) {
        process.env.ANTIFAN_CONFIG_DIR = oldEnv;
      } else {
        delete process.env.ANTIFAN_CONFIG_DIR;
      }
    }
  });

  test('bridgeClientFailuresPath respects ANTIFAN_DATA_ROOT env var', () => {
    const oldEnv = process.env.ANTIFAN_DATA_ROOT;
    try {
      process.env.ANTIFAN_DATA_ROOT = tmpDir;
      const resolved = bridgeClientFailuresPath();
      assert.strictEqual(resolved, path.join(tmpDir, 'runtime', 'bridge-client-failures.jsonl'));
    } finally {
      if (oldEnv !== undefined) {
        process.env.ANTIFAN_DATA_ROOT = oldEnv;
      } else {
        delete process.env.ANTIFAN_DATA_ROOT;
      }
    }
  });
});

describe('isPidAlive', () => {
  test('returns true for current process.pid', () => {
    assert.strictEqual(isPidAlive(process.pid), true);
  });

  test('returns false for dead pid', () => {
    assert.strictEqual(isPidAlive(DEAD_PID), false);
  });

  test('returns false for non-positive or non-integer pids', () => {
    assert.strictEqual(isPidAlive(0), false);
    assert.strictEqual(isPidAlive(-1), false);
    assert.strictEqual(isPidAlive(NaN), false);
    assert.strictEqual(isPidAlive(1.5), false);
  });
});

describe('readBridgeInfo & evaluateBridgeHealth with real files in temp dir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir('bridge-eval-');
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('absent record evaluates to down with HEALTH_RECORD_ABSENT', () => {
    const filePath = path.join(tmpDir, 'nonexistent-bridge.json');
    const record = readBridgeInfo(filePath);
    assert.strictEqual(record, null);

    const evaluated = evaluateBridgeHealth(record, Date.now());
    assert.strictEqual(evaluated.state, 'down');
    assert.strictEqual(evaluated.reasonCode, 'HEALTH_RECORD_ABSENT');
  });

  test('corrupt record evaluates to down with HEALTH_RECORD_CORRUPT', () => {
    const filePath = path.join(tmpDir, 'corrupt-bridge.json');
    fs.writeFileSync(filePath, '{"port": 20129, broken_json');

    const record = readBridgeInfo(filePath);
    assert.notStrictEqual(record, null);
    assert.strictEqual(record?.corrupt, true);

    const evaluated = evaluateBridgeHealth(record, Date.now());
    assert.strictEqual(evaluated.state, 'down');
    assert.strictEqual(evaluated.reasonCode, 'HEALTH_RECORD_CORRUPT');
  });

  test('corrupt record with non-object JSON evaluates to HEALTH_RECORD_CORRUPT', () => {
    const filePath = path.join(tmpDir, 'non-object.json');
    fs.writeFileSync(filePath, '12345');

    const record = readBridgeInfo(filePath);
    assert.strictEqual(record?.corrupt, true);

    const evaluated = evaluateBridgeHealth(record, Date.now());
    assert.strictEqual(evaluated.state, 'down');
    assert.strictEqual(evaluated.reasonCode, 'HEALTH_RECORD_CORRUPT');
  });

  test('legacy record with live pid evaluates to degraded with HEALTH_RECORD_LEGACY', () => {
    const filePath = path.join(tmpDir, 'legacy-live.json');
    // Pre-change record: port, host, pid, startedAt, no health, no updatedAt
    const legacy = {
      port: 20129,
      host: '127.0.0.1',
      pid: process.pid,
      startedAt: Date.now() - 10_000,
      isDev: false,
      protocolVersion: 1,
      endpoints: { status: '/status' },
    };
    fs.writeFileSync(filePath, JSON.stringify(legacy));

    const record = readBridgeInfo(filePath);
    assert.notStrictEqual(record, null);
    assert.strictEqual(record?.corrupt, undefined);

    const evaluated = evaluateBridgeHealth(record, Date.now());
    assert.strictEqual(evaluated.state, 'degraded');
    assert.strictEqual(evaluated.reasonCode, 'HEALTH_RECORD_LEGACY');
  });

  test('legacy record with dead pid evaluates to down with HEALTH_PID_DEAD', () => {
    const filePath = path.join(tmpDir, 'legacy-dead.json');
    const legacy = {
      port: 20129,
      host: '127.0.0.1',
      pid: DEAD_PID,
      startedAt: Date.now() - 10_000,
      isDev: false,
    };
    fs.writeFileSync(filePath, JSON.stringify(legacy));

    const record = readBridgeInfo(filePath);
    assert.notStrictEqual(record, null);

    const evaluated = evaluateBridgeHealth(record, Date.now());
    assert.strictEqual(evaluated.state, 'down');
    assert.strictEqual(evaluated.reasonCode, 'HEALTH_PID_DEAD');
  });

  test('stale updatedAt beyond 3 * heartbeatMs evaluates to down with HEALTH_STALE', () => {
    const filePath = path.join(tmpDir, 'stale.json');
    const now = 1_000_000;
    // Stale: updatedAt is older than now - 3 * 5000 (15,000 ms)
    const freshRecord = {
      port: 20129,
      host: '127.0.0.1',
      pid: process.pid,
      health: 'listening',
      heartbeatMs: 5000,
      updatedAt: now - 15_001, // 1 ms beyond 3 * 5000
    };
    fs.writeFileSync(filePath, JSON.stringify(freshRecord));

    const record = readBridgeInfo(filePath);
    assert.notStrictEqual(record, null);

    const evaluated = evaluateBridgeHealth(record, now);
    assert.strictEqual(evaluated.state, 'down');
    assert.strictEqual(evaluated.reasonCode, 'HEALTH_STALE');
  });

  test('stale threshold respects custom heartbeatMs from record', () => {
    const now = 2_000_000;
    // Custom heartbeatMs = 10,000 ms. Stale threshold = 3 * 10,000 = 30,000 ms.
    // If updatedAt is 20,000 ms ago: fresh with custom heartbeat, but stale if default 5000ms was used!
    const record = {
      port: 20129,
      pid: process.pid,
      health: 'listening' as const,
      heartbeatMs: 10_000,
      updatedAt: now - 20_000,
    };

    const evaluated = evaluateBridgeHealth(record, now);
    // Because 20,000 <= 3 * 10,000 (30,000), it is NOT stale
    assert.strictEqual(evaluated.state, 'listening');
    assert.strictEqual(evaluated.reasonCode, undefined);

    // But if updatedAt is 30,001 ms ago: it IS stale
    const staleRecord = {
      ...record,
      updatedAt: now - 30_001,
    };
    const evaluatedStale = evaluateBridgeHealth(staleRecord, now);
    assert.strictEqual(evaluatedStale.state, 'down');
    assert.strictEqual(evaluatedStale.reasonCode, 'HEALTH_STALE');
  });

  test('fresh record evaluates to its own health', () => {
    const now = 1_000_000;
    const listeningRec = {
      port: 20129,
      pid: process.pid,
      health: 'listening' as const,
      heartbeatMs: 5000,
      updatedAt: now - 2000,
    };
    assert.strictEqual(evaluateBridgeHealth(listeningRec, now).state, 'listening');

    const degradedRec = {
      port: 20129,
      pid: process.pid,
      health: 'degraded' as const,
      heartbeatMs: 5000,
      updatedAt: now - 2000,
    };
    assert.strictEqual(evaluateBridgeHealth(degradedRec, now).state, 'degraded');

    const downRec = {
      port: 20129,
      pid: process.pid,
      health: 'down' as const,
      heartbeatMs: 5000,
      updatedAt: now - 2000,
    };
    assert.strictEqual(evaluateBridgeHealth(downRec, now).state, 'down');
  });
});

describe('readRecentClientFailures journal tail reader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir('bridge-journal-');
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test('absent journal returns count 0', () => {
    const result = readRecentClientFailures(path.join(tmpDir, 'absent.jsonl'));
    assert.strictEqual(result.count, 0);
  });

  test('empty journal returns count 0', () => {
    const file = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    const result = readRecentClientFailures(file);
    assert.strictEqual(result.count, 0);
  });

  test('window filtering: only failures within 120s are counted', () => {
    const file = path.join(tmpDir, 'window.jsonl');
    const now = 1_000_000;
    const rows = [
      // Old row (130s ago): outside 120s window
      JSON.stringify({ at: now - 130_000, code: 'MCP_BRIDGE_OFFLINE', message: 'too old' }),
      // Inside window (60s ago)
      JSON.stringify({ at: now - 60_000, code: 'CONNECT_FAILED', message: 'conn refused', terminalSessionId: 'term-1' }),
      // Inside window (10s ago)
      JSON.stringify({ at: now - 10_000, code: 'PAIRING_UNAVAILABLE', message: 'no queue', terminalSessionId: 'term-2' }),
    ].join('\n');

    fs.writeFileSync(file, rows);

    const result = readRecentClientFailures(file, now);
    assert.strictEqual(result.count, 2);
    assert.strictEqual(result.latestAt, now - 10_000);
    assert.strictEqual(result.latest?.code, 'PAIRING_UNAVAILABLE');
    assert.strictEqual(result.latest?.terminalSessionId, 'term-2');
  });

  test('skips malformed and torn lines cleanly', () => {
    const file = path.join(tmpDir, 'torn.jsonl');
    const now = 1_000_000;
    const content = [
      JSON.stringify({ at: now - 5000, code: 'CONNECT_FAILED', message: 'ok 1' }),
      '{"at": ' + (now - 4000) + ', "code": "BROKEN_JSON', // torn line
      'random garbage not json',
      JSON.stringify({ at: now - 2000, code: 'CONNECT_FAILED', message: 'ok 2', terminalSessionId: 'term-x' }),
      '{"truncated_tail": true', // torn last line
    ].join('\n');

    fs.writeFileSync(file, content);

    const result = readRecentClientFailures(file, now);
    assert.strictEqual(result.count, 2);
    assert.strictEqual(result.latestAt, now - 2000);
    assert.strictEqual(result.latest?.terminalSessionId, 'term-x');
  });

  test('oversized journal: reads only the tail 32KB, ignoring head entries', () => {
    const file = path.join(tmpDir, 'oversized.jsonl');
    const now = 1_000_000;

    // Create a file larger than BRIDGE_CLIENT_FAILURE_TAIL_BYTES (32 KB = 32,768 bytes).
    // In the head (> 32KB before the end), put 5 failures in the window.
    // In the tail (last 16KB), put 2 failures in the window.
    // If the reader only parses the tail, it will count 2.
    // If a buggy reader parsed the whole file, it would count 7!

    const headEntries = [];
    for (let i = 0; i < 5; i++) {
      headEntries.push(JSON.stringify({ at: now - 50_000 + i, code: 'HEAD_FAILURE', message: 'head failure' }));
    }
    const headText = headEntries.join('\n') + '\n';

    // Padding to ensure file size exceeds 32KB + head text size
    const paddingLine = '{"at": ' + (now - 200_000) + ', "code": "OLD", "message": "' + 'X'.repeat(500) + '"}\n';
    const paddingCount = 75; // 75 * ~540 bytes ≈ 40 KB
    const padding = paddingLine.repeat(paddingCount);

    const tailEntries = [
      JSON.stringify({ at: now - 1000, code: 'TAIL_FAILURE_1', message: 'tail 1' }),
      JSON.stringify({ at: now - 500, code: 'TAIL_FAILURE_2', message: 'tail 2', terminalSessionId: 'term-tail' }),
    ].join('\n') + '\n';

    fs.writeFileSync(file, headText + padding + tailEntries);

    const stat = fs.statSync(file);
    assert.ok(stat.size > BRIDGE_CLIENT_FAILURE_TAIL_BYTES, `File size ${stat.size} must be > ${BRIDGE_CLIENT_FAILURE_TAIL_BYTES}`);

    const result = readRecentClientFailures(file, now);
    // Must ONLY count the tail entries (2), not the head entries (5)
    assert.strictEqual(result.count, 2);
    assert.strictEqual(result.latest?.code, 'TAIL_FAILURE_2');
    assert.strictEqual(result.latest?.terminalSessionId, 'term-tail');
  });
});

describe('buildBridgeHealthReport composition & honesty rules', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir('bridge-report-');
    setMockBridgeServer(null);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
    setMockBridgeServer(null);
  });

  test('deferred start window (BridgeServer instance null, record absent) returns safe down report', () => {
    setMockBridgeServer(null);
    const infoFile = path.join(tmpDir, 'absent-bridge.json');
    const failuresFile = path.join(tmpDir, 'absent-failures.jsonl');

    const report = buildBridgeHealthReport(Date.now(), { infoPath: infoFile, failuresPath: failuresFile });

    assert.strictEqual(report.active, false);
    assert.strictEqual(report.state, 'down');
    assert.strictEqual(report.health, 'down');
    assert.strictEqual(report.reasonCode, 'HEALTH_RECORD_ABSENT');
    assert.strictEqual(report.record.present, false);
    assert.strictEqual(report.record.stale, false);
    assert.strictEqual(report.clientFailures.count, 0);
  });

  test('Rule 1: Same pid prefers live memory derivation', () => {
    const infoFile = path.join(tmpDir, 'bridge.json');
    const now = 1_000_000;

    // Record on disk has lagging/stale stamp, but same pid as process.pid
    const diskRecord = {
      port: 20129,
      host: '127.0.0.1',
      pid: process.pid,
      health: 'listening' as const,
      heartbeatMs: 5000,
      updatedAt: now - 20_000, // file has not updated in 20s
    };
    fs.writeFileSync(infoFile, JSON.stringify(diskRecord));

    // Live BridgeServer instance is listening and healthy
    const mockServer: LiveBridgeServerLike = {
      getStatus: () => ({
        active: true,
        port: 20129,
        clientCount: 2,
        tabCount: 1,
        inspecting: false,
        health: 'listening',
      }),
      isDev: false,
    };
    setMockBridgeServer(mockServer);

    const report = buildBridgeHealthReport(now, { infoPath: infoFile });

    // Same pid => memory derivation is preferred, so state is 'listening'
    assert.strictEqual(report.state, 'listening');
    assert.strictEqual(report.reasonCode, undefined);
    assert.strictEqual(report.active, true);
    assert.strictEqual(report.clientCount, 2);
    assert.strictEqual(report.record.present, true);
    assert.strictEqual(report.record.stale, true); // the file itself is reported stale
  });

  test('Rule 2: Different pid causes the record rules to win', () => {
    const infoFile = path.join(tmpDir, 'bridge.json');
    const now = 1_000_000;

    // Record on disk has a DEAD pid
    const diskRecord = {
      port: 20129,
      host: '127.0.0.1',
      pid: DEAD_PID,
      health: 'listening' as const,
      heartbeatMs: 5000,
      updatedAt: now - 1000, // fresh timestamp, but DEAD pid
    };
    fs.writeFileSync(infoFile, JSON.stringify(diskRecord));

    // Even if a mock server claims active:
    const mockServer: LiveBridgeServerLike = {
      getStatus: () => ({
        active: true,
        port: 20129,
        clientCount: 1,
        tabCount: 1,
        inspecting: false,
        health: 'listening',
      }),
      isDev: false,
    };
    setMockBridgeServer(mockServer);

    const report = buildBridgeHealthReport(now, { infoPath: infoFile });

    // Different pid => record evaluation wins, dead pid reports down
    assert.strictEqual(report.state, 'down');
    assert.strictEqual(report.reasonCode, 'HEALTH_PID_DEAD');
    assert.strictEqual(report.active, false);
  });

  test('folds client failures and server failures into composite report', () => {
    const infoFile = path.join(tmpDir, 'bridge.json');
    const failuresFile = path.join(tmpDir, 'failures.jsonl');
    const now = 1_000_000;

    const diskRecord = {
      port: 20129,
      host: '127.0.0.1',
      pid: process.pid,
      health: 'degraded' as const,
      lastFailure: { code: 'PAIRING_REFUSED', message: 'pairing code expired', at: now - 3000 },
      heartbeatMs: 5000,
      updatedAt: now - 1000,
    };
    fs.writeFileSync(infoFile, JSON.stringify(diskRecord));

    const failureRow = {
      at: now - 2000,
      code: 'CONNECT_FAILED',
      message: 'connection refused',
      terminalSessionId: 'term-42',
    };
    fs.writeFileSync(failuresFile, JSON.stringify(failureRow) + '\n');

    const mockServer: LiveBridgeServerLike = {
      getStatus: () => ({
        active: true,
        port: 20129,
        clientCount: 0,
        tabCount: 2,
        inspecting: false,
        health: 'degraded',
        lastFailure: diskRecord.lastFailure,
      }),
      isDev: false,
    };
    setMockBridgeServer(mockServer);

    const report = buildBridgeHealthReport(now, { infoPath: infoFile, failuresPath: failuresFile });

    assert.strictEqual(report.state, 'degraded');
    assert.strictEqual(report.lastFailure?.code, 'PAIRING_REFUSED');
    assert.strictEqual(report.clientFailures.count, 1);
    assert.strictEqual(report.clientFailures.latest?.code, 'CONNECT_FAILED');
    assert.strictEqual(report.clientFailures.latest?.terminalSessionId, 'term-42');
  });
});

describe('subscribeBridgeHealth & emitBridgeHealthChanged', () => {
  test('registered listeners receive notifications; unsubscribe stops them', () => {
    let callCount = 0;
    const listener = () => {
      callCount++;
    };

    const unsubscribe = subscribeBridgeHealth(listener);
    emitBridgeHealthChanged();
    assert.strictEqual(callCount, 1);

    emitBridgeHealthChanged();
    assert.strictEqual(callCount, 2);

    unsubscribe();
    emitBridgeHealthChanged();
    assert.strictEqual(callCount, 2);
  });
});
