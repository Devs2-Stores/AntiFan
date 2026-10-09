import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type RunCardLifecycle,
  type RunCardMode,
  type RunCardState,
  type CapsuleBrief,
} from '../../shared/contracts.js';
import { isPidAlive } from '../bridge/bridge-health.js';

export const RUN_STALE_MS = 45_000;
export const RUN_SWEEP_MS = 5_000;
export const RUN_PRUNE_ENDED_MS = 24 * 60 * 60 * 1000; // 24 hours
export const RUN_CONTROL_EXPIRED_MARGIN_MS = 60 * 60 * 1000; // 1 hour
export const RUN_CHANGES_MAX_FILES = 24;
// A failed removal of an orphaned control dir is retried at most this often.
export const RUN_CONTROL_PRUNE_RETRY_MS = 60_000;

type RunChanges = { files: string[]; fileCount: number; blockedCount: number };

export interface TerminalRunStateFile {
  schema: 1;
  terminalSessionId: string;
  ompSessionId: string;
  pid: number;
  cwd: string;
  mode: RunCardMode;
  state: RunCardLifecycle;
  runSeq: number;
  runStartedAt?: number;
  lastEventAt: number;
  lastTool?: string;
  promptHead?: string;
  updatedAt: number;
}

export interface BriefMirrorFile {
  schema: 1;
  capsuleId: string;
  briefSeq: number;
  brief: CapsuleBrief | null;
  updatedAt: number;
}

export interface RunStateSessionInfo {
  id: string;
  owner?: string;
  ownerKey?: string;
  windowId?: string;
  capsuleId?: string;
}

export interface RunStateAttachmentInfo {
  runId: string;
  attemptId?: string;
  backendId: string;
}

export interface RunStateCapsuleBriefInfo {
  brief?: CapsuleBrief | null;
  updatedAt: number;
}

export interface RunStateServiceOptions {
  runsDir: string;
  lookupSession?: (terminalSessionId: string) => RunStateSessionInfo | undefined;
  listSessions?: () => RunStateSessionInfo[];
  lookupCapsule?: (terminalSessionId: string) => string | undefined;
  lookupCapsuleBrief?: (capsuleId: string) => RunStateCapsuleBriefInfo | undefined;
  lookupAttachment?: (terminalSessionId: string) => RunStateAttachmentInfo | undefined;
  isProcessAlive?: (pid: number) => boolean;
  clock?: () => number;
  sweepMs?: number;
  staleMs?: number;
  watch?: boolean;
  isManagerSender?: (senderId?: string | number) => boolean;
  isSessionVisibleToWindow?: (sessionId: string, senderId?: string | number) => boolean;
}

export function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
}

interface RunLivenessInputs {
  stamp: string;
  /** Mirrors getRunsSync's projection filter; an invalid file projects no card. */
  valid: boolean;
  ended: boolean;
  pid: number;
  updatedAt: number;
}

function readRunLivenessInputs(filePath: string, stamp: string): RunLivenessInputs {
  const invalid: RunLivenessInputs = { stamp, valid: false, ended: false, pid: 0, updatedAt: 0 };
  let data: Partial<TerminalRunStateFile>;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return invalid;
  }
  if (!data || typeof data !== 'object' || data.schema !== 1 || !data.terminalSessionId) return invalid;
  return {
    stamp,
    valid: true,
    ended: data.state === 'ended',
    pid: typeof data.pid === 'number' ? data.pid : 0,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
  };
}

