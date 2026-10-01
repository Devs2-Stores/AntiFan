/**
 * AntiFan Browser Desktop — Project Window Manager
 *
 * Maps a stable window owner (a project, the web hub or Unassigned) to exactly one live
 * ProjectWindowShell.
 *
 * It is a directory and an admission point — not a second tab authority. Tab identity, tab
 * membership, selection authority, attachments and shared services stay with the hosting tab
 * authority, and this directory keeps no page state of its own: the pages a shell presents are
 * answered in exactly one place (the hosting tab authority, read by the close wiring), so a
 * second, drifting membership answer cannot exist here.
 *
 * It is also the close-surface directory: `listCloseSurfaces()` /
 * `closeSurfaceForOwner()` hand the close coordinator one surface per live browser shell, and
 * `browserShellCount()` / `isFinalBrowserShell()` answer the last-browser question from this
 * directory — never from `BrowserWindow.getAllWindows()`. Auxiliary windows (capture hosts,
 * terminal popouts) are never admitted here, so they can neither inflate the count nor be
 * mistaken for a surviving browser shell.
 */
import type { CloseSurface } from './project-close-coordinator';
import { ownerKey, ProjectWindowShell, type WindowOwner } from './project-window-shell';

/**
 * `user`: an explicit user action — the shell is presented and focused.
 * `agent`: background work — the shell is created but never presented.
 * `restore`: boot-time resurrection — the shell is presented unfocused
 * (`showInactive` semantics: visible, placement restored, no focus steal). A
 * shell restored unfocused can still be focused by a later `user` intent.
 */
export type OpenIntent = 'user' | 'agent' | 'restore';

export interface ProjectWindowManagerOptions {
  /** Builds the native shell. The manager never constructs BrowserWindow itself. */
  createShell: (owner: WindowOwner, intent: OpenIntent) => ProjectWindowShell;
  /** Presents an existing shell for an explicit user action; never called for agent intent. */
  presentShell?: (shell: ProjectWindowShell) => void;
  /**
   * Presents an existing shell for a `restore` intent join: the window surfaces
   * without stealing focus (`showInactive`), so a boot-time restore can never
   * interrupt what the user is already looking at. Never called for agent or
   * user intents — those keep `presentShell`.
   */
  presentShellInactive?: (shell: ProjectWindowShell) => void;
  /**
   * Main unregisters this shell's routing and host here, with the owner identity it needs
   * (`shell.owner`). Runs once per shell: before its own teardown on `disposeShell()`, and
   * after native closure when the platform destroyed the window — never for a refused or
   * vetoed close, which leaves the window alive.
   */
  onShellDisposed?: (shell: ProjectWindowShell) => void;
  /**
   * Re-present the surviving active page inside a shell that stayed open after a partial
   * close. Wired by Main to the tab authority's own restore; it MUST NOT show, focus or
   * raise a window and must not touch another shell. Left unwired, a partial close reports
   * the missing restore as a warning instead of pretending the layout was repaired.
   */
  restoreShellLayout?: (shell: ProjectWindowShell, survivingTabIds: readonly string[]) => void;
}

export class ProjectWindowManager {
  private readonly shells = new Map<string, ProjectWindowShell>();
  private readonly pendingOpens = new Map<string, Promise<ProjectWindowShell>>();
  /**
   * Close surfaces are minted once per admitted shell instance, so a surface cannot drift
   * onto a replacement window in the middle of a close attempt.
   */
  private readonly closeSurfaces = new Map<string, { shell: ProjectWindowShell; surface: CloseSurface }>();
  private readonly options: ProjectWindowManagerOptions;

  constructor(options: ProjectWindowManagerOptions) {
    this.options = options;
  }

