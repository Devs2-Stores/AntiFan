/**
 * One-time migration of `saved-tabs.json` from the hub era (a shared 'web' window that
 * presented one project at a time, a placeholder boot project, detach/fold markers) to one
 * record per project window.
 *
 * Invariant: no tab row leaves the document. Every row of the 'web' record, of the boot
 * project's record and of the Terminal Manager's 'unassigned' record (which never restores
 * tabs, so its first write would drop them) lands in the `project:<id>` record of the project
 * it is stamped with. A stamp naming a project the registry still holds — open or closed —
 * is honored as is; the row waits in that project's record until its window opens.
 *
 * A row whose stamp is missing, the boot placeholder, or unknown to the registry is re-homed
 * to the first available project of this order, and loses its stale `capsuleId` (that
 * capsule belonged to the old project):
 *   1. the project the hub was presenting;
 *   2. the first project in the open-window ledger;
 *   3. the open project whose existing `project:<id>` record has the newest `updatedAt`
 *      (an open project with no record yet when none has one).
 * When no open project exists at all, the row goes to the Terminal Manager's 'unassigned'
 * record if that window can host browser tabs; otherwise it is reported in `unplacedTabIds`
 * and left where it was — the caller must then log and not persist.
 *
 * The transform is pure (the input is never mutated and nothing reads the clock or the
 * disk); only `backupSavedTabsBeforeMigration` touches the filesystem.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SavedTabsDocument } from './native-tab-host';

/**
 * Document version of the project-window layout. A document below it is unmigrated;
 * the migration writes exactly this version, which is what makes it run once.
 */
export const PROJECT_WINDOWS_SAVED_TABS_VERSION = 3;

/** The placeholder boot project the hub era stamped onto rows it could not attribute. */
const LEGACY_BOOT_PROJECT_ID = 'project-00000000-0000-4000-8000-000000000001';

/** Owner key of the hub shell that no longer exists; read here and nowhere else. */
const LEGACY_WEB_OWNER_KEY = 'web';
const LEGACY_BOOT_OWNER_KEY = `project:${LEGACY_BOOT_PROJECT_ID}`;
const UNASSIGNED_OWNER_KEY = 'unassigned';
const PROJECT_OWNER_PREFIX = 'project:';

/** Window state that belongs to the window as a whole, not to one tab. */
const POPOUT_FIELDS = ['terminalWindows', 'isTerminalPopoutOpen', 'wasSidebarOpenBeforePopout', 'popoutSessionId'] as const;
const WINDOW_LOOK_FIELDS = ['terminalTabLayout', 'terminalSidebarWidth'] as const;

export interface ProjectWindowsMigrationOptions {
  /** Open projects of the registry: the only ones a re-homed row may be sent to. */
  knownProjectIds: ReadonlySet<string>;
  /**
   * Every project of the registry, whatever its state. A row stamped with one of these (and
   * not open) keeps its stamp and moves into that project's own record; only a stamp the
   * registry does not know falls back. Absent means "only the open projects are registered".
   */
  registeredProjectIds?: ReadonlySet<string>;
  /**
   * Whether the 'unassigned' (Terminal Manager) window can host browser tabs. When true its
   * rows stay where they are and it is the last-resort home for a row with no open project.
   */
  unassignedHostsTabs: boolean;
  /**
   * Owner keys of the windows that were open at the last exit (`open-windows.json`). The
   * saved `detached` markers cannot stand in for it: they outlive a window the user closed,
   * so honoring them would resurrect every project ever detached. `null`/absent means no
   * evidence, and then only the hub's presented project is reopened.
   */
  openWindowKeys?: ReadonlySet<string> | null;
}

