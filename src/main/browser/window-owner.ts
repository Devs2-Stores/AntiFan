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

/**
 * Stable identity of whatever owns a window. `project` windows are retired — every web
 * surface is the one `web` hub, `unassigned` is the shared Terminal Manager; the two are
 * disjoint and the `project` variant stays in the type only so stored owner keys like
 * `project:<id>` keep parsing where a migration reads them.
 */
export type WindowOwner = { kind: 'project'; projectId: string } | { kind: 'web' } | { kind: 'unassigned' };

/** Collision-free map key for an owner. Project IDs and the sentinels cannot alias. */
export function ownerKey(owner: WindowOwner): string {
  return owner.kind === 'project' ? `project:${owner.projectId}` : owner.kind;
}
