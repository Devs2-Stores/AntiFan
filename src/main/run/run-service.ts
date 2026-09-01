import {
  BrowserTarget,
  ExecutionAttempt,
  AttemptState,
  RunRecord,
  RunState,
  makeControlPlaneId,
  validateControlPlaneId,
  digestText,
  ReceiptBinding,
  validateLaunchPath,
  CapabilityError,
  McpAttachmentLaunch,
  RuntimeLease,
  assertRuntimeLease,
} from '../../shared/control-plane-contracts';
export interface CreateCliSessionOptions {
  projectId: string;
  workspaceId: string;
  chatId?: string;
  backendId?: string;
  grant?: 'read' | 'write' | 'execute' | 'eval';
  tabId?: string;
  browserEpoch?: number;
  ttlMs?: number;
  hostEpoch?: number;
  ownerPid?: number;
  lease: RuntimeLease;
  leaseToken: string;
}
export interface CliSessionResult {
  run: RunRecord;
  attempt: ExecutionAttempt;
  launch: McpAttachmentLaunch;
}

export interface CreateWorkflowSessionOptions {
  projectId: string;
  workspaceId: string;
  workflowName: string;
  chatId?: string;
  grant?: 'read' | 'write' | 'execute' | 'eval';
  tabId?: string;
  browserEpoch?: number;
  hostEpoch?: number;
  ttlMs?: number;
  lease: RuntimeLease;
  leaseToken: string;
  browserTarget?: BrowserTarget;
}
export interface WorkflowSessionResult {
  run: RunRecord;
  attempt: ExecutionAttempt;
  lease: RuntimeLease;
  leaseToken: string;
  launch: McpAttachmentLaunch;
}
import { ChatStore } from '../chat/chat-store';
import { EventStore } from '../session/event-store';
import { ExecutionBackend, StartRunInput } from '../agent/execution-backend';
import { RunEvent } from '../agent/execution-backend';
import { ReceiptStore } from '../session/receipt-store';
import { AttachmentRegistry } from './attachment-registry';
export class RunService {
  private readonly runs = new Map<string, RunRecord>();
  private readonly attempts = new Map<string, ExecutionAttempt>();
  private readonly attemptPids = new Map<string, number>();
  private readonly receiptBindings = new Map<string, ReceiptBinding>();
  private readonly receiptWorkspaces = new Map<string, string>();
  readonly attachments: AttachmentRegistry;

  constructor(
    private readonly chats: ChatStore,
    private readonly events: EventStore,
    private readonly receipts: ReceiptStore,
    private readonly getWorkspaceRoot: (workspaceId: string, projectId: string) => string,
    attachments?: AttachmentRegistry,
    private readonly getHostEpoch: () => number = () => 1,
    private readonly getDocumentGeneration?: (tabId?: string) => number,
    private readonly getAutomationTabId?: () => string | null,
    dataRoot?: string
  ) {
    this.attachments =
      attachments ||
      new AttachmentRegistry({
        getAttemptState: (attemptId) => this.attempts.get(attemptId)?.state,
        getHostEpoch: () => this.getHostEpoch(),
        getBackendId: (attemptId) => this.attempts.get(attemptId)?.backendId,
        getProcessPid: (_runId, attemptId) => this.attemptPids.get(attemptId),
        getDocumentGeneration: (tabId) => (this.getDocumentGeneration ? this.getDocumentGeneration(tabId) : 1),
        getAutomationTabId: this.getAutomationTabId,
      },
      dataRoot);
  }

  setAttemptProcessPid(attemptId: string, pid: number): void {
    this.attemptPids.set(validateControlPlaneId(attemptId, 'attempt'), pid);
  }
  getAttemptProcessPid(attemptId: string): number | undefined {
    return this.attemptPids.get(validateControlPlaneId(attemptId, 'attempt'));
  }
  createRun(projectId: string, workspaceId: string, chatId: string, backendId: string): RunRecord {
    const chat = this.chats.get(chatId, projectId, workspaceId);
    const now = Date.now();
    const run: RunRecord = { id: makeControlPlaneId('run'), projectId: validateControlPlaneId(projectId, 'project'), workspaceId: validateControlPlaneId(workspaceId, 'workspace'), chatId: chat.id, state: 'queued', backendId, createdAt: now, updatedAt: now };
    this.runs.set(run.id, run);
    this.append('run/create', run, run);
    return { ...run };
  }

