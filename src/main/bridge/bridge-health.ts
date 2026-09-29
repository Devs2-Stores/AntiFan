/**
 * AntiFan Bridge Health Surface
 *
 * Owns the reading rules, evaluation precedence, and composite health reporting
 * for the MCP bridge socket.
 *
 * Implements Component 2 of docs/superpowers/specs/2026-09-28-manager-bridge-health-design.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StorageLocations } from '../config/storage-locations';
import type {
  BridgeHealthState,
  BridgeFailureRecord,
  BridgeHealthReasonCode,
  BridgeClientFailureRow,
  BridgeHealthReport,
} from '../../shared/contracts';
import type { BridgeServer } from './bridge-server';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BRIDGE_HEALTH_HEARTBEAT_MS = 5000;
export const BRIDGE_FAILURE_RECENCY_MS = 120_000;
export const BRIDGE_HEALTH_STALE_MULTIPLIER = 3;
export const BRIDGE_CLIENT_FAILURE_WINDOW_MS = 120_000;
export const BRIDGE_CLIENT_FAILURE_JOURNAL_MAX_BYTES = 256 * 1024;
export const BRIDGE_CLIENT_FAILURE_TAIL_BYTES = 32 * 1024;

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export interface BridgeDiscoveryRecord {
  port?: number;
  host?: string;
  pid?: number;
  startedAt?: number;
  isDev?: boolean;
  protocolVersion?: number;
  endpoints?: Record<string, string>;
  health?: BridgeHealthState;
  lastFailure?: BridgeFailureRecord;
  heartbeatMs?: number;
  updatedAt?: number;
  corrupt?: boolean;
  [key: string]: unknown;
}

export interface BuildBridgeHealthReportOptions {
  infoPath?: string;
  failuresPath?: string;
}

export interface LiveBridgeServerLike {
  getStatus(): {
    active: boolean;
    port: number;
    clientCount: number;
    activeTabId?: string;
    tabCount: number;
    inspecting: boolean;
    sidebarOpen?: boolean;
    health?: BridgeHealthState;
    lastFailure?: BridgeFailureRecord;
  };
  isDev?: boolean;
}

// ---------------------------------------------------------------------------
// Mocking / Dependency Injection Hooks for Testing
// ---------------------------------------------------------------------------

let mockBridgeServer: LiveBridgeServerLike | null = null;

export function setMockBridgeServer(mock: LiveBridgeServerLike | null): void {
  mockBridgeServer = mock;
}

function getBridgeServerInstance(): LiveBridgeServerLike | null {
  if (mockBridgeServer !== null) {
    return mockBridgeServer;
  }
  try {
    if (typeof require !== 'function') return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod: unknown = require('./bridge-server');
    if (mod && typeof mod === 'object' && 'BridgeServer' in mod) {
      const serverClass = mod.BridgeServer;
      if (serverClass && typeof serverClass === 'object' && 'getInstance' in serverClass) {
        const getter = serverClass.getInstance;
        if (typeof getter === 'function') {
          const inst: unknown = getter();
          return (inst as LiveBridgeServerLike | null);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isDevMode(): boolean {
  try {
    const instance = getBridgeServerInstance();
    if (instance && typeof instance.isDev === 'boolean') {
      return instance.isDev;
    }
  } catch {}
  const isProd = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
  return !isProd;
}

// ---------------------------------------------------------------------------
// Path Resolvers
// ---------------------------------------------------------------------------

/**
 * Returns the path to the bridge discovery file.
 * The writer's own rule: ANTIFAN_CONFIG_DIR || StorageLocations.getConfigDir(),
 * bridge-dev.json when dev mode, bridge.json otherwise.
 *
 * Accepts an explicit override path so tests never touch real app state.
 */
export function bridgeInfoPath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  let configDir = process.env.ANTIFAN_CONFIG_DIR;
  if (!configDir) {
    if (process.env.ANTIFAN_DATA_ROOT) {
      configDir = path.join(process.env.ANTIFAN_DATA_ROOT, 'config');
    } else {
      try {
        configDir = StorageLocations.getConfigDir();
      } catch {
        configDir = path.join(os.homedir(), '.antifan', 'config');
      }
    }
  }
  const isDev = isDevMode();
  return path.join(configDir, isDev ? 'bridge-dev.json' : 'bridge.json');
}

/**
 * Returns the path to the bridge client failures journal.
 * <runtimeDir>/bridge-client-failures.jsonl
 *
 * Accepts an explicit override path so tests never touch real app state.
 */
export function bridgeClientFailuresPath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  let runtimeDir: string;
  if (process.env.ANTIFAN_DATA_ROOT) {
    runtimeDir = path.join(process.env.ANTIFAN_DATA_ROOT, 'runtime');
  } else {
    try {
      runtimeDir = StorageLocations.getRuntimeDir();
    } catch {
      runtimeDir = path.join(os.homedir(), '.antifan', 'runtime');
    }
  }
  return path.join(runtimeDir, 'bridge-client-failures.jsonl');
}

// ---------------------------------------------------------------------------
// Readers & Evaluators
// ---------------------------------------------------------------------------

