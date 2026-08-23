import {
  ExecutionAttempt,
  RunRecord,
  RunState,
  makeControlPlaneId,
  validateControlPlaneId,
  digestText,
  ReceiptBinding,
  canonicalizeWorkspaceRoot,
} from '../../shared/control-plane-contracts';
import { ChatStore } from '../chat/chat-store';
import { EventStore } from '../session/event-store';
import { ExecutionBackend, StartRunInput } from '../agent/execution-backend';
import { RunEvent } from '../agent/execution-backend';
import { ReceiptStore } from '../session/receipt-store';

export class RunService {
  private readonly runs = new Map<string, RunRecord>();
  private readonly attempts = new Map<string, ExecutionAttempt>();
  private readonly receiptBindings = new Map<string, ReceiptBinding>();
  private readonly receiptWorkspaces = new Map<string, string>();

  constructor(private readonly chats: ChatStore, private readonly events: EventStore, private readonly receipts: ReceiptStore) {}

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
    if (typeof options.cwd !== 'string' || options.cwd.trim().length === 0) throw new Error('Run requires an explicitly bound Workspace cwd');
    const promptDigest = digestText(promptText);
    const attempt: ExecutionAttempt = { id: makeControlPlaneId('attempt'), runId: run.id, projectId: run.projectId, workspaceId: run.workspaceId, chatId: run.chatId, state: 'prepared', backendId: backend.id, createdAt: Date.now(), updatedAt: Date.now() };
    attempt.promptDigest = promptDigest;
    this.attempts.set(attempt.id, attempt);
    run.state = 'starting';
    run.updatedAt = Date.now();
    this.runs.set(run.id, run);
    this.append('turn/start', { promptText }, run, attempt);
    const canonicalWorkspace = canonicalizeWorkspaceRoot(options.cwd);
    this.receiptWorkspaces.set(attempt.id, canonicalWorkspace);
    const requiresReceipt = backend.requiresAuthoritativeReceipt === true;
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
    const input: StartRunInput = { ...options, cwd: options.cwd, runId: run.id, attemptId: attempt.id, projectId: run.projectId, workspaceId: run.workspaceId, chatId: run.chatId, promptText };
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
    }
    return { ...attempt };
  }

  async cancel(runId: string, backend: ExecutionBackend): Promise<void> {
    const run = this.getRun(runId);
    const attempt = Array.from(this.attempts.values()).reverse().find((item) => item.runId === run.id && ['prepared', 'dispatching', 'running'].includes(item.state));
    if (!attempt) return;
    run.state = 'cancelling';
    attempt.state = 'interrupted';
    run.updatedAt = attempt.updatedAt = Date.now();
    this.append('backend/status', { state: 'cancelling' }, run, attempt);
    await backend.cancel(run.id);
  }

  listRuns(projectId: string): RunRecord[] { return Array.from(this.runs.values()).filter((item) => item.projectId === validateControlPlaneId(projectId, 'project')).map((item) => ({ ...item })); }

  private applyEvent(run: RunRecord, attempt: ExecutionAttempt, event: RunEvent, requiresReceipt = false): void {
    if (event.runId !== run.id || event.attemptId !== attempt.id) throw new Error('Backend event identity mismatch');
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
