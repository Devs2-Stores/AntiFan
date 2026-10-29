import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TerminalManager } from '../../src/main/browser/terminal-manager';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import {
  registerTerminalCapabilities,
  resolveHomeBaseTerminal,
  isLiveSplitOf,
  isLiveTerminal,
  type TerminalOwnershipPort,
} from '../../src/main/tools/terminal-capabilities';
import { LeaderRegistry } from '../../src/main/leader/leader-registry';
import {
  registerLeaderPlacementPort,
  type LeaderPlacementRequest,
  type LeaderPlacementResult,
} from '../../src/main/leader/leader-runtime';
import {
  CapabilityError,
  issueRuntimeLease,
  makeControlPlaneId,
  type RuntimeLease,
} from '../../src/shared/control-plane-contracts';

/**
 * Leader scope of the terminal capability surface, against the production reach predicates and a
 * fake terminal manager. The run files live in a scratch data root, and the registry persists to a
 * scratch config dir, so nothing here touches the live user data.
 */
const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-leader-capabilities-'));
const PREVIOUS_CONFIG_DIR = process.env.ANTIFAN_CONFIG_DIR;
const PREVIOUS_DATA_ROOT = process.env.ANTIFAN_DATA_ROOT;
const CONFIG_DIR = path.join(SCRATCH_DIR, 'config');
const DATA_ROOT = path.join(SCRATCH_DIR, 'data');
const RUNS_DIR = path.join(DATA_ROOT, 'runtime', 'runs');
process.env.ANTIFAN_CONFIG_DIR = CONFIG_DIR;
process.env.ANTIFAN_DATA_ROOT = DATA_ROOT;
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(RUNS_DIR, { recursive: true });

interface FakeRow {
  id: string;
  name?: string;
  cwd: string;
  state: string;
  ownerKey?: string;
  splitOf?: string;
  disposed?: boolean;
}

const writeRun = (terminalId: string, state: 'idle' | 'running' | 'waiting_user' | 'ended', runSeq: number, extra: { pid?: number; updatedAt?: number; lastEventAt?: number } = {}): void => {
  fs.writeFileSync(
    path.join(RUNS_DIR, `${terminalId}.json`),
    JSON.stringify({
      schema: 1,
      terminalSessionId: terminalId,
      ompSessionId: `omp-${terminalId}`,
      pid: extra.pid ?? process.pid,
      cwd: 'E:/Work/other',
      mode: 'unset',
      state,
      runSeq,
      runStartedAt: 1,
      lastEventAt: extra.lastEventAt ?? 2,
      promptHead: `prompt of ${terminalId}`,
      updatedAt: extra.updatedAt ?? Date.now(),
    }),
    'utf8'
  );
};

