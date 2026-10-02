/**
 * Main-process store for the Theme Studio checklist.
 *
 * Persisted scopes live in `<workspaceRoot>/.antifan/qa-checklist.json`, a file
 * the whole toolbar↔agent bridge shares, so every mutation is one synchronous
 * read → apply → atomic write step (the same reason `native-tab-host` keeps its
 * saved-tabs read-merge-rename inside a single `enqueueSavedTabsWrite` task: an
 * interrupted interleave would let a stale reader overwrite a fresh write).
 *
 * Atomic write convention follows `terminal-manager.ts`: temp file named
 * `<target>.tmp-<pid>-<seq>-<timestamp>` + `fs.renameSync`, direct-write
 * fallback when the rename is refused (locked/EPERM/AV on Windows), temp file
 * removed on failure, and a one-shot sweep deletes leftover `tmp-*` debris the
 * first time a file's directory is opened.
 *
 * Scopes whose tag is `unknown-workspace` — or that arrive with an empty
 * workspaceRoot — have no durable identity: they are provisional and must be
 * served from the owning host's in-memory map, never from this module.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CapabilityError } from '../../shared/control-plane-contracts';
import {
  DEFAULT_THEME_CHECKLIST,
  UNKNOWN_WORKSPACE_TAG,
  type ThemeChecklistItem,
} from '../../shared/theme-checklist';

export const THEME_CHECKLIST_DIRNAME = '.antifan';
export const THEME_CHECKLIST_FILENAME = 'qa-checklist.json';

/** ~1KB per free-text field — the caps a renderer or agent cannot exceed. */
export const MAX_CHECKLIST_FIELD_CHARS = 1024;
export const MAX_CHECKLIST_ITEMS_PER_SCOPE = 200;
export const CHECKLIST_PAGE_KEY_PATTERN = /^[a-z0-9-]{1,32}$/;

export interface ChecklistScopeRecord {
  items: ThemeChecklistItem[];
  updatedAt: number;
  /** Set once toolbar-side (localStorage) state has been merged into the file. */
  legacyMigrated?: boolean;
}

export interface ChecklistFileData {
  version: 1;
  scopes: Record<string, ChecklistScopeRecord>;
}

export interface ChecklistScopeSnapshot {
  items: ThemeChecklistItem[];
  updatedAt: number;
  /** Whether this scope already has a persisted record (vs. seeded defaults). */
  existed: boolean;
  /** Whether the record absorbed legacy toolbar state. */
  migrated: boolean;
}

export type ChecklistMutationOp =
  | { op: 'mark'; itemId: string; done: boolean; note?: string }
  | { op: 'add'; item: unknown }
  | { op: 'remove'; itemId: string }
  | { op: 'markPage'; page: string; done: boolean };

export interface ChecklistMutationResult {
  items: ThemeChecklistItem[];
  updatedAt: number;
  /** The item a `mark`/`add` op resolved to. */
  item?: ThemeChecklistItem;
  /** Rows `markPage` actually flipped. */
  toggled?: number;
  /** Whether `remove` dropped a row. */
  removed?: boolean;
}

export interface ChecklistCasResult {
  conflict: boolean;
  items: ThemeChecklistItem[];
  updatedAt: number;
}

export function checklistFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, THEME_CHECKLIST_DIRNAME, THEME_CHECKLIST_FILENAME);
}

/**
 * True when a scope has no durable identity to persist against: the workspace
 * could not be resolved (tag) or no root was supplied. Provisional scopes must
 * never reach `checklistFilePath`.
 */
export function isProvisionalChecklistScope(scope: string | undefined, workspaceRoot: string | undefined): boolean {
  if (!workspaceRoot || !String(workspaceRoot).trim()) return true;
  const s = typeof scope === 'string' ? scope : '';
  const tag = s.slice(s.lastIndexOf('@') + 1);
  return tag === UNKNOWN_WORKSPACE_TAG;
}

// ---------------------------------------------------------------------------
// Validation caps (F13): the renderer is not trusted, and agent callers even
// less so. Writes are strict; reads are lenient (corrupt rows are dropped, not
// fatal, so one bad item never bricks the whole checklist).
// ---------------------------------------------------------------------------

function capField(value: unknown): string {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  return s.length > MAX_CHECKLIST_FIELD_CHARS ? s.slice(0, MAX_CHECKLIST_FIELD_CHARS) : s;
}

