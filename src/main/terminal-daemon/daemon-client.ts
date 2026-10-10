/**
 * Terminal Host client — the GUI-side proxy for the detached daemon.
 *
 * Two layers:
 *
 *   DaemonClient          low-level WebSocket RPC. Speaks the same {id,method,params} /
 *                         {id,success,data,error} envelope the bridge already uses, plus the
 *                         daemon's {event,data} broadcasts. Reconnects with backoff and re-issues
 *                         nothing — a dropped call rejects so the caller can retry explicitly.
 *
 *   DaemonTerminalProxy   a TerminalManager-shaped async facade over DaemonClient. The daemon owns
 *                         the real PTYs; this class only forwards. Methods are async because the
 *                         transport is async — the flag-gated cutover awaits them at the call
 *                         sites. Events the daemon broadcasts (data / session / session-closed /
 *                         session-created / session-restarted / session-woken) are re-emitted under
 *                         the same names TerminalManager uses, so subscribers need no change.
 *
 * The proxy never spawns a PTY and never writes terminal state — single-writer invariant stays
 * with the daemon.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { HOST_METHOD, HOST_EVENT, HOST_EVENT_TO_LOCAL } from './protocol';
import type { HostNewSessionParams, HostNewSessionResult, HostRestartParams, HostStartParams, HostStartResult, HostTransferOwnerParams } from './protocol';
import type { BridgeRequestPayload, BridgeResponsePayload, BridgeEventPayload, TerminalAckPayload, TerminalSleepResult, TerminalRoleMeta } from '../../shared/contracts';
import type { TerminalWaitInput, TerminalWaitResult } from '../../shared/control-plane-contracts';
import type { DaemonSpawnResult } from './daemon-spawner';

const HOST = '127.0.0.1';
const CALL_TIMEOUT_MS = 15000;
/**
 * Deadline for establishing the socket and completing authentication handshake.
 *
 * Sits far above the measured local loopback WebSocket upgrade round trip (1–15ms)
 * and well below user patience and CALL_TIMEOUT_MS (15000ms), so an accepted TCP
 * connection whose peer never answers the WebSocket upgrade rejects with a typed refusal
 * instead of stranding every caller awaiting connect().
 */
export const HANDSHAKE_TIMEOUT_MS = 5000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;

export interface DaemonEndpoint {
  port: number;
  token: string;
}

/** Consecutive refused connects (nothing listens on the port) before a respawn is considered. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
/** Circuit breaker: respawns allowed per window; plain reconnects keep backing off past it. */
export const MAX_DAEMON_RESPAWNS = 3;
export const DAEMON_RESPAWN_WINDOW_MS = 10 * 60 * 1000;

/** Brings up a replacement host; `ensureDaemon({ onlyIfDead: true })` in production. */
export type DaemonRespawnFn = () => Promise<DaemonSpawnResult>;

/** The transport half the proxy drives; `DaemonClient` in production. */
export interface DaemonClientTransport {
  connect(timeoutMs?: number): Promise<void>;
  call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onEvent(event: string, handler: (data: unknown) => void): () => void;
  onClose(handler: () => void): void;
  updateEndpoint(endpoint: DaemonEndpoint): void;
  close(): void;
}

export interface DaemonTerminalProxyOptions {
  respawn?: DaemonRespawnFn;
  maxReconnectAttempts?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  client?: DaemonClientTransport;
}

interface PendingCall {
  resolve: (value: BridgeResponsePayload) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Low-level RPC transport. One socket, one pending-call map, server-push events surfaced through
 * `onEvent`. Reconnect is the caller's decision (`onClose`); this class does not silently retry a
 * call across a reconnect because the daemon may not have completed it.
 */
export class DaemonClient {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private nextId = 1;
  private readonly eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  private closeHandlers = new Set<() => void>();
  private openPromise: Promise<void> | null = null;
  private openReject: ((err: Error) => void) | null = null;

  constructor(private endpoint: DaemonEndpoint) {}

