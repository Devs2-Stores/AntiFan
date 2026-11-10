import * as path from 'node:path';
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
import type { TerminalRunSnapshot } from '../../shared/contracts';
import { LeaderRegistry, type LeaderMintedRecord } from '../leader/leader-registry';
import {
  clearRunFilesOf,
  getLeaderPlacementPort,
  getLeaderProjectRemovalPort,
  installedHooksStale,
  installedRunStateHookSha256,
  isUnderLeaderScratchRoot,
  leaderHookStatus,
  leaderPushApprovalsDir,
  leaderRunSnapshot,
  waitForAnyRunSettled,
  waitForRunSettled,
  type LeaderMintedProjectRemoval,
  type StaleHook,
} from '../leader/leader-runtime';
import { daemonVersionStatus, type DaemonVersionStatus } from '../terminal-daemon/daemon-spawner';
import { LINE_MAX_CHARS, MESSAGE_CONTROL_CHARS, MESSAGE_PASSTHROUGH_SIGIL, WorkerTerminalInputGate } from './worker-terminal-input-gate';
import { APPROVAL_SELF_CODE } from '../../omp-hooks/theme-push-approval';
import { THEME_PUSH_CODES } from '../../omp-hooks/theme-push-policy';
import { recordLifecycleEvent } from '../diagnostics/main-lifecycle-log';

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
  /** Set when the wait named several terminals. */
  sessionIds?: string[];
  sleepingSessionIds?: string[];
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
  /** Set when the wait named several terminals. */
  sessionIds?: string[];
  sleepingSessionIds?: string[];
}

/** `terminal.wait` with `condition: 'run-idle'`: the OMP run in that terminal has finished its turn. */
export interface TerminalRunWaitResult extends TerminalWaitResult {
  satisfied: true;
  run: TerminalRunSnapshot;
}

/**
 * `terminal.wait` over `sessionIds[]` with `condition: 'run-idle'`: the first terminal whose run settled.
 * `sessionId` names that terminal, `run` is its snapshot; the other terminals are still running.
 */
export interface TerminalAnyRunWaitResult extends TerminalRunWaitResult {
  sessionId: string;
  sessionIds: string[];
  /** Terminals of the request that sleep and so were not polled (a wait never wakes one). */
  sleepingSessionIds?: string[];
}

/**
 * What `terminal.wait` accepts. `condition` may be left out when `pattern` (output-match), `silenceMs`
 * (silence), or `sessionIds` / `minRunSeq` / `afterEventAt` (run-idle) say which one is meant.
 * `sessionIds` waits for the first of several terminals and is only valid for run-idle.
 */
export type TerminalWaitParams = Omit<TerminalWaitInput, 'sessionId' | 'condition'> & {
  sessionId?: string;
  sessionIds?: string[];
  condition?: TerminalWaitInput['condition'];
};

/** Most terminals one `terminal.wait` may poll together. */
export const TERMINAL_WAIT_MAX_SESSIONS = 16;

/**
 * The wait condition a call means: the explicit one, or the single one its other parameters imply. Two
 * implied conditions (a pattern together with silenceMs) are ambiguous and refused rather than guessed.
 */
export function inferTerminalWaitCondition(params: TerminalWaitParams, multiSession: boolean): TerminalWaitInput['condition'] {
  if (params.condition !== undefined) return params.condition;
  const implied: Array<{ condition: TerminalWaitInput['condition']; because: string }> = [];
  if (params.pattern !== undefined) implied.push({ condition: 'output-match', because: 'pattern' });
  if (params.silenceMs !== undefined) implied.push({ condition: 'silence', because: 'silenceMs' });
  if (multiSession) implied.push({ condition: 'run-idle', because: 'sessionIds' });
  else if (params.minRunSeq !== undefined) implied.push({ condition: 'run-idle', because: 'minRunSeq' });
  else if (params.afterEventAt !== undefined) implied.push({ condition: 'run-idle', because: 'afterEventAt' });
  const [only] = implied;
  if (implied.length === 1 && only) return only.condition;
  if (implied.length === 0) {
    throw new CapabilityError(
      'INVALID_ARGUMENT',
      'condition is required: one of output-match, exit, silence, run-idle. It can be left out only when pattern (output-match), silenceMs (silence), or sessionIds / minRunSeq / afterEventAt (run-idle) names it'
    );
  }
  throw new CapabilityError(
    'INVALID_ARGUMENT',
    `condition is ambiguous: ${implied.map((entry) => `${entry.because} implies ${entry.condition}`).join(' but ')}. Pass condition explicitly`
  );
}

export type TerminalWaitOutcome =
  | TerminalWaitResult
  | TerminalRunWaitResult
  | TerminalAnyRunWaitResult
  | TerminalWaitSleepingResult
  | TerminalWaitTimedOutResult;

/** What a `terminal.close { removeMintedProject: true }` did about the project its placement minted. */
export type TerminalProjectRemoval = LeaderMintedProjectRemoval | { status: 'SKIPPED'; reason: string };

export interface TerminalWriteResult {
  /** Whether the input was handed to a live shell. */
  written: boolean;
  /** True when this write was the implicit wake of a sleeping session. */
  woke: boolean;
  priorState?: string;
  state?: string;
  sessionGeneration?: number;
  /** Epoch ms taken right before the input went to the PTY: pass it to `terminal.wait` run-idle as `afterEventAt`. */
  writtenAt: number;
  /** The OMP run state the terminal showed just BEFORE this write, when a run file exists. */
  run?: TerminalRunSnapshot;
  message?: string;
  /**
   * Leader writes into an idle OMP only: `started` when a run began (runSeq grew or the state left idle) within the wait;
   * `pending` when the OMP is alive but still idle after the short wait (a worker needs 15 to 55 s to finish its old
   * turn, load context and start: that is no verdict, only `worker-status --since --min-run-seq` after 90 s is);
   * `not_running` when its OMP has ended, so the input went to the shell. Absent when the target was not an idle OMP,
   * the input had no Enter, or the wait was disabled (deliveryWaitMs 0) or aborted.
   */
  delivery?: 'started' | 'pending' | 'not_running';
  /** The run the terminal showed when `delivery` was decided. */
  deliveryRun?: TerminalRunSnapshot;
}

const SESSION_SLEEPING_CODE = 'SESSION_SLEEPING' as const;

/** How long the platform waits for a cancelled capability to acknowledge before it gives up on it; added on top of every execution budget. */
const TERMINAL_CANCELLATION_ACK_MS = 5_000;

/**
 * Execution deadline of a `terminal.create` call, which is also how long a queued reuse create waits on a
 * stuck predecessor. The policy adds the cancellation ack on top, because the platform aborts the call at
 * `policy.timeoutMs - cancellationAckTimeoutMs`.
 */
const CREATE_POLICY_TIMEOUT_MS = 15_000;

/** Execution deadline of `terminal.wait`: the platform aborts the call when it is spent. The policy adds the ack to it. */
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
      `terminal.wait runs at most ${TERMINAL_WAIT_MAX_TIMEOUT_MS}ms per call (the platform aborts a call at its ${TERMINAL_WAIT_BUDGET_MS}ms execution deadline, so the wait answers ${TERMINAL_WAIT_BUDGET_MARGIN_MS}ms ahead of it), so the requested ${requestedTimeoutMs}ms was shortened and elapsed without the condition. ` +
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
      `Write non-blank input to the session to wake it — terminal.write { "sessionId": "${sessionId}", "input": "echo wake\\r" } (a Leader may send key "enter" instead; whitespace-only input is refused as no usable value) — then re-issue terminal.wait. ` +
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
 * The base terminal `terminalId` is a live split pane of, or undefined when it is not a live split
 * (missing, disposed, closed, or a base terminal itself). It is the session half of the one relation
 * that decides what an agent may see and drive, so a caller checking many homes against one terminal
 * probes the terminal once.
 */
export function liveSplitParentOf(terminal: TerminalManager, terminalId: string): string | undefined {
  const record = probeTerminalLifecycle(terminal, terminalId);
  if (record === undefined || record.disposed === true || record.state === 'closed') return undefined;
  return record.splitOf || undefined;
}

/**
 * Whether `terminalId` is a live split pane of `homeId`: the one relation that decides what an
 * agent may see and drive. Everything else (the home shell itself, other base terminals, panes of
 * other terminals, other projects) is outside it.
 *
 * `homeId` must name a terminal; the signature says so because every caller resolves it through
 * `resolveHomeBaseTerminal`, which never returns an empty or undefined id. A caller that bypassed
 * that guard would get `false` here, which is the fail-closed answer.
 */
export function isLiveSplitOf(terminal: TerminalManager, homeId: string, terminalId: string): boolean {
  const parent = liveSplitParentOf(terminal, terminalId);
  return parent !== undefined && parent === homeId;
}

