# AntiFan Agent Adapter Architecture Specification

## 1. Executive Summary

This specification defines the architectural seam and compatibility contract for `AgentAdapter` in the Chromium-first AntiFan harness. The seam enables AntiFan to integrate diverse AI agent runtimes (including current CLI sub-processes such as Codex and DeepSeek, as well as future Agent Client Protocol / ACP implementations) without coupling the control plane to any single runtime's internal format, lifecycle quirks, or process mechanics.

AntiFan retains absolute authority over the browser environment, workspace validation, capability permissions, approval dialogs, durable receipts, evidence stores, and verification outcomes. Agent adapters act strictly as runtime protocol and process translators.

---

## 2. Ownership & Authority Matrix

The boundary between the AntiFan Control Plane and Agent Adapters is absolute. The following matrix governs all adapter implementations.

| Domain / Responsibility | AntiFan Control Plane Authority | Agent Adapter Responsibility | Forbidden Crossings |
|---|---|---|---|
| **Run & Attempt Identity** | Sole creator and validator of `runId`, `attemptId`, `chatId`, `workspaceId`, `projectId` via `validateControlPlaneId`. | Receives immutable context in `AgentRunInput`; tags all outbound events with exact `runId` and `attemptId`. | Adapters MUST NOT invent, alter, or synthesize control plane IDs. |
| **Executable & Launch Path** | Enforces approved binary allowlists (`resolveApprovedExecutable`), realpath resolution, and canonical workspace containment (`validateLaunchPath`). | Spawns only the binary path validated by the control plane. | Adapters MUST NOT accept unapproved commands, bare names, or relative paths. |
| **Browser Control & Tabs** | Owns `BrowserWindow`, `NativeTabHost`, `BrowserControlPort`, DOM inspection, screenshots, CDP sessions, and tab lifecycle. | Invocations of browser tools occur strictly through normalized `tool/call` events or MCP attachments. | Adapters MUST NOT retain direct references to Electron `webContents`, `NativeTabHost`, or browser instances. |
| **Capabilities & Tool Dispatch** | Authoritative `CapabilityCatalogue` validates `RuntimeLease`, tool permissions, risk levels (`read`, `write`, `execute`, `eval`), and execution context. | Formats and yields normalized `tool/call` events or exposes client tool definitions during initialization. | Adapters MUST NOT bypass capability checks, grant permissions, or execute arbitrary unbrokered system commands. |
| **Approvals & Elicitation** | Displays approval UI, records user decisions, enforces timeouts and policy overrides. | Yields `approval/request` or translates protocol elicitation into structured approval events. | Adapters MUST NOT prompt the user directly or assume implicit approval. |
| **Process Lifecycle & Cleanup** | Tracks overall run timeouts, cancellation triggers, attachment revocations, and system resource limits. | Manages child process spawn, stdio streams, process group/tree termination, and `finally` cleanup handlers. | Adapters MUST NOT leak orphaned child processes or survive after run disposal/cancel. |
| **Receipts & Evidence** | `ReceiptStore`, `EventStore`, and `ArtifactStore` record immutable, hash-verified execution traces and authoritative receipts. | Delivers runtime events with exact prompt digests and session references. | Adapters MUST NOT forge receipts or mark runs as "delivered" or "completed" without control-plane verification. |

### Forbidden Authority Crossings
1. **Direct Electron / DOM Access**: An adapter process or class must never import or invoke Electron main/renderer APIs, `BrowserWindow`, or `NativeTabHost`.
2. **Lease & Secret Fabrication**: Adapters must never generate `RuntimeLease` tokens or `McpAttachmentLaunch` secrets.
3. **Implicit Workspace Escape**: Adapters must never execute commands outside the validated canonical workspace directory.
4. **State Machine Override**: An adapter cannot force a run into `completed` if the control plane has transitioned the run to `cancelling`, `interrupted`, or `failed`.

---

## 3. Core Adapter Interface & Runtime-Neutral Event Model