describe('Leader scope of the terminal capabilities', () => {
  let lease: RuntimeLease;
  let projectId: string;
  let workspaceId: string;

  before(() => {
    projectId = makeControlPlaneId('project');
    workspaceId = makeControlPlaneId('workspace');
    lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);
  });

  after(() => {
    LeaderRegistry.resetInstance();
    if (PREVIOUS_CONFIG_DIR === undefined) delete process.env.ANTIFAN_CONFIG_DIR;
    else process.env.ANTIFAN_CONFIG_DIR = PREVIOUS_CONFIG_DIR;
    if (PREVIOUS_DATA_ROOT === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = PREVIOUS_DATA_ROOT;
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    LeaderRegistry.resetInstance();
    fs.rmSync(path.join(CONFIG_DIR, 'leader-terminals.json'), { force: true });
    for (const entry of fs.readdirSync(RUNS_DIR)) fs.rmSync(path.join(RUNS_DIR, entry), { force: true });
  });

  const attachmentContext = (attachmentId: string) => ({
    attachmentId,
    runId: 'run-leader',
    attemptId: 'attempt-leader',
    projectId,
    workspaceId,
    backendId: 'backend-leader',
    hostEpoch: 1,
    invocationId: 'invocation-leader',
    lease,
    leaseToken: lease.token,
    grant: 'write' as const,
  });

  const rowsOf = (): FakeRow[] => [
    { id: 'terminal-lead', name: 'Leader', cwd: 'E:/Work/lead', state: 'running', ownerKey: 'project:p0' },
    { id: 'terminal-w1', name: 'Worker 1', cwd: 'E:/Work/other', state: 'running', ownerKey: 'project:p2' },
    { id: 'split-w1', cwd: 'E:/Work/other', state: 'running', ownerKey: 'project:p2', splitOf: 'terminal-w1' },
    { id: 'terminal-plain', name: 'Plain', cwd: 'E:/Work/third', state: 'running', ownerKey: 'project:p3' },
    { id: 'terminal-gone', cwd: 'E:/Work/gone', state: 'closed', ownerKey: 'project:p4' },
  ];

  const build = (rows: FakeRow[] = rowsOf(), homes: Record<string, string> = { 'att-lead': 'terminal-lead', 'att-plain': 'terminal-plain' }) => {
    const calls = {
      writes: [] as Array<{ sessionId: string; input: string }>,
      closedSplits: [] as string[],
      closedBases: [] as string[],
      splitCreates: [] as string[],
    };
    const facade = {
      listSessions: () => rows.map((row) => ({ ...row })),
      getSession: (id: string) => rows.find((row) => row.id === id),
      getActiveSessionId: () => 'terminal-w1',
      writeTo: async (sessionId: string, input: string) => {
        calls.writes.push({ sessionId, input });
        return true;
      },
      resizeTo: () => {},
      waitTerminal: async (params: { sessionId: string }) => ({ satisfied: true, sessionId: params.sessionId }),
      closeSplitSession: async (id: string) => {
        calls.closedSplits.push(id);
        return true;
      },
      closeSession: async (id: string) => {
        calls.closedBases.push(id);
        return true;
      },
      createSplitSession: async (parentId: string) => {
        calls.splitCreates.push(parentId);
        return 'split-new';
      },
      createSession: async () => 'terminal-unscoped',
    } as unknown as TerminalManager;
    const ownership: TerminalOwnershipPort = {
      ownerTabId: (attachmentId) => `tab-${attachmentId}`,
      homeTerminalId: (attachmentId) => resolveHomeBaseTerminal(facade, [homes[attachmentId]]),
      isHomeSplit: (homeId, terminalId) => isLiveSplitOf(facade, homeId, terminalId),
      originTerminalId: (attachmentId) => homes[attachmentId],
      tabAffiliation: () => ({ live: true }),
      isLeader: (homeId) => LeaderRegistry.getInstance().isLeader(homeId),
      isLiveTerminal: (terminalId) => isLiveTerminal(facade, terminalId),
    };
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });
    registerTerminalCapabilities(catalogue, facade, ownership);
    return { rows, calls, catalogue };
  };

  const code = (expected: string) => (err: unknown): boolean => err instanceof CapabilityError && err.code === expected;

  describe('LeaderRegistry', () => {
    it('persists leaders and workers, reloads them, and prunes what is no longer live', () => {
      const registry = LeaderRegistry.getInstance();
      const changes: number[] = [];
      registry.on('change', () => changes.push(1));

      assert.strictEqual(registry.setLeader('terminal-lead', true), true);
      assert.strictEqual(registry.setLeader('terminal-lead', true), false, 'a repeat flip changes nothing');
      registry.assignWorker('terminal-w1', 'terminal-lead', ' Worker one ');
      registry.assignWorker('terminal-ghost', 'terminal-nobody');
      assert.strictEqual(registry.workerOf('terminal-ghost'), undefined, 'only a Leader can own workers');
      registry.assignWorker('terminal-lead', 'terminal-lead');
      assert.strictEqual(registry.workerOf('terminal-lead'), undefined, 'a Leader is never its own worker');
      assert.deepStrictEqual(registry.leaders(), ['terminal-lead']);
      assert.strictEqual(registry.workerOf('terminal-w1')?.title, 'Worker one');
      assert.strictEqual(changes.length, 2, 'one change event per persisted change');

      const onDisk = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'leader-terminals.json'), 'utf8'));
      assert.strictEqual(onDisk.schema, 1);
      assert.deepStrictEqual(onDisk.leaders, ['terminal-lead']);
      assert.strictEqual(onDisk.workers['terminal-w1'].leaderId, 'terminal-lead');
      assert.strictEqual(onDisk.workers['terminal-w1'].title, 'Worker one');
      assert.strictEqual(typeof onDisk.workers['terminal-w1'].assignedAt, 'number');

      LeaderRegistry.resetInstance();
      const reloaded = LeaderRegistry.getInstance();
      assert.strictEqual(reloaded.isLeader('terminal-lead'), true);
      assert.strictEqual(reloaded.workerOf('terminal-w1')?.leaderId, 'terminal-lead');

      reloaded.assignWorker('terminal-w2', 'terminal-lead');
      reloaded.prune(new Set(['terminal-lead', 'terminal-w2']));
      assert.strictEqual(reloaded.workerOf('terminal-w1'), undefined, 'a closed worker is dropped');
      assert.strictEqual(reloaded.workerOf('terminal-w2')?.leaderId, 'terminal-lead');

      reloaded.prune(new Set(['terminal-w2']));
      assert.strictEqual(reloaded.isLeader('terminal-lead'), false, 'a closed Leader loses its rights');
      assert.strictEqual(reloaded.workerOf('terminal-w2'), undefined, 'and its workers are released with it');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'leader-terminals.json'), 'utf8')).leaders, []);
    });

    it('clearing a Leader releases its workers', () => {
      const registry = LeaderRegistry.getInstance();
      registry.setLeader('terminal-lead', true);
      registry.assignWorker('terminal-w1', 'terminal-lead');
      assert.strictEqual(registry.setLeader('terminal-lead', false), true);
      assert.strictEqual(registry.workerOf('terminal-w1'), undefined);
    });

    it('forgetting a closed terminal drops its Leader flag, its own record and the workers it drove, and leaves the rest', () => {
      const registry = LeaderRegistry.getInstance();
      registry.setLeader('terminal-lead', true);
      registry.setLeader('terminal-other', true);
      registry.assignWorker('terminal-w1', 'terminal-lead');
      registry.assignWorker('terminal-w2', 'terminal-other');
      registry.forget('terminal-lead');
      assert.strictEqual(registry.isLeader('terminal-lead'), false);
      assert.strictEqual(registry.workerOf('terminal-w1'), undefined);
      assert.strictEqual(registry.isLeader('terminal-other'), true);
      assert.strictEqual(registry.workerOf('terminal-w2')?.leaderId, 'terminal-other');
      registry.forget('terminal-w2');
      assert.strictEqual(registry.workerOf('terminal-w2'), undefined);
      assert.strictEqual(LeaderRegistry.getInstance().isLeader('terminal-other'), true);
    });
  });

  describe('a caller that is not a Leader', () => {
    it('keeps the split-only scope', async () => {
      const { catalogue, calls } = build();
      const ctx = attachmentContext('att-plain');
      const listed = (await catalogue.dispatch('terminal.list', {}, ctx)) as { sessions: unknown[] };
      assert.deepStrictEqual(listed.sessions, [], 'a plain terminal with no split sees nothing');
      await assert.rejects(() => catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'x' }, ctx), code('TERMINAL_FORBIDDEN'));
      await assert.rejects(() => catalogue.dispatch('terminal.close', { sessionId: 'terminal-w1' }, ctx), code('TERMINAL_FORBIDDEN'));
      assert.deepStrictEqual(calls.writes, []);
      assert.deepStrictEqual(calls.closedSplits.concat(calls.closedBases), []);
    });

    it('cannot make itself a Leader by sending force or name', async () => {
      const { catalogue, calls } = build();
      writeRun('terminal-w1', 'running', 1);
      await assert.rejects(
        () => catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'x', force: true }, attachmentContext('att-plain')),
        code('TERMINAL_FORBIDDEN')
      );
      assert.deepStrictEqual(calls.writes, []);
      assert.strictEqual(LeaderRegistry.getInstance().leaders().length, 0);
    });
  });

  describe('a Leader', () => {
    const ctx = () => attachmentContext('att-lead');

    it('lists every live terminal of every project except its own, with the run snapshot of each', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      LeaderRegistry.getInstance().assignWorker('terminal-w1', 'terminal-lead', 'Row 12');
      writeRun('terminal-w1', 'running', 3);
      writeRun('terminal-plain', 'idle', 1, { pid: 0 });
      const { catalogue } = build();

      const listed = (await catalogue.dispatch('terminal.list', {}, ctx())) as {
        sessions: Array<{ id: string; cwd: string; name?: string; ownerKey?: string; workerOf?: string; owned: boolean; run?: { state: string; runSeq: number; ompSessionId?: string; promptHead?: string; lastEventAt?: number; stale: boolean } }>;
        activeSessionId: string;
        omittedOutOfScopeTerminals?: number;
      };
      assert.deepStrictEqual(listed.sessions.map((s) => s.id), ['terminal-w1', 'split-w1', 'terminal-plain'], 'the home shell and the closed terminal are not listed');
      const w1 = listed.sessions.find((s) => s.id === 'terminal-w1')!;
      assert.strictEqual(w1.cwd, 'E:/Work/other');
      assert.strictEqual(w1.name, 'Worker 1');
      assert.strictEqual(w1.ownerKey, 'project:p2');
      assert.strictEqual(w1.workerOf, 'terminal-lead');
      assert.deepStrictEqual(w1.run, {
        state: 'running',
        stale: false,
        runSeq: 3,
        ompSessionId: 'omp-terminal-w1',
        promptHead: 'prompt of terminal-w1',
        lastEventAt: 2,
      });
      const plain = listed.sessions.find((s) => s.id === 'terminal-plain')!;
      assert.strictEqual(plain.workerOf, undefined, 'a terminal the Leader never drove is not its worker');
      assert.strictEqual(plain.run?.state, 'ended', 'a run whose process is gone reads ended');
      assert.strictEqual(plain.run?.stale, true);
      assert.strictEqual(listed.sessions.find((s) => s.id === 'split-w1')?.run, undefined, 'a terminal with no run file carries no run');
      assert.strictEqual(listed.activeSessionId, 'terminal-w1');
    });

    it('terminal.create with a cwd and no parentId mints a base terminal through the placement port and registers the worker', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      const requests: LeaderPlacementRequest[] = [];
      const release = registerLeaderPlacementPort({
        placeTerminal: async (request): Promise<LeaderPlacementResult> => {
          requests.push(request);
          return { ok: true, sessionId: 'terminal-new', ownerKey: 'project:p9', capsuleId: 'capsule-9' };
        },
      });
      try {
        const { catalogue, calls } = build();
        const created = (await catalogue.dispatch('terminal.create', { cwd: 'E:/Work/f1genz', name: 'Feedback row 7' }, ctx())) as {
          sessionId: string; cwd: string; workerOf: string; ownerKey?: string; capsuleId?: string;
        };
        assert.deepStrictEqual(requests, [{ cwd: 'E:/Work/f1genz', name: 'Feedback row 7' }]);
        assert.strictEqual(created.sessionId, 'terminal-new');
        assert.strictEqual(created.workerOf, 'terminal-lead');
        assert.strictEqual(created.ownerKey, 'project:p9');
        assert.strictEqual(created.capsuleId, 'capsule-9');
        const worker = LeaderRegistry.getInstance().workerOf('terminal-new');
        assert.strictEqual(worker?.leaderId, 'terminal-lead');
        assert.strictEqual(worker?.title, 'Feedback row 7');
        assert.strictEqual(calls.splitCreates.length, 0, 'no split pane is minted for a placed worker');

        // With a parentId the existing split behaviour applies.
        const split = (await catalogue.dispatch('terminal.create', { cwd: 'E:/Work/f1genz', parentId: 'terminal-lead' }, ctx())) as { sessionId: string };
        assert.strictEqual(split.sessionId, 'split-new');
        assert.deepStrictEqual(calls.splitCreates, ['terminal-lead']);
        assert.strictEqual(requests.length, 1);
      } finally {
        release();
      }
    });

    it('terminal.create reports a refused placement instead of inventing a terminal', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      const release = registerLeaderPlacementPort({
        placeTerminal: async () => ({ ok: false, reason: 'FOLDER_INVALID', message: 'not a directory' }),
      });
      try {
        const { catalogue } = build();
        await assert.rejects(
          () => catalogue.dispatch('terminal.create', { cwd: 'E:/Work/missing' }, ctx()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'EXECUTION_ERROR' && /FOLDER_INVALID/.test(err.message)
        );
        assert.strictEqual(LeaderRegistry.getInstance().workerOf('terminal-new'), undefined);
      } finally {
        release();
      }
    });

    it('terminal.write refuses a running target with TERMINAL_BUSY, allows force, and allows idle, waiting, ended and run-less targets', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      const { catalogue, calls } = build();

      writeRun('terminal-w1', 'running', 2);
      await assert.rejects(
        () => catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'hello\r' }, ctx()),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_BUSY' && /run-idle/.test(err.message)
      );
      assert.strictEqual(calls.writes.length, 0, 'a refused write never reaches the PTY');
      assert.strictEqual(LeaderRegistry.getInstance().workerOf('terminal-w1'), undefined, 'a refused write claims nothing');

      await catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'forced\r', force: true }, ctx());
      assert.deepStrictEqual(calls.writes.map((w) => w.input), ['forced\r']);

      writeRun('terminal-w1', 'idle', 2);
      await catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'idle\r' }, ctx());
      writeRun('terminal-w1', 'waiting_user', 2);
      await catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'waiting\r' }, ctx());
      writeRun('terminal-w1', 'running', 2, { pid: 0 });
      await catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'dead\r' }, ctx());
      await catalogue.dispatch('terminal.write', { sessionId: 'terminal-plain', input: 'plain\r' }, ctx());
      assert.deepStrictEqual(calls.writes.map((w) => w.input), ['forced\r', 'idle\r', 'waiting\r', 'dead\r', 'plain\r']);

      assert.strictEqual(LeaderRegistry.getInstance().workerOf('terminal-w1')?.leaderId, 'terminal-lead', 'a successful write registers the worker');
      assert.strictEqual(LeaderRegistry.getInstance().workerOf('terminal-plain')?.leaderId, 'terminal-lead');
    });

    it('terminal.wait run-idle is satisfied when the run file flips to idle, and honours minRunSeq', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      const { catalogue } = build();

      writeRun('terminal-w1', 'running', 1);
      const flip = setTimeout(() => writeRun('terminal-w1', 'idle', 1), 150);
      const started = Date.now();
      const waited = (await catalogue.dispatch('terminal.wait', { sessionId: 'terminal-w1', condition: 'run-idle', timeoutMs: 5000 }, ctx())) as {
        satisfied: boolean; run: { state: string; runSeq: number };
      };
      clearTimeout(flip);
      assert.strictEqual(waited.satisfied, true);
      assert.strictEqual(waited.run.state, 'idle');
      assert.ok(Date.now() - started >= 100, 'the wait really blocked until the file flipped');

      // An idle run older than minRunSeq is the previous turn: the wait keeps going until the new one settles.
      writeRun('terminal-w1', 'idle', 1);
      const newTurn = setTimeout(() => writeRun('terminal-w1', 'idle', 2), 150);
      const second = (await catalogue.dispatch('terminal.wait', { sessionId: 'terminal-w1', condition: 'run-idle', minRunSeq: 2, timeoutMs: 5000 }, ctx())) as {
        satisfied: boolean; run: { runSeq: number };
      };
      clearTimeout(newTurn);
      assert.strictEqual(second.run.runSeq, 2);

      // A run that never settles ends in the ordinary WAIT_TIMEOUT.
      writeRun('terminal-w1', 'running', 3);
      await assert.rejects(
        () => catalogue.dispatch('terminal.wait', { sessionId: 'terminal-w1', condition: 'run-idle', timeoutMs: 200 }, ctx()),
        code('WAIT_TIMEOUT')
      );
    });

    it('terminal.write returns writtenAt, and run-idle with afterEventAt ignores a run older than that write', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      const { catalogue } = build();
      // The previous turn's file: idle, last event long before the write.
      writeRun('terminal-w1', 'idle', 1, { lastEventAt: 1_000 });
      const written = (await catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'go\r' }, ctx())) as {
        writtenAt: number; run?: { state: string };
      };
      assert.ok(written.writtenAt > 1_000);
      assert.strictEqual(written.run?.state, 'idle');

      // Without afterEventAt the stale idle file satisfies the wait at once; with it, only the new turn does.
      const newTurn = setTimeout(() => writeRun('terminal-w1', 'idle', 2, { lastEventAt: Date.now() + 1 }), 150);
      const started = Date.now();
      const waited = (await catalogue.dispatch(
        'terminal.wait',
        { sessionId: 'terminal-w1', condition: 'run-idle', afterEventAt: written.writtenAt, timeoutMs: 5000 },
        ctx()
      )) as { satisfied: boolean; run: { runSeq: number } };
      clearTimeout(newTurn);
      assert.strictEqual(waited.run.runSeq, 2);
      assert.ok(Date.now() - started >= 100, 'the old idle file did not satisfy the wait');

      await assert.rejects(
        () => catalogue.dispatch('terminal.wait', { sessionId: 'terminal-w1', condition: 'run-idle', afterEventAt: 'x' }, ctx()),
        code('INVALID_ARGUMENT')
      );
    });

    it('terminal.wait run-idle is also available to a caller that is not a Leader, on the panes it owns', async () => {
      const rows = rowsOf();
      rows.push({ id: 'split-mine', cwd: 'E:/Work/third', state: 'running', ownerKey: 'project:p3', splitOf: 'terminal-plain' });
      const { catalogue } = build(rows);
      writeRun('split-mine', 'idle', 4);
      const waited = (await catalogue.dispatch('terminal.wait', { sessionId: 'split-mine', condition: 'run-idle', timeoutMs: 1000 }, attachmentContext('att-plain'))) as { satisfied: boolean; run: { runSeq: number } };
      assert.strictEqual(waited.satisfied, true);
      assert.strictEqual(waited.run.runSeq, 4);
      await assert.rejects(
        () => catalogue.dispatch('terminal.wait', { sessionId: 'terminal-w1', condition: 'run-idle', timeoutMs: 100 }, attachmentContext('att-plain')),
        code('TERMINAL_FORBIDDEN')
      );
    });

    it('closes any live terminal of any project, base through closeSession and a split through closeSplitSession, but never its own home', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      const { catalogue, calls } = build();
      assert.deepStrictEqual(await catalogue.dispatch('terminal.close', { sessionId: 'terminal-w1' }, ctx()), { closed: true });
      assert.deepStrictEqual(await catalogue.dispatch('terminal.close', { sessionId: 'split-w1' }, ctx()), { closed: true });
      assert.deepStrictEqual(calls.closedBases, ['terminal-w1']);
      assert.deepStrictEqual(calls.closedSplits, ['split-w1']);
    });

    it('never touches its own home shell, nor a terminal that is not live', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      const { catalogue, calls } = build();
      for (const op of [
        () => catalogue.dispatch('terminal.write', { sessionId: 'terminal-lead', input: 'x', force: true }, ctx()),
        () => catalogue.dispatch('terminal.resize', { sessionId: 'terminal-lead', cols: 80, rows: 24 }, ctx()),
        () => catalogue.dispatch('terminal.wait', { sessionId: 'terminal-lead', condition: 'run-idle', timeoutMs: 50 }, ctx()),
        () => catalogue.dispatch('terminal.close', { sessionId: 'terminal-lead' }, ctx()),
      ]) {
        await assert.rejects(op, (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_FORBIDDEN' && /home terminal/.test(err.message));
      }
      for (const missing of ['terminal-gone', 'terminal-never-existed']) {
        await assert.rejects(() => catalogue.dispatch('terminal.write', { sessionId: missing, input: 'x' }, ctx()), code('TERMINAL_FORBIDDEN'), missing);
        await assert.rejects(() => catalogue.dispatch('terminal.close', { sessionId: missing }, ctx()), code('TERMINAL_FORBIDDEN'), missing);
      }
      assert.deepStrictEqual(calls.writes, []);
      assert.deepStrictEqual(calls.closedBases.concat(calls.closedSplits), []);
      assert.strictEqual(LeaderRegistry.getInstance().workerOf('terminal-lead'), undefined);
    });

    it('loses its rights the moment its terminal stops being a Leader', async () => {
      const registry = LeaderRegistry.getInstance();
      registry.setLeader('terminal-lead', true);
      const { catalogue } = build();
      assert.ok(((await catalogue.dispatch('terminal.list', {}, ctx())) as { sessions: unknown[] }).sessions.length > 0);
      registry.prune(new Set(['terminal-w1']));
      const after = (await catalogue.dispatch('terminal.list', {}, ctx())) as { sessions: unknown[] };
      assert.deepStrictEqual(after.sessions, [], 'authority is read per call from the registry, never cached');
    });
  });
});