  /**
   * Return the live shell for an owner, creating one when absent. Concurrent
   * requests for the same owner share a single creation attempt, so a
   * double-click cannot produce two windows. `user` presents focused, `restore`
   * presents unfocused, `agent` never presents.
   */
  public ensureWindow(owner: WindowOwner, intent: OpenIntent): Promise<ProjectWindowShell> {
    const key = ownerKey(owner);

    const existing = this.shells.get(key);
    if (existing) {
      if (!existing.window.isDestroyed()) {
        if (intent === 'user') this.present(existing);
        else if (intent === 'restore') this.presentInactive(existing);
        return Promise.resolve(existing);
      }
      this.forgetShell(key);
    }

    const inFlight = this.pendingOpens.get(key);
    if (inFlight) {
      // A user click that lands while a background creation is still running
      // must still present the window it joins; the creation intent itself is
      // whichever request won, so an agent-driven creation stays hidden. The
      // same rule drives `restore`: joining an in-flight open surfaces the
      // shell unfocused rather than leaving a boot-restored window invisible.
      if (intent === 'agent') return inFlight;
      return inFlight.then((shell) => {
        if (intent === 'restore') this.presentInactive(shell);
        else this.present(shell);
        return shell;
      });
    }


    const attempt = Promise.resolve()
      .then(() => this.options.createShell(owner, intent))
      .then((shell) => {
        const createdKey = ownerKey(shell.owner);
        if (createdKey !== key) {
          // Trusted identity mismatch: admitting this shell would present one
          // project's record under another project's key. Fail closed.
          try {
            shell.dispose();
          } catch (err) {
            console.error('[project-window-manager] failed to dispose a mismatched shell:', err);
          }
          throw new Error(`shell creation returned owner '${createdKey}' for requested owner '${key}'`);
        }
        const raced = this.shells.get(key);
        if (raced && !raced.window.isDestroyed()) {
          // Another creation path won the race. Keep the winner and tear down
          // only the redundant shell, chrome and window included.
          shell.dispose();
          return raced;
        }
        this.shells.set(key, shell);
        this.watchShellClosure(key, shell);
        return shell;
      })
      .finally(() => {
        this.pendingOpens.delete(key);
      });

    this.pendingOpens.set(key, attempt);
    // A failed initialization must not leave a dead mapping behind, and later
    // explicit opens must be able to retry.
    attempt.catch(() => this.forgetShell(key));
    return attempt;
  }

  /** Chrome-surface lookup for IPC: a shell only serves webContents it owns. */
  public shellForSender(webContentsId: number): ProjectWindowShell | undefined {
    for (const shell of this.shells.values()) {
      if (shell.window.isDestroyed()) continue;
      if (shell.ownsChromeWebContents(webContentsId)) return shell;
    }
    return undefined;
  }

  /**
   * Live browser shells: the directory's own entries. Capture hosts, terminal
   * popouts and other auxiliary windows are never admitted to this directory,
   * so they can never inflate this count — it is not a BrowserWindow census.
   *
   * Exactly one shell per owner key, counted from window liveness, so a shell that is
   * mid-close still counts exactly once — its window is alive until the native closure
   * completes — and stops counting the moment that window is actually gone, even before its
   * mapping is cleared.
   */
  public browserShellCount(): number {
    return this.listShells().length;
  }

  /**
   * The check for "this is the last browser shell", answerable without
   * `BrowserWindow.getAllWindows()`: true only while this owner's shell is the one live
   * browser shell. False when the owner has no live shell and when another browser shell is
   * live. Auxiliary windows are not in this directory, so terminal popouts and capture hosts
   * still being open never changes the answer: "no browser shells left" and "auxiliary windows
   * still open" are different facts, and only the first one may start an orderly quit.
   */
  public isFinalBrowserShell(owner: WindowOwner): boolean {
    const key = ownerKey(owner);
    const shell = this.shells.get(key);
    if (!shell || shell.window.isDestroyed()) return false;
    return this.listShells().length === 1;
  }

  public listShells(): ProjectWindowShell[] {
    return [...this.shells.values()].filter((shell) => !shell.window.isDestroyed());
  }

  /**
   * The close coordinator's surface directory: one stable surface per live browser shell, in
   * directory order. Auxiliaries are never included, which is what keeps the coordinator's own
   * last-browser-shell decision and `browserShellCount()` the same fact.
   */
  public listCloseSurfaces(): CloseSurface[] {
    return this.listShells().map((shell) => this.closeSurfaceFor(shell));
  }

  /**
   * The close surface of one live browser shell, by owner key, or undefined when that shell is
   * gone. The same instance answers while the same shell instance owns the key.
   */
  public closeSurfaceForOwner(key: string): CloseSurface | undefined {
    const shell = this.shells.get(key);
    if (!shell || shell.window.isDestroyed()) {
      this.closeSurfaces.delete(key);
      return undefined;
    }
    return this.closeSurfaceFor(shell);
  }

