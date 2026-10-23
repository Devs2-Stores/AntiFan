import { describe, it, before, after, mock } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionDeliveryJournal, TerminalManager, DEFAULT_TERMINAL_CAPSULE_ID } from '../../src/main/browser/terminal-manager';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerTerminalCapabilities } from '../../src/main/tools/terminal-capabilities';
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

  it('9. Scopes an attachment-bound caller to its own sessions: a foreign agent terminal is refused and never listed', async () => {
    const mine = terminalManager.createSession('E:/Work/scope-mine');
    const foreign = terminalManager.createSession('E:/Work/scope-foreign');
    const userPlane = terminalManager.createSession('E:/Work/scope-user');
    assert.ok(mine && foreign && userPlane);

    // The host's live affinity is the single ownership source: `mine` is driven by tab-mine,
    // `foreign` by tab-other, and `userPlane` by no agent at all (a human's shell).
    const boundToTab: Record<string, string> = { 'tab-mine': mine, 'tab-other': foreign };
    const ownership = {
      ownerTabId: (attachmentId: string) =>
        attachmentId === 'att-mine' ? 'tab-mine' : attachmentId === 'att-other' ? 'tab-other' : undefined,
      allowsTab: (tabId: string, terminalId: string) => boundToTab[tabId] === terminalId,
      isAgentTerminal: (terminalId: string) => terminalId === mine || terminalId === foreign,
      isAgentHeld: (terminalId: string) => terminalId === mine || terminalId === foreign,
      bind: () => true,
      tabAffiliation: () => ({ live: true }),
    };
    const scoped = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });
    registerTerminalCapabilities(scoped, terminalManager, ownership);

    const contextOf = (attachmentId: string) => ({
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

    const writes: Array<{ sessionId: string; input: string }> = [];
    const originalWriteTo = terminalManager.writeTo.bind(terminalManager);
    terminalManager.writeTo = ((sessionId: string, input: string) => {
      writes.push({ sessionId, input });
      return originalWriteTo(sessionId, input);
    }) as typeof terminalManager.writeTo;

    try {
      await scoped.dispatch('terminal.write', { sessionId: mine, input: 'echo MINE\r\n' }, contextOf('att-mine'));
      assert.deepStrictEqual(writes.map((w) => w.sessionId), [mine], 'a caller may drive its own session');

      await assert.rejects(
        () => scoped.dispatch('terminal.write', { sessionId: foreign, input: 'echo STOLEN\r\n' }, contextOf('att-mine')),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_FORBIDDEN'
      );
      assert.strictEqual(writes.length, 1, 'a refused write must never reach the PTY');

      // The user plane is readable but not drivable by an agent attachment, and must not goad the agent into calling terminal.create.
      await assert.rejects(
        () => scoped.dispatch('terminal.write', { sessionId: userPlane, input: 'echo USER\r\n' }, contextOf('att-mine')),
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'TERMINAL_FORBIDDEN');
          assert.match(err.message, /terminal\.wait/);
          assert.match(err.message, /terminal\.list/);
          assert.doesNotMatch(err.message, /terminal\.create/);
          return true;
        }
      );
      const userSession = terminalManager.getSession(userPlane);
      assert.ok(userSession);
      userSession.buffer += '\r\nUSER_PLANE_MARKER\r\n';
      const observed = (await scoped.dispatch(
        'terminal.wait',
        { sessionId: userPlane, condition: 'output-match', pattern: 'USER_PLANE_MARKER', timeoutMs: 2000 },
        contextOf('att-mine')
      )) as TerminalWaitResult;
      assert.strictEqual(observed.satisfied, true, 'the user plane stays observable to an agent attachment');

      await assert.rejects(
        () =>
          scoped.dispatch(
            'terminal.wait',
            { sessionId: foreign, condition: 'output-match', pattern: 'never', timeoutMs: 50 },
            contextOf('att-mine')
          ),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_FORBIDDEN'
      );

      const listed = (await scoped.dispatch('terminal.list', {}, contextOf('att-mine'))) as {
        sessions: Array<{ id: string; owned: boolean }>;
        omittedForeignAgentTerminals?: number;
      };
      const listedIds = listed.sessions.map((s) => s.id);
      assert.ok(listedIds.includes(mine), 'the caller sees its own terminal');
      assert.ok(listedIds.includes(userPlane), 'the caller sees the user plane');
      assert.ok(!listedIds.includes(foreign), 'a foreign agent terminal must not be advertised for addressing');
      assert.strictEqual(listed.omittedForeignAgentTerminals, 1);
      // `owned` tells the caller which visible rows it may drive: its own terminal yes, the user plane only to observe.
      assert.strictEqual(listed.sessions.find((s) => s.id === mine)?.owned, true);
      assert.strictEqual(listed.sessions.find((s) => s.id === userPlane)?.owned, false);

      // A caller with no attachment has no ownership question, so every row is owned.
      const unboundListed = (await scoped.dispatch('terminal.list', {}, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'read' })) as {
        sessions: Array<{ id: string; owned: boolean }>;
      };
      assert.ok(unboundListed.sessions.length >= 3);
      assert.ok(unboundListed.sessions.every((s) => s.owned === true));

      // A caller whose bound tab cannot be resolved is refused rather than allowed unverified.
      await assert.rejects(
        () => scoped.dispatch('terminal.write', { sessionId: mine, input: 'echo X\r\n' }, contextOf('att-unknown')),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_FORBIDDEN'
      );

      // A lease-bound internal caller carries no attachment, so its reach is unchanged.
      await scoped.dispatch(
        'terminal.write',
        { sessionId: foreign, input: 'echo LEASE\r\n' },
        { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' }
      );
      assert.deepStrictEqual(writes.map((w) => w.sessionId), [mine, foreign]);
    } finally {
      terminalManager.writeTo = originalWriteTo;
      await terminalManager.closeSession(mine);
      await terminalManager.closeSession(foreign);
      await terminalManager.closeSession(userPlane);
    }
  });

  it('10. Claims a created terminal for the calling attachment and refuses to create one it cannot own', async () => {
    const claims: Array<{ terminalId: string; generation: number | undefined; tabId: string }> = [];
    const ownership = {
      ownerTabId: (attachmentId: string) => (attachmentId === 'att-known' ? 'tab-known' : undefined),
      allowsTab: (tabId: string, terminalId: string) => tabId === 'tab-known' && terminalId === 'terminal-owned-parent',
      isAgentTerminal: () => false,
      isAgentHeld: () => false,
      bind: (terminalId: string, generation: number | undefined, tabId: string) => {
        claims.push({ terminalId, generation, tabId });
        return true;
      },
      tabAffiliation: () => ({ live: true }),
    };
    const scoped = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });
    const created: string[] = [];
    const facade = {
      createSession: async () => {
        created.push('terminal-90');
        return 'terminal-90';
      },
      createSplitSession: async () => {
        created.push('terminal-91');
        return 'terminal-91';
      },
      getSession: (id: string) => ({ id, sessionGeneration: 7 }),
      listSessions: () => [],
      getActiveSessionId: () => '',
    } as unknown as TerminalManager;
    registerTerminalCapabilities(scoped, facade, ownership);

    const contextOf = (attachmentId: string) => ({
      attachmentId,
      runId: 'run-create',
      attemptId: 'attempt-create',
      projectId,
      workspaceId,
      backendId: 'backend-create',
      hostEpoch: 1,
      invocationId: 'invocation-create',
      lease,
      leaseToken: lease.token,
      grant: 'write' as const,
    });

    const base = (await scoped.dispatch('terminal.create', { cwd: 'E:/Work/scope-create' }, contextOf('att-known'))) as {
      sessionId: string;
      ownerBound?: boolean;
    };
    assert.deepStrictEqual(base, { sessionId: 'terminal-90', ownerBound: true });
    assert.deepStrictEqual(
      claims,
      [{ terminalId: 'terminal-90', generation: 7, tabId: 'tab-known' }],
      'a base session nobody owns yet must be claimed for the tab that asked for it'
    );

    const split = (await scoped.dispatch(
      'terminal.create',
      { parentId: 'terminal-owned-parent' },
      contextOf('att-known')
    )) as { sessionId: string; ownerBound?: boolean };
    assert.deepStrictEqual(split, { sessionId: 'terminal-91', ownerBound: true });
    assert.strictEqual(claims.length, 2, 'the split of an owned shell is claimed as well');

    // Splitting a shell this caller does not own is refused BEFORE a shell exists.
    await assert.rejects(
      () => scoped.dispatch('terminal.create', { parentId: 'terminal-foreign' }, contextOf('att-known')),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_FORBIDDEN'
    );

    // An attachment with no resolvable tab owns nothing, so no ownerless session is created for it.
    await assert.rejects(
      () => scoped.dispatch('terminal.create', { cwd: 'E:/Work/scope-create' }, contextOf('att-unbound')),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_FORBIDDEN'
    );
    assert.deepStrictEqual(created, ['terminal-90', 'terminal-91'], 'a refused create must leave no session behind');
  });
  it('11. Refuses a dead bound tab before creating a PTY', async () => {
    let creates = 0;
    const ownership = {
      ownerTabId: () => 'tab-dead',
      allowsTab: () => false,
      isAgentTerminal: () => false,
      isAgentHeld: () => false,
      bind: () => true,
      tabAffiliation: () => ({ live: false }),
    };
    const scoped = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1, getActiveLease: () => lease });
    const facade = {
      createSession: async () => { creates++; return 'terminal-dead'; },
      createSplitSession: async () => { creates++; return 'terminal-dead-split'; },
      listSessions: () => [],
      getActiveSessionId: () => '',
    } as unknown as TerminalManager;
    registerTerminalCapabilities(scoped, facade, ownership);
    const context = { attachmentId: 'att-dead', runId: 'r', attemptId: 'a', projectId, workspaceId, backendId: 'b', hostEpoch: 1, invocationId: 'i', lease, leaseToken: lease.token, grant: 'write' as const };
    await assert.rejects(() => scoped.dispatch('terminal.create', {}, context), (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE');
    assert.strictEqual(creates, 0);
  });

  for (const bindOutcome of ['throws', 'false'] as const) {
    it(`12. Rolls back a created PTY when bind ${bindOutcome}`, async () => {
      let sessionExists = false;
      let closeCalls = 0;
      const ownership = {
        ownerTabId: () => 'tab-live',
        allowsTab: () => false,
        isAgentTerminal: () => false,
        isAgentHeld: () => false,
        bind: () => {
          if (bindOutcome === 'throws') throw new Error('stale tab');
          return false;
        },
        tabAffiliation: () => ({ live: true }),
      };
      const scoped = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1, getActiveLease: () => lease });
      const facade = {
        createSession: async () => { sessionExists = true; return 'terminal-rollback'; },
        closeSession: async () => { closeCalls++; sessionExists = false; return true; },
        getSession: () => ({ sessionGeneration: 1 }),
        listSessions: () => sessionExists ? [{ id: 'terminal-rollback' }] : [],
        getActiveSessionId: () => '',
      } as unknown as TerminalManager;
      registerTerminalCapabilities(scoped, facade, ownership);
      const context = { attachmentId: 'att-live', runId: 'r', attemptId: 'a', projectId, workspaceId, backendId: 'b', hostEpoch: 1, invocationId: 'i', lease, leaseToken: lease.token, grant: 'write' as const };
      // A `false` bind means the tab went away; a thrown bind is a real fault and surfaces unchanged.
      await assert.rejects(
        () => scoped.dispatch('terminal.create', {}, context),
        (err: unknown) =>
          bindOutcome === 'false'
            ? err instanceof CapabilityError && err.code === 'TARGET_STALE'
            : err instanceof Error && !(err instanceof CapabilityError) && err.message === 'stale tab'
      );
      assert.strictEqual(closeCalls, 1);
      assert.deepStrictEqual(facade.listSessions(), []);
    });
  }

  it('13. Uses the bound tab capsule, DEFAULT sentinel when absent, and explicit capsule when supplied', async () => {
    const capsules: Array<string | undefined> = [];
    let tabCapsule: string | undefined = 'tab-capsule';
    const ownership = {
      ownerTabId: () => 'tab-capsule',
      allowsTab: () => false,
      isAgentTerminal: () => false,
      isAgentHeld: () => false,
      bind: () => true,
      tabAffiliation: () => ({ live: true, capsuleId: tabCapsule }),
    };
    const scoped = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1, getActiveLease: () => lease });
    let nextId = 1;
    const facade = {
      createSession: async (_cwd?: string, capsuleId?: string) => { capsules.push(capsuleId); return `terminal-capsule-${nextId++}`; },
      getSession: (id: string) => ({ id, sessionGeneration: 1 }),
      listSessions: () => [],
      getActiveSessionId: () => '',
    } as unknown as TerminalManager;
    registerTerminalCapabilities(scoped, facade, ownership);
    const context = { attachmentId: 'att-capsule', runId: 'r', attemptId: 'a', projectId, workspaceId, backendId: 'b', hostEpoch: 1, invocationId: 'i', lease, leaseToken: lease.token, grant: 'write' as const };
    await scoped.dispatch('terminal.create', {}, context);
    assert.strictEqual(capsules[0], 'tab-capsule');
    tabCapsule = undefined;
    await scoped.dispatch('terminal.create', {}, context);
    assert.strictEqual(capsules[1], DEFAULT_TERMINAL_CAPSULE_ID);
    assert.notStrictEqual(capsules[1], undefined);
    await scoped.dispatch('terminal.create', { capsuleId: 'explicit-capsule' }, context);
    assert.strictEqual(capsules[2], 'explicit-capsule');
  });

  it('14. Hands back the shell the tab already minted for that folder instead of leaving another behind', async () => {
    // Field report: one agent minted a terminal per command (9 creates, 1 close in 8 minutes) and the
    // sidebar filled with shells nobody closed.
    const rows: Array<{ id: string; cwd: string; ownerKey?: string; state: string; capsuleId?: string; splitOf?: string }> = [];
    const binds: string[] = [];
    const ownership = {
      ownerTabId: () => 'tab-reuse',
      allowsTab: (tabId: string, terminalId: string) => tabId === 'tab-reuse' && rows.some((r) => r.id === terminalId && r.ownerKey === 'agent:tab-reuse'),
      isAgentTerminal: () => false,
      isAgentHeld: () => false,
      bind: (terminalId: string) => {
        binds.push(terminalId);
        return true;
      },
      tabAffiliation: () => ({ live: true }),
    };
    const scoped = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1, getActiveLease: () => lease });
    const facade = {
      createSession: async (cwd?: string, capsuleId?: string, ownerKey?: string) => {
        const id = `terminal-reuse-${rows.length + 1}`;
        rows.push({ id, cwd: cwd ?? 'E:/Work/default', ownerKey, state: 'running', capsuleId });
        return id;
      },
      getSession: (id: string) => ({ id, sessionGeneration: 1 }),
      listSessions: () => rows,
      getActiveSessionId: () => '',
    } as unknown as TerminalManager;
    registerTerminalCapabilities(scoped, facade, ownership);
    const context = { attachmentId: 'att-reuse', runId: 'r', attemptId: 'a', projectId, workspaceId, backendId: 'b', hostEpoch: 1, invocationId: 'i', lease, leaseToken: lease.token, grant: 'write' as const };
    type CreateResult = { sessionId: string; ownerBound?: boolean; reused?: boolean; cwd?: string };
    const create = (params: Record<string, unknown>) => scoped.dispatch('terminal.create', params, context) as Promise<CreateResult>;

    const first = await create({ cwd: 'E:/Work/first' });
    assert.strictEqual(first.reused, undefined, 'the first create mints a shell');

    const again = await create({ cwd: 'E:/Work/first', reuse: true });
    assert.deepStrictEqual(again, { sessionId: first.sessionId, ownerBound: true, reused: true, cwd: 'E:/Work/first' });
    const anyFolder = await create({ reuse: true });
    assert.strictEqual(anyFolder.sessionId, first.sessionId, 'with no folder requested the tab\'s live shell fits');
    assert.strictEqual(rows.length, 1, 'no second PTY may be spawned while a compatible shell is live');
    assert.deepStrictEqual(binds, [first.sessionId], 'a reused shell is not re-bound');

    // A different folder is a different shell: silently running there in the first folder would be worse than a new tab.
    const other = await create({ cwd: 'E:/Work/second', reuse: true });
    assert.notStrictEqual(other.sessionId, first.sessionId);
    assert.strictEqual(other.reused, undefined);

    // A shell that has exited cannot take commands, so it is never handed back.
    const firstRow = rows.find((r) => r.id === first.sessionId);
    assert.ok(firstRow);
    firstRow.state = 'exited';
    const afterExit = await create({ cwd: 'E:/Work/first', reuse: true });
    assert.notStrictEqual(afterExit.sessionId, first.sessionId);
    assert.strictEqual(afterExit.reused, undefined);

    // Another tab's shell is not this caller's to hand back.
    rows.push({ id: 'terminal-foreign', cwd: 'E:/Work/third', ownerKey: 'agent:tab-other', state: 'running' });
    const third = await create({ cwd: 'E:/Work/third', reuse: true });
    assert.notStrictEqual(third.sessionId, 'terminal-foreign');
    assert.strictEqual(third.reused, undefined);

    // Reuse is opt-in: without it a compatible, possibly busy shell is never handed back.
    const plain = await create({ cwd: 'E:/Work/third' });
    assert.notStrictEqual(plain.sessionId, third.sessionId);
    assert.strictEqual(plain.reused, undefined);
  });

  it('15. Concurrent reuse creates from one tab mint a single shell', async () => {
    // Field report: parallel `terminal.create` calls both saw "no shell yet" and each minted one.
    const rows: Array<{ id: string; cwd: string; ownerKey?: string; state: string }> = [];
    const ownership = {
      ownerTabId: () => 'tab-race',
      allowsTab: (tabId: string, terminalId: string) => tabId === 'tab-race' && rows.some((r) => r.id === terminalId && r.ownerKey === 'agent:tab-race'),
      isAgentTerminal: () => false,
      isAgentHeld: () => false,
      bind: () => true,
      tabAffiliation: () => ({ live: true }),
    };
    const scoped = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1, getActiveLease: () => lease });
    const facade = {
      // The row only lands after a tick, as the real daemon round trip does.
      createSession: async (cwd?: string, _capsuleId?: string, ownerKey?: string) => {
        // Yield a few microtasks, as the daemon round trip does, so racing creates interleave.
        for (let i = 0; i < 5; i++) await Promise.resolve();
        const id = `terminal-race-${rows.length + 1}`;
        rows.push({ id, cwd: cwd ?? 'E:/Work/default', ownerKey, state: 'running' });
        return id;
      },
      getSession: (id: string) => ({ id, sessionGeneration: 1 }),
      listSessions: () => rows,
      getActiveSessionId: () => '',
    } as unknown as TerminalManager;
    registerTerminalCapabilities(scoped, facade, ownership);
    const context = { attachmentId: 'att-race', runId: 'r', attemptId: 'a', projectId, workspaceId, backendId: 'b', hostEpoch: 1, invocationId: 'i', lease, leaseToken: lease.token, grant: 'write' as const };
    const create = () => scoped.dispatch('terminal.create', { cwd: 'E:/Work/race', reuse: true }, context) as Promise<{ sessionId: string }>;

    const results = await Promise.all([create(), create(), create()]);
    assert.strictEqual(rows.length, 1, 'three racing creates must spawn one PTY');
    assert.deepStrictEqual(new Set(results.map((r) => r.sessionId)), new Set(rows.map((r) => r.id)));
  });

  it('16. A reuse create stuck forever does not hold the tab\'s later creates hostage', async () => {
    // A createSession whose daemon socket stalls never settles. Its own caller fails at the policy
    // deadline; the next create from that tab must run once that deadline has passed, not wait on it.
    const rows: Array<{ id: string; cwd: string; ownerKey?: string; state: string }> = [];
    let calls = 0;
    const ownership = {
      ownerTabId: () => 'tab-hang',
      allowsTab: (tabId: string, terminalId: string) => tabId === 'tab-hang' && rows.some((r) => r.id === terminalId && r.ownerKey === 'agent:tab-hang'),
      isAgentTerminal: () => false,
      isAgentHeld: () => false,
      bind: () => true,
      tabAffiliation: () => ({ live: true }),
    };
    const scoped = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1, getActiveLease: () => lease });
    const facade = {
      createSession: (cwd?: string, _capsuleId?: string, ownerKey?: string): Promise<string> => {
        calls += 1;
        if (calls === 1) return new Promise<string>(() => undefined);
        const id = `terminal-hang-${calls}`;
        rows.push({ id, cwd: cwd ?? 'E:/Work/default', ownerKey, state: 'running' });
        return Promise.resolve(id);
      },
      getSession: (id: string) => ({ id, sessionGeneration: 1 }),
      listSessions: () => rows,
      getActiveSessionId: () => '',
    } as unknown as TerminalManager;
    registerTerminalCapabilities(scoped, facade, ownership);
    const context = { attachmentId: 'att-hang', runId: 'r', attemptId: 'a', projectId, workspaceId, backendId: 'b', hostEpoch: 1, invocationId: 'i', lease, leaseToken: lease.token, grant: 'write' as const };
    const create = () => scoped.dispatch('terminal.create', { cwd: 'E:/Work/hang', reuse: true }, context) as Promise<{ sessionId: string }>;
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      void create();
      await turn();
      const second = create();
      await turn();
      assert.strictEqual(calls, 1, 'the second create queues behind the first until the deadline');
      mock.timers.tick(15_000);
      const result = await second;
      assert.strictEqual(result.sessionId, 'terminal-hang-2');
      assert.strictEqual(calls, 2);
    } finally {
      mock.timers.reset();
    }
  });

  it('17. Plain creates are never queued behind another create', async () => {
    const pending = Promise.withResolvers<string>();
    let calls = 0;
    const ownership = {
      ownerTabId: () => 'tab-plain',
      allowsTab: () => false,
      isAgentTerminal: () => false,
      isAgentHeld: () => false,
      bind: () => true,
      tabAffiliation: () => ({ live: true }),
    };
    const scoped = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1, getActiveLease: () => lease });
    const facade = {
      createSession: (): Promise<string> => {
        calls += 1;
        return calls === 1 ? pending.promise : Promise.resolve('terminal-plain-2');
      },
      getSession: (id: string) => ({ id, sessionGeneration: 1 }),
      listSessions: () => [],
      getActiveSessionId: () => '',
    } as unknown as TerminalManager;
    registerTerminalCapabilities(scoped, facade, ownership);
    const context = { attachmentId: 'att-plain', runId: 'r', attemptId: 'a', projectId, workspaceId, backendId: 'b', hostEpoch: 1, invocationId: 'i', lease, leaseToken: lease.token, grant: 'write' as const };
    const create = () => scoped.dispatch('terminal.create', { cwd: 'E:/Work/plain' }, context) as Promise<{ sessionId: string }>;

    const first = create();
    const second = await create();
    assert.strictEqual(second.sessionId, 'terminal-plain-2', 'a stalled create must not delay an independent one');
    pending.resolve('terminal-plain-1');
    assert.strictEqual((await first).sessionId, 'terminal-plain-1');
  });

  it('18. A shell an agent still holds stays private even once evicted from the affinity map', async () => {
    const rows = [
      { id: 'terminal-held', cwd: 'E:/Work/held', state: 'running' },
      { id: 'terminal-user', cwd: 'E:/Work/user', state: 'running' },
    ];
    const ownership = {
      ownerTabId: () => 'tab-other',
      allowsTab: () => false,
      // Evicted: no live affinity any more, yet the directory still names an open tab as its agent.
      isAgentTerminal: () => false,
      isAgentHeld: (terminalId: string) => terminalId === 'terminal-held',
      bind: () => true,
      tabAffiliation: () => ({ live: true }),
    };
    const scoped = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1, getActiveLease: () => lease });
    const facade = {
      listSessions: () => rows,
      getSession: (id: string) => rows.find((r) => r.id === id),
      getActiveSessionId: () => '',
    } as unknown as TerminalManager;
    registerTerminalCapabilities(scoped, facade, ownership);
    const context = { attachmentId: 'att-other', runId: 'r', attemptId: 'a', projectId, workspaceId, backendId: 'b', hostEpoch: 1, invocationId: 'i', lease, leaseToken: lease.token, grant: 'write' as const };

    const listed = (await scoped.dispatch('terminal.list', {}, context)) as { sessions: Array<{ id: string }> };
    assert.deepStrictEqual(listed.sessions.map((s) => s.id), ['terminal-user'], 'a held shell is not advertised to another attachment');
    await assert.rejects(
      () => scoped.dispatch('terminal.write', { sessionId: 'terminal-held', input: 'x\r\n' }, context),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_FORBIDDEN' && /agent terminal/.test(err.message)
    );
  });

});