To eliminate circular dependencies and prevent leaking legacy execution types, the adapter interface defines completely runtime-neutral inputs and event models.

### 3.1 Runtime-Neutral Adapter Input & Context

```typescript
import {
  AuthoritativeReceipt,
  BackendSessionRef,
  CapabilityError,
  McpAttachmentLaunch,
  ReceiptBinding,
  RunState,
  RuntimeLease,
} from '../../shared/control-plane-contracts';

export interface AdapterCapabilities {
  readonly streamingText: boolean;
  readonly structuredToolCalls: boolean;
  readonly sessionPersistence: boolean;
  readonly sessionResume: boolean;
  readonly userApprovals: boolean;
  readonly cancelSignal: boolean;
  readonly maxOutputBudget?: number;
  readonly requiresAuthoritativeReceipt?: boolean;
}

export interface AdapterInitializeContext {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly dataRoot: string;
  readonly hostEpoch: number;
}

export interface AdapterInitializeResult {
  readonly adapterId: string;
  readonly runtimeName: string;
  readonly runtimeVersion: string;
  readonly protocolVersion: number;
  readonly capabilities: AdapterCapabilities;
}

export interface AdapterSessionContext {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly chatId: string;
  readonly cwd: string;
  readonly lease?: RuntimeLease;
}

export interface AdapterSessionHandle {
  readonly sessionId: string;
  readonly providerSessionId?: string;
  readonly createdAt: number;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentRunInput {
  readonly runId: string;
  readonly attemptId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly chatId: string;
  readonly promptText: string;
  readonly cwd: string;
  readonly canonicalWorkspaceRoot?: string;
  readonly attachmentLaunch?: McpAttachmentLaunch;
  readonly timeoutMs?: number;
  readonly outputBudgetBytes?: number;
  readonly backendSessionRef?: BackendSessionRef;
  readonly signal?: AbortSignal;
}
```

### 3.2 Runtime-Neutral Event Model (`AdapterEvent`)

```typescript
export type AdapterEvent =
  | {
      type: 'status';
      runId: string;
      attemptId: string;
      state: RunState;
      errorCode?: string;
      errorMessage?: string;
    }
  | {
      type: 'receipt';
      runId: string;
      attemptId: string;
      receipt: Pick<AuthoritativeReceipt, 'binding' | 'state' | 'deliveryState' | 'errorCode' | 'errorMessage'> & {
        binding: ReceiptBinding;
      };
    }
  | {
      type: 'text';
      runId: string;
      attemptId: string;
      text: string;
      stream: 'stdout' | 'stderr' | 'thought';
    }
  | {
      type: 'tool/call';
      runId: string;
      attemptId: string;
      toolName: string;
      args: Record<string, unknown>;
      callId?: string;
    }
  | {
      type: 'tool/result';
      runId: string;
      attemptId: string;
      toolName: string;
      result: unknown;
      callId?: string;
      isError?: boolean;
    }
  | {
      type: 'session/ref';
      runId: string;
      attemptId: string;
      sessionRef: BackendSessionRef;
    }
  | {
      type: 'approval/request';
      runId: string;
      attemptId: string;
      requestId: string;
      action: string;
      details: Record<string, unknown>;
    }
  | {
      type: 'approval/response';
      runId: string;
      attemptId: string;
      requestId: string;
      approved: boolean;
      reason?: string;
    }
  | {
      type: 'error';
      runId: string;
      attemptId: string;
      errorCode: string;
      errorMessage: string;
    };
```

### 3.3 `AgentAdapter` Contract

