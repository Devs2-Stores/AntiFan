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
type Session = {
  id: string;
  name: string;
  cwd: string;
  pty: pty.IPty;
  buffer: string;
  splitOf?: string;
  capsuleId: string;
  disposed?: boolean;
  lastSeq: number;
  sessionGeneration: number;
  state: 'running' | 'exited' | 'closed';
  exitCode?: number;
  exitSignal?: number;
  exitedAt?: number;
  closedAt?: number;
  dataSubscription?: { dispose: () => void };
  exitSubscription?: { dispose: () => void };
};
type SavedSession = { id: string; name: string; cwd: string; buffer?: string; splitOf?: string; capsuleId?: string };
const MAX_TRANSCRIPT_BYTES = 512 * 1024; // 512KB in-memory history buffer (~5,000-10,000 lines)
const MAX_PERSISTED_BYTES = 256 * 1024; // 256KB per session on disk
const MIN_TERMINAL_ROWS = 8;
const MIN_SPLIT_TERMINAL_ROWS = 4;
const SPLIT_TERMINAL_FRACTION = 0.2;
const GLOBAL_JSON_BUFFER_BUDGET_BYTES = 40 * 1024; // 40 KiB total wire budget for all session buffers

export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  active: boolean;
  buffer: string;
  snapshotThroughSeq?: number;
  splitSessionId?: string;
  splitBuffer?: string;
  splitSnapshotThroughSeq?: number;
  bufferLength: number;
  sessionGeneration: number;
  state?: 'running' | 'exited' | 'closed';
  exitCode?: number;
  exitedAt?: number;
  closedAt?: number;
}
export interface TerminalManagerStats {
  sessionCount: number;
  runningPtyCount: number;
  transcriptBytes: number;
  dataSubscriptionCount: number;
  exitSubscriptionCount: number;
}