export class RunStateService extends EventEmitter {
  private readonly runsDir: string;
  private readonly options: RunStateServiceOptions;
  private readonly isProcessAliveFn: (pid: number) => boolean;
  private readonly clock: () => number;
  private readonly sweepMs: number;
  private readonly staleMs: number;
  private started = false;
  private watcher?: fs.FSWatcher;
  private sweepTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  // Fingerprint (name + mtime + size) of the run files 'change' last announced.
  // A sweep that observes the same set the last emit did has nothing new for
  // listeners: their only read, getRunsSync, projects exactly these files.
  private lastEmittedRunFingerprint: string | null = null;
  // Parsed liveness inputs per run file, reused while the file's mtime:size stamp
  // holds, so each sweep re-derives staleness without re-reading unchanged files.
  private readonly runLivenessInputs = new Map<string, RunLivenessInputs>();
  // Orphaned control dirs whose removal failed, skipped until the stored time:
  // a synchronous retry blocks the main thread (~100 ms each on Windows).
  private readonly controlPruneRetryAt = new Map<string, number>();
  // Resolved cwd → workspace root. Only hits are cached: edit-guard creates
  // <root>/.antifan lazily, so a miss can turn into a hit mid-run.
  private readonly workspaceRootCache = new Map<string, string>();
  // Parsed edit-guard change summary per (cwd, ompSessionId), reused while the
  // log's mtime:size stamp and the requested runSeq hold.
  private readonly changesCache = new Map<string, { stamp: string; runSeq: number; result: RunChanges }>();

  constructor(options: RunStateServiceOptions) {
    super();
    this.options = options;
    this.runsDir = path.resolve(options.runsDir);
    this.isProcessAliveFn = options.isProcessAlive ?? isPidAlive;
    this.clock = options.clock ?? (() => Date.now());
    this.sweepMs = options.sweepMs ?? RUN_SWEEP_MS;
    this.staleMs = options.staleMs ?? RUN_STALE_MS;

    try {
      if (!fs.existsSync(this.runsDir)) {
        fs.mkdirSync(this.runsDir, { recursive: true });
      }
    } catch {}
  }

  public start(): void {
    if (this.started) return;
    this.started = true;

    if (this.options.watch !== false) {
      try {
        this.watcher = fs.watch(this.runsDir, () => {
          this.scheduleDebouncedEmit();
        });
        if (typeof this.watcher.unref === 'function') {
          this.watcher.unref();
        }
      } catch {
        // Watch fallback covered by periodic sweep
      }
    }

    this.sweepTimer = setInterval(() => {
      try {
        this.sweepSync();
      } catch {}
    }, this.sweepMs);

    if (typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
  }

  public stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {}
      this.watcher = undefined;
    }

    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  public dispose(): void {
    this.stop();
  }

