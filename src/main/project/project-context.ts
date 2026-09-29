/**
 * The one place that answers "which project does this belong to".
 *
 * Terminals, tabs, windows and bare project ids all reach the same question from different
 * evidence: a capsule the row was created under, the durable owner key stamped on a terminal
 * record, or an id a window carries. Each answer used to be re-derived at the call site, so the
 * rules drifted (which claim is ambiguous, which record may authorize a path). They live here once.
 *
 * Deliberately Electron-free and registry-agnostic: the daemon's terminal closure imports the
 * modules next door, and every collaborator arrives as a port so a test can drive each case.
 * Nothing here mutates; an answer that cannot be proven is `unresolved`, never guessed.
 */
import { validateControlPlaneId } from '../../shared/control-plane-contracts';
import type { WorkspaceCapsule } from './workspace-capsule';

/** A capsule record whose affiliation Main can trust on the evidence of the record alone. */
export type ValidatedAffiliationCapsule = WorkspaceCapsule & { projectId: string; workspaceId: string };

/**
 * Whether a capsule carries an explicit, control-plane-safe affiliation: both ids present and
 * well formed. Ambiguity — two records claiming one project — is a separate rule, settled by
 * `uniqueValidatedClaim`, never here.
 *
 * A persisted record can carry `migrationMarker: 'explicit'` without a workspace id (the store
 * trusts a marker it reads from disk). Such a record must NOT count as a known project: the
 * synchronizer registers nothing for it, so opening it would mint a workspace id from nothing.
 */
export function hasValidatedAffiliation(capsule: WorkspaceCapsule): capsule is ValidatedAffiliationCapsule {
  if (!capsule.projectId || typeof capsule.projectId !== 'string' || capsule.projectId.trim().length === 0) {
    return false;
  }
  if (!capsule.workspaceId || typeof capsule.workspaceId !== 'string' || capsule.workspaceId.trim().length === 0) {
    return false;
  }
  try {
    validateControlPlaneId(capsule.projectId, 'project');
    validateControlPlaneId(capsule.workspaceId, 'workspace');
  } catch {
    return false;
  }
  return true;
}

/**
 * The capsule record authorizing an open of `projectId`, when exactly one exists and it carries a
 * validated affiliation. This is the same evidence the synchronizer registers from, so an open can
 * never name a project the registry refuses to know — and a second claim stays a refusal rather
 * than a tiebreak.
 */
export function uniqueValidatedClaim(
  capsules: readonly WorkspaceCapsule[],
  projectId: string,
): ValidatedAffiliationCapsule | undefined {
  const matches = capsules.filter((capsule) => capsule.projectId === projectId);
  const [onlyMatch, ...rest] = matches;
  if (!onlyMatch || rest.length > 0) return undefined;
  return hasValidatedAffiliation(onlyMatch) ? onlyMatch : undefined;
}

/** What a durable owner key names. The inverse of `ownerKey()` plus the agent spelling. */
export type ParsedOwnerKey =
  | { kind: 'project'; projectId: string }
  | { kind: 'web' }
  | { kind: 'unassigned' }
  | { kind: 'agent'; tabId: string }
  /** `project:` with no usable id: a corrupted stamp, a claim that cannot be honoured or ignored. */
  | { kind: 'malformed' }
  | { kind: 'other' };

/**
 * Read an owner key. A `project:`-prefixed key is always a project claim, even with an empty id:
 * that is a corrupted stamp, not the absence of one, so it must not fall through as "unassigned".
 */
export function parseOwnerKey(key: unknown): ParsedOwnerKey {
  if (typeof key !== 'string') return { kind: 'other' };
  if (key.startsWith('project:')) {
    const projectId = key.slice('project:'.length).trim();
    return projectId ? { kind: 'project', projectId } : { kind: 'malformed' };
  }
  if (key === 'unassigned') return { kind: 'unassigned' };
  if (key === 'web') return { kind: 'web' };
  if (key.startsWith('agent:')) return { kind: 'agent', tabId: key.slice('agent:'.length) };
  return { kind: 'other' };
}

/**
 * How the capsule store speaks for a project:
 * - `validated`: exactly one record claims it and its affiliation is well formed.
 * - `ambiguous`: two or more records claim it.
 * - `invalid`: one record claims it but names no usable workspace.
 * - `none`: no record claims it.
 */
export type ProjectClaim = 'validated' | 'ambiguous' | 'invalid' | 'none';

export interface ProjectContextProject {
  kind: 'project';
  projectId: string;
  ownerKey: string;
  claim: ProjectClaim;
  /** Where the answer came from: the row's own capsule, its owner key, or a bare project id. */
  source: 'capsule' | 'owner-key' | 'project-id';
  /** Present only when a validated capsule speaks for the project. */
  capsuleId?: string;
  /** Present only when exactly one workspace is attached (owner key) or a validated record names one. */
  workspaceId?: string;
  /** Registry attached root first, validated capsule path second. */
  workspaceRoot?: string;
  /** Capsule name, else registry name, else the id. */
  title: string;
}

export type ProjectContext =
  | ProjectContextProject
  | { kind: 'unassigned'; ownerKey: 'unassigned' }
  | { kind: 'agent'; ownerKey: string }
  | { kind: 'unresolved'; reason: 'UNKNOWN_SUBJECT' | 'MALFORMED_OWNER_KEY' | 'STALE_CAPSULE' };

export type ProjectContextSubject =
  | { kind: 'terminal'; sessionId: string }
  | { kind: 'tab'; tabId: string }
  | { kind: 'ownerKey'; ownerKey: string }
  | { kind: 'projectId'; projectId: string };

