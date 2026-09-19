import * as pty from 'node-pty';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'events';
import { performance } from 'node:perf_hooks';
import { isBenchmarkEnabled, recordBenchmark } from '../benchmark/telemetry';
import { StorageLocations } from '../config/storage-locations';
import { TerminalWaitInput, TerminalWaitResult, CapabilityError } from '../../shared/control-plane-contracts';
import { TerminalDeltaResult, TerminalJournalEntry, TerminalAckPayload, TerminalSyncViewResult } from '../../shared/contracts';
export function resolveScriptsDir(): string | undefined {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'scripts');
    try {
      if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(candidate, 'antifan-agent.cjs'))) {
        return candidate;
      }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fallback = path.resolve(__dirname, '..', '..', '..', 'scripts');
  try {
    if (fs.existsSync(fallback) && fs.existsSync(path.join(fallback, 'antifan-agent.cjs'))) {
      return fallback;
    }
  } catch {}
  return undefined;
}

export function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid || typeof pid !== 'number' || pid <= 0 || !Number.isFinite(pid)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(settle, 2000);
    timer.unref?.();

    if (process.platform === 'win32') {
      try {
        const child = spawn(
          'taskkill',
          ['/pid', String(Math.floor(pid)), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' }
        );
        child.unref();
        child.on('error', settle);
        child.on('close', settle);
      } catch {
        settle();
      }
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      settle();
    }
  });
}

export class SessionDeliveryJournal {
  private entries: TerminalJournalEntry[] = [];
  // Index of the oldest live entry; entries[0..head-1] are already evicted.
  // Eviction advances this pointer instead of shift() so dropping the oldest
  // chunk is O(1) instead of an O(n) array move on every append over budget.
  private head = 0;
  private totalBytes = 0;
  private readonly MAX_BYTES = 2 * 1024 * 1024; // 2 MiB hard bound
  private readonly MAX_CHUNKS = 4096; // 4,096 chunks hard bound

  private get liveLength(): number {
    return this.entries.length - this.head;
  }

  public append(generation: number, seq: number, data: string, byteLength = Buffer.byteLength(data, 'utf8')): void {
    const entry: TerminalJournalEntry = {
      seq,
      generation,
      data,
      byteLength,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    this.totalBytes += byteLength;

    // Dual-bound eviction: evict oldest while over bytes or chunks
    while (
      this.liveLength > 1 &&
      (this.totalBytes > this.MAX_BYTES || this.liveLength > this.MAX_CHUNKS)
    ) {
      const removed = this.entries[this.head];
      if (removed) {
        this.totalBytes -= removed.byteLength;
      }
      this.head++;
    }

    // The evicted prefix is dead weight; once it outweighs the live tail,
    // compact so the backing array cannot grow unbounded under sustained churn.
    if (this.head >= 1024 && this.head >= this.liveLength) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
  }

  public getDelta(generation: number, fromSeq: number): TerminalDeltaResult {
    if (this.liveLength === 0) {
      return {
        status: 'OK',
        generation,
        fromSeq,
        throughSeq: fromSeq - 1,
        chunks: [],
      };
    }

    const currentGen = this.entries[this.entries.length - 1]?.generation ?? generation;
    if (generation > 0 && generation !== currentGen) {
      return {
        status: 'GENERATION_MISMATCH',
        currentGeneration: currentGen,
      };
    }

    const retainedFromSeq = this.entries[this.head]?.seq ?? 0;
    const retainedThroughSeq = this.entries[this.entries.length - 1]?.seq ?? 0;

    const effectiveFromSeq = Math.max(1, fromSeq);
    // Only consider expired if chunks were actually evicted and requested sequence is before retention window
    if (retainedFromSeq > 1 && effectiveFromSeq < retainedFromSeq) {
      return {
        status: 'DELTA_EXPIRED',
        generation: currentGen,
        retainedFromSeq,
        retainedThroughSeq,
      };
    }

    const chunks: Array<{ seq: number; data: string }> = [];
    for (let i = this.head; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.seq >= effectiveFromSeq) {
        chunks.push({ seq: e.seq, data: e.data });
      }
    }

    return {
      status: 'OK',
      generation: currentGen,
      fromSeq: effectiveFromSeq,
      throughSeq: retainedThroughSeq,
      chunks,
    };
  }

  public getRetainedRange(): { fromSeq: number; throughSeq: number; bytes: number; chunks: number } {
    if (this.liveLength === 0) {
      return { fromSeq: 0, throughSeq: 0, bytes: 0, chunks: 0 };
    }
    return {
      fromSeq: this.entries[this.head]?.seq ?? 0,
      throughSeq: this.entries[this.entries.length - 1]?.seq ?? 0,
      bytes: this.totalBytes,
      chunks: this.liveLength,
    };
  }

  public clear(): void {
    this.entries = [];
    this.head = 0;
    this.totalBytes = 0;
  }
}

export class SessionRecord {
  public id: string;
  public name: string;
  public cwd: string;
  public pty: pty.IPty | null = null;
  public splitOf?: string;
  public capsuleId: string;
  public disposed?: boolean;
  public lastSeq = 0;
  public sessionGeneration: number;
  public state: 'running' | 'exited' | 'closed' | 'sleeping' = 'running';
  public deliveryJournal: SessionDeliveryJournal;
  public exitCode?: number;
  public exitSignal?: number;
  public exitedAt?: number;
  public closedAt?: number;
  public dataSubscription?: { dispose: () => void };
  public exitSubscription?: { dispose: () => void };
  public pendingCols?: number;
  public pendingRows?: number;
  public pendingMinimumRows?: number;
  public pendingParentId?: string;
  public pendingParentGeneration?: number;
  public restoredTail?: string;
  public pendingClearScreen?: boolean;
  public altScreen?: boolean;
  public altScreenScanTail?: string;
  public inputLineBuffer?: string;
  public category?: string;
  public sleptAt?: number;

  public chunks: Buffer[] = [];
  public bufferBytes = 0;
  private _materialized: string | null = null;

  constructor(fields: {
    id: string;
    cwd: string;
    capsuleId: string;
    sessionGeneration: number;
    name?: string;
    pty?: pty.IPty | null;
    restoredTail?: string;
    pendingCols?: number;
    pendingRows?: number;
    pendingMinimumRows?: number;
    pendingParentId?: string;
    pendingParentGeneration?: number;
    splitOf?: string;
    state?: 'running' | 'exited' | 'closed' | 'sleeping';
    category?: string;
    disposed?: boolean;
  }) {
    this.id = fields.id;
    this.name = fields.name ?? `Terminal ${fields.id.replace('terminal-', '')}`;
    this.cwd = fields.cwd;
    this.capsuleId = fields.capsuleId;
    this.sessionGeneration = fields.sessionGeneration;
    this.pty = fields.pty ?? null;
    this.restoredTail = fields.restoredTail;
    this.pendingCols = fields.pendingCols;
    this.pendingRows = fields.pendingRows;
    this.pendingMinimumRows = fields.pendingMinimumRows;
    this.pendingParentId = fields.pendingParentId;
    this.pendingParentGeneration = fields.pendingParentGeneration;
    this.splitOf = fields.splitOf;
    this.state = fields.state ?? 'running';
    this.category = fields.category;
    this.disposed = fields.disposed ?? false;
    this.deliveryJournal = new SessionDeliveryJournal();
  }

  public get buffer(): string {
    if (this._materialized !== null) {
      return this._materialized;
    }
    if (this.chunks.length === 0) {
      this._materialized = '';
      return '';
    }
    if (this.chunks.length === 1) {
      this._materialized = this.chunks[0]!.toString('utf8');
      return this._materialized;
    }
    this._materialized = Buffer.concat(this.chunks, this.bufferBytes).toString('utf8');
    return this._materialized;
  }

  public set buffer(val: string) {
    this._materialized = typeof val === 'string' ? val : '';
    this.chunks = [];
    this.bufferBytes = 0;
    if (this._materialized.length > 0) {
      const b = Buffer.from(this._materialized, 'utf8');
      this.chunks.push(b);
      this.bufferBytes = b.length;
    }
  }

  public appendData(data: string | Buffer, dataBytes?: number): void {
    if (!data || (typeof data === 'string' && data.length === 0)) return;
    this._materialized = null;
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (buf.length > 0) {
      this.chunks.push(buf);
      this.bufferBytes += (dataBytes !== undefined && typeof data === 'string') ? dataBytes : buf.length;
    }
  }

  public trimTail(maxBytes: number): void {
    if (this.bufferBytes <= maxBytes) return;
    this._materialized = null;
    let excess = this.bufferBytes - maxBytes;
    while (this.chunks.length > 0 && excess > 0) {
      const first = this.chunks[0]!;
      if (first.length <= excess) {
        excess -= first.length;
        this.bufferBytes -= first.length;
        this.chunks.shift();
      } else {
        let cutOffset = excess;
        while (cutOffset < first.length && (first[cutOffset]! & 0xc0) === 0x80) {
          cutOffset++;
        }
        const nlIdx = first.indexOf(0x0a, cutOffset);
        if (nlIdx !== -1 && (nlIdx - cutOffset) < 2048) {
          cutOffset = nlIdx + 1;
        }
        if (cutOffset < first.length) {
          const remaining = Buffer.from(first.subarray(cutOffset));
          this.bufferBytes -= cutOffset;
          this.chunks[0] = remaining;
        } else {
          this.bufferBytes -= first.length;
          this.chunks.shift();
        }
        excess = 0;
        break;
      }
    }
  }
}

export type Session = SessionRecord;
type SavedSession = {
  id: string;
  name: string;
  cwd: string;
  buffer?: string;
  splitOf?: string;
  capsuleId?: string;
  cols?: number;
  rows?: number;
  // Sleep/archive metadata. `state` is written for every session so a session the
  // user put to sleep survives a restart without a PTY; `restoredTail` carries
  // that session's whole transcript, which for a sleeping record is the only
  // place it lives (its live `buffer` is empty by definition).
  state?: 'running' | 'exited' | 'closed' | 'sleeping';
  category?: string;
  restoredTail?: string;
};
// Interactive TUIs (agent spinners, status bars) redraw continuously and consume
// a transcript tail fast: a 512KB ceiling evicted output within a couple of
// minutes even at ~3KB/s of redraw chatter, which surfaced to users as output
// that "started mid-word". 4MB retains hours of TUI traffic per session.
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024; // 4MB in-memory history buffer
const MAX_PERSISTED_BYTES = 1024 * 1024; // 1MB per session on disk (restart recovery)
// Re-slicing the transcript copies the whole retained tail, so only trim after a
// generous overshoot instead of on every 64KB of new output.
const TRANSCRIPT_TRIM_OVERSHOOT_BYTES = 256 * 1024;
/**
 * Default preference for Windows Pseudo Console (ConPTY) on Windows 10 build 18309+ / Windows 11.
 * Off by default: measured on this machine, a ConPTY-backed session leaves the Electron
 * process unable to exit after teardown (the live theme proof stages its report and then
 * never terminates), while the same proof exits cleanly on winpty. Opt in with
 * ANTIFAN_USE_CONPTY=1 only after re-verifying process exit on the target machine;
 * ANTIFAN_USE_CONPTY=0 forces the winpty fallback.
 */
