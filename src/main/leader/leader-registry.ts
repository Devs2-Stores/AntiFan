import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StorageLocations } from '../config/storage-locations';

/** A terminal a Leader drives: who it answers to and what the Leader called it. */
export interface LeaderWorkerRecord {
  leaderId: string;
  title?: string;
  assignedAt: number;
}

interface LeaderRegistryFile {
  schema: 1;
  leaders: string[];
  workers: Record<string, LeaderWorkerRecord>;
}

const FILE_NAME = 'leader-terminals.json';
const TITLE_MAX_CHARS = 80;

/**
 * Which terminals the user marked Leader, and which terminals those Leaders drive.
 *
 * Authority is bound to the terminal id. A terminal minted later must not inherit a closed Leader's
 * rights, and the terminal manager raises its id counters so a live id is never reissued; a daemon that
 * predates the persisted counters can still reissue a closed id until it is restarted, so an id minted
 * for a Leader's worker is cleared of any stale flag or record before it is registered. The flag is
 * flipped only through `setLeader`, which the host calls from the user's own Terminal Manager gesture:
 * nothing an agent sends can reach it.
 *
 * A worker record lives until its own terminal closes: clearing or closing its Leader does not free it,
 * because the record is what makes the worker's OMP hook refuse theme pushes. The worker becomes an
 * orphan that a live Leader may adopt by writing to it. Persisted synchronously on every change, so a
 * crash right after a promotion cannot lose it. Emits `'change'` (no payload) whenever the persisted
 * shape changes.
 */
export class LeaderRegistry extends EventEmitter {
  private static instance: LeaderRegistry | undefined;

  private readonly leaderIds = new Set<string>();
  private readonly workerRecords = new Map<string, LeaderWorkerRecord>();

  public static getInstance(): LeaderRegistry {
    if (!LeaderRegistry.instance) LeaderRegistry.instance = new LeaderRegistry();
    return LeaderRegistry.instance;
  }

  /** Test seam: drop the singleton so the next `getInstance` reloads from the file path in force. */
  public static resetInstance(): void {
    LeaderRegistry.instance?.removeAllListeners();
    LeaderRegistry.instance = undefined;
  }

  private constructor() {
    super();
    // Every project window's host subscribes to re-push its projections, so more than the default 10 is normal.
    this.setMaxListeners(50);
    this.load();
  }

