/**
 * AntiFan Browser Desktop — Window State Manager
 *
 * Persists placement per window owner. Two facts are stored independently for every owner:
 * the saved NORMAL (restored-from-maximize) outer bounds and the explicit maximize intent —
 * neither is derived from the other. Every placement is validated against the *usable* work
 * area of the displays that currently exist, so a window whose monitor was unplugged, or whose
 * work area shrank, comes back with a reachable titlebar and reports honestly when it cannot
 * fully fit. All values are device-independent pixels; a display scale factor never multiplies
 * them. Records are keyed by the shell's serialized owner key (`ownerKey`), which carries the
 * owner kind, so a project and the Unassigned surface can never collide in one file.
 */
import * as fs from 'fs';
import * as path from 'path';
import { screen } from 'electron';

/** Outer window rectangle in device-independent pixels. */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A window rectangle whose position is optional: a record that was never positioned keeps
 * `x`/`y` unset so the shell can fall back to the platform's own default placement.
 */
export interface WindowPlacementBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface WindowState extends WindowPlacementBounds {
  isMaximized: boolean;
}

/** Persisted state of one window owner. */
export interface WindowStateRecord {
  /** Saved normal bounds; survives a maximize and is repaired independently of it. */
  normal: WindowPlacementBounds | null;
  /** Explicit maximize intent. */
  isMaximized: boolean;
}

/** The display facts placement validation needs; an Electron `Display` satisfies it. */
export interface WindowStateDisplay {
  id: number;
  bounds: WindowRect;
  workArea: WindowRect;
  /** Informational only: DIP coordinates are never multiplied by the scale factor. */
  scaleFactor?: number;
}

export type WindowStateDisplayEvent = 'display-removed' | 'display-metrics-changed';

export interface WindowStateDisplaySource {
  getAllDisplays(): WindowStateDisplay[];
  on(event: WindowStateDisplayEvent, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: WindowStateDisplayEvent, listener: (...args: unknown[]) => void): unknown;
}

