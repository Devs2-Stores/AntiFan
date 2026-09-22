import { CapabilityCatalogue } from './capability-catalogue';
import { TerminalManager } from '../browser/terminal-manager';
import {
  CapabilityError,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
  TerminalWaitInput,
  TerminalWaitResult,
} from '../../shared/control-plane-contracts';

/**
 * Read-only lifecycle view of a terminal record.
 *
 * Terminal tabs can be put to SLEEP: a sleeping session keeps its transcript and its
 * browser-tab affinity but holds no live PTY. That lifecycle lives in
 * `terminal-manager.ts` (owned elsewhere), so this tool surface reads it through a
 * widened structural view instead of depending on the exact literal union of
 * `Session['state']`. When the probe is unavailable the tools degrade to their
 * pre-sleep behaviour (straight delegation), never to something worse.
 */
interface TerminalLifecycleProbe {
  state?: string;
  disposed?: boolean;
  lastSeq?: number;
  sessionGeneration?: number;
}

function probeTerminalLifecycle(
  terminal: TerminalManager,
  sessionId: string
): TerminalLifecycleProbe | undefined {
  if (!sessionId || typeof sessionId !== 'string') return undefined;
  const probe = terminal as unknown as {
    getSession?: (id: string) => TerminalLifecycleProbe | undefined;
  };
  if (typeof probe.getSession !== 'function') return undefined;
  return probe.getSession(sessionId);
}

/**
 * Explicit, typed outcome of `terminal.wait` against a SLEEPING session.
 *
 * It intentionally keeps `TerminalWaitResult`'s base shape (`satisfied: false` plus the
 * live cursor) so callers that only read `satisfied` behave exactly as they do today,
 * while `sleeping`/`code`/`reason`/`wakeHint` make the cause and the next step
 * machine-readable instead of an unexplained non-satisfied wait.
 */
export interface TerminalWaitSleepingResult extends TerminalWaitResult {
  satisfied: false;
  sleeping: true;
  code: 'SESSION_SLEEPING';
  reason: 'SESSION_SLEEPING';
  sessionId: string;
  /** The capability that wakes the session. Writing input IS the wake path. */
  wakeCapability: 'terminal.write';
  message: string;
  wakeHint: string;
}

export type TerminalWaitOutcome = TerminalWaitResult | TerminalWaitSleepingResult;

export interface TerminalWriteResult {
  /** Whether the input was handed to a live shell. */
  written: boolean;
  /** True when this write was the implicit wake of a sleeping session. */
  woke: boolean;
  priorState?: string;
  state?: string;
  sessionGeneration?: number;
  message?: string;
}

const SESSION_SLEEPING_CODE = 'SESSION_SLEEPING' as const;

function sleepingWaitResult(sessionId: string, record: TerminalLifecycleProbe): TerminalWaitSleepingResult {
  const sessionGeneration = typeof record.sessionGeneration === 'number' ? record.sessionGeneration : 0;
  const lastSeq = typeof record.lastSeq === 'number' ? record.lastSeq : 0;
  return {
    satisfied: false,
    sleeping: true,
    code: SESSION_SLEEPING_CODE,
    reason: SESSION_SLEEPING_CODE,
    sessionId,
    sessionGeneration,
    lastSeq,
    wakeCapability: 'terminal.write',
    message:
      `Terminal session "${sessionId}" is sleeping: it has no live PTY, so no wait condition can be satisfied while it sleeps, and ` +
      `terminal.wait deliberately does not wake it (starting a shell would silently undo the nap and cost the CPU/RAM sleep released).`,
    wakeHint:
      `Write input to the session to wake it — terminal.write { "sessionId": "${sessionId}", "input": "\\r\\n" } — then re-issue terminal.wait. ` +
      `Its transcript stays readable while asleep (terminal.list / the session snapshot).`,
  };
}

/**
 * Where terminal ownership comes from, joined once per runtime.
 *
 * `ownerTabId` resolves the browser tab an attachment is bound to (the runtime's attachment
 * registry); the rest is the host's live tab authority (NativeTabHost) — the same source the
 * Bridge gate already reads. Joining them here keeps a single ownership record per plane instead
 * of a second, drifting one inside this tool surface.
 */
export interface TerminalOwnershipPort {
  ownerTabId(attachmentId: string): string | undefined;
  allowsTab(tabId: string, terminalId: string): boolean;
  isAgentTerminal(terminalId: string): boolean;
  bind(terminalId: string, generation: number | undefined, tabId: string): boolean;
}

