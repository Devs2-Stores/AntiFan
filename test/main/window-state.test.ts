import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  DEFAULT_WINDOW_STATE_OWNER_KEY,
  MIN_VISIBLE_TITLEBAR_WIDTH,
  WINDOW_STATE_FILE_VERSION,
  WindowStateManager,
  type WindowPlacementBounds,
  type WindowRect,
  type WindowStateDisplay,
  type WindowStateDisplayEvent,
  type WindowStateDisplaySource,
  type WindowStateTarget,
} from '../../src/main/browser/window-state';
import { ownerKey } from '../../src/main/browser/project-window-shell';

/** Canonical serialized keys are produced by the shell's `ownerKey`, never by hand. */
const PROJECT_ALPHA = ownerKey({ kind: 'project', projectId: 'alpha' });
const PROJECT_BETA = ownerKey({ kind: 'project', projectId: 'beta' });
const PROJECT_GAMMA = ownerKey({ kind: 'project', projectId: 'gamma' });
const PROJECT_DELTA = ownerKey({ kind: 'project', projectId: 'delta' });
const PROJECT_LEFT = ownerKey({ kind: 'project', projectId: 'left' });
/** A project whose id collides with the Unassigned sentinel can only differ by its kind. */
const PROJECT_NAMED_UNASSIGNED = ownerKey({ kind: 'project', projectId: 'unassigned' });
const UNASSIGNED = ownerKey({ kind: 'unassigned' });

/** Primary 1080p display with the whole screen usable. */
const PRIMARY: WindowStateDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
};

/** Second 1080p display to the right of the primary one. */
const SECONDARY: WindowStateDisplay = {
  id: 2,
  bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1920, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
};

/** 1080p display to the left of the primary one, driven at 200% scale. */
const LEFT_HIGH_DPI: WindowStateDisplay = {
  id: 3,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
  scaleFactor: 2,
};

interface PersistedRecordShape {
  normal: WindowPlacementBounds | null;
  isMaximized: boolean;
}

interface PersistedFileShape {
  version: number;
  windows: Record<string, PersistedRecordShape>;
}