  /**
   * Point later connects at a replacement host. Only the respawn path calls this, after the old
   * socket is already gone; a socket or handshake still held is dropped so nothing reaches the
   * old host under the new token.
   */
  updateEndpoint(endpoint: DaemonEndpoint): void {
    if (this.endpoint.port === endpoint.port && this.endpoint.token === endpoint.token) return;
    this.endpoint = endpoint;
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      try { oldWs.close(); } catch { /* ignore */ }
    }
    if (this.openReject) {
      const reject = this.openReject;
      this.openReject = null;
      reject(new Error(`daemon endpoint replaced before handshake (${HOST}:${endpoint.port})`));
    }
    this.openPromise = null;
  }

  /** Establish the socket and authenticate. Resolves once the upgrade succeeds. */
  connect(timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.openReject = reject;
      let handshakeTimer: NodeJS.Timeout | null = null;
      const settle = (fn: () => void): void => {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        this.openReject = null;
        fn();
      };

      const ws = new WebSocket(`ws://${HOST}:${this.endpoint.port}/`, {
        headers: { 'x-antifan-token': this.endpoint.token },
      });
      this.ws = ws;

      handshakeTimer = setTimeout(() => {
        if (this.openReject) {
          try { ws.close(); } catch { /* ignore */ }
          settle(() => reject(new Error(`daemon handshake timed out after ${timeoutMs}ms (${HOST}:${this.endpoint.port})`)));
        }
      }, timeoutMs);
      handshakeTimer.unref?.();

      ws.on('message', (raw) => this.onMessage(raw));
      ws.on('close', () => {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        // A socket connect() has already replaced — a handshake-timeout retry, or an
        // explicit reconnect — closes after its successor is installed. That close says
        // nothing about the live socket, so it must not run the shared teardown: doing so
        // rejects the new socket's in-flight calls and asks the owner to reconnect a link
        // that is healthy. Only the currently installed socket speaks for the transport.
        if (this.ws !== ws) return;
        this.handleSocketClose();
      });
      ws.on('error', () => { /* close follows */ });

      ws.once('open', () => settle(() => resolve()));
      ws.once('unexpected-response', (_req, res) => settle(() => reject(new Error(`HTTP ${res.statusCode}`))));
      ws.once('error', (err) => settle(() => reject(err)));
    });
    // A failed connect must not poison a later retry.
    this.openPromise.catch(() => {
      this.openPromise = null;
      this.openReject = null;
    });
    return this.openPromise;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Invoke a daemon method. Rejects on transport failure, timeout, or a daemon-side error.
   *
   * `timeoutMs` exists because a call whose server-side work is legitimately slow — `terminalWaitReady`
   * waits for a prompt — must not be cancelled by a transport budget shorter than its own. A fixed
   * transport timeout makes such a call fail forever, no matter how healthy the host is.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('daemon socket is not open');

    const id = `rpc-${this.nextId++}`;
    const frame: BridgeRequestPayload = { id, method, params };
    const response = new Promise<BridgeResponsePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    ws.send(JSON.stringify(frame));

    const resp = await response;
    if (!resp.success) {
      // `data` is the handler's own outcome and it survives even when no reason string was set:
      // `success:false` with `error:undefined` is how a boolean-returning handler reports "not
      // applied". Dropping the envelope here leaves callers — and the probes that gate dispatch —
      // holding an unreadable `<method> failed` with nothing to triage.
      const err = new Error(resp.error || `${method} failed`) as Error & {
        rpcFailure?: { data?: unknown; error?: string };
      };
      err.rpcFailure = { data: resp.data, error: resp.error };
      throw err;
    }
    return resp.data as T;
  }

  /** Subscribe to a daemon broadcast event (e.g. 'antifan:terminal:data'). */
  onEvent(event: string, handler: (data: unknown) => void): () => void {
    let set = this.eventHandlers.get(event);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Fired once per socket close. Register reconnection policy here. */
  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
    this.handleSocketClose();
  }

  private onMessage(raw: WebSocket.RawData): void {
    let frame: BridgeResponsePayload & BridgeEventPayload;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    // Response frame: has id + success.
    if (typeof frame.id === 'string' && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id)!;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      p.resolve(frame);
      return;
    }
    // Event frame: has event + data.
    if (typeof frame.event === 'string') {
      const set = this.eventHandlers.get(frame.event);
      if (set) for (const h of set) h(frame.data);
    }
  }

  private handleSocketClose(): void {
    if (this.openReject) {
      const reject = this.openReject;
      this.openReject = null;
      reject(new Error(`daemon socket closed before handshake (${HOST}:${this.endpoint.port})`));
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('daemon socket closed'));
    }
    this.pending.clear();
    this.ws = null;
    this.openPromise = null;
    for (const h of this.closeHandlers) h();
  }
}