export interface ProjectContextPorts {
  capsules: () => readonly WorkspaceCapsule[];
  registry: {
    getProject(projectId: string): { name: string; state: string };
    listWorkspaces(projectId: string): ReadonlyArray<{ id: string; rootPath: string; state: string }>;
  };
  terminalOwnerKey?: (sessionId: string) => string | undefined;
  terminalCapsuleId?: (sessionId: string) => string | undefined;
  tabCapsuleId?: (tabId: string) => string | undefined;
}

function claimFor(capsules: readonly WorkspaceCapsule[], projectId: string): { claim: ProjectClaim; capsule?: ValidatedAffiliationCapsule } {
  const matches = capsules.filter((capsule) => capsule.projectId === projectId);
  if (matches.length === 0) return { claim: 'none' };
  if (matches.length > 1) return { claim: 'ambiguous' };
  const only = matches[0];
  if (!only) return { claim: 'none' };
  return hasValidatedAffiliation(only) ? { claim: 'validated', capsule: only } : { claim: 'invalid' };
}

/** Everything the two identity axes say about one project id. */
function describeProject(
  ports: ProjectContextPorts,
  projectId: string,
  source: ProjectContextProject['source'],
): ProjectContextProject {
  const { claim, capsule } = claimFor(ports.capsules(), projectId);

  let attached: { id: string; rootPath: string } | undefined;
  let attachedCount = 0;
  try {
    const list = ports.registry.listWorkspaces(projectId).filter((w) => w.state === 'attached');
    attachedCount = list.length;
    attached = list.find((w) => typeof w.rootPath === 'string' && w.rootPath.trim().length > 0);
  } catch {
    attachedCount = 0;
  }

  let title = projectId;
  if (capsule?.name) {
    title = capsule.name;
  } else {
    try {
      const record = ports.registry.getProject(projectId);
      if (record?.name) title = record.name;
    } catch {
      // No registry record: the id stays the label.
    }
  }

  const workspaceRoot = attached?.rootPath || capsule?.workspacePath || undefined;
  // A capsule names its own workspace even when the project holds several; the owner-key path
  // may only claim the sole attached one, since nothing else would say which.
  const workspaceId = source === 'owner-key'
    ? (attachedCount === 1 ? attached?.id : undefined)
    : capsule?.workspaceId || (attachedCount === 1 ? attached?.id : undefined);

  const context: ProjectContextProject = {
    kind: 'project',
    projectId,
    ownerKey: `project:${projectId}`,
    claim,
    source,
    title,
  };
  if (capsule) context.capsuleId = capsule.id;
  if (workspaceId) context.workspaceId = workspaceId;
  if (workspaceRoot) context.workspaceRoot = workspaceRoot;
  return context;
}

function fromCapsule(ports: ProjectContextPorts, capsuleId: string): ProjectContext | undefined {
  const capsule = ports.capsules().find((c) => c.id === capsuleId);
  if (!capsule?.projectId || !capsule.workspaceId) return undefined;
  const described = describeProject(ports, capsule.projectId, 'capsule');
  // The row's own capsule names its workspace even when the project's claim is ambiguous.
  described.capsuleId = capsule.id;
  described.workspaceId = capsule.workspaceId;
  return described;
}

function fromOwnerKey(ports: ProjectContextPorts, key: unknown): ProjectContext {
  const parsed = parseOwnerKey(key);
  switch (parsed.kind) {
    case 'project': return describeProject(ports, parsed.projectId, 'owner-key');
    case 'malformed': return { kind: 'unresolved', reason: 'MALFORMED_OWNER_KEY' };
    case 'agent': return { kind: 'agent', ownerKey: key as string };
    // The web hub and 'other' keys own terminals outside every project: they resolve to the
    // shared unassigned context rather than naming a project they do not belong to.
    default: return { kind: 'unassigned', ownerKey: 'unassigned' };
  }
}

/**
 * Resolve the project a subject belongs to.
 *
 * Terminals are capsule-exact first (the row's own workspace), then fall back to the owner key
 * stamped on the record. Tabs speak only through the capsule they were created under. A bare
 * project id or owner key is described from the two stores as they stand.
 */
export function resolveProjectContext(ports: ProjectContextPorts, subject: ProjectContextSubject): ProjectContext {
  switch (subject.kind) {
    case 'projectId': {
      const id = typeof subject.projectId === 'string' ? subject.projectId.trim() : '';
      return id ? describeProject(ports, id, 'project-id') : { kind: 'unresolved', reason: 'UNKNOWN_SUBJECT' };
    }
    case 'ownerKey':
      return fromOwnerKey(ports, subject.ownerKey);
    case 'tab': {
      const capsuleId = ports.tabCapsuleId?.(subject.tabId);
      if (!capsuleId) return { kind: 'unresolved', reason: 'UNKNOWN_SUBJECT' };
      return fromCapsule(ports, capsuleId) ?? { kind: 'unresolved', reason: 'STALE_CAPSULE' };
    }
    case 'terminal': {
      const capsuleId = ports.terminalCapsuleId?.(subject.sessionId);
      if (capsuleId) {
        const byCapsule = fromCapsule(ports, capsuleId);
        if (byCapsule) return byCapsule;
      }
      const owner = ports.terminalOwnerKey?.(subject.sessionId);
      if (owner === undefined) return { kind: 'unresolved', reason: 'UNKNOWN_SUBJECT' };
      return fromOwnerKey(ports, owner);
    }
  }
}