/** The subset of `BrowserWindow` this manager drives; a real BrowserWindow satisfies it. */
export interface WindowStateTarget {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isMinimized(): boolean;
  /** Absent means "assume a user could have seen it"; `false` blocks maximize-intent capture. */
  isVisible?(): boolean;
  getBounds(): WindowRect;
  getNormalBounds?(): WindowRect;
  setBounds?(bounds: WindowRect): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface WindowPlacementResolution {
  /** Bounds to hand to a shell: DIP coordinates clamped into a usable work area when possible. */
  bounds: WindowPlacementBounds;
  isMaximized: boolean;
  /** Display the placement was validated against; `null` when nothing could be verified. */
  displayId: number | null;
  /** True when the saved position had to be clamped to stay reachable. */
  repositioned: boolean;
  /** True when the window is larger than the work area and therefore cannot fully fit. */
  exceedsWorkArea: boolean;
  /** True when a usable slice of the titlebar lies inside the work area. */
  titlebarReachable: boolean;
}

/** Schema version of window-state.json. Version 1 was a single flat window rectangle. */
export const WINDOW_STATE_FILE_VERSION = 2;

/** Owner key of a window that belongs to no project; also where legacy records migrate. */
export const DEFAULT_WINDOW_STATE_OWNER_KEY = 'unassigned';

/** Smallest window the manager hands to a shell. */
export const MIN_WINDOW_WIDTH = 500;
export const MIN_WINDOW_HEIGHT = 350;

/** Titlebar slice that must stay inside a work area before a placement counts as reachable. */
export const MIN_VISIBLE_TITLEBAR_WIDTH = 160;

/** Native titlebar height that must fit at the top of a work area (DIP). */
export const TITLEBAR_HEIGHT = 32;

/** Debounce for high-frequency move/resize captures. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Collision-free storage key for an owner. Callers pass the serialized owner key
 * (`project:<id>` or `unassigned`), so a project named "unassigned" cannot alias the
 * Unassigned owner and two projects can never share one record.
 */
export function normalizeOwnerKey(ownerKey?: string | null): string {
  const trimmed = typeof ownerKey === 'string' ? ownerKey.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_WINDOW_STATE_OWNER_KEY;
}

interface PersistedWindowStateFile {
  version: number;
  windows: Record<string, WindowStateRecord>;
}

interface PersistedWindowStateRead {
  status: 'absent' | 'current' | 'legacy' | 'unreadable';
  records: Map<string, WindowStateRecord>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampNumber(value: number, boundA: number, boundB: number): number {
  const min = Math.min(boundA, boundB);
  const max = Math.max(boundA, boundB);
  return Math.min(Math.max(value, min), max);
}

function rectsEqual(a: WindowRect, b: WindowRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Whether a user could have seen this window. Maximize intent is user knowledge, so it is only
 * read back from a window that was shown; a platform that cannot answer counts as shown.
 */
function isTargetVisible(target: WindowStateTarget): boolean {
  if (typeof target.isVisible !== 'function') return true;
  try {
    return target.isVisible();
  } catch {
    return true;
  }
}

export class WindowStateManager {
  private readonly stateFilePath: string;
  private readonly defaultWidth: number;
  private readonly defaultHeight: number;
  private readonly injectedDisplaySource: WindowStateDisplaySource | null;
  private readonly records = new Map<string, WindowStateRecord>();
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  private readonly managedTargets = new Map<string, Set<WindowStateTarget>>();
  private displayListenersAttached = false;

  /** Display events are handled independently: a removal never waits for a metrics change. */
  private readonly onDisplayRemoved = (): void => {
    this.repairManagedPlacements('display-removed');
  };
  private readonly onDisplayMetricsChanged = (): void => {
    this.repairManagedPlacements('display-metrics-changed');
  };

  constructor(
    userDataPath: string,
    defaultWidth = 1360,
    defaultHeight = 880,
    stateFileName = 'window-state.json',
    displaySource?: WindowStateDisplaySource | null,
  ) {
    this.stateFilePath = path.join(userDataPath, stateFileName);
    this.defaultWidth = defaultWidth;
    this.defaultHeight = defaultHeight;
    this.injectedDisplaySource = displaySource ?? null;

    const loaded = WindowStateManager.readStateFile(this.stateFilePath);
    for (const [key, record] of loaded.records) {
      this.records.set(key, record);
    }
    if (loaded.status === 'legacy') {
      console.info(
        `[antifan] Legacy window state found; it migrates into the "${DEFAULT_WINDOW_STATE_OWNER_KEY}" record on the next save.`,
      );
    }
  }

  /** Saved values for one owner; unvalidated, so callers must not place a window with them directly. */
  public getState(ownerKey?: string): WindowState {
    const record = this.records.get(normalizeOwnerKey(ownerKey));
    const normal = record?.normal ?? null;
    const positioned = normal && isFiniteNumber(normal.x) && isFiniteNumber(normal.y)
      ? { x: normal.x, y: normal.y }
      : {};
    return {
      ...positioned,
      width: normal?.width ?? this.defaultWidth,
      height: normal?.height ?? this.defaultHeight,
      isMaximized: record?.isMaximized ?? false,
    };
  }

  /** Placeable bounds for one owner, clamped into a usable work area. */
  public getValidBounds(ownerKey?: string): WindowState {
    const resolution = this.getPlacement(ownerKey);
    return { ...resolution.bounds, isMaximized: resolution.isMaximized };
  }

  /** Full validation result for one owner, including honesty about what does not fit. */
  public getPlacement(ownerKey?: string): WindowPlacementResolution {
    return this.resolveRecordPlacement(this.records.get(normalizeOwnerKey(ownerKey)));
  }

  /**
   * Validate a flat record against the given displays (or the live display layout). Used by
   * auxiliary windows that keep a single record rather than a per-owner one.
   */
  public static validateBounds(
    bounds?: Partial<WindowState>,
    defaultWidth = 900,
    defaultHeight = 600,
    displays?: readonly WindowStateDisplay[],
  ): WindowState {
    const resolution = WindowStateManager.resolvePlacement(
      bounds ?? null,
      Boolean(bounds?.isMaximized),
      displays ?? WindowStateManager.readDisplays(WindowStateManager.electronDisplaySource()),
      defaultWidth,
      defaultHeight,
    );
    return { ...resolution.bounds, isMaximized: resolution.isMaximized };
  }

  /**
   * Pure placement resolution: no Electron, no I/O. `saved` is the stored normal rectangle;
   * `isMaximized` travels separately so intent is never inferred from geometry.
   */
  public static resolvePlacement(
    saved: Partial<WindowPlacementBounds> | null | undefined,
    isMaximized: boolean,
    displays: readonly WindowStateDisplay[],
    defaultWidth = 900,
    defaultHeight = 600,
  ): WindowPlacementResolution {
    const width = WindowStateManager.resolveDimension(saved?.width, defaultWidth, MIN_WINDOW_WIDTH);
    const height = WindowStateManager.resolveDimension(saved?.height, defaultHeight, MIN_WINDOW_HEIGHT);
    const savedX = isFiniteNumber(saved?.x) ? saved.x : undefined;
    const savedY = isFiniteNumber(saved?.y) ? saved.y : undefined;

    // Nothing was ever positioned: leave the position to the platform instead of inventing one.
    if (savedX === undefined || savedY === undefined) {
      return {
        bounds: { width, height },
        isMaximized,
        displayId: null,
        repositioned: false,
        exceedsWorkArea: false,
        titlebarReachable: false,
      };
    }

    const display = WindowStateManager.selectDisplay(displays, { x: savedX, y: savedY, width, height });
    if (!display) {
      return {
        bounds: { x: savedX, y: savedY, width, height },
        isMaximized,
        displayId: null,
        repositioned: false,
        exceedsWorkArea: false,
        titlebarReachable: false,
      };
    }

    const workArea = display.workArea ?? display.bounds;
    const x = WindowStateManager.clampHorizontal(savedX, width, workArea);
    const y = WindowStateManager.clampVertical(savedY, height, workArea);
    const bounds: WindowRect = { x, y, width, height };
    return {
      bounds,
      isMaximized,
      displayId: display.id,
      repositioned: x !== savedX || y !== savedY,
      exceedsWorkArea: width > workArea.width || height > workArea.height,
      titlebarReachable: WindowStateManager.isTitlebarReachable(bounds, workArea),
    };
  }

  /**
   * Track one window: capture its placement on every transition and repair it on display changes.
   * Saved maximize intent survives a window that is closed before it was ever shown, so a shell
   * created hidden for an agent does not consume the intent the user left behind.
   */
  public manage(window: WindowStateTarget, ownerKey?: string): void {
    const key = normalizeOwnerKey(ownerKey);
    let targets = this.managedTargets.get(key);
    if (!targets) {
      targets = new Set<WindowStateTarget>();
      this.managedTargets.set(key, targets);
    }
    targets.add(window);
    this.attachDisplayListeners();

    const capture = (repair: boolean, immediate: boolean) => {
      try {
        this.capturePlacement(key, window, { repair, immediate });
      } catch (err) {
        console.warn('[antifan] Error updating window state:', err);
      }
    };

    window.on('resize', () => capture(false, false));
    window.on('move', () => capture(false, false));
    window.on('maximize', () => capture(false, true));
    // The platform restores the rectangle it held when the window was maximized, which may be
    // the one on a monitor that is gone; re-validate it before it becomes the live placement.
    window.on('unmaximize', () => capture(true, true));
    window.on('close', () => capture(false, true));
    window.on('closed', () => {
      this.forgetTarget(key, window);
    });
  }

  private capturePlacement(
    key: string,
    target: WindowStateTarget,
    options: { repair: boolean; immediate: boolean },
  ): void {
    if (target.isDestroyed()) return;
    const record = this.recordFor(key);
    const isMaximized = target.isMaximized();
    const current = WindowStateManager.readTargetRect(target, 'bounds');
    const normal = WindowStateManager.readTargetRect(target, 'normal') ?? current;
    // A window that was never shown cannot express user intent: an agent-created shell that is
    // built hidden and closed before presentation must not erase the saved maximize intent.
    const visible = isTargetVisible(target);
    if (visible) record.isMaximized = isMaximized;
    const intent = visible ? isMaximized : record.isMaximized;

    if (isMaximized) {
      // getNormalBounds() reports the pre-maximize rectangle on Windows and macOS, but a few
      // Linux builds report the maximized one; never overwrite a saved normal rectangle with it.
      if (normal && (!current || !rectsEqual(normal, current))) {
        record.normal = { x: normal.x, y: normal.y, width: normal.width, height: normal.height };
      }
    } else if (!target.isMinimized() && normal) {
      record.normal = { x: normal.x, y: normal.y, width: normal.width, height: normal.height };
    }

    if (options.repair) {
      this.repairPlacement(record, intent || target.isMinimized() ? null : target);
    }
    this.scheduleSave(key, options.immediate);
  }

  /**
   * Clamp a record into a reachable placement. A maximized or minimized window passes `null`:
   * its saved normal bounds are still repaired, its live placement is left alone.
   */
  private repairPlacement(record: WindowStateRecord, target: WindowStateTarget | null): void {
    const resolution = this.resolveRecordPlacement(record);
    const x = resolution.bounds.x;
    const y = resolution.bounds.y;
    if (resolution.displayId === null || !isFiniteNumber(x) || !isFiniteNumber(y)) return;
    if (!resolution.repositioned) return;

    const repaired: WindowRect = { x, y, width: resolution.bounds.width, height: resolution.bounds.height };
    record.normal = repaired;
    if (!target || target.isDestroyed() || target.isMaximized() || target.isMinimized()) return;

    const current =
      WindowStateManager.readTargetRect(target, 'bounds') ?? WindowStateManager.readTargetRect(target, 'normal');
    if (current && rectsEqual(current, repaired)) return;
    try {
      target.setBounds?.({ ...repaired });
    } catch (err) {
      console.warn('[antifan] Failed to move a window back into a usable work area:', err);
    }
  }

  private repairManagedPlacements(reason: WindowStateDisplayEvent): void {
    if (this.managedTargets.size === 0) return;
    for (const [key, targets] of [...this.managedTargets]) {
      for (const target of [...targets]) {
        try {
          if (target.isDestroyed()) {
            targets.delete(target);
            continue;
          }
          this.capturePlacement(key, target, { repair: true, immediate: false });
        } catch (err) {
          console.warn(`[antifan] Window state repair failed after ${reason}:`, err);
        }
      }
      if (targets.size === 0) this.managedTargets.delete(key);
      // A display change is structural: persist the repair now instead of waiting out the debounce.
      this.flushSave(key);
    }
  }

  private forgetTarget(key: string, target: WindowStateTarget): void {
    const targets = this.managedTargets.get(key);
    if (targets) {
      targets.delete(target);
      if (targets.size === 0) this.managedTargets.delete(key);
    }
    if (this.managedTargets.size === 0) this.detachDisplayListeners();
  }

  private attachDisplayListeners(): void {
    if (this.displayListenersAttached) return;
    const source = this.resolveDisplaySource();
    if (!source) return;
    try {
      source.on('display-removed', this.onDisplayRemoved);
      source.on('display-metrics-changed', this.onDisplayMetricsChanged);
      this.displayListenersAttached = true;
    } catch (err) {
      console.warn('[antifan] Failed to subscribe to display changes:', err);
    }
  }

  private detachDisplayListeners(): void {
    if (!this.displayListenersAttached) return;
    this.displayListenersAttached = false;
    const source = this.resolveDisplaySource();
    if (!source || typeof source.removeListener !== 'function') return;
    try {
      source.removeListener('display-removed', this.onDisplayRemoved);
      source.removeListener('display-metrics-changed', this.onDisplayMetricsChanged);
    } catch (err) {
      console.warn('[antifan] Failed to unsubscribe from display changes:', err);
    }
  }

  private resolveDisplaySource(): WindowStateDisplaySource | null {
    return this.injectedDisplaySource ?? WindowStateManager.electronDisplaySource();
  }

  private listDisplays(): WindowStateDisplay[] {
    return WindowStateManager.readDisplays(this.resolveDisplaySource());
  }

  private resolveRecordPlacement(record: WindowStateRecord | undefined): WindowPlacementResolution {
    return WindowStateManager.resolvePlacement(
      record?.normal ?? null,
      record?.isMaximized ?? false,
      this.listDisplays(),
      this.defaultWidth,
      this.defaultHeight,
    );
  }

  private recordFor(ownerKey: string): WindowStateRecord {
    let record = this.records.get(ownerKey);
    if (!record) {
      record = { normal: null, isMaximized: false };
      this.records.set(ownerKey, record);
    }
    return record;
  }

  private scheduleSave(ownerKey: string, immediate: boolean): void {
    const pending = this.saveTimers.get(ownerKey);
    if (pending) {
      clearTimeout(pending);
      this.saveTimers.delete(ownerKey);
    }
    if (immediate) {
      this.saveStateSync(ownerKey);
      return;
    }
    const timer = setTimeout(() => {
      this.saveTimers.delete(ownerKey);
      this.saveStateSync(ownerKey);
    }, SAVE_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.saveTimers.set(ownerKey, timer);
  }

  private flushSave(ownerKey: string): void {
    const pending = this.saveTimers.get(ownerKey);
    if (pending) {
      clearTimeout(pending);
      this.saveTimers.delete(ownerKey);
    }
    this.saveStateSync(ownerKey);
  }

  /**
   * Merge this record into the file and swap it in atomically. Prior records — including a
   * legacy file that has not migrated yet — are read back and preserved; a candidate that fails
   * to write or read back leaves the file exactly as it was.
   */
  private saveStateSync(ownerKey: string): void {
    const record = this.records.get(ownerKey);
    if (!record) return;
    try {
      const existing = WindowStateManager.readStateFile(this.stateFilePath);
      if (existing.status === 'unreadable') this.preserveUnreadableFile();
      const merged = new Map(existing.records);
      // An empty in-memory record never overwrites what another window already persisted.
      if (record.normal || record.isMaximized || !merged.has(ownerKey)) {
        merged.set(ownerKey, {
          normal: record.normal ? { ...record.normal } : null,
          isMaximized: record.isMaximized,
        });
      }
      this.writeStateFile(WindowStateManager.buildDocument(merged));
    } catch (err) {
      console.warn('[antifan] Failed to save window state:', err);
    }
  }

  private preserveUnreadableFile(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recoveryPath = `${this.stateFilePath}.corrupt-${stamp}`;
    fs.copyFileSync(this.stateFilePath, recoveryPath);
    console.warn(
      `[antifan] Window state file was unreadable; preserved it as ${path.basename(recoveryPath)} before rewriting.`,
    );
  }

  private writeStateFile(document: PersistedWindowStateFile): void {
    const serialized = JSON.stringify(document, null, 2);
    if (WindowStateManager.readTextQuietly(this.stateFilePath) === serialized) return;

    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    // Staged beside the target so the swap stays on one volume, and process-unique so another
    // process can never overwrite this process's candidate mid-write.
    const tempPath = `${this.stateFilePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempPath, serialized, 'utf-8');
      // Read the candidate back before the swap: a document that cannot be parsed back, or that
      // lost a record, must never replace what is already on disk.
      const readback = JSON.parse(fs.readFileSync(tempPath, 'utf-8')) as unknown;
      const lostRecords =
        !WindowStateManager.isPersistedDocument(readback) ||
        Object.keys(document.windows).some((key) => !(key in readback.windows));
      if (lostRecords) {
        throw new Error('window state readback did not reproduce the written document');
      }
      fs.renameSync(tempPath, this.stateFilePath);
    } catch (err) {
      WindowStateManager.removeFileQuietly(tempPath);
      throw err;
    }
  }

  private static buildDocument(records: Map<string, WindowStateRecord>): PersistedWindowStateFile {
    // Null prototype: owner keys are arbitrary strings and must never collide with Object.prototype.
    const windows: Record<string, WindowStateRecord> = Object.create(null);
    for (const [key, record] of records) {
      if (!record.normal && !record.isMaximized) continue;
      windows[key] = {
        normal: record.normal ? { ...record.normal } : null,
        isMaximized: record.isMaximized,
      };
    }
    return { version: WINDOW_STATE_FILE_VERSION, windows };
  }

  private static isPersistedDocument(value: unknown): value is PersistedWindowStateFile {
    return (
      isPlainObject(value) &&
      value.version === WINDOW_STATE_FILE_VERSION &&
      isPlainObject(value.windows)
    );
  }

  private static readStateFile(filePath: string): PersistedWindowStateRead {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { status: 'absent', records: new Map() };
      }
      console.warn('[antifan] Failed to read window state:', err);
      return { status: 'unreadable', records: new Map() };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn('[antifan] Failed to parse window state:', err);
      return { status: 'unreadable', records: new Map() };
    }
    return WindowStateManager.interpretStateFile(parsed);
  }

  private static interpretStateFile(parsed: unknown): PersistedWindowStateRead {
    if (!isPlainObject(parsed)) return { status: 'unreadable', records: new Map() };

    if (parsed.version === WINDOW_STATE_FILE_VERSION && isPlainObject(parsed.windows)) {
      const records = new Map<string, WindowStateRecord>();
      for (const [key, value] of Object.entries(parsed.windows)) {
        const record = WindowStateManager.decodeRecord(value);
        if (record) records.set(key, record);
      }
      return { status: 'current', records };
    }

    // Version 1 was the rectangle of the single window the app had; it belongs to Unassigned.
    const legacy = WindowStateManager.decodeLegacyRecord(parsed);
    if (legacy) {
      return { status: 'legacy', records: new Map([[DEFAULT_WINDOW_STATE_OWNER_KEY, legacy]]) };
    }
    return { status: 'unreadable', records: new Map() };
  }

  private static decodeRecord(value: unknown): WindowStateRecord | null {
    if (!isPlainObject(value)) return null;
    const normal = WindowStateManager.decodeNormalBounds(value.normal);
    const isMaximized = Boolean(value.isMaximized);
    if (!normal && !isMaximized) return null;
    return { normal, isMaximized };
  }

  private static decodeLegacyRecord(value: unknown): WindowStateRecord | null {
    const normal = WindowStateManager.decodeNormalBounds(value);
    if (!normal) return null;
    return { normal, isMaximized: isPlainObject(value) && Boolean(value.isMaximized) };
  }

  private static decodeNormalBounds(value: unknown): WindowPlacementBounds | null {
    if (!isPlainObject(value)) return null;
    const { width, height } = value;
    if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return null;
    const normal: WindowPlacementBounds = { width, height };
    if (isFiniteNumber(value.x)) normal.x = value.x;
    if (isFiniteNumber(value.y)) normal.y = value.y;
    return normal;
  }

  private static resolveDimension(value: unknown, fallback: number, minimum: number): number {
    const candidate = isFiniteNumber(value) && value > 0 ? value : fallback;
    return Math.max(minimum, Math.round(isFiniteNumber(candidate) ? candidate : minimum));
  }

  /** Largest work-area overlap wins; with no overlap at all, the nearest usable work area wins. */
  private static selectDisplay(
    displays: readonly WindowStateDisplay[],
    rect: WindowRect,
  ): WindowStateDisplay | null {
    let best: WindowStateDisplay | null = null;
    let bestOverlap = 0;
    for (const display of displays) {
      const workArea = display.workArea ?? display.bounds;
      const overlapWidth =
        Math.min(rect.x + rect.width, workArea.x + workArea.width) - Math.max(rect.x, workArea.x);
      const overlapHeight =
        Math.min(rect.y + rect.height, workArea.y + workArea.height) - Math.max(rect.y, workArea.y);
      const overlap = overlapWidth > 0 && overlapHeight > 0 ? overlapWidth * overlapHeight : 0;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = display;
      }
    }
    if (best) return best;

    const anchorX = rect.x + rect.width / 2;
    const anchorY = rect.y + TITLEBAR_HEIGHT / 2;
    let nearest: WindowStateDisplay | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const display of displays) {
      const workArea = display.workArea ?? display.bounds;
      const nearestX = clampNumber(anchorX, workArea.x, workArea.x + workArea.width);
      const nearestY = clampNumber(anchorY, workArea.y, workArea.y + workArea.height);
      const distance = (anchorX - nearestX) ** 2 + (anchorY - nearestY) ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = display;
      }
    }
    return nearest;
  }

  private static clampHorizontal(x: number, width: number, workArea: WindowRect): number {
    if (width <= workArea.width) {
      return clampNumber(x, workArea.x, workArea.x + workArea.width - width);
    }
    // Wider than the work area: it cannot fully fit, so keep the window controls — drawn at the
    // right end of the titlebar — inside and report the shortfall instead of shrinking the window.
    const rightAligned = workArea.x + workArea.width - width;
    const leftLimit = workArea.x + MIN_VISIBLE_TITLEBAR_WIDTH - width;
    return clampNumber(x, Math.min(rightAligned, leftLimit), rightAligned);
  }

  private static clampVertical(y: number, height: number, workArea: WindowRect): number {
    if (height <= workArea.height) {
      return clampNumber(y, workArea.y, workArea.y + workArea.height - height);
    }
    // Taller than the work area: keep the titlebar itself inside so the window stays draggable.
    return clampNumber(y, workArea.y, workArea.y + workArea.height - TITLEBAR_HEIGHT);
  }

  private static isTitlebarReachable(bounds: WindowRect, workArea: WindowRect): boolean {
    const visibleWidth =
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
    const titlebarInside = bounds.y >= workArea.y && bounds.y + TITLEBAR_HEIGHT <= workArea.y + workArea.height;
    return visibleWidth >= MIN_VISIBLE_TITLEBAR_WIDTH && titlebarInside;
  }

  private static readTargetRect(target: WindowStateTarget, kind: 'bounds' | 'normal'): WindowRect | null {
    try {
      const rect =
        kind === 'normal'
          ? typeof target.getNormalBounds === 'function'
            ? target.getNormalBounds()
            : undefined
          : target.getBounds();
      if (!rect) return null;
      return isFiniteNumber(rect.x) && isFiniteNumber(rect.y) && isFiniteNumber(rect.width) && isFiniteNumber(rect.height)
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null;
    } catch {
      return null;
    }
  }

  private static electronDisplaySource(): WindowStateDisplaySource | null {
    try {
      // `screen` is undefined outside an Electron main process (node CLI, tests); the manager
      // stays usable there and simply reports placements as unverified.
      const candidate = screen as WindowStateDisplaySource | undefined;
      return candidate && typeof candidate.getAllDisplays === 'function' ? candidate : null;
    } catch {
      return null;
    }
  }

  private static readDisplays(source: WindowStateDisplaySource | null): WindowStateDisplay[] {
    if (!source || typeof source.getAllDisplays !== 'function') return [];
    try {
      const displays = source.getAllDisplays();
      return Array.isArray(displays) ? displays : [];
    } catch (err) {
      console.warn('[antifan] Failed to read the display layout:', err);
      return [];
    }
  }

  private static readTextQuietly(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  private static removeFileQuietly(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup: the caller keeps the real failure, and a leftover temp file is
      // harmless because the next save overwrites it before the atomic swap.
    }
  }
}