/**
 * TerminalManager-shaped async facade. Method names mirror the manager's; every one is a forwarded
 * RPC. Events are re-emitted under TerminalManager's names so existing subscribers are unchanged.
 */
export class DaemonTerminalProxy extends EventEmitter {
  private readonly client: DaemonClientTransport;
  private readonly respawnFn?: DaemonRespawnFn;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private reconnectDelay: number;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private consecutiveRefusedFailures = 0;
  private readonly respawnAttempts: number[] = [];
  private circuitBreakerWarned = false;
  private reconnecting = false;
  private closed = false;

  private cachedSessions: Array<Record<string, unknown>> = [];
  private cachedSessionsById = new Map<string, Record<string, unknown>>();
  private cachedActiveSessionId = '';
  private cachedCwd = process.cwd();
  private cachedSessionState: Record<string, unknown> | null = null;
  private cachedStats = {
    sessionCount: 0,
    runningPtyCount: 0,
    transcriptBytes: 0,
    dataSubscriptionCount: 0,
    exitSubscriptionCount: 0,
    memoryEstimateBytes: 0,
  };

  constructor(endpoint: DaemonEndpoint, options: DaemonTerminalProxyOptions = {}) {
    super();
    this.respawnFn = options.respawn;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectMinMs = options.reconnectMinMs ?? RECONNECT_MIN_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? RECONNECT_MAX_MS;
    this.reconnectDelay = this.reconnectMinMs;
    this.client = options.client ?? new DaemonClient(endpoint);
    this.wireEvents();
    this.client.onClose(() => this.scheduleReconnect());
  }

  private _updateLocalCache(state: { sessions?: unknown[]; activeSessionId?: string; cwd?: string; splitSessionId?: string; snapshot?: string; snapshotThroughSeq?: number } | null | undefined): void {
    if (!state) return;
    if (Array.isArray(state.sessions)) {
      this.cachedSessions = state.sessions as Array<Record<string, unknown>>;
      this.cachedSessionsById.clear();
      for (const s of this.cachedSessions) {
        if (s && typeof s.id === 'string') {
          this.cachedSessionsById.set(s.id, s);
        }
      }
    }
    if (typeof state.activeSessionId === 'string' && state.activeSessionId) {
      this.cachedActiveSessionId = state.activeSessionId;
    }
    if (typeof state.cwd === 'string' && state.cwd) {
      this.cachedCwd = state.cwd;
    } else {
      const active = this.cachedSessionsById.get(this.cachedActiveSessionId);
      if (active && typeof active.cwd === 'string') {
        this.cachedCwd = active.cwd;
      }
    }
    const prevSnapshot = (this.cachedSessionState as Record<string, unknown> | undefined)?.snapshot;
    const prevSeq = (this.cachedSessionState as Record<string, unknown> | undefined)?.snapshotThroughSeq;
    this.cachedSessionState = {
      activeSessionId: this.cachedActiveSessionId,
      sessions: this.cachedSessions,
      splitSessionId: state.splitSessionId || (this.cachedSessionState as Record<string, unknown> | undefined)?.splitSessionId,
      snapshot: typeof state.snapshot === 'string' ? state.snapshot : (typeof prevSnapshot === 'string' ? prevSnapshot : ''),
      snapshotThroughSeq: typeof state.snapshotThroughSeq === 'number' ? state.snapshotThroughSeq : (typeof prevSeq === 'number' ? prevSeq : 0),
    };
    this.cachedStats.sessionCount = this.cachedSessions.length;
    this.cachedStats.runningPtyCount = this.cachedSessions.filter((s) => s.state === 'running').length;
  }

