/**
 * Phase 4 — O(1) terminal output routing.
 *
 * Drives the real `TerminalOutputRouter` against a fake terminal seam: the same
 * EventEmitter contract `TerminalManager`/`DaemonTerminalProxy` expose
 * (`data`, `session`, `session-created`, `session-closed`, …). The asserted
 * invariants are the phase's own:
 *   - a chunk reaches only hosts whose scope admits the session (7 hosts, 1 session);
 *   - popout-bound and Unassigned/manager surfaces still receive output;
 *   - `isSessionVisibleToWindow`-equivalent calls per steady-state chunk = 0;
 *   - host open/close cycles never grow the seam's `data` listener count.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { TerminalOutputRouter, type TerminalRouteHost } from '../../src/main/browser/terminal-output-router';
import type { TerminalDataPayload } from '../../src/shared/contracts';

interface FakeSessionRow {
  id: string;
  ownerKey?: string;
  capsuleId?: string;
}

/** TerminalManager-shaped seam: an emitter plus the session list the router reads. */
class FakeSeam extends EventEmitter {
  public sessions: FakeSessionRow[] = [];

  public listSessions(): FakeSessionRow[] {
    return this.sessions;
  }

  public emitSessionPush(): void {
    this.emit('session', { sessions: this.sessions, activeSessionId: '' });
  }
}

/**
 * A window host double with the production scope rules reduced to what the
 * router consumes: `projectHost` admits its own ownerKey only; `manager`
 * (Unassigned/managerAll) admits every row; `boundTo` models the
 * terminalWindowMeta positive-binding rule for a popout.
 */
class FakeHost implements TerminalRouteHost {
  public received: TerminalDataPayload[] = [];
  public admitCalls = 0;

  constructor(
    public readonly label: string,
    private readonly opts: { ownerKey?: string; managerAll?: boolean; boundTo?: string } = {},
  ) {}

  admitSession(sessionId: string): boolean {
    this.admitCalls += 1;
    if (this.opts.boundTo === sessionId) return true;
    if (this.opts.managerAll) return true;
    const row = seam.sessions.find((s) => s.id === sessionId);
    if (row?.ownerKey !== undefined) return row.ownerKey === this.opts.ownerKey;
    return false;
  }

  handleTerminalDataChunk(payload: TerminalDataPayload): void {
    this.received.push(payload);
  }
}

let seam: FakeSeam;
let router: TerminalOutputRouter;
let originalInstance: unknown;

const chunk = (sessionId: string, seq: number, data = `chunk-${seq}\n`): TerminalDataPayload => ({
  sessionId,
  data,
  seq,
  generation: 1,
});

const emitData = (payload: TerminalDataPayload): void => {
  seam.emit('data', payload);
};