/** Whether `terminalId` names a terminal that exists and is not closed or disposed. */
export function isLiveTerminal(terminal: TerminalManager, terminalId: string): boolean {
  const record = probeTerminalLifecycle(terminal, terminalId);
  return record !== undefined && record.disposed !== true && record.state !== 'closed';
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
  /**
   * The live base terminal the attachment was MINTED from (its origin), or undefined when none
   * resolves. Leader authority belongs to this terminal alone: the bound tab can be re-bound to
   * another terminal's tab, the origin cannot. Omitted: nobody is a Leader.
   */
  originTerminalId?(attachmentId: string): string | undefined;
  /**
   * Whether `terminalId` is a terminal the user marked Leader. The host decides from its own registry,
   * but the terminal id it is asked about is the attachment's origin as the caller declared it when it
   * paired: the id is a claim the same user's tooling makes, not something this port can prove.
   */
  isLeader?(terminalId: string): boolean;
  /** Whether `terminalId` is a live terminal (any base or split, any project). A Leader reaches exactly these. */
  isLiveTerminal?(terminalId: string): boolean;
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
  | { bound: true; attachmentId: string; tabId: string; homeId: string; ownership: TerminalOwnershipPort; leader: boolean };

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
  // A Leader is decided by the terminal the attachment was MINTED from, and only by it: re-binding a
  // tab never changes the origin, so it can neither grant nor take away the role. A Leader's home is
  // that origin, whichever tab (if any) it is bound to now, so a tab rooted elsewhere (or none, for an
  // agent that never opened a page) cannot turn the Leader off.
  const originId = ownership.originTerminalId?.(attachmentId);
  if (originId !== undefined && ownership.isLeader?.(originId) === true) {
    return { bound: true, attachmentId, tabId: ownership.ownerTabId(attachmentId) ?? '', homeId: originId, ownership, leader: true };
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
  return { bound: true, attachmentId, tabId, homeId, ownership, leader: false };
}

/**
 * Gate one terminal for the resolved caller.
 *
 * An agent sees, reads and drives ONLY the live split panes of its home terminal: the user's own
 * split, a Space pane such as a sync watcher, and a pane the agent created. The home shell itself
 * (where the agent is typing) is refused, so it can never write into its own prompt, and so is every
 * terminal of another base or project.
 *
 * A Leader (a home terminal the user marked) reaches every live terminal of every project instead,
 * still never its own home shell.
 */
export function assertTerminalOwnership(scope: TerminalCallerScope, terminalId: string): void {
  if (!scope.bound) return;
  if (scope.leader) {
    if (terminalId === scope.homeId) {
      throw new CapabilityError(
        'TERMINAL_FORBIDDEN',
        `Terminal "${terminalId}" is the home terminal of attachment "${scope.attachmentId}" (the shell you run in): even a Leader never drives it through terminal.*. terminal.list shows the other terminals you may drive`
      );
    }
    if (scope.ownership.isLiveTerminal?.(terminalId) === true) return;
    throw new CapabilityError(
      'TERMINAL_FORBIDDEN',
      `Terminal "${terminalId}" is not a live terminal: it never existed or has been closed. terminal.list shows the terminals you may drive`
    );
  }
  if (scope.ownership.isHomeSplit(scope.homeId, terminalId)) return;
  throw new CapabilityError(
    'TERMINAL_FORBIDDEN',
    terminalId === scope.homeId
      ? `Terminal "${terminalId}" is the home terminal of attachment "${scope.attachmentId}" (the shell you run in): it is never driven through terminal.*. Use terminal.create for a new split pane, or terminal.list for the panes you may drive`
      : `Terminal "${terminalId}" is outside the terminal scope of attachment "${scope.attachmentId}": only the split panes under your own terminal "${scope.homeId}" are reachable (terminal.list shows them, terminal.create adds one)`
  );
}

/**
 * Refuse a Leader's write into a terminal whose OMP is mid-turn: the keystrokes would land inside
 * the running prompt. `waiting_user`, `idle`, an ended or stale run and a terminal with no run file
 * (a plain shell) all accept input.
 */
function assertLeaderTargetNotBusy(sessionId: string): void {
  const run = leaderRunSnapshot(sessionId);
  if (run?.state !== 'running') return;
  throw new CapabilityError(
    'TERMINAL_BUSY',
    `Terminal "${sessionId}" is running an OMP turn (run ${run.runSeq}); input typed now would land inside that prompt. ` +
      `Wait with terminal.wait { "sessionId": "${sessionId}", "condition": "run-idle" } and write again, or pass force:true to write anyway`,
    { sessionId, run, recovery: 'terminal.wait condition run-idle, then terminal.write; force:true overrides' }
  );
}

/** Longest time one `terminal.write` waits for an idle OMP to start a run (the handler is aborted at 10 s: policy 15 s minus the 5 s cancellation ack). */
export const TERMINAL_WRITE_DELIVERY_MAX_MS = 7_000;
export const TERMINAL_WRITE_DELIVERY_DEFAULT_MS = 5_000;
const TERMINAL_WRITE_DELIVERY_POLL_MS = 100;
/** Seconds without a new run after which worker-status / wait-workers call a prompt undelivered (their `--undelivered-sec` default). */
const TERMINAL_WRITE_UNDELIVERED_AFTER_S = 90;
/** The delivery wait ends 1.5 s ahead of the 10 s execution deadline, counted from the start of the call, so a slow write or wake only shortens it. */
const TERMINAL_WRITE_BUDGET_MS = 8_500;
/** `omp ...` typed on purpose: a Leader starting (or resuming) OMP in a terminal whose OMP has ended. */
const OMP_LAUNCH_RE = /^\s*(?:&\s*)?omp(?:\.exe)?(?:\s|$)/i;

/**
 * Refuse a Leader's write into a terminal whose OMP is gone (`ended`: it exited, crashed, or stopped
 * heartbeating): the keystrokes would go to the shell, not to the agent, and the Leader would wait for an
 * answer nobody gives. `omp ...` starts a new OMP on purpose and a sleeping terminal is
 * being woken; `shell:true` is the explicit way to type into the shell.
 */
function assertLeaderTargetRunsOmp(terminal: TerminalManager, sessionId: string, input: string): void {
  const run = leaderRunSnapshot(sessionId);
  if (run?.state !== 'ended') return;
  if (OMP_LAUNCH_RE.test(input)) return;
  if (probeTerminalLifecycle(terminal, sessionId)?.state === 'sleeping') return;
  throw new CapabilityError(
    'OMP_NOT_RUNNING',
    `Terminal "${sessionId}" has no OMP any more (run ${run.runSeq} is ended${run.stale ? ', stale: its process is gone or stopped heartbeating' : ''}): this input would go to the shell, not to an agent, and nothing would answer it. ` +
      `Start a new OMP there with an input that begins with "omp " (or recycle the worker: terminal.close it, terminal.create a new one and hand it a continuation prompt), or pass shell:true to type into the shell on purpose`,
    { sessionId, run, recovery: 'input starting with "omp ", or a new worker terminal; shell:true to type into the shell' }
  );
}

/** The run snapshot of a pane whose agent CLI is alive (not ended, not stale), or undefined when there is none or it cannot be read. */
function liveAgentRun(sessionId: string): TerminalRunSnapshot | undefined {
  let run: TerminalRunSnapshot | undefined;
  try {
    run = leaderRunSnapshot(sessionId);
  } catch {
    return undefined;
  }
  return run !== undefined && run.state !== 'ended' && run.stale !== true ? run : undefined;
}

/**
 * Refuse a `message` unless the pane holds a live agent run: a chat line typed anywhere else would go to a shell.
 * Unknown (no run file, unreadable, ended, stale, a sleeping pane that a write would wake into a shell) refuses; `running`
 * is TERMINAL_BUSY exactly as for `input`, unless the caller passed force:true.
 */
function assertMessageTargetLive(terminal: TerminalManager, sessionId: string, force: boolean): TerminalRunSnapshot {
  const run = liveAgentRun(sessionId);
  if (run === undefined || probeTerminalLifecycle(terminal, sessionId)?.state === 'sleeping') {
    throw new CapabilityError(
      'OMP_NOT_RUNNING',
      `Terminal "${sessionId}" has no live OMP: message is only for a pane running the agent CLI, and a line typed anywhere else would go to a shell. Use input to type into a shell pane`,
      { sessionId, recovery: 'input for a shell pane; for a worker whose OMP ended, an input starting with "omp " or a new worker terminal' }
    );
  }
  if (run.state === 'waiting_user') {
    throw new CapabilityError(
      'TERMINAL_BUSY',
      `Terminal "${sessionId}" is waiting on an ask dialog: a message would be typed into it. Answer the dialog with keys first (worker-status lists ask.questions[].answerKeys), then send the message`,
      { sessionId, run, recovery: 'terminal.write keys with answerKeys, then message' }
    );
  }
  if (!force) assertLeaderTargetNotBusy(sessionId);
  return run;
}

/** Keys a Leader may send with `terminal.write { key }`, as the terminal itself sends them. */
const TERMINAL_WRITE_KEY_SEQUENCES = {
  enter: '\r',
  esc: '\x1b',
  'ctrl-c': '\x03',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
} as const;
export const TERMINAL_WRITE_KEYS = Object.keys(TERMINAL_WRITE_KEY_SEQUENCES) as ReadonlyArray<keyof typeof TERMINAL_WRITE_KEY_SEQUENCES>;

/** Most keys one `terminal.write { keys }` call sends (an ask dialog needs a handful of arrows plus Enter). */
const TERMINAL_WRITE_KEYS_MAX = 16;

/**
 * The text a `terminal.write` call types: `input`, or the sequence of `key` / `keys` (Leader only; exactly one form).
 * Whitespace-only `input` never reaches here: the argument layer refuses it as no usable value, so a bare Enter is `key: "enter"`.
 */
function resolveWriteInput(params: { input?: string; message?: string; key?: string; keys?: string[] }, isLeader: boolean): string {
  if (params.message !== undefined) {
    if (!isLeader) throw new CapabilityError('INVALID_ARGUMENT', 'message is only available to a Leader terminal; type plain text with input');
    if (params.input !== undefined || params.key !== undefined || params.keys !== undefined) {
      throw new CapabilityError('INVALID_ARGUMENT', 'pass exactly one of input, message, key or keys');
    }
    const message = params.message;
    if (typeof message !== 'string' || message.trim().length === 0 || message.length > LINE_MAX_CHARS || MESSAGE_CONTROL_CHARS.test(message)) {
      throw new CapabilityError(
        'INVALID_ARGUMENT',
        `message must be one non-empty line of plain text of at most ${LINE_MAX_CHARS} characters, with no line breaks, tabs or other control characters. Put long or multi-line instructions in a file and send a message that references its path`
      );
    }
    if (MESSAGE_PASSTHROUGH_SIGIL.test(message)) {
      throw new CapabilityError(
        'INVALID_ARGUMENT',
        'message cannot start with a shell/code passthrough sigil (! $ & >) or a slash (/): the agent CLI would run it as a shell or code command, or as a slash command (/exit, /new, ...), outside every gate. To run a command in the worker\'s shell use input (judged as a shell line), or ask the worker in words'
      );
    }
    return message;
  }
  if (params.key !== undefined || params.keys !== undefined) {
    if (!isLeader) throw new CapabilityError('INVALID_ARGUMENT', 'key / keys are only available to a Leader terminal; type plain text with input');
    if (params.input !== undefined || (params.key !== undefined && params.keys !== undefined)) {
      throw new CapabilityError('INVALID_ARGUMENT', 'pass exactly one of input, key or keys');
    }
    const names = params.key !== undefined ? [params.key] : params.keys;
    if (!Array.isArray(names) || names.length === 0 || names.length > TERMINAL_WRITE_KEYS_MAX) {
      throw new CapabilityError('INVALID_ARGUMENT', `keys must be a list of 1..${TERMINAL_WRITE_KEYS_MAX} key names`);
    }
    // An Esc followed by another key in the same write is read by the terminal input parser as Alt+that key.
    if (names.slice(0, -1).includes('esc')) {
      throw new CapabilityError('INVALID_ARGUMENT', 'esc must be the last key of a write (an Esc followed by another key in the same write reads as Alt+key): send it in its own call');
    }
    return names
      .map((name) => {
        const sequence = typeof name === 'string' ? (TERMINAL_WRITE_KEY_SEQUENCES as Record<string, string | undefined>)[name] : undefined;
        if (sequence === undefined) throw new CapabilityError('INVALID_ARGUMENT', `key must be one of ${TERMINAL_WRITE_KEYS.join(', ')}`);
        return sequence;
      })
      .join('');
  }
  if (typeof params.input !== 'string') throw new CapabilityError('INVALID_ARGUMENT', 'input string (or, for a Leader, key / keys) is required');
  return params.input;
}

/**
 * After a Leader typed a prompt into an idle OMP: did a run start? True once the run counter passed `before`'s or the state
 * left idle; `pending` once the wait ends with the OMP still idle (lastEventAt may have moved: the previous turn closing
 * does that); `not_running` when the run is `ended`. Undefined when the wait was aborted.
 */
async function confirmRunStarted(
  sessionId: string,
  before: TerminalRunSnapshot,
  waitMs: number,
  signal: AbortSignal | undefined
): Promise<{ delivery: 'started' | 'pending' | 'not_running'; run?: TerminalRunSnapshot } | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const run = leaderRunSnapshot(sessionId);
    if (run?.state === 'ended') return { delivery: 'not_running', run };
    if (run && (run.runSeq > before.runSeq || run.state === 'running' || run.state === 'waiting_user')) return { delivery: 'started', run };
    const left = deadline - Date.now();
    if (left <= 0) return { delivery: 'pending', ...(run ? { run } : {}) };
    if (signal?.aborted) return undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(TERMINAL_WRITE_DELIVERY_POLL_MS, left)));
  }
}

