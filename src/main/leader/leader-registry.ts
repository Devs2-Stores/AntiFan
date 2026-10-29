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
 * Authority is bound to the terminal id, and ids are never reissued (the terminal manager's counters
 * only grow), so a terminal minted later never inherits a closed Leader's rights. The flag is flipped
 * only through `setLeader`, which the host calls from the user's own Terminal Manager gesture: nothing
 * an agent sends can reach it. Persisted synchronously on every change, so a crash right after a
 * promotion cannot lose it. Emits `'change'` (no payload) whenever the persisted shape changes.
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

  private commit(): void {
    const file: LeaderRegistryFile = {
      schema: 1,
      leaders: [...this.leaderIds],
      workers: Object.fromEntries(this.workerRecords),
    };
    const target = this.filePath();
    const temp = `${target}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(file), 'utf8');
      fs.renameSync(temp, target);
    } catch (err) {
      console.warn('[leader-registry] failed to persist leader terminals:', err);
      try { fs.rmSync(temp, { force: true }); } catch {}
    }
    this.emit('change');
  }

  public isLeader(id: string): boolean {
    return this.leaderIds.has(id);
  }

  public leaders(): string[] {
    return [...this.leaderIds];
  }

  /**
   * Mark (or clear) a Leader. Marking drops any worker record the terminal had (a Leader is never
   * anybody's worker); clearing also releases the workers it drove: a terminal that is no longer a
   * Leader commands nobody. Returns whether the registry changed.
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
    for (const [workerId, record] of this.workerRecords) {
      if (record.leaderId === id) this.workerRecords.delete(workerId);
    }
    this.commit();
    return true;
  }

  /**
   * Record that `leaderId` drives `workerId`. Ignored unless `leaderId` is a Leader, and a Leader
   * is never its own worker nor another Leader's. A repeat assignment keeps its `assignedAt` and
   * only refreshes the title when one is given.
   */
  public assignWorker(workerId: string, leaderId: string, title?: string): void {
    if (!workerId || !leaderId || workerId === leaderId) return;
    if (!this.leaderIds.has(leaderId) || this.leaderIds.has(workerId)) return;
    const cleanTitle = typeof title === 'string' ? title.trim().slice(0, TITLE_MAX_CHARS) : '';
    const existing = this.workerRecords.get(workerId);
    const sameLeader = existing?.leaderId === leaderId ? existing : undefined;
    const nextTitle = cleanTitle || sameLeader?.title;
    if (sameLeader && nextTitle === sameLeader.title) return;
    this.workerRecords.set(workerId, {
      leaderId,
      ...(nextTitle ? { title: nextTitle } : {}),
      assignedAt: sameLeader?.assignedAt ?? Date.now(),
    });
    this.commit();
  }

  public workerOf(id: string): LeaderWorkerRecord | undefined {
    const record = this.workerRecords.get(id);
    return record ? { ...record } : undefined;
  }

  /**
   * A terminal was closed: forget it everywhere. Drops its Leader flag, its own worker record and the
   * worker records of the workers it drove (so a closed Leader's rights, and its workers, go with it).
   * Terminal ids are never reissued, so nothing else needs to be swept.
   */
  public forget(id: string): void {
    if (!id) return;
    let changed = this.leaderIds.delete(id);
    if (this.workerRecords.delete(id)) changed = true;
    for (const [workerId, record] of [...this.workerRecords]) {
      if (record.leaderId === id) {
        this.workerRecords.delete(workerId);
        changed = true;
      }
    }
    if (changed) this.commit();
  }

  /** Drop every Leader and worker that is no longer live, and every worker whose Leader is gone. */
  public prune(liveIds: ReadonlySet<string>): void {
    let changed = false;
    for (const id of [...this.leaderIds]) {
      if (!liveIds.has(id)) {
        this.leaderIds.delete(id);
        changed = true;
      }
    }
    for (const [workerId, record] of [...this.workerRecords]) {
      if (!liveIds.has(workerId) || !this.leaderIds.has(record.leaderId)) {
        this.workerRecords.delete(workerId);
        changed = true;
      }
    }
    if (changed) this.commit();
  }
}