```typescript
export interface AgentAdapter {
  readonly id: string;
  readonly protocolVersion: number;
  readonly capabilities: AdapterCapabilities;
  readonly requiresAuthoritativeReceipt?: boolean;

  initialize?(context: AdapterInitializeContext): Promise<AdapterInitializeResult>;
  createSession?(context: AdapterSessionContext): Promise<AdapterSessionHandle>;
  loadSession?(context: AdapterSessionContext, ref: BackendSessionRef): Promise<AdapterSessionHandle>;
  resumeSession?(context: AdapterSessionContext, ref: BackendSessionRef): Promise<AdapterSessionHandle>;

  startRun(input: AgentRunInput): AsyncIterable<AdapterEvent>;
  cancel(runId: string): Promise<void>;
  dispose?(): Promise<void>;
}
```

### 3.4 Compatibility Bridge & Narrowed Projection Semantics

To maintain 100% backward compatibility during incremental migration, `ExecutionBackend` functions as a bidirectional facade. Because `AdapterEvent` introduces capabilities (`approval/request`, `approval/response`, `stream: 'thought'`, `callId`, `isError`) not present in legacy `RunEvent`, the bridge defines an explicit **narrowed projection**:

1. **Approval Events (`approval/request`, `approval/response`)**: Filtered from the legacy `RunEvent` stream (`mapAdapterEventToRunEvent` returns `null`). The control plane records all approval events directly in `EventStore`. Legacy consumers (which lack approval handling) do not receive approval events through the legacy facade.
2. **Thought Streaming (`stream: 'thought'`)**: Projected to `stream: 'stdout'` for legacy consumers, while `EventStore` retains the native `thought` stream classification.
3. **Tool Call Metadata (`callId`, `isError`)**: Truncated in the legacy `tool/call` and `tool/result` projections, but preserved in `EventStore` payload records.
4. **Direct Consumption Recommendation**: New control-plane services and modernized UI components MUST subscribe directly to `AdapterEvent` streams from `AgentAdapter` or the control-plane event bus rather than going through the narrowed legacy facade.

```typescript
// Legacy contract in src/main/agent/execution-backend.ts:
export interface ExecutionBackend {
  readonly id: string;
  readonly requiresAuthoritativeReceipt?: boolean;
  startRun(input: StartRunInput): AsyncIterable<RunEvent>;
  cancel(runId: string): Promise<void>;
  resume?(input: StartRunInput): AsyncIterable<RunEvent>;
}

/** Explicit exhaustive narrowed projection from runtime-neutral AdapterEvent to legacy RunEvent */
export function mapAdapterEventToRunEvent(event: AdapterEvent): RunEvent | null {
  switch (event.type) {
    case 'status':
      return {
        type: 'status',
        runId: event.runId,
        attemptId: event.attemptId,
        state: event.state,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
      };
    case 'receipt':
      return {
        type: 'receipt',
        runId: event.runId,
        attemptId: event.attemptId,
        receipt: event.receipt,
      };
    case 'text':
      return {
        type: 'text',
        runId: event.runId,
        attemptId: event.attemptId,
        text: event.text,
        stream: event.stream === 'thought' ? 'stdout' : event.stream,
      };
    case 'tool/call':
      return {
        type: 'tool/call',
        runId: event.runId,
        attemptId: event.attemptId,
        toolName: event.toolName,
        args: event.args,
      };
    case 'tool/result':
      return {
        type: 'tool/result',
        runId: event.runId,
        attemptId: event.attemptId,
        toolName: event.toolName,
        result: event.result,
      };
    case 'session/ref':
      return {
        type: 'session/ref',
        runId: event.runId,
        attemptId: event.attemptId,
        sessionRef: event.sessionRef,
      };
    case 'error':
      return {
        type: 'error',
        runId: event.runId,
        attemptId: event.attemptId,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
      };
    case 'approval/request':
    case 'approval/response':
      // Approvals are handled directly by control-plane runtime and filtered from legacy streams
      return null;
  }
}

// Compatibility wrapper:
export class AdapterExecutionBackendWrapper implements ExecutionBackend {
  constructor(private readonly adapter: AgentAdapter) {}
  get id(): string { return this.adapter.id; }
  get requiresAuthoritativeReceipt(): boolean {
    return Boolean(this.adapter.requiresAuthoritativeReceipt ?? this.adapter.capabilities.requiresAuthoritativeReceipt ?? false);
  }
  async *startRun(input: StartRunInput): AsyncIterable<RunEvent> {
    const agentInput: AgentRunInput = { ...input };
    for await (const adapterEvent of this.adapter.startRun(agentInput)) {
      const runEvent = mapAdapterEventToRunEvent(adapterEvent);
      if (runEvent) {
        yield runEvent;
      }
    }
  }
  async cancel(runId: string): Promise<void> {
    await this.adapter.cancel(runId);
  }
}
```

