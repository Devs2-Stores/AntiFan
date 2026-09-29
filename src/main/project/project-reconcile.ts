/**
 * The one place that answers "what happened to this stored project since it was saved".
 *
 * Both list surfaces (Terminal Manager groups, Project Picker rows) need the same three-way
 * label: is the project open right now, is its folder gone, or is it simply closed and
 * resumable. Each used to be inferred ad hoc; the rules live here once.
 *
 * A stored record is classified by two axes: liveness (a session or window currently bound
 * to the project) and durability (the workspace path on record still exists on disk). LIVE
 * beats everything — a live project is never STALE, whatever its path looks like. Of the
 * dead records, a missing workspace path means STALE: the folder is gone, so reopening is
 * impossible and only cleanup remains. Anything else is DEAD: closed, but resumable.
 *
 * Pure and deterministic: `pathExists` is injected so nothing here touches fs, and an empty
 * input is an answer (an empty list), never an error.
 */

/** A stored project record, reduced to the fields classification reads. */
export interface ReconcileStoredRecord {
  id: string;
  workspacePath?: string;
  capsuleId?: string;
}

/** The ports reconciliation reads. Nothing is stored; each call re-derives the answer. */
export interface ReconcileProjectRecordsInput {
  stored: readonly ReconcileStoredRecord[];
  liveSessionProjectIds: ReadonlySet<string>;
  liveWindowProjectIds: ReadonlySet<string>;
  pathExists: (p: string) => boolean;
}

export type ReconcileStatus = 'LIVE' | 'DEAD' | 'STALE';

export interface ReconciledProjectRecord {
  id: string;
  status: ReconcileStatus;
  reason: string;
}

/**
 * Label every stored record LIVE, STALE or DEAD.
 *
 * LIVE wins unconditionally and short-circuits the path probe; STALE then beats DEAD among
 * dead records. A record with no usable workspace path can never be STALE — there is no
 * folder whose absence could be proven.
 */
export function reconcileProjectRecords(input: ReconcileProjectRecordsInput): ReconciledProjectRecord[] {
  return input.stored.map((record) => {
    if (input.liveSessionProjectIds.has(record.id)) {
      return { id: record.id, status: 'LIVE', reason: 'live-session' };
    }
    if (input.liveWindowProjectIds.has(record.id)) {
      return { id: record.id, status: 'LIVE', reason: 'live-window' };
    }
    const workspacePath = record.workspacePath?.trim();
    if (workspacePath && !input.pathExists(workspacePath)) {
      return { id: record.id, status: 'STALE', reason: 'workspace-path-missing' };
    }
    return { id: record.id, status: 'DEAD', reason: workspacePath ? 'closed-resumable' : 'no-workspace-path' };
  });
}
