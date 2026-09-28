/**
 * The project list Main offers when a user asks to open a project without naming one.
 *
 * A renderer never guesses which project a click meant, and Main never opens a window for
 * an id no record describes. The picker is therefore built from Main's own inventory and
 * its answer is either a project id from that inventory or the explicit request to choose a
 * folder — both resolved by Main, never by a renderer string.
 *
 * The selection logic is pure so the mapping from a dialog response to an action is testable
 * without Electron: the button order the user sees and the ids behind each button are produced
 * by one function, which is what keeps a filtered or re-sorted list from shifting a click onto
 * a neighbouring project.
 */

/** One project the picker may honestly offer: an id Main holds a record for, and its label. */
export interface ProjectOpenCandidate {
  projectId: string;
  title: string;
}

/** The dialog Main shows, plus what each button stands for, position by position. */
export interface ProjectOpenDialogSpec {
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  /** The button that opens the folder chooser. Always present, even with no project to list. */
  folderActionId: number;
  ids: string[];
}

/** The label of the button that opens the folder chooser, and of the dismissal button. */
export const PROJECT_OPEN_FOLDER_LABEL = 'Chọn thư mục…';
export const PROJECT_OPEN_CANCEL_LABEL = 'Huỷ';

/**
 * The registry records a picker may offer. A closed project is not offered: opening it
 * would be refused downstream by the same knownness check, and a button that cannot work
 * is worse than no button.
 */
export interface ProjectOpenRegistryRecord {
  id: string;
  name: string;
  state: string;
}

export interface CollectProjectOpenCandidatesInput {
  /** Records from the shared registry, as Main holds them. */
  registryProjects: readonly ProjectOpenRegistryRecord[];
  /** Project ids a live window already owns, plus the boot identity: known without a record. */
  knownProjectIds?: readonly string[];
  /** The validated display projection for one project, resolved by Main. */
  describe: (projectId: string) => { title: string; pathLabel?: string };
}

/**
 * The inventory, de-duplicated and in a stable order.
 *
 * Every label carries its workspace path when the record has one, and only falls back to the
 * project id when it does not: the dialog's `detail` line is not rendered by every platform
 * (Windows drops it), so a bare title would leave two projects sharing a name — or a project
 * named after its own id — indistinguishable in the buttons the user actually clicks. A label
 * that is still ambiguous after the path is qualified with the id, which is unique by
 * construction.
 */
export function collectProjectOpenCandidates(
  input: CollectProjectOpenCandidatesInput,
): ProjectOpenCandidate[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (projectId: string): void => {
    const id = typeof projectId === 'string' ? projectId.trim() : '';
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  for (const record of input.registryProjects) {
    if (!record || record.state !== 'open') continue;
    add(record.id);
  }
  for (const projectId of input.knownProjectIds ?? []) add(projectId);

  const described = ids.map((projectId) => {
    const projection = input.describe(projectId);
    const title = typeof projection.title === 'string' && projection.title.trim()
      ? projection.title.trim()
      : projectId;
    const pathLabel = typeof projection.pathLabel === 'string' ? projection.pathLabel.trim() : '';
    return { projectId, title, label: pathLabel ? `${title} — ${pathLabel}` : title };
  });

  const labelCounts = new Map<string, number>();
  for (const entry of described) {
    labelCounts.set(entry.label, (labelCounts.get(entry.label) ?? 0) + 1);
  }

  return described
    .map((entry) => ({
      projectId: entry.projectId,
      title: (labelCounts.get(entry.label) ?? 0) > 1
        ? `${entry.label} — ${entry.projectId}`
        : entry.label,
    }))
    .sort((a, b) => a.title.localeCompare(b.title, 'en') || a.projectId.localeCompare(b.projectId, 'en'));
}

/**
 * The dialog spec for an inventory. It always exists: with no project to offer, the folder
 * chooser is still a real answer to "open a project", and a dialog whose only choices are
 * that and dismissal is honest about a build that knows no projects yet.
 */
export function projectOpenDialogSpec(
  candidates: readonly ProjectOpenCandidate[],
): ProjectOpenDialogSpec {
  const buttons = candidates.map((candidate) => candidate.title);
  const folderActionId = buttons.length;
  return {
    message: 'Mở dự án',
    detail: 'Chọn dự án để mở trong cửa sổ riêng, hoặc chọn một thư mục để mở nó thành dự án mới. '
      + 'Mỗi dự án có cửa sổ, tab và phiên terminal riêng.',
    buttons: [...buttons, PROJECT_OPEN_FOLDER_LABEL, PROJECT_OPEN_CANCEL_LABEL],
    defaultId: 0,
    cancelId: folderActionId + 1,
    folderActionId,
    ids: candidates.map((candidate) => candidate.projectId),
  };
}

/**
 * What a dialog response means: one of the listed projects, the folder chooser, or nothing.
 *
 * A response outside the buttons the spec declared is treated as a dismissal rather than as a
 * neighbouring project: a dialog that answered with an index it never offered must not be read
 * as a choice the user could not have made.
 */
export type ProjectOpenChoice =
  | { kind: 'project'; projectId: string }
  | { kind: 'folder' }
  | { kind: 'cancelled' };

export function projectOpenChoiceFor(
  spec: ProjectOpenDialogSpec,
  response: number,
): ProjectOpenChoice {
  if (!Number.isInteger(response)) return { kind: 'cancelled' };
  if (response === spec.folderActionId) return { kind: 'folder' };
  if (response < 0 || response >= spec.ids.length) return { kind: 'cancelled' };
  const projectId = spec.ids[response];
  return projectId ? { kind: 'project', projectId } : { kind: 'cancelled' };
}