function makeTempDir(label: string): string {
  const dir = path.join(
    os.tmpdir(),
    `antifan-window-state-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readPersistedFile(dir: string): PersistedFileShape {
  return JSON.parse(fs.readFileSync(path.join(dir, 'window-state.json'), 'utf-8')) as PersistedFileShape;
}

class FakeDisplaySource implements WindowStateDisplaySource {
  public displays: WindowStateDisplay[];
  public readonly emitted: WindowStateDisplayEvent[] = [];
  private readonly listeners = new Map<WindowStateDisplayEvent, Array<(...args: unknown[]) => void>>();

  constructor(displays: WindowStateDisplay[]) {
    this.displays = displays;
  }

  getAllDisplays(): WindowStateDisplay[] {
    return this.displays.map((display) => ({
      ...display,
      bounds: { ...display.bounds },
      workArea: { ...display.workArea },
    }));
  }

  on(event: WindowStateDisplayEvent, listener: (...args: unknown[]) => void): unknown {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  removeListener(event: WindowStateDisplayEvent, listener: (...args: unknown[]) => void): unknown {
    const existing = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      existing.filter((candidate) => candidate !== listener),
    );
    return this;
  }

  emit(event: WindowStateDisplayEvent): void {
    this.emitted.push(event);
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener({});
    }
  }
}

/** Mimics the BrowserWindow surface the manager drives, including platform restore behaviour. */
class FakeWindow implements WindowStateTarget {
  public destroyed = false;
  public maximized = false;
  public minimized = false;
  /** A shell created for an agent is built hidden and shown only on explicit presentation. */
  public visible = true;
  public bounds: WindowRect;
  public normalBounds: WindowRect;
  public readonly setBoundsCalls: WindowRect[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(bounds: WindowRect, normalBounds?: WindowRect) {
    this.bounds = { ...bounds };
    this.normalBounds = { ...(normalBounds ?? bounds) };
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isVisible(): boolean {
    return this.visible;
  }

  getBounds(): WindowRect {
    return { ...this.bounds };
  }

  getNormalBounds(): WindowRect {
    return { ...this.normalBounds };
  }

  setBounds(bounds: WindowRect): void {
    this.setBoundsCalls.push({ ...bounds });
    this.bounds = { ...bounds };
    this.normalBounds = { ...bounds };
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): unknown {
    const existing = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      existing.filter((candidate) => candidate !== listener),
    );
    return this;
  }

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener({});
    }
  }

  /** What the platform does for a maximized window: restore the rectangle it held when maximized. */
  simulateUnmaximize(restored: WindowRect): void {
    this.maximized = false;
    this.bounds = { ...restored };
    this.normalBounds = { ...restored };
    this.emit('unmaximize');
  }
}

describe('AntiFan Window State Manager', () => {
  it('loads default bounds when state file does not exist', () => {
    const tmpDir = path.join(os.tmpdir(), `antifan-test-${Date.now()}`);
    const mgr = new WindowStateManager(tmpDir, 1400, 900);
    const state = mgr.getState();
    assert.strictEqual(state.width, 1400);
    assert.strictEqual(state.height, 900);
    assert.strictEqual(state.isMaximized, false);
  });

  it('loads saved state with multi-monitor coordinates and maximize flag', () => {
    const tmpDir = path.join(os.tmpdir(), `antifan-test-saved-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const savedData = {
      x: 1920,
      y: 100,
      width: 1600,
      height: 1000,
      isMaximized: true,
    };
    fs.writeFileSync(path.join(tmpDir, 'window-state.json'), JSON.stringify(savedData));

    const mgr = new WindowStateManager(tmpDir);
    const state = mgr.getState();
    assert.strictEqual(state.x, 1920);
    assert.strictEqual(state.y, 100);
    assert.strictEqual(state.width, 1600);
    assert.strictEqual(state.height, 1000);
    assert.strictEqual(state.isMaximized, true);
  });

  it('validates against the usable work area rather than the raw display bounds', () => {
    const docked: WindowStateDisplay = {
      id: 7,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1000 },
      scaleFactor: 1,
    };
    // The rectangle sits inside display.bounds but under the bottom taskbar, outside workArea.
    const resolution = WindowStateManager.resolvePlacement(
      { x: 0, y: 900, width: 800, height: 600 },
      false,
      [docked],
    );

    assert.strictEqual(resolution.displayId, docked.id);
    assert.strictEqual(resolution.repositioned, true);
    assert.strictEqual(resolution.bounds.y, 400);
    assert.strictEqual(resolution.bounds.x, 0);
    assert.strictEqual(resolution.titlebarReachable, true);
    assert.strictEqual(resolution.exceedsWorkArea, false);
  });

  it('repairs saved normal bounds and placement when a maximized window loses its monitor', () => {
    const dir = makeTempDir('removed-monitor');
    fs.writeFileSync(
      path.join(dir, 'window-state.json'),
      JSON.stringify({
        version: WINDOW_STATE_FILE_VERSION,
        windows: {
          [PROJECT_ALPHA]: {
            normal: { x: 1920, y: 0, width: 1600, height: 1000 },
            isMaximized: true,
          },
        },
      }),
    );
    const displays = new FakeDisplaySource([PRIMARY, SECONDARY]);
    const mgr = new WindowStateManager(dir, 1360, 880, 'window-state.json', displays);
    const win = new FakeWindow(
      { x: 1920, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 1600, height: 1000 },
    );
    win.maximized = true;
    mgr.manage(win, PROJECT_ALPHA);

    displays.displays = [PRIMARY];
    displays.emit('display-removed');

    const whileMaximized = mgr.getPlacement(PROJECT_ALPHA);
    assert.strictEqual(whileMaximized.isMaximized, true, 'maximize intent survives a display removal');
    assert.strictEqual(whileMaximized.bounds.x, 320, 'the saved normal rectangle is pulled into the remaining work area');
    assert.strictEqual(whileMaximized.bounds.y, 0);
    assert.strictEqual(whileMaximized.titlebarReachable, true);
    assert.deepStrictEqual(win.setBoundsCalls, [], 'a maximized window is not taken out of its state');
    assert.deepStrictEqual(readPersistedFile(dir).windows[PROJECT_ALPHA], {
      normal: { x: 320, y: 0, width: 1600, height: 1000 },
      isMaximized: true,
    });

    win.simulateUnmaximize({ x: 1920, y: 0, width: 1600, height: 1000 });

    assert.deepStrictEqual(
      win.setBoundsCalls.at(-1),
      { x: 320, y: 0, width: 1600, height: 1000 },
      'unmaximizing lands on the repaired placement instead of the vanished monitor',
    );
    assert.deepStrictEqual(readPersistedFile(dir).windows[PROJECT_ALPHA], {
      normal: { x: 320, y: 0, width: 1600, height: 1000 },
      isMaximized: false,
    });
  });

  it('retains valid negative DIP coordinates instead of scaling them', () => {
    const displays = new FakeDisplaySource([PRIMARY, LEFT_HIGH_DPI]);
    const resolution = WindowStateManager.resolvePlacement(
      { x: -1600, y: 120, width: 1200, height: 800 },
      false,
      displays.displays,
    );

    assert.strictEqual(resolution.displayId, LEFT_HIGH_DPI.id);
    assert.deepStrictEqual(resolution.bounds, { x: -1600, y: 120, width: 1200, height: 800 });
    assert.strictEqual(resolution.repositioned, false);
    assert.strictEqual(resolution.titlebarReachable, true);
    assert.strictEqual(resolution.exceedsWorkArea, false);

    const dir = makeTempDir('negative-dip');
    const mgr = new WindowStateManager(dir, 1360, 880, 'window-state.json', displays);
    const win = new FakeWindow({ x: -1600, y: 120, width: 1200, height: 800 });
    mgr.manage(win, PROJECT_LEFT);
    win.emit('close');

    assert.deepStrictEqual(
      readPersistedFile(dir).windows[PROJECT_LEFT]?.normal,
      { x: -1600, y: 120, width: 1200, height: 800 },
      'a 200% display scale factor must not multiply DIP coordinates',
    );
  });

  it('keeps titlebar controls reachable in a work area smaller than the window', () => {
    const small: WindowStateDisplay = {
      id: 9,
      bounds: { x: 0, y: 0, width: 1024, height: 768 },
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      scaleFactor: 1,
    };
    const resolution = WindowStateManager.resolvePlacement(
      { x: 0, y: 0, width: 960, height: 640 },
      false,
      [small],
    );

    assert.strictEqual(resolution.exceedsWorkArea, true, '960x640 does not fit an 800x600 work area');
    assert.strictEqual(resolution.bounds.width, 960, 'the window is not silently shrunk to fit');
    assert.strictEqual(resolution.bounds.height, 640);
    assert.strictEqual(resolution.titlebarReachable, true);
    const placementX = resolution.bounds.x;
    assert.ok(typeof placementX === 'number', 'a reachable placement carries explicit coordinates');
    assert.strictEqual(
      placementX + resolution.bounds.width,
      small.workArea.x + small.workArea.width,
      'the controls at the right end of the titlebar stay inside the work area',
    );

    const bounds = WindowStateManager.validateBounds({ x: 0, y: 0, width: 960, height: 640 }, 900, 600, [small]);
    assert.strictEqual(bounds.width, 960);
    assert.strictEqual(bounds.height, 640);
    assert.strictEqual(bounds.x, -160);
  });

  it('reports an odd work area as unreachable instead of pretending the titlebar fits', () => {
    const odd: WindowStateDisplay = {
      id: 10,
      bounds: { x: 0, y: 0, width: 200, height: 150 },
      workArea: { x: 0, y: 0, width: 120, height: 100 },
      scaleFactor: 1,
    };
    const resolution = WindowStateManager.resolvePlacement(
      { x: 0, y: 0, width: 960, height: 640 },
      false,
      [odd],
    );

    assert.strictEqual(resolution.exceedsWorkArea, true);
    assert.strictEqual(resolution.titlebarReachable, false);
    const placementX = resolution.bounds.x;
    assert.ok(typeof placementX === 'number', 'a placement is still produced for an odd work area');
    assert.ok(
      placementX < odd.workArea.x + MIN_VISIBLE_TITLEBAR_WIDTH,
      'the placement is still pulled toward the work area',
    );
  });

  it('repairs placement from a work-area change without any display removal', () => {
    const dir = makeTempDir('work-area-change');
    const displays = new FakeDisplaySource([PRIMARY, SECONDARY]);
    const mgr = new WindowStateManager(dir, 1360, 880, 'window-state.json', displays);
    const win = new FakeWindow({ x: 1920, y: 0, width: 900, height: 700 });
    mgr.manage(win, PROJECT_BETA);

    displays.displays = [
      PRIMARY,
      {
        ...SECONDARY,
        workArea: { x: 2000, y: 0, width: 1840, height: 1000 },
      },
    ];
    displays.emit('display-metrics-changed');

    assert.deepStrictEqual(displays.emitted, ['display-metrics-changed']);
    assert.deepStrictEqual(win.setBoundsCalls, [{ x: 2000, y: 0, width: 900, height: 700 }]);
    assert.deepStrictEqual(
      readPersistedFile(dir).windows[PROJECT_BETA]?.normal,
      { x: 2000, y: 0, width: 900, height: 700 },
    );
  });

  it('repairs placement from a display removal without any metrics change', () => {
    const dir = makeTempDir('display-removal');
    const displays = new FakeDisplaySource([PRIMARY, SECONDARY]);
    const mgr = new WindowStateManager(dir, 1360, 880, 'window-state.json', displays);
    const win = new FakeWindow({ x: 1920, y: 0, width: 900, height: 700 });
    mgr.manage(win, PROJECT_GAMMA);

    displays.displays = [PRIMARY];
    displays.emit('display-removed');

    assert.deepStrictEqual(displays.emitted, ['display-removed']);
    assert.deepStrictEqual(win.setBoundsCalls, [{ x: 1020, y: 0, width: 900, height: 700 }]);
    assert.deepStrictEqual(
      readPersistedFile(dir).windows[PROJECT_GAMMA]?.normal,
      { x: 1020, y: 0, width: 900, height: 700 },
    );
  });

  it('moves nothing and rewrites nothing when only the scale factor changes', () => {
    const dir = makeTempDir('scale-change');
    const displays = new FakeDisplaySource([PRIMARY, SECONDARY]);
    const mgr = new WindowStateManager(dir, 1360, 880, 'window-state.json', displays);
    const win = new FakeWindow({ x: 1920, y: 0, width: 900, height: 700 });
    mgr.manage(win, PROJECT_DELTA);
    win.emit('close');
    const before = fs.readFileSync(path.join(dir, 'window-state.json'), 'utf-8');

    displays.displays = [
      { ...PRIMARY, scaleFactor: 2 },
      { ...SECONDARY, scaleFactor: 2 },
    ];
    displays.emit('display-metrics-changed');

    assert.deepStrictEqual(win.setBoundsCalls, []);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'window-state.json'), 'utf-8'), before);
    assert.deepStrictEqual(mgr.getValidBounds(PROJECT_DELTA), {
      x: 1920,
      y: 0,
      width: 900,
      height: 700,
      isMaximized: false,
    });
  });

  it('reports an unverified placement instead of claiming reachability without display information', () => {
    const resolution = WindowStateManager.resolvePlacement(
      { x: 100, y: 100, width: 900, height: 700 },
      false,
      [],
    );

    assert.strictEqual(resolution.displayId, null);
    assert.strictEqual(resolution.titlebarReachable, false);
    assert.strictEqual(resolution.exceedsWorkArea, false);
    assert.deepStrictEqual(resolution.bounds, { x: 100, y: 100, width: 900, height: 700 });
    assert.deepStrictEqual(WindowStateManager.validateBounds({ width: 10, height: 10 }, 900, 600, []), {
      width: 500,
      height: 350,
      isMaximized: false,
    });
  });

  it('keeps per-owner records from overwriting each other', () => {
    const dir = makeTempDir('per-owner-keys');

    // The manager's default key must be exactly the shell's Unassigned key, and a project that
    // reuses the word "unassigned" must still be distinguishable from it.
    assert.strictEqual(UNASSIGNED, DEFAULT_WINDOW_STATE_OWNER_KEY);
    assert.notStrictEqual(PROJECT_NAMED_UNASSIGNED, UNASSIGNED);

    const alpha = new WindowStateManager(dir, 1360, 880);
    const alphaWindow = new FakeWindow({ x: 10, y: 20, width: 900, height: 700 });
    alpha.manage(alphaWindow, PROJECT_ALPHA);
    alphaWindow.emit('close');

    const beta = new WindowStateManager(dir, 1360, 880);
    const betaWindow = new FakeWindow({ x: 400, y: 300, width: 1000, height: 800 });
    beta.manage(betaWindow, PROJECT_BETA);
    betaWindow.emit('close');

    const unassigned = new WindowStateManager(dir, 1360, 880);
    const unassignedWindow = new FakeWindow({ x: 40, y: 40, width: 700, height: 500 });
    unassigned.manage(unassignedWindow, UNASSIGNED);
    unassignedWindow.emit('close');

    const projectNamedUnassigned = new WindowStateManager(dir, 1360, 880);
    const collisionWindow = new FakeWindow({ x: 60, y: 60, width: 800, height: 600 });
    projectNamedUnassigned.manage(collisionWindow, PROJECT_NAMED_UNASSIGNED);
    collisionWindow.emit('close');

    const persisted = readPersistedFile(dir);
    assert.deepStrictEqual(
      Object.keys(persisted.windows).sort(),
      [PROJECT_ALPHA, PROJECT_BETA, PROJECT_NAMED_UNASSIGNED, UNASSIGNED].sort(),
    );
    assert.deepStrictEqual(persisted.windows[PROJECT_ALPHA]?.normal, { x: 10, y: 20, width: 900, height: 700 });
    assert.deepStrictEqual(persisted.windows[PROJECT_BETA]?.normal, { x: 400, y: 300, width: 1000, height: 800 });
    assert.deepStrictEqual(persisted.windows[UNASSIGNED]?.normal, { x: 40, y: 40, width: 700, height: 500 });
    assert.deepStrictEqual(persisted.windows[PROJECT_NAMED_UNASSIGNED]?.normal, { x: 60, y: 60, width: 800, height: 600 });
    assert.deepStrictEqual(alpha.getState(PROJECT_ALPHA), {
      x: 10,
      y: 20,
      width: 900,
      height: 700,
      isMaximized: false,
    });
  });

  it('persists the saved normal rectangle separately from the maximize intent', () => {
    const dir = makeTempDir('maximize-intent');
    const mgr = new WindowStateManager(dir, 1360, 880);
    const win = new FakeWindow({ x: 20, y: 30, width: 900, height: 700 });
    mgr.manage(win, PROJECT_ALPHA);

    win.maximized = true;
    win.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    win.emit('maximize');

    assert.deepStrictEqual(
      readPersistedFile(dir).windows[PROJECT_ALPHA],
      { normal: { x: 20, y: 30, width: 900, height: 700 }, isMaximized: true },
      'the maximized rectangle never becomes the saved normal rectangle',
    );
    assert.deepStrictEqual(mgr.getValidBounds(PROJECT_ALPHA), {
      x: 20,
      y: 30,
      width: 900,
      height: 700,
      isMaximized: true,
    });

    win.maximized = false;
    win.minimized = true;
    win.bounds = { x: -32000, y: -32000, width: 160, height: 30 };
    win.emit('resize');
    win.emit('close');

    assert.deepStrictEqual(readPersistedFile(dir).windows[PROJECT_ALPHA], {
      normal: { x: 20, y: 30, width: 900, height: 700 },
      isMaximized: false,
    });
  });

  it('preserves the saved maximize intent for a window the user never saw', () => {
    const dir = makeTempDir('hidden-intent');
    fs.writeFileSync(
      path.join(dir, 'window-state.json'),
      JSON.stringify({
        version: WINDOW_STATE_FILE_VERSION,
        windows: {
          [PROJECT_ALPHA]: {
            normal: { x: 20, y: 30, width: 900, height: 700 },
            isMaximized: true,
          },
        },
      }),
    );
    const mgr = new WindowStateManager(dir, 1360, 880);

    // A shell built for an agent stays hidden until an explicit user presentation: closing it
    // unshown must not consume the maximize intent the user left behind.
    const hidden = new FakeWindow({ x: 20, y: 30, width: 900, height: 700 });
    hidden.visible = false;
    mgr.manage(hidden, PROJECT_ALPHA);
    hidden.emit('close');

    assert.deepStrictEqual(
      readPersistedFile(dir).windows[PROJECT_ALPHA],
      { normal: { x: 20, y: 30, width: 900, height: 700 }, isMaximized: true },
      'the unshown window leaves the stored maximize intent alone',
    );
    assert.strictEqual(
      mgr.getPlacement(PROJECT_ALPHA).isMaximized,
      true,
      'presentation still knows to maximize the project window',
    );

    // A window the user actually saw owns the intent again.
    const presented = new FakeWindow({ x: 20, y: 30, width: 900, height: 700 });
    mgr.manage(presented, PROJECT_ALPHA);
    presented.emit('close');

    assert.deepStrictEqual(readPersistedFile(dir).windows[PROJECT_ALPHA], {
      normal: { x: 20, y: 30, width: 900, height: 700 },
      isMaximized: false,
    });
  });

  it('migrates a legacy file into the Unassigned record without discarding it', () => {
    const dir = makeTempDir('legacy-migration');
    const filePath = path.join(dir, 'window-state.json');
    const legacy = { x: 1920, y: 100, width: 1600, height: 1000, isMaximized: true };
    fs.writeFileSync(filePath, JSON.stringify(legacy));

    const mgr = new WindowStateManager(dir, 1360, 880);
    assert.deepStrictEqual(mgr.getState(), { x: 1920, y: 100, width: 1600, height: 1000, isMaximized: true });
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), JSON.stringify(legacy), 'loading never rewrites the file');

    const win = new FakeWindow({ x: 12, y: 24, width: 900, height: 700 });
    mgr.manage(win, PROJECT_ALPHA);
    win.emit('close');

    const persisted = readPersistedFile(dir);
    assert.strictEqual(persisted.version, WINDOW_STATE_FILE_VERSION);
    assert.deepStrictEqual(persisted.windows[DEFAULT_WINDOW_STATE_OWNER_KEY], {
      normal: { x: 1920, y: 100, width: 1600, height: 1000 },
      isMaximized: true,
    });
    assert.deepStrictEqual(persisted.windows[PROJECT_ALPHA]?.normal, { x: 12, y: 24, width: 900, height: 700 });
  });

  it('preserves the previous file when a write cannot be completed', () => {
    const dir = makeTempDir('failed-write');
    const filePath = path.join(dir, 'window-state.json');
    const mgr = new WindowStateManager(dir, 1360, 880);
    const win = new FakeWindow({ x: 100, y: 100, width: 900, height: 700 });
    mgr.manage(win, PROJECT_ALPHA);
    win.emit('close');
    const before = fs.readFileSync(filePath, 'utf-8');

    // Occupy the staging path the writer swaps from, so no candidate can land on disk.
    const stagingPath = `${filePath}.${process.pid}.tmp`;
    fs.mkdirSync(stagingPath);
    win.bounds = { x: 300, y: 200, width: 900, height: 700 };
    win.normalBounds = { ...win.bounds };
    win.emit('close');

    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), before, 'the previous file survives a failed write');

    fs.rmdirSync(stagingPath);
    win.emit('close');

    assert.deepStrictEqual(
      readPersistedFile(dir).windows[PROJECT_ALPHA]?.normal,
      { x: 300, y: 200, width: 900, height: 700 },
      'state persists again once the write can complete',
    );
  });

  it('preserves an unreadable state file before rewriting it', () => {
    const dir = makeTempDir('unreadable-state');
    const filePath = path.join(dir, 'window-state.json');
    const garbage = '{ this is not json';
    fs.writeFileSync(filePath, garbage);

    const mgr = new WindowStateManager(dir, 1360, 880);
    assert.deepStrictEqual(mgr.getState(), { width: 1360, height: 880, isMaximized: false });

    const win = new FakeWindow({ x: 5, y: 6, width: 800, height: 600 });
    mgr.manage(win, PROJECT_ALPHA);
    win.emit('close');

    const recovery = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    assert.strictEqual(recovery.length, 1, 'the unreadable file is preserved, not destroyed');
    assert.strictEqual(fs.readFileSync(path.join(dir, recovery[0]!), 'utf-8'), garbage);
    assert.deepStrictEqual(readPersistedFile(dir).windows[PROJECT_ALPHA]?.normal, {
      x: 5,
      y: 6,
      width: 800,
      height: 600,
    });
  });
});
