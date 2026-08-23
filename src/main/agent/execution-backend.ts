import { AuthoritativeReceipt, BackendSessionRef, ReceiptBinding, RunState } from '../../shared/control-plane-contracts';

export interface StartRunInput {
  runId: string;
  attemptId: string;
  projectId: string;
  workspaceId: string;
  chatId: string;
  promptText: string;
  cwd: string;
  timeoutMs?: number;
  outputBudgetBytes?: number;
  backendSessionRef?: BackendSessionRef;
  signal?: AbortSignal;
}

export type RunEvent =
  | { type: 'status'; runId: string; attemptId: string; state: RunState; errorCode?: string; errorMessage?: string }
  | { type: 'receipt'; runId: string; attemptId: string; receipt: Pick<AuthoritativeReceipt, 'binding' | 'state' | 'deliveryState' | 'errorCode' | 'errorMessage'> & { binding: ReceiptBinding } }
  | { type: 'text'; runId: string; attemptId: string; text: string; stream: 'stdout' | 'stderr' }
  | { type: 'tool/call'; runId: string; attemptId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool/result'; runId: string; attemptId: string; toolName: string; result: unknown }
  | { type: 'session/ref'; runId: string; attemptId: string; sessionRef: BackendSessionRef }
  | { type: 'error'; runId: string; attemptId: string; errorCode: string; errorMessage: string };

export interface ExecutionBackend {
  readonly id: string;
  readonly requiresAuthoritativeReceipt?: boolean;
  startRun(input: StartRunInput): AsyncIterable<RunEvent>;
  cancel(runId: string): Promise<void>;
  resume?(input: StartRunInput): AsyncIterable<RunEvent>;
}