  private closeSurfaceFor(shell: ProjectWindowShell): CloseSurface {
    const key = ownerKey(shell.owner);
    const cached = this.closeSurfaces.get(key);
    if (cached && cached.shell === shell) return cached.surface;
    const surface: CloseSurface = {
      key,
      kind: 'browser',
      // This directory holds no page state. Which pages a shell presents is decided by the
      // hosting tab authority, and the close wiring reads them from there before it hands the
      // coordinator a surface. A member read that reaches this surface therefore means that
      // wiring is missing — and an empty answer is indistinguishable from a shell that really
      // has no pages, which is how a close came to destroy a window whose pages were never
      // busy-checked, reserved or closed. Unknown membership fails the attempt instead.
      visibleMemberIds: () => {
        throw new Error(
          `the window directory does not track the pages of ${key}; ` +
            'read them from the hosting tab authority at the close wiring',
        );
      },
      closeSelf: (force) => shell.closeSelf(force),
      restoreSurvivingLayout: (survivingTabIds) => {
        if (survivingTabIds.length === 0) return;
        const restore = this.options.restoreShellLayout;
        if (!restore) {
          throw new Error(
            `no restoreShellLayout hook is wired; ${key} keeps the layout it has after a partial close`
          );
        }
        restore(shell, [...survivingTabIds]);
      },
    };
    this.closeSurfaces.set(key, { shell, surface });
    return surface;
  }

  /**
   * Subscribe to this shell's native closure at admission. A shell double that cannot report
   * closure is left unwatched rather than guessed at; the real shell always reports it.
   */
  private watchShellClosure(key: string, shell: ProjectWindowShell): void {
    if (typeof shell.onClosed !== 'function') return;
    shell.onClosed(() => { this.handleNativeClosure(key, shell); });
  }

  /**
   * The platform destroyed this shell's window, so the shell is gone: clear the mapping and
   * tell Main. Runs after native closure — never for a refused or vetoed close, which leaves
   * the window alive — and exactly once per shell, because a superseded or already-disposed
   * mapping is ignored.
   */
  private handleNativeClosure(key: string, shell: ProjectWindowShell): void {
    if (this.shells.get(key) !== shell) return;
    this.forgetShell(key);
    this.notifyDisposed(shell);
  }

  /**
   * Dispose one shell after its pages are gone: drop the owner and its tab bindings, let Main
   * unregister routing, then tear down that shell's chrome and window. Other windows and
   * shared services are untouched.
   *
   * This is the only entry that tears a shell down, and it is idempotent: a shell that was
   * already disposed — or already closed natively, which clears the mapping through the
   * closure listener — reports false with no second teardown and no second `onShellDisposed`.
   */
  public disposeShell(owner: WindowOwner): boolean {
    const key = ownerKey(owner);
    const shell = this.shells.get(key);
    if (!shell) return false;
    this.forgetShell(key);
    this.notifyDisposed(shell);
    try {
      shell.dispose();
    } catch (err) {
      console.error('[project-window-manager] failed to dispose shell:', err);
    }
    return true;
  }

  /**
   * Clear the mapping for a shell the platform already destroyed, for callers that cannot rely
   * on closure reporting. Callers keep ownership of deciding whether that destruction was
   * allowed; this only clears the mapping and still fires `onShellDisposed` at most once per
   * shell — and never for a shell whose window is still alive.
   */
  public notifyShellGone(owner: WindowOwner): void {
    const key = ownerKey(owner);
    const shell = this.shells.get(key);
    // A live window is not "gone": unregistering its routing would strand a shell that a
    // refused or vetoed close deliberately kept alive.
    if (!shell || !shell.window.isDestroyed()) return;
    this.forgetShell(key);
    this.notifyDisposed(shell);
  }

  private notifyDisposed(shell: ProjectWindowShell): void {
    try {
      this.options.onShellDisposed?.(shell);
    } catch (err) {
      console.error('[project-window-manager] onShellDisposed failed:', err);
    }
  }

  private present(shell: ProjectWindowShell): void {
    if (shell.window.isDestroyed()) return;
    try {
      this.options.presentShell?.(shell);
    } catch (err) {
      console.error('[project-window-manager] presentShell failed:', err);
    }
  }

  private presentInactive(shell: ProjectWindowShell): void {
    if (shell.window.isDestroyed()) return;
    try {
      this.options.presentShellInactive?.(shell);
    } catch (err) {
      console.error('[project-window-manager] presentShellInactive failed:', err);
    }
  }

  private forgetShell(key: string): void {
    this.shells.delete(key);
    this.closeSurfaces.delete(key);
  }
}
