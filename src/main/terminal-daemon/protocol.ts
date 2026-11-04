/**
 * Terminal Host protocol — the single source of truth for method and event names.
 *
 * Both sides import this: the daemon's dispatch switch and the GUI's proxy. A name that exists only
 * on one side is the drift this module exists to prevent — the proxy once exposed calls the daemon
 * answered with UNKNOWN_METHOD, which is a silent runtime failure rather than a compile error. With
 * the names shared, adding a method to one side without the other fails to compile.
 *
 * The payload envelope itself is the bridge's (src/shared/contracts.ts): the host is another
 * endpoint speaking the protocol this codebase already runs, not a third one.
 */
import type { BridgeRequestPayload, BridgeResponsePayload, BridgeEventPayload } from '../../shared/contracts';

export type HostRequest = BridgeRequestPayload<Record<string, unknown>>;
export type HostResponse = BridgeResponsePayload<unknown>;
export type HostEvent = BridgeEventPayload<unknown>;

/** Every RPC method the host answers. Keys are local; values are the wire method names. */
export const HOST_METHOD = {
  start: 'terminalStart',
  listSessions: 'terminalListSessions',
  // Liveness + scalar fields for one session, deliberately WITHOUT its buffer: the GUI calls this as
  // a truthiness oracle in ~25 places, and shipping a multi-MB transcript for `if (session)` would
  // put megabytes on the socket per check. Callers that need the transcript use getFullBuffer.
  getSession: 'terminalGetSession',
  getCurrentCwd: 'terminalGetCurrentCwd',
  getFullBuffer: 'terminalGetFullBuffer',
  getDelta: 'terminalGetDelta',
  syncView: 'terminalSyncView',
  captureBaseline: 'terminalCaptureBaseline',
  waitReady: 'terminalWaitReady',
  waitTerminal: 'terminalWaitTerminal',
  input: 'terminalInput',
  sendKey: 'terminalSendKey',
  resize: 'terminalResize',
  switchSession: 'terminalSwitchSession',
  newSession: 'terminalNewSession',
  closeSession: 'terminalCloseSession',
  closeSplitSession: 'terminalCloseSplitSession',
  renameSession: 'terminalRenameSession',
  reorderSessions: 'terminalReorderSessions',
  sleepSession: 'terminalSleepSession',
  wakeSession: 'terminalWakeSession',
  setCategory: 'terminalSetCategory',
  setSessionRole: 'terminalSetSessionRole',
  setCapsule: 'terminalSetCapsule',
  /**
   * Re-stamp one live session's owner key and capsule. Dotted deliberately: unlike its siblings,
   * this wire name is a frozen contract shared with the assign-capsule route, so it keeps its own
   * spelling instead of the `terminalXxx` form.
   */
  transferOwner: 'terminal.transferOwner',
  recordSubscriberAck: 'terminalRecordSubscriberAck',
  restart: 'terminalRestart',
  getStats: 'terminalGetStats',
  getDiagnostics: 'terminalGetDiagnostics',
  getSessionState: 'terminalGetSessionState',
  getSubscribers: 'terminalGetSubscribers',
  persistSync: 'terminalPersistSync',
  hostPing: 'terminalHostPing',
  setBridgeEndpoint: 'terminalSetBridgeEndpoint',
  /**
   * Kills every PTY and exits the host. Callers: the explicit "quit everything" menu action and an
   * owner-approved restart. It must never be wired to GUI shutdown — surviving GUI shutdown is the
   * entire reason the host is a separate process, so a shutdown-path call here would delete the
   * feature it was built for. Refused with `LIVE_RUNS` while an OMP run is alive, unless `force:true`.
   */
  shutdown: 'terminalHostShutdown',
} as const;

export type HostMethod = (typeof HOST_METHOD)[keyof typeof HOST_METHOD];

/** Wire parameters for terminalHostShutdown. */
export interface HostShutdownParams {
  /**
   * Shut down even when OMP runs are still alive. Only for a caller that shows the owner the live
   * runs at that moment (the "Thoát hoàn toàn" dialog). A scripted restart must use `allowRuns`.
   */
  force?: boolean;
  /**
   * terminalSessionIds whose live run the owner approved ending. They do not block; any other live
   * run (for example one that started after the approval) still refuses the shutdown.
   */
  allowRuns?: string[];
  [key: string]: unknown;
}

/** One OMP run that a host shutdown would end: a run file whose state is not `ended` and whose pid is alive. */
export interface LiveRunSummary {
  terminalSessionId: string;
  pid: number;
  state: string;
  ompSessionId?: string;
  cwd?: string;
  promptHead?: string;
  lastEventAt?: number;
}

/** `error` prefix and `data.code` of a terminalHostShutdown the host refused. */
export const LIVE_RUNS_CODE = 'LIVE_RUNS';

/** Wire `data` of a refused terminalHostShutdown (`success:false`). */
export interface HostShutdownRefusal {
  code: typeof LIVE_RUNS_CODE;
  runs: LiveRunSummary[];
}

