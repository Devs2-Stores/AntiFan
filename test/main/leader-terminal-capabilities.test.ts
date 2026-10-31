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
  type TerminalCapabilityDeps,
  type TerminalOwnershipPort,
} from '../../src/main/tools/terminal-capabilities';
import { LeaderRegistry } from '../../src/main/leader/leader-registry';
import {
  registerLeaderPlacementPort,
  type LeaderPlacementRequest,
  type LeaderPlacementResult,
  registerLeaderProjectRemovalPort,
  type LeaderMintedProjectRemoval,
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
  buffer?: string;
}

const writeRun = (terminalId: string, state: 'idle' | 'running' | 'waiting_user' | 'ended', runSeq: number, extra: { pid?: number; updatedAt?: number; lastEventAt?: number; hookSha256?: string } = {}): void => {
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
      ...(extra.hookSha256 ? { hookSha256: extra.hookSha256 } : {}),
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

  const build = (
    rows: FakeRow[] = rowsOf(),
    homes: Record<string, string> = { 'att-lead': 'terminal-lead', 'att-plain': 'terminal-plain' },
    overrides: Partial<TerminalOwnershipPort> = {},
    deps: TerminalCapabilityDeps = {},
  ) => {
    const calls = {
      writes: [] as Array<{ sessionId: string; input: string }>,
      closedSplits: [] as string[],
      closedBases: [] as string[],
      /** Every input the facade's `waitTerminal` received. */
      waits: [] as Array<Record<string, unknown>>,
      splitCreates: [] as string[],
      /** What the facade's `writeTo` resolves to; `false` is a daemon that reports no session took the input. */
      writeResult: true as unknown,
      /** What the facade's `closeSession` resolves to; `false` is a close that was refused or failed. */
      closeResult: true as unknown,
    };
    const facade = {
      listSessions: () => rows.map((row) => ({ ...row })),
      getSession: (id: string) => rows.find((row) => row.id === id),
      getActiveSessionId: () => 'terminal-w1',
      writeTo: async (sessionId: string, input: string) => {
        calls.writes.push({ sessionId, input });
        return calls.writeResult;
      },
      resizeTo: () => {},
      waitTerminal: async (params: { sessionId: string }) => {
        calls.waits.push({ ...params });
        return { satisfied: true, sessionId: params.sessionId };
      },
      closeSplitSession: async (id: string) => {
        calls.closedSplits.push(id);
        return true;
      },
      closeSession: async (id: string) => {
        calls.closedBases.push(id);
        return calls.closeResult;
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
      ...overrides,
    };
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });
    registerTerminalCapabilities(catalogue, facade, ownership, deps);
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
      assert.strictEqual(registry.assignWorker('terminal-w1', 'terminal-lead', ' Worker one '), true);
      assert.strictEqual(registry.assignWorker('terminal-ghost', 'terminal-nobody'), false);
      assert.strictEqual(registry.workerOf('terminal-ghost'), undefined, 'only a Leader can own workers');
      assert.strictEqual(registry.assignWorker('terminal-lead', 'terminal-lead'), false);
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
      assert.strictEqual(reloaded.workerOf('terminal-w2')?.leaderId, 'terminal-lead', 'but its live worker keeps the record that gates its theme pushes');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'leader-terminals.json'), 'utf8')).leaders, []);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'leader-terminals.json'), 'utf8')).workers['terminal-w2'].leaderId, 'terminal-lead', 'the orphan survives a reload too');
    });

    it('clearing a Leader keeps its workers: they become orphans that are still gated', () => {
      const registry = LeaderRegistry.getInstance();
      registry.setLeader('terminal-lead', true);
      registry.assignWorker('terminal-w1', 'terminal-lead', 'Row 7');
      assert.strictEqual(registry.setLeader('terminal-lead', false), true);
      assert.strictEqual(registry.isLeader('terminal-lead'), false);
      assert.strictEqual(registry.workerOf('terminal-w1')?.leaderId, 'terminal-lead');
      assert.strictEqual(registry.workerOf('terminal-w1')?.title, 'Row 7');
    });

    it('forgetting a closed terminal drops its Leader flag and its own record, and leaves the workers it drove and the rest', () => {
      const registry = LeaderRegistry.getInstance();
      registry.setLeader('terminal-lead', true);
      registry.setLeader('terminal-other', true);
      registry.assignWorker('terminal-w1', 'terminal-lead');
      registry.assignWorker('terminal-w2', 'terminal-other');
      registry.forget('terminal-lead');
      assert.strictEqual(registry.isLeader('terminal-lead'), false);
      assert.strictEqual(registry.workerOf('terminal-w1')?.leaderId, 'terminal-lead', 'the worker terminal is still open and still gated');
      assert.strictEqual(registry.isLeader('terminal-other'), true);
      assert.strictEqual(registry.workerOf('terminal-w2')?.leaderId, 'terminal-other');
      registry.forget('terminal-w2');
      assert.strictEqual(registry.workerOf('terminal-w2'), undefined);
      assert.strictEqual(LeaderRegistry.getInstance().isLeader('terminal-other'), true);
    });

    it('never takes a worker from a Leader that is still a Leader, and lets a live Leader adopt an orphan', () => {
      const registry = LeaderRegistry.getInstance();
      registry.setLeader('terminal-a', true);
      registry.setLeader('terminal-b', true);
      assert.strictEqual(registry.assignWorker('terminal-w1', 'terminal-a', 'Row 7'), true);
      const assignedAt = registry.workerOf('terminal-w1')?.assignedAt;

      assert.strictEqual(registry.assignWorker('terminal-w1', 'terminal-b'), false, 'B cannot steal A\'s worker while A is a Leader');
      assert.strictEqual(registry.workerOf('terminal-w1')?.leaderId, 'terminal-a');

      registry.setLeader('terminal-a', false);
      assert.strictEqual(registry.assignWorker('terminal-w1', 'terminal-b'), true, 'B adopts the orphan');
      assert.strictEqual(registry.workerOf('terminal-w1')?.leaderId, 'terminal-b');
      assert.strictEqual(registry.workerOf('terminal-w1')?.title, 'Row 7', 'the title carries over unless a new one is given');
      assert.ok((registry.workerOf('terminal-w1')?.assignedAt ?? 0) >= (assignedAt ?? 0));
    });

    it('a repeat claim by the same Leader writes and announces nothing, and only a new title changes the record', () => {
      const registry = LeaderRegistry.getInstance();
      registry.setLeader('terminal-lead', true);
      assert.strictEqual(registry.assignWorker('terminal-w1', 'terminal-lead', 'Row 7'), true);
      const first = registry.workerOf('terminal-w1');
      const changes: number[] = [];
      registry.on('change', () => changes.push(1));

      // A later clock: a record rewritten from scratch would carry this time instead of the first one.
      const realNow = Date.now;
      Date.now = () => (first?.assignedAt ?? 0) + 60_000;
      try {
        assert.strictEqual(registry.assignWorker('terminal-w1', 'terminal-lead'), true);
        assert.strictEqual(registry.assignWorker('terminal-w1', 'terminal-lead', 'Row 7'), true);
        assert.strictEqual(changes.length, 0, 'no file write and no board re-push for a repeat claim');

        assert.strictEqual(registry.assignWorker('terminal-w1', 'terminal-lead', 'Row 8'), true);
      } finally {
        Date.now = realNow;
      }
      assert.strictEqual(changes.length, 1);
      assert.strictEqual(registry.workerOf('terminal-w1')?.title, 'Row 8');
      assert.strictEqual(registry.workerOf('terminal-w1')?.assignedAt, first?.assignedAt, 'a new title keeps the time the worker was first assigned');
    });

    it('inheritWorker gives a split the parent worker\'s Leader even when that Leader is gone, and refuses a Leader or an unrecorded parent', () => {
      const registry = LeaderRegistry.getInstance();
      registry.setLeader('terminal-lead', true);
      registry.assignWorker('terminal-w1', 'terminal-lead');
      registry.setLeader('terminal-lead', false);

      assert.strictEqual(registry.inheritWorker('split-w1', 'terminal-w1'), true);
      assert.strictEqual(registry.workerOf('split-w1')?.leaderId, 'terminal-lead', 'the orphan\'s split is gated too');
      assert.strictEqual(registry.inheritWorker('split-x', 'terminal-unrecorded'), false);
      assert.strictEqual(registry.workerOf('split-x'), undefined);
      registry.setLeader('terminal-other', true);
      assert.strictEqual(registry.inheritWorker('terminal-other', 'terminal-w1'), false, 'a Leader is never a worker');
      assert.strictEqual(registry.inheritWorker('terminal-w1', 'terminal-w1'), false);
    });

    it('reports false and keeps nothing in memory when the registry file cannot be written', () => {
      const registry = LeaderRegistry.getInstance();
      registry.setLeader('terminal-lead', true);
      const target = path.join(CONFIG_DIR, 'leader-terminals.json');
      fs.rmSync(target, { force: true });
      fs.mkdirSync(target); // a directory in the file's place: the rename onto it fails
      try {
        assert.strictEqual(registry.assignWorker('terminal-w1', 'terminal-lead'), false);
        assert.strictEqual(registry.workerOf('terminal-w1'), undefined, 'the record that never reached the file is not claimed in memory');
        assert.strictEqual(registry.inheritWorker('split-w1', 'terminal-w1'), false);
      } finally {
        fs.rmSync(target, { recursive: true, force: true });
      }
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

    it('terminal.create says which state a worker terminal is left in when it cannot be recorded: closed again, or still open and ungated', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      const release = registerLeaderPlacementPort({
        placeTerminal: async () => ({ ok: true, sessionId: 'terminal-new', ownerKey: 'project:p9', capsuleId: 'capsule-9' }),
      });
      const registryFile = path.join(CONFIG_DIR, 'leader-terminals.json');
      try {
        for (const [closeResult, expected] of [[true, /was closed again/], [false, /could not be closed: it is still open and ungated/]] as const) {
          const { catalogue, calls } = build();
          calls.closeResult = closeResult;
          fs.rmSync(registryFile, { recursive: true, force: true });
          fs.mkdirSync(registryFile);
          await assert.rejects(
            () => catalogue.dispatch('terminal.create', { cwd: 'E:/Work/shop' }, ctx()),
            (err: unknown) => err instanceof CapabilityError && err.code === 'EXECUTION_ERROR' && expected.test(err.message) && err.details?.closed === closeResult
          );
          assert.deepStrictEqual(calls.closedBases, ['terminal-new']);
        }
      } finally {
        release();
        fs.rmSync(registryFile, { recursive: true, force: true });
      }
    });

    it('terminal.write reports written:false when the facade says no session took the input, and claims no worker for it', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      const { catalogue, calls } = build();
      calls.writeResult = false;
      const result = (await catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'hello\r' }, ctx())) as {
        written: boolean; woke: boolean; message?: string;
      };
      assert.strictEqual(result.written, false);
      assert.match(result.message ?? '', /did not confirm the input/);
      assert.match(result.message ?? '', /before writing again/, 'a timed-out daemon call may still have delivered, so the caller is told to check');
      assert.strictEqual(LeaderRegistry.getInstance().workerOf('terminal-w1'), undefined, 'an undelivered write claims nothing');

      // Anything else the facade returns (an in-process manager returns nothing; an older daemon replies true) is delivery.
      for (const reply of [true, undefined]) {
        calls.writeResult = reply;
        const delivered = (await catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'hello\r' }, ctx())) as { written: boolean };
        assert.strictEqual(delivered.written, true, `reply ${String(reply)}`);
      }
      assert.strictEqual(LeaderRegistry.getInstance().workerOf('terminal-w1')?.leaderId, 'terminal-lead');
    });

    it('a second Leader writing to a worker leaves the record alone, and adopts it once the first is no longer a Leader', async () => {
      const registry = LeaderRegistry.getInstance();
      registry.setLeader('terminal-lead', true);
      registry.setLeader('terminal-plain', true);
      const { catalogue, calls } = build(undefined, { 'att-lead': 'terminal-lead', 'att-b': 'terminal-plain' });
      await catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'a\r' }, ctx());
      assert.strictEqual(registry.workerOf('terminal-w1')?.leaderId, 'terminal-lead');
      const assignedAt = registry.workerOf('terminal-w1')?.assignedAt;

      const byB = (await catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'b\r' }, attachmentContext('att-b'))) as { written: boolean; message?: string };
      assert.strictEqual(byB.written, true, 'the write itself is allowed: B is a Leader');
      assert.strictEqual(byB.message, undefined, 'a refused claim is not a persistence failure');
      assert.strictEqual(registry.workerOf('terminal-w1')?.leaderId, 'terminal-lead', 'B did not steal A\'s worker');
      assert.strictEqual(registry.workerOf('terminal-w1')?.assignedAt, assignedAt);

      registry.setLeader('terminal-lead', false);
      await catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'c\r' }, attachmentContext('att-b'));
      assert.strictEqual(registry.workerOf('terminal-w1')?.leaderId, 'terminal-plain', 'B adopts the orphan');
      assert.deepStrictEqual(calls.writes.map((w) => w.input), ['a\r', 'b\r', 'c\r']);
    });

    it('says so when the claim on a target could not be saved: that terminal\'s OMP is not gated', async () => {
      const registry = LeaderRegistry.getInstance();
      registry.setLeader('terminal-lead', true);
      const { catalogue } = build();
      const target = path.join(CONFIG_DIR, 'leader-terminals.json');
      fs.rmSync(target, { force: true });
      fs.mkdirSync(target);
      try {
        const result = (await catalogue.dispatch('terminal.write', { sessionId: 'terminal-w1', input: 'x\r' }, ctx())) as { written: boolean; message?: string };
        assert.strictEqual(result.written, true, 'the keystrokes were delivered');
        assert.match(result.message ?? '', /Leader registry could not be saved/);
        assert.strictEqual(registry.workerOf('terminal-w1'), undefined);
      } finally {
        fs.rmSync(target, { recursive: true, force: true });
      }
    });

    it('a worker minted under a recycled id starts clean: stale run files and a stale Leader flag are gone', async () => {
      const registry = LeaderRegistry.getInstance();
      registry.setLeader('terminal-lead', true);
      registry.setLeader('terminal-9', true);
      writeRun('terminal-9', 'running', 5);
      fs.writeFileSync(path.join(RUNS_DIR, 'terminal-9.brief.json'), '{}');
      fs.writeFileSync(path.join(RUNS_DIR, 'terminal-9.json.tmp-1-2-abcd'), '{}');
      fs.writeFileSync(path.join(RUNS_DIR, 'terminal-90.json'), '{}');
      const release = registerLeaderPlacementPort({
        placeTerminal: async (): Promise<LeaderPlacementResult> => ({ ok: true, sessionId: 'terminal-9' }),
      });
      try {
        const { catalogue } = build();
        const created = (await catalogue.dispatch('terminal.create', { cwd: 'E:/Work/f1genz', name: 'Row 9' }, ctx())) as { sessionId: string };
        assert.strictEqual(created.sessionId, 'terminal-9');
        assert.strictEqual(registry.isLeader('terminal-9'), false, 'a fresh id cannot be a Leader');
        assert.strictEqual(registry.workerOf('terminal-9')?.leaderId, 'terminal-lead');
        assert.deepStrictEqual(fs.readdirSync(RUNS_DIR), ['terminal-90.json'], 'only the recycled id\'s files went; a neighbour with the same prefix stays');
      } finally {
        release();
      }
    });

    it('closes the minted worker and refuses when the registry cannot record it, instead of returning an ungated worker', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      const target = path.join(CONFIG_DIR, 'leader-terminals.json');
      const release = registerLeaderPlacementPort({
        placeTerminal: async (): Promise<LeaderPlacementResult> => ({ ok: true, sessionId: 'terminal-new' }),
      });
      fs.rmSync(target, { force: true });
      fs.mkdirSync(target);
      try {
        const { catalogue, calls } = build();
        await assert.rejects(
          () => catalogue.dispatch('terminal.create', { cwd: 'E:/Work/f1genz' }, ctx()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'EXECUTION_ERROR' && /not gated/.test(err.message)
        );
        assert.deepStrictEqual(calls.closedBases, ['terminal-new'], 'the unrecorded terminal is closed again');
        assert.strictEqual(LeaderRegistry.getInstance().workerOf('terminal-new'), undefined);
      } finally {
        release();
        fs.rmSync(target, { recursive: true, force: true });
      }
    });

    it('terminal.list carries daemonOutdated for a Leader when the daemon runs an older bundle, and nothing otherwise', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      let status = { running: 'v-old', staged: 'v-new', outdated: true };
      const { catalogue } = build(undefined, undefined, {}, { daemonStatus: () => status });
      const outdated = (await catalogue.dispatch('terminal.list', {}, ctx())) as { daemonOutdated?: { running: string; staged: string; message: string } };
      assert.strictEqual(outdated.daemonOutdated?.running, 'v-old');
      assert.strictEqual(outdated.daemonOutdated?.staged, 'v-new');
      assert.match(outdated.daemonOutdated?.message ?? '', /restart the daemon/);

      status = { running: 'v-new', staged: 'v-new', outdated: false };
      const current = (await catalogue.dispatch('terminal.list', {}, ctx())) as Record<string, unknown>;
      assert.strictEqual('daemonOutdated' in current, false);

      status = { running: 'v-old', staged: 'v-new', outdated: true };
      const plain = (await catalogue.dispatch('terminal.list', {}, attachmentContext('att-plain'))) as Record<string, unknown>;
      assert.strictEqual('daemonOutdated' in plain, false, 'a plain agent in a split pane is not told');

      const unbound = (await catalogue.dispatch('terminal.list', {}, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' as const })) as Record<string, unknown>;
      assert.strictEqual('daemonOutdated' in unbound, false, 'a caller with no attachment cannot restart or relay about the daemon either');
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

    it('stays a Leader with no bound tab, or a tab rooted in another terminal: the home is the origin', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      for (const overrides of [
        { ownerTabId: () => undefined, homeTerminalId: () => undefined },
        { homeTerminalId: () => 'terminal-w1' },
      ] satisfies Array<Partial<TerminalOwnershipPort>>) {
        const { catalogue } = build(undefined, undefined, overrides);
        const listed = (await catalogue.dispatch('terminal.list', {}, ctx())) as { sessions: Array<{ id: string }> };
        const ids = listed.sessions.map((row) => row.id);
        assert.ok(ids.includes('terminal-w1'), `expected Leader reach, got ${JSON.stringify(ids)}`);
        assert.ok(!ids.includes('terminal-lead'), 'the origin shell stays out of reach');
      }
    });

    it('is not granted to a caller whose tab is rooted in the Leader terminal but whose origin is elsewhere', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      const { catalogue } = build(undefined, undefined, {
        homeTerminalId: (attachmentId) => (attachmentId === 'att-plain' ? 'terminal-lead' : undefined),
      });
      const listed = (await catalogue.dispatch('terminal.list', {}, attachmentContext('att-plain'))) as { sessions: unknown[] };
      assert.deepStrictEqual(listed.sessions, []);
    });

    it('includeBuffer:false drops the raw output tail from every row', async () => {
      LeaderRegistry.getInstance().setLeader('terminal-lead', true);
      const rows = rowsOf().map((row) => ({ ...row, buffer: 'raw tail' }));
      const { catalogue } = build(rows);
      const full = (await catalogue.dispatch('terminal.list', {}, ctx())) as { sessions: Array<Record<string, unknown>> };
      assert.ok(full.sessions.every((row) => row.buffer === 'raw tail'));
      const compact = (await catalogue.dispatch('terminal.list', { includeBuffer: false }, ctx())) as { sessions: Array<Record<string, unknown>> };
      assert.strictEqual(compact.sessions.length, full.sessions.length);
      assert.ok(compact.sessions.every((row) => !('buffer' in row)));
    });

    describe('terminal.wait condition inference', () => {
      it('a pattern means output-match and silenceMs means silence, and the condition may still be explicit', async () => {
        LeaderRegistry.getInstance().setLeader('terminal-lead', true);
        const { catalogue, calls } = build();
        await catalogue.dispatch('terminal.wait', { sessionId: 'terminal-w1', pattern: 'READY' }, ctx());
        await catalogue.dispatch('terminal.wait', { sessionId: 'terminal-w1', silenceMs: 500 }, ctx());
        await catalogue.dispatch('terminal.wait', { sessionId: 'terminal-w1', condition: 'exit' }, ctx());
        assert.deepStrictEqual(calls.waits.map((wait) => wait.condition), ['output-match', 'silence', 'exit']);
        assert.strictEqual(calls.waits[0]?.pattern, 'READY');
        assert.strictEqual(calls.waits[1]?.silenceMs, 500);
      });

      it('minRunSeq or afterEventAt means run-idle', async () => {
        LeaderRegistry.getInstance().setLeader('terminal-lead', true);
        const { catalogue } = build();
        writeRun('terminal-w1', 'idle', 5, { lastEventAt: Date.now() + 10_000 });
        for (const hint of [{ minRunSeq: 3 }, { afterEventAt: 1 }]) {
          const waited = (await catalogue.dispatch('terminal.wait', { sessionId: 'terminal-w1', timeoutMs: 1000, ...hint }, ctx())) as { run: { runSeq: number } };
          assert.strictEqual(waited.run.runSeq, 5);
        }
      });

      it('refuses a call that names no condition, and one whose hints disagree', async () => {
        LeaderRegistry.getInstance().setLeader('terminal-lead', true);
        const { catalogue, calls } = build();
        await assert.rejects(
          () => catalogue.dispatch('terminal.wait', { sessionId: 'terminal-w1' }, ctx()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && /output-match, exit, silence, run-idle/.test(err.message)
        );
        await assert.rejects(
          () => catalogue.dispatch('terminal.wait', { sessionId: 'terminal-w1', pattern: 'x', silenceMs: 10 }, ctx()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && /ambiguous/.test(err.message)
        );
        assert.deepStrictEqual(calls.waits, [], 'nothing was waited on');
      });

      it('the schema no longer requires condition', () => {
        const { catalogue } = build();
        const schema = catalogue.get('terminal.wait')?.inputSchema as { required?: string[] } | undefined;
        assert.ok(!schema?.required?.includes('condition'));
      });
    });

    describe('terminal.wait run-idle over sessionIds', () => {
      it('returns the first terminal whose run settled, with its run and the whole id list', async () => {
        LeaderRegistry.getInstance().setLeader('terminal-lead', true);
        const { catalogue } = build();
        writeRun('terminal-w1', 'running', 1);
        writeRun('terminal-plain', 'idle', 3);
        const waited = (await catalogue.dispatch('terminal.wait', { sessionIds: ['terminal-w1', 'terminal-plain'], timeoutMs: 1000 }, ctx())) as {
          satisfied: boolean; sessionId: string; sessionIds: string[]; run: { runSeq: number };
        };
        assert.strictEqual(waited.satisfied, true);
        assert.strictEqual(waited.sessionId, 'terminal-plain');
        assert.deepStrictEqual(waited.sessionIds, ['terminal-w1', 'terminal-plain']);
        assert.strictEqual(waited.run.runSeq, 3);
      });

      it('waits until one of them flips to idle, and honours afterEventAt for every terminal', async () => {
        LeaderRegistry.getInstance().setLeader('terminal-lead', true);
        const { catalogue } = build();
        writeRun('terminal-w1', 'idle', 1, { lastEventAt: 1_000 });
        writeRun('terminal-plain', 'idle', 1, { lastEventAt: 1_000 });
        const since = Date.now();
        const flip = setTimeout(() => writeRun('terminal-plain', 'idle', 2, { lastEventAt: Date.now() + 1 }), 150);
        const waited = (await catalogue.dispatch('terminal.wait', { sessionIds: ['terminal-w1', 'terminal-plain'], afterEventAt: since, timeoutMs: 5000 }, ctx())) as {
          sessionId: string; run: { runSeq: number };
        };
        clearTimeout(flip);
        assert.strictEqual(waited.sessionId, 'terminal-plain');
        assert.strictEqual(waited.run.runSeq, 2);
      });

      it('ends in WAIT_TIMEOUT naming the terminals when none settles within the deadline', async () => {
        LeaderRegistry.getInstance().setLeader('terminal-lead', true);
        const { catalogue } = build();
        writeRun('terminal-w1', 'running', 1);
        writeRun('terminal-plain', 'running', 1);
        await assert.rejects(
          () => catalogue.dispatch('terminal.wait', { sessionIds: ['terminal-w1', 'terminal-plain'], timeoutMs: 200 }, ctx()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'WAIT_TIMEOUT' && JSON.stringify(err.details?.sessionIds) === JSON.stringify(['terminal-w1', 'terminal-plain'])
        );
      });

      it('never polls a sleeping terminal and says so; all asleep answers SESSION_SLEEPING', async () => {
        LeaderRegistry.getInstance().setLeader('terminal-lead', true);
        const rows = rowsOf().map((row) => (row.id === 'terminal-w1' ? { ...row, state: 'sleeping' } : row));
        const { catalogue } = build(rows);
        writeRun('terminal-w1', 'idle', 9);
        writeRun('terminal-plain', 'idle', 4);
        const waited = (await catalogue.dispatch('terminal.wait', { sessionIds: ['terminal-w1', 'terminal-plain'], timeoutMs: 1000 }, ctx())) as {
          sessionId: string; sleepingSessionIds?: string[];
        };
        assert.strictEqual(waited.sessionId, 'terminal-plain', 'the idle file of the sleeping terminal did not answer');
        assert.deepStrictEqual(waited.sleepingSessionIds, ['terminal-w1']);

        const allAsleep = build(rowsOf().map((row) => (row.id === 'terminal-w1' || row.id === 'terminal-plain' ? { ...row, state: 'sleeping' } : row)));
        const sleeping = (await allAsleep.catalogue.dispatch('terminal.wait', { sessionIds: ['terminal-w1', 'terminal-plain'], timeoutMs: 1000 }, ctx())) as {
          satisfied: boolean; code: string; sleepingSessionIds?: string[];
        };
        assert.strictEqual(sleeping.satisfied, false);
        assert.strictEqual(sleeping.code, 'SESSION_SLEEPING');
        assert.deepStrictEqual(sleeping.sleepingSessionIds, ['terminal-w1', 'terminal-plain']);
      });

      it('validates the list: only run-idle, at most 16 ids, strings only, and every id inside the caller reach', async () => {
        LeaderRegistry.getInstance().setLeader('terminal-lead', true);
        const { catalogue } = build();
        const invalid = code('INVALID_ARGUMENT');
        await assert.rejects(() => catalogue.dispatch('terminal.wait', { sessionIds: ['terminal-w1'], condition: 'exit' }, ctx()), invalid);
        await assert.rejects(() => catalogue.dispatch('terminal.wait', { sessionIds: Array.from({ length: 17 }, (_, i) => `t-${i}`) }, ctx()), invalid);
        await assert.rejects(() => catalogue.dispatch('terminal.wait', { sessionIds: ['terminal-w1', 7] }, ctx()), invalid);
        await assert.rejects(() => catalogue.dispatch('terminal.wait', { sessionIds: [] }, ctx()), invalid);
        await assert.rejects(() => catalogue.dispatch('terminal.wait', { sessionIds: ['terminal-w1', 'terminal-lead'], timeoutMs: 50 }, ctx()), code('TERMINAL_FORBIDDEN'));
        await assert.rejects(
          () => catalogue.dispatch('terminal.wait', { sessionIds: ['terminal-w1', 'terminal-plain'], timeoutMs: 50 }, attachmentContext('att-plain')),
          code('TERMINAL_FORBIDDEN')
        );
      });
    });

    describe('terminal.list hook build status', () => {
      it('flags a terminal whose OMP runs a different run-state hook build than the installed one', async () => {
        LeaderRegistry.getInstance().setLeader('terminal-lead', true);
        const { catalogue } = build(undefined, undefined, {}, { installedHookSha256: () => 'sha-installed' });
        writeRun('terminal-w1', 'idle', 1, { hookSha256: 'sha-installed' });
        writeRun('terminal-plain', 'idle', 1, { hookSha256: 'sha-old' });
        writeRun('split-w1', 'idle', 1);
        const listed = (await catalogue.dispatch('terminal.list', {}, ctx())) as { sessions: Array<{ id: string; hookSha256?: string; hookOutdated?: boolean }> };
        const byId = new Map(listed.sessions.map((row) => [row.id, row]));
        assert.strictEqual(byId.get('terminal-w1')?.hookOutdated, false);
        assert.strictEqual(byId.get('terminal-w1')?.hookSha256, 'sha-installed');
        assert.strictEqual(byId.get('terminal-plain')?.hookOutdated, true);
        assert.strictEqual(byId.get('terminal-plain')?.hookSha256, 'sha-old');
        assert.strictEqual(byId.get('split-w1')?.hookOutdated, true, 'a hook that reports no build predates build identities');
        assert.ok(!('hookSha256' in (byId.get('split-w1') ?? {})));
      });

      it('reports nothing it cannot prove: no installed identity, or no run file', async () => {
        LeaderRegistry.getInstance().setLeader('terminal-lead', true);
        const { catalogue } = build(undefined, undefined, {}, { installedHookSha256: () => undefined });
        writeRun('terminal-w1', 'idle', 1, { hookSha256: 'sha-old' });
        const listed = (await catalogue.dispatch('terminal.list', {}, ctx())) as { sessions: Array<{ id: string; hookSha256?: string; hookOutdated?: boolean }> };
        const withRun = listed.sessions.find((row) => row.id === 'terminal-w1');
        assert.strictEqual(withRun?.hookSha256, 'sha-old');
        assert.ok(!('hookOutdated' in (withRun ?? {})));
        const noRun = listed.sessions.find((row) => row.id === 'terminal-plain');
        assert.ok(!('hookOutdated' in (noRun ?? {})) && !('hookSha256' in (noRun ?? {})));
      });
    });

    describe('removing the project a placement minted', () => {
      const SCRATCH_ROOT = path.join(SCRATCH_DIR, 'leader-scratch');
      let restoreRoots: () => void;
      let previousRoots: string | undefined;
      const removals: string[] = [];
      let removalOutcome: () => Promise<LeaderMintedProjectRemoval>;
      let unregisterRemoval: () => void;

      beforeEach(() => {
        previousRoots = process.env.ANTIFAN_LEADER_SCRATCH_ROOTS;
        process.env.ANTIFAN_LEADER_SCRATCH_ROOTS = SCRATCH_ROOT;
        removals.length = 0;
        removalOutcome = async () => ({ status: 'REMOVED', projectId: 'project-gone' });
        unregisterRemoval = registerLeaderProjectRemovalPort({
          removeMintedProject: async ({ capsuleId }) => {
            removals.push(capsuleId);
            return removalOutcome();
          },
        });
        restoreRoots = () => {
          if (previousRoots === undefined) delete process.env.ANTIFAN_LEADER_SCRATCH_ROOTS;
          else process.env.ANTIFAN_LEADER_SCRATCH_ROOTS = previousRoots;
          unregisterRemoval();
        };
      });

      const withRestore = async (run: () => Promise<void>): Promise<void> => {
        try {
          await run();
        } finally {
          restoreRoots();
        }
      };

      const placeAndBuild = async (cwd: string, minted: boolean, sessionId = 'terminal-new') => {
        LeaderRegistry.getInstance().setLeader('terminal-lead', true);
        const release = registerLeaderPlacementPort({
          placeTerminal: async (): Promise<LeaderPlacementResult> => ({
            ok: true,
            sessionId,
            ownerKey: 'project:p9',
            capsuleId: 'capsule-9',
            ...(minted ? { minted: { capsuleId: 'capsule-9' } } : {}),
          }),
        });
        const rows = [...rowsOf(), { id: sessionId, cwd, state: 'running', ownerKey: 'project:p9' }];
        const built = build(rows);
        try {
          const created = (await built.catalogue.dispatch('terminal.create', { cwd, name: 'Row 9' }, ctx())) as { minted?: { capsuleId: string } };
          return { ...built, created };
        } finally {
          release();
        }
      };

      it('terminal.create reports `minted` and records it in the registry only when the placement created the project', async () => {
        await withRestore(async () => {
          const cwd = path.join(SCRATCH_ROOT, 'job-a');
          const minted = await placeAndBuild(cwd, true);
          assert.deepStrictEqual(minted.created.minted, { capsuleId: 'capsule-9' });
          assert.strictEqual(LeaderRegistry.getInstance().mintedOf('terminal-new')?.capsuleId, 'capsule-9');
          assert.strictEqual(LeaderRegistry.getInstance().mintedOf('terminal-new')?.workspacePath, path.resolve(cwd));

          LeaderRegistry.resetInstance();
          const reloaded = LeaderRegistry.getInstance().mintedOf('terminal-new');
          assert.strictEqual(reloaded?.capsuleId, 'capsule-9', 'the record survives a restart');

          fs.rmSync(path.join(CONFIG_DIR, 'leader-terminals.json'), { force: true });
          LeaderRegistry.resetInstance();
          const existing = await placeAndBuild(cwd, false);
          assert.strictEqual(existing.created.minted, undefined);
          assert.strictEqual(LeaderRegistry.getInstance().mintedOf('terminal-new'), undefined);
        });
      });

      it('terminal.close removeMintedProject removes exactly the project this placement minted, under the scratch folder', async () => {
        await withRestore(async () => {
          const { catalogue, calls } = await placeAndBuild(path.join(SCRATCH_ROOT, 'job-b'), true);
          const result = (await catalogue.dispatch('terminal.close', { sessionId: 'terminal-new', removeMintedProject: true }, ctx())) as {
            closed: boolean; projectRemoval: { status: string; projectId?: string };
          };
          assert.deepStrictEqual(calls.closedBases, ['terminal-new']);
          assert.strictEqual(result.closed, true);
          assert.strictEqual(result.projectRemoval.status, 'REMOVED');
          assert.deepStrictEqual(removals, ['capsule-9']);
          assert.strictEqual(LeaderRegistry.getInstance().mintedOf('terminal-new'), undefined, 'a removed project leaves no record');
        });
      });

      it('keeps the minted record after a refused removal, so closing the last worker in the folder finishes it', async () => {
        await withRestore(async () => {
          const cwd = path.join(SCRATCH_ROOT, 'job-g');
          removalOutcome = async () => ({ status: 'REFUSED', reason: 'LIVE_TERMINALS_IN_PROJECT', liveSessions: 1 });
          const first = await placeAndBuild(cwd, true, 'terminal-a');
          const second = await placeAndBuild(cwd, false, 'terminal-b');
          assert.strictEqual(second.created.minted, undefined, 'the second worker did not mint the project');
          assert.strictEqual(LeaderRegistry.getInstance().mintedOf('terminal-b')?.capsuleId, 'capsule-9', 'but it is recorded as placed in the minted capsule');

          const refused = (await first.catalogue.dispatch('terminal.close', { sessionId: 'terminal-a', removeMintedProject: true }, ctx())) as { projectRemoval: { status: string } };
          assert.strictEqual(refused.projectRemoval.status, 'REFUSED');
          // The host forgets a closed terminal's records as soon as it is closed.
          LeaderRegistry.getInstance().forget('terminal-a');
          assert.strictEqual(LeaderRegistry.getInstance().mintedOf('terminal-a'), undefined);
          assert.strictEqual(LeaderRegistry.getInstance().mintedOf('terminal-b')?.capsuleId, 'capsule-9', 'the refusal did not lose the record');

          removalOutcome = async () => ({ status: 'REMOVED', projectId: 'project-gone' });
          const done = (await second.catalogue.dispatch('terminal.close', { sessionId: 'terminal-b', removeMintedProject: true }, ctx())) as { projectRemoval: { status: string } };
          assert.strictEqual(done.projectRemoval.status, 'REMOVED');
          assert.deepStrictEqual(removals, ['capsule-9', 'capsule-9']);
          assert.strictEqual(LeaderRegistry.getInstance().mintedOf('terminal-b'), undefined, 'a removed project leaves no record');
        });
      });

      it('a closed terminal keeps no placement but the capsule record survives a restart, and a file keyed by terminal id still loads', async () => {
        const registry = LeaderRegistry.getInstance();
        assert.strictEqual(registry.recordMinted('terminal-m', { capsuleId: 'capsule-m', workspacePath: path.join(SCRATCH_ROOT, 'm') }), true);
        assert.strictEqual(registry.recordJoined('terminal-j', 'capsule-m'), true);
        assert.strictEqual(registry.recordJoined('terminal-x', 'capsule-unknown'), false, 'a capsule nobody minted is never recorded as joined');
        registry.forget('terminal-m');
        LeaderRegistry.resetInstance();
        assert.strictEqual(LeaderRegistry.getInstance().mintedOf('terminal-m'), undefined);
        assert.strictEqual(LeaderRegistry.getInstance().mintedOf('terminal-j')?.capsuleId, 'capsule-m');
        assert.strictEqual(LeaderRegistry.getInstance().clearMinted('capsule-m'), true);
        assert.strictEqual(LeaderRegistry.getInstance().mintedOf('terminal-j'), undefined, 'clearing the capsule clears every placement that named it');

        fs.writeFileSync(
          path.join(CONFIG_DIR, 'leader-terminals.json'),
          JSON.stringify({ schema: 1, leaders: [], workers: {}, minted: { 'terminal-old': { capsuleId: 'capsule-old', workspacePath: path.join(SCRATCH_ROOT, 'old'), mintedAt: 5 } } }),
          'utf8',
        );
        LeaderRegistry.resetInstance();
        assert.strictEqual(LeaderRegistry.getInstance().mintedOf('terminal-old')?.capsuleId, 'capsule-old');
      });

      it('refuses a folder outside the scratch allowlist and never calls the host', async () => {
        await withRestore(async () => {
          const { catalogue } = await placeAndBuild(path.join(SCRATCH_DIR, 'real-project'), true);
          const result = (await catalogue.dispatch('terminal.close', { sessionId: 'terminal-new', removeMintedProject: true }, ctx())) as {
            closed: boolean; projectRemoval: { status: string; reason?: string };
          };
          assert.strictEqual(result.closed, true, 'the terminal is still closed');
          assert.strictEqual(result.projectRemoval.status, 'REFUSED');
          assert.match(result.projectRemoval.reason ?? '', /OUTSIDE_SCRATCH_ALLOWLIST/);
          assert.deepStrictEqual(removals, []);
        });
      });

      it('the scratch root itself and a sibling that merely shares its prefix are outside the allowlist', async () => {
        await withRestore(async () => {
          for (const cwd of [SCRATCH_ROOT, `${SCRATCH_ROOT}-other${path.sep}job`]) {
            LeaderRegistry.resetInstance();
            const { catalogue } = await placeAndBuild(cwd, true);
            const result = (await catalogue.dispatch('terminal.close', { sessionId: 'terminal-new', removeMintedProject: true }, ctx())) as {
              projectRemoval: { status: string };
            };
            assert.strictEqual(result.projectRemoval.status, 'REFUSED', cwd);
          }
          assert.deepStrictEqual(removals, []);
        });
      });

      it('SKIPPED for a worker whose placement did not mint the project, so a pre-existing project is never touched', async () => {
        await withRestore(async () => {
          const { catalogue } = await placeAndBuild(path.join(SCRATCH_ROOT, 'job-c'), false);
          const result = (await catalogue.dispatch('terminal.close', { sessionId: 'terminal-new', removeMintedProject: true }, ctx())) as {
            projectRemoval: { status: string; reason?: string };
          };
          assert.strictEqual(result.projectRemoval.status, 'SKIPPED');
          assert.match(result.projectRemoval.reason ?? '', /NOT_MINTED_BY_PLACEMENT/);
          const other = (await build().catalogue.dispatch('terminal.close', { sessionId: 'terminal-w1', removeMintedProject: true }, ctx())) as {
            projectRemoval: { status: string };
          };
          assert.strictEqual(other.projectRemoval.status, 'SKIPPED', 'a terminal that was never a placement');
          assert.deepStrictEqual(removals, []);
        });
      });

      it('passes a host refusal or failure through, and an exception from the host becomes FAILED', async () => {
        await withRestore(async () => {
          for (const [outcome, expected] of [
            [async (): Promise<LeaderMintedProjectRemoval> => ({ status: 'REFUSED', reason: 'LIVE_TERMINALS_REMAIN', liveSessions: 2 }), 'REFUSED'],
            [async (): Promise<LeaderMintedProjectRemoval> => ({ status: 'NO_PROJECT' }), 'NO_PROJECT'],
            [async (): Promise<LeaderMintedProjectRemoval> => { throw new Error('window gate vetoed'); }, 'FAILED'],
          ] as const) {
            LeaderRegistry.resetInstance();
            removalOutcome = outcome;
            const { catalogue } = await placeAndBuild(path.join(SCRATCH_ROOT, 'job-d'), true);
            const result = (await catalogue.dispatch('terminal.close', { sessionId: 'terminal-new', removeMintedProject: true }, ctx())) as {
              projectRemoval: { status: string; reason?: string };
            };
            assert.strictEqual(result.projectRemoval.status, expected);
            if (expected === 'FAILED') assert.match(result.projectRemoval.reason ?? '', /window gate vetoed/);
          }
        });
      });

      it('does not touch the project when the terminal itself could not be closed', async () => {
        await withRestore(async () => {
          const { catalogue, calls } = await placeAndBuild(path.join(SCRATCH_ROOT, 'job-e'), true);
          calls.closeResult = false;
          const result = (await catalogue.dispatch('terminal.close', { sessionId: 'terminal-new', removeMintedProject: true }, ctx())) as {
            closed: boolean; projectRemoval: { status: string; reason?: string };
          };
          assert.strictEqual(result.closed, false);
          assert.strictEqual(result.projectRemoval.status, 'SKIPPED');
          assert.match(result.projectRemoval.reason ?? '', /TERMINAL_NOT_CLOSED/);
          assert.deepStrictEqual(removals, []);
        });
      });

      it('is a Leader-only option and must be a boolean; a plain close removes nothing', async () => {
        await withRestore(async () => {
          const { catalogue } = await placeAndBuild(path.join(SCRATCH_ROOT, 'job-f'), true);
          await assert.rejects(() => catalogue.dispatch('terminal.close', { sessionId: 'terminal-new', removeMintedProject: 'yes' }, ctx()), code('INVALID_ARGUMENT'));
          const rows = rowsOf();
          rows.push({ id: 'split-mine', cwd: 'E:/Work/third', state: 'running', ownerKey: 'project:p3', splitOf: 'terminal-plain' });
          await assert.rejects(
            () => build(rows).catalogue.dispatch('terminal.close', { sessionId: 'split-mine', removeMintedProject: true }, attachmentContext('att-plain')),
            code('TERMINAL_FORBIDDEN')
          );
          const plain = await catalogue.dispatch('terminal.close', { sessionId: 'terminal-new' }, ctx());
          assert.deepStrictEqual(plain, { closed: true });
          assert.deepStrictEqual(removals, []);
        });
      });
    });
  });
});