  getRun(runId: string, projectId?: string): RunRecord {
    const run = this.runs.get(validateControlPlaneId(runId, 'run'));
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (projectId && run.projectId !== validateControlPlaneId(projectId, 'project')) throw new Error('Run does not belong to Project');
    return { ...run };
  }

  getAttempt(attemptId: string, projectId?: string): ExecutionAttempt {
    const attempt = this.attempts.get(validateControlPlaneId(attemptId, 'attempt'));
    if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
    if (projectId && attempt.projectId !== validateControlPlaneId(projectId, 'project')) throw new Error('Attempt does not belong to Project');
    return { ...attempt };
  }

  async start(runId: string, promptText: string, backend: ExecutionBackend, options: Partial<Omit<StartRunInput, 'runId' | 'promptText' | 'attemptId' | 'projectId' | 'workspaceId' | 'chatId'>> = {}): Promise<ExecutionAttempt> {
    const run = this.getRun(runId);
    if (run.state !== 'queued' && run.state !== 'interrupted') throw new Error(`Run cannot start from ${run.state}`);
    if (typeof options.cwd !== 'string' || options.cwd.trim().length === 0) throw new CapabilityError('INVALID_ARGUMENT', 'Run requires an explicitly bound Workspace cwd');
    const authoritativeRoot = this.getWorkspaceRoot(run.workspaceId, run.projectId);
    if (!authoritativeRoot || typeof authoritativeRoot !== 'string') {
      throw new CapabilityError('OUTSIDE_WORKSPACE', `No authoritative workspace root found for workspace: ${run.workspaceId}`);
    }
    const { canonicalRoot, canonicalLaunchCwd } = validateLaunchPath(authoritativeRoot, options.cwd);
    const promptDigest = digestText(promptText);
    const attempt: ExecutionAttempt = { id: makeControlPlaneId('attempt'), runId: run.id, projectId: run.projectId, workspaceId: run.workspaceId, chatId: run.chatId, state: 'prepared', backendId: backend.id, createdAt: Date.now(), updatedAt: Date.now() };
    attempt.promptDigest = promptDigest;
    this.attempts.set(attempt.id, attempt);
    run.state = 'starting';
    run.updatedAt = Date.now();
    this.runs.set(run.id, run);
    this.append('turn/start', { promptText }, run, attempt);
    const canonicalWorkspace = canonicalLaunchCwd;
    this.receiptWorkspaces.set(attempt.id, canonicalWorkspace);
    const requiresReceipt = Boolean(backend.requiresAuthoritativeReceipt);
    const binding: ReceiptBinding | undefined = requiresReceipt
      ? undefined
      : {
          commandId: attempt.id,
          promptDigest,
          projectId: run.projectId,
          workspaceId: run.workspaceId,
          canonicalWorkspace,
          hostInstanceId: backend.id,
          hostEpoch: 0,
          attemptId: attempt.id,
          backendSessionRef: backend.id,
        };
    if (binding) this.receipts.put(binding, 'prepared', 'prepared');
    const input: StartRunInput = { ...options, cwd: canonicalLaunchCwd, canonicalWorkspaceRoot: canonicalRoot, runId: run.id, attemptId: attempt.id, projectId: run.projectId, workspaceId: run.workspaceId, chatId: run.chatId, promptText };
    try {
      for await (const event of backend.startRun(input)) {
        this.applyEvent(run, attempt, event, requiresReceipt);
      }
    } catch (error) {
      const errorCode = 'BACKEND_ERROR';
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (requiresReceipt) {
        attempt.state = 'unknown';
        run.state = 'unknown';
        this.append('backend/status', { state: 'unknown', errorCode, error: errorMessage }, run, attempt);
      } else {
        attempt.state = 'failed';
        run.state = 'failed';
        if (binding) this.receipts.put(binding, 'failed', 'failed', { errorCode, errorMessage });
        this.append('backend/status', { state: 'failed', error: errorMessage }, run, attempt);
      }
    } finally {
      this.attachments.revokeForAttempt(attempt.id);
    }
    return { ...attempt };
  }