/**
 * Reads and parses the bridge discovery record.
 * Returns the parsed record, or null if absent, or { corrupt: true } if unparseable.
 * Never throws.
 */
export function readBridgeInfo(file?: string): BridgeDiscoveryRecord | null {
  const filePath = bridgeInfoPath(file);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { corrupt: true };
      }
      return parsed as BridgeDiscoveryRecord;
    } catch {
      return { corrupt: true };
    }
  } catch {
    return null;
  }
}

/**
 * Checks process liveness via kill signal 0.
 * ESRCH => dead (false)
 * EPERM => alive (true: uninspectable is not down; freshness carries the verdict)
 * Any other throw => treated dead-but-flagged via updatedAt staleness rather than direct verdict (true)
 * Exported for cross-module usage (e.g. run-state service).
 */
export function isPidAlive(pid: number): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err) {
      const errCode = err.code;
      if (errCode === 'EPERM') {
        return true;
      }
      if (errCode === 'ESRCH') {
        return false;
      }
    }
    return true;
  }
}

/**
 * Evaluates the health state of a bridge discovery record.
 * Precedence:
 * 1. HEALTH_RECORD_ABSENT when no record (null/undefined)
 * 2. HEALTH_RECORD_CORRUPT when record exists but does not parse
 * 3. HEALTH_PID_DEAD when the recorded pid is gone (regardless of updatedAt)
 * 4. HEALTH_RECORD_LEGACY when record parses but has no health/updatedAt:
 *    alive pid => degraded (HEALTH_RECORD_LEGACY), dead pid => down (HEALTH_PID_DEAD above)
 * 5. HEALTH_STALE when now - updatedAt > 3 * (record.heartbeatMs || BRIDGE_HEALTH_HEARTBEAT_MS)
 * 6. Record's own health (listening/degraded/down)
 */
export function evaluateBridgeHealth(
  record: BridgeDiscoveryRecord | null,
  now = Date.now()
): { state: BridgeHealthState; reasonCode?: BridgeHealthReasonCode } {
  if (!record) {
    return { state: 'down', reasonCode: 'HEALTH_RECORD_ABSENT' };
  }
  if (record.corrupt) {
    return { state: 'down', reasonCode: 'HEALTH_RECORD_CORRUPT' };
  }
  if (typeof record.pid === 'number' && !isPidAlive(record.pid)) {
    return { state: 'down', reasonCode: 'HEALTH_PID_DEAD' };
  }
  const updatedAt = record.updatedAt;
  const isLegacy = record.health === undefined || typeof updatedAt !== 'number';
  if (isLegacy) {
    return { state: 'degraded', reasonCode: 'HEALTH_RECORD_LEGACY' };
  }
  const heartbeat =
    typeof record.heartbeatMs === 'number' && record.heartbeatMs > 0
      ? record.heartbeatMs
      : BRIDGE_HEALTH_HEARTBEAT_MS;
  const staleThreshold = BRIDGE_HEALTH_STALE_MULTIPLIER * heartbeat;
  if (now - updatedAt > staleThreshold) {
    return { state: 'down', reasonCode: 'HEALTH_STALE' };
  }
  return {
    state: record.health || 'listening',
  };
}

/**
 * Reads recent client failure rows from the tail of the journal.
 * Reads at most BRIDGE_CLIENT_FAILURE_TAIL_BYTES (32 KB) from the end of the file.
 * Line-wise parses, skipping malformed or torn rows.
 * Returns rows inside the time window [now - windowMs, now + 60s].
 */
export function readRecentClientFailures(
  file?: string,
  now = Date.now(),
  windowMs = BRIDGE_CLIENT_FAILURE_WINDOW_MS
): { count: number; latestAt?: number; latest?: BridgeClientFailureRow } {
  const filePath = bridgeClientFailuresPath(file);
  try {
    if (!fs.existsSync(filePath)) {
      return { count: 0 };
    }
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      return { count: 0 };
    }

    let raw = '';
    if (stat.size <= BRIDGE_CLIENT_FAILURE_TAIL_BYTES) {
      raw = fs.readFileSync(filePath, 'utf8');
    } else {
      const bytesToRead = BRIDGE_CLIENT_FAILURE_TAIL_BYTES;
      const start = stat.size - bytesToRead;
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(bytesToRead);
      try {
        fs.readSync(fd, buf, 0, bytesToRead, start);
      } finally {
        fs.closeSync(fd);
      }
      raw = buf.toString('utf8');
      // Sliced into the middle of the file: skip the first partial/torn line
      const firstNewline = raw.indexOf('\n');
      if (firstNewline !== -1) {
        raw = raw.slice(firstNewline + 1);
      } else {
        raw = '';
      }
    }

    const lines = raw.split(/\r?\n/);
    let count = 0;
    let latestAt: number | undefined;
    let latest: BridgeClientFailureRow | undefined;

    const minAt = now - windowMs;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (
          row &&
          typeof row === 'object' &&
          typeof row.at === 'number' &&
          typeof row.code === 'string' &&
          typeof row.message === 'string'
        ) {
          if (row.at >= minAt && row.at <= now + 60_000) {
            count++;
            if (latestAt === undefined || row.at >= latestAt) {
              latestAt = row.at;
              latest = {
                at: row.at,
                code: row.code,
                message: row.message,
                ...(row.terminalSessionId ? { terminalSessionId: row.terminalSessionId } : {}),
                ...(typeof row.pid === 'number' ? { pid: row.pid } : {}),
              };
            }
          }
        }
      } catch {
        // Skip malformed or torn line
        continue;
      }
    }

    if (count === 0) {
      return { count: 0 };
    }
    return { count, latestAt, latest };
  } catch {
    return { count: 0 };
  }
}