export const DEFAULT_USE_CONPTY = false;
// Gap between deferred shell starts during session restore. Each Windows PTY spawn
// blocks the main thread, so the queue yields to the event loop between starts.
const DEFERRED_PTY_START_DELAY_MS = 250;
const MIN_TERMINAL_ROWS = 8;
const MIN_SPLIT_TERMINAL_ROWS = 4;
const SPLIT_TERMINAL_FRACTION = 0.2;
// Rolling input line cap: enough to hold any real command, small enough that a
// paste or runaway key repeat cannot grow it.
const INPUT_LINE_MAX_CHARS = 128;
// Whole-line match only: `cls`, `clear`, or `Clear-Host` surrounded by
// whitespace. Anything else on the line (arguments, pipes) is not a clear.
// Case-insensitive because both shells this manager spawns are: PowerShell and
// cmd.exe resolve `CLS` / `Cls` / `CLEAR-HOST` to the same command, so a
// case-sensitive pattern silently missed every non-canonical spelling the user
// actually types. Exported so the spec test asserts THIS pattern instead of a
// duplicated copy that can drift out of sync with the implementation.
export const CLEAR_SCREEN_COMMAND_RE = /^\s*(?:cls|clear|clear-host)\s*$/i;
// Same-clock ack-latency stamps are kept per session; the cap bounds memory for
// sequences that are never acked (subscriber closed, chunks gated downstream).
const MAX_EMIT_TIME_STAMPS_PER_SESSION = 256;
// The alternate-screen switches a PTY stream reports as text. Named here so the
// chunk-boundary scan and its test read the same spellings, and the retained tail
// (`length - 1`) is derived from them instead of a hand-copied 7.
export const ALT_SCREEN_ON_SEQ = '\x1b[?1049h';
export const ALT_SCREEN_OFF_SEQ = '\x1b[?1049l';
export const ALT_SCREEN_SEQ_LENGTH = ALT_SCREEN_ON_SEQ.length;
// waitTerminal output-match scans only the transcript tail: a full 4MB regex
// scan on every wait call stalls the main thread for a match that virtually
// always lives in recent output.
const WAIT_MATCH_WINDOW_BYTES = 64 * 1024;
// Wire budget for the session-state payload (renderer fallback only; the renderer
// hydrates from getFullBuffer). The legacy 40 KiB budget truncated the active
// pane snapshot to ~16 KiB, which made a pane look mid-stream after a reattach.
const GLOBAL_JSON_BUFFER_BUDGET_BYTES = 160 * 1024; // 160 KiB total wire budget for all session buffers
const ACTIVE_SNAPSHOT_BUDGET_BYTES = Math.floor(GLOBAL_JSON_BUFFER_BUDGET_BYTES * 0.4);
const BACKGROUND_SNAPSHOT_BUDGET_BYTES = Math.floor(GLOBAL_JSON_BUFFER_BUDGET_BYTES * 0.6);

export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  active: boolean;
  buffer: string;
  snapshotThroughSeq?: number;
  /** Names the parent when this entry is a split pane, and is absent on base sessions. */
  splitOf?: string;
  splitSessionId?: string;
  splitBuffer?: string;
  splitSnapshotThroughSeq?: number;
  bufferLength: number;
  sessionGeneration: number;
  state?: 'running' | 'exited' | 'closed' | 'sleeping';
  exitCode?: number;
  exitedAt?: number;
  closedAt?: number;
  // Sleep/archive metadata for the tab strip: the user-assigned group and the
  // moment the tab was put to sleep (absent while it is awake).
  category?: string;
  sleptAt?: number;
  cols?: number;
  rows?: number;
  // True while the session's foreground program is on the alternate screen (vim,
  // htop, an agent TUI). That screen is not scrollback, so a viewer must offer the
  // transcript instead of pretending the history is there.
  altScreen?: boolean;
}
export interface TerminalManagerStats {
  sessionCount: number;
  runningPtyCount: number;
  transcriptBytes: number;
  dataSubscriptionCount: number;
  exitSubscriptionCount: number;
}

/**
 * The sessions an annotation can be sent to, derived from `listSessions()`.
 *
 * Only a running base session has a shell that accepts the queued prompt, and a
 * split pane is the same tab as the parent it belongs to — so a sleeping session
 * or a pane would only add a target row a user cannot act on (and the pane would
 * duplicate its parent). The annotation picker's target list is built from this,
 * never from the raw session list.
 */
export function selectAnnotationTargets(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.filter((s) => s.state === 'running' && !s.splitOf);
}
export interface TerminalSessionDiagnostics {
  sessionId: string;
  generation: number;
  lastSeq: number;
  bufferBytes: number;
  state: 'running' | 'exited' | 'closed' | 'sleeping';
  splitOf?: string;
  altScreen: boolean;
  capsuleId: string;
}

export interface TerminalSubscriberState {
  rendererInstanceId: string;
  sessionId: string;
  generation: number;
  lastAckedSeq: number;
  role: 'DOCK' | 'POPOUT';
  lastHeartbeatAt: number;
}

export interface TerminalDiagnosticsReport {
  timestamp: number;
  sessionCount: number;
  activeSessionId: string;
  sessions: TerminalSessionDiagnostics[];
  subscribers?: TerminalSubscriberState[];
}

export function safeSliceTail(target: string | SessionRecord | Buffer[], maxBytes: number): string {
  if (!target || maxBytes <= 0) return '';
  if (typeof target === 'string') {
    if (target.length <= maxBytes) return target;
    const buf = Buffer.from(target, 'utf8');
    if (buf.length <= maxBytes) return target;
    let cutOffset = buf.length - maxBytes;
    while (cutOffset < buf.length && (buf[cutOffset]! & 0xc0) === 0x80) {
      cutOffset++;
    }
    const nlIdx = buf.indexOf(0x0a, cutOffset);
    if (nlIdx !== -1 && (nlIdx - cutOffset) < 2048) {
      cutOffset = nlIdx + 1;
    }
    return buf.subarray(cutOffset).toString('utf8');
  }

  const chunks = Array.isArray(target) ? target : target.chunks;
  if (!chunks || chunks.length === 0) return '';
  const totalBytes = Array.isArray(target)
    ? chunks.reduce((acc, c) => acc + c.length, 0)
    : target.bufferBytes;
  if (totalBytes <= maxBytes) {
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  }
  let excess = totalBytes - maxBytes;
  const kept: Buffer[] = [];
  let keptBytes = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    if (excess >= c.length) {
      excess -= c.length;
      continue;
    }
    if (excess > 0) {
      let cutOffset = excess;
      while (cutOffset < c.length && (c[cutOffset]! & 0xc0) === 0x80) {
        cutOffset++;
      }
      const nlIdx = c.indexOf(0x0a, cutOffset);
      if (nlIdx !== -1 && (nlIdx - cutOffset) < 2048) {
        cutOffset = nlIdx + 1;
      }
      if (cutOffset < c.length) {
        const sliced = c.subarray(cutOffset);
        kept.push(sliced);
        keptBytes += sliced.length;
      }
      excess = 0;
    } else {
      kept.push(c);
      keptBytes += c.length;
    }
  }
  return Buffer.concat(kept, keptBytes).toString('utf8');
}

export function safeSliceTailJsonBounded(str: string, maxJsonBytes: number): string {
  if (!str || maxJsonBytes < 2) return '';
  const resetPrefix = '\x1b[0m';
  // JSON.stringify('\x1b[0m') produces "\u001b[0m" (11 bytes: 6 for \u001b, 3 for [0m, 2 for quotes)
  const prefixByteCost = 11;
  if (maxJsonBytes < prefixByteCost) return '';
  const targetBodyBudget = maxJsonBytes - prefixByteCost;
  if (targetBodyBudget <= 0) return '';
  let bodyCost = 0;
  let cutIndex = str.length;

  for (let i = str.length - 1; i >= 0; i--) {
    const code = str.charCodeAt(i);
    let charCost = 1;
    if (code === 0x1b) {
      charCost = 6;
    } else if (code === 0x22 || code === 0x5c || code === 0x0a || code === 0x0d || code === 0x09) {
      charCost = 2;
    } else if (code < 0x20) {
      charCost = 6;
    } else if (code <= 0x7f) {
      charCost = 1;
    } else if (code <= 0x7ff) {
      charCost = 2;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      if (i > 0 && str.charCodeAt(i - 1) >= 0xd800 && str.charCodeAt(i - 1) <= 0xdbff) {
        charCost = 4;
        i--;
      } else {
        charCost = 6;
      }
    } else if (code >= 0xd800 && code <= 0xdbff) {
      charCost = 6;
    } else {
      charCost = 3;
    }

    if (bodyCost + charCost > targetBodyBudget) {
      break;
    }
    bodyCost += charCost;
    cutIndex = i;
  }

  if (cutIndex > 0) {
    const nl = str.indexOf('\n', cutIndex);
    if (nl !== -1 && nl < str.length - 1) {
      cutIndex = nl + 1;
    }
  }

  if (cutIndex < str.length && str.charCodeAt(cutIndex) >= 0xdc00 && str.charCodeAt(cutIndex) <= 0xdfff) {
    cutIndex++;
  }

  const rawSlice = str.slice(cutIndex);
  const result = `${resetPrefix}${rawSlice}`;
  return result;
}
export class TerminalManager extends EventEmitter {
  private static instance: TerminalManager | any | undefined;
  private static constructionCount = 0;
  private sessions = new Map<string, Session>();
  private sessionGenerations = new Map<string, number>();
  private activeSessionId = '';
  private bridgeEndpoint: { port: number; host: string; pid: number } | null = null;
  private currentCwd = process.cwd();
  private currentCapsuleId = 'default';
  private persistTimer: NodeJS.Timeout | null = null;
  private isPersisting = false;
  private hasPendingPersist = false;
  private activePersistPromise: Promise<void> | null = null;
  private writeSequence = 0;
  private lastCols = 120;
  private lastRows = 30;
  private isDisposed = false;
  private deferredPtyIds: string[] = [];
  private deferredPtyTimer: NodeJS.Timeout | null = null;
  private benchmarkChunkSeq = 0;
  private benchmarkChunkBytes = 0;
  private conptyFallbackLogged = false;
  private conptyFailed = false;
  // Sessions whose transcript changed since the last confirmed disk write.
  // persistAsync/persistSync re-serialize only dirty (or field-changed) sessions
  // and reuse the cached JSON fragment for the rest; the set is cleared only
  // after the file write is confirmed so a crash mid-write loses nothing.
  private dirtySessionIds = new Set<string>();
  private persistedFragments = new Map<string, {
    fragment: string;
    buffer: string;
    name: string;
    cwd: string;
    splitOf?: string;
    capsuleId: string;
    cols: number;
    rows: number;
    state: 'running' | 'exited' | 'closed' | 'sleeping';
    category?: string;
    restoredTail?: string;
  }>();
  // True once any session record existed this run. Persisting an empty session
  // list is only meaningful after that point; before it, an empty write would
  // wipe a state file the fresh instance has not restored yet.
  private hadAnySessions = false;
  // Same-clock emit stamps for ack-latency measurement, keyed per session so
  // per-generation seq restarts cannot collide across sessions. Only populated
  // while benchmark mode is enabled.
  private emitTimeMs = new Map<string, Map<number, number>>();

  private supportsConpty(): boolean {
    if (process.platform !== 'win32') return false;
    const override = process.env.ANTIFAN_USE_CONPTY;
    if (override === '0') return false;
    if (override !== '1' && !DEFAULT_USE_CONPTY) return false;
    try {
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(os.release());
      if (match && match[3]) {
        const build = parseInt(match[3], 10);
        return build >= 18309;
      }
    } catch {}
    return false;
  }

  private subscribers = new Map<string, TerminalSubscriberState>();
  // Single canonical owner. Construction is private and only the composition root's
  // getInstance() may create the one TerminalManager; no module can spawn a second
  // owner with duplicate PTYs or an uncoordinated process tree. Tests may reset the
  // static field for isolation but each process still yields exactly one instance.
  private constructor() {
    super();
    this.setMaxListeners(50);
    TerminalManager.constructionCount++;
    if (TerminalManager.constructionCount > 1) {
      throw new Error(
        'TerminalManager: a second instance was constructed. The composition root owns ' +
          'the single canonical instance; duplicate owners are forbidden (dual-plane invariant).'
      );
    }
  }
  private getInitialSplitRows(parentRows = this.lastRows): number {
    return Math.max(MIN_SPLIT_TERMINAL_ROWS, Math.floor((parentRows || 30) * SPLIT_TERMINAL_FRACTION));
  }

