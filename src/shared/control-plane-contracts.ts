import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CONTROL_PLANE_PROTOCOL_VERSION = 1;
export const SESSION_FORMAT_VERSION = 1;

export type ControlPlaneEntity = 'project' | 'workspace' | 'chat' | 'run' | 'attempt' | 'tool' | 'artifact' | 'binding';
export type LifecycleState = 'open' | 'closed' | 'interrupted' | 'completed' | 'failed' | 'unknown';
export type RunState = 'queued' | 'starting' | 'streaming' | 'waiting-tool' | 'cancelling' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export type AttemptState = 'prepared' | 'dispatching' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export type CapabilityRisk = 'read' | 'write' | 'execute' | 'eval';
export type DeliveryState = 'prepared' | 'dispatching' | 'accepted-exact' | 'accepted-active-panel' | 'prompt-observed' | 'response-observed' | 'failed' | 'unknown' | 'unavailable';

export interface ProjectRecord {
  id: string;
  name: string;
  dataRoot: string;
  state: 'open' | 'closed';
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceRecord {
  id: string;
  projectId: string;
  rootPath: string;
  state: 'attached' | 'detached';
  createdAt: number;
  updatedAt: number;
}

export interface ChatRecord {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  state: 'open' | 'closed';
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  projectId: string;
  workspaceId: string;
  chatId: string;
  state: RunState;
  backendId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ExecutionAttempt {
  id: string;
  runId: string;
  projectId: string;
  workspaceId: string;
  chatId: string;
  state: AttemptState;
  backendId: string;
  backendSessionRef?: BackendSessionRef;
  commandId?: string;
  promptDigest?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ToolInvocation {
  id: string;
  runId: string;
  attemptId: string;
  capability: string;
  risk: CapabilityRisk;
  state: 'prepared' | 'running' | 'completed' | 'failed' | 'denied';
  startedAt?: number;
  completedAt?: number;
}

export interface ArtifactRef {
  id: string;
  runId: string;
  attemptId: string;
  kind: 'dom' | 'screenshot' | 'console' | 'terminal' | 'attachment' | 'report';
  path: string;
  byteLength: number;
  sha256: string;
  mime: string;
  truncated: boolean;
  redacted: boolean;
  createdAt: number;
}

export interface BrowserBinding {
  projectId: string;
  workspaceId: string;
  runtimeId: string;
  tabId: string;
  browserEpoch: number;
  documentGeneration: number;
}

export interface BrowserTarget extends BrowserBinding {
  url?: string;
}

export interface BackendSessionRef {
  backendId: string;
  providerSessionId?: string;
  opaqueRef: string;
  createdAt: number;
}

export interface RuntimeLease {
  runtimeId: string;
  projectId: string;
  workspaceId?: string;
  token: string;
  protocolVersion: number;
  hostEpoch: number;
  ownerPid: number;
  issuedAt: number;
  expiresAt: number;
}

export interface CapabilityRequestContext {
  lease: RuntimeLease;
  leaseToken: string;
  projectId: string;
  workspaceId: string;
  runId?: string;
  attemptId?: string;
  browserTarget?: BrowserTarget;
  grant?: 'read' | 'write' | 'execute' | 'eval';
  signal?: AbortSignal;
}

export interface CapabilityDefinition<TParams = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  risk: CapabilityRisk;
  requiresBrowserTarget?: boolean;
  inputSchema: Record<string, unknown>;
  execute: (params: TParams, context: CapabilityRequestContext) => Promise<TResult> | TResult;
}

export interface ControlPlaneEvent<T = unknown> {
  formatVersion: number;
  id: string;
  sequence: number;
  type: string;
  projectId: string;
  workspaceId?: string;
  chatId?: string;
  runId?: string;
  attemptId?: string;
  createdAt: number;
  payload: T;
}

export interface ReceiptBinding {
  commandId: string;
  promptDigest: string;
  projectId: string;
  workspaceId: string;
  canonicalWorkspace: string;
  hostInstanceId: string;
  hostEpoch: number;
  attemptId: string;
  backendSessionRef: string;
}

export interface AuthoritativeReceipt {
  formatVersion: number;
  id: string;
  binding: ReceiptBinding;
  state: 'prepared' | 'accepted' | 'completed' | 'failed' | 'unknown';
  deliveryState: DeliveryState;
  createdAt: number;
  completedAt?: number;
  errorCode?: string;
  errorMessage?: string;
}

export type CapabilityErrorCode = 'UNAUTHENTICATED' | 'LEASE_EXPIRED' | 'PROJECT_MISMATCH' | 'WORKSPACE_MISMATCH' | 'RUNTIME_MISMATCH' | 'TARGET_REQUIRED' | 'TARGET_STALE' | 'POLICY_DENIED' | 'CAPABILITY_NOT_FOUND' | 'INVALID_ARGUMENT' | 'OUTSIDE_WORKSPACE' | 'ARTIFACT_TOO_LARGE' | 'RUNTIME_DRAINING';

export class CapabilityError extends Error {
  readonly code: CapabilityErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CapabilityErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
    this.details = details;
  }
}

export type RuntimeLifecycle = 'active' | 'draining' | 'drained' | 'legacy';

export interface RuntimeFeatureSwitch {
  mode: 'standalone' | 'legacy';
  lifecycle: RuntimeLifecycle;
}

export function makeControlPlaneId(entity: ControlPlaneEntity): string {
  return `${entity}-${crypto.randomUUID()}`;
}

export function isControlPlaneId(value: unknown, entity?: ControlPlaneEntity): value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,32}-[0-9a-f-]{20,}$/.test(value)) return false;
  return !entity || value.startsWith(`${entity}-`);
}

