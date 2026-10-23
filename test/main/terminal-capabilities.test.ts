import { describe, it, before, after, mock } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionDeliveryJournal, TerminalManager, DEFAULT_TERMINAL_CAPSULE_ID } from '../../src/main/browser/terminal-manager';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import {
  registerTerminalCapabilities,
  resolveHomeBaseTerminal,
  isLiveSplitOf,
  type TerminalOwnershipPort,
} from '../../src/main/tools/terminal-capabilities';
import {
  CapabilityError,
  issueRuntimeLease,
  makeControlPlaneId,
  RuntimeLease,
  TerminalWaitResult,
} from '../../src/shared/control-plane-contracts';

/**
 * Data-safety isolation. This suite drives the REAL `TerminalManager`
 * singleton (it stubs only `spawn`), and the manager persists
 * `terminal-sessions.json` into `ANTIFAN_CONFIG_DIR` — falling back to the
 * live user config directory when that variable is unset. Without this
 * redirect the suite overwrites the developer's actual terminal sessions on
 * every run. Empirically verified: with the redirect the scratch directory
 * receives `terminal-sessions.json` and the live file's mtime does not move.
 * Same convention as test/main/terminal-sleep-affinity-host.test.ts.
 */
const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-terminal-capabilities-'));
const PREVIOUS_CONFIG_DIR = process.env.ANTIFAN_CONFIG_DIR;
process.env.ANTIFAN_CONFIG_DIR = path.join(SCRATCH_DIR, 'config');
fs.mkdirSync(process.env.ANTIFAN_CONFIG_DIR, { recursive: true });