/**
 * Strict item validation for writes: unknown keys stripped, strings coerced and
 * truncated, `done` coerced, page key checked. Throws `INVALID_ARGUMENT`.
 */
export function validateChecklistItem(raw: unknown, indexLabel = 'item'): ThemeChecklistItem {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CapabilityError('INVALID_ARGUMENT', `Checklist ${indexLabel} must be an object`);
  }
  // Boundary validation: every field below is re-coerced or range-checked, so
  // the record view is a read shape, never trusted input.
  const src = raw as Record<string, unknown>;
  const id = capField(src.id).trim();
  if (!id) throw new CapabilityError('INVALID_ARGUMENT', `Checklist ${indexLabel} requires a non-empty id`);
  const page = capField(src.page).trim() || 'home';
  if (!CHECKLIST_PAGE_KEY_PATTERN.test(page)) {
    throw new CapabilityError('INVALID_ARGUMENT', `Checklist ${indexLabel} page "${page}" must match ${CHECKLIST_PAGE_KEY_PATTERN}`);
  }
  const item: ThemeChecklistItem = {
    id,
    code: capField(src.code),
    name: capField(src.name),
    desc: capField(src.desc),
    qaPoint: capField(src.qaPoint),
    page,
    done: src.done === true,
  };
  if (src.pathHint !== undefined) item.pathHint = capField(src.pathHint);
  if (src.note !== undefined) item.note = capField(src.note);
  return item;
}

export function validateChecklistItems(raw: unknown): ThemeChecklistItem[] {
  if (!Array.isArray(raw)) throw new CapabilityError('INVALID_ARGUMENT', 'Checklist items must be an array');
  if (raw.length > MAX_CHECKLIST_ITEMS_PER_SCOPE) {
    throw new CapabilityError('INVALID_ARGUMENT', `Checklist exceeds ${MAX_CHECKLIST_ITEMS_PER_SCOPE} items per scope`);
  }
  const items = raw.map((entry, index) => validateChecklistItem(entry, `item[${index}]`));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new CapabilityError('INVALID_ARGUMENT', `Checklist item id "${item.id}" is duplicated`);
    seen.add(item.id);
  }
  return items;
}

/** Lenient read-side sanitize: malformed rows are dropped, fields coerced. */
function sanitizeChecklistItemForRead(raw: unknown): ThemeChecklistItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>; // read-only view; every field is re-coerced below
  const id = capField(src.id).trim();
  if (!id) return null;
  const pageRaw = capField(src.page).trim();
  const page = CHECKLIST_PAGE_KEY_PATTERN.test(pageRaw) ? pageRaw : 'pages';
  const item: ThemeChecklistItem = {
    id,
    code: capField(src.code),
    name: capField(src.name),
    desc: capField(src.desc),
    qaPoint: capField(src.qaPoint),
    page,
    done: src.done === true,
  };
  if (typeof src.pathHint === 'string' && src.pathHint) item.pathHint = capField(src.pathHint);
  if (typeof src.note === 'string' && src.note) item.note = capField(src.note);
  return item;
}

function sanitizeItemsForRead(raw: unknown): ThemeChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  const items: ThemeChecklistItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (items.length >= MAX_CHECKLIST_ITEMS_PER_SCOPE) break;
    const item = sanitizeChecklistItemForRead(entry);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

export function defaultChecklistItems(): ThemeChecklistItem[] {
  return DEFAULT_THEME_CHECKLIST.map((item) => ({ ...item }));
}

// ---------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------

/** Directories whose `tmp-*` debris has already been swept this process. */
const sweptDirs = new Set<string>();
let writeSequence = 0;

/**
 * Delete leftover `qa-checklist.json.tmp-*` files once per directory per
 * process — debris from a crashed write must not accumulate or be mistaken for
 * content on the next open.
 */