  private scheduleDebouncedEmit(): void {
    // Coalesce a burst of watch events (each atomic run-file write raises
    // several) into one projection once the burst settles.
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.emitIfChanged(false);
    }, 100);
    if (typeof this.debounceTimer.unref === 'function') {
      this.debounceTimer.unref();
    }
  }

  public sweepSync(): void {
    // Emit only on an observable change: prune deleted something, or the set
    // of run files the card projection reads changed since the last emit.
    this.emitIfChanged(this.pruneSync());
  }

  /**
   * Announce the run-card projection when it may have changed. The projection
   * rides on the event so every listener shares one getRunsSync pass.
   */
  private emitIfChanged(force: boolean): void {
    // Snapshot BEFORE emitting: a file landing mid-emit must not be folded
    // into the baseline without having been announced.
    const fingerprint = this.collectRunFileFingerprint();
    if (!force && fingerprint === this.lastEmittedRunFingerprint) return;
    this.emit('change', this.getRunsSync());
    this.lastEmittedRunFingerprint = fingerprint;
  }

  /**
   * name:mtimeMs:size plus the derived liveness of every run file (*.json minus
   * *.brief.json and the control subtree) — exactly the inputs getRunsSync reads.
   * A non-ended run turns stale when its pid dies or its heartbeat ages past
   * staleMs, with no file change, so that verdict is part of the fingerprint:
   * a hard-killed run still flips its card. Null when the runs dir is absent,
   * so a dir appearing/disappearing registers as a change.
   */
  private collectRunFileFingerprint(): string | null {
    if (!fs.existsSync(this.runsDir)) return null;
    let entries: string[];
    try {
      entries = fs.readdirSync(this.runsDir);
    } catch {
      // A transient read failure proves nothing changed; keep the baseline.
      return this.lastEmittedRunFingerprint;
    }
    const now = this.clock();
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.endsWith('.brief.json')) continue;
      const filePath = path.join(this.runsDir, entry);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(filePath);
      } catch {}
      if (!stat || !stat.isFile()) {
        parts.push(`${entry}!`);
        continue;
      }
      seen.add(entry);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      let inputs = this.runLivenessInputs.get(entry);
      if (!inputs || inputs.stamp !== stamp) {
        inputs = readRunLivenessInputs(filePath, stamp);
        this.runLivenessInputs.set(entry, inputs);
      }
      const verdict = !inputs.valid
        ? 'x'
        : inputs.ended
          ? 'e'
          : (inputs.pid > 0 && this.isProcessAliveFn(inputs.pid) && (now - inputs.updatedAt) <= this.staleMs ? 'l' : 's');
      parts.push(`${entry}:${stamp}:${verdict}`);
    }
    for (const name of this.runLivenessInputs.keys()) {
      if (!seen.has(name)) this.runLivenessInputs.delete(name);
    }
    parts.sort();
    return parts.join('|');
  }

  public async sweep(): Promise<void> {
    this.sweepSync();
  }

  /**
   * Project run-cards from runtime/runs/*.json while carving out *.brief.json.
   */
  public getRunsSync(): RunCardState[] {
    const cards: RunCardState[] = [];
    if (!fs.existsSync(this.runsDir)) return cards;

    let entries: string[];
    try {
      entries = fs.readdirSync(this.runsDir);
    } catch {
      return cards;
    }

    const now = this.clock();
    const liveChangeKeys = new Set<string>();

    for (const entry of entries) {
      // Carve out *.brief.json and non-json entries
      if (!entry.endsWith('.json') || entry.endsWith('.brief.json')) {
        continue;
      }

      const filePath = path.join(this.runsDir, entry);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      let data: Partial<TerminalRunStateFile>;
      try {
        data = JSON.parse(content);
      } catch {
        // Malformed JSON treated as absent by projection
        continue;
      }

      if (!data || typeof data !== 'object' || data.schema !== 1 || !data.terminalSessionId) {
        continue;
      }

      const terminalSessionId = String(data.terminalSessionId);
      const ompSessionId = typeof data.ompSessionId === 'string' && data.ompSessionId ? data.ompSessionId : undefined;
      const pid = typeof data.pid === 'number' ? data.pid : 0;
      const rawState = (typeof data.state === 'string' ? data.state : 'idle') as RunCardLifecycle;
      const mode = (typeof data.mode === 'string' ? data.mode : 'unset') as RunCardMode;
      const runSeq = typeof data.runSeq === 'number' ? data.runSeq : 0;
      const runStartedAt = typeof data.runStartedAt === 'number' ? data.runStartedAt : undefined;
      const lastEventAt = typeof data.lastEventAt === 'number' ? data.lastEventAt : undefined;
      const lastTool = typeof data.lastTool === 'string' ? data.lastTool : undefined;
      const promptHead = typeof data.promptHead === 'string' ? data.promptHead : undefined;
      const cwd = typeof data.cwd === 'string' ? data.cwd : undefined;
      const updatedAt = typeof data.updatedAt === 'number' ? data.updatedAt : 0;

      // Stale rule: state !== 'ended' AND (!isProcessAlive(pid) OR updatedAt older than RUN_STALE_MS)
      let state = rawState;
      let stale = false;

      if (rawState !== 'ended') {
        const isAlive = pid > 0 && this.isProcessAliveFn(pid);
        const isHeartbeatStale = (now - updatedAt) > this.staleMs;
        if (!isAlive || isHeartbeatStale) {
          state = 'ended';
          stale = true;
        }
      }

      const session = this.options.lookupSession?.(terminalSessionId);
      const capsuleId = this.options.lookupCapsule?.(terminalSessionId) ?? session?.capsuleId;

      const isAgentOwned = Boolean(session?.owner?.startsWith('agent:') || session?.ownerKey?.startsWith('agent:'));
      const viewOnly = isAgentOwned;

      let controlPlane: RunCardState['controlPlane'] = undefined;
      const attachment = this.options.lookupAttachment?.(terminalSessionId);
      if (attachment) {
        controlPlane = {
          runId: attachment.runId,
          attemptId: attachment.attemptId,
          backendId: attachment.backendId,
        };
      }

      let changes: RunCardState['changes'] = undefined;
      if (ompSessionId && typeof runSeq === 'number') {
        changes = this.readChanges(cwd, ompSessionId, runSeq, liveChangeKeys);
      }

      cards.push({
        terminalSessionId,
        ompSessionId,
        state,
        stale,
        mode,
        runSeq,
        runStartedAt,
        lastEventAt,
        lastTool,
        promptHead,
        cwd,
        capsuleId,
        viewOnly,
        controlPlane,
        changes,
      });
    }

    for (const key of this.changesCache.keys()) {
      if (!liveChangeKeys.has(key)) this.changesCache.delete(key);
    }
    return cards;
  }

  public async getRuns(): Promise<RunCardState[]> {
    return this.getRunsSync();
  }

  /**
   * Filter and map run-cards for a receiving window.
   */
  public runCardsForWindow(runs: RunCardState[], senderId?: string | number): RunCardState[] {
    const isManager = this.options.isManagerSender
      ? this.options.isManagerSender(senderId)
      : (senderId === 'manager' || senderId === undefined);

    return runs
      .filter((card) => {
        if (this.options.isSessionVisibleToWindow) {
          return this.options.isSessionVisibleToWindow(card.terminalSessionId, senderId);
        }
        return true;
      })
      .map((card) => {
        const session = this.options.lookupSession?.(card.terminalSessionId);
        const isAgentOwned = Boolean(session?.owner?.startsWith('agent:') || session?.ownerKey?.startsWith('agent:'));
        const viewOnly = isManager ? isAgentOwned : false;
        if (card.viewOnly === viewOnly) return card;
        return { ...card, viewOnly };
      });
  }

  /**
   * Component 5's main half: read <workspaceRoot>/.antifan/edit-guard/<ompSessionId>.jsonl
   */
  public readChanges(
    cwd?: string,
    ompSessionId?: string,
    runSeq?: number,
    liveKeys?: Set<string>,
  ): RunChanges | undefined {
    if (!cwd || !ompSessionId || typeof runSeq !== 'number') return undefined;

    const workspaceRoot = this.findWorkspaceRoot(cwd);
    if (!workspaceRoot) return undefined;

    const guardDir = path.join(workspaceRoot, '.antifan', 'edit-guard');
    let logPath = path.join(guardDir, `${safeFileSegment(ompSessionId)}.jsonl`);

    try {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(logPath);
      } catch {
        logPath = path.join(guardDir, `${ompSessionId}.jsonl`);
        stat = fs.statSync(logPath);
      }

      // The log is append-only and grows for the whole session; re-parse it
      // only when it changed, not on every projection.
      const key = `${cwd}\0${ompSessionId}`;
      liveKeys?.add(key);
      const stamp = `${logPath}:${stat.mtimeMs}:${stat.size}`;
      const cached = this.changesCache.get(key);
      if (cached && cached.stamp === stamp && cached.runSeq === runSeq) return cached.result;

      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split(/\r?\n/);
      const allowedFiles = new Set<string>();
      let blockedCount = 0;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (!row || typeof row !== 'object') continue;
          if (row.runSeq !== runSeq) continue;

          if (row.decision === 'allow') {
            if (typeof row.path === 'string' && row.path.length > 0) {
              allowedFiles.add(row.path);
            }
          } else {
            blockedCount++;
          }
        } catch {
          // Torn lines tolerated
        }
      }

      const uniqueFiles = Array.from(allowedFiles);
      const result: RunChanges = {
        files: uniqueFiles.slice(0, RUN_CHANGES_MAX_FILES),
        fileCount: uniqueFiles.length,
        blockedCount,
      };
      this.changesCache.set(key, { stamp, runSeq, result });
      return result;
    } catch {
      return undefined;
    }
  }

  private findWorkspaceRoot(cwd: string): string | null {
    const resolved = path.resolve(cwd);
    const cachedRoot = this.workspaceRootCache.get(resolved);
    if (cachedRoot !== undefined) return cachedRoot;
    try {
      let current = resolved;
      while (true) {
        const candidate = path.join(current, '.antifan');
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            this.workspaceRootCache.set(resolved, current);
            return current;
          }
        } catch {}

        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch {}
    return null;
  }

  /**
   * Prune rule implementation:
   * - Run file removed when terminal session no longer exists, or when state:'ended' for > 24 h.
   * - Expired control requests and acks older than request's expiresAt + 1 h are swept.
   * - Orphaned control/<ompSessionId> dirs vanish with their run file.
   * - A brief mirror is pruned ONLY with the run file of the session its own filename names.
   */
  public pruneSync(): boolean {
    let changed = false;
    if (!fs.existsSync(this.runsDir)) return changed;
    let entries: string[];
    try {
      entries = fs.readdirSync(this.runsDir);
    } catch {
      return changed;
    }

    const now = this.clock();
    const activeOmpSessions = new Set<string>();

    for (const file of entries) {
      if (!file.endsWith('.json') || file.endsWith('.brief.json')) {
        continue;
      }

      const filePath = path.join(this.runsDir, file);
      const sidFromFilename = file.slice(0, -5);

      let data: Partial<TerminalRunStateFile> | null = null;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        // Malformed run file
      }

      const sid = data?.terminalSessionId || sidFromFilename;
      const session = this.options.lookupSession?.(sid);

      let shouldPrune = false;

      if (!session) {
        // Session no longer exists
        shouldPrune = true;
      } else if (data && data.state === 'ended') {
        const endedAt = (typeof data.updatedAt === 'number' && Number.isFinite(data.updatedAt))
          ? data.updatedAt
          : (typeof data.lastEventAt === 'number' && Number.isFinite(data.lastEventAt) ? data.lastEventAt : 0);
        // Strictly > 24 hours
        if ((now - endedAt) > RUN_PRUNE_ENDED_MS) {
          shouldPrune = true;
        }
      }

      if (shouldPrune) {
        try {
          fs.unlinkSync(filePath);
          changed = true;
        } catch {}

        // A brief mirror is pruned with the run file of the session named in its filename
        const briefMirrorPath = path.join(this.runsDir, `${sid}.brief.json`);
        try {
          if (fs.existsSync(briefMirrorPath)) {
            fs.unlinkSync(briefMirrorPath);
          }
        } catch {}

        // Control dir vanishes with run file
        if (data?.ompSessionId) {
          const controlDir = path.join(this.runsDir, 'control', data.ompSessionId);
          try {
            if (fs.existsSync(controlDir)) {
              fs.rmSync(controlDir, { recursive: true, force: true });
            }
          } catch {}
        }
      } else {
        if (data?.ompSessionId) {
          activeOmpSessions.add(data.ompSessionId);
        }
      }
    }

    // Prune brief mirrors whose sessions no longer exist
    for (const file of entries) {
      if (file.endsWith('.brief.json')) {
        const sid = file.slice(0, -'.brief.json'.length);
        const session = this.options.lookupSession?.(sid);
        if (!session) {
          try {
            fs.unlinkSync(path.join(this.runsDir, file));
            changed = true;
          } catch {}
        }
      }
    }

    // Clean up control directory
    const controlBaseDir = path.join(this.runsDir, 'control');
    if (fs.existsSync(controlBaseDir)) {
      let controlEntries: string[] = [];
      try {
        controlEntries = fs.readdirSync(controlBaseDir);
      } catch {}

      const listed = new Set(controlEntries);
      for (const ompSid of this.controlPruneRetryAt.keys()) {
        if (!listed.has(ompSid)) this.controlPruneRetryAt.delete(ompSid);
      }

      for (const ompSid of controlEntries) {
        const ompDir = path.join(controlBaseDir, ompSid);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(ompDir);
        } catch {
          continue;
        }

        if (!stat.isDirectory()) continue;

        // Orphaned control dir: no active run file
        if (!activeOmpSessions.has(ompSid)) {
          // Listed but not accessible = already delete-pending on Windows (a
          // live OMP process still watches it); the OS finishes the removal
          // when that handle closes, and another rmSync only stalls ~100 ms
          // before EPERM.
          if (!fs.existsSync(ompDir)) continue;
          const retryAt = this.controlPruneRetryAt.get(ompSid);
          if (retryAt !== undefined && now < retryAt) continue;
          try {
            fs.rmSync(ompDir, { recursive: true, force: true });
            this.controlPruneRetryAt.delete(ompSid);
            changed = true;
          } catch {
            this.controlPruneRetryAt.set(ompSid, now + RUN_CONTROL_PRUNE_RETRY_MS);
          }
          continue;
        }

        // Inside active control dir: sweep expired requests and acks
        let controlFiles: string[] = [];
        try {
          controlFiles = fs.readdirSync(ompDir);
        } catch {
          continue;
        }

        for (const cf of controlFiles) {
          const cfPath = path.join(ompDir, cf);
          try {
            if (cf.endsWith('.json') && !cf.endsWith('.ack.json')) {
              // Request file
              const parsed = JSON.parse(fs.readFileSync(cfPath, 'utf8'));
              if (parsed && typeof parsed.expiresAt === 'number') {
                if (now > (parsed.expiresAt + RUN_CONTROL_EXPIRED_MARGIN_MS)) {
                  fs.unlinkSync(cfPath);
                  changed = true;
                }
              }
            } else if (cf.endsWith('.ack.json')) {
              // Ack file
              const parsed = JSON.parse(fs.readFileSync(cfPath, 'utf8'));
              const ackTime = (parsed && typeof parsed.at === 'number') ? parsed.at : stat.mtimeMs;
              if (now > (ackTime + RUN_CONTROL_EXPIRED_MARGIN_MS)) {
                fs.unlinkSync(cfPath);
                changed = true;
              }
            }
          } catch {}
        }
      }
    }
    return changed;
  }

  public async prune(): Promise<void> {
    this.pruneSync();
  }

  /**
   * syncBriefs() writes runtime/runs/<sid>.brief.json:
   * {schema:1, capsuleId, briefSeq, brief, updatedAt} (briefSeq = capsule.updatedAt)
   * and deletes it when the brief clears or the session's capsule changes.
   */
  public syncBriefsSync(explicitSessions?: RunStateSessionInfo[]): void {
    const sessions = explicitSessions ?? this.options.listSessions?.() ?? [];
    const now = this.clock();

    for (const session of sessions) {
      const sid = session.id;
      if (!sid) continue;

      const capsuleId = session.capsuleId ?? this.options.lookupCapsule?.(sid);
      const briefFilePath = path.join(this.runsDir, `${sid}.brief.json`);

      if (!capsuleId) {
        // Session has no capsule: delete brief file if exists
        try {
          if (fs.existsSync(briefFilePath)) {
            fs.unlinkSync(briefFilePath);
          }
        } catch {}
        continue;
      }

      const capsuleInfo = this.options.lookupCapsuleBrief?.(capsuleId);
      const brief = capsuleInfo?.brief;

      if (!brief || (typeof brief === 'object' && Object.keys(brief).length === 0)) {
        // Brief cleared: delete brief file if exists
        try {
          if (fs.existsSync(briefFilePath)) {
            fs.unlinkSync(briefFilePath);
          }
        } catch {}
        continue;
      }

      // Check existing brief file
      let needsWrite = true;
      try {
        if (fs.existsSync(briefFilePath)) {
          const existing: BriefMirrorFile = JSON.parse(fs.readFileSync(briefFilePath, 'utf8'));
          if (existing.capsuleId !== capsuleId) {
            // Session's capsule changed: delete old
            fs.unlinkSync(briefFilePath);
          } else if (existing.briefSeq === capsuleInfo.updatedAt && JSON.stringify(existing.brief) === JSON.stringify(brief)) {
            needsWrite = false;
          }
        }
      } catch {
        needsWrite = true;
      }

      if (needsWrite) {
        const payload: BriefMirrorFile = {
          schema: 1,
          capsuleId,
          briefSeq: capsuleInfo.updatedAt ?? now,
          brief,
          updatedAt: now,
        };

        const tmpPath = path.join(
          this.runsDir,
          `${sid}.brief.json.tmp-${process.pid}-${now}-${Math.random().toString(36).slice(2, 8)}`,
        );
        fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tmpPath, briefFilePath);
      }
    }
  }

  public async syncBriefs(explicitSessions?: RunStateSessionInfo[]): Promise<void> {
    this.syncBriefsSync(explicitSessions);
  }
}