describe('Terminal Capabilities, Generation Tracking & Wait Lifecycle (Phase 04)', () => {
  let terminalManager: TerminalManager;
  let catalogue: CapabilityCatalogue;
  let projectId: string;
  let workspaceId: string;
  let lease: RuntimeLease;
  let originalSpawn: any;

  before(() => {
    projectId = makeControlPlaneId('project');
    workspaceId = makeControlPlaneId('workspace');
    lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);
    terminalManager = TerminalManager.getInstance();
    originalSpawn = (terminalManager as any).spawn.bind(terminalManager);
    (terminalManager as any).spawn = function (
      id: string,
      cwd: string,
      restoredBuffer = '',
      initialCols?: number,
      initialRows?: number,
      minimumRows = 4
    ) {
      const cols = Math.max(40, initialCols || (terminalManager as any).lastCols || 120);
      const rows = Math.max(minimumRows, initialRows || (terminalManager as any).lastRows || 30);
      const generation = ((terminalManager as any).sessionGenerations.get(id) || 0) + 1;
      (terminalManager as any).sessionGenerations.set(id, generation);
      const mockPty = {
        pid: undefined,
        cols,
        rows,
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
        kill: () => {},
        write: (data: string) => {
          s.buffer += data;
          s.lastSeq = (s.lastSeq || 0) + 1;
          s.deliveryJournal.append(s.sessionGeneration, s.lastSeq, data, Buffer.byteLength(data, 'utf8'));
          terminalManager.emit('data', { sessionId: id, data, seq: s.lastSeq });
        },
        resize: (newCols: number, newRows: number) => {
          mockPty.cols = newCols;
          mockPty.rows = newRows;
        },
      };
      const s = {
        id,
        name: `Terminal ${id.replace('terminal-', '')}`,
        cwd: cwd || 'E:/Work/project',
        pty: mockPty,
        buffer: restoredBuffer || '',
        capsuleId: (terminalManager as any).currentCapsuleId || 'default',
        disposed: false,
        lastSeq: 0,
        sessionGeneration: generation,
        state: 'running' as const,
        deliveryJournal: new SessionDeliveryJournal(),
      };
      (terminalManager as any).sessions.set(id, s);
      return s;
    };
    catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });
    registerTerminalCapabilities(catalogue, terminalManager);
  });

  after(async () => {
    try {
      await terminalManager.dispose();
      (terminalManager as any).spawn = originalSpawn;
      (TerminalManager as any).instance = undefined;
    } catch {}
    // Restore the config-dir pointer and drop the scratch state so this suite
    // leaves no trace in (and takes nothing from) the live user config dir.
    if (PREVIOUS_CONFIG_DIR === undefined) delete process.env.ANTIFAN_CONFIG_DIR;
    else process.env.ANTIFAN_CONFIG_DIR = PREVIOUS_CONFIG_DIR;
    try {
      fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('1. Spawns terminal session with initial sessionGeneration 1 and structured state', () => {
    const sessionId = terminalManager.createSession();
    assert.ok(sessionId.startsWith('terminal-'));

    const session = terminalManager.getSession(sessionId);
    assert.ok(session);
    assert.strictEqual(session?.sessionGeneration, 1);
    assert.strictEqual(session?.state, 'running');

    const summaries = terminalManager.listSessions();
    const summary = summaries.find((s) => s.id === sessionId);
    assert.ok(summary);
    assert.strictEqual(summary?.sessionGeneration, 1);
    assert.strictEqual(summary?.state, 'running');
  });

  it('2. Dispatches terminal.write and terminal.resize through catalogue policy', async () => {
    const sessionId = terminalManager.getActiveSessionId() || terminalManager.createSession();

    const writeRes = (await catalogue.dispatch(
      'terminal.write',
      { sessionId, input: 'echo "hello from test"\r\n' },
      { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' }
    )) as { written: boolean };
    assert.strictEqual(writeRes.written, true);

    const resizeRes = (await catalogue.dispatch(
      'terminal.resize',
      { sessionId, cols: 100, rows: 24 },
      { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' }
    )) as { resized: boolean };
    assert.strictEqual(resizeRes.resized, true);
  });

  it('3. Increments sessionGeneration on session restart', async () => {
    const sessionId = terminalManager.getActiveSessionId();
    assert.ok(sessionId);

    const beforeSession = terminalManager.getSession(sessionId);
    const beforeGen = beforeSession?.sessionGeneration ?? 1;

    await terminalManager.restart();

    const afterSession = terminalManager.getSession(sessionId);
    assert.ok(afterSession);
    assert.strictEqual(afterSession?.sessionGeneration, beforeGen + 1);
  });

  it('4. Rejects terminal.wait when sessionGeneration does not match active incarnation', async () => {
    const sessionId = terminalManager.getActiveSessionId();
    assert.ok(sessionId);

    await assert.rejects(
      () =>
        catalogue.dispatch(
          'terminal.wait',
          {
            sessionId,
            condition: 'output-match',
            pattern: 'test-pattern',
            sessionGeneration: 99999, // Stale generation
          },
          { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'read' }
        ),
      (err: unknown) => err instanceof CapabilityError && err.code === 'SESSION_STALE'
    );
  });

  it('5. Resolves terminal.wait output-match fast path if pattern already present in buffer', async () => {
    const sessionId = terminalManager.getActiveSessionId();
    assert.ok(sessionId);
    const session = terminalManager.getSession(sessionId);
    assert.ok(session);

    // Ensure session buffer contains marker to exercise the already-buffered fast path
    const marker = 'FAST_PATH_MARKER_12345';
    session.buffer += `\r\n${marker}\r\n`;

    const waitRes = (await catalogue.dispatch(
      'terminal.wait',
      {
        sessionId,
        condition: 'output-match',
        pattern: 'FAST_PATH_MARKER_12345',
        sessionGeneration: session?.sessionGeneration,
        timeoutMs: 2000,
      },
      { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'read' }
    )) as TerminalWaitResult;
    assert.strictEqual(waitRes.satisfied, true);
    assert.strictEqual(waitRes.sessionGeneration, session?.sessionGeneration);
  });

  it('5b. Resolves terminal.wait with afterSeq when the matching chunk already arrived after that seq', async () => {
    const sessionId = terminalManager.getActiveSessionId();
    assert.ok(sessionId);
    const session = terminalManager.getSession(sessionId);
    assert.ok(session);

    // Caller observed lastSeq, then output landed before the wait was issued:
    // the data event for it has already fired, so only the journal can prove it.
    const afterSeq = session.lastSeq || 0;
    // The stub pty's write() is the only path that advances seq and the journal here.
    assert.ok(session.pty);
    session.pty.write('\r\nSynced » update config/settings_data.json\r\n');
    assert.ok((session.lastSeq || 0) > afterSeq);

    const waitRes = (await catalogue.dispatch(
      'terminal.wait',
      {
        sessionId,
        condition: 'output-match',
        pattern: 'Synced » update config/settings_data\\.json',
        afterSeq,
        timeoutMs: 500,
      },
      { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'read' }
    )) as TerminalWaitResult;
    assert.strictEqual(waitRes.satisfied, true);
    assert.ok(waitRes.lastSeq > afterSeq);

    // Output that arrived at or before afterSeq must still NOT satisfy the wait.
    await assert.rejects(
      () =>
        catalogue.dispatch(
          'terminal.wait',
          {
            sessionId,
            condition: 'output-match',
            pattern: 'Synced » update config/settings_data\\.json',
            afterSeq: session.lastSeq,
            timeoutMs: 120,
          },
          { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'read' }
        ),
      (err: unknown) => err instanceof CapabilityError && err.code === 'WAIT_TIMEOUT'
    );
  });

  it('6. Times out on unsatisfied terminal.wait and clears all listeners', async () => {
    const sessionId = terminalManager.getActiveSessionId();
    assert.ok(sessionId);

    await assert.rejects(
      () =>
        catalogue.dispatch(
          'terminal.wait',
          {
            sessionId,
            condition: 'output-match',
            pattern: 'NON_EXISTENT_MARKER_NEVER_EMITTED',
            timeoutMs: 150,
          },
          { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'read' }
        ),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'WAIT_TIMEOUT');
        // The caller learns where the session stood when the deadline passed.
        assert.strictEqual(err.details?.sessionId, sessionId);
        assert.strictEqual(typeof err.details?.outputTail, 'string');
        assert.strictEqual(typeof err.details?.lastSeq, 'number');
        assert.strictEqual(typeof err.details?.sessionGeneration, 'number');
        return true;
      }
    );
  });

  it('7. Aborts terminal.wait when AbortSignal fires', async () => {
    const sessionId = terminalManager.getActiveSessionId();
    assert.ok(sessionId);

    const controller = new AbortController();
    setImmediate(() => controller.abort());

    await assert.rejects(
      () =>
        catalogue.dispatch(
          'terminal.wait',
          {
            sessionId,
            condition: 'output-match',
            pattern: 'NEVER_EMITTED_ABORT_TEST',
            timeoutMs: 5000,
          },
          {
            lease,
            leaseToken: lease.token,
            projectId,
            workspaceId,
            grant: 'read',
            signal: controller.signal,
          }
        ),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual(err.code, 'WAIT_ABORTED');
        assert.strictEqual(err.details?.sessionId, sessionId);
        assert.strictEqual(typeof err.details?.outputTail, 'string');
        assert.strictEqual(typeof err.details?.lastSeq, 'number');
        assert.strictEqual(typeof err.details?.sessionGeneration, 'number');
        return true;
      }
    );
  });

  it('8. Returns a string session id when the canonical terminal instance is the async daemon facade', async () => {
    // Regression: the composition root may install DaemonTerminalProxy as the canonical
    // TerminalManager, whose same-named methods are ASYNC. terminal.create used to place the
    // returned Promise inside its result object, so the wire answer was `{"sessionId":{}}` and
    // the caller never received the id of the terminal it had just created — which is how an
    // agent ends up addressing terminals by scanning every other project's sessions.
    const created: Array<{ cwd?: string; parentId?: string }> = [];
    const buildCatalogue = (instance: TerminalManager) => {
      const c = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId,
        workspaceId,
        runtimeId: lease.runtimeId,
        hostEpoch: 1,
        getActiveLease: () => lease,
      });
      registerTerminalCapabilities(c, instance);
      return c;
    };
    const context = { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' as const };

    const facade = {
      createSession: async (cwd?: string) => {
        created.push({ cwd });
        return 'terminal-77';
      },
      createSplitSession: async (parentId: string, cwd?: string) => {
        created.push({ parentId, cwd });
        return 'terminal-78';
      },
      listSessions: () => [],
      getActiveSessionId: () => '',
    } as unknown as TerminalManager;
    const facadeCatalogue = buildCatalogue(facade);

    const base = (await facadeCatalogue.dispatch('terminal.create', { cwd: 'E:/Work/project-target' }, context)) as {
      sessionId: unknown;
    };
    assert.strictEqual(typeof base.sessionId, 'string', 'the result must carry a string id, never a Promise');
    assert.strictEqual(base.sessionId, 'terminal-77');
    assert.deepStrictEqual(created[0], { cwd: 'E:/Work/project-target' });

    const split = (await facadeCatalogue.dispatch('terminal.create', { parentId: 'terminal-77' }, context)) as {
      sessionId: unknown;
    };
    assert.strictEqual(split.sessionId, 'terminal-78');
    assert.deepStrictEqual(created[1], { parentId: 'terminal-77', cwd: undefined });

    // An unusable parent is reported as a refusal, never as an empty handle: `''` resolves to
    // no session, so returning it as `sessionId` would hand back a target that cannot be used.
    const refusing = {
      createSession: async () => '',
      createSplitSession: async () => '',
      listSessions: () => [],
      getActiveSessionId: () => '',
    } as unknown as TerminalManager;
    await assert.rejects(
      () => buildCatalogue(refusing).dispatch('terminal.create', { parentId: 'terminal-missing' }, context),
      (err: unknown) => err instanceof CapabilityError && err.code === 'EXECUTION_ERROR'
    );
  });

  interface FakeRow {
    id: string;
    cwd: string;
    state: string;
    ownerKey?: string;
    splitOf?: string;
    disposed?: boolean;
    role?: string;
    spaceTerminalId?: string;
  }
  interface SplitCreateCall {
    parentId: string;
    cwd?: string;
    ownerKey?: unknown;
  }
  interface ScenarioOptions {
    rows: FakeRow[];
    /** attachmentId → bound tab. */
    tabs: Record<string, string>;
    /** attachmentId → the terminal the host/registry names as that attachment's home. */
    homes: Record<string, string | undefined>;
    liveTabs?: string[];
    activeId?: string;
    createSplit?: (parentId: string) => Promise<string>;
  }

  const attachmentContext = (attachmentId: string) => ({
    attachmentId,
    runId: 'run-scope',
    attemptId: 'attempt-scope',
    projectId,
    workspaceId,
    backendId: 'backend-scope',
    hostEpoch: 1,
    invocationId: 'invocation-scope',
    lease,
    leaseToken: lease.token,
    grant: 'write' as const,
  });
  const unboundContext = () => ({ lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' as const });
  const newCatalogue = () => new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId,
    workspaceId,
    runtimeId: lease.runtimeId,
    hostEpoch: 1,
    getActiveLease: () => lease,
  });
  const homeRows = (): FakeRow[] => [
    { id: 'terminal-home', cwd: 'E:/Work/home', state: 'running', ownerKey: 'project:p1' },
    { id: 'split-user', cwd: 'E:/Work/home', state: 'running', ownerKey: 'project:p1', splitOf: 'terminal-home' },
    { id: 'split-hrv', cwd: 'E:/Work/home/Haravan', state: 'running', ownerKey: 'project:p1', splitOf: 'terminal-home', role: 'sync', spaceTerminalId: 'haravan' },
    { id: 'split-sapo', cwd: 'E:/Work/home/Sapo', state: 'running', ownerKey: 'project:p1', splitOf: 'terminal-home', role: 'sync', spaceTerminalId: 'sapo' },
    { id: 'terminal-other', cwd: 'E:/Work/other', state: 'running', ownerKey: 'project:p2' },
    { id: 'split-other', cwd: 'E:/Work/other', state: 'running', ownerKey: 'project:p2', splitOf: 'terminal-other' },
    { id: 'terminal-agent-other', cwd: 'E:/Work/elsewhere', state: 'running', ownerKey: 'agent:tab-other' },
  ];

  /** The capability surface over an in-memory terminal manager and the production reach predicate. */
  const buildScenario = (options: ScenarioOptions) => {
    const rows = options.rows;
    const calls = {
      writes: [] as Array<{ sessionId: string; input: string }>,
      resizes: [] as string[],
      closedSplits: [] as string[],
      closedBases: [] as string[],
      splitCreates: [] as SplitCreateCall[],
      baseCreates: 0,
    };
    let nextSplit = 1;
    const facade = {
      listSessions: () => rows.map((row) => ({ ...row })),
      getSession: (id: string) => rows.find((row) => row.id === id),
      getActiveSessionId: () => options.activeId ?? '',
      writeTo: async (sessionId: string, input: string) => {
        calls.writes.push({ sessionId, input });
        return true;
      },
      resizeTo: (sessionId: string) => {
        calls.resizes.push(sessionId);
      },
      waitTerminal: async (params: { sessionId: string }) => ({ satisfied: true, sessionId: params.sessionId }),
      closeSplitSession: async (id: string) => {
        calls.closedSplits.push(id);
        const index = rows.findIndex((row) => row.id === id);
        if (index >= 0) rows.splice(index, 1);
        return true;
      },
      closeSession: async (id: string) => {
        calls.closedBases.push(id);
        return true;
      },
      createSplitSession: async (parentId: string, cwd?: string, _cols?: number, _rows?: number, meta?: { ownerKey?: unknown }) => {
        calls.splitCreates.push({ parentId, cwd, ownerKey: meta?.ownerKey });
        if (options.createSplit) return options.createSplit(parentId);
        const id = `split-new-${nextSplit++}`;
        rows.push({ id, cwd: cwd ?? 'E:/Work/home', state: 'running', splitOf: parentId, ownerKey: typeof meta?.ownerKey === 'string' ? meta.ownerKey : undefined });
        return id;
      },
      createSession: async () => {
        calls.baseCreates++;
        return 'terminal-base-new';
      },
    } as unknown as TerminalManager;
    const ownership: TerminalOwnershipPort = {
      ownerTabId: (attachmentId) => options.tabs[attachmentId],
      homeTerminalId: (attachmentId) => resolveHomeBaseTerminal(facade, [options.homes[attachmentId]]),
      isHomeSplit: (homeId, terminalId) => isLiveSplitOf(facade, homeId, terminalId),
      tabAffiliation: (tabId) => ({ live: (options.liveTabs ?? Object.values(options.tabs)).includes(tabId) }),
    };
    const scoped = newCatalogue();
    registerTerminalCapabilities(scoped, facade, ownership);
    return { rows, calls, facade, scoped };
  };
  const forbidden = (err: unknown): boolean => err instanceof CapabilityError && err.code === 'TERMINAL_FORBIDDEN';

  it('9. An attachment sees and drives only the split panes of its home terminal, never the home shell or any other terminal', async () => {
    const { calls, scoped } = buildScenario({
      rows: homeRows(),
      tabs: { 'att-mine': 'tab-mine' },
      homes: { 'att-mine': 'terminal-home' },
      activeId: 'terminal-other',
    });
    const ctx = attachmentContext('att-mine');

    const listed = (await scoped.dispatch('terminal.list', {}, ctx)) as {
      sessions: Array<{ id: string; owned: boolean }>;
      activeSessionId: string;
      omittedOutOfScopeTerminals?: number;
    };
    assert.deepStrictEqual(listed.sessions.map((s) => s.id), ['split-user', 'split-hrv', 'split-sapo'], 'the user split and both Space splits, nothing else');
    assert.ok(listed.sessions.every((s) => s.owned === true));
    assert.strictEqual(listed.omittedOutOfScopeTerminals, 4, 'home, the other base, its split and the foreign agent shell are omitted and counted');
    assert.strictEqual(listed.activeSessionId, 'split-user', 'the process-wide active id names a terminal outside the scope and is never echoed');

    // Two Space splits (role sync, spaceTerminalId) under home are fully reachable.
    for (const pane of ['split-hrv', 'split-sapo']) {
      await scoped.dispatch('terminal.write', { sessionId: pane, input: `echo ${pane}\r\n` }, ctx);
      await scoped.dispatch('terminal.resize', { sessionId: pane, cols: 100, rows: 30 }, ctx);
      const waited = (await scoped.dispatch('terminal.wait', { sessionId: pane, condition: 'exit', timeoutMs: 50 }, ctx)) as TerminalWaitResult & { sessionId?: string };
      assert.strictEqual(waited.satisfied, true);
    }
    assert.deepStrictEqual(calls.writes.map((w) => w.sessionId), ['split-hrv', 'split-sapo']);
    assert.deepStrictEqual(calls.resizes, ['split-hrv', 'split-sapo']);
    assert.strictEqual((await scoped.dispatch('terminal.close', { sessionId: 'split-sapo' }, ctx) as { closed: boolean }).closed, true);
    assert.deepStrictEqual(calls.closedSplits, ['split-sapo'], 'a bound close always closes exactly that pane as a split');
    assert.deepStrictEqual(calls.closedBases, []);

    // The home shell the agent runs in is refused for every operation, so it can never type into its own prompt.
    for (const op of [
      () => scoped.dispatch('terminal.write', { sessionId: 'terminal-home', input: 'x\r\n' }, ctx),
      () => scoped.dispatch('terminal.resize', { sessionId: 'terminal-home', cols: 80, rows: 24 }, ctx),
      () => scoped.dispatch('terminal.wait', { sessionId: 'terminal-home', condition: 'exit', timeoutMs: 50 }, ctx),
      () => scoped.dispatch('terminal.close', { sessionId: 'terminal-home' }, ctx),
    ]) {
      await assert.rejects(op, (err: unknown) => forbidden(err) && /home terminal/.test((err as CapabilityError).message));
    }
    // Other bases, panes of other bases and another attachment's agent shell are refused as out of scope.
    for (const foreign of ['terminal-other', 'split-other', 'terminal-agent-other', 'terminal-missing']) {
      await assert.rejects(() => scoped.dispatch('terminal.write', { sessionId: foreign, input: 'x\r\n' }, ctx), forbidden, foreign);
      await assert.rejects(() => scoped.dispatch('terminal.wait', { sessionId: foreign, condition: 'exit', timeoutMs: 50 }, ctx), forbidden, foreign);
      await assert.rejects(() => scoped.dispatch('terminal.resize', { sessionId: foreign, cols: 80, rows: 24 }, ctx), forbidden, foreign);
      await assert.rejects(() => scoped.dispatch('terminal.close', { sessionId: foreign }, ctx), forbidden, foreign);
    }
    assert.strictEqual(calls.writes.length, 2, 'a refused write must never reach the PTY');
    assert.deepStrictEqual(calls.closedSplits, ['split-sapo'], 'a refused close must not close anything');
  });

  it('9b. A caller with no attachment keeps its unscoped reach', async () => {
    const { calls, scoped } = buildScenario({ rows: homeRows(), tabs: {}, homes: {} });
    const listed = (await scoped.dispatch('terminal.list', {}, unboundContext())) as { sessions: Array<{ id: string; owned: boolean }> };
    assert.strictEqual(listed.sessions.length, 7);
    assert.ok(listed.sessions.every((s) => s.owned === true));
    await scoped.dispatch('terminal.write', { sessionId: 'terminal-other', input: 'x' }, unboundContext());
    assert.deepStrictEqual(calls.writes.map((w) => w.sessionId), ['terminal-other']);
  });

  it('10. A disposed or closed pane is unreachable and a split that is not under the home is never reachable', async () => {
    const rows = homeRows();
    rows.find((r) => r.id === 'split-user')!.disposed = true;
    rows.find((r) => r.id === 'split-sapo')!.state = 'closed';
    const { scoped } = buildScenario({ rows, tabs: { 'att-mine': 'tab-mine' }, homes: { 'att-mine': 'terminal-home' } });
    const listed = (await scoped.dispatch('terminal.list', {}, attachmentContext('att-mine'))) as { sessions: Array<{ id: string }> };
    assert.deepStrictEqual(listed.sessions.map((s) => s.id), ['split-hrv']);
    await assert.rejects(() => scoped.dispatch('terminal.write', { sessionId: 'split-user', input: 'x' }, attachmentContext('att-mine')), forbidden);
  });

  it('11. An attachment whose home is a split resolves to the parent, and one with no live home gets an explicit error', async () => {
    // The tab names a split as its terminal: the home is the base it is split off.
    const viaSplit = buildScenario({ rows: homeRows(), tabs: { 'att-mine': 'tab-mine' }, homes: { 'att-mine': 'split-user' } });
    const listed = (await viaSplit.scoped.dispatch('terminal.list', {}, attachmentContext('att-mine'))) as { sessions: Array<{ id: string }> };
    assert.deepStrictEqual(listed.sessions.map((s) => s.id), ['split-user', 'split-hrv', 'split-sapo']);
    await assert.rejects(() => viaSplit.scoped.dispatch('terminal.write', { sessionId: 'terminal-home', input: 'x' }, attachmentContext('att-mine')), forbidden);

    // No home: never an empty list, always an actionable refusal; nothing is created.
    const homeless = buildScenario({
      rows: homeRows(),
      tabs: { 'att-none': 'tab-none', 'att-gone': 'tab-gone' },
      homes: { 'att-none': undefined, 'att-gone': 'terminal-closed-long-ago' },
    });
    for (const attachmentId of ['att-none', 'att-gone']) {
      const ctx = attachmentContext(attachmentId);
      const noHome = (err: unknown): boolean => forbidden(err) && /no home terminal/.test((err as CapabilityError).message);
      await assert.rejects(() => homeless.scoped.dispatch('terminal.list', {}, ctx), noHome);
      await assert.rejects(() => homeless.scoped.dispatch('terminal.write', { sessionId: 'split-user', input: 'x' }, ctx), noHome);
      await assert.rejects(() => homeless.scoped.dispatch('terminal.wait', { sessionId: 'split-user', condition: 'exit', timeoutMs: 50 }, ctx), noHome);
      await assert.rejects(() => homeless.scoped.dispatch('terminal.create', { cwd: 'E:/Work/x' }, ctx), noHome);
    }
    assert.deepStrictEqual(homeless.calls.splitCreates, []);
    assert.strictEqual(homeless.calls.baseCreates, 0);
    assert.deepStrictEqual(homeless.calls.writes, []);

    // A caller whose bound tab cannot be resolved is refused rather than allowed unverified.
    await assert.rejects(
      () => homeless.scoped.dispatch('terminal.write', { sessionId: 'split-user', input: 'x' }, attachmentContext('att-unknown')),
      forbidden
    );
    // A runtime wired without host authority cannot verify scope at all.
    const unwired = newCatalogue();
    registerTerminalCapabilities(unwired, buildScenario({ rows: homeRows(), tabs: {}, homes: {} }).facade);
    await assert.rejects(() => unwired.dispatch('terminal.write', { sessionId: 'split-user', input: 'x' }, attachmentContext('att-mine')), forbidden);
  });

  it('12. terminal.create always mints a NEW split under the home, stamped with the agent key, even beside the user\'s own split', async () => {
    const { rows, calls, scoped } = buildScenario({
      rows: homeRows(),
      tabs: { 'att-mine': 'tab-mine' },
      homes: { 'att-mine': 'terminal-home' },
    });
    const ctx = attachmentContext('att-mine');
    type CreateResult = { sessionId: string; ownerBound?: boolean; reused?: boolean };

    const first = (await scoped.dispatch('terminal.create', { cwd: 'E:/Work/home/tools' }, ctx)) as CreateResult;
    assert.strictEqual(first.sessionId, 'split-new-1');
    assert.notStrictEqual(first.sessionId, 'split-user', 'the user\'s manual split is never handed back');
    assert.strictEqual(first.ownerBound, true);
    assert.deepStrictEqual(calls.splitCreates, [{ parentId: 'terminal-home', cwd: 'E:/Work/home/tools', ownerKey: 'agent:tab-mine' }]);
    const second = (await scoped.dispatch('terminal.create', {}, ctx)) as CreateResult;
    assert.strictEqual(second.sessionId, 'split-new-2', 'every call is a new pane');
    assert.strictEqual(calls.baseCreates, 0, 'an agent never creates a base shell');

    // The pane is immediately inside the agent's scope.
    const listed = (await scoped.dispatch('terminal.list', {}, ctx)) as { sessions: Array<{ id: string }> };
    assert.deepStrictEqual(listed.sessions.map((s) => s.id), ['split-user', 'split-hrv', 'split-sapo', 'split-new-1', 'split-new-2']);
    await scoped.dispatch('terminal.write', { sessionId: first.sessionId, input: 'ls\r\n' }, ctx);
    assert.ok(rows.some((r) => r.id === 'split-new-1' && r.ownerKey === 'agent:tab-mine'));

    // A parent other than the home is refused before anything is minted; naming the home is fine.
    for (const parentId of ['terminal-other', 'split-user']) {
      await assert.rejects(() => scoped.dispatch('terminal.create', { parentId }, ctx), (err: unknown) => forbidden(err) && /always adds a split under your own terminal/.test((err as CapabilityError).message));
    }
    assert.strictEqual(calls.splitCreates.length, 2, 'a refused create must leave no session behind');
    const named = (await scoped.dispatch('terminal.create', { parentId: 'terminal-home' }, ctx)) as CreateResult;
    assert.strictEqual(named.sessionId, 'split-new-3');
  });

  it('13. An empty id from the manager is a refusal, and a dead bound tab is refused before a pane exists', async () => {
    const refusing = buildScenario({
      rows: homeRows(),
      tabs: { 'att-mine': 'tab-mine' },
      homes: { 'att-mine': 'terminal-home' },
      createSplit: async () => '',
    });
    await assert.rejects(
      () => refusing.scoped.dispatch('terminal.create', {}, attachmentContext('att-mine')),
      (err: unknown) => err instanceof CapabilityError && err.code === 'EXECUTION_ERROR'
    );

    const dead = buildScenario({
      rows: homeRows(),
      tabs: { 'att-dead': 'tab-dead' },
      homes: { 'att-dead': 'terminal-home' },
      liveTabs: [],
    });
    await assert.rejects(
      () => dead.scoped.dispatch('terminal.create', {}, attachmentContext('att-dead')),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
    assert.deepStrictEqual(dead.calls.splitCreates, []);
  });

  it('14. reuse:true hands back only the agent\'s own live pane under the home for that folder', async () => {
    // Field report: one agent minted a terminal per command (9 creates, 1 close in 8 minutes) and the
    // sidebar filled with shells nobody closed.
    const { rows, calls, scoped } = buildScenario({
      rows: homeRows(),
      tabs: { 'att-mine': 'tab-mine' },
      homes: { 'att-mine': 'terminal-home' },
    });
    const ctx = attachmentContext('att-mine');
    type CreateResult = { sessionId: string; ownerBound?: boolean; reused?: boolean; cwd?: string };
    const create = (params: Record<string, unknown>) => scoped.dispatch('terminal.create', params, ctx) as Promise<CreateResult>;

    const first = await create({ cwd: 'E:/Work/home/first' });
    assert.strictEqual(first.reused, undefined, 'the first create mints a pane');

    const again = await create({ cwd: 'E:/Work/home/first', reuse: true });
    assert.deepStrictEqual(again, { sessionId: first.sessionId, ownerBound: true, reused: true, cwd: 'E:/Work/home/first' });
    const anyFolder = await create({ reuse: true });
    assert.strictEqual(anyFolder.sessionId, first.sessionId, 'with no folder requested the tab\'s live pane fits');
    assert.strictEqual(calls.splitCreates.length, 1, 'no second PTY may be spawned while a compatible pane is live');

    // A different folder is a different pane: silently running in the first folder would be worse than a new pane.
    const other = await create({ cwd: 'E:/Work/home/second', reuse: true });
    assert.notStrictEqual(other.sessionId, first.sessionId);
    assert.strictEqual(other.reused, undefined);

    // A pane that has exited cannot take commands, so it is never handed back.
    const firstRow = rows.find((r) => r.id === first.sessionId);
    assert.ok(firstRow);
    firstRow.state = 'exited';
    const afterExit = await create({ cwd: 'E:/Work/home/first', reuse: true });
    assert.notStrictEqual(afterExit.sessionId, first.sessionId);
    assert.strictEqual(afterExit.reused, undefined);

    // Another tab's pane under the same home, and the user's own split, are not this caller's to hand back.
    rows.push({ id: 'split-foreign-agent', cwd: 'E:/Work/home/third', state: 'running', splitOf: 'terminal-home', ownerKey: 'agent:tab-other' });
    const third = await create({ cwd: 'E:/Work/home/third', reuse: true });
    assert.notStrictEqual(third.sessionId, 'split-foreign-agent');
    assert.strictEqual(third.reused, undefined);
    const userFolder = await create({ cwd: 'E:/Work/home', reuse: true });
    assert.notStrictEqual(userFolder.sessionId, 'split-user');

    // Reuse is opt-in: without it a compatible, possibly busy pane is never handed back.
    const plain = await create({ cwd: 'E:/Work/home/third' });
    assert.notStrictEqual(plain.sessionId, third.sessionId);
    assert.strictEqual(plain.reused, undefined);

    // A pane of the agent's key that is NOT under its home (a stale base shell) is out of reach and never reused.
    rows.push({ id: 'terminal-stale-agent', cwd: 'E:/Work/home/stale', state: 'running', ownerKey: 'agent:tab-mine' });
    const stale = await create({ cwd: 'E:/Work/home/stale', reuse: true });
    assert.notStrictEqual(stale.sessionId, 'terminal-stale-agent');
  });

  it('15. Concurrent reuse creates from one tab mint a single pane', async () => {
    // Field report: parallel `terminal.create` calls both saw "no shell yet" and each minted one.
    const rows = homeRows();
    const scenario = buildScenario({
      rows,
      tabs: { 'att-mine': 'tab-mine' },
      homes: { 'att-mine': 'terminal-home' },
      // The row only lands after a few ticks, as the real daemon round trip does.
      createSplit: async (parentId: string) => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
        const id = `split-race-${rows.length}`;
        rows.push({ id, cwd: 'E:/Work/race', state: 'running', splitOf: parentId, ownerKey: 'agent:tab-mine' });
        return id;
      },
    });
    const before = rows.length;
    const create = () => scenario.scoped.dispatch('terminal.create', { cwd: 'E:/Work/race', reuse: true }, attachmentContext('att-mine')) as Promise<{ sessionId: string }>;
    const results = await Promise.all([create(), create(), create()]);
    assert.strictEqual(rows.length - before, 1, 'three racing creates must spawn one PTY');
    assert.strictEqual(new Set(results.map((r) => r.sessionId)).size, 1);
  });

  it('16. A reuse create stuck forever does not hold the tab\'s later creates hostage', async () => {
    // A createSplitSession whose daemon socket stalls never settles. Its own caller fails at the policy
    // deadline; the next create from that tab must run once that deadline has passed, not wait on it.
    const rows = homeRows();
    let calls = 0;
    const scenario = buildScenario({
      rows,
      tabs: { 'att-mine': 'tab-mine' },
      homes: { 'att-mine': 'terminal-home' },
      createSplit: (parentId: string) => {
        calls += 1;
        if (calls === 1) return new Promise<string>(() => undefined);
        const id = `split-hang-${calls}`;
        rows.push({ id, cwd: 'E:/Work/hang', state: 'running', splitOf: parentId, ownerKey: 'agent:tab-mine' });
        return Promise.resolve(id);
      },
    });
    const create = () => scenario.scoped.dispatch('terminal.create', { cwd: 'E:/Work/hang', reuse: true }, attachmentContext('att-mine')) as Promise<{ sessionId: string }>;
    const turn = () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      return promise;
    };

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      void create();
      await turn();
      const second = create();
      await turn();
      assert.strictEqual(calls, 1, 'the second create queues behind the first until the deadline');
      mock.timers.tick(15_000);
      const result = await second;
      assert.strictEqual(result.sessionId, 'split-hang-2');
      assert.strictEqual(calls, 2);
    } finally {
      mock.timers.reset();
    }
  });

  it('17. Plain creates are never queued behind another create', async () => {
    const pending = Promise.withResolvers<string>();
    let calls = 0;
    const rows = homeRows();
    const scenario = buildScenario({
      rows,
      tabs: { 'att-mine': 'tab-mine' },
      homes: { 'att-mine': 'terminal-home' },
      createSplit: (parentId: string) => {
        calls += 1;
        if (calls === 1) return pending.promise;
        rows.push({ id: 'split-plain-2', cwd: 'E:/Work/plain', state: 'running', splitOf: parentId, ownerKey: 'agent:tab-mine' });
        return Promise.resolve('split-plain-2');
      },
    });
    const create = () => scenario.scoped.dispatch('terminal.create', { cwd: 'E:/Work/plain' }, attachmentContext('att-mine')) as Promise<{ sessionId: string }>;

    const first = create();
    const second = await create();
    assert.strictEqual(second.sessionId, 'split-plain-2', 'a stalled create must not delay an independent one');
    pending.resolve('split-plain-1');
    assert.strictEqual((await first).sessionId, 'split-plain-1');
  });

  it('18. On the real manager an agent split never reuses the user\'s manual split, is stamped with the agent key, and stays out of the user toggle', async () => {
    const home = terminalManager.createSession('E:/Work/real-home');
    const otherHome = terminalManager.createSession('E:/Work/real-other');
    const otherSplit = terminalManager.createSplitSession(otherHome);
    const userSplit = terminalManager.createSplitSession(home);
    const spaceSplit = terminalManager.createSplitSession(home, 'E:/Work/real-home', undefined, undefined, { role: 'sync', spaceTerminalId: 'haravan' });
    assert.ok(home && otherHome && otherSplit && userSplit && spaceSplit);
    assert.strictEqual(terminalManager.createSplitSession(home), userSplit, 'the user toggle still reuses its manual split');

    const ownership: TerminalOwnershipPort = {
      ownerTabId: () => 'tab-real',
      homeTerminalId: () => resolveHomeBaseTerminal(terminalManager, [home]),
      isHomeSplit: (homeId, terminalId) => isLiveSplitOf(terminalManager, homeId, terminalId),
      tabAffiliation: () => ({ live: true }),
    };
    const scoped = newCatalogue();
    registerTerminalCapabilities(scoped, terminalManager, ownership);
    const ctx = attachmentContext('att-real');
    const sessionIds = (listed: unknown): string[] => (listed as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id).sort();

    try {
      const created = (await scoped.dispatch('terminal.create', { cwd: 'E:/Work/real-home' }, ctx)) as { sessionId: string };
      const createdAgain = (await scoped.dispatch('terminal.create', {}, ctx)) as { sessionId: string };
      assert.notStrictEqual(created.sessionId, userSplit);
      assert.notStrictEqual(createdAgain.sessionId, created.sessionId);
      for (const id of [created.sessionId, createdAgain.sessionId]) {
        assert.strictEqual(terminalManager.getSession(id)?.splitOf, home);
        assert.strictEqual(terminalManager.getSession(id)?.ownerKey, 'agent:tab-real');
      }
      assert.notStrictEqual(terminalManager.getSession(userSplit)?.ownerKey, 'agent:tab-real', 'the user split keeps its own owner');

      assert.deepStrictEqual(
        sessionIds(await scoped.dispatch('terminal.list', {}, ctx)),
        [userSplit, spaceSplit, created.sessionId, createdAgain.sessionId].sort(),
        'the user split, the Space split and the agent panes; never home, another base or its split'
      );
      await scoped.dispatch('terminal.write', { sessionId: spaceSplit, input: 'echo sync\r\n' }, ctx);
      await scoped.dispatch('terminal.resize', { sessionId: spaceSplit, cols: 90, rows: 20 }, ctx);
      for (const refused of [home, otherHome, otherSplit]) {
        await assert.rejects(() => scoped.dispatch('terminal.write', { sessionId: refused, input: 'x' }, ctx), forbidden, refused);
      }

      // The user's split toggle neither reuses nor closes an agent's pane.
      assert.strictEqual(terminalManager.createSplitSession(home), userSplit);
      assert.strictEqual(await terminalManager.closeSplitSession(home), true, 'closes the user\'s manual split');
      assert.strictEqual(terminalManager.getSession(userSplit), undefined);
      assert.strictEqual(await terminalManager.closeSplitSession(home), false, 'no manual split is left: the agent panes are not the toggle\'s to close');
      assert.ok(terminalManager.getSession(created.sessionId));

      // The agent closes its own pane by name; afterwards it is gone from its scope.
      assert.strictEqual(((await scoped.dispatch('terminal.close', { sessionId: created.sessionId }, ctx)) as { closed: boolean }).closed, true);
      assert.strictEqual(terminalManager.getSession(created.sessionId), undefined);
      await assert.rejects(() => scoped.dispatch('terminal.write', { sessionId: created.sessionId, input: 'x' }, ctx), forbidden);

      // A non-agent owner key is not an agent mint: it keeps the toggle's reuse semantics.
      const toggled = terminalManager.createSplitSession(home, undefined, undefined, undefined, { ownerKey: 'project:p9' });
      assert.notStrictEqual(terminalManager.getSession(toggled)?.ownerKey, 'project:p9');
    } finally {
      await terminalManager.closeSession(home);
      await terminalManager.closeSession(otherHome);
    }
  });

});