---

## 4. Lifecycle State Machine & Terminal Invariants

```text
                ┌───────────────┐
                │    queued     │
                └───────┬───────┘
                        │ start()
                        ▼
                ┌───────────────┐
                │   starting    │
                └───────┬───────┘
                        │ first event / session/ref
                        ▼
       ┌────────►┌──────────────┐◄─────────┐
       │         │  streaming   │          │
       │         │  (running)   │          │
       │         └──────┬───────┘          │
       │                │                  │
tool/result             │ tool/call        │ approval/response
       │                ▼                  │
       │         ┌──────────────┐          │
       └─────────┤ waiting-tool ├──────────┘
                 │ waiting-appr │
                 └──────┬───────┘
                        │
      ┌─────────────────┼─────────────────┐
      │ cancel()        │ exit 0 / receipt│ runtime error / crash
      ▼                 ▼                 ▼
┌───────────┐     ┌───────────┐     ┌───────────┐
│cancelling │     │ completed │     │  failed   │
└─────┬─────┘     └───────────┘     └───────────┘
      │
      ▼
┌───────────┐
│interrupted│
└───────────┘
```

### Invariants
1. **Single Terminal Transition**: Once an attempt reaches a terminal state (`completed`, `failed`, `interrupted`, `unknown`), its state is frozen. Any subsequent events yielded by the adapter are logged to `EventStore` as non-authoritative diagnostics and discarded from the run state machine.
2. **Cancellation Dominance (Fence)**: If `RunService.cancel()` is invoked, the run state transitions immediately to `cancelling` / `interrupted`. Even if the subprocess exits with code 0 or sends a late `turn.completed` event before dying, the terminal state remains `interrupted`.
3. **Consumer Error Containment & Guaranteed Cleanup**: If `RunService` or an event listener throws an exception during `applyEvent()`, the loop terminates cleanly:
   - Attempt state transitions to `failed` or `unknown`.
   - The adapter's cleanup routines run in a `finally` block, killing child process trees and revoking MCP attachments.
4. **PID Registration & Attachment Security**: When an adapter yields `session/ref` with a `sessionRef.processPid`, `RunService` binds this PID via `this.setAttemptProcessPid(attempt.id, sessionRef.processPid)`. Subsequent MCP tool invocations from this attempt must match the registered PID.

---

## 5. ACP (Agent Client Protocol) Seam & Mapping

ACP v1 provides a JSON-RPC based model for initialization, session setup, prompt turns, tool invocations, cancellation, and elicitation. AntiFan translates these concepts into its internal control-plane vocabulary.

### 5.1 Protocol Mapping Matrix