  /** Same directory rule as the terminal session file: the isolated-instance override wins. */
  private filePath(): string {
    return path.join(process.env.ANTIFAN_CONFIG_DIR || StorageLocations.getConfigDir(), FILE_NAME);
  }

  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
    } catch {
      return;
    }
    if (!raw || typeof raw !== 'object') return;
    const file = raw as Partial<LeaderRegistryFile>;
    if (file.schema !== 1) return;
    if (Array.isArray(file.leaders)) {
      for (const id of file.leaders) {
        if (typeof id === 'string' && id) this.leaderIds.add(id);
      }
    }
    if (file.workers && typeof file.workers === 'object') {
      for (const [workerId, record] of Object.entries(file.workers)) {
        if (!workerId || !record || typeof record.leaderId !== 'string' || !record.leaderId) continue;
        this.workerRecords.set(workerId, {
          leaderId: record.leaderId,
          ...(typeof record.title === 'string' && record.title ? { title: record.title } : {}),
          assignedAt: typeof record.assignedAt === 'number' ? record.assignedAt : 0,
        });
      }
    }
  }

  /** Persist the current shape and announce it. Returns whether the file was written. */
  private commit(): boolean {
    const file: LeaderRegistryFile = {
      schema: 1,
      leaders: [...this.leaderIds],
      workers: Object.fromEntries(this.workerRecords),
    };
    const target = this.filePath();
    const temp = `${target}.tmp-${process.pid}`;
    let persisted = true;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(file), 'utf8');
      fs.renameSync(temp, target);
    } catch (err) {
      persisted = false;
      console.warn('[leader-registry] failed to persist leader terminals:', err);
      try { fs.rmSync(temp, { force: true }); } catch {}
    }
    this.emit('change');
    return persisted;
  }

  public isLeader(id: string): boolean {
    return this.leaderIds.has(id);
  }

  public leaders(): string[] {
    return [...this.leaderIds];
  }

  /**
   * Mark (or clear) a Leader. Marking drops any worker record the terminal had (a Leader is never
   * anybody's worker). Clearing removes the flag only: the workers it drove keep their records, so
   * their theme-push gate survives the Leader. Returns whether the registry changed.
   */
  public setLeader(id: string, on: boolean): boolean {
    if (!id) return false;
    if (on) {
      if (this.leaderIds.has(id)) return false;
      this.leaderIds.add(id);
      this.workerRecords.delete(id);
      this.commit();
      return true;
    }
    if (!this.leaderIds.delete(id)) return false;
    this.commit();
    return true;
  }

  /**
   * Record that `leaderId` drives `workerId`. Ignored unless `leaderId` is a Leader, and a Leader
   * is never its own worker nor another Leader's. A worker another live Leader already drives is never
   * taken from it; a record whose Leader is no longer a Leader may be adopted. A repeat assignment
   * keeps its `assignedAt`, and the title carries over unless a new one is given.
   *
   * Returns true when the record names `leaderId` and is persisted, false when nothing was recorded
   * (a refused assignment, or a file that could not be written).
   */
  public assignWorker(workerId: string, leaderId: string, title?: string): boolean {
    if (!workerId || !leaderId || workerId === leaderId) return false;
    if (!this.leaderIds.has(leaderId) || this.leaderIds.has(workerId)) return false;
    const existing = this.workerRecords.get(workerId);
    if (existing && existing.leaderId !== leaderId && this.leaderIds.has(existing.leaderId)) return false;
    const cleanTitle = typeof title === 'string' ? title.trim().slice(0, TITLE_MAX_CHARS) : '';
    const sameLeader = existing?.leaderId === leaderId ? existing : undefined;
    const nextTitle = cleanTitle || existing?.title;
    if (sameLeader && nextTitle === sameLeader.title) return true;
    const previous = existing;
    this.workerRecords.set(workerId, {
      leaderId,
      ...(nextTitle ? { title: nextTitle } : {}),
      assignedAt: sameLeader?.assignedAt ?? Date.now(),
    });
    if (this.commit()) return true;
    // The change is not on disk: the hook reads the file, so an unsaved record gates nothing. Keep memory honest.
    if (previous) this.workerRecords.set(workerId, previous);
    else this.workerRecords.delete(workerId);
    this.emit('change');
    return false;
  }

  /**
   * Make `childId` a worker of the same Leader as `parentWorkerId`, whether or not that Leader is
   * still a Leader: a split of an orphan worker must be gated like the orphan. Returns false when the
   * parent has no record, the child is the parent or a Leader, or the record could not be saved.
   */
  public inheritWorker(childId: string, parentWorkerId: string): boolean {
    if (!childId || !parentWorkerId || childId === parentWorkerId || this.leaderIds.has(childId)) return false;
    const parent = this.workerRecords.get(parentWorkerId);
    if (!parent) return false;
    const previous = this.workerRecords.get(childId);
    this.workerRecords.set(childId, { leaderId: parent.leaderId, assignedAt: Date.now() });
    if (this.commit()) return true;
    if (previous) this.workerRecords.set(childId, previous);
    else this.workerRecords.delete(childId);
    this.emit('change');
    return false;
  }

  public workerOf(id: string): LeaderWorkerRecord | undefined {
    const record = this.workerRecords.get(id);
    return record ? { ...record } : undefined;
  }

  /**
   * A terminal was closed: forget it. Drops its Leader flag and its own worker record. The workers it
   * drove keep theirs: their terminals are still open and still gated.
   */
  public forget(id: string): void {
    if (!id) return;
    let changed = this.leaderIds.delete(id);
    if (this.workerRecords.delete(id)) changed = true;
    if (changed) this.commit();
  }

  /** Drop every Leader and worker whose terminal is no longer live. Workers of a Leader that closed stay: they are orphans, still gated. */
  public prune(liveIds: ReadonlySet<string>): void {
    let changed = false;
    for (const id of [...this.leaderIds]) {
      if (!liveIds.has(id)) {
        this.leaderIds.delete(id);
        changed = true;
      }
    }
    for (const workerId of [...this.workerRecords.keys()]) {
      if (!liveIds.has(workerId)) {
        this.workerRecords.delete(workerId);
        changed = true;
      }
    }
    if (changed) this.commit();
  }
}