/**
 * `terminal.wait` for `condition: 'run-idle'`: poll the terminal's run file until the run settled,
 * reached `minRunSeq` and, when `afterEventAt` is given, produced an event after that instant with at
 * least one completed turn. The per-call deadline applies exactly as for the other conditions.
 */
async function waitForRunIdle(
  params: TerminalWaitInput,
  lifecycle: TerminalLifecycleProbe | undefined,
  plan: { timeoutMs: number; clamped: boolean },
  signal: AbortSignal | undefined
): Promise<TerminalRunWaitResult | TerminalWaitTimedOutResult> {
  assertFiniteRunCriteria(params);
  const sessionGeneration = typeof lifecycle?.sessionGeneration === 'number' ? lifecycle.sessionGeneration : 0;
  const lastSeq = typeof lifecycle?.lastSeq === 'number' ? lifecycle.lastSeq : 0;
  try {
    const run = await waitForRunSettled(params.sessionId, {
      minRunSeq: params.minRunSeq,
      afterEventAt: params.afterEventAt,
      timeoutMs: plan.timeoutMs,
      signal,
    });
    return { satisfied: true, sessionGeneration, lastSeq, run };
  } catch (err) {
    if (!(err instanceof CapabilityError) || err.code !== 'WAIT_TIMEOUT') throw err;
    const details = { ...err.details, sessionGeneration, lastSeq };
    const timeout = new CapabilityError('WAIT_TIMEOUT', err.message, details);
    if (!plan.clamped) throw timeout;
    return {
      ...clampedWaitTimedOutResult(params.sessionId, params.timeoutMs as number, timeout),
      message:
        `terminal.wait runs at most ${TERMINAL_WAIT_MAX_TIMEOUT_MS}ms per call, so the requested ${params.timeoutMs}ms was shortened and the run did not settle in time. ` +
        `The terminal is unaffected: call terminal.wait again with condition "run-idle" (same minRunSeq / afterEventAt) and repeat until it is satisfied.`,
    };
  }
}

function assertFiniteRunCriteria(params: TerminalWaitParams): void {
  for (const field of ['minRunSeq', 'afterEventAt'] as const) {
    const value = params[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new CapabilityError('INVALID_ARGUMENT', `${field} must be a finite number`);
    }
  }
}

/**
 * `terminal.wait` for `condition: 'run-idle'` over several terminals: one poll loop answers with the first
 * whose run settled. A sleeping terminal is never polled (its run cannot settle and a wait must not wake it);
 * when every terminal sleeps the answer is the sleeping outcome of the first. The per-call deadline applies
 * exactly as for one terminal.
 */
async function waitForAnyRunIdle(
  params: TerminalWaitParams,
  sessionIds: readonly [string, ...string[]],
  terminal: TerminalManager,
  plan: { timeoutMs: number; clamped: boolean },
  signal: AbortSignal | undefined
): Promise<TerminalAnyRunWaitResult | TerminalWaitTimedOutResult | TerminalWaitSleepingResult> {
  assertFiniteRunCriteria(params);
  const sleepingSessionIds: string[] = [];
  const awake: string[] = [];
  for (const id of sessionIds) {
    const lifecycle = probeTerminalLifecycle(terminal, id);
    if (lifecycle && lifecycle.disposed !== true && lifecycle.state === 'sleeping') sleepingSessionIds.push(id);
    else awake.push(id);
  }
  const sleepingNote = sleepingSessionIds.length > 0 ? { sleepingSessionIds } : {};
  const [firstAwake] = awake;
  if (firstAwake === undefined) {
    const first = probeTerminalLifecycle(terminal, sessionIds[0]);
    return { ...sleepingWaitResult(sessionIds[0], first ?? {}), sessionIds: [...sessionIds], ...sleepingNote };
  }
  const cursorOf = (id: string): { sessionGeneration: number; lastSeq: number } => {
    const lifecycle = probeTerminalLifecycle(terminal, id);
    return {
      sessionGeneration: typeof lifecycle?.sessionGeneration === 'number' ? lifecycle.sessionGeneration : 0,
      lastSeq: typeof lifecycle?.lastSeq === 'number' ? lifecycle.lastSeq : 0,
    };
  };
  try {
    const { sessionId, run } = await waitForAnyRunSettled(awake, {
      minRunSeq: params.minRunSeq,
      afterEventAt: params.afterEventAt,
      timeoutMs: plan.timeoutMs,
      signal,
    });
    return { satisfied: true, sessionId, sessionIds: [...sessionIds], ...sleepingNote, ...cursorOf(sessionId), run };
  } catch (err) {
    if (!(err instanceof CapabilityError) || err.code !== 'WAIT_TIMEOUT') throw err;
    if (!plan.clamped) throw new CapabilityError('WAIT_TIMEOUT', err.message, { ...err.details, sessionIds: [...sessionIds], ...sleepingNote });
    return {
      satisfied: false,
      timedOut: true,
      sessionId: firstAwake,
      sessionIds: [...sessionIds],
      ...sleepingNote,
      ...cursorOf(firstAwake),
      timeoutMs: TERMINAL_WAIT_MAX_TIMEOUT_MS,
      requestedTimeoutMs: params.timeoutMs as number,
      maxTimeoutMs: TERMINAL_WAIT_MAX_TIMEOUT_MS,
      message:
        `terminal.wait runs at most ${TERMINAL_WAIT_MAX_TIMEOUT_MS}ms per call, so the requested ${params.timeoutMs}ms was shortened and none of the ${awake.length} terminals settled in time. ` +
        `They are unaffected: call terminal.wait again with the same sessionIds and condition "run-idle" and repeat until one is satisfied.`,
    };
  }
}

