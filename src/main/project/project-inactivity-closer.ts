/**
 * Closes a project's Web window once the project has stopped being active.
 *
 * A project is active while at least one of its terminals runs. When the last running terminal
 * goes to sleep, exits or is closed, the Web window that belonged to that work has nothing left
 * to serve, so it closes with it. The rule is edge-triggered: only a project that was seen
 * running and is seen not running again closes. A window the user opens for a project whose
 * terminals already sleep (or that never had one) is left alone until that project runs again.
 *
 * Every project with a terminal is tracked, windowed or not, so a window opened after the
 * terminal started still has a baseline when that terminal later sleeps.
 *
 * Pure on purpose: the caller supplies what is running and how a window is closed, so the rule
 * is testable without Electron or a terminal.
 */

/** Projects that have a terminal; a project with none is absent. */
export type ProjectTerminalStates = ReadonlyMap<string, ProjectTerminalState>;

/** `running`: a terminal runs. `idle`: terminals exist (sleeping or exited), none runs. Absent from the map: no terminal at all. */
export type ProjectTerminalState = 'running' | 'idle';

export type ProjectInactivityReason = 'terminals-stopped' | 'terminal-manager-closed';

export interface ProjectTerminalFacts {
  projectId: string;
  state: string;
  role?: string | undefined;
  idlePolicy?: string | undefined;
}

/**
 * One pass over every session. Closed sessions are not terminals any more. Sync watchers
 * (`role: sync`, `idlePolicy: never`) are background infrastructure the app starts with the window
 * and that refuse to sleep, so they neither keep a project running nor count as its terminals.
 */
export function classifyProjectTerminals(sessions: Iterable<ProjectTerminalFacts>): Map<string, ProjectTerminalState> {
  const states = new Map<string, ProjectTerminalState>();
  for (const session of sessions) {
    if (session.state === 'closed' || session.role === 'sync' || session.idlePolicy === 'never') continue;
    if (session.state === 'running') states.set(session.projectId, 'running');
    else if (!states.has(session.projectId)) states.set(session.projectId, 'idle');
  }
  return states;
}

export interface ProjectInactivityDeps {
  /** Projects that currently own a Web window. */
  windowProjectIds(): readonly string[];
  terminalStates(): ProjectTerminalStates;
  /** Whether closing this project's window would leave no window on screen (which ends the app). */
  isLastVisibleWindow(projectId: string): boolean;
  closeWindow(projectId: string, reason: ProjectInactivityReason): void;
}

export interface ProjectInactivityCloser {
  /**
   * Re-read every project; close the window of each one that stopped running since the last call.
   * A window that is the last one on screen stays: a terminal going to sleep must not end the app.
   */
  evaluate(): void;
  /**
   * The Terminal Manager went away: close the window of every project that has terminals but none
   * running. A project that never had a terminal is not stopped, so its window stays.
   */
  closeIdleWindows(): void;
  /**
   * A project's window was just created. The baseline is re-read from what runs now, so a window
   * reopened within the check interval does not inherit the previous window's "was running".
   */
  windowOpened(projectId: string): void;
}

export function createProjectInactivityCloser(deps: ProjectInactivityDeps): ProjectInactivityCloser {
  const wasRunning = new Map<string, boolean>();
  return {
    evaluate(): void {
      const states = deps.terminalStates();
      const windows = new Set(deps.windowProjectIds());
      const ids = new Set<string>([...wasRunning.keys(), ...windows, ...states.keys()]);
      for (const projectId of ids) {
        const running = states.get(projectId) === 'running';
        const before = wasRunning.get(projectId);
        wasRunning.set(projectId, running);
        if (before === true && !running && windows.has(projectId) && !deps.isLastVisibleWindow(projectId)) {
          deps.closeWindow(projectId, 'terminals-stopped');
        }
      }
    },
    closeIdleWindows(): void {
      const states = deps.terminalStates();
      for (const projectId of deps.windowProjectIds()) {
        if (states.get(projectId) === 'idle') {
          deps.closeWindow(projectId, 'terminal-manager-closed');
        }
      }
    },
    windowOpened(projectId: string): void {
      wasRunning.set(projectId, deps.terminalStates().get(projectId) === 'running');
    },
  };
}
