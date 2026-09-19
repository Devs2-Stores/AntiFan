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
import type { BridgeRequestPayload, BridgeResponsePayload, BridgeEventPayload, TerminalAckPayload } from '../../shared/contracts';

const HOST = '127.0.0.1';
const CALL_TIMEOUT_MS = 15000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;

export interface DaemonEndpoint {
  port: number;
  token: string;
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

  constructor(private readonly endpoint: DaemonEndpoint) {}

  /** Establish the socket and authenticate. Resolves once the upgrade succeeds. */
  connect(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://${HOST}:${this.endpoint.port}/`, {
        headers: { 'x-antifan-token': this.endpoint.token },
      });
      this.ws = ws;

      ws.on('message', (raw) => this.onMessage(raw));
      ws.on('close', () => this.handleSocketClose());
      ws.on('error', () => { /* close follows */ });

      ws.once('open', () => resolve());
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', (err) => reject(err));
    });
    // A failed connect must not poison a later retry.
    this.openPromise.catch(() => { this.openPromise = null; });
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
  private readonly client: DaemonClient;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | undefined;
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

  constructor(endpoint: DaemonEndpoint) {
    super();
    this.client = new DaemonClient(endpoint);
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
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (this.closed) return;
      try {
        await this.connect();
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.emit('reconnected');
        if (this.cachedSessionState) {
          this.emit('session', this.cachedSessionState);
        }
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
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
    clearTimeout(this.reconnectTimer);
    this.client.close();
  }

  /* ---- TerminalManager-shaped surface (async & sync-cached) ---- */

  async startTerminal(cwd?: string): Promise<boolean> {
    // Idempotent on the daemon side: its shell already exists, so this re-establishes cwd and
    // returns the manager's actual answer rather than a fabricated success.
    const r = await this.client.call<{ started: boolean }>(HOST_METHOD.start, { cwd });
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

  write(input: string): boolean {
    this.client.call(HOST_METHOD.input, { text: input }).catch(() => undefined);
    return true;
  }

  writeTo(sessionId: string, input: string): boolean {
    this.client.call(HOST_METHOD.input, { sessionId, text: input }).catch(() => undefined);
    return true;
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

  async createSession(cwd?: string): Promise<string> {
    const r = await this.client.call<{ sessionId: string }>(HOST_METHOD.newSession, { cwd });
    return r.sessionId;
  }

  async createSplitSession(parentId: string, cwd?: string, cols?: number, rows?: number): Promise<string> {
    const r = await this.client.call<{ sessionId: string }>(HOST_METHOD.newSession, { parentId, cwd, cols, rows });
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

  async restart(cwd?: string): Promise<void> {
    await this.client.call(HOST_METHOD.restart, { cwd });
  }

  async sleepSession(sessionId: string): Promise<boolean> {
    const r = await this.client.call<{ slept: boolean }>(HOST_METHOD.sleepSession, { sessionId });
    return r.slept;
  }

  async setCategory(sessionId: string, category?: string): Promise<boolean> {
    const r = await this.client.call<{ ok: boolean }>(HOST_METHOD.setCategory, { sessionId, category });
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
