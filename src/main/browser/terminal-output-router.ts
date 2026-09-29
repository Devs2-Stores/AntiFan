/**
 * O(1) terminal output router.
 *
 * Before this existed, every `NativeTabHost` subscribed its own `data` listener on
 * the shared terminal seam and ran `isSessionVisibleToWindow` for every chunk of
 * every session — O(hosts × chunks) seam calls plus a map scan per chunk. The
 * router keeps exactly ONE `data` listener on the seam (the in-process
 * `TerminalManager` or the `DaemonTerminalProxy` installed over it) and maintains
 * `sessionId → Set<host>`: dispatch is one map lookup.
 *
 * Route maintenance is event-driven, so a steady-state chunk performs ZERO
 * visibility checks:
 *   - `session-created` / `session-restarted` / `session-woken` refresh the one
 *     affected route;
 *   - `session-closed` drops it;
 *   - `session` (the throttled projection push) rebuilds routes only when the
 *     owner/capsule signature changed, which is the only signal an owner
 *     transfer produces;
 *   - hosts call `invalidateRoutes()` when their own scope surface changes
 *     (workspace affiliation, terminal-window binding);
 *   - a `data` chunk for a session the events never announced computes the route
 *     lazily, once, and caches it.
 *
 * Fallback rule (risk: a session with no owner must still reach the Unassigned
 * window): no positive match is needed for the unclaimed path — the host that
 * accepts unclaimed sessions admits it through the same `admitSession` answer the
 * old per-host filter used, so the route lands there exactly as before.
 */
import { EventEmitter } from 'node:events';
import type { TerminalDataPayload } from '../../shared/contracts';
import { TerminalManager } from './terminal-manager';

/**
 * The slice of a window host the router drives. `NativeTabHost` satisfies this
 * structurally — `admitSessionForWindow` is the same scope funnel every other
 * terminal read goes through, so a route can never out-admit the window's own
 * projection.
 */
export interface TerminalRouteHost {
  /** Whether this window presents the session (the routing answer). */
  admitSession(sessionId: string): boolean;
  /** Receive one output chunk for a session this host admitted. */
  handleTerminalDataChunk(payload: TerminalDataPayload): void;
}

/** Session event payloads carry `{ id }`; anything else is ignored. */
function emittedSessionId(arg: unknown): string {
  if (arg && typeof arg === 'object' && 'id' in arg) {
    const id = (arg as Record<string, unknown>).id;
    if (typeof id === 'string' && id) return id;
  }
  return '';
}

export class TerminalOutputRouter {
  private static instance: TerminalOutputRouter | undefined;

  public static getInstance(): TerminalOutputRouter {
    if (!TerminalOutputRouter.instance) {
      TerminalOutputRouter.instance = new TerminalOutputRouter();
    }
    return TerminalOutputRouter.instance;
  }

  /** Test seam: drop the singleton so each suite owns a fresh router. */
  public static resetInstance(): void {
    try { TerminalOutputRouter.instance?.dispose(); } catch {}
    TerminalOutputRouter.instance = undefined;
  }

  private readonly hosts = new Set<TerminalRouteHost>();
  /** sessionId → hosts that present it. Entries are only ever replaced or dropped. */
  private readonly routes = new Map<string, Set<TerminalRouteHost>>();
  private emitter: EventEmitter | null = null;
  private readonly releases: Array<() => void> = [];
  /** id|ownerKey|capsuleId signature of the last `session` push; routing only follows ownership facts. */
  private sessionSignature = '';
  private disposed = false;

  private constructor() {}

  /**
   * Bind the single `data` listener to the terminal seam. Called from index.ts
   * once the definitive manager (daemon proxy or in-process fallback) is
   * installed; re-attach replaces a previous binding rather than stacking.
   */
  public attach(emitter: EventEmitter): void {
    if (this.emitter === emitter) return;
    this.detach();
    this.emitter = emitter;
    this.disposed = false;
    const on = (event: string, handler: Parameters<EventEmitter['on']>[1]): void => {
      emitter.on(event, handler);
      this.releases.push(() => {
        try { emitter.removeListener(event, handler); } catch {}
      });
    };
    on('data', (payload: TerminalDataPayload) => this.dispatchData(payload));
    on('session', () => this.refreshAllRoutesIfSignatureChanged());
    const refreshOne = (arg: unknown): void => {
      const id = emittedSessionId(arg);
      if (id) this.routes.set(id, this.computeRoute(id));
    };
    on('session-created', refreshOne);
    on('session-restarted', refreshOne);
    on('session-woken', refreshOne);
    on('session-closed', (arg: unknown) => {
      const id = emittedSessionId(arg);
      if (id) this.routes.delete(id);
    });
  }

  /** Remove the seam listeners this instance registered (nothing else's). */
  public detach(): void {
    const releases = this.releases.splice(0);
    for (const release of releases) {
      try { release(); } catch {}
    }
    this.emitter = null;
  }