  private statePath(): string {
    const dir = process.env.ANTIFAN_CONFIG_DIR || StorageLocations.getConfigDir();
    return path.join(dir, 'terminal-sessions.json');
  }
  private cleanOrphanedTempFiles(): void {
    try {
      const dir = path.dirname(this.statePath());
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (f.startsWith('terminal-sessions.json.tmp-')) {
          try {
            fs.unlinkSync(path.join(dir, f));
          } catch {}
        }
      }
    } catch {}
  }

  private readSavedSessions(): { activeSessionId?: string; lastCols?: number; lastRows?: number; sessions: SavedSession[] } {
    this.cleanOrphanedTempFiles();
    try {
      const value = JSON.parse(fs.readFileSync(this.statePath(), 'utf8'));
      if (Array.isArray(value)) return { sessions: value };
      if (value && Array.isArray(value.sessions)) {
        if (typeof value.lastCols === 'number' && value.lastCols >= 40) {
          this.lastCols = value.lastCols;
        }
        if (typeof value.lastRows === 'number' && value.lastRows >= MIN_TERMINAL_ROWS) {
          this.lastRows = value.lastRows;
        }
        return {
          activeSessionId: value.activeSessionId,
          lastCols: value.lastCols,
          lastRows: value.lastRows,
          sessions: value.sessions,
        };
      }
      return { sessions: [] };
    } catch {
      return { sessions: [] };
    }
  }

  /**
   * Serializes one session's persisted record, reusing the cached JSON fragment
   * when nothing the file stores has changed. The buffer is compared by
   * reference: every in-place producer (appendData, clear-screen reset) assigns
   * a new string, so a changed reference means the content changed; an identical
   * reference means it cannot have. The remaining scalar fields are compared by
   * value so a rename/resize/capsule move on a clean session still re-serializes.
   * `restoredTail` is deliberately absent for a live session — it is display-only
   * history and re-writing it would stack one history banner per restart — but it
   * IS written for a sleeping session, where it is the only surviving copy of the
   * transcript (a sleeping record keeps its live `buffer` empty).
   */
  private serializeSessionFragment(s: Session): string {
    const cols = s.pendingCols || s.pty?.cols || this.lastCols || 120;
    const rows = s.pendingRows || s.pty?.rows || this.lastRows || 30;
    const state = s.state;
    const category = s.category;
    const restoredTail = state === 'sleeping' && s.restoredTail
      ? safeSliceTail(s.restoredTail, MAX_PERSISTED_BYTES)
      : undefined;
    const cached = this.persistedFragments.get(s.id);
    if (
      cached &&
      !this.dirtySessionIds.has(s.id) &&
      cached.buffer === s.buffer &&
      cached.name === s.name &&
      cached.cwd === s.cwd &&
      cached.splitOf === s.splitOf &&
      cached.capsuleId === s.capsuleId &&
      cached.cols === cols &&
      cached.rows === rows &&
      cached.state === state &&
      cached.category === category &&
      cached.restoredTail === restoredTail
    ) {
      return cached.fragment;
    }
    const fragment = JSON.stringify({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      buffer: safeSliceTail(s.buffer, MAX_PERSISTED_BYTES),
      splitOf: s.splitOf,
      capsuleId: s.capsuleId,
      cols,
      rows,
      state,
      category,
      restoredTail,
    });
    this.persistedFragments.set(s.id, {
      fragment,
      buffer: s.buffer,
      name: s.name,
      cwd: s.cwd,
      splitOf: s.splitOf,
      capsuleId: s.capsuleId,
      cols,
      rows,
      state,
      category,
      restoredTail,
    });
    return fragment;
  }

  /**
   * Builds the state-file body by hand so clean sessions contribute their
   * cached fragment verbatim instead of a fresh JSON.stringify of the whole
   * payload. Also drops fragment cache entries for sessions that no longer
   * exist so the map cannot leak across closes.
   */
  private serializePersistPayload(): string {
    const fragments: string[] = [];
    for (const s of this.sessions.values()) {
      fragments.push(this.serializeSessionFragment(s));
    }
    for (const id of this.persistedFragments.keys()) {
      if (!this.sessions.has(id)) this.persistedFragments.delete(id);
    }
    // Compact JSON: the state file is machine-read on restore, and pretty
    // printing a multi-MB buffer string only burns main-thread time.
    return (
      `{"activeSessionId":${JSON.stringify(this.activeSessionId)},` +
      `"lastCols":${this.lastCols || 120},"lastRows":${this.lastRows || 30},` +
      `"sessions":[${fragments.join(',')}]}`
    );
  }

  /**
   * Marks the sessions covered by a confirmed write as clean. Entries dirtied
   * after the snapshot was taken are left set so the next write re-serializes
   * them; the field comparison in serializeSessionFragment is the backstop for
   * any mutation that never went through the dirty set.
   */
  private clearDirtySessions(dirtySnapshot: Set<string>): void {
    for (const id of dirtySnapshot) {
      this.dirtySessionIds.delete(id);
    }
  }

  private async persistAsync(): Promise<void> {
    if (this.isDisposed || (this.sessions.size === 0 && !this.hadAnySessions)) {
      return this.activePersistPromise || Promise.resolve();
    }
    if (this.isPersisting) {
      this.hasPendingPersist = true;
      return this.activePersistPromise || Promise.resolve();
    }
    this.isPersisting = true;
    const currentSeq = ++this.writeSequence;
    let currentJob: Promise<void> | null = null;
    currentJob = (async () => {
      const filePath = this.statePath();
      const tempPath = `${filePath}.tmp-async-${currentSeq}-${Date.now()}`;
      // Snapshot before serializing: sessions dirtied while the write is in
      // flight must stay dirty so the next pass re-serializes them.
      const dirtySnapshot = new Set(this.dirtySessionIds);
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const serialized = this.serializePersistPayload();
        await fs.promises.writeFile(tempPath, serialized, 'utf8');
        if (this.writeSequence === currentSeq) {
          try {
            await fs.promises.rename(tempPath, filePath);
            this.clearDirtySessions(dirtySnapshot);
          } catch {
            // Windows safe fallback: write directly to target file ONLY if sequence is still current
            if (this.writeSequence === currentSeq) {
              await fs.promises.writeFile(filePath, serialized, 'utf8');
              this.clearDirtySessions(dirtySnapshot);
            }
            await fs.promises.unlink(tempPath).catch(() => {});
          }
          if (this.writeSequence !== currentSeq) {
            this.schedulePersist();
          }
        } else {
          await fs.promises.unlink(tempPath).catch(() => {});
        }
      } catch (err) {
        await fs.promises.unlink(tempPath).catch(() => {});
      } finally {
        this.isPersisting = false;
        if (currentJob && this.activePersistPromise === currentJob) {
          this.activePersistPromise = null;
        }
        if (this.hasPendingPersist && this.writeSequence === currentSeq) {
          this.hasPendingPersist = false;
          this.schedulePersist();
        }
      }
    })();
    this.activePersistPromise = currentJob;
    return currentJob;
  }

  public persistSync(): void {
    if (this.isDisposed || (this.sessions.size === 0 && !this.hadAnySessions)) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.hasPendingPersist = false;
    this.activePersistPromise = null;
    const currentSeq = ++this.writeSequence;
    const filePath = this.statePath();
    const tempPath = `${filePath}.tmp-sync-${currentSeq}-${Date.now()}`;
    const dirtySnapshot = new Set(this.dirtySessionIds);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const serialized = this.serializePersistPayload();
      try {
        fs.writeFileSync(tempPath, serialized, 'utf8');
        fs.renameSync(tempPath, filePath);
        this.clearDirtySessions(dirtySnapshot);
      } catch {
        // Windows safe fallback: write directly to target file if rename throws (locked / AV / EPERM)
        fs.writeFileSync(filePath, serialized, 'utf8');
        this.clearDirtySessions(dirtySnapshot);
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch {}
      }
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {}
    }
  }
  private persist(): void {
    this.schedulePersist();
  }

  private schedulePersist(sessionId?: string): void {
    if (this.isDisposed) return;
    if (sessionId) this.dirtySessionIds.add(sessionId);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistAsync();
    }, 5000);
    this.persistTimer.unref?.();
  }

  public static getInstance(): TerminalManager { return this.instance ??= new TerminalManager(); }
  public static setInstance(inst: TerminalManager | any): void { this.instance = inst; }
  public setCwd(cwd: string): void { this.currentCwd = cwd; }
  /**
   * Pin every PTY spawned by this instance to this instance's own bridge endpoint.
   * A terminal-launched agent must attach to the instance that owns the terminal,
   * never to whichever instance last wrote a shared discovery mirror.
   */
  public setBridgeEndpoint(endpoint: { port: number; host: string; pid: number } | null): void {
    this.bridgeEndpoint = endpoint;
  }
  public getCurrentCwd(): string { return this.currentCwd; }
  public setCapsule(capsuleId: string, cwd?: string, targetSessionId?: string): void {
    this.isDisposed = false;
    this.currentCapsuleId = capsuleId || 'default';
    if (cwd) this.currentCwd = cwd;

    if (targetSessionId && this.sessions.has(targetSessionId)) {
      // User explicitly targeted a specific session for this capsule/workspace folder
      const target = this.sessions.get(targetSessionId);
      if (target) {
        target.capsuleId = this.currentCapsuleId;
        if (cwd && !target.disposed) {
          const oldCwd = target.cwd;
          target.cwd = cwd;
          if (oldCwd !== cwd) {
            const isWin = process.platform === 'win32';
            const cdCmd = isWin ? `Set-Location -LiteralPath "${cwd}"\r\n` : `cd "${cwd}"\n`;
            try { target.pty?.write(cdCmd); } catch {}
          }
        }
        this.activeSessionId = targetSessionId;
      }
    } else {
      // Find an existing active/base session belonging to this capsule
      const matching = [...this.sessions.values()].find(s => !s.splitOf && s.capsuleId === this.currentCapsuleId);
      if (matching) {
        this.activeSessionId = matching.id;
      } else if (this.sessions.size > 0) {
        // Live sessions exist for other capsules, but none for this capsule: spawn a new dedicated session
        const id = this.nextTerminalId();
        this.activeSessionId = id;
        this.spawn(id, this.currentCwd);
      } else {
        // No live sessions at all: restore from saved sessions or spawn fresh.
        // Synchronously spawning every saved session blocks the main thread for seconds,
        // so mirror startTerminal(): spawn eagerly only the active base session and its split,
        // reserving background sessions to start from a deferred queue.
        const { activeSessionId: savedActiveId, sessions: saved } = this.readSavedSessions();
        const baseSessions = saved.filter(item => !item.splitOf);
        if (baseSessions.length > 0) {
          const targetEntry = targetSessionId ? saved.find(item => item.id === targetSessionId) : undefined;
          const targetBaseId = targetEntry ? (targetEntry.splitOf || targetEntry.id) : undefined;
          const matchingSaved = baseSessions.find(item => (item.capsuleId || this.currentCapsuleId) === this.currentCapsuleId);
          const savedActiveEntry = savedActiveId ? saved.find(item => item.id === savedActiveId) : undefined;
          const savedBaseId = savedActiveEntry ? (savedActiveEntry.splitOf || savedActiveEntry.id) : undefined;

          const activeBaseId = (targetBaseId && baseSessions.some(item => item.id === targetBaseId))
            ? targetBaseId
            : (matchingSaved
              ? matchingSaved.id
              : (savedBaseId && baseSessions.some(item => item.id === savedBaseId)
                ? savedBaseId
                : baseSessions[0]!.id));

          const deferredIds: string[] = [];
          for (const item of baseSessions) {
            if (item.id === activeBaseId) {
              // A session the user put to sleep before quitting comes back asleep:
              // restoring it must not cost a shell (its transcript is enough).
              if (item.state === 'sleeping') {
                this.restoreSleepingSession(item, item.cols, item.rows, MIN_TERMINAL_ROWS);
              } else {
                const s = this.spawn(item.id, item.cwd || this.currentCwd, item.buffer || '', item.cols, item.rows);
                s.name = item.name || s.name;
                s.capsuleId = item.capsuleId || this.currentCapsuleId;
              }
            } else if (item.state === 'sleeping') {
              this.restoreSleepingSession(item, item.cols, item.rows, MIN_TERMINAL_ROWS);
            } else {
              const s = this.reserveRestoredSession(item, item.cols, item.rows, MIN_TERMINAL_ROWS);
              s.capsuleId = item.capsuleId || this.currentCapsuleId;
              deferredIds.push(item.id);
            }
          }
          const splitSessions = saved.filter(item => item.splitOf && this.sessions.has(item.splitOf));
          for (const item of splitSessions) {
            const parent = item.splitOf ? this.sessions.get(item.splitOf) : undefined;
            const parentRows = parent?.pty?.rows || parent?.pendingRows;
            const initialRows = item.rows || this.getInitialSplitRows(parentRows || this.lastRows);
            // A pane cannot outlive its parent's live shell, so a save that predates the
            // sleep cascade (or a parent parked while this pane still ran) restores the
            // pane asleep instead of resurrecting a shell under a parked tab.
            if (item.state === 'sleeping' || parent?.state === 'sleeping') {
              this.restoreSleepingSession(item, item.cols, initialRows, MIN_SPLIT_TERMINAL_ROWS, item.splitOf, parent?.sessionGeneration);
            } else if (item.splitOf === activeBaseId) {
              const s = this.spawn(item.id, item.cwd || this.currentCwd, item.buffer || '', item.cols, initialRows, MIN_SPLIT_TERMINAL_ROWS, item.splitOf, parent?.sessionGeneration);
              s.name = item.name || s.name;
              s.splitOf = item.splitOf;
              s.capsuleId = item.capsuleId || this.currentCapsuleId;
            } else {
              const s = this.reserveRestoredSession(item, item.cols, initialRows, MIN_SPLIT_TERMINAL_ROWS, item.splitOf, parent?.sessionGeneration);
              s.capsuleId = item.capsuleId || this.currentCapsuleId;
              deferredIds.push(item.id);
            }
          }
          this.scheduleDeferredPtyStarts(deferredIds);

          if (targetSessionId && this.sessions.has(targetSessionId)) {
            this.activeSessionId = targetSessionId;
          } else if (matchingSaved && this.sessions.has(matchingSaved.id)) {
            this.activeSessionId = matchingSaved.id;
          } else if (savedActiveId && this.sessions.has(savedActiveId)) {
            const savedTarget = this.sessions.get(savedActiveId);
            this.activeSessionId = savedTarget?.splitOf || savedActiveId;
          } else {
            this.activeSessionId = baseSessions[0]?.id || '';
          }
        } else {
          const id = this.nextTerminalId();
          this.activeSessionId = id;
          this.spawn(id, this.currentCwd);
        }
      }
    }
    this.persist();
    this.emitSession();
  }

  /**
   * Creates the session record (transcript, generation, identity) without a shell.
   * Restoring several Windows PTYs in one loop blocked the main thread for 3.5-7.9s
   * (measured: 150-800ms per spawn), so restored background sessions are recorded
   * synchronously and start their shell from a deferred queue.
   */
  private createSessionRecord(
    id: string,
    cwd: string,
    restoredBuffer: string,
    initialCols: number | undefined,
    initialRows: number | undefined,
    minimumRows: number,
    parentSessionId: string | undefined,
    generation: number,
    parentGeneration?: number,
  ): Session {
    const s = new SessionRecord({
      id,
      name: `Terminal ${id.replace('terminal-', '')}`,
      cwd,
      pty: null,
      // The recovered transcript is display-only history: it renders once
      // behind a separator via composeTranscript and is never persisted again.
      restoredTail: restoredBuffer ? safeSliceTail(restoredBuffer, MAX_TRANSCRIPT_BYTES) : undefined,
      capsuleId: this.currentCapsuleId,
      disposed: false,
      sessionGeneration: generation,
      state: 'running',
      pendingCols: initialCols || this.lastCols || 120,
      pendingRows: initialRows || this.lastRows || 30,
      pendingMinimumRows: minimumRows,
      pendingParentId: parentSessionId,
      pendingParentGeneration: parentGeneration,
    });
    this.sessions.set(id, s);
    this.hadAnySessions = true;
    return s;
  }

  private reserveRestoredSession(
    item: SavedSession,
    initialCols: number | undefined,
    initialRows: number | undefined,
    minimumRows: number,
    parentSessionId?: string,
    parentGeneration?: number,
  ): Session {
    const generation = (this.sessionGenerations.get(item.id) || 0) + 1;
    this.sessionGenerations.set(item.id, generation);
    const effectiveCols = initialCols || item.cols;
    const effectiveRows = initialRows || item.rows;
    const s = this.createSessionRecord(
      item.id,
      item.cwd || this.currentCwd,
      item.buffer || '',
      effectiveCols,
      effectiveRows,
      minimumRows,
      parentSessionId,
      generation,
      parentGeneration,
    );
    s.name = item.name || s.name;
    s.splitOf = item.splitOf;
    s.capsuleId = item.capsuleId || this.currentCapsuleId;
    s.category = item.category;
    return s;
  }

  /**
   * Restores a session the user had put to sleep when the app last exited: the
   * record, its generation, its category and its whole transcript come back
   * without a shell, so the tab renders instantly and costs no process. The
   * generation is reserved here so a later wake reuses it and the
   * `${terminalId}@${generation}` affinity key never migrates.
   */
  private restoreSleepingSession(
    item: SavedSession,
    initialCols: number | undefined,
    initialRows: number | undefined,
    minimumRows: number,
    parentSessionId?: string,
    parentGeneration?: number,
  ): Session {
    const generation = (this.sessionGenerations.get(item.id) || 0) + 1;
    this.sessionGenerations.set(item.id, generation);
    const effectiveCols = initialCols || item.cols;
    const effectiveRows = initialRows || item.rows;
    // A sleeping record keeps its transcript in `restoredTail`; `buffer` is the
    // fallback for a file written before the sleep fields existed.
    const transcript = item.restoredTail ?? item.buffer ?? '';
    const s = this.createSessionRecord(
      item.id,
      item.cwd || this.currentCwd,
      transcript,
      effectiveCols,
      effectiveRows,
      minimumRows,
      parentSessionId,
      generation,
      parentGeneration,
    );
    s.name = item.name || s.name;
    s.splitOf = item.splitOf;
    s.capsuleId = item.capsuleId || this.currentCapsuleId;
    s.category = item.category;
    s.state = 'sleeping';
    s.sleptAt = Date.now();
    return s;
  }

  /**
   * Guarantees the session has a live shell, materializing a deferred restore on
   * demand. Returns the live record (the reserved record is replaced by the spawned
   * one, which is bound to the PTY's data/exit subscriptions).
   */
  private ensureSessionPty(id: string): Session | undefined {
    const queuedIdx = this.deferredPtyIds.indexOf(id);
    if (queuedIdx !== -1) this.deferredPtyIds.splice(queuedIdx, 1);
    const reserved = this.sessions.get(id);
    if (!reserved || reserved.disposed) return undefined;
    if (reserved.pty) return reserved;
    let live: Session;
    try {
      live = this.spawn(
        id,
        reserved.cwd,
        reserved.restoredTail || reserved.buffer || '',
        reserved.pendingCols,
        reserved.pendingRows,
        reserved.pendingMinimumRows || MIN_TERMINAL_ROWS,
        reserved.pendingParentId,
        reserved.pendingParentGeneration,
        reserved.sessionGeneration,
      );
    } catch {
      return this.sessions.get(id) || reserved;
    }
    // The spawned record carries the restored transcript in restoredTail
    // (passed as restoredBuffer); identity fields are re-applied so tabs,
    // splits and capsule membership survive. Any live output the reserved
    // record accumulated is carried over so nothing is dropped.
    live.name = reserved.name;
    live.splitOf = reserved.splitOf;
    live.capsuleId = reserved.capsuleId;
    live.category = reserved.category;
    live.lastSeq = reserved.lastSeq || 0;
    if (reserved.chunks && reserved.chunks.length > 0) {
      live.chunks = [...reserved.chunks];
      live.bufferBytes = reserved.bufferBytes;
    } else if (reserved.buffer) {
      live.buffer = reserved.buffer;
      live.bufferBytes = reserved.bufferBytes;
    }
    return live;
  }

  private scheduleDeferredPtyStarts(ids: string[]): void {
    for (const id of ids) {
      if (!this.deferredPtyIds.includes(id)) this.deferredPtyIds.push(id);
    }
    this.pumpDeferredPtyQueue();
  }

  private pumpDeferredPtyQueue(): void {
    if (this.isDisposed || this.deferredPtyTimer || this.deferredPtyIds.length === 0) return;
    this.deferredPtyTimer = setTimeout(() => {
      this.deferredPtyTimer = null;
      // A session put to sleep after it was queued must never be resurrected by
      // the queue: drop it (not merely skip it, which would wedge the head) so
      // the nap really costs zero processes.
      while (this.deferredPtyIds.length > 0) {
        const candidate = this.deferredPtyIds[0]!;
        if (this.sessions.get(candidate)?.state === 'sleeping') {
          this.deferredPtyIds.shift();
          continue;
        }
        break;
      }
      const nextId = this.deferredPtyIds[0];
      if (nextId) this.ensureSessionPty(nextId);
      this.pumpDeferredPtyQueue();
    }, DEFERRED_PTY_START_DELAY_MS);
    this.deferredPtyTimer.unref();
  }

  private spawn(id: string, cwd: string, restoredBuffer = '', initialCols?: number, initialRows?: number, minimumRows = MIN_TERMINAL_ROWS, parentSessionId?: string, parentGeneration?: number, reservedGeneration?: number): Session {
    let validCwd = cwd || this.currentCwd;
    try {
      if (!validCwd || !fs.existsSync(validCwd) || !fs.statSync(validCwd).isDirectory()) {
        validCwd = process.cwd();
      }
    } catch {
      validCwd = process.cwd();
    }
    const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
    let child: pty.IPty;
    const cols = Math.max(40, initialCols || this.lastCols || 120);
    const rows = Math.max(minimumRows, initialRows || this.lastRows || 30);
    const scriptsDir = resolveScriptsDir();
    const pathDelimiter = process.platform === 'win32' ? ';' : ':';
    const currentPath = process.env.PATH || '';
    const envPath = scriptsDir ? (currentPath ? `${scriptsDir}${pathDelimiter}${currentPath}` : scriptsDir) : currentPath;
    // A deferred restore reserved this session's generation when it created the
    // record; reusing it keeps agent affinity and the renderer's chunk-generation
    // stream continuous when the shell actually starts.
    const generation = reservedGeneration !== undefined ? reservedGeneration : (this.sessionGenerations.get(id) || 0) + 1;
    this.sessionGenerations.set(id, generation);
    const affinitySessionId = parentSessionId || id;
    const affinityGeneration = String(parentGeneration !== undefined ? parentGeneration : generation);
    const terminalEnv: Record<string, string> = {
      ...process.env,
      PATH: envPath,
      TERM: 'xterm-256color',
      FORCE_COLOR: '1',
      ANTIFAN_CONFIG_DIR: process.env.ANTIFAN_CONFIG_DIR || StorageLocations.getConfigDir(),
      ANTIFAN_DATA_ROOT: process.env.ANTIFAN_DATA_ROOT || StorageLocations.getDataRoot(),
      // Endpoint metadata only (never a token): the owning instance tells its own
      // terminals which bridge they belong to.
      ...(this.bridgeEndpoint
        ? {
            ANTIFAN_BRIDGE_PORT: String(this.bridgeEndpoint.port),
            ANTIFAN_BRIDGE_HOST: this.bridgeEndpoint.host,
            ANTIFAN_BRIDGE_PID: String(this.bridgeEndpoint.pid),
          }
        : {}),
      ANTIFAN_TERMINAL_SESSION_ID: id,
      ANTIFAN_TERMINAL_GENERATION: String(generation),
      ANTIFAN_TERMINAL_AFFINITY_SESSION_ID: affinitySessionId,
      ANTIFAN_TERMINAL_AFFINITY_GENERATION: affinityGeneration,
      ...(parentSessionId ? { ANTIFAN_TERMINAL_PARENT_SESSION_ID: parentSessionId } : {}),
    };
    const basePtyOptions: pty.IBasePtyForkOptions = {
      cols,
      rows,
      env: terminalEnv,
    };

    const spawnWithCwd = (options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions, targetCwd: string): pty.IPty => {
      try {
        return pty.spawn(shell, [], { ...options, cwd: targetCwd });
      } catch {
        return pty.spawn(shell, [], { ...options, cwd: os.homedir() });
      }
    };

    const canUseConpty = this.supportsConpty() && !this.conptyFailed;
    if (canUseConpty) {
      try {
        child = spawnWithCwd({ ...basePtyOptions, useConpty: true }, validCwd);
      } catch (err) {
        if (!this.conptyFallbackLogged) {
          this.conptyFallbackLogged = true;
          console.warn('[antifan:terminal] ConPTY spawn failed, falling back to legacy winpty:', err);
        }
        this.conptyFailed = true;
        child = spawnWithCwd({ ...basePtyOptions, useConpty: false }, validCwd);
      }
    } else {
      const legacyOptions: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions = {
        ...basePtyOptions,
        ...(process.platform === 'win32' ? { useConpty: false } : {}),
      };
      child = spawnWithCwd(legacyOptions, validCwd);
    }
    const s = this.createSessionRecord(id, validCwd, restoredBuffer, cols, rows, minimumRows, parentSessionId, generation, parentGeneration);
    // The record must carry its own shell handle: `writeTo`/`resizeTo` route through it, teardown
    // kills it, and `ensureSessionPty` reads it to tell a live session from a deferred restore.
    s.pty = child;
    const dataSub = child.onData(data => {
      if (s.disposed) return;
      const dataBytes = Buffer.byteLength(data, 'utf8');
      if (isBenchmarkEnabled()) {
        this.benchmarkChunkSeq += 1;
        this.benchmarkChunkBytes += dataBytes;
        recordBenchmark({ surface: 'terminal', name: 'ptyData', value: dataBytes, extra: { sessionId: id, chunkSeq: this.benchmarkChunkSeq, totalBytes: this.benchmarkChunkBytes } });
      }
      this.appendData(s, data, dataBytes);
    });
    const exitSub = child.onExit(({ exitCode, signal }) => {
      if (s.disposed) return;
      recordBenchmark({ surface: 'terminal', name: 'exit', extra: { sessionId: id, exitCode } });
      s.state = 'exited';
      s.exitCode = exitCode;
      s.exitSignal = typeof signal === 'number' ? signal : undefined;
      s.exitedAt = Date.now();
      const data = `\r\n[Process exited with code ${exitCode}]\r\n`;
      this.appendData(s, data);
      this.emit('exit', {
        sessionId: s.id,
        sessionGeneration: s.sessionGeneration,
        exitCode,
        signal,
        lastSeq: s.lastSeq,
        exitedAt: s.exitedAt,
      });
      this.emitSession();
    });
    s.dataSubscription = dataSub;
    s.exitSubscription = exitSub;
    this.sessions.set(id, s);
    return s;
  }
  private appendData(s: Session, data: string, dataBytes = Buffer.byteLength(data, 'utf8')): void {
    if (s.disposed) return;
    // Track the alternate screen buffer so full-screen TUIs (vim/htop/less)
    // are never mistaken for a clear-screen repaint. ConPTY splits chunks mid
    // sequence (`…\x1b[?10` then `49h…`), so the scan runs over the previous
    // chunk's tail plus this one, and the longest sequence minus one byte is
    // retained. The last escape seen wins when both appear in one chunk: leaving
    // the alternate screen is what a viewer must observe, and a stale `true`
    // would silence the next clear-screen repaint.
    const altScan = (s.altScreenScanTail || '') + data;
    s.altScreenScanTail = altScan.slice(-(ALT_SCREEN_SEQ_LENGTH - 1));
    if (altScan.includes('\x1b[?1049')) {
      const entered = altScan.lastIndexOf(ALT_SCREEN_ON_SEQ);
      const left = altScan.lastIndexOf(ALT_SCREEN_OFF_SEQ);
      if (entered >= 0 || left >= 0) s.altScreen = entered > left;
    }
    if (s.pendingClearScreen && !s.altScreen) {
      // The shell is repainting after cls/clear/Ctrl+L: drop the transcript and
      // the retained journal, and tell renderers to wipe scrollback too. The
      // seq counter stays monotonic — the renderer's lastRenderedSeq depends on it.
      //
      // The guard reads the state this instant, and that is deliberate: a chunk
      // that ends mid-sequence has not entered the alternate screen yet, and a
      // clear issued at the prompt applies to the chunk that arrives rather than
      // waiting for a sequence to finish. Deferring it to the end of the alternate
      // screen would turn a prompt-issued clear into a wipe of the full-screen
      // program's own output, which is the opposite of what the keystroke asked
      // for. Only a clear issued *while* the alternate screen is active is held
      // back, because there the program owns the screen and repaints it itself.
      s.buffer = '';
      s.bufferBytes = 0;
      s.restoredTail = undefined;
      s.deliveryJournal.clear();
      data = '\x1b[3J' + data;
      dataBytes += 4; // '\x1b[3J' is 4 bytes
      s.pendingClearScreen = false;
    }
    s.lastSeq = (s.lastSeq || 0) + 1;
    s.deliveryJournal.append(s.sessionGeneration, s.lastSeq, data, dataBytes);
    s.appendData(data, dataBytes);
    if (s.bufferBytes > MAX_TRANSCRIPT_BYTES + TRANSCRIPT_TRIM_OVERSHOOT_BYTES) {
      s.trimTail(MAX_TRANSCRIPT_BYTES);
    }
    this.schedulePersist(s.id);
    if (isBenchmarkEnabled()) {
      let stamps = this.emitTimeMs.get(s.id);
      if (!stamps) {
        stamps = new Map();
        this.emitTimeMs.set(s.id, stamps);
      }
      stamps.set(s.lastSeq, performance.now());
      // Sequences gated or coalesced downstream are never acked; bound the map
      // so those stamps cannot accumulate for the life of the session.
      while (stamps.size > MAX_EMIT_TIME_STAMPS_PER_SESSION) {
        const oldest = stamps.keys().next();
        if (oldest.done) break;
        stamps.delete(oldest.value);
      }
    }
    this.emit('data', { sessionId: s.id, data, seq: s.lastSeq, generation: s.sessionGeneration });
  }

  public startTerminal(cwd?: string): boolean {
    this.isDisposed = false;
    if (cwd) this.currentCwd = cwd;
    const sessions = this.listSessions();
    if (!sessions.length) {
      const { activeSessionId: savedActiveId, sessions: saved } = this.readSavedSessions();
      const baseSessions = saved.filter(item => !item.splitOf);
      if (baseSessions.length > 0) {
        // Only the session the user lands on starts its shell eagerly: restoring every
        // saved session synchronously blocked the main thread for seconds. The others
        // get their restored transcript record now and start from a deferred queue,
        // materializing immediately if anything touches them first.
        const savedActiveEntry = savedActiveId ? saved.find(item => item.id === savedActiveId) : undefined;
        const requestedBaseId = savedActiveEntry ? (savedActiveEntry.splitOf || savedActiveEntry.id) : '';
        const activeBaseId = baseSessions.some(item => item.id === requestedBaseId)
          ? requestedBaseId
          : baseSessions[0]!.id;
        const deferredIds: string[] = [];
        for (const item of baseSessions) {
          if (item.id === activeBaseId) {
            // A tab the user put to sleep before quitting must come back asleep:
            // restoring it may not cost a shell, not even for the landing tab.
            if (item.state === 'sleeping') {
              this.restoreSleepingSession(item, item.cols, item.rows, MIN_TERMINAL_ROWS);
            } else {
              const s = this.spawn(item.id, item.cwd || this.currentCwd, item.buffer || '', item.cols, item.rows);
              s.name = item.name || s.name;
              s.capsuleId = item.capsuleId || this.currentCapsuleId;
            }
          } else if (item.state === 'sleeping') {
            this.restoreSleepingSession(item, item.cols, item.rows, MIN_TERMINAL_ROWS);
          } else {
            this.reserveRestoredSession(item, item.cols, item.rows, MIN_TERMINAL_ROWS);
            deferredIds.push(item.id);
          }
        }
        const splitSessions = saved.filter(item => item.splitOf && this.sessions.has(item.splitOf));
        for (const item of splitSessions) {
          const parent = item.splitOf ? this.sessions.get(item.splitOf) : undefined;
          const parentRows = parent?.pty?.rows || parent?.pendingRows;
          const initialRows = item.rows || this.getInitialSplitRows(parentRows || this.lastRows);
          // A pane cannot outlive its parent's live shell, so a save that predates the
          // sleep cascade (or a parent parked while this pane still ran) restores the
          // pane asleep instead of resurrecting a shell under a parked tab.
          if (item.state === 'sleeping' || parent?.state === 'sleeping') {
            this.restoreSleepingSession(item, item.cols, initialRows, MIN_SPLIT_TERMINAL_ROWS, item.splitOf, parent?.sessionGeneration);
          } else if (item.splitOf === activeBaseId) {
            const s = this.spawn(item.id, item.cwd || this.currentCwd, item.buffer || '', item.cols, initialRows, MIN_SPLIT_TERMINAL_ROWS, item.splitOf, parent?.sessionGeneration);
            s.name = item.name || s.name;
            s.splitOf = item.splitOf;
            s.capsuleId = item.capsuleId || this.currentCapsuleId;
          } else {
            this.reserveRestoredSession(item, item.cols, initialRows, MIN_SPLIT_TERMINAL_ROWS, item.splitOf, parent?.sessionGeneration);
            deferredIds.push(item.id);
          }
        }
        this.scheduleDeferredPtyStarts(deferredIds);
        if (savedActiveId && this.sessions.has(savedActiveId)) {
          const savedTarget = this.sessions.get(savedActiveId);
          this.activeSessionId = savedTarget?.splitOf || savedActiveId;
        } else {
          this.activeSessionId = baseSessions[0]?.id || '';
        }
      } else {
        const id = this.nextTerminalId();
        this.activeSessionId = id;
        this.spawn(id, this.currentCwd);
      }
      this.persist();
      this.emitSession();
      return true;
    }
    if (!this.sessions.has(this.activeSessionId)) {
      this.activeSessionId = sessions[0]!.id;
    }
    this.emitSession();
    return true;
  }

  private nextTerminalId(): string {
    let n = 1;
    while (this.sessions.has(`terminal-${n}`)) n++;
    return `terminal-${n}`;
  }

  public write(input: string): void {
    const s = this.resolveWritableSession(this.activeSessionId);
    if (!s || !s.pty) return;
    // The keystroke must reach the shell before the detector runs: the detector
    // only observes, it never swallows, reorders, or delays input.
    s.pty.write(input);
    this.trackInputLine(s, input);
  }

  public writeTo(id: string, input: string): void {
    const s = this.resolveWritableSession(id);
    if (!s || !s.pty) return;
    s.pty.write(input);
    this.trackInputLine(s, input);
  }

  /**
   * Resolves the record a keystroke must reach, waking a sleeping session first.
   * Typing IS the wake trigger, so it has to run the full `wakeSession`
   * transition — not a bare `ensureSessionPty` — or the affinity tombstone
   * written while the session slept is never cleared and the owning agent stays
   * forbidden (`TERMINAL_FORBIDDEN`) for the rest of the run.
   */
  private resolveWritableSession(id: string): Session | undefined {
    if (!id) return undefined;
    const record = this.sessions.get(id);
    if (record && !record.disposed && record.state === 'sleeping') {
      if (!this.wakeSession(id)) return undefined;
      return this.sessions.get(id);
    }
    return this.ensureSessionPty(id);
  }

  /**
   * Maintains a rolling copy of the line being typed so a clear-screen command
   * can be recognized at the prompt. Enter submits the line for classification;
   * Ctrl+L is itself the clear-screen keystroke and needs no line content.
   * Any other control character (Ctrl+C, Ctrl+U, arrows, escape sequences)
   * abandons the line — the buffer always resets on Enter/Ctrl+L so it can
   * neither grow past INPUT_LINE_MAX_CHARS nor leak across commands.
   */
  private trackInputLine(s: Session, input: string): void {
    let line = s.inputLineBuffer || '';
    for (let i = 0; i < input.length; i++) {
      const ch = input[i]!;
      if (ch === '\r' || ch === '\n') {
        if (CLEAR_SCREEN_COMMAND_RE.test(line)) {
          s.pendingClearScreen = true;
        }
        line = '';
      } else if (ch === '\x0c') {
        s.pendingClearScreen = true;
        line = '';
      } else if (ch === '\x7f' || ch === '\b') {
        line = line.slice(0, -1);
      } else if (ch >= ' ') {
        line += ch;
        if (line.length > INPUT_LINE_MAX_CHARS) {
          line = line.slice(-INPUT_LINE_MAX_CHARS);
        }
      } else {
        line = '';
      }
    }
    s.inputLineBuffer = line;
  }
  public resize(cols: number, rows: number): void {
    const validCols = Math.max(40, cols);
    const validRows = Math.max(MIN_TERMINAL_ROWS, rows);
    if (validCols >= 60 && validRows >= 15) {
      this.lastCols = validCols;
      this.lastRows = validRows;
    }
    for (const s of this.sessions.values()) {
      // A sleeping session has no shell to resize; its geometry is re-applied by
      // the pane when it wakes.
      if (s.disposed || s.state === 'sleeping') continue;
      s.pendingCols = validCols;
      s.pendingRows = validRows;
      if (!s.pty) continue;
      try {
        s.pty.resize(validCols, validRows);
      } catch {}
    }
  }

  public resizeTo(id: string, cols: number, rows: number): void {
    const target = this.sessions.get(id);
    const minRows = target?.splitOf ? MIN_SPLIT_TERMINAL_ROWS : MIN_TERMINAL_ROWS;
    const validCols = Math.max(40, cols);
    const validRows = Math.max(minRows, rows);
    if (target && !target.splitOf && validCols >= 60 && validRows >= 15) {
      this.lastCols = validCols;
      this.lastRows = validRows;
    }
    if (target && !target.disposed) {
      target.pendingCols = validCols;
      target.pendingRows = validRows;
      if (target.pty) {
        try { target.pty.resize(validCols, validRows); } catch {}
      }
    }
  }
  /**
   * Releases the session's shell and every OS resource behind it, and nothing
   * else: no `disposed`, no `state` transition, no event. The record, its
   * transcript, its generation and its tab affinity all survive, which is what
   * makes sleep different from close. `safelyKillSession` builds the terminal
   * state on top of this.
   */
  private async teardownSessionPty(s: Session | undefined): Promise<void> {
    if (!s) return;
    // Drop per-session bookkeeping that belongs to the dead shell: unacked emit
    // stamps can never be acked once the pty stops emitting chunks.
    this.emitTimeMs.delete(s.id);
    if (s.dataSubscription) {
      try { s.dataSubscription.dispose(); } catch {}
      s.dataSubscription = undefined;
    }
    if (s.exitSubscription) {
      try { s.exitSubscription.dispose(); } catch {}
      s.exitSubscription = undefined;
    }
    const ptyInstance = s.pty;
    // If the session was paused for backpressure, resume it unconditionally
    // before teardown so the shell can drain and exit cleanly.
    if (ptyInstance && typeof ptyInstance.resume === 'function') {
      try { ptyInstance.resume(); } catch {}
    }
    // Detach the handle synchronously: a keystroke arriving during the async kill
    // must not be written into a process that is being torn down.
    s.pty = null;
    const pid = ptyInstance?.pid;
    // A pty write issued in the current event-loop turn is still queued on the
    // libuv loop. Tearing the pty down before that write flushes leaves a
    // half-written handle behind and deadlocks process shutdown on Windows
    // (verified: write+close in one turn hangs app.exit/app.quit; one macrotask
    // of separation does not). Yield a single loop turn before killing.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (ptyInstance) {
      try {
        if (typeof (ptyInstance as any).removeAllListeners === 'function') {
          (ptyInstance as any).removeAllListeners();
        }
        if (typeof (ptyInstance as any).on === 'function') {
          (ptyInstance as any).on('error', () => {});
        }
        const agent = (ptyInstance as any)._agent;
        const agentPid = agent?._pid;

        // 1. Kill ptyInstance first while pipes are intact
        try { ptyInstance.kill(); } catch {}

        // 2. Dispose worker thread and close sockets
        if (agent) {
          try { agent._conoutSocketWorker?.dispose?.(); } catch {}
          try { agent._cleanUpProcess?.(); } catch {}
          try { agent._inSocket?.destroy?.(); } catch {}
          try { agent._outSocket?.destroy?.(); } catch {}
          try { agent._inSocket?.unref?.(); } catch {}
          try { agent._outSocket?.unref?.(); } catch {}
        }
        if (typeof (ptyInstance as any)._socket?.destroy === 'function') {
          try { (ptyInstance as any)._socket.destroy(); } catch {}
        }
        if (typeof (ptyInstance as any)._socket?.unref === 'function') {
          try { (ptyInstance as any)._socket.unref(); } catch {}
        }
        if (typeof (ptyInstance as any).destroy === 'function') {
          try { (ptyInstance as any).destroy(); } catch {}
        }
        if (typeof (ptyInstance as any).unref === 'function') {
          try { (ptyInstance as any).unref(); } catch {}
        }

        // 3. Kill agent process tree if separate
        if (agentPid && typeof agentPid === 'number' && agentPid > 0 && agentPid !== pid) {
          await killProcessTree(agentPid);
        }
      } catch {}
    }
    if (pid && typeof pid === 'number' && pid > 0) {
      await killProcessTree(pid);
    }
  }
  private async safelyKillSession(s: Session | undefined): Promise<void> {
    if (!s || s.disposed) return;
    s.disposed = true;
    s.state = 'closed';
    s.closedAt = Date.now();
    this.emit('close', {
      sessionId: s.id,
      sessionGeneration: s.sessionGeneration,
      lastSeq: s.lastSeq,
      closedAt: s.closedAt,
    });
    // A closed record will never persist again, so its dirty flag is dropped;
    // the emit stamps belong to the shell and are cleared by the teardown.
    this.dirtySessionIds.delete(s.id);
    await this.teardownSessionPty(s);
  }
  private pruneSubscribersForSession(sessionId: string): void {
    for (const [key, sub] of this.subscribers.entries()) {
      if (sub.sessionId === sessionId) {
        this.subscribers.delete(key);
      }
    }
  }
  public async kill(): Promise<void> {
    const s = this.sessions.get(this.activeSessionId);
    if (s) {
      const split = [...this.sessions.values()].find(x => x.splitOf === s.id);
      if (split) {
        await this.safelyKillSession(split);
        this.sessions.delete(split.id);
        this.sessionGenerations.delete(split.id);
        this.dirtySessionIds.delete(split.id);
        this.pruneSubscribersForSession(split.id);
        this.emit('session-closed', { id: split.id, generation: split.sessionGeneration });
      }
      await this.safelyKillSession(s);
      this.sessions.delete(s.id);
      this.sessionGenerations.delete(s.id);
      this.dirtySessionIds.delete(s.id);
      this.pruneSubscribersForSession(s.id);
      if (this.activeSessionId === s.id) {
        this.activeSessionId = this.listSessions()[0]?.id || '';
      }
      this.persist();
      this.emitSession();
    }
  }

  public async restart(cwd?: string): Promise<void> {
    if (cwd) this.currentCwd = cwd;
    let id = this.activeSessionId;
    if (!id || !this.sessions.has(id)) {
      const list = this.listSessions();
      if (list.length > 0) {
        id = list[0]!.id;
        this.activeSessionId = id;
      } else {
        id = this.nextTerminalId();
        this.activeSessionId = id;
      }
    }
    const split = [...this.sessions.values()].find(x => x.splitOf === id);
    if (split) {
      await this.safelyKillSession(split);
      this.sessions.delete(split.id);
      this.emit('session-closed', { id: split.id, generation: split.sessionGeneration });
    }
    const targetSession = this.sessions.get(id);
    if (targetSession) {
      await this.safelyKillSession(targetSession);
      this.sessions.delete(id);
    }
    const s = this.spawn(id, cwd || this.currentCwd);
    this.persist();
    this.emitSession();
    this.emit('session-restarted', { id, generation: s.sessionGeneration });
  }

  public createSession(cwd?: string): string {
    this.isDisposed = false;
    const id = this.nextTerminalId();
    this.activeSessionId = id;
    const s = this.spawn(id, cwd || this.currentCwd);
    this.persist();
    this.emitSession();
    this.emit('session-created', { id, generation: s.sessionGeneration });
    return id;
  }

  public createSplitSession(parentId: string, cwd?: string, initialCols?: number, initialRows?: number): string {
    const parentRecord = this.sessions.get(parentId);
    if (!parentRecord || parentRecord.disposed || parentRecord.splitOf) return '';
    // Splitting genuinely needs two live shells: route a sleeping parent through
    // the wake transition instead of a bare ensureSessionPty, so the wake is
    // broadcast (and the affinity tombstone cleared) exactly once.
    const parent = parentRecord.state === 'sleeping'
      ? (this.wakeSession(parentId) ? (this.sessions.get(parentId) || parentRecord) : parentRecord)
      : (this.ensureSessionPty(parentId) || parentRecord);
    const existing = [...this.sessions.values()].find(x => x.splitOf === parentId);
    if (existing) {
      // The sidebar may hide a sleeping split, so the split toggle is also its
      // explicit wake path. Reuse the existing pane instead of creating a second
      // split, and wake it after the parent has been made live above.
      if (existing.state === 'sleeping') this.wakeSession(existing.id);
      return existing.id;
    }
    let n = 1;
    while (this.sessions.has(`split-${n}`)) n++;
    const id = `split-${n}`;
    const targetCols = Math.max(40, initialCols || this.lastCols || 120);
    const targetRows = Math.max(MIN_SPLIT_TERMINAL_ROWS, initialRows || this.getInitialSplitRows(parent.pty?.rows));
    const splitSession = this.spawn(id, cwd || parent.cwd, '', targetCols, targetRows, MIN_SPLIT_TERMINAL_ROWS, parentId, parent.sessionGeneration);
    splitSession.splitOf = parentId;
    splitSession.capsuleId = parent.capsuleId || this.currentCapsuleId;
    this.persist();
    this.emitSession();
    this.emit('session-created', { id, parentId, generation: splitSession.sessionGeneration });
    return id;
  }

  public async closeSplitSession(parentIdOrSplitId: string): Promise<boolean> {
    let split = [...this.sessions.values()].find(x => x.splitOf === parentIdOrSplitId);
    if (!split) {
      const direct = this.sessions.get(parentIdOrSplitId);
      if (direct && direct.splitOf) {
        split = direct;
      }
    }
    if (!split) return false;
    await this.safelyKillSession(split);
    this.sessions.delete(split.id);
    this.sessionGenerations.delete(split.id);
    this.dirtySessionIds.delete(split.id);
    this.pruneSubscribersForSession(split.id);
    this.emit('session-closed', { id: split.id, generation: split.sessionGeneration });
    this.persist();
    this.emitSession();
    return true;
  }

  /**
   * Puts a running session to sleep: the shell and its whole process tree are
   * released, the transcript is folded into `restoredTail` and the record stays
   * in the session map so every viewer keeps its history.
   *
   * A base session takes its split panes with it: a pane has no life outside the
   * tab it splits, and a pane left running under a parked tab keeps a shell for a
   * session the user believes is put away. `wakeSession` is the mirror — waking a
   * pane wakes the tab that owns it.
   *
   * Sleep is NOT close. It never sets `disposed` and never emits `'close'` or
   * `'session-closed'`: `native-tab-host.ts` treats those as the signal to drop
   * the browser-tab ↔ terminal affinity mapping, which would make the session
   * permanently unwakeable and wedge the owning agent. The only event is the
   * ordinary `'session'` broadcast.
   */
  public sleepSession(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.disposed || s.state !== 'running') return false;
    // A pane is subordinate to the tab it splits, so parking the parent parks its panes
    // in the same breath. A split left running under a sleeping parent keeps a PTY
    // alive for a tab the user believes is parked, and the sidebar files that pane by
    // its own category — the parent it inherits its group from is no longer awake —
    // so the row leaks out of its parent's group as a standalone entry.
    for (const split of [...this.sessions.values()]) {
      if (split.splitOf === id) this.parkRecord(split);
    }
    const parked = this.parkRecord(s);
    // One broadcast for the whole cascade: the panes and their parent change state
    // together, and a per-record emit would paint the sidebar mid-park.
    this.emitSession();
    return parked;
  }

  /**
   * The per-record half of `sleepSession`: releases the shell, folds the live output
   * behind the restored tail and leaves the record in the map. Deliberately silent —
   * the caller owns the single broadcast for the whole cascade.
   */
  private parkRecord(s: Session | undefined): boolean {
    if (!s || s.disposed || s.state !== 'running') return false;
    // A queued deferred start would spawn the shell we are about to release.
    const queuedIdx = this.deferredPtyIds.indexOf(s.id);
    if (queuedIdx !== -1) this.deferredPtyIds.splice(queuedIdx, 1);
    // Disposes the data/exit subscriptions first, so no chunk can land between
    // the fold and the kill.
    void this.teardownSessionPty(s);
    // Fold the live output behind the restored tail so getFullBuffer /
    // listSessions / mobile-remote-html keep serving the whole transcript from a
    // record that has no shell and an empty live buffer.
    s.restoredTail = this.composeTranscript(s);
    s.buffer = '';
    s.bufferBytes = 0;
    s.deliveryJournal.clear();
    // Shell-scoped input state dies with the shell: a stale pendingClearScreen
    // would wipe the folded transcript on the first chunk after the wake.
    s.pendingClearScreen = false;
    s.altScreen = false;
    s.altScreenScanTail = undefined;
    s.inputLineBuffer = '';
    s.state = 'sleeping';
    s.sleptAt = Date.now();
    this.schedulePersist(s.id);
    return true;
  }

  /**
   * Wakes a sleeping session: materializes a fresh shell in the same cwd and
   * reuses the reserved generation, so the `${terminalId}@${generation}` affinity
   * key is stable and `'session-restarted'` (which would migrate that key) is
   * never emitted. On failure the session is left asleep so a retry is possible.
   */
  public wakeSession(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.disposed || s.state !== 'sleeping') return false;
    // The mirror of the sleep cascade: a pane needs the tab it splits to be live, so a
    // wake request for a pane wakes that tab first. A pane awake under a sleeping parent
    // is a shell the sidebar cannot file — its group comes from a parent that is parked —
    // and the parent's own wake path would then park it again on the next sleep.
    if (s.splitOf) {
      const parent = this.sessions.get(s.splitOf);
      if (parent && !parent.disposed && parent.state === 'sleeping') this.wakeSession(s.splitOf);
    }
    // ensureSessionPty replaces the reserved record with the spawned one, so the
    // state flip and the event must be driven from the returned live record.
    const live = this.ensureSessionPty(id);
    if (!live || !live.pty) return false;
    // The folded transcript returns to the live buffer. It is the SAME session
    // continuing, not a previous run, so its history must travel in the field a
    // running session persists: a `restoredTail` is display-only and is dropped
    // from disk for a live session, which would lose the whole transcript if the
    // user quit before the shell printed anything new.
    if (live.restoredTail) {
      live.buffer = live.restoredTail + live.buffer;
      live.bufferBytes = Buffer.byteLength(live.buffer, 'utf8');
      live.restoredTail = undefined;
    }
    live.state = 'running';
    live.sleptAt = undefined;
    this.schedulePersist(id);
    this.emitSession();
    this.emit('session-woken', { id, generation: live.sessionGeneration });
    return true;
  }

  /**
   * Assigns (or clears) the tab-strip category. Whitespace and empty strings
   * mean "no category" rather than an unnamed group.
   */
  public setCategory(id: string, category?: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.disposed) return false;
    const trimmed = typeof category === 'string' ? category.trim() : '';
    s.category = trimmed ? trimmed : undefined;
    this.schedulePersist(id);
    this.emitSession();
    return true;
  }

  /**
   * The transcript a viewer should render: the restored on-disk tail behind a
   * separator, then the live shell output. Single source for getFullBuffer and
   * listSessions so the two views can never drift apart.
   */
  private composeTranscript(s: Session): string {
    return (s.restoredTail ? s.restoredTail + '\r\n── phiên trước ──\r\n' : '') + s.buffer;
  }

  /**
   * Every live pane: base sessions first, each followed by the splits it owns.
   *
   * A split is an independent terminal (own id, own transcript, own activity), so it is
   * projected as its own entry — the tab strip keys panes by id and would otherwise show
   * a split as part of its parent. Base entries keep `splitSessionId`/`splitBuffer`
   * carrying the first split, which is what the lower-pane plumbing asks for by name.
   */
  public listSessions(paged = true): SessionSummary[] {
    const all = [...this.sessions.values()];
    const baseSessions = all.filter(s => !s.splitOf);
    const splitsByParent = new Map<string, Session[]>();
    for (const s of all) {
      if (!s.splitOf) continue;
      const siblings = splitsByParent.get(s.splitOf);
      if (siblings) siblings.push(s);
      else splitsByParent.set(s.splitOf, [s]);
    }

    // `cwd` is the directory the split was created in (a split does not follow the
    // parent's later `cd`), and `state`/`exitCode` are its own PTY's.
    const summarize = (s: Session, active: boolean, buffer: string): SessionSummary => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      active,
      buffer,
      snapshotThroughSeq: s.lastSeq || 0,
      splitOf: s.splitOf,
      bufferLength: s.bufferBytes ?? Buffer.byteLength(s.buffer, 'utf8'),
      sessionGeneration: s.sessionGeneration,
      state: s.state,
      exitCode: s.exitCode,
      exitedAt: s.exitedAt,
      closedAt: s.closedAt,
      category: s.category,
      sleptAt: s.sleptAt,
      cols: s.pendingCols || s.pty?.cols || this.lastCols || 120,
      rows: s.pendingRows || s.pty?.rows || this.lastRows || 30,
      altScreen: Boolean(s.altScreen),
    });

    if (!paged || baseSessions.length === 0) {
      const summaries: SessionSummary[] = [];
      for (const s of baseSessions) {
        const splits = splitsByParent.get(s.id) || [];
        const first = splits[0];
        summaries.push({
          ...summarize(s, s.id === this.activeSessionId, this.composeTranscript(s)),
          splitSessionId: first?.id,
          splitBuffer: first ? this.composeTranscript(first) : '',
          splitSnapshotThroughSeq: first ? (first.lastSeq || 0) : 0,
        });
        for (const split of splits) {
          summaries.push(summarize(split, false, this.composeTranscript(split)));
        }
      }
      return summaries;
    }

    const activeBudget = ACTIVE_SNAPSHOT_BUDGET_BYTES;
    const bgBudget = all.length > 1
      ? Math.floor(BACKGROUND_SNAPSHOT_BUDGET_BYTES / (all.length - 1))
      : activeBudget;

    const summaries: SessionSummary[] = [];
    for (const s of baseSessions) {
      const isActive = s.id === this.activeSessionId;
      const splits = splitsByParent.get(s.id) || [];
      const first = splits[0];
      const baseSlotBudget = isActive ? activeBudget : bgBudget;

      summaries.push({
        ...summarize(s, isActive, safeSliceTailJsonBounded(this.composeTranscript(s), baseSlotBudget)),
        splitSessionId: first?.id,
        splitBuffer: first ? safeSliceTailJsonBounded(this.composeTranscript(first), bgBudget) : '',
        splitSnapshotThroughSeq: first ? (first.lastSeq || 0) : 0,
      });
      // Each split carries its own transcript, so a sibling split can never be rendered
      // in another split's place.
      for (const split of splits) {
        summaries.push(summarize(split, false, safeSliceTailJsonBounded(this.composeTranscript(split), bgBudget)));
      }
    }
    return summaries;
  }

  public getStats(): TerminalManagerStats {
    let runningPtyCount = 0;
    let transcriptBytes = 0;
    let dataSubscriptionCount = 0;
    let exitSubscriptionCount = 0;
    for (const session of this.sessions.values()) {
      if (session.pty && session.state === 'running' && !session.disposed) runningPtyCount++;
      transcriptBytes += (session.bufferBytes ?? Buffer.byteLength(session.buffer, 'utf8'))
        + (session.restoredTail ? Buffer.byteLength(session.restoredTail, 'utf8') : 0);
      if (session.dataSubscription) dataSubscriptionCount++;
      if (session.exitSubscription) exitSubscriptionCount++;
    }
    return {
      sessionCount: this.sessions.size,
      runningPtyCount,
      transcriptBytes,
      dataSubscriptionCount,
      exitSubscriptionCount,
    };
  }

  public getFullBuffer(sessionId: string): { sessionId: string; buffer: string; snapshotThroughSeq: number } {
    const s = this.sessions.get(sessionId);
    return {
      sessionId,
      buffer: s ? this.composeTranscript(s) : '',
      snapshotThroughSeq: s ? (s.lastSeq || 0) : 0,
    };
  }

  public getDiagnostics(): TerminalDiagnosticsReport {
    return {
      timestamp: Date.now(),
      sessionCount: this.sessions.size,
      activeSessionId: this.activeSessionId,
      sessions: [...this.sessions.values()].map(s => ({
        sessionId: s.id,
        generation: s.sessionGeneration || 0,
        lastSeq: s.lastSeq || 0,
        bufferBytes: Buffer.byteLength(s.buffer || '', 'utf8'),
        state: s.state,
        splitOf: s.splitOf,
        altScreen: Boolean(s.altScreen),
        capsuleId: s.capsuleId,
      })),
      subscribers: this.getSubscribers(),
    };
  }

  public recordSubscriberAck(ack: TerminalAckPayload): void {
    if (!ack || !ack.rendererInstanceId || !ack.sessionId) return;
    const key = `${ack.rendererInstanceId}:${ack.sessionId}`;
    const existing = this.subscribers.get(key);
    const ackGen = ack.generation || 0;
    const existingGen = existing?.generation || 0;

    // Reject stale ACKs from an older generation
    if (ackGen < existingGen) {
      return;
    }

    // If generation advanced, reset lastAckedSeq to current ack.seq; otherwise take maximum
    const newLastAckedSeq = (ackGen > existingGen)
      ? (ack.seq || 0)
      : Math.max(existing?.lastAckedSeq || 0, ack.seq || 0);

    this.subscribers.set(key, {
      rendererInstanceId: ack.rendererInstanceId,
      sessionId: ack.sessionId,
      generation: ackGen,
      lastAckedSeq: newLastAckedSeq,
      role: ack.role || existing?.role || 'DOCK',
      lastHeartbeatAt: Date.now(),
    });
    if (isBenchmarkEnabled()) {
      // Same-clock latency: the emit stamp was taken in this process when the
      // chunk was dispatched, so no renderer clock skew enters the measurement.
      const stamps = this.emitTimeMs.get(ack.sessionId);
      if (stamps) {
        const emitTime = stamps.get(ack.seq);
        if (emitTime !== undefined) {
          recordBenchmark({
            surface: 'terminal',
            name: 'ackLatency',
            value: performance.now() - emitTime,
            extra: { sessionId: ack.sessionId, seq: ack.seq },
          });
        }
        // The ack covers this seq and everything before it; drop the covered
        // stamps so the map only ever holds in-flight sequences.
        for (const seq of stamps.keys()) {
          if (seq <= ack.seq) stamps.delete(seq);
        }
      }
    }
    this.pruneStaleSubscribers();
  }

  public pruneStaleSubscribers(maxAgeMs = 30000): void {
    const now = Date.now();
    for (const [key, sub] of this.subscribers.entries()) {
      if (now - sub.lastHeartbeatAt >= maxAgeMs) {
        this.subscribers.delete(key);
      }
    }
  }

  public getSubscribers(maxAgeMs = 30000): TerminalSubscriberState[] {
    this.pruneStaleSubscribers(maxAgeMs);
    return [...this.subscribers.values()];
  }

  public getTerminalDelta(sessionId: string, generation: number, fromSeq: number): TerminalDeltaResult {
    const s = this.sessions.get(sessionId);
    if (!s || s.state === 'closed') {
      return { status: 'SESSION_CLOSED', finalSeq: s?.lastSeq || 0 };
    }
    if (generation > 0 && s.sessionGeneration !== generation) {
      return { status: 'GENERATION_MISMATCH', currentGeneration: s.sessionGeneration };
    }
    return s.deliveryJournal.getDelta(generation || s.sessionGeneration, fromSeq);
  }

  public syncTerminalView(query: { sessionId: string; knownGeneration: number; lastAppliedSeq: number }): TerminalSyncViewResult {
    const s = this.sessions.get(query.sessionId);
    if (!s || s.state === 'closed') {
      return { status: 'SESSION_CLOSED', finalSeq: s?.lastSeq || 0 };
    }
    if (query.knownGeneration > 0 && query.knownGeneration !== s.sessionGeneration) {
      return { status: 'GENERATION_CHANGED', currentGeneration: s.sessionGeneration };
    }
    if (query.lastAppliedSeq >= s.lastSeq) {
      return { status: 'UP_TO_DATE', generation: s.sessionGeneration, lastSeq: s.lastSeq };
    }
    const delta = s.deliveryJournal.getDelta(s.sessionGeneration, query.lastAppliedSeq + 1);
    if (delta.status === 'OK') {
      return {
        status: 'DELTA',
        generation: s.sessionGeneration,
        fromSeq: delta.fromSeq,
        throughSeq: delta.throughSeq,
        chunks: delta.chunks,
      };
    }
    if (delta.status === 'DELTA_EXPIRED') {
      return {
        status: 'DELTA_EXPIRED',
        generation: s.sessionGeneration,
        retainedFromSeq: delta.retainedFromSeq,
        retainedThroughSeq: delta.retainedThroughSeq,
      };
    }
    if (delta.status === 'GENERATION_MISMATCH') {
      return { status: 'GENERATION_CHANGED', currentGeneration: delta.currentGeneration };
    }
    return { status: 'UP_TO_DATE', generation: s.sessionGeneration, lastSeq: s.lastSeq };
  }

  public captureBaselineSeq(sessionId: string): { sessionId: string; sessionGeneration: number; baselineSeq: number } {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw new CapabilityError('INVALID_ARGUMENT', `Terminal session "${sessionId}" not found`);
    }
    if (s.disposed || (s.state !== 'running' && s.state !== 'sleeping')) {
      throw new CapabilityError('SESSION_CLOSED', `Terminal session "${sessionId}" is not running (state: ${s.state})`);
    }
    return {
      sessionId,
      sessionGeneration: s.sessionGeneration,
      baselineSeq: s.lastSeq || 0,
    };
  }

  public renameSession(id: string, name: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.splitOf || !name.trim()) return false;
    s.name = name.trim();
    this.persist();
    this.emitSession();
    return true;
  }

  public switchSession(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.disposed) return false;
    const targetId = s.splitOf ? s.splitOf : id;
    if (s.splitOf && !this.sessions.has(s.splitOf)) return false;
    if (this.activeSessionId === targetId) {
      return true;
    }
    // Selecting a sleeping tab is a free read of its transcript: materializing
    // its shell here would silently undo the nap on a plain tab click.
    const target = s.splitOf ? this.sessions.get(targetId) : s;
    if (!target || target.state !== 'sleeping') {
      this.ensureSessionPty(targetId);
    }
    this.activeSessionId = targetId;
    this.emitSession();
    return true;
  }

  public reorderSessions(orderIds: string[]): boolean {
    if (!Array.isArray(orderIds) || orderIds.length === 0) return false;
    const reordered = new Map<string, Session>();
    for (const id of orderIds) {
      const s = this.sessions.get(id);
      if (s) reordered.set(id, s);
    }
    for (const [id, s] of this.sessions.entries()) {
      if (!reordered.has(id)) reordered.set(id, s);
    }
    this.sessions = reordered;
    this.persist();
    this.emitSession();
    return true;
  }

  public async closeSession(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s || s.splitOf) return false;
    // Every split is its own PTY: closing the parent releases all of them, or a
    // sibling split survives as an orphan with no tab that could ever show or close it.
    const splits = [...this.sessions.values()].filter(x => x.splitOf === id);
    for (const split of splits) {
      await this.safelyKillSession(split);
      this.sessions.delete(split.id);
      this.sessionGenerations.delete(split.id);
      this.dirtySessionIds.delete(split.id);
      this.pruneSubscribersForSession(split.id);
      this.emit('session-closed', { id: split.id, generation: split.sessionGeneration });
    }
    await this.safelyKillSession(s);
    this.sessions.delete(id);
    this.sessionGenerations.delete(id);
    this.dirtySessionIds.delete(id);
    this.pruneSubscribersForSession(id);
    if (this.activeSessionId === id) {
      this.activeSessionId = this.listSessions()[0]?.id || '';
    }
    this.emit('session-closed', { id, generation: s.sessionGeneration });
    this.persist();
    this.emitSession();
    return true;
  }

  public getActiveSessionId(): string {
    return this.activeSessionId;
  }
  public getSession(id: string, _opts?: { includeBuffer?: boolean }) {
    return this.sessions.get(id);
  }

  public pauseSession(id: string): boolean {
    if (process.env.BRIDGE_PTY_BACKPRESSURE !== '1') return false;
    const s = this.sessions.get(id);
    if (!s || !s.pty) return false;
    if (typeof s.pty.pause !== 'function') {
      console.warn(`[antifan:terminal] pause() not available on this pty backend for session ${id}`);
      return false;
    }
    try {
      s.pty.pause();
      return true;
    } catch (err) {
      console.warn(`[antifan:terminal] failed to pause session ${id}:`, err);
      return false;
    }
  }

  public resumeSession(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.pty) return false;
    if (typeof s.pty.resume !== 'function') return false;
    try {
      s.pty.resume();
      return true;
    } catch (err) {
      console.warn(`[antifan:terminal] failed to resume session ${id}:`, err);
      return false;
    }
  }

  public findSessionForWorkspace(workspacePath: string): string | undefined {
    if (!workspacePath) return undefined;
    const normalizedTarget = path.normalize(workspacePath).toLowerCase().replace(/\\/g, '/');
    for (const session of this.sessions.values()) {
      if (!session.splitOf && session.cwd) {
        const normalizedCwd = path.normalize(session.cwd).toLowerCase().replace(/\\/g, '/');
        if (normalizedCwd === normalizedTarget || normalizedTarget.startsWith(normalizedCwd) || normalizedCwd.startsWith(normalizedTarget)) {
          return session.id;
        }
      }
    }
    return undefined;
  }
  public getSessionState(): {
    activeSessionId: string;
    sessions: SessionSummary[];
    splitSessionId?: string;
    snapshot: string;
    snapshotThroughSeq: number;
  } {
    const s = this.sessions.get(this.activeSessionId);
    const sessionsList = this.listSessions();
    const activeSummary = sessionsList.find(x => x.id === this.activeSessionId);
    return {
      activeSessionId: this.activeSessionId,
      sessions: sessionsList,
      splitSessionId: activeSummary?.splitSessionId,
      snapshot: activeSummary?.buffer || (s ? safeSliceTailJsonBounded(this.composeTranscript(s), ACTIVE_SNAPSHOT_BUDGET_BYTES) : ''),
      snapshotThroughSeq: s ? (s.lastSeq || 0) : 0,
    };
  }

  private emitSession(): void {
    this.emit('session', this.getSessionState());
  }

  public async dispose(): Promise<void> {
    if (this.isDisposed) return;
    // Allow a later canonical to be constructed after teardown (test isolation etc.):
    // each process still holds at most ONE live instance at any moment.
    TerminalManager.constructionCount = 0;
    if (this.deferredPtyTimer) {
      clearTimeout(this.deferredPtyTimer);
      this.deferredPtyTimer = null;
    }
    this.deferredPtyIds = [];
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.activePersistPromise) {
      try {
        await this.activePersistPromise;
      } catch {}
    }
    this.persistSync();
    this.isDisposed = true;
    this.removeAllListeners();
    const killPromises: Promise<void>[] = [];
    for (const [, s] of this.sessions.entries()) {
      killPromises.push(this.safelyKillSession(s));
    }
    await Promise.allSettled(killPromises);
    this.sessions.clear();
    this.sessionGenerations.clear();
    this.persistedFragments.clear();
    this.subscribers.clear();
    this.emitTimeMs.clear();
    this.dirtySessionIds.clear();
    TerminalManager.instance = undefined;
  }

  public async waitTerminal(input: TerminalWaitInput, signal?: AbortSignal): Promise<TerminalWaitResult> {
    if (!input.sessionId) {
      throw new CapabilityError('INVALID_ARGUMENT', 'sessionId is required for terminal wait');
    }
    // A sleeping session has no shell that could ever satisfy the condition, and
    // materializing one here would silently undo the nap (an MCP terminal.wait or
    // a HaravanSyncBarrier awaitSync must never cost a PTY). Refuse explicitly
    // instead of waiting for a timeout the caller cannot explain.
    const asleep = this.sessions.get(input.sessionId);
    if (asleep && !asleep.disposed && asleep.state === 'sleeping') {
      return {
        satisfied: false,
        sessionGeneration: asleep.sessionGeneration,
        lastSeq: asleep.lastSeq || 0,
      };
    }
    const s = this.ensureSessionPty(input.sessionId) || this.sessions.get(input.sessionId);
    if (!s) {
      throw new CapabilityError('INVALID_ARGUMENT', `Terminal session ${input.sessionId} not found`);
    }
    if (input.sessionGeneration !== undefined && input.sessionGeneration !== s.sessionGeneration) {
      throw new CapabilityError(
        'SESSION_STALE',
        `Terminal session generation mismatch: requested ${input.sessionGeneration}, active is ${s.sessionGeneration}`
      );
    }
    const validConditions = ['exit', 'output-match', 'silence'];
    if (!validConditions.includes(input.condition)) {
      throw new CapabilityError('INVALID_ARGUMENT', `Unsupported wait condition: ${input.condition}`);
    }

    // Fail-fast if session already terminated and condition is not exit
    if (s.state === 'exited' || s.state === 'closed') {
      if (input.condition === 'exit') {
        return {
          satisfied: true,
          sessionGeneration: s.sessionGeneration,
          lastSeq: s.lastSeq || 0,
          exitCode: s.exitCode,
        };
      }
      throw new CapabilityError('SESSION_CLOSED', 'Terminal session already terminated');
    }

    // Fast path for output-match when afterSeq is not specified or already reached
    if (input.condition === 'output-match') {
      if (!input.pattern) {
        throw new CapabilityError('INVALID_ARGUMENT', 'pattern is required for output-match condition');
      }
      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern);
      } catch (err) {
        throw new CapabilityError('INVALID_ARGUMENT', `Invalid regex pattern: ${(err as Error).message}`);
      }
      if (input.afterSeq === undefined && regex.test(safeSliceTail(s.buffer, WAIT_MATCH_WINDOW_BYTES))) {
        return {
          satisfied: true,
          sessionGeneration: s.sessionGeneration,
          lastSeq: s.lastSeq || 0,
          outputTail: safeSliceTail(s.buffer, 4096),
        };
      }
    }

    let regex: RegExp | undefined;
    if (input.condition === 'output-match') {
      if (!input.pattern) {
        throw new CapabilityError('INVALID_ARGUMENT', 'pattern is required for output-match condition');
      }
      try {
        regex = new RegExp(input.pattern);
      } catch (err) {
        throw new CapabilityError('INVALID_ARGUMENT', `Invalid regex pattern: ${(err as Error).message}`);
      }
    }

    return new Promise<TerminalWaitResult>((resolve, reject) => {
      let settled = false;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let silenceTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        settled = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (silenceTimer) {
          clearTimeout(silenceTimer);
          silenceTimer = null;
        }
        this.removeListener('data', onData);
        this.removeListener('exit', onExit);
        this.removeListener('close', onClose);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const onAbort = () => {
        if (settled) return;
        cleanup();
        reject(new CapabilityError('WAIT_ABORTED', 'Terminal wait was aborted'));
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const timeoutMs = input.timeoutMs ?? 30_000;
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new CapabilityError('WAIT_TIMEOUT', `Terminal wait timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeoutTimer.unref?.();

      let accumulatedAfterSeq = '';
      const onData = (evt: { sessionId: string; data: string; seq: number }) => {
        if (settled || evt.sessionId !== input.sessionId) return;
        if (input.afterSeq !== undefined && evt.seq <= input.afterSeq) return;

        if (input.condition === 'output-match' && regex) {
          if (input.afterSeq !== undefined) {
            accumulatedAfterSeq += evt.data;
            if (regex.test(evt.data) || regex.test(accumulatedAfterSeq)) {
              cleanup();
              resolve({
                satisfied: true,
                sessionGeneration: s.sessionGeneration,
                lastSeq: evt.seq,
                outputTail: safeSliceTail(s.buffer, 4096),
              });
              return;
            }
          } else {
            if (regex.test(evt.data) || regex.test(safeSliceTail(s.buffer, WAIT_MATCH_WINDOW_BYTES))) {
              cleanup();
              resolve({
                satisfied: true,
                sessionGeneration: s.sessionGeneration,
                lastSeq: evt.seq,
                outputTail: safeSliceTail(s.buffer, 4096),
              });
              return;
            }
          }
        }
        if (input.condition === 'silence') {
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            if (settled) return;
            cleanup();
            resolve({
              satisfied: true,
              sessionGeneration: s.sessionGeneration,
              lastSeq: s.lastSeq || 0,
            });
          }, input.silenceMs ?? 1000);
          silenceTimer.unref?.();
        }
      };

      const onExit = (evt: { sessionId: string; sessionGeneration: number; exitCode?: number }) => {
        if (settled || evt.sessionId !== input.sessionId) return;
        if (input.condition === 'exit') {
          cleanup();
          resolve({
            satisfied: true,
            sessionGeneration: s.sessionGeneration,
            lastSeq: s.lastSeq || 0,
            exitCode: evt.exitCode,
          });
        } else {
          cleanup();
          reject(new CapabilityError('SESSION_CLOSED', 'Terminal session exited before wait condition was satisfied'));
        }
      };

      const onClose = (evt: { sessionId: string; sessionGeneration: number }) => {
        if (settled || evt.sessionId !== input.sessionId) return;
        cleanup();
        reject(new CapabilityError('SESSION_CLOSED', 'Terminal session closed before wait condition was satisfied'));
      };

      this.on('data', onData);
      this.on('exit', onExit);
      this.on('close', onClose);

      if (input.condition === 'silence') {
        silenceTimer = setTimeout(() => {
          if (settled) return;
          cleanup();
          resolve({
            satisfied: true,
            sessionGeneration: s.sessionGeneration,
            lastSeq: s.lastSeq || 0,
          });
        }, input.silenceMs ?? 1000);
        silenceTimer.unref?.();
      }
    });
  }
}
