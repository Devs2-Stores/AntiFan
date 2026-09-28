/**
 * AntiFan Browser Desktop — window ownership identity.
 *
 * One place defines what owns a window and how that owner is spelled as a key. The
 * key is a durable string: it is written into the terminal session state file and
 * compared across processes, so it must not depend on Electron, on a live window,
 * or on any registry lookup. That is also why this module is deliberately pure —
 * `terminal-manager.ts` imports it, and that module is the headless daemon's own
 * closure, which must not pull Electron in.
 */

/** Stable identity of whatever owns a window. Project and Unassigned are disjoint. */
export type WindowOwner = { kind: 'project'; projectId: string } | { kind: 'unassigned' };

/** Collision-free map key for an owner. Project IDs and the sentinel cannot alias. */
export function ownerKey(owner: WindowOwner): string {
  return owner.kind === 'project' ? `project:${owner.projectId}` : 'unassigned';
}
