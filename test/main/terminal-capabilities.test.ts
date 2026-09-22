import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
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
      (err: unknown) => err instanceof CapabilityError && err.code === 'WAIT_TIMEOUT'
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
      (err: unknown) => err instanceof CapabilityError && err.code === 'WAIT_ABORTED'
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
      bind: () => true,
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

      // The user plane is readable but not drivable by an agent attachment.
      await assert.rejects(
        () => scoped.dispatch('terminal.write', { sessionId: userPlane, input: 'echo USER\r\n' }, contextOf('att-mine')),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_FORBIDDEN'
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
        sessions: Array<{ id: string }>;
        omittedForeignAgentTerminals?: number;
      };
      const listedIds = listed.sessions.map((s) => s.id);
      assert.ok(listedIds.includes(mine), 'the caller sees its own terminal');
      assert.ok(listedIds.includes(userPlane), 'the caller sees the user plane');
      assert.ok(!listedIds.includes(foreign), 'a foreign agent terminal must not be advertised for addressing');
      assert.strictEqual(listed.omittedForeignAgentTerminals, 1);

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
      bind: (terminalId: string, generation: number | undefined, tabId: string) => {
        claims.push({ terminalId, generation, tabId });
        return true;
      },
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
});