| ACP v1 Concept | AntiFan Adapter Mapping | Semantics & Authority Rules |
|---|---|---|
| `initialize` request / response | `AgentAdapter.initialize(context)` | Negotiates protocol version, adapter ID, and capabilities. AntiFan rejects mismatched protocol versions or missing required capabilities. |
| `session/new` | `AgentAdapter.createSession(context)` | Allocates session state within the bound Project and Workspace. Returns opaque `sessionId`. |
| `session/load` | `AgentAdapter.loadSession(context, ref)` | Restores historical context if supported (`sessionPersistence: true`). Lineage is validated by AntiFan. |
| `session/resume` | `AgentAdapter.resumeSession(context, ref)` | Resumes an active runtime session. Strictly capability-gated (`sessionResume: true`) and lease-validated. |
| `session/prompt` turn | `AgentAdapter.startRun(input)` | Begins prompt execution turn. Passes validated workspace cwd, MCP attachment tokens, timeouts, and output budgets. |
| `session/update` notifications | `AdapterEvent` stream (`text`, `status`, `tool/call`, `tool/result`) | Streaming text chunks, thought blocks, and execution progress updates. |
| `tools/call` request / response | `AdapterEvent { type: 'tool/call' }` and `AdapterEvent { type: 'tool/result' }` | Adapter reports intent to invoke a tool. AntiFan broker resolves capability permissions and dispatches to browser or filesystem ports. |
| `$/cancel_request` | `AgentAdapter.cancel(runId)` | Signals cancellation. Adapter sends interrupt/SIGINT or terminates process tree. Control plane fences state to `interrupted`. |
| `session/elicitation` / permissions | `AdapterEvent { type: 'approval/request' }` / `approval/response` | Adapter requests user confirmation. AntiFan displays UI and returns user decision. Adapter cannot auto-approve. |

### 5.2 Capability Negotiation & Unsupported Semantics
1. **Explicit Capability Advertisement**: Each adapter declares `AdapterCapabilities`.
2. **Fail-Closed on Unsupported Features**:
   - If a consumer requests `resumeSession()` on an adapter with `sessionResume: false`, the adapter immediately throws `CapabilityError('UNSUPPORTED_CAPABILITY', 'Session resume is not supported by adapter')`.
   - If an adapter attempts an unadvertised action (e.g. direct file mutation without capability brokering), the control plane blocks the action with `CapabilityError('PERMISSION_DENIED', ...)`.
3. **Session Lineage & Reconnect Security Rules**:
   - Resuming or loading a session requires:
     a. `projectId` and `workspaceId` exactly match the session record.
     b. `chatId` matches the originating conversation.
     c. `backendId` matches the active adapter.
     d. An active, unexpired `RuntimeLease` is presented.
   - If any lineage check fails, the control plane MUST refuse attachment and start a new session or fail closed.

---

## 6. Migration Slices & Incremental Cutover

To ensure zero downtime, no regressions in existing test suites, and clean separation of concerns, implementation proceeds in six isolated slices.

### Slice A: Contract & Registry Scaffold
- **Files Touched/Created**: `src/main/agent/adapter-contracts.ts`, `src/main/agent/adapter-registry.ts`.
- **Changes**: Define `AgentAdapter`, `AdapterCapabilities`, `AdapterInitializeContext`, `AdapterSessionHandle`, and registry lookup functions.
- **Compatibility**: No existing caller changes. Pure contract addition.

### Slice B: Codex Adapter Extraction & Compatibility Facade
- **Files Touched/Created**: `src/main/agent/codex-agent-adapter.ts`, `src/main/agent/codex-execution-backend.ts`.
- **Changes**: Extract Codex child-process spawning, JSONL parser, and attachment environment injection into `CodexAgentAdapter`. Update `CodexExecutionBackend` to implement `ExecutionBackend` as a thin wrapper over `CodexAgentAdapter`.
- **Compatibility**: All existing `test/main/codex-execution-backend.test.ts` pass without modifications.

### Slice C: Control-Plane Adapter Selection in `RunService`
- **Files Touched/Created**: `src/main/run/run-service.ts`, `src/main/control-plane/control-plane-runtime.ts`.
- **Changes**: `RunService.start()` accepts `AgentAdapter | ExecutionBackend`. Introduce event-order and terminal guards (cancellation fence, duplicate-event discard, consumer exception handling).
- **Compatibility**: Existing `RunService` tests remain 100% green.

### Slice D: Session & Capability Metadata Persistence
- **Files Touched/Created**: `src/main/session/event-store.ts`, `src/shared/control-plane-contracts.ts`.
- **Changes**: Persist adapter handshake and capability records in `ExecutionAttempt` and `EventStore`. Validate `session/ref` bindings against adapter metadata.