/**
 * The result's `warning` for a placement the host filed under no project: the folder is claimed by no open
 * project (or by several), so the terminal sits under the Terminal Manager's `unassigned` owner; an OMP
 * started in it has been seen unable to attach to the AntiFan browser tools.
 */
export const NO_PROJECT_OWNER_WARNING =
  'NO_PROJECT_OWNER: the folder belongs to no open AntiFan project, so this terminal is filed under "unassigned" and an OMP started in it may not be able to reach the AntiFan browser tools (anti.*, theme.*). Open the folder as an AntiFan project first, or give that worker a task that needs no browser tool';

/**
 * A Leader's base terminal for a project folder: minted through the host's placement port and registered
 * as its worker. The registration is what makes the worker's OMP hook refuse unsafe theme commands, so a
 * terminal that cannot be registered is closed again instead of being handed back ungated.
 */
async function placeLeaderWorker(
  terminal: TerminalManager,
  homeId: string,
  params: { cwd?: string; name?: string }
): Promise<{ sessionId: string; cwd: string; workerOf: string; ownerKey?: string; capsuleId?: string; minted?: { capsuleId: string }; warning?: string }> {
  const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';
  if (!cwd) {
    throw new CapabilityError('INVALID_ARGUMENT', 'cwd is required: a Leader mints a terminal in the project folder it names');
  }
  if (!path.isAbsolute(cwd)) {
    throw new CapabilityError('INVALID_ARGUMENT', `cwd "${cwd}" must be an absolute path: a Leader mints a terminal in the project folder it names, and a relative path names no project`);
  }
  const name = typeof params.name === 'string' ? params.name.trim().slice(0, 80) : '';
  const port = getLeaderPlacementPort();
  if (!port) {
    throw new CapabilityError(
      'TERMINAL_SCOPE_UNRESOLVED',
      'No Terminal Manager host is available to place a terminal in a project folder: open the Terminal Manager window, then retry'
    );
  }
  const placed = await port.placeTerminal({ cwd, ...(name ? { name } : {}) });
  if (!placed.ok) {
    throw new CapabilityError('EXECUTION_ERROR', `${placed.reason}: ${placed.message}`, { reason: placed.reason });
  }
  // A freshly minted id has no legitimate history: the Leader flag only comes from the user's own gesture,
  // and a live id is never reissued. Anything recorded under it belongs to a closed terminal (a daemon that
  // predates the persisted id counters can hand a closed id out again), and must not make this worker look
  // like a Leader or like a run it never had.
  const registry = LeaderRegistry.getInstance();
  registry.forget(placed.sessionId);
  clearRunFilesOf(placed.sessionId);
  if (!registry.assignWorker(placed.sessionId, homeId, name || undefined)) {
    const closed = await closeUnrecordedTerminal(() => terminal.closeSession(placed.sessionId));
    throw unrecordedWorkerError('The worker terminal', placed.sessionId, closed);
  }
  // The capsule exists only because this placement created it: remember that, so closing this worker can
  // remove exactly it later. A record that cannot be saved only means the capsule is left for the user to remove.
  // A worker placed in a capsule an earlier placement minted is recorded as joined, so its close can finish a
  // removal that the earlier worker's close had to refuse while this one was still open.
  const minted = placed.minted && registry.recordMinted(placed.sessionId, { capsuleId: placed.minted.capsuleId, workspacePath: path.resolve(cwd) })
    ? { capsuleId: placed.minted.capsuleId }
    : undefined;
  if (!placed.minted && placed.capsuleId) registry.recordJoined(placed.sessionId, placed.capsuleId);
  return {
    sessionId: placed.sessionId,
    cwd,
    workerOf: homeId,
    ...(placed.ownerKey && placed.ownerKey.startsWith('project:') ? { ownerKey: placed.ownerKey } : { warning: NO_PROJECT_OWNER_WARNING }),
    ...(placed.capsuleId ? { capsuleId: placed.capsuleId } : {}),
    ...(minted ? { minted } : {}),
  };
}

/** Close a terminal that could not be recorded as a worker. False when it is still open (the close was refused or failed). */
async function closeUnrecordedTerminal(close: () => Promise<unknown> | unknown): Promise<boolean> {
  try {
    return (await close()) !== false;
  } catch {
    return false;
  }
}

function unrecordedWorkerError(label: string, sessionId: string, closed: boolean): CapabilityError {
  return new CapabilityError(
    'EXECUTION_ERROR',
    closed
      ? `${label} "${sessionId}" was closed again: the Leader registry could not record it, and an unrecorded worker's OMP is not gated. Check that the AntiFan config directory is writable, then retry`
      : `${label} "${sessionId}" could not be closed: it is still open and ungated, because the Leader registry could not record it and an unrecorded worker's OMP is not gated. Close it with terminal.close, check that the AntiFan config directory is writable, then retry`,
    { sessionId, closed }
  );
}

/**
 * Remove the project a Leader's worker placement minted, after that worker's terminal was closed.
 *
 * Only a record written by the placement itself qualifies, and only while the folder it named is inside a
 * Leader scratch folder; the host repeats both checks against the live capsule. The caller reads the record
 * before closing, because closing a terminal drops its placement. The record itself belongs to the capsule
 * and stays until the capsule's project is removed or is found to be gone, so a refused removal (a sibling
 * worker still open, a window the user opened) can be asked again by closing the last worker in the folder.
 */
