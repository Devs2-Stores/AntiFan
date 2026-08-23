import { AntigravityCommandClient, DispatchCommandParams, computePromptDigest } from '../../bridge/antigravity-command-client';
import { AntigravityResultV2 } from '../../../shared/contracts';
import { BackendSessionRef, ReceiptBinding, RunState, canonicalizeWorkspaceRoot } from '../../../shared/control-plane-contracts';
import { ExecutionBackend, RunEvent, StartRunInput } from '../../agent/execution-backend';

export interface AntigravityExecutionBackendOptions {
  clientFactory: (workspacePath: string) => AntigravityCommandClient;
  hostInstanceId?: string;
  hostEpoch?: number;
}

export class AntigravityExecutionBackend implements ExecutionBackend {
  readonly id = 'antigravity';
  readonly requiresAuthoritativeReceipt = true;
  private readonly clients = new Map<string, AntigravityCommandClient>();
  private readonly commandIds = new Map<string, string>();

  constructor(private readonly options: AntigravityExecutionBackendOptions) {}

  async *startRun(input: StartRunInput): AsyncIterable<RunEvent> {
    if (!input.cwd || input.cwd.trim().length === 0) throw new Error('Antigravity backend requires an explicitly bound Workspace cwd');
    const client = this.options.clientFactory(input.cwd);
    this.clients.set(input.runId, client);
    const host = client.readHostStatus();
    const hostInstanceId = host?.hostInstanceId || this.options.hostInstanceId;
    const hostEpoch = host?.hostEpoch ?? this.options.hostEpoch;
    if (!hostInstanceId || hostEpoch === undefined) throw new Error('Antigravity backend requires an actual Extension Host identity');
    yield { type: 'status', runId: input.runId, attemptId: input.attemptId, state: 'starting' };
    const providerSessionId = input.backendSessionRef?.providerSessionId;
    if (!providerSessionId) throw new Error('Antigravity backend requires an exact provider conversation session');
    const sessionRef: BackendSessionRef = { backendId: this.id, opaqueRef: input.backendSessionRef?.opaqueRef || `${input.runId}:${input.attemptId}`, providerSessionId, createdAt: Date.now() };
    yield { type: 'session/ref', runId: input.runId, attemptId: input.attemptId, sessionRef };
    const calleeDeadlineMs = 30_000;
    const ioBufferMs = 5_000;
    const callerTimeoutMs = Math.max(input.timeoutMs ?? 0, calleeDeadlineMs + ioBufferMs);
    const params: DispatchCommandParams = { action: 'send-prompt', mode: 'auto', promptText: input.promptText, timeoutMs: callerTimeoutMs, targetConversationId: providerSessionId, backendSessionRef: providerSessionId, meta: { projectId: input.projectId, workspaceId: input.workspaceId, attemptId: input.attemptId, hostInstanceId, hostEpoch } };
    const dispatch = client.dispatchCommand(params);
    this.commandIds.set(input.runId, dispatch.command.id);
    yield { type: 'status', runId: input.runId, attemptId: input.attemptId, state: 'streaming' };
    const receipt = await dispatch.resultPromise;
    if (receipt.commandId !== dispatch.command.id || receipt.hostInstanceId !== hostInstanceId || receipt.hostEpoch !== hostEpoch || receipt.promptDigest !== computePromptDigest(input.promptText) || receipt.projectId !== input.projectId || receipt.workspaceId !== input.workspaceId || receipt.attemptId !== input.attemptId || receipt.backendSessionRef !== providerSessionId || !receipt.targetWorkspace || canonicalizeWorkspaceRoot(receipt.targetWorkspace.folderUri) !== canonicalizeWorkspaceRoot(input.cwd)) {
      throw new Error('Antigravity receipt did not contain a validated command and host binding');
    }
    yield* this.emitReceiptEvents(input, receipt, hostInstanceId, hostEpoch, providerSessionId);
    if (receipt.deliveryState === 'unknown') {
      const lateReceipt = await this.waitForLateReceipt(client, dispatch.command, hostInstanceId, hostEpoch, providerSessionId);
      if (lateReceipt) yield* this.emitReceiptEvents(input, lateReceipt, hostInstanceId, hostEpoch, providerSessionId);
    }
  }

  private async *emitReceiptEvents(input: StartRunInput, receipt: AntigravityResultV2, hostInstanceId: string, hostEpoch: number, providerSessionId: string): AsyncIterable<RunEvent> {
    const binding: ReceiptBinding = antigravityReceiptBinding(input, receipt.commandId, input.cwd, hostInstanceId, hostEpoch, providerSessionId);
    const authoritativeDeliveryState = receipt.deliveryState === 'unknown' ? 'unknown' : receipt.deliveryState === 'ide-api-accepted' ? 'accepted-exact' : receipt.ok ? 'accepted-exact' : 'failed';
    yield { type: 'receipt', runId: input.runId, attemptId: input.attemptId, receipt: { binding, state: receipt.deliveryState === 'unknown' ? 'unknown' : receipt.ok ? 'completed' : 'failed', deliveryState: authoritativeDeliveryState, errorCode: receipt.errorCode, errorMessage: receipt.errorMessage } };
    if (receipt.deliveryState === 'unknown') yield { type: 'status', runId: input.runId, attemptId: input.attemptId, state: 'unknown', errorCode: receipt.errorCode, errorMessage: receipt.errorMessage };
    else if (receipt.ok) yield { type: 'status', runId: input.runId, attemptId: input.attemptId, state: 'completed' };
    else yield { type: 'status', runId: input.runId, attemptId: input.attemptId, state: 'failed', errorCode: receipt.errorCode, errorMessage: receipt.errorMessage };
  }

  private async waitForLateReceipt(client: AntigravityCommandClient, command: { id: string; targetWorkspace: { folderUri: string }; promptDigest: string; meta?: Record<string, unknown>; backendSessionRef?: string }, hostInstanceId: string, hostEpoch: number, providerSessionId: string): Promise<AntigravityResultV2 | null> {
    const expectedCommand = {
      id: command.id,
      targetWorkspace: command.targetWorkspace,
      promptDigest: command.promptDigest,
      projectId: command.meta?.projectId as string,
      workspaceId: command.meta?.workspaceId as string,
      attemptId: command.meta?.attemptId as string,
      hostInstanceId,
      hostEpoch,
      backendSessionRef: providerSessionId,
    };
    const deadline = Date.now() + 4500;
    while (Date.now() <= deadline) {
      const lateReceipt = client.checkLateReceipt(command.id, expectedCommand);
      if (lateReceipt) return lateReceipt;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  async cancel(runId: string): Promise<void> {
    const client = this.clients.get(runId);
    const commandId = this.commandIds.get(runId);
    if (client && commandId) client.cancelPending(commandId);
  }

  resume(input: StartRunInput): AsyncIterable<RunEvent> {
    return this.startRun(input);
  }
}

export function antigravityReceiptBinding(input: StartRunInput, commandId: string, workspacePath: string, hostInstanceId: string, hostEpoch: number, providerSessionId = input.backendSessionRef?.providerSessionId) {
  if (!input.cwd || input.cwd.trim().length === 0) throw new Error('Receipt binding requires an explicitly bound Workspace cwd');
  if (!providerSessionId) throw new Error('Receipt binding requires an exact provider conversation session');
  return { commandId, promptDigest: computePromptDigest(input.promptText), projectId: input.projectId, workspaceId: input.workspaceId, canonicalWorkspace: canonicalizeWorkspaceRoot(workspacePath), hostInstanceId, hostEpoch, attemptId: input.attemptId, backendSessionRef: providerSessionId };
}
