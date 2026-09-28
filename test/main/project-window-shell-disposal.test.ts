/**
 * A closed shell's own disposal must be judged after it had its chance to happen.
 *
 * The reported production line was a false positive:
 *
 *   [project-window-shell] project-…-0000000000a1 closed with 1 content(s) still alive: toolbar#2
 *
 * measured against a content that was already gone by the next turn (the process census no
 * longer listed it 1ms later). Chromium completes a `WebContents` teardown on a later turn —
 * a `WebContentsView` content still answers `isDestroyed() === false` in the task that called
 * `destroy()`, and lands within ~5ms — so a check made in that task reports a content that is
 * on its way out, while a check that waits only for the contents disposal can still miss a
 * genuinely undying one.
 *
 * These rows pin both directions with a double that models Electron rather than a convenient
 * API: `destroy()` posts its teardown instead of completing it inline (a plain boolean flag
 * would make every row pass and prove nothing), and one row's content never finishes it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { BrowserWindow, WebContentsView } from 'electron';
import {
  ProjectWindowShell,
  type ShellDisplayInfo,
  type ShellNativeSeam,
  type WindowOwner,
} from '../../src/main/browser/project-window-shell';

type Rect = { x: number; y: number; width: number; height: number };

const OWNER: WindowOwner = { kind: 'project', projectId: 'project-00000000-0000-4000-8000-000000000d1s' };

/**
 * One chrome content. `destroy()` requests the teardown and Chromium finishes it later, so
 * the content answers `isDestroyed() === false` for the rest of the calling turn — measured
 * against Electron 43: still alive after the calling task, gone within ~5ms. A later turn is
 * the whole of that fact, so this double defers instead of sleeping and the rows below carry
 * no wall-clock delay. A content asked to never finish models the leak the warning exists for.
 */
class StubWebContents {
  public readonly id: number;
  public neverFinishesTeardown = false;
  private teardownRequested = false;
  private gone = false;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(id: number) {
    this.id = id;
  }

  public on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    if (existing) existing.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  public removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    const index = existing ? existing.indexOf(listener) : -1;
    if (existing && index >= 0) existing.splice(index, 1);
    return this;
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  public isDestroyed(): boolean {
    return this.gone;
  }

  /** Requests the teardown; the content is still alive for the whole calling turn. */
  public destroy(): void {
    if (this.gone || this.teardownRequested) return;
    this.teardownRequested = true;
    if (this.neverFinishesTeardown) return;
    setImmediate(() => this.finishTeardown());
  }

  public close(): void {
    this.destroy();
  }

  /** Complete the teardown now, the way the platform eventually does. */
  public finishTeardown(): void {
    if (this.gone) return;
    this.gone = true;
    this.teardownRequested = false;
    this.emit('destroyed');
  }

  public loadFile(file: string): void {
    this.emit('did-finish-load', file);
  }
}

class StubView {
  public readonly contents: StubWebContents;

  constructor(id: number) {
    this.contents = new StubWebContents(id);
  }

  public get webContents(): StubWebContents {
    return this.contents;
  }

  public setBounds(): void {}

  public setBackgroundColor(): void {}
}

/**
 * A window that behaves like the platform's close sequence: the native close raises `close`
 * first and only destroys the window when nothing prevented it; a veto arrives from the
 * window's own document during that close and leaves the window standing.
 */
