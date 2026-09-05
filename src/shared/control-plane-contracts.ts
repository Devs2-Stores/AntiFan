import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CONTROL_PLANE_PROTOCOL_VERSION = 1;
export const SESSION_FORMAT_VERSION = 1;
export * from './theme-task-context';

export type ControlPlaneEntity = 'project' | 'workspace' | 'chat' | 'run' | 'attempt' | 'tool' | 'artifact' | 'binding' | 'invocation' | 'event' | 'message' | 'request' | 'idempotency' | 'attachment';
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
  projectId: string;
  workspaceId: string;
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
  processPid?: number;
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
  control?: CapabilityExecutionControl;
}

export interface McpAttachmentLaunch {
  attachmentId: string;
  runId: string;
  attemptId: string;
  projectId: string;
  workspaceId: string;
  secret: string;
  backendId: string;
  issuedAt: number;
  expiresAt: number;
  hostEpoch: number;
  grant?: 'read' | 'write' | 'execute' | 'eval';
  tabId?: string;
  browserEpoch?: number;
  authorityRevision: AuthorityRevisionHandle;
}

export interface UntrustedCapabilityClaims {
  attachmentId?: string;
  attachmentSecret?: string;
  runId?: string;
  attemptId?: string;
  projectId?: string;
  workspaceId?: string;
  tabId?: string;
  browserEpoch?: number;
  expectedDocumentGeneration?: number;
  invocationId?: string;
  grant?: 'read' | 'write' | 'execute' | 'eval';
  ownerPid?: number;
}

export type AuthorityRevisionHandle = string;

export type InvocationState = 'claiming' | 'in_progress' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export type InvocationDispatchStage = 'pre_dispatch' | 'dispatch_started';

export type OwnerCancellationBehavior = 'abort-immediate' | 'drain-and-persist';
export type SubscriberDisconnectBehavior = 'abort-when-unobserved' | 'detach-and-continue';

export type EffectMarker = 'not-started' | 'effect-started' | 'effect-committed';
export type EffectAcknowledgement = 'no-effect' | 'effect-possible' | 'effect-committed';
export type CancellationAck = EffectAcknowledgement;

export interface CapabilityExecutionControl {
  readonly cancellationId?: string;
  readonly cancellationSource?: 'owner' | 'subscriber' | 'timeout' | 'system';
  readonly effectStage: EffectMarker;
  setEffectStage(stage: 'effect-started' | 'effect-committed'): void;
  readonly signal: AbortSignal;
  acknowledgeCancellation(cancellationId: string, ack: EffectAcknowledgement): boolean;
  readonly cancellationAck?: EffectAcknowledgement;
}
export interface ClientInvocationIntent<T = unknown> {
  requestId: string;
  idempotencyKey: string;
  attachmentId: string;
  attachmentSecret: string;
  authorityRevision: AuthorityRevisionHandle;
  name: string;
  params?: T;
}

export interface MainResolvedAuthority {
  attachmentId: string;
  authorityRevision: AuthorityRevisionHandle;
  revisionNumber: number;
  projectId: string;
  workspaceId?: string;
  runId: string;
  attemptId: string;
  backendId: string;
  grant: CapabilityRisk;
  hostEpoch: number;
  runtimePid: number;
  runtimeLeaseToken?: string;
  leaseExpiresAt: number;
  browserTarget?: BrowserTarget;
  issuedAt: number;
}

export interface CapabilityEffectPolicy {
  effect: 'read' | 'idempotent-write' | 'destructive-mutation' | 'interactive-effect' | 'management';
  risk: CapabilityRisk;
  requiresBrowserTarget: boolean;
  schedulerLane: 'short-passive' | 'event-wait' | 'viewport-gate' | 'unbounded';
  duplicateMode: 'in-process-join' | 'reject-concurrent';
  recordedVisibility: 'public' | 'tenant-scoped' | 'run-scoped' | 'redacted';
  receiptReadPermission: CapabilityRisk;
  timeoutMs: number;
  retentionPolicy: 'ephemeral' | 'run-durable' | 'permanent';
  ownerCancellationBehavior: OwnerCancellationBehavior;
  subscriberDisconnectBehavior: SubscriberDisconnectBehavior;
  cancellationAckTimeoutMs: number;
  policyVersion: number;
  policyDigest: string;
}
export type CapabilityEffectPolicyInput = Omit<CapabilityEffectPolicy, 'policyDigest'>;
export interface InvocationBinding {
  attachmentId: string;
  idempotencyKey: string;
  authorityRevision: AuthorityRevisionHandle;
  canonicalCapability: string;
  parameterDigest: string;
  policyDigest: string;
}