/**
 * Builds the composite BridgeHealthReport.
 * Never throws.
 *
 * Implements field ownership and the two honesty rules:
 * - Rule 1 (Same pid => prefer memory): When the record's pid is this process and the
 *   instance exists, the in-process derivation is the answer.
 * - Rule 2 (Different or absent pid => record rules): evaluateBridgeHealth wins,
 *   so a dead server can never report listening, and an absent instance reports down.
 */
export function buildBridgeHealthReport(
  now = Date.now(),
  options?: BuildBridgeHealthReportOptions | string,
  explicitFailuresPath?: string
): BridgeHealthReport {
  let infoPathOverride: string | undefined;
  let failuresPathOverride: string | undefined;

  if (typeof options === 'string') {
    infoPathOverride = options;
    failuresPathOverride = explicitFailuresPath;
  } else if (options && typeof options === 'object') {
    infoPathOverride = options.infoPath;
    failuresPathOverride = options.failuresPath;
  }

  const record = readBridgeInfo(infoPathOverride);
  const evaluated = evaluateBridgeHealth(record, now);
  const clientFailures = readRecentClientFailures(failuresPathOverride, now);

  const server = getBridgeServerInstance();
  const liveStatus = server ? server.getStatus() : null;

  const isSamePid = Boolean(
    server &&
    liveStatus &&
    record &&
    typeof record.pid === 'number' &&
    record.pid === process.pid
  );

  let state: BridgeHealthState;
  let reasonCode: BridgeHealthReasonCode | undefined;
  let health: BridgeHealthState;
  let active: boolean;
  let port: number;
  let clientCount: number;
  let activeTabId: string | undefined;
  let tabCount: number;
  let inspecting: boolean;
  let sidebarOpen: boolean | undefined;
  let lastFailure: BridgeFailureRecord | undefined;

  if (isSamePid && liveStatus) {
    // Rule 1: Same pid => prefer memory
    state = liveStatus.health || (liveStatus.active ? 'listening' : 'down');
    reasonCode = undefined;
    health = liveStatus.health || 'listening';
    active = Boolean(liveStatus.active);
    port = liveStatus.port || 0;
    clientCount = liveStatus.clientCount || 0;
    activeTabId = liveStatus.activeTabId;
    tabCount = liveStatus.tabCount || 0;
    inspecting = Boolean(liveStatus.inspecting);
    sidebarOpen = liveStatus.sidebarOpen;
    lastFailure = liveStatus.lastFailure || record?.lastFailure;
  } else {
    // Rule 2: Different or absent pid => the record rules
    state = evaluated.state;
    reasonCode = evaluated.reasonCode;
    health = record?.health || (liveStatus?.health ?? 'down');
    active = state === 'down' ? false : Boolean(liveStatus?.active ?? false);
    port = (liveStatus?.port ?? record?.port) || 0;
    clientCount = liveStatus?.clientCount ?? 0;
    activeTabId = liveStatus?.activeTabId;
    tabCount = liveStatus?.tabCount ?? 0;
    inspecting = Boolean(liveStatus?.inspecting ?? false);
    sidebarOpen = liveStatus?.sidebarOpen;
    lastFailure = record?.lastFailure || liveStatus?.lastFailure;
  }

  const reportRecord = {
    present: Boolean(record && !record.corrupt),
    stale: evaluated.reasonCode === 'HEALTH_STALE',
    ...(record && typeof record.updatedAt === 'number' ? { updatedAt: record.updatedAt } : {}),
  };

  const report: BridgeHealthReport = {
    active,
    port,
    clientCount,
    ...(activeTabId !== undefined ? { activeTabId } : {}),
    tabCount,
    inspecting,
    ...(sidebarOpen !== undefined ? { sidebarOpen } : {}),
    health,
    ...(lastFailure ? { lastFailure } : {}),
    state,
    ...(reasonCode ? { reasonCode } : {}),
    record: reportRecord,
    clientFailures,
  };

  return report;
}

// ---------------------------------------------------------------------------
// Module-level Event Channel
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

/**
 * Subscribes a listener to bridge health change transitions.
 * Returns an unsubscribe callback.
 */
export function subscribeBridgeHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Emits a health changed event to all registered listeners.
 */
export function emitBridgeHealthChanged(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (err) {
      console.error('[bridge-health] Error in bridge health subscriber:', err);
    }
  }
}