/**
 * The host half of {@link TerminalOwnershipPort}: live tab authority without the attachment lookup
 * the runtime owns. This is what the composition root injects.
 */
export type TerminalHostAuthority = Omit<TerminalOwnershipPort, 'ownerTabId'>;

/**
 * The terminal plane a caller may touch: unbound (lease-bound internal call, no attachment) or the
 * attachment's own tab.
 */
type TerminalCallerScope =
  | { bound: false }
  | { bound: true; attachmentId: string; tabId: string; ownership: TerminalOwnershipPort };

function callingAttachmentId(
  context?: CapabilityRequestContext | AuthenticatedCapabilityContext
): string | undefined {
  if (!context || !('attachmentId' in context)) return undefined;
  const id = context.attachmentId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Resolve which terminal plane an attachment-bound caller may touch.
 *
 * Lease-bound internal calls stay exactly as they were: no attachment means no ownership question.
 * An attachment must resolve to its bound tab — nothing can be attributed to a caller without one,
 * and guessing would re-open the cross-project write this gate exists to stop — so an unattributable
 * caller is refused instead of allowed unverified.
 */
function resolveTerminalCallerScope(
  ownership: TerminalOwnershipPort | undefined,
  context?: CapabilityRequestContext | AuthenticatedCapabilityContext
): TerminalCallerScope {
  const attachmentId = callingAttachmentId(context);
  if (!attachmentId) return { bound: false };
  if (!ownership) {
    throw new CapabilityError(
      'TERMINAL_FORBIDDEN',
      `Attachment "${attachmentId}" cannot be authorised for terminal access: this runtime is wired without host tab authority, so terminal ownership cannot be verified`
    );
  }
  const tabId = ownership.ownerTabId(attachmentId);
  if (!tabId) {
    throw new CapabilityError(
      'TERMINAL_FORBIDDEN',
      `Attachment "${attachmentId}" is bound to no browser tab: it owns no terminal, and no terminal can be attributed to it`
    );
  }
  return { bound: true, attachmentId, tabId, ownership };
}

/**
 * Gate one terminal for the resolved caller.
 *
 * `operate` (write/resize/close/split) is owner-strict: a caller may not drive a shell it does not
 * own, whether that shell belongs to another agent or to the user. `observe` (wait) also allows the
 * user plane — reading what the user types is a legitimate read-only capability — while still
 * refusing another attachment's private agent terminal.
 */
function assertTerminalOwnership(
  scope: TerminalCallerScope,
  terminalId: string,
  mode: 'operate' | 'observe'
): void {
  if (!scope.bound) return;
  const { ownership, tabId } = scope;
  if (ownership.allowsTab(tabId, terminalId)) return;
  const agentOwned = ownership.isAgentTerminal(terminalId);
  if (mode === 'observe' && !agentOwned) return;
  const plane = agentOwned ? "another attachment's agent terminal" : 'a user terminal';
  throw new CapabilityError(
    'TERMINAL_FORBIDDEN',
    `Terminal "${terminalId}" is ${plane} and is not owned by tab "${tabId}" of attachment "${scope.attachmentId}": ` +
      (mode === 'operate'
        ? 'create a session of your own with terminal.create and operate that one'
        : 'wait on your own sessions, or on user-plane terminals no agent owns')
  );
}

export function registerTerminalCapabilities(
  catalogue: CapabilityCatalogue,
  terminal: TerminalManager,
  ownership?: TerminalOwnershipPort
): void {
  catalogue.register<{ sessionId: string; input: string }, TerminalWriteResult>({
    name: 'terminal.write',
    description:
      'Write raw input text to an active PTY terminal session. Writing to a SLEEPING session wakes it (a fresh shell in the same cwd) and then delivers the input; the result reports woke=true',
    risk: 'write',
    policy: {
      effect: 'interactive-effect',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'reject-concurrent',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target terminal session ID' },
        input: { type: 'string', description: 'Data/commands to write into PTY stdin' },
      },
      required: ['sessionId', 'input'],
    },
    execute: (
      params: { sessionId: string; input: string },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params.sessionId || typeof params.sessionId !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'sessionId is required');
      }
      if (typeof params.input !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'input string is required');
      }
      assertTerminalOwnership(resolveTerminalCallerScope(ownership, context), params.sessionId, 'operate');
      const before = probeTerminalLifecycle(terminal, params.sessionId);
      const wasSleeping = before !== undefined && before.disposed !== true && before.state === 'sleeping';
      // Writing IS the wake path. `writeTo` runs the manager's own wake transition
      // (shell spawn + `session-woken` emit + affinity-tombstone cleanup) and then
      // delivers the input to the fresh shell. No explicit wakeSession() call is made
      // here on purpose: a second wake would race that transition and could spawn two
      // shells for one keystroke.
      terminal.writeTo(params.sessionId, params.input);
      const after = probeTerminalLifecycle(terminal, params.sessionId) || before;
      const woke = wasSleeping && after !== undefined && after.state !== 'sleeping';
      const result: TerminalWriteResult = {
        // Historical semantics for a live session stay exactly as they were: the write
        // is reported as handed to the shell. A sleeping session whose wake failed is
        // the one case where `written: true` would be a fabrication — the manager's
        // write route returns without a shell and the input is dropped.
        written: wasSleeping ? woke : true,
        woke,
        priorState: before?.state,
        state: after?.state,
        sessionGeneration: after?.sessionGeneration,
      };
      if (wasSleeping && !woke) {
        result.message =
          `Session "${params.sessionId}" was sleeping and did not wake — the shell spawn failed, so the input was NOT delivered. ` +
          `Retry terminal.write, or re-create the session.`;
      }
      return result;
    },
  });

  catalogue.register<{ sessionId: string; cols: number; rows: number }, { resized: boolean }>({
    name: 'terminal.resize',
    description: 'Resize terminal rows and columns for an active PTY session',
    risk: 'write',
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'reject-concurrent',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target terminal session ID' },
        cols: { type: 'number', description: 'Terminal columns' },
        rows: { type: 'number', description: 'Terminal rows' },
      },
      required: ['sessionId', 'cols', 'rows'],
    },
    execute: (
      params: { sessionId: string; cols: number; rows: number },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params.sessionId || typeof params.sessionId !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'sessionId is required');
      }
      assertTerminalOwnership(resolveTerminalCallerScope(ownership, context), params.sessionId, 'operate');
      terminal.resizeTo(params.sessionId, params.cols, params.rows);
      return { resized: true };
    },
  });

  catalogue.register<TerminalWaitInput, TerminalWaitOutcome>({
    name: 'terminal.wait',
    description:
      'Wait for output-match pattern, process exit, or silence on a terminal session. A SLEEPING session returns immediately with satisfied=false, sleeping=true and code=SESSION_SLEEPING instead of blocking: it is never woken here, write input to wake it',
    risk: 'read',
    policy: {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'event-wait',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Terminal session ID' },
        condition: { type: 'string', enum: ['output-match', 'exit', 'silence'] },
        pattern: { type: 'string', description: 'Regex pattern for output-match' },
        sessionGeneration: { type: 'number', description: 'Expected session incarnation' },
        afterSeq: { type: 'number', description: 'Sequence cursor' },
        silenceMs: { type: 'number', description: 'Silence duration threshold in milliseconds' },
        timeoutMs: { type: 'number', description: 'Wait deadline in milliseconds' },
      },
      required: ['sessionId', 'condition'],
    },
    execute: (
      params: TerminalWaitInput,
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      const signal = context && 'signal' in context ? context.signal : undefined;
      assertTerminalOwnership(resolveTerminalCallerScope(ownership, context), params.sessionId, 'observe');
      // A sleeping session must never reach the wait path: materializing its shell
      // would let a read-only MCP wait (or a Haravan barrier awaitSync) silently
      // undo the nap and re-spawn a PTY. Answer with an explicit, actionable,
      // typed outcome instead of blocking until the timeout.
      const lifecycle = probeTerminalLifecycle(terminal, params.sessionId);
      if (lifecycle && lifecycle.disposed !== true && lifecycle.state === 'sleeping') {
        return sleepingWaitResult(params.sessionId, lifecycle);
      }
      return terminal.waitTerminal(params, signal);
    },
  });

  catalogue.register<
    { paged?: boolean },
    { sessions: unknown[]; activeSessionId: string; omittedForeignAgentTerminals?: number }
  >({
    name: 'terminal.list',
    description: 'List active terminal sessions with bounded wire summary and incarnation metadata',
    risk: 'read',
    policy: {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        paged: { type: 'boolean', description: 'Whether to page buffers according to wire budget' },
      },
    },
    execute: (
      params: { paged?: boolean },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      const sessions = terminal.listSessions(params.paged ?? true);
      const scope = resolveTerminalCallerScope(ownership, context);
      if (!scope.bound) {
        return { sessions, activeSessionId: terminal.getActiveSessionId() };
      }
      // An attachment sees its own sessions and the user plane. Another attachment's agent terminal
      // is not part of its world: listing is how a caller discovers what to address, so a session it
      // may not operate must not be advertised to it in the first place.
      const visible = sessions.filter((session) => {
        const id = (session as { id?: string } | undefined)?.id;
        if (!id) return true;
        return scope.ownership.allowsTab(scope.tabId, id) || !scope.ownership.isAgentTerminal(id);
      });
      const omitted = sessions.length - visible.length;
      return {
        sessions: visible,
        activeSessionId: terminal.getActiveSessionId(),
        ...(omitted > 0 ? { omittedForeignAgentTerminals: omitted } : {}),
      };
    },
  });

  catalogue.register<
    {
      cwd?: string;
      parentId?: string;
      initialCols?: number;
      initialRows?: number;
    },
    { sessionId: string; ownerBound?: boolean; message?: string }
  >({
    name: 'terminal.create',
    description: 'Create a new base or split terminal PTY session',
    risk: 'write',
    policy: {
      effect: 'management',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'reject-concurrent',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        parentId: { type: 'string' },
        initialCols: { type: 'number' },
        initialRows: { type: 'number' },
      },
    },
    execute: async (
      params: { cwd?: string; parentId?: string; initialCols?: number; initialRows?: number },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      // Ownership is resolved BEFORE a shell exists: a session created for a caller that cannot be
      // attributed to a tab would be an ownerless terminal inside the shared namespace — precisely
      // the session any other project's attachment could then reach.
      const scope = resolveTerminalCallerScope(ownership, context);
      if (scope.bound && params.parentId) {
        // Splitting IS operating the parent: a split of a shell this caller does not own would put a
        // new PTY in a foreign workspace and then claim that workspace's tab for it.
        assertTerminalOwnership(scope, params.parentId, 'operate');
      }
      // The manager's declared contract is synchronous, but the daemon-backed facade the
      // composition root installs as the canonical instance (see DaemonTerminalProxy)
      // exposes these same names as ASYNC methods. Reading the return value without
      // awaiting it therefore put a Promise where the wire contract promises a string, and
      // the tool answered `{"sessionId":{}}` — the caller lost the only handle to the
      // terminal it had just created. Awaiting is correct for both shapes.
      const id = params.parentId
        ? await terminal.createSplitSession(params.parentId, params.cwd, params.initialCols, params.initialRows)
        : await terminal.createSession(params.cwd);
      if (typeof id !== 'string' || !id) {
        // An empty id is a refusal, not a handle: `createSplitSession` reports an
        // unusable parent (missing, disposed, or itself a split) that way. Fabricating
        // `{ sessionId: '' }` would hand the caller a target that resolves to nothing.
        throw new CapabilityError(
          'EXECUTION_ERROR',
          params.parentId
            ? `No session id was issued: parent "${params.parentId}" is missing, disposed, or already a split`
            : 'No session id was issued for the new terminal session'
        );
      }
      if (!scope.bound) return { sessionId: id };
      // A split already inherits its parent's tab through the host's own `session-created` hook, and
      // re-binding it would evict that tab from its parent. Only an unattributed session is claimed.
      if (scope.ownership.isAgentTerminal(id)) {
        return { sessionId: id, ownerBound: true };
      }
      const generation = probeTerminalLifecycle(terminal, id)?.sessionGeneration;
      const ownerBound = scope.ownership.bind(
        id,
        typeof generation === 'number' ? generation : undefined,
        scope.tabId
      );
      return ownerBound
        ? { sessionId: id, ownerBound }
        : {
            sessionId: id,
            ownerBound,
            message:
              `Session "${id}" was created but could not be bound to tab "${scope.tabId}": ` +
              `its tab no longer exists, so this attachment does not own it and its own writes to it are refused.`,
          };
    },
  });

  catalogue.register<{ sessionId: string; isSplit?: boolean }, { closed: boolean }>({
    name: 'terminal.close',
    description: 'Close a terminal session and safely terminate its process tree',
    risk: 'write',
    policy: {
      effect: 'management',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'reject-concurrent',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to close' },
        isSplit: { type: 'boolean', description: 'Whether target is a split session' },
      },
      required: ['sessionId'],
    },
    execute: async (
      params: { sessionId: string; isSplit?: boolean },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params.sessionId || typeof params.sessionId !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'sessionId is required');
      }
      assertTerminalOwnership(resolveTerminalCallerScope(ownership, context), params.sessionId, 'operate');
      const closed = params.isSplit
        ? await terminal.closeSplitSession(params.sessionId)
        : await terminal.closeSession(params.sessionId);
      return { closed };
    },
  });
}