  private wireEvents(): void {
    // The daemon broadcasts the `antifan:`-prefixed names; TerminalManager emits the bare ones.
    // The mapping lives in protocol.ts so neither side can drift from the other.
    for (const [remote, local] of Object.entries(HOST_EVENT_TO_LOCAL)) {
      this.client.onEvent(remote, (data) => {
        if (remote === 'antifan:terminal:session' || local === 'session') {
          this._updateLocalCache(data as Record<string, unknown>);
        }
        this.emit(local, data);
      });
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed || this.reconnecting) return;
      this.reconnecting = true;
      void this.attemptConnect().finally(() => { this.reconnecting = false; });
    }, this.reconnectDelay);
  }

  private async attemptConnect(): Promise<void> {
    try {
      await this.connect();
      if (this.closed) return;
      this.onReconnected();
    } catch (err) {
      if (this.closed) return;
      // Only a refused connect says nothing listens on the port any more; a timeout or a failed
      // handshake can come from a host that is alive and busy, which a respawn must never replace.
      const refused = !!err && typeof err === 'object' && 'code' in err && err.code === 'ECONNREFUSED';
      this.consecutiveRefusedFailures = refused ? this.consecutiveRefusedFailures + 1 : 0;
      if (this.respawnFn && this.consecutiveRefusedFailures >= this.maxReconnectAttempts && this.respawnAllowed()) {
        await this.respawnAndConnect(this.respawnFn);
        return;
      }
      this.backOff();
    }
  }

  private onReconnected(): void {
    this.consecutiveRefusedFailures = 0;
    this.reconnectDelay = this.reconnectMinMs;
    this.emit('reconnected');
    if (this.cachedSessionState) this.emit('session', this.cachedSessionState);
  }

  private backOff(): void {
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs);
    this.scheduleReconnect();
  }

  /** Circuit breaker: at most MAX_DAEMON_RESPAWNS respawns per window; plain reconnects keep going. */
  private respawnAllowed(): boolean {
    const now = Date.now();
    while (this.respawnAttempts.length && now - this.respawnAttempts[0]! >= DAEMON_RESPAWN_WINDOW_MS) {
      this.respawnAttempts.shift();
    }
    if (this.respawnAttempts.length < MAX_DAEMON_RESPAWNS) return true;
    if (!this.circuitBreakerWarned) {
      this.circuitBreakerWarned = true;
      console.warn(`[daemon-proxy] Respawn circuit breaker open after ${MAX_DAEMON_RESPAWNS} attempts; continuing reconnect backoff`);
    }
    return false;
  }

  private async respawnAndConnect(respawn: DaemonRespawnFn): Promise<void> {
    this.respawnAttempts.push(Date.now());
    try {
      const result = await respawn();
      if (this.closed) return;
      if (!result.handle) throw new Error(result.reason || 'daemon respawn produced no host');
      this.client.updateEndpoint({ port: result.handle.port, token: result.handle.token });
      await this.connect();
      if (this.closed) return;
      this.onReconnected();
    } catch (err) {
      if (this.closed) return;
      console.warn('[daemon-proxy] Daemon respawn refused or failed; reconnect backoff continues:', err instanceof Error ? err.message : err);
      this.backOff();
    }
  }

  async connect(): Promise<void> {
    await this.client.connect();
    try {
      const initial = await this.client.call<Record<string, unknown>>(HOST_METHOD.getSessionState);
      this._updateLocalCache(initial);
      const cwdRes = await this.client.call<{ cwd: string }>(HOST_METHOD.getCurrentCwd).catch(() => null);
      if (cwdRes?.cwd) this.cachedCwd = cwdRes.cwd;
    } catch {
      /* best effort warm */
    }
  }

  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.client.close();
  }

  /* ---- TerminalManager-shaped surface (async & sync-cached) ---- */

  /**
   * Start the terminal subsystem or re-establish working directory.
   *
   * ASYNC/SYNC SEAM CONTRACT:
   * While `TerminalManager.startTerminal(cwd?, capsuleId?, ownerKey?)` is synchronous and returns `boolean`,
   * this proxy communicates with the daemon over WebSocket and returns `Promise<boolean>`.
   * The daemon's `start` handler threads `capsuleId` and `ownerKey` to `TerminalManager.startTerminal`,
   * so initial session creation and restored saved sessions preserve workspace provenance and window ownership.
   *
   * @param cwd Initial working directory
   * @param capsuleId Optional workspace capsule to preserve provenance if an initial session is spawned
   * @param ownerKey Optional owner key of the requesting window; a session spawned by this call is
   *   visible only to that window's scope. Omitted from the wire when empty, so the host falls back
   *   to the legacy capsule attribution.
   */
  async startTerminal(cwd?: string, capsuleId?: string, ownerKey?: string): Promise<boolean> {
    // Idempotent on the daemon side: its shell already exists, so this re-establishes cwd and
    // returns the manager's actual answer rather than a fabricated success.
    const payload: HostStartParams = {};
    if (typeof cwd === 'string' && cwd) payload.cwd = cwd;
    if (typeof capsuleId === 'string' && capsuleId) payload.capsuleId = capsuleId;
    if (typeof ownerKey === 'string' && ownerKey) payload.ownerKey = ownerKey;
    const r = await this.client.call<HostStartResult>(HOST_METHOD.start, payload);
    return r.started;
  }

  listSessions(): unknown[] {
    return this.cachedSessions;
  }

  getActiveSessionId(): string {
    return this.cachedActiveSessionId;
  }
  async getFullBuffer(sessionId: string): Promise<unknown> {
    return this.client.call(HOST_METHOD.getFullBuffer, { sessionId });
  }

  async getTerminalDelta(sessionId: string, generation: number, fromSeq: number): Promise<unknown> {
    return this.client.call(HOST_METHOD.getDelta, { sessionId, generation, fromSeq });
  }

  async syncTerminalView(query: { sessionId: string; knownGeneration: number; lastAppliedSeq: number }): Promise<unknown> {
    return this.client.call(HOST_METHOD.syncView, query as Record<string, unknown>);
  }

  /**
   * Write input to the daemon's active session.
   *
   * ASYNC/SYNC SEAM CONTRACT:
   * `TerminalManager.write(input)` in-process is `void`, but this proxy is a daemon
   * round-trip, so it returns `Promise<boolean>` resolving when the daemon settles it —
   * `true` when the input was delivered, `false` when the RPC failed. The promise must
   * NOT be discarded here: callers admit this write against the close gate and release
   * that admission from the returned value's own settlement, so a swallowed promise would
   * report the write finished while the daemon is still waking or spawning the PTY that
   * receives it — letting a quit tear down mid-write. The catch-to-`false` mapping keeps
   * the old "never throws" contract so the release path can never be stranded by a
   * rejection.
   */
  write(input: string): Promise<boolean> {
    return this.client.call(HOST_METHOD.input, { text: input }).then(() => true, () => false);
  }

  /**
   * Write input to a named session in the daemon.
   *
   * ASYNC/SYNC SEAM CONTRACT: same shape as {@link write} — returns `Promise<boolean>`
   * settling when the daemon RPC settles (`true` delivered / `false` failed, never
   * rejects) instead of the in-process manager's `void`, so a close admission held
   * against the write releases only once the daemon is actually done with it.
   */
  writeTo(sessionId: string, input: string): Promise<boolean> {
    return this.client.call(HOST_METHOD.input, { sessionId, text: input }).then(() => true, () => false);
  }

  async sendKey(key: string, sessionId?: string): Promise<void> {
    await this.client.call(HOST_METHOD.sendKey, { key, sessionId });
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.client.call(HOST_METHOD.resize, { cols, rows });
  }

  async resizeTo(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.client.call(HOST_METHOD.resize, { sessionId, cols, rows });
  }

  /**
   * Create a new terminal session in the daemon.
   *
   * ASYNC/SYNC SEAM CONTRACT:
   * While `TerminalManager.createSession(cwd?, capsuleId?, ownerKey?)` in-process is synchronous and returns `string`,
   * this daemon proxy communicates over WebSocket and returns `Promise<string>`.
   * Callers holding a reference to the process-wide terminal singleton (`TerminalManager.getInstance()`)
   * in daemon mode MUST await `createSession(...)` (e.g. `await terminal.createSession(cwd, capsuleId, ownerKey)`).
   * A synchronous read without `await` receives a `Promise<string>` object rather than a session ID string,
   * whose `typeof` is `'object'` and cannot be used directly as a session identifier (it serializes to `{}` in JSON).
   * Awaiting the call unwraps both shapes cleanly: `await Promise.resolve(id)` and `await id` both evaluate to the string id.
   *
   * @param cwd Initial working directory for the session shell
   * @param capsuleId Optional workspace capsule to preserve provenance for the created session
   * @param ownerKey Optional owner key of the requesting window; the created session is visible only
   *   to that window's scope. Omitted from the wire when empty, so the host falls back to the legacy
   *   capsule attribution.
   * @returns Promise resolving to the created session ID string
   */
  async createSession(cwd?: string, capsuleId?: string, ownerKey?: string, meta?: TerminalRoleMeta): Promise<string> {
    const payload: HostNewSessionParams = {};
    if (typeof cwd === 'string' && cwd) payload.cwd = cwd;
    if (typeof capsuleId === 'string' && capsuleId) payload.capsuleId = capsuleId;
    if (typeof ownerKey === 'string' && ownerKey) payload.ownerKey = ownerKey;
    if (meta) {
      if (typeof meta.role === 'string') payload.role = meta.role;
      if (typeof meta.idlePolicy === 'string') payload.idlePolicy = meta.idlePolicy;
      if (typeof meta.spaceTerminalId === 'string') payload.spaceTerminalId = meta.spaceTerminalId;
    }
    const r = await this.client.call<HostNewSessionResult>(HOST_METHOD.newSession, payload);
    return r.sessionId;
  }

  async createSplitSession(parentId: string, cwd?: string, cols?: number, rows?: number): Promise<string> {
    const payload: HostNewSessionParams = { parentId };
    if (typeof cwd === 'string' && cwd) payload.cwd = cwd;
    if (typeof cols === 'number') payload.cols = cols;
    if (typeof rows === 'number') payload.rows = rows;
    const r = await this.client.call<HostNewSessionResult>(HOST_METHOD.newSession, payload);
    return r.sessionId;
  }

  async switchSession(sessionId: string): Promise<boolean> {
    const r = await this.client.call<{ switched: boolean }>(HOST_METHOD.switchSession, { sessionId });
    return r.switched;
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const r = await this.client.call<{ closed: boolean }>(HOST_METHOD.closeSession, { sessionId });
    return r.closed;
  }

  async renameSession(sessionId: string, name: string): Promise<boolean> {
    const r = await this.client.call<{ renamed: boolean }>(HOST_METHOD.renameSession, { sessionId, name });
    return r.renamed;
  }

  /**
   * Restart the daemon's shell.
   *
   * `ownerKey` is stamped on any record this restart mints: a restart with no live session would
   * otherwise create an unowned record that a project window must never see. Omitted from the wire
   * when empty, so the host falls back to the legacy capsule attribution.
   */
  async restart(cwd?: string, ownerKey?: string): Promise<void> {
    const payload: HostRestartParams = { cwd };
    if (typeof ownerKey === 'string' && ownerKey) payload.ownerKey = ownerKey;
    await this.client.call(HOST_METHOD.restart, payload);
  }

  async sleepSession(sessionId: string): Promise<TerminalSleepResult> {
    const r = await this.client.call<{ result: TerminalSleepResult }>(HOST_METHOD.sleepSession, { sessionId });
    return r.result;
  }

  async setCategory(sessionId: string, category?: string): Promise<boolean> {
    const r = await this.client.call<{ ok: boolean }>(HOST_METHOD.setCategory, { sessionId, category });
    return r.ok;
  }

  async setSessionRole(sessionId: string, meta: { role?: unknown; idlePolicy?: unknown; spaceTerminalId?: unknown }): Promise<boolean> {
    const r = await this.client.call<{ ok: boolean }>(HOST_METHOD.setSessionRole, { sessionId, ...meta });
    return r.ok;
  }

  getStats(): unknown {
    this.client.call(HOST_METHOD.getStats).then((stats: unknown) => {
      if (stats && typeof stats === 'object') Object.assign(this.cachedStats, stats);
    }).catch(() => undefined);
    return this.cachedStats;
  }

  getSession(sessionId: string, opts: { includeBuffer?: boolean } = {}): Record<string, unknown> | Promise<Record<string, unknown> | undefined> | undefined {
    if (opts.includeBuffer === true) {
      return this.client.call<{ session: Record<string, unknown> | null }>(HOST_METHOD.getSession, {
        sessionId,
        includeBuffer: true,
      }).then((r) => r.session ?? undefined);
    }
    const s = this.cachedSessionsById.get(sessionId);
    if (!s) return undefined;
    const { buffer: _b, splitBuffer: _sb, ...scalars } = s;
    return scalars;
  }

  getCurrentCwd(): string {
    return this.cachedCwd;
  }

  async closeSplitSession(parentIdOrSplitId: string): Promise<boolean> {
    const r = await this.client.call<{ closed: boolean }>(HOST_METHOD.closeSplitSession, { sessionId: parentIdOrSplitId });
    return r.closed;
  }

  async reorderSessions(orderIds: string[]): Promise<boolean> {
    const r = await this.client.call<{ reordered: boolean }>(HOST_METHOD.reorderSessions, { orderIds });
    return r.reordered;
  }

  async wakeSession(sessionId: string): Promise<boolean> {
    const r = await this.client.call<{ woken: boolean }>(HOST_METHOD.wakeSession, { sessionId });
    return r.woken;
  }

  async setCapsule(capsuleId: string, cwd?: string, sessionId?: string): Promise<void> {
    await this.client.call(HOST_METHOD.setCapsule, { capsuleId, cwd, sessionId });
  }

  /**
   * Move a live session onto another window owner, re-stamping its owner key and workspace capsule.
   *
   * ASYNC/SYNC SEAM CONTRACT: `TerminalManager.transferSessionOwner(sessionId, ownerKey, capsuleId)`
   * in-process is synchronous and returns `boolean`; the daemon owns the records, so this facade
   * keeps the manager's public name and returns `Promise<boolean>` for the same call. A project
   * without a workspace passes no `capsuleId`: the field is omitted from the wire so the daemon
   * clears the row's old workspace stamp rather than preserving it.
   *
   * A refusal — unknown session, already-closed session, empty owner or a present-but-empty
   * capsule — resolves `false` instead of rejecting, because that is exactly what the in-process
   * call returns for the same inputs. Only a transport failure or a malformed request rejects, so
   * a caller can tell "not moved" from "could not ask". The host broadcasts the ordinary session
   * event before answering, so the cached summaries this facade answers {@link sessionOwnerKey}
   * and {@link sessionCapsuleId} from carry the new owner by the time this promise settles.
   */
  async transferSessionOwner(sessionId: string, ownerKey: string, capsuleId?: string): Promise<boolean> {
    const payload: HostTransferOwnerParams = { sessionId, ownerKey };
    if (capsuleId !== undefined) payload.capsuleId = capsuleId;
    const r = await this.client.call<{ transferred: boolean }>(HOST_METHOD.transferOwner, payload);
    return r.transferred === true;
  }

  async recordSubscriberAck(ack: TerminalAckPayload): Promise<void> {
    await this.client.call(HOST_METHOD.recordSubscriberAck, ack as unknown as Record<string, unknown>);
  }

  /**
   * Kills every PTY on the host and exits it. The ONLY legitimate caller is the explicit
   * "quit everything" menu action. Never call this from GUI shutdown: the host outliving the GUI is
   * the point of the host, so a shutdown-path call would silently delete the feature.
   */
  async shutdownHost(): Promise<void> {
    await this.client.call(HOST_METHOD.shutdown).catch(() => undefined);
  }

  async getDiagnostics(): Promise<unknown> {
    return this.client.call(HOST_METHOD.getDiagnostics);
  }

  getSessionState(): unknown {
    return this.cachedSessionState || {
      activeSessionId: this.cachedActiveSessionId,
      sessions: this.cachedSessions,
    };
  }

  /**
   * Workspace capsule a session belongs to, or undefined for a session this facade holds
   * no summary for.
   *
   * The daemon owns the session records, so the cached summaries are the only provenance
   * the proxy can answer from. A summary carries `capsuleId` exactly when the session was
   * created in a workspace, so the answer matches the in-process manager's
   * `s.capsuleId || undefined` for every session this facade knows — and matches its
   * unknown-session answer for every session it does not.
   */
  sessionCapsuleId(sessionId: string): string | undefined {
    const s = this.cachedSessionsById.get(sessionId);
    if (!s) return undefined;
    return typeof s.capsuleId === 'string' && s.capsuleId ? s.capsuleId : undefined;
  }

  /**
   * Owner key of the window a session belongs to, or undefined when the cached summary carries
   * none — an unknown session, or a legacy row written before owner-key attribution.
   *
   * The daemon owns the session records, so the cached summaries are the only provenance this
   * facade can answer from: `_updateLocalCache` stores them verbatim, so the field survives the
   * round trip. `undefined` is a meaningful answer here, not a miss: a session without an owner
   * key is matched by the legacy capsule rule in the asking window's scope, exactly as it was
   * before owner keys existed.
   */
  sessionOwnerKey(sessionId: string): string | undefined {
    const s = this.cachedSessionsById.get(sessionId);
    if (!s) return undefined;
    return typeof s.ownerKey === 'string' && s.ownerKey ? s.ownerKey : undefined;
  }

  async getSubscribers(): Promise<unknown> {
    return this.client.call(HOST_METHOD.getSubscribers);
  }

  async captureBaselineSeq(sessionId: string): Promise<unknown> {
    return this.client.call(HOST_METHOD.captureBaseline, { sessionId });
  }

  async waitReady(sessionId: string, timeoutMs = 15000): Promise<boolean> {
    // The transport budget must exceed the server's own wait, or a slow-but-healthy shell reads
    // as a transport failure. The extra headroom covers the round trip and host-side scheduling.
    const r = await this.client.call<{ ready: boolean }>(HOST_METHOD.waitReady, { sessionId, timeoutMs }, timeoutMs + 5000);
    return r.ready;
  }

  async waitTerminal(input: TerminalWaitInput, signal?: AbortSignal): Promise<TerminalWaitResult> {
    if (signal?.aborted) {
      throw new Error('Terminal wait aborted');
    }
    const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? input.timeoutMs
      : 15000;
    const callPromise = this.client.call<TerminalWaitResult>(
      HOST_METHOD.waitTerminal,
      input as unknown as Record<string, unknown>,
      timeoutMs + 5000,
    );
    if (!signal) return callPromise;
    return new Promise<TerminalWaitResult>((resolve, reject) => {
      const onAbort = (): void => reject(new Error('Terminal wait aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      callPromise.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
        (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
      );
    });
  }

  /** No-op locally: the daemon owns persistence. Kept so call sites need no branch. */
  persistSync(): void {
    this.client.call(HOST_METHOD.persistSync).catch(() => undefined);
  }

  setBridgeEndpoint(endpoint: unknown): void {
    this.client.call(HOST_METHOD.setBridgeEndpoint, { endpoint }).catch(() => undefined);
  }

  async ping(): Promise<{ pong: boolean; pid: number }> {
    return this.client.call<{ pong: boolean; pid: number }>(HOST_METHOD.hostPing);
  }
}