### Slice E: DeepSeek Adapter Migration
- **Files Touched/Created**: `src/main/agent/deepseek-agent-adapter.ts`, `src/main/agent/deepseek-harness-adapter.ts`.
- **Changes**: Migrate `DeepSeekHarnessAdapter` to `DeepSeekAgentAdapter` adhering to `AgentAdapter` contract under `ANTIFAN_DSH_SPIKE`.
- **Compatibility**: Feature flag gating preserved; default behavior untouched.

### Slice F: Cleanup & Legacy Deprecation
- **Files Touched/Created**: `src/main/agent/execution-backend.ts`, `src/main/agent/index.ts`.
- **Changes**: Mark legacy `ExecutionBackend` methods as deprecated shims, remove unused helper code, and finalize export surfaces.

---

## 7. Verification, Security & Rollback Gates

### 7.1 Verification Matrix

| Area | Test Suite / Scenario | Invariant Verified |
|---|---|---|
| **Contract Invariants** | `test/main/agent-adapter-contract.test.ts` | Validates `AgentAdapter` contract, capability checking, error codes, and monotonic event ordering. |
| **Receipt Propagation** | `test/main/agent-adapter-contract.test.ts` | Validates that `AdapterExecutionBackendWrapper.requiresAuthoritativeReceipt` propagates adapter receipt requirements and `RunService` rejects unverified terminal state. |
| **Approved Executables** | `test/main/codex-execution-backend.test.ts` | Realpath resolution, allowlist enforcement, bare-command rejection, relative path rejection. |
| **Workspace Containment** | `test/main/codex-execution-backend.test.ts` | Rejection of `cwd` outside canonical workspace root prior to process spawn. |
| **Attachment Security** | `test/main/run-lifecycle.test.ts` | PID binding, secret environment injection, token revocation upon attempt termination. |
| **Cancellation Race** | `test/main/run-lifecycle.test.ts` | Control-plane cancellation wins over post-kill exit code 0 or late `turn.completed` events. |
| **Consumer Failure** | `test/main/run-lifecycle.test.ts` | Exception thrown during `applyEvent()` cleanly terminates child process and transitions attempt to `failed`. |
| **Duplicate/Late Events** | `test/main/run-lifecycle.test.ts` | Post-terminal events are logged as non-authoritative diagnostics and do not alter terminal state. |
| **Browser Authority** | `test/main/native-tab-host-agent-lifecycle.test.ts` | Adapters cannot directly manipulate tabs or bypass `BrowserControlPort`. |

### 7.2 Security Verification
1. **Authoritative Receipt Enforcement**: For backends configured with `requiresAuthoritativeReceipt: true`, `RunService` rejects unverified terminal status with `AUTHORITATIVE_RECEIPT_REQUIRED` and forces run state to `unknown`.
2. **Argument & Environment Sanitization**: Attachment secrets and control plane tokens are passed strictly via `NodeJS.ProcessEnv` and never in CLI argument vectors (`argv`).
3. **Path & Symlink Traversal**: Realpath checks verify that symlinked executables resolve to an approved binary before execution.
4. **PID Binding Enforcement**: MCP attachment validation rejects calls from processes whose PID does not match the registered `processPid`.
5. **Secret Redaction**: Error messages and stdout streams are scrubbed of sensitive tokens before logging or persistence.

### 7.3 Rollback Triggers & Procedures
- **Rollback Triggers**:
  1. Any failure in approved executable validation or workspace boundary checks.
  2. Orphaned or leaked child processes observed during test or run cancellation.
  3. Any regression in existing 217 unit and integration tests.
  4. Broken DeepSeek compatibility spike under `ANTIFAN_DSH_SPIKE`.
- **Rollback Procedure**:
  - Revert the `RunService` selection dispatch to the legacy `ExecutionBackend` direct path.
  - The compatibility facade ensures that both old and new adapter implementations can be toggled without breaking data stores.