export interface ProjectWindowsMigrationResult {
  /** New object; the input is never mutated. */
  doc: SavedTabsDocument;
  /** False when the document was already at the project-window version (returned as-is). */
  migrated: boolean;
  movedTabs: Array<{ tabId: string; from: string; to: string }>;
  /** Tabs with no non-lossy home; non-empty means the caller must not persist and must log. */
  unplacedTabIds: string[];
  /**
   * Project windows to reopen at startup. "Open at quit" is: the project the hub was
   * presenting (its window was open by construction), then every project whose window the
   * ledger lists, in ledger order — only projects that are real and known — then the
   * fallback project when it took re-homed rows. Never derived from `detached` markers.
   */
  openProjectIds: string[];
}

type LooseTab = Record<string, unknown>;
type LooseRecord = Record<string, unknown> & {
  tabs: LooseTab[];
  updatedAt: number;
  activeTabId?: string;
  terminalAffinities?: Array<Record<string, unknown>>;
};

function realProjectId(value: unknown, known: ReadonlySet<string>): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id === LEGACY_BOOT_PROJECT_ID || !known.has(id)) return null;
  return id;
}

function projectOwnerKey(projectId: string): string {
  return `${PROJECT_OWNER_PREFIX}${projectId}`;
}

function tabIdOf(tab: LooseTab): string | undefined {
  return typeof tab.id === 'string' && tab.id ? tab.id : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Open projects named by the hub's presented project, then by the ledger, in that order. */
function openProjectIdsOf(
  presented: string | null,
  opts: ProjectWindowsMigrationOptions,
): string[] {
  const ids: string[] = [];
  const add = (id: string | null): void => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  add(presented);
  for (const key of opts.openWindowKeys ?? []) {
    if (typeof key !== 'string' || !key.startsWith(PROJECT_OWNER_PREFIX)) continue;
    add(realProjectId(key.slice(PROJECT_OWNER_PREFIX.length), opts.knownProjectIds));
  }
  return ids;
}

/**
 * The project a row with no usable stamp is re-homed to: the presented project, else the
 * first ledger project, else the open project whose existing record is newest (the first
 * open project when none has a record). Null only when no project is open.
 */
function fallbackProjectOf(
  presented: string | null,
  owners: Record<string, LooseRecord>,
  opts: ProjectWindowsMigrationOptions,
): string | null {
  if (presented) return presented;
  const [firstLedger] = openProjectIdsOf(null, opts);
  if (firstLedger) return firstLedger;
  let newest: { id: string; updatedAt: number } | null = null;
  let firstKnown: string | null = null;
  for (const id of opts.knownProjectIds) {
    if (typeof id !== 'string' || !id || id === LEGACY_BOOT_PROJECT_ID) continue;
    firstKnown ??= id;
    const record = owners[projectOwnerKey(id)];
    if (!isObject(record)) continue;
    const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0;
    if (!newest || updatedAt > newest.updatedAt) newest = { id, updatedAt };
  }
  return newest?.id ?? firstKnown;
}

export function migrateSavedTabsToProjectWindows(
  doc: SavedTabsDocument,
  opts: ProjectWindowsMigrationOptions,
): ProjectWindowsMigrationResult {
  const known = opts.knownProjectIds;
  if (typeof doc.version === 'number' && doc.version >= PROJECT_WINDOWS_SAVED_TABS_VERSION) {
    return { doc, migrated: false, movedTabs: [], unplacedTabIds: [], openProjectIds: openProjectIdsOf(null, opts) };
  }

  const out = structuredClone(doc) as SavedTabsDocument;
  if (!isObject(out.owners)) out.owners = {};
  const owners = out.owners as unknown as Record<string, LooseRecord>;

  const webRecord = isObject(owners[LEGACY_WEB_OWNER_KEY]) ? owners[LEGACY_WEB_OWNER_KEY] : undefined;
  const presented = realProjectId(webRecord?.activeProjectId, known);
  const registered = new Set<string>([...known, ...(opts.registeredProjectIds ?? [])]);
  // Fixed before any row moves, so the answer does not depend on records created below.
  const fallbackProject = fallbackProjectOf(presented, owners, opts);
  let usedFallbackProject = false;

  const movedTabs: ProjectWindowsMigrationResult['movedTabs'] = [];
  const unplacedTabIds: string[] = [];
  const retained = new Set<string>();
  /** tab id -> owner key it now lives under; resolves active pointers and affinities. */
  const homeOfTab = new Map<string, string>();

  const recordFor = (key: string, seedUpdatedAt: number): LooseRecord => {
    const existing = owners[key];
    if (isObject(existing)) {
      if (!Array.isArray(existing.tabs)) existing.tabs = [];
      return existing as LooseRecord;
    }
    const created = { tabs: [], updatedAt: seedUpdatedAt } as unknown as LooseRecord;
    owners[key] = created;
    return created;
  };

  const sourceKeys = opts.unassignedHostsTabs
    ? [LEGACY_WEB_OWNER_KEY, LEGACY_BOOT_OWNER_KEY]
    : [LEGACY_WEB_OWNER_KEY, LEGACY_BOOT_OWNER_KEY, UNASSIGNED_OWNER_KEY];
  for (const sourceKey of sourceKeys) {
    const source = owners[sourceKey];
    if (!isObject(source)) continue;
    const sourceTabs: unknown[] = Array.isArray(source.tabs) ? source.tabs : [];
    const sourceUpdatedAt = typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt)
      ? source.updatedAt
      : (typeof out.updatedAt === 'number' ? out.updatedAt : 0);
    const kept: LooseTab[] = [];
    const touched = new Set<string>();

    sourceTabs.forEach((entry, index) => {
      if (!isObject(entry)) return;
      const tab: LooseTab = entry;
      const label = tabIdOf(tab) ?? `${sourceKey}#${index}`;
      const own = realProjectId(tab.projectId, registered);
      let destKey: string | null = null;
      if (own) {
        destKey = projectOwnerKey(own);
      } else if (fallbackProject) {
        destKey = projectOwnerKey(fallbackProject);
        tab.projectId = fallbackProject;
        // The capsule belonged to the project the row used to be stamped with.
        delete tab.capsuleId;
        usedFallbackProject = true;
      } else if (opts.unassignedHostsTabs) {
        destKey = UNASSIGNED_OWNER_KEY;
        // A stale stamp for a removed project must not follow the row into a shared window.
        delete tab.projectId;
        delete tab.capsuleId;
      }
      if (!destKey) {
        kept.push(tab);
        unplacedTabIds.push(label);
        return;
      }
      const dest = recordFor(destKey, sourceUpdatedAt);
      const id = tabIdOf(tab);
      touched.add(destKey);
      if (id) homeOfTab.set(id, destKey);
      // The same tab id is the same tab: a window that already carries it keeps its row.
      if (id && dest.tabs.some((t) => isObject(t) && t.id === id)) return;
      dest.tabs.push(tab);
      dest.updatedAt = Math.max(typeof dest.updatedAt === 'number' ? dest.updatedAt : 0, sourceUpdatedAt);
      movedTabs.push({ tabId: label, from: sourceKey, to: destKey });
    });

    // The window's active tab follows its row, but never displaces a valid pointer the
    // destination already has.
    const sourceActive = typeof source.activeTabId === 'string' ? source.activeTabId : '';
    const activeHome = sourceActive ? homeOfTab.get(sourceActive) : undefined;
    if (activeHome) {
      const dest = owners[activeHome] as LooseRecord;
      const valid = typeof dest.activeTabId === 'string'
        && dest.tabs.some((t) => isObject(t) && t.id === dest.activeTabId);
      if (!valid) dest.activeTabId = sourceActive;
      if (sourceKey === UNASSIGNED_OWNER_KEY) delete source.activeTabId;
    }

    // An affinity travels with the window that holds its primary tab; one whose primary
    // tab is gone points at nothing. A record that stays (the Terminal Manager's) gives up
    // the affinities that moved.
    const remainingAffinities: Array<Record<string, unknown>> = [];
    for (const aff of Array.isArray(source.terminalAffinities) ? source.terminalAffinities : []) {
      if (!isObject(aff) || typeof aff.primaryTabId !== 'string') continue;
      const home = homeOfTab.get(aff.primaryTabId);
      if (!home) {
        remainingAffinities.push(aff);
        continue;
      }
      const dest = owners[home] as LooseRecord;
      const list = (dest.terminalAffinities ??= []);
      if (!list.some((a) => a.terminalId === aff.terminalId && a.primaryTabId === aff.primaryTabId)) {
        list.push(aff);
      }
    }
    if (sourceKey === UNASSIGNED_OWNER_KEY && Array.isArray(source.terminalAffinities)) {
      source.terminalAffinities = remainingAffinities;
    }

    // Terminal pop-outs were the hub's; the project it was presenting inherits them.
    if (presented && sourceKey === LEGACY_WEB_OWNER_KEY && kept.length === 0) {
      const hasPopout = POPOUT_FIELDS.some((field) => source[field] !== undefined);
      if (hasPopout) {
        const dest = recordFor(projectOwnerKey(presented), sourceUpdatedAt);
        if (POPOUT_FIELDS.every((field) => dest[field] === undefined)) {
          for (const field of POPOUT_FIELDS) {
            if (source[field] !== undefined) dest[field] = source[field];
          }
        }
      }
    }

    // A window record that took rows from here without a look of its own inherits the
    // source window's tab-strip layout and sidebar width. The Terminal Manager's look is
    // its own and is never handed to a project window.
    for (const destKey of sourceKey === UNASSIGNED_OWNER_KEY ? [] : touched) {
      const dest = owners[destKey] as LooseRecord;
      for (const field of WINDOW_LOOK_FIELDS) {
        if (dest[field] === undefined && source[field] !== undefined) dest[field] = source[field];
      }
    }

    if (kept.length === 0) {
      if (sourceKey === UNASSIGNED_OWNER_KEY) {
        // The Terminal Manager's record stays: it still carries the window's own fields.
        source.tabs = [];
      } else {
        delete owners[sourceKey];
      }
    } else {
      source.tabs = kept;
      retained.add(sourceKey);
    }
  }

  // What the hub era needed to track which window was detached or presenting is gone from
  // every record that is not still waiting on an unplaced row.
  for (const [key, record] of Object.entries(owners)) {
    if (!isObject(record) || retained.has(key)) continue;
    delete record.detached;
    delete record.activeProjectId;
  }

  if (unplacedTabIds.length === 0) out.version = PROJECT_WINDOWS_SAVED_TABS_VERSION;

  // A project that took re-homed rows reopens even when neither the hub nor the ledger named
  // it, so those rows are not parked in a window nobody sees.
  const openProjectIds = openProjectIdsOf(presented, opts);
  if (usedFallbackProject && fallbackProject && !openProjectIds.includes(fallbackProject)) {
    openProjectIds.push(fallbackProject);
  }

  return { doc: out, migrated: true, movedTabs, unplacedTabIds, openProjectIds };
}

function stamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Copy `filePath` next to itself as `<name>.pre-project-windows-<yyyymmddHHMMss>.bak` before
 * the first rewrite. The source is copied, never moved, and an existing backup is never
 * overwritten — the copy is exclusive-create, and a taken name gets a `-1`, `-2`, ... suffix.
 * Returns the backup path, or null when there is no file to back up.
 */
export function backupSavedTabsBeforeMigration(filePath: string, now: Date = new Date()): string | null {
  if (!fs.existsSync(filePath)) return null;
  const base = `${filePath}.pre-project-windows-${stamp(now)}`;
  for (let attempt = 0; ; attempt += 1) {
    const target = `${base}${attempt === 0 ? '' : `-${attempt}`}.bak`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL);
      return target;
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
}