  async cancel(runId: string, backend: ExecutionBackend): Promise<void> {
    const run = this.getRun(runId);
    const attempt = Array.from(this.attempts.values()).reverse().find((item) => item.runId === run.id && (item.state === 'prepared' || item.state === 'dispatching' || item.state === 'running'));
    if (!attempt) return;
    this.attachments.revokeForAttempt(attempt.id);
    run.state = 'cancelling';
    attempt.state = 'interrupted';
    run.updatedAt = attempt.updatedAt = Date.now();
    this.append('backend/status', { state: 'cancelling' }, run, attempt);
    await backend.cancel(run.id);
  }

  listRuns(projectId: string): RunRecord[] { return Array.from(this.runs.values()).filter((item) => item.projectId === validateControlPlaneId(projectId, 'project')).map((item) => ({ ...item })); }
  createCliSession(options: CreateCliSessionOptions): CliSessionResult {
    let chatId = options.chatId;
    if (!chatId) {
      const chat = this.chats.create(options.projectId, options.workspaceId, 'CLI Session');
      chatId = chat.id;
    }
    const backendId = options.backendId || 'cli';
    const run = this.createRun(options.projectId, options.workspaceId, chatId, backendId);
    run.state = 'streaming';
    run.updatedAt = Date.now();
    this.runs.set(run.id, run);

    const promptDigest = digestText('cli:interactive');
    const attempt: ExecutionAttempt = {
      id: makeControlPlaneId('attempt'),
      runId: run.id,
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      chatId: run.chatId,
      state: 'running',
      backendId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      promptDigest,
    };
    this.attempts.set(attempt.id, attempt);
    if (typeof options.ownerPid === 'number' && options.ownerPid > 0) {
      this.setAttemptProcessPid(attempt.id, options.ownerPid);
    }
    this.append('turn/start', { promptText: 'cli:interactive' }, run, attempt);

    const { launch } = this.attachments.issueAttachment(run.id, attempt.id, options.projectId, options.workspaceId, {
      backendId,
      chatId,
      grant: options.grant || 'write',
      tabId: options.tabId,
      browserEpoch: options.browserEpoch,
      ttlMs: options.ttlMs || 7_200_000,
      hostEpoch: options.hostEpoch ?? 1,
      boundPid: options.ownerPid,
      lease: options.lease,
      leaseToken: options.leaseToken,
    });

    return { run: { ...run }, attempt: { ...attempt }, launch };
  }

  endCliSession(
    runId: string,
    attemptId: string,
    outcome: 'completed' | 'failed' | 'cancelled' = 'completed',
    error?: string
  ): { ok: boolean } {
    const validRunId = validateControlPlaneId(runId, 'run');
    const validAttemptId = validateControlPlaneId(attemptId, 'attempt');
    const run = this.runs.get(validRunId);
    const attempt = this.attempts.get(validAttemptId);
    const now = Date.now();
    const finalRunState: RunState = outcome === 'completed' ? 'completed' : outcome === 'cancelled' ? 'interrupted' : 'failed';
    const finalAttemptState: AttemptState = outcome === 'completed' ? 'completed' : outcome === 'cancelled' ? 'interrupted' : 'failed';
    if (attempt) {
      attempt.state = finalAttemptState;
      attempt.updatedAt = now;
      this.attempts.set(attempt.id, attempt);
    }
    if (run) {
      run.state = finalRunState;
      run.updatedAt = now;
      this.runs.set(run.id, run);
      this.append('turn/finish', { outcome, error, runState: finalRunState, attemptState: finalAttemptState }, run, attempt);
    }
    this.attachments.revokeForAttempt(validAttemptId);
    this.attemptPids.delete(validAttemptId);
    return { ok: true };
  }

