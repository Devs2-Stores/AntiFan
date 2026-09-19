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
  setCapsule: 'terminalSetCapsule',
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
   * Kills every PTY and exits the host. This exists for one caller only: the explicit
   * "quit everything" menu action. It must never be wired to GUI shutdown — surviving GUI shutdown
   * is the entire reason the host is a separate process, so a shutdown-path call here would delete
   * the feature it was built for.
   */
  shutdown: 'terminalHostShutdown',
} as const;

export type HostMethod = (typeof HOST_METHOD)[keyof typeof HOST_METHOD];

/** Broadcast events the host pushes to every connected client. */
export const HOST_EVENT = {
  data: 'antifan:terminal:data',
  session: 'antifan:terminal:session',
  sessionClosed: 'antifan:terminal:session-closed',
  sessionCreated: 'antifan:terminal:session-created',
  sessionRestarted: 'antifan:terminal:session-restarted',
  sessionWoken: 'antifan:terminal:session-woken',
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
};