export interface McpEvidence {
  timestamp?: number;
  tabId?: string;
  url?: string;
  title?: string;
  documentGeneration?: number;
  browserEpoch?: number;
  viewport?: { width: number; height: number };
  executionTier?: 'cdp_trusted' | 'isolated_synthetic';
  fallbackReason?: string;
  [key: string]: unknown;
}

export interface AuthoritativeInvocationReceipt<T = unknown> {
  invocationId: string;
  originRequestId: string;
  binding?: InvocationBinding;
  state: InvocationState;
  dispatchStage?: InvocationDispatchStage;
  startedAt: number;
  completedAt?: number;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  evidence?: McpEvidence;
  replacementAuthorityRevision?: AuthorityRevisionHandle;
}

export interface BrowserObserveInput {
  tabId?: string;
  paneId?: 'desktop' | 'mobile';
  components?: Array<'dom' | 'snapshot' | 'screenshot' | 'diagnostics' | 'network'>;
  timeoutMs?: number;
}

export interface BrowserObserveResult {
  browserEpoch: number;
  tabId: string;
  paneId: 'desktop' | 'mobile';
  documentGeneration: number;
  documentUrl: string;
  captureTimestamp: number;
  driftWindowMs: number;
  dom?: {
    html: string;
    artifactRef?: ArtifactRef;
    byteLength: number;
  };
  snapshot?: {
    generation: number;
    descriptorsCount: number;
    serializedBytes: number;
    rootSummary?: string;
  };
  screenshot?: {
    artifactRef: ArtifactRef;
    mime: 'image/png';
  };
  diagnostics?: unknown;
  network?: {
    inflightCount: number;
    isIdle: boolean;
  };
}

export interface BrowserWaitInput {
  tabId?: string;
  paneId?: 'desktop' | 'mobile';
  condition: 'selector' | 'ref' | 'document-loaded' | 'url' | 'network-idle' | 'dom-stable';
  selector?: string;
  ref?: string;
  urlPattern?: string;
  stabilityMs?: number;
  timeoutMs?: number;
}

export interface BrowserWaitResult {
  satisfied: boolean;
  condition: string;
  durationMs: number;
  documentGeneration: number;
}

export interface TerminalWaitInput {
  sessionId: string;
  condition: 'output-match' | 'exit' | 'silence';
  pattern?: string;
  sessionGeneration?: number;
  afterSeq?: number;
  silenceMs?: number;
  timeoutMs?: number;
}

export interface TerminalWaitResult {
  satisfied: boolean;
  sessionGeneration: number;
  lastSeq: number;
  exitCode?: number;
  outputTail?: string;
}

export interface ArtifactReadInput {
  artifactId: string;
  offset?: number;
  limit?: number;
}

export interface ArtifactReadResult {
  artifactId: string;
  offset: number;
  limit: number;
  totalBytes: number;
  hasMore: boolean;
  mime: string;
  encoding: 'utf8' | 'base64';
  data: string;
}

export function canonicalJsonStringify(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const record = val as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}
export function canonicalDigest(val: unknown): string {
  return crypto.createHash('sha256').update(canonicalJsonStringify(val), 'utf8').digest('hex');
}

export function computePolicyDigest(policy: Omit<CapabilityEffectPolicy, 'policyDigest'>): string {
  return canonicalDigest({
    effect: policy.effect,
    risk: policy.risk,
    requiresBrowserTarget: policy.requiresBrowserTarget,
    schedulerLane: policy.schedulerLane,
    duplicateMode: policy.duplicateMode,
    recordedVisibility: policy.recordedVisibility,
    receiptReadPermission: policy.receiptReadPermission,
    timeoutMs: policy.timeoutMs,
    retentionPolicy: policy.retentionPolicy,
    ownerCancellationBehavior: policy.ownerCancellationBehavior,
    subscriberDisconnectBehavior: policy.subscriberDisconnectBehavior,
    cancellationAckTimeoutMs: policy.cancellationAckTimeoutMs,
    policyVersion: policy.policyVersion,
  });
}