  /**
   * The router attaches lazily too: a host registered before index.ts installed
   * the daemon proxy binds the seam in force at that moment instead of dropping
   * every chunk until boot finishes.
   */
  private ensureAttached(): void {
    if (this.emitter || this.disposed) return;
    try {
      const seam = TerminalManager.getInstance() as unknown;
      if (seam && typeof seam === 'object' && typeof (seam as EventEmitter).on === 'function') {
        this.attach(seam as EventEmitter);
      }
    } catch {}
  }

  /**
   * Register a window host for routed output. Returns the unregister the host
   * must run on dispose; calling it twice is a no-op.
   */
  public registerHost(host: TerminalRouteHost): () => void {
    this.ensureAttached();
    this.hosts.add(host);
    // A host constructed after sessions already exist still owns its routes:
    // its admission answer is computed for every known session, not just the
    // ones created after it arrived.
    this.refreshAllRoutes();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.unregisterHost(host);
    };
  }

  public unregisterHost(host: TerminalRouteHost): void {
    this.hosts.delete(host);
    for (const hosts of this.routes.values()) {
      hosts.delete(host);
    }
    // The last host out leaves no consumer for the seam: detaching here is what
    // makes a disposed host honestly return the manager's listener counts to
    // their pre-registration baseline instead of stranding a global listener
    // nobody will ever route to again. A later registerHost re-attaches through
    // ensureAttached.
    if (this.hosts.size === 0 && !this.disposed) this.detach();
  }

  /**
   * A host's scope surface changed (workspace affiliation, terminal-window
   * binding). Route membership is a function of every host's scope, so all
   * known routes are recomputed — the call is rare, never per chunk.
   */
  public invalidateRoutes(): void {
    this.refreshAllRoutes();
  }

  /** Read-only view for diagnostics/tests: the hosts a session currently routes to. */
  public routedHosts(sessionId: string): ReadonlySet<TerminalRouteHost> | undefined {
    return this.routes.get(sessionId);
  }

  /** How many sessions currently hold a route entry. */
  public get routeCount(): number {
    return this.routes.size;
  }

  /** The one `data` handler: O(1) map lookup, zero visibility checks per chunk. */
  private dispatchData(payload: TerminalDataPayload): void {
    this.ensureAttached();
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId) return;
    let hosts = this.routes.get(sessionId);
    if (!hosts) {
      // A session the seam events never announced (boot race, emitted before
      // the router attached): compute the route once and cache it. Every later
      // chunk for this session is a pure map hit.
      hosts = this.computeRoute(sessionId);
      this.routes.set(sessionId, hosts);
    }
    if (hosts.size === 0) {
      if (process.env.ANTIFAN_DEBUG_ROUTER === '1') {
        console.warn(`[router] session=${sessionId} hosts=${this.hosts.size} route=EMPTY dropped chunk seq=${payload.seq}`);
      }
      return;
    }
    for (const host of hosts) {
      try { host.handleTerminalDataChunk(payload); } catch {}
    }
  }

  private computeRoute(sessionId: string): Set<TerminalRouteHost> {
    const admitted = new Set<TerminalRouteHost>();
    for (const host of this.hosts) {
      try {
        if (host.admitSession(sessionId)) admitted.add(host);
      } catch {}
    }
    return admitted;
  }

  /** Recompute every known route: the union of cached routes and listed sessions. */
  private refreshAllRoutes(): void {
    const sessionIds = new Set<string>(this.routes.keys());
    for (const row of this.sessionRows()) {
      if (typeof row.id === 'string' && row.id) sessionIds.add(row.id);
    }
    if (sessionIds.size === 0) return;
    for (const id of sessionIds) {
      this.routes.set(id, this.computeRoute(id));
    }
  }

  /**
   * The `session` push fires far more often than ownership changes (name,
   * state, activity all emit it). Routes depend only on (id, ownerKey,
   * capsuleId), so the rebuild is skipped unless that signature moved.
   */
  private refreshAllRoutesIfSignatureChanged(): void {
    const parts: string[] = [];
    for (const row of this.sessionRows()) {
      if (typeof row.id !== 'string' || !row.id) continue;
      const owner = typeof row.ownerKey === 'string' ? row.ownerKey : '';
      const capsule = typeof row.capsuleId === 'string' ? row.capsuleId : '';
      parts.push(`${row.id}|${owner}|${capsule}`);
    }
    parts.sort();
    const signature = parts.join(';');
    if (signature === this.sessionSignature) return;
    this.sessionSignature = signature;
    this.refreshAllRoutes();
  }

  /** Session summary rows as generic records; the seam may be the daemon proxy's cached shape. */
  private sessionRows(): Array<Record<string, unknown>> {
    try {
      const seam = TerminalManager.getInstance() as unknown;
      if (!seam || typeof seam !== 'object' || !('listSessions' in seam)) return [];
      const listSessions = (seam as { listSessions?: unknown }).listSessions;
      if (typeof listSessions !== 'function') return [];
      const rows = (listSessions as () => unknown).call(seam);
      if (!Array.isArray(rows)) return [];
      const out: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        if (row && typeof row === 'object') out.push(row as Record<string, unknown>);
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Drop all listeners and state; a disposed router never re-attaches lazily. */
  public dispose(): void {
    this.disposed = true;
    this.detach();
    this.hosts.clear();
    this.routes.clear();
    this.sessionSignature = '';
  }
}
