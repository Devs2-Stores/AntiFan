import * as pty from 'node-pty';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'events';
import { performance } from 'node:perf_hooks';
import { isBenchmarkEnabled, recordBenchmark } from '../benchmark/telemetry';
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
        const child = execFile(
          'taskkill',
          ['/pid', String(Math.floor(pid)), '/T', '/F'],
          { windowsHide: true, timeout: 1500 },
          () => settle()
        );
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
type Session = { id: string; name: string; cwd: string; pty: pty.IPty; buffer: string; splitOf?: string; capsuleId: string; disposed?: boolean; lastSeq?: number };
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
}

function safeSliceTail(str: string, maxBytes: number): string {
  if (!str || str.length <= maxBytes) return str || '';
  const raw = str.slice(-maxBytes);
  const firstNl = raw.indexOf('\n');
  if (firstNl !== -1 && firstNl < 2048) {
    return raw.slice(firstNl + 1);
  }
  return raw;
}

export function safeSliceTailJsonBounded(str: string, maxJsonBytes: number): string {
  if (!str || maxJsonBytes < 2) return '';
  const resetPrefix = '\x1b[0m';
  if (maxJsonBytes < Buffer.byteLength(JSON.stringify(resetPrefix), 'utf8')) {
    return '';
  }

  const codePoints = Array.from(str);
  let low = 0;
  let high = codePoints.length;
  let bestFit = '';

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (mid >= codePoints.length) {
      break;
    }
    const rawSlice = codePoints.slice(mid).join('');
    const firstNl = rawSlice.indexOf('\n');
    const candidate = firstNl >= 0 && firstNl < rawSlice.length - 1
      ? `${resetPrefix}${rawSlice.slice(firstNl + 1)}`
      : `${resetPrefix}${rawSlice}`;

    const jsonCost = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    if (jsonCost <= maxJsonBytes) {
      bestFit = candidate;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  if (Buffer.byteLength(JSON.stringify(bestFit), 'utf8') > maxJsonBytes) {
    return '';
  }
  return bestFit;
}
export class TerminalManager extends EventEmitter {
  private static instance: TerminalManager;
  private sessions = new Map<string, Session>();
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
  private getInitialSplitRows(parentRows = this.lastRows): number {
    return Math.max(MIN_SPLIT_TERMINAL_ROWS, Math.floor((parentRows || 30) * SPLIT_TERMINAL_FRACTION));
  }

  private statePath(): string {
    const dir = process.env.ANTIFAN_CONFIG_DIR || path.join(os.homedir(), '.antifan');
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
            const parentRows = item.splitOf ? this.sessions.get(item.splitOf)?.pty?.rows : undefined;
            const initialRows = this.getInitialSplitRows(parentRows || this.lastRows);
            const s = this.spawn(item.id, item.cwd || this.currentCwd, '', undefined, initialRows, MIN_SPLIT_TERMINAL_ROWS);
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

  private spawn(id: string, cwd: string, restoredBuffer = '', initialCols?: number, initialRows?: number, minimumRows = MIN_TERMINAL_ROWS): Session {
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
    const terminalEnv = {
      ...process.env,
      PATH: envPath,
      TERM: 'xterm-256color',
      FORCE_COLOR: '1',
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
    };
    this.sessions.set(id, s);
    child.onData(data => {
      if (s.disposed) return;
      if (isBenchmarkEnabled()) {
        this.benchmarkChunkSeq += 1;
        this.benchmarkChunkBytes += Buffer.byteLength(data, 'utf8');
        recordBenchmark({ surface: 'terminal', name: 'ptyData', value: Buffer.byteLength(data, 'utf8'), extra: { sessionId: id, chunkSeq: this.benchmarkChunkSeq, totalBytes: this.benchmarkChunkBytes } });
      }
      this.appendData(s, data);
    });
    child.onExit(({ exitCode }) => {
      if (s.disposed) return;
      recordBenchmark({ surface: 'terminal', name: 'exit', extra: { sessionId: id, exitCode } });
      const data = `\r\n[Process exited with code ${exitCode}]\r\n`;
      this.appendData(s, data);
    });
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
          const parentRows = item.splitOf ? this.sessions.get(item.splitOf)?.pty?.rows : undefined;
          const initialRows = this.getInitialSplitRows(parentRows || this.lastRows);
          const s = this.spawn(item.id, item.cwd || this.currentCwd, '', undefined, initialRows, MIN_SPLIT_TERMINAL_ROWS);
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
    const ptyInstance = s.pty;
    const pid = ptyInstance?.pid;
    if (ptyInstance) {
      try {
        ptyInstance.kill();
      } catch {}
    }
    if (pid && typeof pid === 'number' && pid > 0) {
      await killProcessTree(pid);
    }
  }
  public async kill(): Promise<void> {
    const s = this.sessions.get(this.activeSessionId);
    if (s) {
      await this.safelyKillSession(s);
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
    }
    const targetSession = this.sessions.get(id);
    if (targetSession) {
      await this.safelyKillSession(targetSession);
      this.sessions.delete(id);
    }
    this.spawn(id, cwd || this.currentCwd);
    this.persist();
    this.emitSession();
  }

  public createSession(cwd?: string): string {
    this.isDisposed = false;
    const id = this.nextTerminalId();
    this.activeSessionId = id;
    this.spawn(id, cwd || this.currentCwd);
    this.persist();
    this.emitSession();
    return id;
  }

  public createSplitSession(parentId: string, cwd?: string, initialCols?: number, initialRows?: number): string {
    const parent = this.sessions.get(parentId);
    if (!parent || parent.splitOf) return '';
    const existing = [...this.sessions.values()].find(x => x.splitOf === parentId);
    if (existing) return existing.id;
    let n = 1;
    while (this.sessions.has(`split-${n}`)) n++;
    const id = `split-${n}`;
    const targetCols = Math.max(40, initialCols || this.lastCols || 120);
    const targetRows = Math.max(MIN_SPLIT_TERMINAL_ROWS, initialRows || this.getInitialSplitRows(parent.pty?.rows));
    const splitSession = this.spawn(id, cwd || parent.cwd, '', targetCols, targetRows, MIN_SPLIT_TERMINAL_ROWS);
    splitSession.splitOf = parentId;
    splitSession.capsuleId = parent.capsuleId || this.currentCapsuleId;
    this.persist();
    this.emitSession();
    return id;
  }

  public async closeSplitSession(parentId: string): Promise<boolean> {
    const split = [...this.sessions.values()].find(x => x.splitOf === parentId);
    if (!split) return false;
    await this.safelyKillSession(split);
    this.sessions.delete(split.id);
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
      };
    });
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
    }
    await this.safelyKillSession(s);
    this.sessions.delete(id);
    if (this.activeSessionId === id) {
      this.activeSessionId = this.listSessions()[0]?.id || '';
    }
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
    this.sessions.clear();
    await Promise.all(killPromises);
  }
}