function safeSliceTail(str: string, maxBytes: number): string {
  if (!str || str.length <= maxBytes) return str || '';
  let raw = str.slice(-maxBytes);
  if (raw.length > 0 && raw.charCodeAt(0) >= 0xdc00 && raw.charCodeAt(0) <= 0xdfff) {
    raw = raw.slice(1);
  }
  if (raw.length > 0 && raw.charCodeAt(raw.length - 1) >= 0xd800 && raw.charCodeAt(raw.length - 1) <= 0xdbff) {
    raw = raw.slice(0, -1);
  }
  const firstNl = raw.indexOf('\n');
  if (firstNl !== -1 && firstNl < 2048) {
    let sliced = raw.slice(firstNl + 1);
    if (sliced.length > 0 && sliced.charCodeAt(0) >= 0xdc00 && sliced.charCodeAt(0) <= 0xdfff) {
      sliced = sliced.slice(1);
    }
    if (sliced.length > 0 && sliced.charCodeAt(sliced.length - 1) >= 0xd800 && sliced.charCodeAt(sliced.length - 1) <= 0xdbff) {
      sliced = sliced.slice(0, -1);
    }
    return sliced;
  }
  return raw;
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
  private static instance: TerminalManager;
  private sessions = new Map<string, Session>();
  private sessionGenerations = new Map<string, number>();
  private activeSessionId = '';
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
  private benchmarkChunkSeq = 0;
  private benchmarkChunkBytes = 0;

  constructor() {
    super();
    this.setMaxListeners(50);
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

  private readSavedSessions(): { activeSessionId?: string; sessions: SavedSession[] } {
    this.cleanOrphanedTempFiles();
    try {
      const value = JSON.parse(fs.readFileSync(this.statePath(), 'utf8'));
      if (Array.isArray(value)) return { sessions: value };
      if (value && Array.isArray(value.sessions)) return { activeSessionId: value.activeSessionId, sessions: value.sessions };
      return { sessions: [] };
    } catch {
      return { sessions: [] };
    }
  }

  private async persistAsync(): Promise<void> {
    if (this.isDisposed || this.sessions.size === 0) {
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
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const payload = {
          activeSessionId: this.activeSessionId,
          sessions: [...this.sessions.values()].map(s => ({
            id: s.id,
            name: s.name,
            cwd: s.cwd,
            buffer: safeSliceTail(s.buffer, MAX_PERSISTED_BYTES),
            splitOf: s.splitOf,
            capsuleId: s.capsuleId,
          })),
        };
        const serialized = JSON.stringify(payload, null, 2);
        await fs.promises.writeFile(tempPath, serialized, 'utf8');
        if (this.writeSequence === currentSeq) {
          try {
            await fs.promises.rename(tempPath, filePath);
          } catch {
            // Windows safe fallback: write directly to target file ONLY if sequence is still current
            if (this.writeSequence === currentSeq) {
              await fs.promises.writeFile(filePath, serialized, 'utf8');
            }
            await fs.promises.unlink(tempPath).catch(() => {});
          }
          if (this.writeSequence !== currentSeq) {
            this.persistSync();
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
    if (this.isDisposed || this.sessions.size === 0) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.hasPendingPersist = false;
    this.activePersistPromise = null;
    const currentSeq = ++this.writeSequence;
    const filePath = this.statePath();
    const tempPath = `${filePath}.tmp-sync-${currentSeq}-${Date.now()}`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = {
        activeSessionId: this.activeSessionId,
        sessions: [...this.sessions.values()].map(s => ({
          id: s.id,
          name: s.name,
          cwd: s.cwd,
          buffer: safeSliceTail(s.buffer, MAX_PERSISTED_BYTES),
          splitOf: s.splitOf,
          capsuleId: s.capsuleId,
        })),
      };
      const serialized = JSON.stringify(payload, null, 2);
      try {
        fs.writeFileSync(tempPath, serialized, 'utf8');
        fs.renameSync(tempPath, filePath);
      } catch {
        // Windows safe fallback: write directly to target file if rename throws (locked / AV / EPERM)
        fs.writeFileSync(filePath, serialized, 'utf8');
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

  private schedulePersist(): void {
    if (this.isDisposed) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistAsync();
    }, 2000);
    this.persistTimer.unref?.();
  }

  public static getInstance(): TerminalManager { return this.instance ??= new TerminalManager(); }
  public setCwd(cwd: string): void { this.currentCwd = cwd; }
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
        // No live sessions at all: restore from saved sessions or spawn fresh
        const { activeSessionId: savedActiveId, sessions: saved } = this.readSavedSessions();
        const baseSessions = saved.filter(item => !item.splitOf);
        if (baseSessions.length > 0) {
          for (const item of baseSessions) {
            const s = this.spawn(item.id, item.cwd || this.currentCwd, '');
            s.name = item.name || s.name;
            s.capsuleId = item.capsuleId || this.currentCapsuleId;
          }
          const splitSessions = saved.filter(item => item.splitOf && this.sessions.has(item.splitOf));
          for (const item of splitSessions) {
            const parent = item.splitOf ? this.sessions.get(item.splitOf) : undefined;
            const parentRows = parent?.pty?.rows;
            const initialRows = this.getInitialSplitRows(parentRows || this.lastRows);
            const s = this.spawn(item.id, item.cwd || this.currentCwd, '', undefined, initialRows, MIN_SPLIT_TERMINAL_ROWS, item.splitOf, parent?.sessionGeneration);
            s.name = item.name || s.name;
            s.splitOf = item.splitOf;
            s.capsuleId = item.capsuleId || this.currentCapsuleId;
          }
          const matchingRestored = [...this.sessions.values()].find(s => !s.splitOf && s.capsuleId === this.currentCapsuleId);
          if (matchingRestored) {
            this.activeSessionId = matchingRestored.id;
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

  private spawn(id: string, cwd: string, restoredBuffer = '', initialCols?: number, initialRows?: number, minimumRows = MIN_TERMINAL_ROWS, parentSessionId?: string, parentGeneration?: number): Session {
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
    const generation = (this.sessionGenerations.get(id) || 0) + 1;
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
      ANTIFAN_TERMINAL_SESSION_ID: id,
      ANTIFAN_TERMINAL_GENERATION: String(generation),
      ANTIFAN_TERMINAL_AFFINITY_SESSION_ID: affinitySessionId,
      ANTIFAN_TERMINAL_AFFINITY_GENERATION: affinityGeneration,
      ...(parentSessionId ? { ANTIFAN_TERMINAL_PARENT_SESSION_ID: parentSessionId } : {}),
    };
    const ptyOptions: pty.IPtyForkOptions = {
      cwd: validCwd,
      cols,
      rows,
      env: terminalEnv,
      ...(process.platform === 'win32' ? { useConpty: false } : {}),
    };
    try {
      child = pty.spawn(shell, [], ptyOptions);
    } catch {
      child = pty.spawn(shell, [], { ...ptyOptions, cwd: os.homedir() });
    }
    const s: Session = {
      id,
      name: `Terminal ${id.replace('terminal-', '')}`,
      cwd: validCwd,
      pty: child,
      buffer: safeSliceTail(restoredBuffer, MAX_TRANSCRIPT_BYTES),
      capsuleId: this.currentCapsuleId,
      disposed: false,
      lastSeq: 0,
      sessionGeneration: generation,
      state: 'running',
    };
    const dataSub = child.onData(data => {
      if (s.disposed) return;
      if (isBenchmarkEnabled()) {
        this.benchmarkChunkSeq += 1;
        this.benchmarkChunkBytes += Buffer.byteLength(data, 'utf8');
        recordBenchmark({ surface: 'terminal', name: 'ptyData', value: Buffer.byteLength(data, 'utf8'), extra: { sessionId: id, chunkSeq: this.benchmarkChunkSeq, totalBytes: this.benchmarkChunkBytes } });
      }
      this.appendData(s, data);
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

  private appendData(s: Session, data: string): void {
    if (s.disposed) return;
    s.lastSeq = (s.lastSeq || 0) + 1;
    s.buffer += data;
    if (s.buffer.length > MAX_TRANSCRIPT_BYTES + 65536) {
      s.buffer = safeSliceTail(s.buffer, MAX_TRANSCRIPT_BYTES);
    }
    this.schedulePersist();
    this.emit('data', { sessionId: s.id, data, seq: s.lastSeq });
  }

  public startTerminal(cwd?: string): boolean {
    this.isDisposed = false;
    if (cwd) this.currentCwd = cwd;
    const sessions = this.listSessions();
    if (!sessions.length) {
      const { activeSessionId: savedActiveId, sessions: saved } = this.readSavedSessions();
      const baseSessions = saved.filter(item => !item.splitOf);
      if (baseSessions.length > 0) {
        for (const item of baseSessions) {
          const s = this.spawn(item.id, item.cwd || this.currentCwd, '');
          s.name = item.name || s.name;
          s.capsuleId = item.capsuleId || this.currentCapsuleId;
        }
        const splitSessions = saved.filter(item => item.splitOf && this.sessions.has(item.splitOf));
        for (const item of splitSessions) {
          const parent = item.splitOf ? this.sessions.get(item.splitOf) : undefined;
          const parentRows = parent?.pty?.rows;
          const initialRows = this.getInitialSplitRows(parentRows || this.lastRows);
          const s = this.spawn(item.id, item.cwd || this.currentCwd, '', undefined, initialRows, MIN_SPLIT_TERMINAL_ROWS, item.splitOf, parent?.sessionGeneration);
          s.name = item.name || s.name;
          s.splitOf = item.splitOf;
          s.capsuleId = item.capsuleId || this.currentCapsuleId;
        }
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
    this.sessions.get(this.activeSessionId)?.pty.write(input);
  }

  public writeTo(id: string, input: string): void {
    this.sessions.get(id)?.pty.write(input);
  }
  public resize(cols: number, rows: number): void {
    const validCols = Math.max(40, cols);
    const validRows = Math.max(MIN_TERMINAL_ROWS, rows);
    if (validCols >= 60 && validRows >= 15) {
      this.lastCols = validCols;
      this.lastRows = validRows;
    }
    for (const s of this.sessions.values()) {
      if (!s.disposed) {
        try {
          s.pty.resize(validCols, validRows);
        } catch {}
      }
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
      try { target.pty.resize(validCols, validRows); } catch {}
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
    if (s.dataSubscription) {
      try { s.dataSubscription.dispose(); } catch {}
      s.dataSubscription = undefined;
    }
    if (s.exitSubscription) {
      try { s.exitSubscription.dispose(); } catch {}
      s.exitSubscription = undefined;
    }
    const ptyInstance = s.pty;
    const pid = ptyInstance?.pid;
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
  public async kill(): Promise<void> {
    const s = this.sessions.get(this.activeSessionId);
    if (s) {
      const split = [...this.sessions.values()].find(x => x.splitOf === s.id);
      if (split) {
        await this.safelyKillSession(split);
        this.sessions.delete(split.id);
        this.emit('session-closed', { id: split.id, generation: split.sessionGeneration });
      }
      await this.safelyKillSession(s);
      this.sessions.delete(s.id);
      this.emit('session-closed', { id: s.id, generation: s.sessionGeneration });
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
    const parent = this.sessions.get(parentId);
    if (!parent || parent.disposed || parent.splitOf) return '';
    const existing = [...this.sessions.values()].find(x => x.splitOf === parentId);
    if (existing) return existing.id;
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
    this.emit('session-closed', { id: split.id, generation: split.sessionGeneration });
    this.persist();
    this.emitSession();
    return true;
  }

  public listSessions(paged = true): SessionSummary[] {
    const baseSessions = [...this.sessions.values()].filter(s => !s.splitOf);
    if (!paged || baseSessions.length === 0) {
      return baseSessions.map(s => {
        const split = [...this.sessions.values()].find(x => x.splitOf === s.id);
        return {
          id: s.id,
          name: s.name,
          cwd: s.cwd,
          active: s.id === this.activeSessionId,
          buffer: s.buffer,
          snapshotThroughSeq: s.lastSeq || 0,
          splitSessionId: split?.id,
          splitBuffer: split?.buffer || '',
          splitSnapshotThroughSeq: split ? (split.lastSeq || 0) : 0,
          bufferLength: Buffer.byteLength(s.buffer, 'utf8'),
          sessionGeneration: s.sessionGeneration,
          state: s.state,
          exitCode: s.exitCode,
          exitedAt: s.exitedAt,
          closedAt: s.closedAt,
        };
      });
    }
    let totalPanes = 0;
    for (const s of baseSessions) {
      totalPanes += 1;
      if ([...this.sessions.values()].some(x => x.splitOf === s.id)) totalPanes += 1;
    }

    const activeBudget = Math.floor(GLOBAL_JSON_BUFFER_BUDGET_BYTES * 0.4);
    const bgBudget = totalPanes > 1
      ? Math.floor((GLOBAL_JSON_BUFFER_BUDGET_BYTES * 0.6) / (totalPanes - 1))
      : activeBudget;

    return baseSessions.map(s => {
      const isActive = s.id === this.activeSessionId;
      const split = [...this.sessions.values()].find(x => x.splitOf === s.id);
      const baseSlotBudget = isActive ? activeBudget : bgBudget;
      const splitSlotBudget = bgBudget;

      const buffer = safeSliceTailJsonBounded(s.buffer, baseSlotBudget);
      const splitBuffer = split ? safeSliceTailJsonBounded(split.buffer, splitSlotBudget) : '';

      return {
        id: s.id,
        name: s.name,
        cwd: s.cwd,
        active: isActive,
        buffer,
        snapshotThroughSeq: s.lastSeq || 0,
        splitSessionId: split?.id,
        splitBuffer,
        splitSnapshotThroughSeq: split ? (split.lastSeq || 0) : 0,
        bufferLength: Buffer.byteLength(s.buffer, 'utf8'),
        sessionGeneration: s.sessionGeneration,
        state: s.state,
        exitCode: s.exitCode,
        exitedAt: s.exitedAt,
        closedAt: s.closedAt,
      };
    });
  }

  public getStats(): TerminalManagerStats {
    let runningPtyCount = 0;
    let transcriptBytes = 0;
    let dataSubscriptionCount = 0;
    let exitSubscriptionCount = 0;
    for (const session of this.sessions.values()) {
      if (session.state === 'running' && !session.disposed) runningPtyCount++;
      transcriptBytes += Buffer.byteLength(session.buffer, 'utf8');
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
      buffer: s ? s.buffer : '',
      snapshotThroughSeq: s ? (s.lastSeq || 0) : 0,
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
    const split = [...this.sessions.values()].find(x => x.splitOf === id);
    if (split) {
      await this.safelyKillSession(split);
      this.sessions.delete(split.id);
      this.emit('session-closed', { id: split.id, generation: split.sessionGeneration });
    }
    await this.safelyKillSession(s);
    this.sessions.delete(id);
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
  public getSession(id: string) {
    return this.sessions.get(id);
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
      snapshot: activeSummary?.buffer || (s?.buffer ? safeSliceTailJsonBounded(s.buffer, 16 * 1024) : ''),
      snapshotThroughSeq: s ? (s.lastSeq || 0) : 0,
    };
  }

  private emitSession(): void {
    this.emit('session', this.getSessionState());
  }

  public async dispose(): Promise<void> {
    if (this.isDisposed) return;
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
  }

  public async waitTerminal(input: TerminalWaitInput, signal?: AbortSignal): Promise<TerminalWaitResult> {
    if (!input.sessionId) {
      throw new CapabilityError('INVALID_ARGUMENT', 'sessionId is required for terminal wait');
    }
    const s = this.sessions.get(input.sessionId);
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
      if (input.afterSeq === undefined && regex.test(s.buffer)) {
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
            if (regex.test(evt.data) || regex.test(s.buffer)) {
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