  renewCliSession(attachmentId: string, secret: string, options?: { extensionMs?: number; ownerPid?: number }): { expiresAt: number } {
    return this.attachments.renewAttachment(attachmentId, secret, options);
  }
  createWorkflowSession(options: CreateWorkflowSessionOptions): WorkflowSessionResult {
    assertRuntimeLease(options.lease, {
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      hostEpoch: options.hostEpoch,
      token: options.leaseToken,
    });

    const authoritativeRoot = this.getWorkspaceRoot(options.workspaceId, options.projectId);
    if (!authoritativeRoot || typeof authoritativeRoot !== 'string') {
      throw new CapabilityError('OUTSIDE_WORKSPACE', `No authoritative workspace root found for workspace: ${options.workspaceId}`);
    }

    const chatId = options.chatId
      ? this.chats.get(options.chatId, options.projectId, options.workspaceId).id
      : this.chats.create(options.projectId, options.workspaceId, `Workflow: ${options.workflowName}`).id;

    const backendId = 'workflow';
    const run = this.createRun(options.projectId, options.workspaceId, chatId, backendId);
    run.state = 'streaming';
    run.updatedAt = Date.now();
    this.runs.set(run.id, run);

    const promptDigest = digestText(`workflow:${options.workflowName}`);
    const attempt: ExecutionAttempt = {
      id: makeControlPlaneId('attempt'),
      runId: run.id,
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      chatId: run.chatId,
      state: 'running',
      backendId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      promptDigest,
    };
    this.attempts.set(attempt.id, attempt);
    this.append('turn/start', { promptText: `workflow:${options.workflowName}`, workflowName: options.workflowName }, run, attempt);

    const canonicalWorkspace = authoritativeRoot;
    this.receiptWorkspaces.set(attempt.id, canonicalWorkspace);

    const binding: ReceiptBinding = {
      commandId: attempt.id,
      promptDigest,
      projectId: run.projectId,
      workspaceId: run.workspaceId,
      canonicalWorkspace,
      hostInstanceId: 'workflow-engine',
      hostEpoch: options.hostEpoch ?? 1,
      attemptId: attempt.id,
      backendSessionRef: backendId,
    };
    this.receiptBindings.set(attempt.id, binding);
    this.receipts.put(binding, 'accepted', 'accepted-exact');
    const { launch } = this.attachments.issueAttachment(
      run.id,
      attempt.id,
      run.projectId,
      run.workspaceId,
      {
        backendId,
        grant: options.grant || 'write',
        lease: options.lease,
        leaseToken: options.leaseToken,
        tabId: options.tabId ?? options.browserTarget?.tabId,
        browserEpoch: options.browserEpoch ?? options.browserTarget?.browserEpoch,
        documentGeneration: options.browserTarget?.documentGeneration,
        browserTarget: options.browserTarget,
        hostEpoch: options.hostEpoch,
        ttlMs: options.ttlMs,
      }
    );

    return {
      run: { ...run },
      attempt: { ...attempt },
      lease: options.lease,
      leaseToken: options.leaseToken,
      launch,
    };
  }

  endWorkflowSession(
    runId: string,
    attemptId: string,
    outcome: 'completed' | 'failed' | 'cancelled' = 'completed',
    error?: string,
    artifacts?: unknown[]
  ): { ok: boolean } {
    const validRunId = validateControlPlaneId(runId, 'run');
    const validAttemptId = validateControlPlaneId(attemptId, 'attempt');
    const run = this.runs.get(validRunId);
    const attempt = this.attempts.get(validAttemptId);
    const now = Date.now();
    const finalRunState: RunState = outcome === 'completed' ? 'completed' : outcome === 'cancelled' ? 'interrupted' : 'failed';
    const finalAttemptState: AttemptState = outcome === 'completed' ? 'completed' : outcome === 'cancelled' ? 'interrupted' : 'failed';
    if (attempt) {
      attempt.state = finalAttemptState;
      attempt.updatedAt = now;
      this.attempts.set(attempt.id, attempt);
    }
    if (run) {
      run.state = finalRunState;
      run.updatedAt = now;
      this.runs.set(run.id, run);
      this.append('turn/finish', { outcome, error, runState: finalRunState, attemptState: finalAttemptState, artifacts }, run, attempt);
    }
    const finalReceiptState: 'completed' | 'failed' = outcome === 'completed' ? 'completed' : 'failed';
    const deliveryState: 'accepted-exact' | 'failed' = outcome === 'completed' ? 'accepted-exact' : 'failed';
    const binding = this.receiptBindings.get(validAttemptId);
    if (binding) {
      this.receipts.put(binding, finalReceiptState, deliveryState, error ? { errorMessage: error } : undefined);
    }
    this.attachments.revokeForAttempt(validAttemptId);
    return { ok: true };
  }

