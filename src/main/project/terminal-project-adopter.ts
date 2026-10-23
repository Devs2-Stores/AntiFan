/**
 * Gives a terminal that belongs to no project one, once, before the control plane measures it.
 *
 * `ControlPlaneRuntime.resolveTerminalScope` answers `unattributed` for a terminal whose owner
 * key names no project. That is not a scope any authority can be minted from, and it is not a
 * licence to guess per call: this adopter decides the project from the folder TerminalManager
 * recorded for the PTY (never a caller's cwd, never the proxy's `process.cwd()`), stamps the
 * answer on the terminal's owner key, and every later scope read is `measured`.
 *
 * The decision itself is `decideTerminalProjectAdoption`; this module is the wiring around it:
 * which terminals qualify, how the answer is stamped, and the typed refusal when no project can
 * be chosen. Every effect arrives through `deps` so the wiring is tested without Electron.
 */
import { CapabilityError } from '../../shared/control-plane-contracts';
import { parseOwnerKey } from './project-context';
import { decideTerminalProjectAdoption } from './terminal-project-adoption';

export interface TerminalProjectAdopterDeps {
  /** The folder the PTY was started in, as TerminalManager recorded it. */
  sessionCwd(terminalSessionId: string): Promise<string | undefined> | string | undefined;
  /** The terminal's current owner key, or undefined when it claims none. */
  sessionOwnerKey(terminalSessionId: string): string | undefined;
  /** Every project a terminal may be attributed to, with the paths of its attached workspaces. */
  knownProjects(): ReadonlyArray<{ projectId: string; workspacePaths: readonly string[] }>;
  /**
   * Create (or adopt) the project for one existing folder and answer its id. Throws when the
   * folder cannot become a project; the adopter reports that as a refusal.
   */
  projectForFolder(folder: string): { projectId: string };
  /** The capsule that names the project's own workspace, when one validates. */
  capsuleIdForProject(projectId: string): string | undefined;
  /** Stamp the owner (and capsule) on the terminal; false when the terminal refused the move. */
  stampOwner(terminalSessionId: string, ownerKey: string, capsuleId: string | undefined): Promise<boolean> | boolean;
  workRoot: string;
  homeDir: string;
  journal?: (event: string, fields: Record<string, unknown>) => void;
}

const REFUSAL_RECOVERY = 'Open the terminal inside a project folder, or assign it to a project in the Terminal Manager, then retry.';

function refusal(terminalSessionId: string, reason: string, folder: string, message: string): CapabilityError {
  return new CapabilityError(
    'TERMINAL_SCOPE_UNRESOLVED',
    `TERMINAL_SCOPE_UNRESOLVED: Terminal '${terminalSessionId}' belongs to no project. ${message}`,
    { terminalSessionId, reason, folder, recovery: REFUSAL_RECOVERY },
  );
}

/**
 * The adopter the control plane calls for a terminal whose scope is `unattributed`. Resolves
 * once the terminal carries a `project:<id>` owner key (or already did); throws a typed
 * `TERMINAL_SCOPE_UNRESOLVED` when no project can be chosen. Concurrent calls for one terminal
 * share one decision, so a terminal is never adopted into two projects.
 */
export function createTerminalProjectAdopter(deps: TerminalProjectAdopterDeps): (terminalSessionId: string) => Promise<void> {
  const inFlight = new Map<string, Promise<void>>();

  const adopt = async (terminalSessionId: string): Promise<void> => {
    const owner = parseOwnerKey(deps.sessionOwnerKey(terminalSessionId));
    // A project claim, even a corrupted one, is not an absence of project: it is measured (or
    // refused as unmeasurable) by the control plane and never restamped here. An agent-held
    // terminal keeps the key that ties it to its agent tab.
    if (owner.kind === 'project' || owner.kind === 'malformed' || owner.kind === 'agent') return;

    const cwd = await deps.sessionCwd(terminalSessionId);
    const decision = decideTerminalProjectAdoption(cwd, deps.knownProjects(), {
      workRoot: deps.workRoot,
      homeDir: deps.homeDir,
    });
    if (decision.kind === 'refuse') {
      deps.journal?.('terminal-adoption.refused', { terminalSessionId, reason: decision.reason, folder: decision.folder });
      throw refusal(terminalSessionId, decision.reason, decision.folder, decision.message);
    }

    let projectId: string;
    if (decision.kind === 'existing') {
      projectId = decision.projectId;
    } else {
      try {
        projectId = deps.projectForFolder(decision.folder).projectId;
      } catch (err) {
        const message = `The folder '${decision.folder}' could not be turned into a project (${err instanceof Error ? err.message : String(err)}).`;
        deps.journal?.('terminal-adoption.refused', { terminalSessionId, reason: 'PROJECT_FOLDER_INVALID', folder: decision.folder });
        throw refusal(terminalSessionId, 'PROJECT_FOLDER_INVALID', decision.folder, message);
      }
    }

    const stamped = await deps.stampOwner(terminalSessionId, `project:${projectId}`, deps.capsuleIdForProject(projectId));
    if (!stamped) {
      deps.journal?.('terminal-adoption.refused', { terminalSessionId, reason: 'STAMP_REFUSED', projectId });
      throw refusal(terminalSessionId, 'STAMP_REFUSED', decision.kind === 'existing' ? decision.workspacePath : decision.folder,
        'The terminal could not be assigned to its project (it may have just closed).');
    }
    deps.journal?.('terminal-adoption.adopted', { terminalSessionId, projectId, source: decision.kind });
  };

  return (terminalSessionId: string): Promise<void> => {
    const pending = inFlight.get(terminalSessionId);
    if (pending) return pending;
    const run = adopt(terminalSessionId).finally(() => { inFlight.delete(terminalSessionId); });
    inFlight.set(terminalSessionId, run);
    return run;
  };
}