describe('Phase 4 - TerminalOutputRouter', () => {
  beforeEach(() => {
    originalInstance = (TerminalManager as unknown as { instance: unknown }).instance;
    seam = new FakeSeam();
    (TerminalManager as unknown as { instance: unknown }).instance = seam;
    TerminalOutputRouter.resetInstance();
    router = TerminalOutputRouter.getInstance();
    router.attach(seam);
  });

  afterEach(() => {
    try { router.dispose(); } catch {}
    TerminalOutputRouter.resetInstance();
    (TerminalManager as unknown as { instance: unknown }).instance = originalInstance;
  });

  it('7 hosts 1 session: only the owning host receives each chunk', () => {
    seam.sessions = [{ id: 's-1', ownerKey: 'project:alpha' }];
    const owner = new FakeHost('owner', { ownerKey: 'project:alpha' });
    const others = Array.from({ length: 6 }, (_v, i) => new FakeHost(`other-${i}`, { ownerKey: `project:o${i}` }));
    for (const host of [owner, ...others]) router.registerHost(host);
    seam.emitSessionPush();

    const dataCount = seam.listenerCount('data');
    emitData(chunk('s-1', 1));
    emitData(chunk('s-1', 2));

    assert.strictEqual(owner.received.length, 2, 'owning host must receive every chunk');
    for (const host of others) {
      assert.strictEqual(host.received.length, 0, `${host.label} must not receive a foreign session's output`);
    }
    assert.strictEqual(dataCount, 1, 'exactly one data listener serves every host');
  });

  it('zero admission calls per steady-state chunk after warm-up', () => {
    seam.sessions = [{ id: 's-1', ownerKey: 'project:alpha' }];
    const owner = new FakeHost('owner', { ownerKey: 'project:alpha' });
    const other = new FakeHost('other', { ownerKey: 'project:beta' });
    router.registerHost(owner);
    router.registerHost(other);
    seam.emitSessionPush();

    const baseline = owner.admitCalls + other.admitCalls;
    for (let seq = 1; seq <= 50; seq++) emitData(chunk('s-1', seq));
    assert.strictEqual(
      owner.admitCalls + other.admitCalls,
      baseline,
      'routed chunks must be pure map hits — no per-chunk visibility computation',
    );
    assert.strictEqual(owner.received.length, 50);
  });

  it('first chunk of an unannounced session computes the route once, then never again', () => {
    // A session that produced output before any session push announced it (boot race).
    const owner = new FakeHost('owner', { ownerKey: 'project:alpha' });
    router.registerHost(owner);
    seam.sessions = [{ id: 's-late', ownerKey: 'project:alpha' }];

    emitData(chunk('s-late', 1));
    const afterFirst = owner.admitCalls;
    assert.strictEqual(afterFirst, 1, 'route miss computes admission exactly once');
    emitData(chunk('s-late', 2));
    emitData(chunk('s-late', 3));
    assert.strictEqual(owner.admitCalls, afterFirst, 'subsequent chunks reuse the cached route');
    assert.strictEqual(owner.received.length, 3);
  });

  it('popout-bound session reaches the popout host and unassigned output reaches the manager', () => {
    seam.sessions = [
      { id: 's-pop', ownerKey: 'project:alpha' },
      { id: 's-free' },
      { id: 's-agent', ownerKey: 'agent:tab-9' },
    ];
    const projectHost = new FakeHost('project', { ownerKey: 'project:alpha' });
    const popoutHost = new FakeHost('popout', { ownerKey: 'project:beta', boundTo: 's-pop' });
    const manager = new FakeHost('manager', { managerAll: true });
    for (const host of [projectHost, popoutHost, manager]) router.registerHost(host);
    seam.emitSessionPush();

    emitData(chunk('s-pop', 1));
    assert.strictEqual(popoutHost.received.length, 1, 'popout must receive its bound session even outside its own scope');
    assert.strictEqual(projectHost.received.length, 1, 'the owning window still receives it');

    emitData(chunk('s-free', 1));
    assert.deepStrictEqual(
      [projectHost, popoutHost, manager].map((h) => h.received.filter((p) => p.sessionId === 's-free').length),
      [0, 0, 1],
      'a session no window owns must still reach the Unassigned/manager window',
    );

    emitData(chunk('s-agent', 1));
    assert.deepStrictEqual(
      [projectHost, popoutHost, manager].map((h) => h.received.filter((p) => p.sessionId === 's-agent').length),
      [0, 0, 1],
      'agent-owned output belongs to the shared manager alone',
    );
  });

  it('owner transfer re-routes the session on the next session push', () => {
    seam.sessions = [{ id: 's-1', ownerKey: 'project:alpha' }];
    const alpha = new FakeHost('alpha', { ownerKey: 'project:alpha' });
    const beta = new FakeHost('beta', { ownerKey: 'project:beta' });
    router.registerHost(alpha);
    router.registerHost(beta);
    seam.emitSessionPush();
    emitData(chunk('s-1', 1));
    assert.strictEqual(alpha.received.length, 1);
    assert.strictEqual(beta.received.length, 0);

    seam.sessions = [{ id: 's-1', ownerKey: 'project:beta' }];
    seam.emitSessionPush();
    emitData(chunk('s-1', 2));

    assert.strictEqual(alpha.received.length, 1, 'old owner stops receiving after the transfer');
    assert.strictEqual(beta.received.length, 1, 'new owner receives after the transfer');
  });

  it('session push with unchanged ownership does not recompute routes', () => {
    seam.sessions = [{ id: 's-1', ownerKey: 'project:alpha' }];
    const owner = new FakeHost('owner', { ownerKey: 'project:alpha' });
    router.registerHost(owner);
    seam.emitSessionPush();
    const baseline = owner.admitCalls;
    // Name/state churn emits the same projection facts; the signature gate skips it.
    seam.emitSessionPush();
    seam.emitSessionPush();
    assert.strictEqual(owner.admitCalls, baseline, 'unchanged owner/capsule signature must not recompute');
  });

  it('20 register/unregister cycles keep the seam listener counts flat, and detach when idle', () => {
    const spawn = () => new FakeHost('h', { ownerKey: 'project:alpha' });
    // Detach-on-empty: the moment the last host unregisters the router hands the
    // seam listeners back, so a window's dispose returns the manager to whatever
    // it had before that host ever registered (0 here — only the router listens).
    // baseline counts the router's own listeners (beforeEach attaches it): after
    // the last host releases, detach-on-empty returns the seam to nothing.
    const baseline = seam.listenerCount('data');
    assert.strictEqual(baseline, 1, 'only the router listens on this seam');
    for (let i = 0; i < 20; i++) {
      const release = router.registerHost(spawn());
      emitData(chunk('s-1', i + 1));
      release();
      assert.strictEqual(seam.listenerCount('data'), 0, `cycle ${i}: release detached the seam listeners`);
    }
    assert.strictEqual(seam.listenerCount('session'), 0, 'no orphaned session listener either');
    // Re-attach is lazy on the next register: a closed host still gets nothing,
    // but the new host resumes routing with exactly one seam listener.
    const host = spawn();
    const release = router.registerHost(host);
    assert.strictEqual(seam.listenerCount('data'), 1, 'the first host re-attaches the seam');
    seam.sessions = [{ id: 's-1', ownerKey: 'project:alpha' }];
    seam.emitSessionPush();
    emitData(chunk('s-1', 1));
    release();
    emitData(chunk('s-1', 2));
    assert.strictEqual(host.received.length, 1, 'unregistered host receives nothing after release');
    assert.strictEqual(seam.listenerCount('data'), 0, 'and the seam goes quiet again');
  });

  it('host registering after sessions exist still receives pre-existing session output', () => {
    seam.sessions = [{ id: 's-old', ownerKey: 'project:alpha' }];
    seam.emitSessionPush();
    const late = new FakeHost('late', { ownerKey: 'project:alpha' });
    router.registerHost(late);
    emitData(chunk('s-old', 1));
    assert.strictEqual(late.received.length, 1, 'register refreshes routes for sessions created before the host');
  });
});