export function sweepTmpFiles(dir: string): void {
  if (sweptDirs.has(dir)) return;
  sweptDirs.add(dir);
  try {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${THEME_CHECKLIST_FILENAME}.tmp-`)) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // best effort — a locked leftover is retried by the next process
      }
    }
  } catch {
    // unreadable dir — reads below report "absent" honestly
  }
}

/**
 * Fresh-from-disk read of the whole checklist file. No shared cache: two
 * surfaces (toolbar CAS + agent per-item ops) may interleave, and only a fresh
 * read inside the same sync step keeps them linearizable. A missing or corrupt
 * file yields an empty document with `existed:false` — the caller falls back
 * to defaults rather than failing the checklist.
 */
export function readChecklistFile(workspaceRoot: string): { existed: boolean; data: ChecklistFileData } {
  const filePath = checklistFilePath(workspaceRoot);
  sweepTmpFiles(path.dirname(filePath));
  let parsed: unknown;
  try {
    if (!fs.existsSync(filePath)) return { existed: false, data: { version: 1, scopes: {} } };
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { existed: false, data: { version: 1, scopes: {} } };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { existed: false, data: { version: 1, scopes: {} } };
  }
  const container = parsed as Record<string, unknown>; // object proven above; scope rows re-validated below
  const rawScopes = container.scopes;
  const scopes: Record<string, ChecklistScopeRecord> = {};
  if (rawScopes && typeof rawScopes === 'object' && !Array.isArray(rawScopes)) {
    for (const [scope, value] of Object.entries(rawScopes as Record<string, unknown>)) {
      if (!scope || scope.length > MAX_CHECKLIST_FIELD_CHARS) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const rec = value as Record<string, unknown>; // fields coerced on read
      scopes[scope] = {
        items: sanitizeItemsForRead(rec.items),
        updatedAt: typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0,
        ...(rec.legacyMigrated === true ? { legacyMigrated: true as const } : {}),
      };
    }
  }
  return { existed: true, data: { version: 1, scopes } };
}

/**
 * The one atomic write of the checklist file. Temp + rename first; when the
 * rename is refused (Windows lock/AV/EPERM) fall back to a direct write of the
 * same serialized payload, then clean the temp. A fully failed write throws —
 * callers must never pretend a persist happened.
 */
export function writeChecklistFileAtomic(workspaceRoot: string, data: ChecklistFileData): void {
  const filePath = checklistFilePath(workspaceRoot);
  const tempPath = `${filePath}.tmp-${process.pid}-${++writeSequence}-${Date.now()}`;
  const serialized = JSON.stringify(data, null, 2);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      fs.writeFileSync(tempPath, serialized, 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch {
      // Windows safe fallback: write directly to the target when the rename is
      // refused, then drop the staged temp so it never counts as content.
      fs.writeFileSync(filePath, serialized, 'utf8');
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
    }
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
    const message = err instanceof Error ? err.message : String(err);
    throw new CapabilityError('DURABILITY_FAILED', `Failed to persist theme checklist: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Pure scope operations (also reused for provisional, in-memory scopes)
// ---------------------------------------------------------------------------

function validateItemId(itemId: unknown): string {
  const id = capField(itemId).trim();
  if (!id) throw new CapabilityError('INVALID_ARGUMENT', 'Checklist operation requires a non-empty itemId');
  return id;
}

/**
 * Apply one per-item op to a checklist array. Pure: the caller owns where the
 * array came from and where the result is written.
 */
export function applyChecklistMutation(items: ThemeChecklistItem[], op: ChecklistMutationOp): {
  items: ThemeChecklistItem[];
  item?: ThemeChecklistItem;
  toggled?: number;
  removed?: boolean;
  changed: boolean;
} {
  switch (op.op) {
    case 'mark': {
      const id = validateItemId(op.itemId);
      const index = items.findIndex((entry) => entry.id === id);
      if (index < 0) throw new CapabilityError('INVALID_ARGUMENT', `Checklist item "${id}" does not exist`);
      const next = items.slice();
      const item = { ...next[index]!, done: op.done === true };
      if (op.note !== undefined) item.note = capField(op.note);
      next[index] = item;
      return { items: next, item, changed: true };
    }
    case 'add': {
      const item = validateChecklistItem(op.item, 'added item');
      const existing = items.find((entry) => entry.id === item.id);
      // Caller-supplied ids make retries no-ops: re-adding an id returns the row
      // already there instead of duplicating or overwriting it.
      if (existing) return { items, item: existing, changed: false };
      if (items.length >= MAX_CHECKLIST_ITEMS_PER_SCOPE) {
        throw new CapabilityError('INVALID_ARGUMENT', `Checklist exceeds ${MAX_CHECKLIST_ITEMS_PER_SCOPE} items per scope`);
      }
      return { items: [...items, item], item, changed: true };
    }
    case 'remove': {
      const id = validateItemId(op.itemId);
      const exists = items.some((entry) => entry.id === id);
      if (!exists) return { items, removed: false, changed: false };
      return { items: items.filter((entry) => entry.id !== id), removed: true, changed: true };
    }
    case 'markPage': {
      const page = capField(op.page).trim();
      if (!CHECKLIST_PAGE_KEY_PATTERN.test(page)) {
        throw new CapabilityError('INVALID_ARGUMENT', `Checklist page "${page}" must match ${CHECKLIST_PAGE_KEY_PATTERN}`);
      }
      let toggled = 0;
      const next = items.map((entry) => {
        if (entry.page !== page) return entry;
        const done = op.done === true;
        if (entry.done === done) return entry;
        toggled += 1;
        return { ...entry, done };
      });
      return { items: next, toggled, changed: toggled > 0 };
    }
    default: {
      // `op` is typed as the closed union; this only runs for runtime input
      // that bypassed the type system, so narrow before reading it.
      const raw: unknown = op;
      const opName = raw && typeof raw === 'object' && 'op' in raw ? String(raw.op) : String(raw);
      throw new CapabilityError('INVALID_ARGUMENT', `Unknown checklist operation: ${opName}`);
    }
  }
}

/**
 * Read one scope. Absent or corrupt records seed a fresh copy of the default
 * checklist — identical to what the toolbar renders before any persisted state.
 */
export function getScope(workspaceRoot: string, scope: string): ChecklistScopeSnapshot {
  const { data } = readChecklistFile(workspaceRoot);
  const rec = data.scopes[scope];
  if (!rec) {
    return { items: defaultChecklistItems(), updatedAt: 0, existed: false, migrated: false };
  }
  return { items: rec.items, updatedAt: rec.updatedAt, existed: true, migrated: rec.legacyMigrated === true };
}

/**
 * Per-item mutation: re-read the file, apply, write — one uninterrupted sync
 * step so a toolbar CAS save can never slip between the read and the write.
 */
export function mutateScope(workspaceRoot: string, scope: string, op: ChecklistMutationOp): ChecklistMutationResult {
  const { data } = readChecklistFile(workspaceRoot);
  const rec = data.scopes[scope];
  const base = rec?.items ?? defaultChecklistItems();
  const applied = applyChecklistMutation(base, op);
  if (!applied.changed) {
    return { items: base, updatedAt: rec?.updatedAt ?? 0, item: applied.item, toggled: applied.toggled, removed: applied.removed };
  }
  const updatedAt = Date.now();
  data.scopes[scope] = {
    items: applied.items,
    updatedAt,
    ...(rec?.legacyMigrated === true ? { legacyMigrated: true as const } : {}),
  };
  writeChecklistFileAtomic(workspaceRoot, data);
  return { items: applied.items, updatedAt, item: applied.item, toggled: applied.toggled, removed: applied.removed };
}

/**
 * Whole-array CAS save for the toolbar: the write lands only while the stored
 * `updatedAt` still equals the caller's `baseUpdatedAt` snapshot. A conflict
 * returns the fresh items and writes nothing — the caller re-bases on them
 * instead of blindly overwriting the interleaved mutation (F6). A save also
 * marks the record `legacyMigrated`: the toolbar's whole-array payload IS the
 * legacy localStorage state landing in the file.
 */
export function setScopeCas(
  workspaceRoot: string,
  scope: string,
  items: unknown,
  baseUpdatedAt?: number,
): ChecklistCasResult {
  const { data } = readChecklistFile(workspaceRoot);
  const rec = data.scopes[scope];
  // An existing record requires a valid CAS base: `baseUpdatedAt` absent or
  // non-finite means the caller skipped the LOAD that prices the write —
  // treating that as unconditional overwrite would clobber any interleaved
  // agent mutation (AU8 regression-gate contract).
  if (rec && (typeof baseUpdatedAt !== 'number' || !Number.isFinite(baseUpdatedAt) || rec.updatedAt !== baseUpdatedAt)) {
    return { conflict: true, items: rec.items, updatedAt: rec.updatedAt };
  }
  const validated = validateChecklistItems(items);
  const updatedAt = Date.now();
  data.scopes[scope] = { items: validated, updatedAt, legacyMigrated: true };
  writeChecklistFileAtomic(workspaceRoot, data);
  return { conflict: false, items: validated, updatedAt };
}