export function validateControlPlaneId(value: unknown, entity: ControlPlaneEntity): string {
  if (!isControlPlaneId(value, entity)) throw new CapabilityError('INVALID_ARGUMENT', `Invalid ${entity} ID`);
  return value;
}

function pathApi(value: string): typeof path {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') ? path.win32 : path;
}

export function canonicalizeWorkspaceRoot(root: string): string {
  if (typeof root !== 'string' || root.trim().length === 0) throw new CapabilityError('INVALID_ARGUMENT', 'Workspace root is required');
  const api = pathApi(root);
  const resolved = api.resolve(root);
  try {
    return fs.realpathSync.native(resolved).replace(/[\\/]$/, '').toLowerCase();
  } catch {
    return resolved.replace(/[\\/]$/, '').toLowerCase();
  }
}

export function assertWorkspaceContained(root: string, candidate: string, allowRoot = false): string {
  const canonicalRoot = canonicalizeWorkspaceRoot(root);
  const canonicalCandidate = canonicalizeWorkspaceRoot(candidate);
  const api = pathApi(canonicalRoot);
  const relative = api.relative(canonicalRoot, canonicalCandidate);
  if (relative === '' && allowRoot) return canonicalCandidate;
  if (relative === '' || relative.startsWith('..' + api.sep) || api.isAbsolute(relative)) {
    throw new CapabilityError('OUTSIDE_WORKSPACE', 'Path is outside the attached workspace', { root: canonicalRoot, candidate: canonicalCandidate });
  }
  return canonicalCandidate;
}

export function assertNoReparseTraversal(root: string, candidate: string): void {
  const api = pathApi(root);
  const resolvedRoot = api.resolve(root);
  const resolvedCandidate = api.resolve(candidate);
  const relative = api.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith('..' + api.sep) || api.isAbsolute(relative)) throw new CapabilityError('OUTSIDE_WORKSPACE', 'Path is outside the attached workspace');
  const parts = relative ? relative.split(/[\\/]+/) : [];
  let current = resolvedRoot;
  for (const part of parts) {
    current = api.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new CapabilityError('OUTSIDE_WORKSPACE', 'Symlink or junction traversal is not permitted');
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      break;
    }
  }
}

export function issueRuntimeLease(projectId: string, workspaceId?: string, ttlMs = 30_000, hostEpoch = 1): RuntimeLease {
  const now = Date.now();
  return {
    runtimeId: makeControlPlaneId('binding'),
    projectId: validateControlPlaneId(projectId, 'project'),
    workspaceId: workspaceId ? validateControlPlaneId(workspaceId, 'workspace') : undefined,
    token: crypto.randomBytes(32).toString('hex'),
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    hostEpoch,
    ownerPid: process.pid,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
}

export function assertRuntimeLease(lease: RuntimeLease, expected: { projectId: string; workspaceId?: string; hostEpoch?: number; token?: string }, now = Date.now()): void {
  if (!lease || typeof lease.token !== 'string') throw new CapabilityError('UNAUTHENTICATED', 'Runtime lease is required');
  if (lease.expiresAt <= now) throw new CapabilityError('LEASE_EXPIRED', 'Runtime lease has expired');
  if (expected.token !== undefined) {
    const actual = Buffer.from(lease.token);
    const supplied = Buffer.from(expected.token);
    if (actual.length !== supplied.length || !crypto.timingSafeEqual(actual, supplied)) throw new CapabilityError('UNAUTHENTICATED', 'Runtime lease token is invalid');
  }
  if (lease.projectId !== expected.projectId) throw new CapabilityError('PROJECT_MISMATCH', 'Runtime lease Project does not match request');
  if (expected.workspaceId !== undefined && lease.workspaceId !== expected.workspaceId) throw new CapabilityError('WORKSPACE_MISMATCH', 'Runtime lease Workspace does not match request');
  if (expected.hostEpoch !== undefined && lease.hostEpoch !== expected.hostEpoch) throw new CapabilityError('TARGET_STALE', 'Runtime lease host epoch is stale');
}

export function assertExactBrowserTarget(target: BrowserTarget | undefined, expected: Pick<BrowserBinding, 'projectId' | 'workspaceId' | 'runtimeId'> & Partial<Pick<BrowserBinding, 'browserEpoch' | 'documentGeneration'>>): BrowserTarget {
  if (!target) throw new CapabilityError('TARGET_REQUIRED', 'An explicit BrowserTarget is required');
  if (target.projectId !== expected.projectId || target.workspaceId !== expected.workspaceId || target.runtimeId !== expected.runtimeId) throw new CapabilityError('WORKSPACE_MISMATCH', 'Browser target ownership does not match request');
  if (expected.browserEpoch !== undefined && target.browserEpoch !== expected.browserEpoch) throw new CapabilityError('TARGET_STALE', 'Browser target epoch is stale');
  if (expected.documentGeneration !== undefined && target.documentGeneration !== expected.documentGeneration) throw new CapabilityError('TARGET_STALE', 'Browser target document generation is stale');
  if (!target.tabId) throw new CapabilityError('TARGET_REQUIRED', 'Browser target tabId is required');
  return target;
}

export function createEvent<T>(input: Omit<ControlPlaneEvent<T>, 'formatVersion' | 'id'>): ControlPlaneEvent<T> {
  return { ...input, formatVersion: SESSION_FORMAT_VERSION, id: makeControlPlaneId('attempt') };
}

export function digestText(value: string): string {
  return crypto.createHash('sha256').update(value.replace(/\r\n/g, '\n').trim(), 'utf8').digest('hex');
}
