/**
 * Which project a terminal with no project belongs to, decided from the folder its shell
 * was started in.
 *
 * Pure on purpose: the caller supplies the known projects, the work root and the home
 * directory, and stamps the answer once at mint time. Paths are compared as Windows paths
 * without touching the filesystem — case-insensitive, either separator, trailing
 * separators and `..` segments collapsed — so a folder that no longer exists (or sits on
 * an offline drive) still resolves the same way every time.
 */
import * as path from 'node:path';

const win32 = path.win32;

export type TerminalAdoptionRefusalReason =
  | 'NO_CWD'
  | 'WORK_ROOT'
  | 'DRIVE_ROOT'
  | 'HOME_DIR'
  | 'OUTSIDE_WORK_ROOT'
  | 'CONTAINS_PROJECTS';

export type TerminalAdoptionDecision =
  | { kind: 'existing'; projectId: string; workspacePath: string }
  | { kind: 'create'; folder: string }
  | { kind: 'refuse'; reason: TerminalAdoptionRefusalReason; folder: string; message: string };

interface CanonicalPath {
  /** Comparison identity: lowercased, backslash-separated, no trailing separator (except a root). */
  key: string;
  /** The same path with the caller's letter case kept, for display and for creating the project. */
  display: string;
  /** Whether the path is a drive root (`E:\`) or a UNC share root (`\\server\share`). */
  isRoot: boolean;
}

/**
 * Resolve one path to its canonical form, or null when it is not an absolute Windows path.
 * A drive-relative spelling (`E:foo`) or a bare name depends on a process cwd this module
 * does not have, so it is not a place a terminal can be attributed from.
 */
function canonicalize(raw: unknown): CanonicalPath | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  // Win32 long-path prefixes name the same directory as the plain spelling.
  if (value.startsWith('\\\\?\\UNC\\')) value = `\\\\${value.slice('\\\\?\\UNC\\'.length)}`;
  else if (value.startsWith('\\\\?\\') || value.startsWith('//?/')) value = value.slice(4);
  // Only a drive-letter or UNC spelling names a place by itself; `\foo` is rooted on whatever drive is current.
  if (!/^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/.test(value)) return null;
  let resolved = win32.resolve(value);
  const root = win32.parse(resolved).root;
  const isRoot = resolved.length <= root.length;
  if (!isRoot) resolved = resolved.replace(/\\+$/, '');
  return { key: resolved.toLowerCase(), display: resolved, isRoot };
}

/** Whether `child` is `parent` or lies anywhere beneath it. */
function isSameOrInside(parentKey: string, childKey: string): boolean {
  if (childKey === parentKey) return true;
  const prefix = parentKey.endsWith('\\') ? parentKey : `${parentKey}\\`;
  return childKey.startsWith(prefix);
}

function refuse(reason: TerminalAdoptionRefusalReason, folder: string, message: string): TerminalAdoptionDecision {
  return { kind: 'refuse', reason, folder, message };
}

const ASSIGN_HINT = 'Open the terminal inside a project folder, or assign it to a project in the Terminal Manager.';

/**
 * Decide the project for a terminal that has none, from its recorded working directory.
 *
 * 1. `existing` — the known project whose workspace is the cwd or the nearest enclosing
 *    folder of it (the longest containing workspace path wins, so a project nested inside
 *    another claims its own terminals).
 * 2. `create` — the cwd is strictly inside the work root and no known project's workspace
 *    lies at or under it: the folder becomes a project of its own.
 * 3. `refuse` — anything else, with the reason as a typed code and an actionable message:
 *    no usable cwd, a drive root, the work root itself, the home directory, a folder
 *    outside the work root, or a grouping folder that already contains projects.
 */
export function decideTerminalProjectAdoption(
  cwd: string | undefined,
  projects: ReadonlyArray<{ projectId: string; workspacePaths: readonly string[] }>,
  opts: { workRoot: string; homeDir: string },
): TerminalAdoptionDecision {
  const folderLabel = typeof cwd === 'string' ? cwd.trim() : '';
  const here = canonicalize(cwd);
  if (!here) {
    return refuse(
      'NO_CWD',
      folderLabel,
      folderLabel
        ? `The terminal's folder '${folderLabel}' is not an absolute path, so no project can be chosen for it. ${ASSIGN_HINT}`
        : `The terminal has no recorded folder, so no project can be chosen for it. ${ASSIGN_HINT}`,
    );
  }

  let best: { projectId: string; workspace: CanonicalPath } | null = null;
  let containsProject = false;
  for (const project of projects) {
    if (!project || typeof project.projectId !== 'string' || !Array.isArray(project.workspacePaths)) continue;
    for (const workspacePath of project.workspacePaths) {
      const workspace = canonicalize(workspacePath);
      if (!workspace) continue;
      if (isSameOrInside(workspace.key, here.key)) {
        if (!best || workspace.key.length > best.workspace.key.length) best = { projectId: project.projectId, workspace };
      } else if (isSameOrInside(here.key, workspace.key)) {
        containsProject = true;
      }
    }
  }
  if (best) return { kind: 'existing', projectId: best.projectId, workspacePath: best.workspace.display };

  if (here.isRoot) {
    return refuse('DRIVE_ROOT', here.display, `'${here.display}' is a drive root, not a project folder. ${ASSIGN_HINT}`);
  }
  const workRoot = canonicalize(opts?.workRoot);
  if (workRoot && here.key === workRoot.key) {
    return refuse(
      'WORK_ROOT',
      here.display,
      `'${here.display}' is the work root that holds every project, not a project itself. ${ASSIGN_HINT}`,
    );
  }
  const home = canonicalize(opts?.homeDir);
  if (home && here.key === home.key) {
    return refuse('HOME_DIR', here.display, `'${here.display}' is the user home folder, not a project folder. ${ASSIGN_HINT}`);
  }
  if (!workRoot || here.key === workRoot.key || !isSameOrInside(workRoot.key, here.key)) {
    return refuse(
      'OUTSIDE_WORK_ROOT',
      here.display,
      `'${here.display}' is outside the work root${workRoot ? ` '${workRoot.display}'` : ''}, so it is not turned into a project automatically. ${ASSIGN_HINT}`,
    );
  }
  if (containsProject) {
    return refuse(
      'CONTAINS_PROJECTS',
      here.display,
      `'${here.display}' is a folder that contains other projects, not a project itself. Open the terminal inside one of them, or assign it to a project in the Terminal Manager.`,
    );
  }
  return { kind: 'create', folder: here.display };
}