export interface InternalChildCapabilityResponse {
  ok: boolean;
  state?: InvocationState;
  data?: unknown;
  error?: { code?: string; message: string; details?: unknown };
  replacementAuthorityRevision?: string;
}

export interface CapabilityDispatchRuntimeOptions {
  signal?: AbortSignal;
  progressSink?: { onProgress: (event: unknown) => void };
}

export interface AuthenticatedCapabilityContext {
  attachmentId: string;
  runId: string;
  attemptId: string;
  projectId: string;
  workspaceId: string;
  chatId?: string;
  backendId: string;
  hostEpoch: number;
  invocationId: string;
  lease: RuntimeLease;
  leaseToken: string;
  browserTarget?: BrowserTarget;
  grant?: 'read' | 'write' | 'execute' | 'eval';
  signal?: AbortSignal;
  control?: CapabilityExecutionControl;
  progressSink?: { onProgress: (event: unknown) => void };
  authorityRevision?: string;
  dispatchChildIntent?: (stepId: string, attempt: number, intent: ClientInvocationIntent) => Promise<InternalChildCapabilityResponse>;
}
export type AttachmentState = 'issued' | 'bound' | 'active' | 'revoked' | 'expired' | 'stale';

export interface ExecutionAttachmentRecord {
  id: string;
  runId: string;
  attemptId: string;
  projectId: string;
  workspaceId: string;
  chatId?: string;
  backendId: string;
  secretHash: string;
  state: AttachmentState;
  hostEpoch: number;
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  revocationReason?: string;
  boundPid?: number;
  connectionId?: string;
  grant?: 'read' | 'write' | 'execute' | 'eval';
  tabId?: string;
  browserEpoch?: number;
  documentGeneration?: number;
  lease?: RuntimeLease;
  leaseToken?: string;
  browserTarget?: BrowserTarget;
  authorityRevision: AuthorityRevisionHandle;
  revisionNumber: number;
}

export interface CapabilityDefinition<TParams = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  risk: CapabilityRisk;
  requiresBrowserTarget?: boolean;
  inputSchema: Record<string, unknown>;
  policy: CapabilityEffectPolicyInput;
  execute: (params: TParams, context: CapabilityRequestContext) => Promise<TResult> | TResult;
}

export interface RegisteredCapability<TParams = Record<string, unknown>, TResult = unknown> extends Omit<CapabilityDefinition<TParams, TResult>, 'policy'> {
  policy: CapabilityEffectPolicy;
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

export type CapabilityErrorCode =
  | 'UNAUTHENTICATED'
  | 'LEASE_EXPIRED'
  | 'PROJECT_MISMATCH'
  | 'WORKSPACE_MISMATCH'
  | 'WORKSPACE_UNBOUND'
  | 'FILE_LOCK_TIMEOUT'
  | 'RUNTIME_MISMATCH'
  | 'TARGET_REQUIRED'
  | 'TARGET_STALE'
  | 'TARGET_MISMATCH'
  | 'POLICY_DENIED'
  | 'CAPABILITY_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'OUTSIDE_WORKSPACE'
  | 'ARTIFACT_TOO_LARGE'
  | 'RUNTIME_DRAINING'
  | 'ATTACHMENT_REQUIRED'
  | 'ATTACHMENT_INVALID'
  | 'ATTACHMENT_STALE'
  | 'LINEAGE_MISMATCH'
  | 'AUTHENTICATION_DENIED'
  | 'BINDING_COLLISION'
  | 'DURABILITY_FAILED'
  | 'REVISION_STALE'
  | 'ATTEMPT_INACTIVE'
  | 'HOST_EPOCH_STALE'
  | 'LEDGER_CLAIM_FAILED'
  | 'ATTEMPT_NOT_ACTIVE'
  | 'PROCESS_MISMATCH'
  | 'MCP_CONTEXT_REQUIRED'
  | 'REPLAY_DENIED'
  | 'LAUNCH_ERROR'
  | 'REF_STALE'
  | 'REF_NOT_FOUND'
  | 'FINGERPRINT_MISMATCH'
  | 'NODE_DETACHED'
  | 'CAPABILITY_OVERLOADED'
  | 'PREEMPTED_BY_USER'
  | 'HMR_DRIFT'
  | 'REF_AMBIGUOUS'
  | 'INTEGRITY_COMPROMISED'
  | 'SESSION_STALE'
  | 'SESSION_CLOSED'
  | 'WAIT_TIMEOUT'
  | 'WAIT_ABORTED'
  | 'STORE_CONTEXT_MISMATCH'
  | 'CAS_MISMATCH'
  | 'STALE_LINEAGE'
  | 'TRANSACTION_CONFLICT';

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

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || process.platform === 'win32';
}