async function removeMintedProjectOf(
  registry: LeaderRegistry,
  minted: LeaderMintedRecord | undefined
): Promise<TerminalProjectRemoval> {
  if (!minted) {
    return { status: 'SKIPPED', reason: 'NOT_MINTED_BY_PLACEMENT: this terminal did not create its project (it was minted in a folder that already had one, or the record is gone)' };
  }
  if (!isUnderLeaderScratchRoot(minted.workspacePath)) {
    return { status: 'REFUSED', reason: 'OUTSIDE_SCRATCH_ALLOWLIST: the folder is not under a Leader scratch folder, so its project is left for the user to remove' };
  }
  const port = getLeaderProjectRemovalPort();
  if (!port) return { status: 'FAILED', reason: 'REMOVAL_PORT_UNAVAILABLE: Main has not installed project removal' };
  let outcome: LeaderMintedProjectRemoval;
  try {
    outcome = await port.removeMintedProject({ capsuleId: minted.capsuleId });
  } catch (err) {
    return { status: 'FAILED', reason: String(err instanceof Error ? err.message : err) };
  }
  if (outcome.status === 'REMOVED' || outcome.status === 'NO_PROJECT') registry.clearMinted(minted.capsuleId);
  return outcome;
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

/** What a test may substitute for the production wiring of {@link registerTerminalCapabilities}. */
export interface TerminalCapabilityDeps {
  /** Time a worker's `hrv theme info -j` probe may take inside `terminal.write` (default 7 s, inside the call's 10 s execution budget). */
  probeTimeoutMs?: number;
  /** Staged-versus-running daemon bundle comparison reported by `terminal.list` (default: the spawner's). */
  daemonStatus?: () => DaemonVersionStatus;
  /** Build identity of the installed run-state hook that `terminal.list` compares each run file against (default: the installer manifest's). */
  installedHookSha256?: () => string | undefined;
  /** Installed OMP hooks that drifted from their install record or source, listed by `terminal.list` for a Leader (default: read from the installer manifest). */
  installedHooksStale?: () => StaleHook[];
  /** How long `terminal.write` waits to see an idle OMP start a run after a Leader's prompt (default 5 s; a call may pass its own, up to 7 s; always cut to the call budget). */
  deliveryWaitMs?: number;
}

/**
 * The probe may use at most this much of `terminal.write`'s execution budget (15 s policy minus the 5 s
 * cancellation ack), so a slow `hrv` is answered with a refusal before the platform aborts the call.
 */
const WORKER_PROBE_TIMEOUT_MS = 7_000;

export function registerTerminalCapabilities(
  catalogue: CapabilityCatalogue,
  terminal: TerminalManager,
  ownership?: TerminalOwnershipPort,
  deps: TerminalCapabilityDeps = {}
): void {
  const workerProbeTimeoutMs = deps.probeTimeoutMs ?? WORKER_PROBE_TIMEOUT_MS;
  const workerInputGate = new WorkerTerminalInputGate({ probeTimeoutMs: workerProbeTimeoutMs });
  const daemonStatus = deps.daemonStatus ?? daemonVersionStatus;
  catalogue.register<{ sessionId: string; input?: string; message?: string; key?: string; keys?: string[]; force?: boolean; shell?: boolean; deliveryWaitMs?: number }, TerminalWriteResult>({
    name: 'terminal.write',
    description:
      'Write raw input text to one of your terminal split panes (the panes under the terminal you run in; never the terminal you run in itself). Writing to a SLEEPING pane wakes it (a fresh shell in the same cwd) and then delivers the input; the result reports woke=true. The result also carries writtenAt (epoch ms taken just before the write) and, when the terminal has an OMP run file, its run state from before the write: pass writtenAt to terminal.wait run-idle as afterEventAt to wait for the answer to THIS input. written:false means no live shell was confirmed to take the input (a dead terminal, a failed wake or a failed daemon call; a daemon call that timed out may still have delivered it): check the terminal with terminal.list before writing again, or re-create it. A Leader terminal (marked by the user) may write to any live terminal of any project except its own: a terminal whose OMP run is `running` is refused with TERMINAL_BUSY unless force:true. A terminal whose OMP has ended (it exited, crashed or stopped heartbeating) is refused with OMP_NOT_RUNNING, because the input would go to the shell and nothing would answer it: start a new OMP with an input that begins with `omp `, recycle the worker (terminal.close, terminal.create, a continuation prompt), or pass shell:true to type into the shell on purpose. After a prompt (input ending in Enter) typed into an idle OMP the result carries delivery: `started` (a run began: runSeq grew or the state left idle) or `pending` (alive but still idle after deliveryWaitMs, default 5000, maximum 7000, shortened to the call budget; 0 skips the check) or `not_running` (its OMP ended: the line went to the shell): pending is NOT a failure, a worker often needs 15 to 55 s to finish its old turn and start the run, so check `worker-status --since <writtenAt> --min-run-seq <pre-write runSeq + 1>` and treat the prompt as not received only after 90 s without a new run; not_running means recycle the worker. A Leader sends Enter, Esc, Ctrl-C, Tab and the arrow keys with `key` or `keys` instead of `input` (whitespace-only input is refused as no usable value), and a one-line chat message to a worker\'s OMP with `message` instead of `input` (live OMP run only, not while it waits on an ask dialog; Enter added; no leading ! $ & > or /; a line that starts with a theme command is still judged as one); `keys` answers the ask dialog of a worker with the ask.questions[].answerKeys[option] list that worker-status / wait-workers print, and Esc, left and right sent into a terminal with a live OMP never count as shell-line editing for the theme gate, while up/down count as such (they recall an unjudged history line, so the next Enter or message there is refused until ctrl-c) unless the run is waiting_user (an ask dialog is open). A terminal a Leader drives (a worker) has the theme-CLI lines it types here checked like its bash tool: each completed line that names hrv/haravan/shopify theme is judged by the same rules (read actions pass; `hrv theme push [--only <files>] --nodelete` passes against the theme id the folder is bound to, live or copy alike, once `hrv theme info -j` there succeeds and reports that same id (no `--nodelete`: REFUSED_THEME_PUSH_NODELETE; a push without `--only` must add `--ignore config/settings_data.json`: REFUSED_THEME_PUSH_SETTINGS_DATA); `hrv theme dev` additionally needs a non-live theme; `--force`, `--prune`, another theme id, publish/delete and every Shopify/Sapo write are refused) and anything refused comes back as POLICY_DENIED with a REFUSED_THEME_* refusalCode: report NEEDS_INPUT to your Leader with the exact command instead of retrying. A worker may type only plain text, Enter, Backspace, Tab, Esc and Ctrl-C: any other control key, a line that ends in a continuation (a trailing backtick, backslash, caret, pipe, ampersand or comma, or an open quote or bracket) and a line that cannot be read back (after Esc or Tab, or over 8 KiB) are refused too, so write a multi-line script to a file instead',
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
      cancellationAckTimeoutMs: TERMINAL_CANCELLATION_ACK_MS,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target terminal session ID' },
        input: { type: 'string', description: 'Data/commands to write into PTY stdin (plain text; for Enter, Esc, Ctrl-C or the arrow keys a Leader passes key instead)' },
        message: { type: 'string', description: 'Leader only, instead of input: one line of chat for the agent CLI (OMP) running in the pane; Enter is added. Only for a pane with a live OMP run (else OMP_NOT_RUNNING; input is for a shell pane); long or multi-line instructions go in a file the message points to' },
        key: { type: 'string', enum: [...TERMINAL_WRITE_KEYS], description: 'Leader only, instead of input: one key sent as the terminal sends it (enter, esc, ctrl-c, tab, up, down, left, right). Use it to close an OMP ask dialog (esc) or submit a prompt already sitting in the input box (enter)' },
        keys: { type: 'array', items: { type: 'string', enum: [...TERMINAL_WRITE_KEYS] }, maxItems: TERMINAL_WRITE_KEYS_MAX, description: 'Leader only, instead of input: several keys in order, sent as one write (esc only as the last key: an Esc followed by another key in the same write reads as Alt+key). worker-status / wait-workers give the list that answers a worker\'s ask dialog as ask.questions[].answerKeys[option], e.g. ["down","down","enter"]' },
        force: { type: 'boolean', description: 'Leader only: write even while the target OMP run is running (the input lands inside the running prompt)' },
        shell: { type: 'boolean', description: 'Leader only: type into the terminal shell on purpose even though its OMP has ended (otherwise OMP_NOT_RUNNING; an input that begins with "omp " is always allowed)' },
        deliveryWaitMs: { type: 'number', description: `Leader only: how long to wait, after a prompt typed into an idle OMP, for a run to start (default ${TERMINAL_WRITE_DELIVERY_DEFAULT_MS}, maximum ${TERMINAL_WRITE_DELIVERY_MAX_MS}; 0 skips the check). The result then carries delivery "started", "pending" (not a failure) or "not_running"` },
      },
      required: ['sessionId'],
      oneOf: [{ required: ['input'] }, { required: ['message'] }, { required: ['key'] }, { required: ['keys'] }],
    },
    execute: async (
      rawParams: { sessionId: string; input?: string; message?: string; key?: string; keys?: string[]; force?: boolean; shell?: boolean; deliveryWaitMs?: number },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!rawParams.sessionId || typeof rawParams.sessionId !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'sessionId is required');
      }
      const startedAt = Date.now();
      const signal = (context && 'signal' in context ? context.signal : undefined) ?? (context && 'control' in context ? context.control?.signal : undefined);
      const scope = resolveTerminalCallerScope(ownership, context);
      assertTerminalOwnership(scope, rawParams.sessionId);
      const isMessage = rawParams.message !== undefined;
      const params = { ...rawParams, input: resolveWriteInput(rawParams, scope.bound && scope.leader) };
      if (params.deliveryWaitMs !== undefined && (typeof params.deliveryWaitMs !== 'number' || !Number.isFinite(params.deliveryWaitMs) || params.deliveryWaitMs < 0)) {
        throw new CapabilityError('INVALID_ARGUMENT', 'deliveryWaitMs must be a finite number of milliseconds, 0 or more');
      }
      const deliveryWaitMs = Math.min(params.deliveryWaitMs ?? deps.deliveryWaitMs ?? TERMINAL_WRITE_DELIVERY_DEFAULT_MS, TERMINAL_WRITE_DELIVERY_MAX_MS);
      if (scope.bound && scope.leader && params.force !== true) assertLeaderTargetNotBusy(params.sessionId);
      if (scope.bound && scope.leader && !isMessage && params.shell !== true) assertLeaderTargetRunsOmp(terminal, params.sessionId, params.input);
      if (isMessage) assertMessageTargetLive(terminal, params.sessionId, params.force === true);
      const registry = LeaderRegistry.getInstance();
      const deliver = async (): Promise<TerminalWriteResult> => {
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
        const run = leaderRunSnapshot(params.sessionId);
        const writtenAt = Date.now();
        // The facade's result is read as `unknown`: only an explicit `false` means the input was not
        // delivered. An in-process manager that returns nothing, or a daemon that predates the field, is delivery.
        let delivered = (await terminal.writeTo(params.sessionId, params.input)) as unknown;
        let messageNote: string | undefined;
        if (isMessage && delivered !== false) {
          // The text is in the input box; Enter goes only to a pane whose agent is still alive. If it ended in between,
          // the text sits in a shell line: erase it the way a refused line is erased, and report nothing was sent.
          if (liveAgentRun(params.sessionId) !== undefined) {
            delivered = (await terminal.writeTo(params.sessionId, '\r')) as unknown;
          } else {
            let cleared = true;
            try {
              cleared = ((await terminal.writeTo(params.sessionId, '\x03')) as unknown) !== false;
            } catch {
              cleared = false;
            }
            if (!cleared) workerInputGate.markTainted(params.sessionId);
            delivered = false;
            messageNote =
              `The agent in terminal "${params.sessionId}" ended before the message was submitted, so Enter was NOT sent and the message was not delivered` +
              (cleared ? '; the typed text was cleared.' : '; the typed text could not be cleared (Ctrl-C was not delivered), so the next input there is refused until it is.');
          }
        }
        // A Leader's first successful write claims the terminal as one of its workers, so the Worker board
        // shows it. A write that reached no shell claims nothing.
        let registryNote = '';
        if (delivered !== false && scope.bound && scope.leader && !registry.assignWorker(params.sessionId, scope.homeId)) {
          const owner = registry.workerOf(params.sessionId);
          const refusedOnPurpose = registry.isLeader(params.sessionId) || (owner !== undefined && owner.leaderId !== scope.homeId && registry.isLeader(owner.leaderId));
          if (!refusedOnPurpose) registryNote = " Leader registry could not be saved: this terminal's OMP is not gated.";
        }
        const after = probeTerminalLifecycle(terminal, params.sessionId) || before;
        const woke = wasSleeping && after !== undefined && after.state !== 'sleeping';
        const result: TerminalWriteResult = {
          // A live session reports the write as handed to the shell unless the facade says it was not. A
          // sleeping session whose wake failed is the other case where `written: true` would be a
          // fabrication — the manager's write route returns without a shell and the input is dropped.
          written: delivered === false ? false : wasSleeping ? woke : true,
          woke,
          priorState: before?.state,
          state: after?.state,
          sessionGeneration: after?.sessionGeneration,
          writtenAt,
          ...(run ? { run } : {}),
        };
        if (wasSleeping && !woke) {
          result.message =
            `Session "${params.sessionId}" was sleeping and did not wake — the shell spawn failed, so the input was NOT delivered. ` +
            `Retry terminal.write, or re-create the session.${registryNote}`;
        } else if (messageNote !== undefined) {
          result.message = messageNote;
        } else if (delivered === false) {
          // A daemon call that timed out reads as `false` too, and the input may have arrived before it did.
          result.message =
            `Terminal "${params.sessionId}" did not confirm the input: no live shell was confirmed to take it (the terminal is gone, its shell could not be reached, or the daemon call timed out), so it may NOT have been delivered. ` +
            `Check the terminal with terminal.list before writing again, or re-create it.${registryNote}`;
        } else if (registryNote) {
          result.message = registryNote.trim();
        }
        // A Leader's prompt into an idle OMP: say whether a run started, so nobody has to guess from a silent worker.
        // lastEventAt is no evidence (the previous turn closing moves it); the run counter or the state is.
        if (scope.bound && scope.leader && run?.state === 'idle' && delivered !== false && !wasSleeping && (isMessage || /[\r\n]$/.test(params.input)) && deliveryWaitMs > 0) {
          const left = Math.max(0, startedAt + TERMINAL_WRITE_BUDGET_MS - Date.now());
          const confirmed = await confirmRunStarted(params.sessionId, run, Math.min(deliveryWaitMs, left), signal);
          if (confirmed) {
            result.delivery = confirmed.delivery;
            if (confirmed.run) result.deliveryRun = confirmed.run;
            if (confirmed.delivery !== 'started') {
              const note =
                confirmed.delivery === 'not_running'
                  ? `Terminal "${params.sessionId}" no longer has an OMP (its run ended): the input went to the shell and nothing will answer it. Recycle the worker (terminal.close, terminal.create, a continuation prompt).`
                  : `PENDING: no new run yet ${Math.min(deliveryWaitMs, left)} ms after the input (runSeq still ${confirmed.run?.runSeq ?? run.runSeq}). That is normal: a worker can need 15 to 55 s to finish its old turn, load context and start. ` +
                    `Check with worker-status.mjs --terminal ${params.sessionId} --since ${writtenAt} --min-run-seq ${run.runSeq + 1}; treat the input as not received only after ${TERMINAL_WRITE_UNDELIVERED_AFTER_S} s without a new run (worker-status then says not_started, wait-workers undelivered).`;
              result.message = result.message ? `${result.message} ${note}` : note;
            }
          }
        }
        return result;
      };
      // Every completed line typed into any pane passes the theme-push rules before it reaches the shell, whoever
      // types it. A Leader's relay and a pane that is not a worker (a Space pane can run `hrv theme dev`) get no
      // exception: with no worker there is no approval to spend, so a live push there is refused.
      const workerId = scope.bound && !scope.leader ? scope.homeId : params.sessionId;
      const worker = registry.workerOf(workerId);
      const abortedError = (): Error =>
        Object.assign(new Error('terminal.write was aborted before the input was written; nothing was typed'), { code: 'ABORTED', name: 'AbortError' });
      return workerInputGate.run(params.sessionId, async () => {
        // A call the platform already gave up on (its budget ran out while it queued behind another write)
        // must not type anything: the worker is told it failed and would retry, so it would run twice.
        if (signal?.aborted) throw abortedError();
        const cwd = terminal.listSessions(true).find((row) => row.id === params.sessionId)?.cwd;
        const approval = worker === undefined ? undefined : { dir: leaderPushApprovalsDir(), worker: workerId, leader: worker.leaderId, via: 'manager:terminal.write' };
        const ompRun = leaderRunSnapshot(params.sessionId);
        const gateOptions = { deadlineAt: startedAt + workerProbeTimeoutMs, ...(approval === undefined ? {} : { approval }) };
        // A message is only ever typed into a live agent: the queue may have delayed this call, so look again now.
        const messageRun = isMessage ? assertMessageTargetLive(terminal, params.sessionId, params.force === true) : undefined;
        const verdict = isMessage
          ? await workerInputGate.inspectMessage(params.sessionId, params.input, cwd, { ...gateOptions, ...(messageRun ? { runState: messageRun.state } : {}) })
          : await workerInputGate.inspect(params.sessionId, params.input, cwd, {
              ...gateOptions,
              // Left/right and Esc into a terminal with a live OMP act on the agent's screen, not on a shell line; up/down
              // do so only while an ask dialog is open (elsewhere the agent recalls an unjudged history line: that taints).
              ...(scope.bound && scope.leader && ompRun !== undefined && ompRun.state !== 'ended' && ompRun.stale !== true
                ? { agentOwnsInput: true, ...(ompRun.state === 'waiting_user' ? { askDialogOpen: true } : {}) }
                : {}),
              ...(scope.bound && scope.leader ? { leaderCaller: true } : {}),
            });
        if (verdict.decision === 'block') {
          if (verdict.code === THEME_PUSH_CODES.PUSH_LIVE || verdict.code === APPROVAL_SELF_CODE) {
            recordLifecycleEvent('leader.push-approval.refused', {
              worker: workerId,
              leader: worker?.leaderId ?? null,
              target: params.sessionId,
              code: verdict.code,
              command: verdict.command.slice(0, 200),
            });
          }
          // Half a line typed by an earlier call would otherwise stay in the shell and be completed by
          // whatever is typed next: clear it. A sleeping shell holds no line, and writing would wake it.
          let interruptDelivered = true;
          if (verdict.interruptPending && probeTerminalLifecycle(terminal, params.sessionId)?.state !== 'sleeping') {
            try {
              interruptDelivered = ((await terminal.writeTo(params.sessionId, '\x03')) as unknown) !== false;
            } catch {
              interruptDelivered = false;
            }
            // The line is still in the shell: the next Enter there must not run it unjudged.
            if (!interruptDelivered) workerInputGate.markTainted(params.sessionId);
          }
          // A Leader's own refusal goes back to the user, not to the Leader.
          const escalation = scope.bound && scope.leader ? 'Tell the user the exact command and the refusal' : 'Report NEEDS_INPUT to your Leader';
          throw new CapabilityError('POLICY_DENIED', verdict.reason, {
            refusalCode: verdict.code,
            sessionId: params.sessionId,
            command: verdict.command,
            ...(interruptDelivered ? {} : { interruptDelivered: false }),
            recovery: interruptDelivered
              ? `${escalation}; nothing of this input was written`
              : `${escalation}; nothing of this input was written, but the half-typed line in the terminal could not be cleared (Ctrl-C was not delivered), so the next input there is refused until it is`,
          });
        }
        if (signal?.aborted) {
          verdict.revert();
          throw abortedError();
        }
        for (const use of verdict.approved) {
          recordLifecycleEvent('leader.push-approval.used', {
            worker: workerId,
            leader: use.leader,
            target: params.sessionId,
            approvalId: use.id,
            command: use.command.slice(0, 200),
            quote: use.quote.slice(0, 200),
          });
        }
        let result: TerminalWriteResult;
        try {
          result = await deliver();
        } catch (err) {
          verdict.undelivered();
          throw err;
        }
        // A write that was not confirmed may still have reached the shell: the buffer keeps the stricter reading.
        if (result.written === false) verdict.undelivered();
        return result;
      });
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
      cancellationAckTimeoutMs: TERMINAL_CANCELLATION_ACK_MS,
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

  catalogue.register<TerminalWaitParams, TerminalWaitOutcome>({
    name: 'terminal.wait',
    description:
      'Wait for output-match pattern, process exit, silence, or run-idle on one of your terminal split panes (the panes under the terminal you run in). condition may be left out when pattern (output-match), silenceMs (silence), or sessionIds / minRunSeq / afterEventAt (run-idle) names it. run-idle waits until the OMP run in that terminal is idle, waiting for the user, or ended and returns the run snapshot; minRunSeq is the run counter the run must have reached, afterEventAt (pass the writtenAt of your terminal.write) counts only a run whose lastEventAt is newer than it and that completed at least one turn, so a leftover file or a fresh session that has not taken your prompt yet never satisfies it. run-idle also accepts sessionIds (up to 16 terminals) instead of sessionId and answers with the FIRST terminal whose run settled (sessionId, run, sessionIds); call again with the remaining ids for the next one. A SLEEPING session returns immediately with satisfied=false, sleeping=true and code=SESSION_SLEEPING instead of blocking: it is never woken here, write input to wake it',
    risk: 'read',
    policy: {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'event-wait',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: TERMINAL_WAIT_BUDGET_MS + TERMINAL_CANCELLATION_ACK_MS,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: TERMINAL_CANCELLATION_ACK_MS,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Terminal session ID' },
        sessionIds: { type: 'array', items: { type: 'string' }, description: `run-idle only: wait for the first of up to ${TERMINAL_WAIT_MAX_SESSIONS} terminals whose run settles, instead of one sessionId` },
        condition: { type: 'string', enum: ['output-match', 'exit', 'silence', 'run-idle'], description: 'Optional when pattern, silenceMs, sessionIds, minRunSeq or afterEventAt implies it' },
        pattern: { type: 'string', description: 'Regex pattern for output-match' },
        sessionGeneration: { type: 'number', description: 'Expected session incarnation' },
        afterSeq: { type: 'number', description: 'Sequence cursor' },
        silenceMs: { type: 'number', description: 'Silence duration threshold in milliseconds' },
        minRunSeq: { type: 'number', description: 'run-idle only: the run counter the OMP run must have reached (runSeq from terminal.list / the run snapshot) before idle counts' },
        afterEventAt: { type: 'number', description: 'run-idle only: epoch ms (the writtenAt of your terminal.write). Idle counts only once the run lastEventAt is newer than this and the run completed at least one turn' },
        timeoutMs: { type: 'number', description: `Wait deadline in milliseconds (default and maximum ${TERMINAL_WAIT_MAX_TIMEOUT_MS} per call; a longer request is shortened and, when it elapses, answers timedOut=true with lastSeq to continue from through afterSeq)` },
      },
    },
    execute: async (
      params: TerminalWaitParams,
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      const signal = context && 'signal' in context ? context.signal : undefined;
      const scope = resolveTerminalCallerScope(ownership, context);
      const rawIds = params.sessionIds;
      if (rawIds !== undefined && (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'string' || !id.trim()))) {
        throw new CapabilityError('INVALID_ARGUMENT', 'sessionIds must be an array of non-empty terminal session ids');
      }
      const multiSession = rawIds !== undefined;
      const named = typeof params.sessionId === 'string' && params.sessionId.trim() ? [params.sessionId.trim()] : [];
      const [firstId, ...otherIds] = [...new Set([...named, ...(rawIds ?? []).map((id) => id.trim())])];
      if (firstId === undefined) {
        throw new CapabilityError('INVALID_ARGUMENT', 'sessionId is required (or sessionIds, for condition run-idle)');
      }
      const sessionIds: [string, ...string[]] = [firstId, ...otherIds];
      if (sessionIds.length > TERMINAL_WAIT_MAX_SESSIONS) {
        throw new CapabilityError('INVALID_ARGUMENT', `terminal.wait takes at most ${TERMINAL_WAIT_MAX_SESSIONS} sessionIds, got ${sessionIds.length}`);
      }
      for (const id of sessionIds) assertTerminalOwnership(scope, id);
      const condition = inferTerminalWaitCondition(params, multiSession);
      if (multiSession && condition !== 'run-idle') {
        throw new CapabilityError('INVALID_ARGUMENT', `sessionIds is only valid with condition "run-idle", not "${condition}"`);
      }
      // The wait must end by its own deadline, inside the invocation budget: a deadline at or past
      // the budget is aborted by the platform and reads as an unexplained failure.
      const plan = planTerminalWaitTimeout(params.timeoutMs);
      if (multiSession) return waitForAnyRunIdle(params, sessionIds, terminal, plan, signal);
      const sessionId = firstId;
      // A sleeping session must never reach the wait path: materializing its shell
      // would let a read-only MCP wait (or a Haravan barrier awaitSync) silently
      // undo the nap and re-spawn a PTY. Answer with an explicit, actionable,
      // typed outcome instead of blocking until the timeout.
      const lifecycle = probeTerminalLifecycle(terminal, sessionId);
      if (lifecycle && lifecycle.disposed !== true && lifecycle.state === 'sleeping') {
        return sleepingWaitResult(sessionId, lifecycle);
      }
      const { sessionIds: _namedByList, ...singleParams } = params;
      const input: TerminalWaitInput = { ...singleParams, sessionId, condition };
      try {
        if (condition === 'run-idle') return await waitForRunIdle(input, lifecycle, plan, signal);
        return await terminal.waitTerminal({ ...input, timeoutMs: plan.timeoutMs }, signal);
      } catch (err) {
        if (plan.clamped && err instanceof CapabilityError && err.code === 'WAIT_TIMEOUT') {
          return clampedWaitTimedOutResult(sessionId, params.timeoutMs as number, err);
        }
        throw err;
      }
    },
  });

  catalogue.register<
    { paged?: boolean; includeBuffer?: boolean },
    {
      sessions: unknown[];
      activeSessionId: string;
      omittedOutOfScopeTerminals?: number;
      daemonOutdated?: { running: string; staged: string; message: string };
      hooksStale?: StaleHook[];
    }
  >({
    name: 'terminal.list',
    description:
      'List the terminal split panes you may drive: the panes under the terminal you run in (the Space panes such as a sync watcher, and panes you created). The terminal you run in, other terminals, and other projects\' terminals are never listed; `omittedOutOfScopeTerminals` counts them. A Leader terminal (marked by the user) instead lists every live terminal of every project except its own, each row adding `workerOf` (when it is one of your workers) and `run` (the OMP run state read from its run file: state, runSeq, ompSessionId, promptHead, lastEventAt, stale), plus `hookSha256` (the run-state hook build that terminal\'s OMP runs) and `hookOutdated` (true when that build differs from the installed one, or reports none: that OMP started before the hooks were reinstalled, so tell the user to restart it; absent when the installed build is unknown). `hooksStale` ([{ id, state, detail }], top level of a Leader result, present only when an OMP hook needs reinstalling) names each hook whose installed copy is MISSING, INSTALLED_CHANGED (differs from what the installer wrote), SOURCE_CHANGED (the source it was built from changed after install), SOURCES_UNREADABLE, or NOT_INSTALLED (the installer knows the hook but the manifest has no row for it): relay it to the user as a reinstall plus new OMP sessions, never run the installer yourself. `daemonOutdated` ({ running, staged, message }) appears for a Leader when the terminal daemon still runs an older bundle than the one staged on disk: relay it to the user as "cần khởi động lại daemon", never restart it yourself (a restart ends every live shell). Rows carry bounded wire summary and incarnation metadata; includeBuffer:false drops the raw output tail (`buffer`) from every row, for polling many terminals',
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
      cancellationAckTimeoutMs: TERMINAL_CANCELLATION_ACK_MS,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        paged: { type: 'boolean', description: 'Whether to page buffers according to wire budget' },
        includeBuffer: { type: 'boolean', description: 'false drops the raw output tail (`buffer`) from every row; default true' },
      },
    },
    execute: (
      params: { paged?: boolean; includeBuffer?: boolean },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      const sessions = terminal.listSessions(params.paged ?? true);
      const scope = resolveTerminalCallerScope(ownership, context);
      const dropBuffer = params.includeBuffer === false;
      const withOwned = (session: unknown, owned: boolean): unknown => {
        if (session === null || typeof session !== 'object') return session;
        const row: Record<string, unknown> = { ...(session as Record<string, unknown>), owned };
        if (dropBuffer) delete row.buffer;
        return row;
      };
      // Only a caller that may restart or relay about the daemon hears about its version: a plain
      // agent in a split pane can do nothing with it.
      const outdatedNote = (): { daemonOutdated?: { running: string; staged: string; message: string } } => {
        const status = daemonStatus();
        if (!status.outdated) return {};
        const running = status.running ?? 'unknown';
        const staged = status.staged ?? 'unknown';
        return {
          daemonOutdated: {
            running,
            staged,
            message: `The terminal daemon runs bundle ${running} but ${staged} is staged: restart the daemon to load the newer terminal code. A restart ends every live shell, so ask the user first.`,
          },
        };
      };
      if (!scope.bound) {
        // A caller with no attachment carries no ownership question: every row is its to drive.
        return { sessions: sessions.map((session) => withOwned(session, true)), activeSessionId: terminal.getActiveSessionId() };
      }
      if (scope.leader) {
        // A Leader sees every live terminal of every project except its own home shell, each with the
        // OMP run state its run file records (when a hook ever wrote one).
        const registry = LeaderRegistry.getInstance();
        const reachable = sessions.filter((session) => Boolean(session?.id) && session.id !== scope.homeId && scope.ownership.isLiveTerminal?.(session.id) === true);
        const installedHook = (deps.installedHookSha256 ?? installedRunStateHookSha256)();
        const staleHooks = (deps.installedHooksStale ?? installedHooksStale)();
        const rows = reachable.map((session): Record<string, unknown> & { id: string } => {
          const worker = registry.workerOf(session.id);
          const run = leaderRunSnapshot(session.id);
          return {
            ...(withOwned(session, true) as Record<string, unknown>),
            id: session.id,
            ...(worker?.leaderId === scope.homeId ? { workerOf: worker.leaderId } : {}),
            ...(run ? { run, ...leaderHookStatus(session.id, installedHook) } : {}),
          };
        });
        const activeId = terminal.getActiveSessionId();
        return {
          sessions: rows,
          activeSessionId: rows.some((row) => row.id === activeId) ? activeId : (rows[0]?.id ?? ''),
          ...(sessions.length - rows.length > 0 ? { omittedOutOfScopeTerminals: sessions.length - rows.length } : {}),
          ...outdatedNote(),
          ...(staleHooks.length > 0 ? { hooksStale: staleHooks } : {}),
        };
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
    const queueKey = scope.tabId || scope.homeId;
    const prior = createQueues.get(queueKey);
    const run = prior ? settleWithin(prior, CREATE_POLICY_TIMEOUT_MS).then(work) : work();
    const tail = run.then(() => undefined, () => undefined);
    createQueues.set(queueKey, tail);
    try {
      return await run;
    } finally {
      if (createQueues.get(queueKey) === tail) createQueues.delete(queueKey);
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
    { sessionId: string; ownerBound?: boolean; reused?: boolean; cwd?: string; workerOf?: string; ownerKey?: string; capsuleId?: string; minted?: { capsuleId: string }; warning?: string }
  >({
    name: 'terminal.create',
    description:
      'Create a new terminal split pane under the terminal you run in (always a new pane, never the user\'s own split). You can only ever drive the panes under your own terminal, so this is the only way to get a shell. Close panes you no longer need with terminal.close. reuse:true returns your own idle pane for the same folder instead of a new one; use it only when that pane is idle, because a pane still running a command receives the input. A Leader terminal (marked by the user) that passes cwd without parentId instead mints a BASE terminal in the project that owns that folder, named by `name`, and registers it as its worker; `minted: { capsuleId }` in the result means this call created the folder\'s project capsule (none existed), which terminal.close { removeMintedProject: true } can remove again when the folder is under a Leader scratch folder. A split minted under a terminal a Leader drives is registered as that Leader\'s worker too, so the theme-push rules that apply to the worker apply in the split',
    risk: 'write',
    policy: {
      effect: 'management',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'reject-concurrent',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: CREATE_POLICY_TIMEOUT_MS + TERMINAL_CANCELLATION_ACK_MS,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: TERMINAL_CANCELLATION_ACK_MS,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory of the new pane (defaults to your terminal\'s). A Leader: the project folder to mint the worker terminal in' },
        name: { type: 'string', description: 'Leader only: the worker terminal\'s name, shown in the Worker board' },
        capsuleId: { type: 'string', description: 'Ignored for an agent: a pane always inherits the workspace of the terminal it splits' },
        parentId: { type: 'string', description: 'Omit. An agent always splits its own terminal; any other value is refused' },
        initialCols: { type: 'number' },
        initialRows: { type: 'number' },
        reuse: { type: 'boolean', description: 'Return your own live pane for the same cwd instead of creating one (only when it is idle)' },
      },
    },
    execute: (
      params: { cwd?: string; name?: string; capsuleId?: string; parentId?: string; initialCols?: number; initialRows?: number; reuse?: boolean },
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
      if (scope.leader && !(typeof params.parentId === 'string' && params.parentId.trim()) && typeof params.cwd === 'string' && params.cwd.trim()) {
        return placeLeaderWorker(terminal, scope.homeId, params);
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
      // A split of a Leader's worker is the same worker: an OMP started in it must find a record and be gated,
      // even when the Leader that drove the parent is gone. A split that cannot be recorded is closed again.
      const registry = LeaderRegistry.getInstance();
      if (registry.workerOf(scope.homeId)) {
        registry.forget(id);
        clearRunFilesOf(id);
        if (!registry.inheritWorker(id, scope.homeId)) {
          const closed = await closeUnrecordedTerminal(() => terminal.closeSplitSession(id));
          throw unrecordedWorkerError('The split', id, closed);
        }
      }
      return { sessionId: id, ownerBound: true };
    }),
  });

  catalogue.register<{ sessionId: string; isSplit?: boolean; removeMintedProject?: boolean }, { closed: boolean; projectRemoval?: TerminalProjectRemoval }>({
    name: 'terminal.close',
    description:
      'Close one of YOUR terminal split panes (a pane under the terminal you run in) and safely terminate its process tree. The terminal you run in and every terminal outside it are refused. A Leader terminal (marked by the user) may close any live terminal of any project except its own, and with removeMintedProject:true also removes the manager project that THIS worker\'s terminal.create minted (the result carries `minted`), but only when the folder is under a Leader scratch folder and no other terminal still lives in that project; a project that existed before the placement is never touched. The outcome is `projectRemoval` { status: REMOVED | NO_PROJECT | REFUSED | FAILED | SKIPPED, reason }',
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
      cancellationAckTimeoutMs: TERMINAL_CANCELLATION_ACK_MS,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to close' },
        isSplit: { type: 'boolean', description: 'Ignored for an agent: a pane is always closed as a split' },
        removeMintedProject: { type: 'boolean', description: 'Leader only: after closing, also remove the manager project this worker\'s terminal.create minted (result `minted`). Refused unless the folder is under a Leader scratch folder; never removes a project that existed before the placement' },
      },
      required: ['sessionId'],
    },
    execute: async (
      params: { sessionId: string; isSplit?: boolean; removeMintedProject?: boolean },
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      if (!params.sessionId || typeof params.sessionId !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'sessionId is required');
      }
      if (params.removeMintedProject !== undefined && typeof params.removeMintedProject !== 'boolean') {
        throw new CapabilityError('INVALID_ARGUMENT', 'removeMintedProject must be a boolean');
      }
      const scope = resolveTerminalCallerScope(ownership, context);
      assertTerminalOwnership(scope, params.sessionId);
      const removeMinted = params.removeMintedProject === true;
      if (removeMinted && !(scope.bound && scope.leader)) {
        throw new CapabilityError('TERMINAL_FORBIDDEN', 'removeMintedProject is available to a Leader terminal only: a pane you split is not a placement that minted a project');
      }
      // Read before closing: the host forgets a closed terminal's registry records as soon as it is closed.
      const registry = LeaderRegistry.getInstance();
      const minted = removeMinted ? registry.mintedOf(params.sessionId) : undefined;
      // A bound caller can only reach a split pane, and a split id closes exactly that pane.
      const isSplit = scope.bound && scope.leader
        ? typeof probeTerminalLifecycle(terminal, params.sessionId)?.splitOf === 'string'
        : params.isSplit || scope.bound;
      const closed = isSplit
        ? await terminal.closeSplitSession(params.sessionId)
        : await terminal.closeSession(params.sessionId);
      if (closed !== false) workerInputGate.forget(params.sessionId);
      if (!removeMinted) return { closed };
      if (closed === false) {
        return { closed, projectRemoval: { status: 'SKIPPED', reason: 'TERMINAL_NOT_CLOSED: the terminal is still open, so its project was not touched' } };
      }
      return { closed, projectRemoval: await removeMintedProjectOf(registry, minted) };
    },
  });
}