class StubWindow {
  public destroyed = false;
  public vetoClose = false;
  public readonly contentView: {
    children: unknown[];
    addChildView: (view: unknown) => void;
    removeChildView: (view: unknown) => void;
  };
  private readonly document: StubWebContents;
  private readonly children: unknown[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor() {
    this.document = new StubWebContents(1);
    this.contentView = {
      children: this.children,
      addChildView: (view: unknown) => {
        if (!this.children.includes(view)) this.children.push(view);
      },
      removeChildView: (view: unknown) => {
        const index = this.children.indexOf(view);
        if (index >= 0) this.children.splice(index, 1);
      },
    };
  }

  /** Electron: a window whose native object is gone cannot report its own document. */
  public get webContents(): StubWebContents {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
    return this.document;
  }

  public on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    if (existing) existing.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  public once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]): void => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  public removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    const index = existing ? existing.indexOf(listener) : -1;
    if (existing && index >= 0) existing.splice(index, 1);
    return this;
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public getBounds(): Rect {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
    return { x: 0, y: 0, width: 1280, height: 800 };
  }

  public getContentBounds(): Rect {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
    return { x: 0, y: 0, width: 1280, height: 800 };
  }

  /** The platform's native close: `close` first, destruction only if nothing prevented it. */
  public close(): void {
    if (this.destroyed) return;
    const event = { defaultPrevented: false, preventDefault(): void { event.defaultPrevented = true; } };
    this.emit('close', event);
    if (event.defaultPrevented) return;
    if (this.vetoClose) {
      // A page refusing to unload: the close was dispatched, the platform asks the document,
      // and the window survives. The shell honors that veto instead of forcing the window.
      this.document.emit('will-prevent-unload');
      return;
    }
    this.destroy();
  }

  /**
   * Electron destroys the window's own document with the window; child view contents are
   * deliberately left alive until the shell disposes them — the fact the audit is about.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.document.finishTeardown();
    this.emit('closed');
  }

  public isVisible(): boolean {
    return !this.destroyed;
  }

  public isMinimized(): boolean {
    return false;
  }

  public isMaximized(): boolean {
    return false;
  }

  public show(): void {}

  public focus(): void {}
}

interface ShellFixture {
  shell: ProjectWindowShell;
  window: StubWindow;
  toolbar: StubView;
  sidebar: StubView;
  backdrop: StubView;
}

function createShell(): ShellFixture {
  const windows: StubWindow[] = [];
  const views: StubView[] = [];
  const display: ShellDisplayInfo = {
    id: 1,
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1280, height: 800 },
    workArea: { x: 0, y: 0, width: 1280, height: 760 },
  };
  let nextId = 100;
  const seam: ShellNativeSeam = {
    createWindow: () => {
      const created = new StubWindow();
      windows.push(created);
      return created as unknown as BrowserWindow;
    },
    createView: () => {
      const created = new StubView(nextId);
      nextId += 1;
      views.push(created);
      return created as unknown as WebContentsView;
    },
    displayForBounds: () => ({ ...display, bounds: { ...display.bounds }, workArea: { ...display.workArea } }),
  };
  const shell = new ProjectWindowShell(
    { owner: OWNER, title: 'Disposal audit', bounds: { width: 1280, height: 800 } },
    undefined,
    seam,
  );
  const [window] = windows;
  // The shell's own creation order: toolbar in the constructor, then the backdrop, then
  // the sidebar inside `createToolbarAndSidebar`.
  const [toolbar, backdrop, sidebar] = views;
  assert.ok(window && toolbar && backdrop && sidebar, 'the seam must have created the window and three chrome views');
  return { shell, window: window!, toolbar: toolbar!, backdrop: backdrop!, sidebar: sidebar! };
}

/** Collect the shell's own diagnostics; the warning channel is what honesty is judged on. */
function captureConsoleError(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  return { lines, restore: () => { console.error = original; } };
}

describe('project window shell — own-content disposal audit', () => {
  it('a shell whose chrome teardown lands reports no survivor', async () => {
    const fixture = createShell();
    const capture = captureConsoleError();
    let outcome: string;
    try {
      outcome = await fixture.shell.closeSelf();
    } finally {
      capture.restore();
    }

    assert.equal(outcome, 'closed');
    assert.deepEqual(capture.lines, [], `a disposed shell must report nothing, got: ${capture.lines.join(' | ')}`);
    // 'closed' is settled only once the disposal landed, which is what makes that claim true.
    for (const [role, view] of [['toolbar', fixture.toolbar], ['sidebar', fixture.sidebar], ['backdrop', fixture.backdrop]] as const) {
      assert.equal(view.contents.isDestroyed(), true, `${role} contents was still alive when the shell reported closure`);
    }
    assert.equal(fixture.window.isDestroyed(), true, 'the window was still alive when the shell reported closure');
  });

  it('a chrome content that never finishes its teardown is reported by role, and closure still settles', async () => {
    const fixture = createShell();
    // The sidebar is the content the previous check could not even see: disposal forgets it.
    fixture.sidebar.contents.neverFinishesTeardown = true;
    const capture = captureConsoleError();
    let outcome: string;
    try {
      outcome = await fixture.shell.closeSelf();
    } finally {
      capture.restore();
    }

    assert.equal(outcome, 'closed', 'a leaked content is reported, never a closure the shell withholds');
    const warning = capture.lines.find((line) => line.includes('still alive'));
    assert.ok(warning, `an undying content must be reported, got: ${capture.lines.join(' | ') || '<nothing>'}`);
    assert.match(warning!, /1 content\(s\) still alive/);
    assert.match(warning!, new RegExp(`sidebar#${fixture.sidebar.contents.id}`));
    assert.doesNotMatch(warning!, /toolbar#/, 'a content that did die must not be named as a survivor');
    assert.equal(fixture.toolbar.contents.isDestroyed(), true);
    assert.equal(fixture.sidebar.contents.isDestroyed(), false);
  });

  it('a vetoed close audits nothing and leaves every chrome content alone', async () => {
    const fixture = createShell();
    fixture.window.vetoClose = true;
    const capture = captureConsoleError();
    let outcome: string;
    try {
      outcome = await fixture.shell.closeSelf();
    } finally {
      capture.restore();
    }

    assert.equal(outcome, 'vetoed');
    assert.deepEqual(capture.lines, [], `a veto is not a closure to audit, got: ${capture.lines.join(' | ')}`);
    assert.equal(fixture.window.isDestroyed(), false);
    for (const [role, view] of [['toolbar', fixture.toolbar], ['sidebar', fixture.sidebar], ['backdrop', fixture.backdrop]] as const) {
      assert.equal(view.contents.isDestroyed(), false, `${role} contents was disposed by a close that was vetoed`);
    }
  });
});