export function canonicalizeWorkspaceRoot(root: string): string {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new CapabilityError('INVALID_ARGUMENT', 'Workspace root is required');
  }
  const api = pathApi(root);
  const resolved = api.resolve(root);
  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch (err: unknown) {
    throw new CapabilityError('OUTSIDE_WORKSPACE', `Workspace root cannot be resolved: ${root}`, { root, error: String(err) });
  }
  const trimmed = real.replace(/[\\/]+$/, '');
  return isWindowsPath(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export function assertWorkspaceContained(root: string, candidate: string, allowRoot = false): string {
  const canonicalRoot = canonicalizeWorkspaceRoot(root);
  const api = pathApi(candidate);
  const resolved = api.resolve(candidate);
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync.native(resolved);
  } catch {
    realCandidate = resolved;
  }
  const trimmed = realCandidate.replace(/[\\/]+$/, '');
  const canonicalCandidate = isWindowsPath(trimmed) ? trimmed.toLowerCase() : trimmed;
  const isWin = isWindowsPath(canonicalRoot);
  const normApi = isWin ? path.win32 : path.posix;
  const relative = normApi.relative(canonicalRoot, canonicalCandidate);
  if (relative === '' && allowRoot) return canonicalCandidate;
  if (relative === '' || relative === '..' || relative.startsWith('..' + normApi.sep) || normApi.isAbsolute(relative)) {
    throw new CapabilityError('OUTSIDE_WORKSPACE', 'Path is outside the attached workspace', { root: canonicalRoot, candidate: canonicalCandidate });
  }
  return canonicalCandidate;
}

export function assertNoReparseTraversal(root: string, candidate: string): void {
  const api = pathApi(root);
  const resolvedRoot = api.resolve(root);
  const resolvedCandidate = api.resolve(candidate);
  const isWin = isWindowsPath(resolvedRoot);
  const normApi = isWin ? path.win32 : path.posix;

  const rootNorm = isWin ? resolvedRoot.toLowerCase() : resolvedRoot;
  const candNorm = isWin ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const relative = normApi.relative(rootNorm, candNorm);
  if (relative === '..' || relative.startsWith('..' + normApi.sep) || normApi.isAbsolute(relative)) {
    throw new CapabilityError('OUTSIDE_WORKSPACE', 'Path is outside the attached workspace');
  }

  // Check root segments first to ensure root is not behind a symlink/junction
  const parsedRoot = api.parse(resolvedRoot);
  let current = parsedRoot.root;
  const rootSegments = resolvedRoot.slice(parsedRoot.root.length).split(/[\\/]+/).filter(Boolean);
  for (const segment of rootSegments) {
    current = api.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new CapabilityError('OUTSIDE_WORKSPACE', `Symlink or junction traversal is not permitted: ${current}`);
      }
    } catch (error: unknown) {
      if (error instanceof CapabilityError) throw error;
      throw new CapabilityError('OUTSIDE_WORKSPACE', `Path segment inaccessible: ${current}`);
    }
  }

  // Check candidate descendant segments
  const parts = relative ? relative.split(/[\\/]+/).filter(Boolean) : [];
  current = resolvedRoot;
  for (const part of parts) {
    current = api.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new CapabilityError('OUTSIDE_WORKSPACE', `Symlink or junction traversal is not permitted: ${current}`);
      }
    } catch (error: unknown) {
      if (error instanceof CapabilityError) throw error;
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') break;
      throw new CapabilityError('OUTSIDE_WORKSPACE', `Path segment inaccessible: ${current}`);
    }
  }
}