  private applyEvent(run: RunRecord, attempt: ExecutionAttempt, event: RunEvent, requiresReceipt = false): void {
    if (event.type === 'receipt') {
      const receipt = event.receipt;
      const expectedWorkspace = this.receiptWorkspaces.get(attempt.id);
      const expectedProviderSession = attempt.backendSessionRef?.providerSessionId;
      if (!expectedWorkspace || (requiresReceipt && (!expectedProviderSession || receipt.binding.backendSessionRef !== expectedProviderSession)) || receipt.binding.projectId !== run.projectId || receipt.binding.workspaceId !== run.workspaceId || receipt.binding.attemptId !== attempt.id || receipt.binding.promptDigest !== attempt.promptDigest || receipt.binding.canonicalWorkspace.toLowerCase() !== expectedWorkspace.toLowerCase() || !receipt.binding.commandId || !receipt.binding.hostInstanceId || receipt.binding.hostInstanceId === 'unknown' || !Number.isFinite(receipt.binding.hostEpoch) || receipt.binding.hostEpoch === 0) {
        throw new Error('Authoritative receipt binding mismatch');
      }
      this.receiptBindings.set(attempt.id, { ...receipt.binding });
      attempt.commandId = receipt.binding.commandId;
      const persisted = this.receipts.put(receipt.binding, receipt.state, receipt.deliveryState, { errorCode: receipt.errorCode, errorMessage: receipt.errorMessage });
      if (persisted.state === 'completed' || persisted.state === 'failed' || persisted.state === 'unknown') {
        attempt.state = persisted.state;
        run.state = persisted.state;
      } else {
        attempt.state = 'running';
        run.state = 'streaming';
      }
      run.updatedAt = attempt.updatedAt = Date.now();
      this.append('backend/receipt', receipt, run, attempt);
      return;
    }
    if (event.type === 'session/ref') {
      if (event.sessionRef.backendId !== attempt.backendId) throw new Error('Backend session identity mismatch');
      attempt.backendSessionRef = { ...event.sessionRef };
      if (typeof event.sessionRef.processPid === 'number' && Number.isFinite(event.sessionRef.processPid) && event.sessionRef.processPid > 0) {
        this.setAttemptProcessPid(attempt.id, event.sessionRef.processPid);
      }
    }
    if (event.type === 'status') {
      const state = event.state;
      const terminal = state === 'completed' || state === 'failed' || state === 'interrupted' || state === 'unknown';
      const binding = this.receiptBindings.get(attempt.id);
      if (requiresReceipt && terminal) {
        const persisted = binding ? this.receipts.findByCommand(binding.commandId) : undefined;
        const matchesTerminal = persisted && ((state === 'completed' && persisted.state === 'completed') || (state === 'failed' && persisted.state === 'failed') || (state === 'unknown' && persisted.state === 'unknown'));
        if (!matchesTerminal) {
          attempt.state = 'unknown';
          run.state = 'unknown';
          run.updatedAt = attempt.updatedAt = Date.now();
          this.append('backend/status', { ...event, state: 'unknown', errorCode: 'AUTHORITATIVE_RECEIPT_REQUIRED' }, run, attempt);
          return;
        }
      }
      if (state === 'completed' || state === 'failed' || state === 'interrupted' || state === 'unknown') attempt.state = state;
      else if (state === 'starting' || state === 'streaming' || state === 'waiting-tool' || state === 'cancelling') attempt.state = state === 'starting' ? 'dispatching' : 'running';
      run.state = state;
      if (!binding) {
        run.updatedAt = attempt.updatedAt = Date.now();
        this.append('backend/status', event, run, attempt);
        return;
      }
      const receiptState = state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : state === 'unknown' ? 'unknown' : 'accepted';
      const deliveryState = state === 'completed' ? 'accepted-exact' : state === 'failed' ? 'failed' : state === 'unknown' ? 'unknown' : 'dispatching';
      this.receipts.put(binding, receiptState, deliveryState, terminal && event.errorCode ? { errorCode: event.errorCode, errorMessage: event.errorMessage } : {});
    }
    if (event.type === 'text' || event.type === 'tool/result') {
      run.state = 'streaming';
      attempt.state = 'running';
    }
    run.updatedAt = attempt.updatedAt = Date.now();
    this.append(event.type === 'text' ? 'assistant/chunk' : `backend/${event.type}`, event, run, attempt);
  }

  private append(type: string, payload: unknown, run: RunRecord, attempt?: ExecutionAttempt): void {
    this.events?.append({ type, projectId: run.projectId, workspaceId: run.workspaceId, chatId: run.chatId, runId: run.id, attemptId: attempt?.id, createdAt: Date.now(), payload });
  }
}
