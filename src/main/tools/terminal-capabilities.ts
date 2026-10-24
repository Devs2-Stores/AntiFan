import { canonicalFolderKey } from '../project/workspace-capsule';
import { CapabilityCatalogue } from './capability-catalogue';
import { TerminalManager, agentTerminalOwnerKey, type SessionSummary } from '../browser/terminal-manager';
import {
  CapabilityError,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
  TerminalWaitInput,
  TerminalWaitResult,
  type TargetStaleCause,
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
  /** Set on a split pane: the base terminal it is split off. */
  splitOf?: string;
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

/**
 * A `terminal.wait` whose caller asked for longer than one call may block. The session is fine and
 * nothing was lost: `lastSeq` is the cursor to continue from with `afterSeq`.
 */
export interface TerminalWaitTimedOutResult extends TerminalWaitResult {
  satisfied: false;
  timedOut: true;
  sessionId: string;
  /** The deadline this call actually ran with. */
  timeoutMs: number;
  requestedTimeoutMs: number;
  /** The largest deadline one call may use. */
  maxTimeoutMs: number;
  message: string;
}

export type TerminalWaitOutcome = TerminalWaitResult | TerminalWaitSleepingResult | TerminalWaitTimedOutResult;

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

/** Deadline of a `terminal.create` call; also how long a queued reuse create waits on a stuck predecessor. */
const CREATE_POLICY_TIMEOUT_MS = 15_000;

/** Invocation budget of `terminal.wait`; the platform aborts the call when it is spent. */
export const TERMINAL_WAIT_BUDGET_MS = 30_000;
/** Headroom so the wait's own deadline fires, and answers, before the platform aborts the call. */
const TERMINAL_WAIT_BUDGET_MARGIN_MS = 2_000;
/** The largest deadline a single `terminal.wait` call runs with. */
export const TERMINAL_WAIT_MAX_TIMEOUT_MS = TERMINAL_WAIT_BUDGET_MS - TERMINAL_WAIT_BUDGET_MARGIN_MS;

/**
 * The deadline a `terminal.wait` call runs with: the caller's own up to the per-call maximum.
 * `clamped` is set only when the caller asked for more than one call may block, which is the one
 * case where running out of time is the cap's doing rather than the caller's.
 */
export function planTerminalWaitTimeout(requested: number | undefined): { timeoutMs: number; clamped: boolean } {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return { timeoutMs: TERMINAL_WAIT_MAX_TIMEOUT_MS, clamped: false };
  if (requested > TERMINAL_WAIT_MAX_TIMEOUT_MS) return { timeoutMs: TERMINAL_WAIT_MAX_TIMEOUT_MS, clamped: true };
  return { timeoutMs: requested, clamped: false };
}

function clampedWaitTimedOutResult(sessionId: string, requestedTimeoutMs: number, err: CapabilityError): TerminalWaitTimedOutResult {
  const details = err.details ?? {};
  const lastSeq = typeof details.lastSeq === 'number' ? details.lastSeq : 0;
  const sessionGeneration = typeof details.sessionGeneration === 'number' ? details.sessionGeneration : 0;
  return {
    satisfied: false,
    timedOut: true,
    sessionId,
    sessionGeneration,
    lastSeq,
    ...(typeof details.outputTail === 'string' ? { outputTail: details.outputTail } : {}),
    timeoutMs: TERMINAL_WAIT_MAX_TIMEOUT_MS,
    requestedTimeoutMs,
    maxTimeoutMs: TERMINAL_WAIT_MAX_TIMEOUT_MS,
    message:
      `terminal.wait runs at most ${TERMINAL_WAIT_MAX_TIMEOUT_MS}ms per call (the capability budget is ${TERMINAL_WAIT_BUDGET_MS}ms), so the requested ${requestedTimeoutMs}ms was shortened and elapsed without the condition. ` +
      `The session is unaffected: call terminal.wait again with afterSeq=${lastSeq} and the same condition and pattern, and repeat until it is satisfied.`,
  };
}

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
 * The live base terminal an agent runs in, from the first candidate that names one.
 *
 * A candidate that is a split resolves to its parent, because the home is always the base shell:
 * the agent's own shell is never part of what it may drive, only the panes split off it. A
 * candidate that is missing, disposed or closed is skipped, so a stale record never becomes a home.
 */
export function resolveHomeBaseTerminal(
  terminal: TerminalManager,
  candidates: ReadonlyArray<string | undefined>
): string | undefined {
  const isLive = (record: TerminalLifecycleProbe | undefined): record is TerminalLifecycleProbe =>
    record !== undefined && record.disposed !== true && record.state !== 'closed';
  for (const candidate of candidates) {
    if (!candidate) continue;
    const record = probeTerminalLifecycle(terminal, candidate);
    if (!isLive(record)) continue;
    if (!record.splitOf) return candidate;
    const parent = probeTerminalLifecycle(terminal, record.splitOf);
    if (isLive(parent) && !parent.splitOf) return record.splitOf;
  }
  return undefined;
}

/**
 * Whether `terminalId` is a live split pane of `homeId`: the one relation that decides what an
 * agent may see and drive. Everything else (the home shell itself, other base terminals, panes of
 * other terminals, other projects) is outside it.
 */
export function isLiveSplitOf(terminal: TerminalManager, homeId: string, terminalId: string): boolean {
  const record = probeTerminalLifecycle(terminal, terminalId);
  return record !== undefined && record.disposed !== true && record.state !== 'closed' && record.splitOf === homeId;
}

/**
 * Where terminal scope comes from, joined once per runtime.
 *
 * `ownerTabId` resolves the browser tab an attachment is bound to and `homeTerminalId` the base
 * terminal it runs in (the bound tab's own terminal, else the terminal the attachment was minted
 * from); both come from the runtime's attachment registry joined with the host's tab authority.
 * `isHomeSplit` is the single reach predicate. Joining them here keeps one scope record per plane
 * instead of a second, drifting one inside this tool surface.
 */
export interface TerminalOwnershipPort {
  ownerTabId(attachmentId: string): string | undefined;
  /** The live base terminal the attachment runs in, or undefined when none can be resolved. */
  homeTerminalId(attachmentId: string): string | undefined;
  /** Whether `terminalId` is a live split pane of `homeId`. */
  isHomeSplit(homeId: string, terminalId: string): boolean;
  /** Probe whether a tab is alive and what capsule it was created under. */
  tabAffiliation(tabId: string): { live: boolean; capsuleId?: string };
}

/**
 * The host half of {@link TerminalOwnershipPort}: live tab authority without the attachment lookup
 * the runtime owns. This is what the composition root injects.
 */
export interface TerminalHostAuthority {
  /** The terminal id the tab is rooted in as the tab records it; may name a split or a dead session. */
  tabHomeTerminal(tabId: string): string | undefined;
  tabAffiliation(tabId: string): { live: boolean; capsuleId?: string };
}

/**
 * The terminal plane a caller may touch: unbound (lease-bound internal call, no attachment) or the
 * splits of the attachment's own home terminal.
 */
export type TerminalCallerScope =
  | { bound: false }
  | { bound: true; attachmentId: string; tabId: string; homeId: string; ownership: TerminalOwnershipPort };

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
 * Lease-bound internal calls stay exactly as they were: no attachment means no scope question.
 * An attachment must resolve to its bound tab AND to a home terminal — nothing can be attributed to
 * a caller without both, and guessing would re-open the cross-project write this gate exists to
 * stop — so an unattributable caller is refused with an explicit error instead of being handed an
 * empty (or unverified) terminal plane.
 */
export function resolveTerminalCallerScope(
  ownership: TerminalOwnershipPort | undefined,
  context?: CapabilityRequestContext | AuthenticatedCapabilityContext
): TerminalCallerScope {
  const attachmentId = callingAttachmentId(context);
  if (!attachmentId) return { bound: false };
  if (!ownership) {
    throw new CapabilityError(
      'TERMINAL_FORBIDDEN',
      `Attachment "${attachmentId}" cannot be authorised for terminal access: this runtime is wired without host tab authority, so terminal scope cannot be verified`
    );
  }
  const tabId = ownership.ownerTabId(attachmentId);
  if (!tabId) {
    throw new CapabilityError(
      'TERMINAL_FORBIDDEN',
      `Attachment "${attachmentId}" is bound to no browser tab: it owns no terminal, and no terminal can be attributed to it`
    );
  }
  const homeId = ownership.homeTerminalId(attachmentId);
  if (!homeId) {
    throw new CapabilityError(
      'TERMINAL_FORBIDDEN',
      `Attachment "${attachmentId}" (tab "${tabId}") has no home terminal: it is not rooted in a live AntiFan terminal, so it has no terminal split panes to drive. Start the agent from an AntiFan terminal, then reconnect`
    );
  }
  return { bound: true, attachmentId, tabId, homeId, ownership };
}

/**
 * Gate one terminal for the resolved caller.
 *
 * An agent sees, reads and drives ONLY the live split panes of its home terminal: the user's own
 * split, a Space pane such as a sync watcher, and a pane the agent created. The home shell itself
 * (where the agent is typing) is refused, so it can never write into its own prompt, and so is every
 * terminal of another base or project.
 */
export function assertTerminalOwnership(scope: TerminalCallerScope, terminalId: string): void {
  if (!scope.bound) return;
  if (scope.ownership.isHomeSplit(scope.homeId, terminalId)) return;
  throw new CapabilityError(
    'TERMINAL_FORBIDDEN',
    terminalId === scope.homeId
      ? `Terminal "${terminalId}" is the home terminal of attachment "${scope.attachmentId}" (the shell you run in): it is never driven through terminal.*. Use terminal.create for a new split pane, or terminal.list for the panes you may drive`
      : `Terminal "${terminalId}" is outside the terminal scope of attachment "${scope.attachmentId}": only the split panes under your own terminal "${scope.homeId}" are reachable (terminal.list shows them, terminal.create adds one)`
  );
}

/**
 * The live pane this tab already minted under its home terminal that satisfies a `terminal.create`
 * request, if any.
 *
 * Matching is on the owner key stamped at mint time and on the reach predicate, so the answer is
 * never a pane the next write is refused. A requested folder must name the same directory as the
 * pane's cwd (canonical key, so case and junctions do not matter); with none requested any live
 * pane of the tab fits.
 */
function findReusableOwnTerminal(
  terminal: TerminalManager,
  scope: Extract<TerminalCallerScope, { bound: true }>,
  agentOwnerKey: string,
  requestedCwd: string | undefined
): SessionSummary | undefined {
  const wantedFolder = typeof requestedCwd === 'string' && requestedCwd.trim()
    ? canonicalFolderKey(requestedCwd.trim())
    : undefined;
  for (const row of terminal.listSessions(true)) {
    if (row.ownerKey !== agentOwnerKey) continue;
    if (row.state === 'exited' || row.state === 'closed') continue;
    if (wantedFolder !== undefined && canonicalFolderKey(row.cwd) !== wantedFolder) continue;
    if (!scope.ownership.isHomeSplit(scope.homeId, row.id)) continue;
    return row;
  }
  return undefined;
}

export function registerTerminalCapabilities(
  catalogue: CapabilityCatalogue,
  terminal: TerminalManager,
  ownership?: TerminalOwnershipPort
): void {
  catalogue.register<{ sessionId: string; input: string }, TerminalWriteResult>({
    name: 'terminal.write',
    description:
      'Write raw input text to one of your terminal split panes (the panes under the terminal you run in; never the terminal you run in itself). Writing to a SLEEPING pane wakes it (a fresh shell in the same cwd) and then delivers the input; the result reports woke=true',
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
    execute: async (
      params: { sessionId: string; input: string },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params.sessionId || typeof params.sessionId !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'sessionId is required');
      }
      if (typeof params.input !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'input string is required');
      }
      assertTerminalOwnership(resolveTerminalCallerScope(ownership, context), params.sessionId);
      const before = probeTerminalLifecycle(terminal, params.sessionId);
      const wasSleeping = before !== undefined && before.disposed !== true && before.state === 'sleeping';
      // Writing IS the wake path. `writeTo` runs the manager's own wake transition
      // (shell spawn + `session-woken` emit + affinity-tombstone cleanup) and then
      // delivers the input to the fresh shell. No explicit wakeSession() call is made
      // here on purpose: a second wake would race that transition and could spawn two
      // shells for one keystroke.
      // The singleton may be the daemon proxy, whose writeTo resolves only once the daemon
      // has delivered the input (and completed any wake it triggered). Awaiting keeps the
      // probe honest: `after` — and therefore `woke` — describes the session after the
      // input landed, not mid-RPC while the wake is still in flight.
      await terminal.writeTo(params.sessionId, params.input);
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
    description: 'Resize terminal rows and columns for one of your terminal split panes (the panes under the terminal you run in)',
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
      assertTerminalOwnership(resolveTerminalCallerScope(ownership, context), params.sessionId);
      terminal.resizeTo(params.sessionId, params.cols, params.rows);
      return { resized: true };
    },
  });

  catalogue.register<TerminalWaitInput, TerminalWaitOutcome>({
    name: 'terminal.wait',
    description:
      'Wait for output-match pattern, process exit, or silence on one of your terminal split panes (the panes under the terminal you run in). A SLEEPING session returns immediately with satisfied=false, sleeping=true and code=SESSION_SLEEPING instead of blocking: it is never woken here, write input to wake it',
    risk: 'read',
    policy: {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'event-wait',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: TERMINAL_WAIT_BUDGET_MS,
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
        timeoutMs: { type: 'number', description: `Wait deadline in milliseconds (default and maximum ${TERMINAL_WAIT_MAX_TIMEOUT_MS} per call; a longer request is shortened and, when it elapses, answers timedOut=true with lastSeq to continue from through afterSeq)` },
      },
      required: ['sessionId', 'condition'],
    },
    execute: async (
      params: TerminalWaitInput,
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      const signal = context && 'signal' in context ? context.signal : undefined;
      assertTerminalOwnership(resolveTerminalCallerScope(ownership, context), params.sessionId);
      // A sleeping session must never reach the wait path: materializing its shell
      // would let a read-only MCP wait (or a Haravan barrier awaitSync) silently
      // undo the nap and re-spawn a PTY. Answer with an explicit, actionable,
      // typed outcome instead of blocking until the timeout.
      const lifecycle = probeTerminalLifecycle(terminal, params.sessionId);
      if (lifecycle && lifecycle.disposed !== true && lifecycle.state === 'sleeping') {
        return sleepingWaitResult(params.sessionId, lifecycle);
      }
      // The wait must end by its own deadline, inside the invocation budget: a deadline at or past
      // the budget is aborted by the platform and reads as an unexplained failure.
      const plan = planTerminalWaitTimeout(params.timeoutMs);
      try {
        return await terminal.waitTerminal({ ...params, timeoutMs: plan.timeoutMs }, signal);
      } catch (err) {
        if (plan.clamped && err instanceof CapabilityError && err.code === 'WAIT_TIMEOUT') {
          return clampedWaitTimedOutResult(params.sessionId, params.timeoutMs as number, err);
        }
        throw err;
      }
    },
  });

  catalogue.register<
    { paged?: boolean },
    { sessions: unknown[]; activeSessionId: string; omittedOutOfScopeTerminals?: number }
  >({
    name: 'terminal.list',
    description:
      'List the terminal split panes you may drive: the panes under the terminal you run in (the Space panes such as a sync watcher, and panes you created). The terminal you run in, other terminals, and other projects\' terminals are never listed; `omittedOutOfScopeTerminals` counts them. Rows carry bounded wire summary and incarnation metadata',
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
      const withOwned = (session: unknown, owned: boolean): unknown =>
        session !== null && typeof session === 'object' ? { ...(session as Record<string, unknown>), owned } : session;
      if (!scope.bound) {
        // A caller with no attachment carries no ownership question: every row is its to drive.
        return { sessions: sessions.map((session) => withOwned(session, true)), activeSessionId: terminal.getActiveSessionId() };
      }
      // An attachment sees the panes of its own terminal and nothing else: listing is how a caller
      // discovers what to address, so a terminal it may not drive is not advertised to it at all.
      const visible = sessions.filter((session) => Boolean(session?.id) && scope.ownership.isHomeSplit(scope.homeId, session.id));
      const omitted = sessions.length - visible.length;
      // The process-wide active id may name a terminal this caller cannot see: never echo it.
      const activeId = terminal.getActiveSessionId();
      return {
        sessions: visible.map((session) => withOwned(session, true)),
        activeSessionId: visible.some((session) => session.id === activeId) ? activeId : (visible[0]?.id ?? ''),
        ...(omitted > 0 ? { omittedOutOfScopeTerminals: omitted } : {}),
      };
    },
  });

  // Reuse creates from one tab run one at a time. `reuse` looks for a live shell and then mints one, so
  // two racing on a tab would both mint. A plain create never looks, so it is never queued.
  // A predecessor is waited for at most the create policy timeout: a createSession that never settles
  // (a stalled daemon socket) fails its own caller at that deadline, and must not hold the tab's later
  // creates hostage. The queue tail never rejects, so a failure cannot wedge a tab either.
  const createQueues = new Map<string, Promise<void>>();
  const settleWithin = (pending: Promise<void>, ms: number): Promise<void> => {
    const { promise: deadline, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
  };
  const serializeReuseCreatePerTab = async <T>(
    context: CapabilityRequestContext | AuthenticatedCapabilityContext | undefined,
    enabled: boolean,
    work: () => Promise<T>
  ): Promise<T> => {
    if (!enabled) return work();
    const scope = resolveTerminalCallerScope(ownership, context);
    if (!scope.bound) return work();
    const prior = createQueues.get(scope.tabId);
    const run = prior ? settleWithin(prior, CREATE_POLICY_TIMEOUT_MS).then(work) : work();
    const tail = run.then(() => undefined, () => undefined);
    createQueues.set(scope.tabId, tail);
    try {
      return await run;
    } finally {
      if (createQueues.get(scope.tabId) === tail) createQueues.delete(scope.tabId);
    }
  };

  catalogue.register<
    {
      cwd?: string;
      capsuleId?: string;
      parentId?: string;
      initialCols?: number;
      initialRows?: number;
      reuse?: boolean;
    },
    { sessionId: string; ownerBound?: boolean; reused?: boolean; cwd?: string }
  >({
    name: 'terminal.create',
    description:
      'Create a new terminal split pane under the terminal you run in (always a new pane, never the user\'s own split). You can only ever drive the panes under your own terminal, so this is the only way to get a shell. Close panes you no longer need with terminal.close. reuse:true returns your own idle pane for the same folder instead of a new one; use it only when that pane is idle, because a pane still running a command receives the input',
    risk: 'write',
    policy: {
      effect: 'management',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'reject-concurrent',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: CREATE_POLICY_TIMEOUT_MS,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory of the new pane (defaults to your terminal\'s)' },
        capsuleId: { type: 'string', description: 'Ignored for an agent: a pane always inherits the workspace of the terminal it splits' },
        parentId: { type: 'string', description: 'Omit. An agent always splits its own terminal; any other value is refused' },
        initialCols: { type: 'number' },
        initialRows: { type: 'number' },
        reuse: { type: 'boolean', description: 'Return your own live pane for the same cwd instead of creating one (only when it is idle)' },
      },
    },
    execute: (
      params: { cwd?: string; capsuleId?: string; parentId?: string; initialCols?: number; initialRows?: number; reuse?: boolean },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => serializeReuseCreatePerTab(context, params.reuse === true, async () => {
      // Scope is resolved BEFORE a shell exists: a pane minted for a caller that cannot be attributed
      // to a home terminal would be an ownerless terminal inside the shared namespace.
      const scope = resolveTerminalCallerScope(ownership, context);
      // ASYNC/SYNC SEAM CONVENTION:
      // TerminalManager declares a synchronous contract (`createSession(cwd?, capsuleId?): string`),
      // but the daemon-backed facade installed as the process singleton (DaemonTerminalProxy)
      // implements `createSession(cwd?, capsuleId?): Promise<string>`.
      // Callers holding a reference to the singleton MUST await `terminal.createSession(...)` (or
      // `terminal.createSplitSession(...)`). Awaiting is correct for both shapes: it cleanly unwraps
      // a Promise when running against DaemonTerminalProxy and resolves a bare string when running
      // against in-process TerminalManager. Reading the return value synchronously yields an unhandled
      // Promise object in daemon mode, which would cause this tool to respond with `{"sessionId":{}}`
      // and lose the session identifier.
      if (!scope.bound) {
        // A lease-bound internal caller carries no attachment and keeps its unscoped reach.
        const id = params.parentId
          ? await terminal.createSplitSession(params.parentId, params.cwd, params.initialCols, params.initialRows)
          : await terminal.createSession(params.cwd, params.capsuleId, agentTerminalOwnerKey(undefined));
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
        return { sessionId: id };
      }
      if (typeof params.parentId === 'string' && params.parentId.trim() && params.parentId.trim() !== scope.homeId) {
        throw new CapabilityError(
          'TERMINAL_FORBIDDEN',
          `terminal.create always adds a split under your own terminal "${scope.homeId}"; parent "${params.parentId}" is not it. Omit parentId`
        );
      }
      // A dead bound tab is refused before a pane exists: the pane is held by its tab's agent key,
      // and a tab that is gone holds nothing, so the PTY would outlive the call as an orphan.
      const affiliation = scope.ownership.tabAffiliation(scope.tabId);
      if (!affiliation.live) {
        throw new CapabilityError(
          'TARGET_STALE',
          `Target tab "${scope.tabId}" is not owned by any live window`,
          {
            tabId: scope.tabId,
            cause: 'unowned' satisfies TargetStaleCause,
            canRebind: true,
            recovery: 'anti.browser.tabs.list then anti.browser.rebind_target',
          }
        );
      }
      // The pane is filed under the caller's own agent key, never the user's or a project window's.
      const agentOwnerKey = agentTerminalOwnerKey(scope.tabId);
      // Opt-in only: the terminal manager has no busy/foreground signal, so a pane handed back
      // implicitly could be mid-command (a timed-out wait is exactly when an agent asks for another
      // shell) and would swallow the next command. A different folder or a pane that has exited
      // still mints a fresh one.
      if (params.reuse === true) {
        const reusable = findReusableOwnTerminal(terminal, scope, agentOwnerKey, params.cwd);
        if (reusable) return { sessionId: reusable.id, ownerBound: true, reused: true, cwd: reusable.cwd };
      }
      const id = await terminal.createSplitSession(scope.homeId, params.cwd, params.initialCols, params.initialRows, { ownerKey: agentOwnerKey });
      if (typeof id !== 'string' || !id) {
        throw new CapabilityError(
          'EXECUTION_ERROR',
          `No session id was issued: your terminal "${scope.homeId}" is missing, disposed, or already a split`
        );
      }
      return { sessionId: id, ownerBound: true };
    }),
  });

  catalogue.register<{ sessionId: string; isSplit?: boolean }, { closed: boolean }>({
    name: 'terminal.close',
    description:
      'Close one of YOUR terminal split panes (a pane under the terminal you run in) and safely terminate its process tree. The terminal you run in and every terminal outside it are refused',
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
      const scope = resolveTerminalCallerScope(ownership, context);
      assertTerminalOwnership(scope, params.sessionId);
      // A bound caller can only reach a split pane, and a split id closes exactly that pane.
      const closed = params.isSplit || scope.bound
        ? await terminal.closeSplitSession(params.sessionId)
        : await terminal.closeSession(params.sessionId);
      return { closed };
    },
  });
}