export const SECRET_VERIFIER_PREFIX = 'v1:sha256:';

export function hashSecret(secret: string): string {
  const digest = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  return `${SECRET_VERIFIER_PREFIX}${digest}`;
}

export function verifySecret(secret: string, secretHash: string): boolean {
  if (typeof secret !== 'string' || typeof secretHash !== 'string') return false;
  if (!secretHash.startsWith(SECRET_VERIFIER_PREFIX)) return false;
  const targetHash = secretHash.slice(SECRET_VERIFIER_PREFIX.length);
  const computed = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  try {
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(targetHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function validateLaunchPath(rootPath: string, candidatePath?: string): { canonicalRoot: string; canonicalLaunchCwd: string } {
  if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
    throw new CapabilityError('INVALID_ARGUMENT', 'Workspace rootPath is required');
  }
  const api = pathApi(rootPath);
  const resolvedRoot = api.resolve(rootPath);
  if (!fs.existsSync(resolvedRoot)) {
    throw new CapabilityError('OUTSIDE_WORKSPACE', `Workspace root does not exist: ${rootPath}`);
  }
  const rootStat = fs.statSync(resolvedRoot);
  if (!rootStat.isDirectory()) {
    throw new CapabilityError('OUTSIDE_WORKSPACE', `Workspace root is not a directory: ${rootPath}`);
  }
  const canonicalRoot = canonicalizeWorkspaceRoot(resolvedRoot);

  const target = candidatePath && candidatePath.trim().length > 0 ? candidatePath : resolvedRoot;
  const resolvedCandidate = api.resolve(target);
  if (!fs.existsSync(resolvedCandidate)) {
    throw new CapabilityError('OUTSIDE_WORKSPACE', `Launch path does not exist: ${target}`);
  }
  const candStat = fs.statSync(resolvedCandidate);
  if (!candStat.isDirectory()) {
    throw new CapabilityError('OUTSIDE_WORKSPACE', `Launch path is not a directory: ${target}`);
  }

  assertNoReparseTraversal(resolvedRoot, resolvedCandidate);
  const canonicalLaunchCwd = assertWorkspaceContained(canonicalRoot, resolvedCandidate, true);
  return { canonicalRoot, canonicalLaunchCwd };
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

export function assertExactBrowserTarget(
  target: BrowserTarget | undefined,
  expected: Pick<BrowserBinding, 'projectId' | 'workspaceId' | 'runtimeId'> & Partial<Pick<BrowserBinding, 'browserEpoch' | 'documentGeneration'>>,
  allowMissingTab = false
): BrowserTarget {
  if (!target) throw new CapabilityError('TARGET_REQUIRED', 'An explicit BrowserTarget is required');
  if (target.projectId !== expected.projectId || target.workspaceId !== expected.workspaceId || target.runtimeId !== expected.runtimeId) throw new CapabilityError('WORKSPACE_MISMATCH', 'Browser target ownership does not match request');
  if (expected.browserEpoch !== undefined && target.browserEpoch !== expected.browserEpoch) throw new CapabilityError('TARGET_STALE', 'Browser target epoch is stale');
  if (expected.documentGeneration !== undefined && target.documentGeneration !== expected.documentGeneration) throw new CapabilityError('TARGET_STALE', 'Browser target document generation is stale');
  if (!allowMissingTab && !target.tabId) throw new CapabilityError('TARGET_REQUIRED', 'Browser target tabId is required');
  return target;
}

export function createEvent<T>(input: Omit<ControlPlaneEvent<T>, 'formatVersion' | 'id'>): ControlPlaneEvent<T> {
  return { ...input, formatVersion: SESSION_FORMAT_VERSION, id: makeControlPlaneId('event') };
}

export function digestText(value: string): string {
  return crypto.createHash('sha256').update(value.replace(/\r\n/g, '\n').trim(), 'utf8').digest('hex');
}