export function describeLiveRuns(runs: readonly LiveRunSummary[]): string {
  return runs.map((run) => `${run.terminalSessionId} (omp pid ${run.pid}, ${run.state})`).join(', ');
}

/** Thrown by the proxy when the host refuses to shut down because OMP runs are alive and `force` was not set. */
export class LiveRunsError extends Error {
  readonly code = LIVE_RUNS_CODE;
  constructor(readonly runs: LiveRunSummary[]) {
    super(`${LIVE_RUNS_CODE}: shutdown would end ${runs.length} live OMP run(s): ${describeLiveRuns(runs)}. Pass force:true only with the owner's explicit approval.`);
    this.name = 'LiveRunsError';
  }
}

/** Wire parameters for terminalNewSession */
export interface HostNewSessionParams {
  cwd?: string;
  capsuleId?: string;
  /**
   * Owner key of the window requesting the session (`project:<projectId>` | `unassigned`).
   * Absent when the caller predates owner-key attribution, in which case the host falls back to
   * the legacy capsule/workspace-tag attribution so old clients keep today's visibility.
   */
  ownerKey?: string;
  /**
   * `role`, `idlePolicy`, `spaceTerminalId`: stamped at creation, never by a follow-up call. A split
   * (`parentId` set) owns them too, and `name` is the label it is minted with.
   */
  role?: string;
  idlePolicy?: string;
  spaceTerminalId?: string;
  name?: string;
  parentId?: string;
  cols?: number;
  rows?: number;
  /** Forward-compatible wire payload: unknown fields travel through untouched. */
  [key: string]: unknown;
}

/** Wire result for terminalNewSession */
export interface HostNewSessionResult {
  sessionId: string;
  sessions?: unknown[];
  activeSessionId?: string;
}

/** Wire parameters for terminalStart */
export interface HostStartParams {
  cwd?: string;
  capsuleId?: string;
  /**
   * Owner key of the window requesting the start (`project:<projectId>` | `unassigned`), stamped
   * onto any session this call spawns. Absent when the caller predates owner-key attribution, in
   * which case the host falls back to the legacy capsule/workspace-tag attribution.
   */
  ownerKey?: string;
  /** Forward-compatible wire payload: unknown fields travel through untouched. */
  [key: string]: unknown;
}

/** Wire result for terminalStart */
export interface HostStartResult {
  started: boolean;
  sessions?: unknown[];
  activeSessionId?: string;
}

/** Wire parameters for terminalRestart */
export interface HostRestartParams {
  cwd?: string;
  /**
   * Owner key of the window requesting the restart (`project:<projectId>` | `unassigned`), stamped
   * onto any record this restart mints — a restart with no live session would otherwise create an
   * unowned record that a project window must never see. Absent when the caller predates owner-key
   * attribution, in which case the host falls back to the legacy capsule/workspace-tag attribution.
   */
  ownerKey?: string;
  /** Forward-compatible wire payload: unknown fields travel through untouched. */
  [key: string]: unknown;
}

/** Wire parameters for terminal.transferOwner */
export interface HostTransferOwnerParams {
  sessionId: string;
  /** Window owner key the session moves to (`project:<projectId>` | `unassigned`). */
  ownerKey: string;
  /** Workspace capsule the session moves to; it travels with the owner so the row cannot be shown under a capsule it is not attributed to. Omitted when the target project has no workspace, which clears the old stamp. */
  capsuleId?: string;
  [key: string]: unknown;
}

/** Broadcast events the host pushes to every connected client. */
export const HOST_EVENT = {
  data: 'antifan:terminal:data',
  session: 'antifan:terminal:session',
  sessionClosed: 'antifan:terminal:session-closed',
  sessionCreated: 'antifan:terminal:session-created',
  sessionRestarted: 'antifan:terminal:session-restarted',
  sessionWoken: 'antifan:terminal:session-woken',
  exit: 'antifan:terminal:exit',
} as const;

export type HostEventName = (typeof HOST_EVENT)[keyof typeof HOST_EVENT];

/**
 * The host's own event names, mapped to the names TerminalManager emits locally.
 *
 * TerminalManager emits bare names ('data', 'session'); the wire carries the `antifan:`-prefixed
 * form the bridge already uses. Subscribers on the GUI side keep listening to the bare names, so a
 * subscriber never needs to know whether it is talking to the daemon or an in-process manager.
 */
export const HOST_EVENT_TO_LOCAL: Record<HostEventName, string> = {
  [HOST_EVENT.data]: 'data',
  [HOST_EVENT.session]: 'session',
  [HOST_EVENT.sessionClosed]: 'session-closed',
  [HOST_EVENT.sessionCreated]: 'session-created',
  [HOST_EVENT.sessionRestarted]: 'session-restarted',
  [HOST_EVENT.sessionWoken]: 'session-woken',
  [HOST_EVENT.exit]: 'exit',
};
