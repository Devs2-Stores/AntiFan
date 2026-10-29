import { setTimeout as delay } from 'node:timers/promises';
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
import { WorkerTerminalInputGate, lineContinues } from '../../src/main/tools/worker-terminal-input-gate';
import { THEME_PUSH_CODES } from '../../src/omp-hooks/theme-push-policy';
import {
  CapabilityError,
  issueRuntimeLease,
  makeControlPlaneId,
  type RuntimeLease,
} from '../../src/shared/control-plane-contracts';

/**
 * What a Leader's worker types through `terminal.write`, against the production capability code
 * and a fake terminal manager. A stand-in `hrv` answers `theme info -j`, so the verdicts are the real
 * ones the hook gives for the same lines. Registry and run files live in a scratch directory.
 */
const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-worker-input-gate-'));
const CONFIG_DIR = path.join(SCRATCH_DIR, 'config');
const DATA_ROOT = path.join(SCRATCH_DIR, 'data');
const THEME_ROOT = path.join(SCRATCH_DIR, 'theme');
const HRV_COMMAND_ENV = 'ANTIFAN_HRV_COMMAND';
const SAVED_ENV = {
  config: process.env.ANTIFAN_CONFIG_DIR,
  data: process.env.ANTIFAN_DATA_ROOT,
  hrv: process.env[HRV_COMMAND_ENV],
};
process.env.ANTIFAN_CONFIG_DIR = CONFIG_DIR;
process.env.ANTIFAN_DATA_ROOT = DATA_ROOT;
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_ROOT, 'runtime', 'runs'), { recursive: true });
fs.mkdirSync(THEME_ROOT, { recursive: true });
fs.writeFileSync(
  path.join(THEME_ROOT, '.haravan-cli_local.json'),
  JSON.stringify({ org_id: '200001', theme_id: '1001507144', theme_name: 'Stub', theme_org_id: '200001' })
);

interface FakeRow {
  id: string;
  cwd: string;
  state: string;
  ownerKey?: string;
  splitOf?: string;
}

/** An `hrv` that records every call and answers `theme info -j` for the bound theme with `role`, after `delayMs`. */
function installHrvStub(role: 'unpublished' | 'main', delayMs = 0): { recorded: () => Array<{ argv: string[] }> } {
  const dir = fs.mkdtempSync(path.join(SCRATCH_DIR, 'hrv-stub-'));
  const calls = path.join(dir, 'calls.jsonl');
  const script = path.join(dir, 'hrv.mjs');
  const body = `- Đang lấy thông tin theme...\n${JSON.stringify({ theme_id: 1001507144, name: 'Stub', role, org_id: '200001' }, null, 2)}`;
  fs.writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");`,
      `await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
      `console.log(${JSON.stringify(body)});`,
    ].join('\n')
  );
  process.env[HRV_COMMAND_ENV] = `"${process.execPath}" "${script}"`;
  return {
    recorded: () => (fs.existsSync(calls)
      ? fs.readFileSync(calls, 'utf8').trim().split('\n').map((row) => JSON.parse(row) as { argv: string[] })
      : []),
  };
}

describe('A Leader worker typing through terminal.write', () => {
  let lease: RuntimeLease;
  let projectId: string;
  let workspaceId: string;

  before(() => {
    projectId = makeControlPlaneId('project');
    workspaceId = makeControlPlaneId('workspace');
    lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);
  });

  after(async () => {
    LeaderRegistry.resetInstance();
    for (const [key, value] of [
      ['ANTIFAN_CONFIG_DIR', SAVED_ENV.config],
      ['ANTIFAN_DATA_ROOT', SAVED_ENV.data],
      [HRV_COMMAND_ENV, SAVED_ENV.hrv],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // A probe the budget cut off may still be exiting inside the scratch folder (its cwd), and Windows
    // refuses to remove a folder a live process holds. Retry until that process is gone.
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt >= 40) throw err;
        await delay(250);
      }
    }
  });

  beforeEach(() => {
    LeaderRegistry.resetInstance();
    fs.rmSync(path.join(CONFIG_DIR, 'leader-terminals.json'), { force: true });
    const registry = LeaderRegistry.getInstance();
    registry.setLeader('terminal-lead', true);
    registry.assignWorker('terminal-w', 'terminal-lead', 'Row 7');
  });

  const attachmentContext = (attachmentId: string) => ({
    attachmentId,
    runId: 'run-gate',
    attemptId: 'attempt-gate',
    projectId,
    workspaceId,
    backendId: 'backend-gate',
    hostEpoch: 1,
    invocationId: 'invocation-gate',
    lease,
    leaseToken: lease.token,
    grant: 'write' as const,
  });

  const rowsOf = (): FakeRow[] => [
    { id: 'terminal-lead', cwd: 'E:/Work/lead', state: 'running', ownerKey: 'project:p0' },
    // The worker's home shell and its sync-watcher split pane, started in the bound theme folder.
    { id: 'terminal-w', cwd: THEME_ROOT, state: 'running', ownerKey: 'project:p2' },
    { id: 'split-w', cwd: THEME_ROOT, state: 'running', ownerKey: 'project:p2', splitOf: 'terminal-w' },
    // A plain terminal nobody drives, with its own split.
    { id: 'terminal-plain', cwd: THEME_ROOT, state: 'running', ownerKey: 'project:p3' },
    { id: 'split-plain', cwd: THEME_ROOT, state: 'running', ownerKey: 'project:p3', splitOf: 'terminal-plain' },
    { id: 'split-w2', cwd: THEME_ROOT, state: 'running', ownerKey: 'project:p2', splitOf: 'terminal-w' },
  ];

  const build = (deps: TerminalCapabilityDeps = {}, facadeOverrides: Record<string, unknown> = {}) => {
    const rows = rowsOf();
    const calls = { writes: [] as Array<{ sessionId: string; input: string }>, splitCreates: [] as string[] };
    let minted = 0;
    const facade = {
      listSessions: () => rows.map((row) => ({ ...row })),
      getSession: (id: string) => rows.find((row) => row.id === id),
      getActiveSessionId: () => 'split-w',
      writeTo: async (sessionId: string, input: string) => {
        calls.writes.push({ sessionId, input });
        return true;
      },
      resizeTo: () => {},
      closeSplitSession: async () => true,
      closeSession: async () => true,
      createSplitSession: async (parentId: string) => {
        calls.splitCreates.push(parentId);
        minted += 1;
        return `split-new-${minted}`;
      },
      createSession: async () => 'terminal-unscoped',
      ...facadeOverrides,
    } as unknown as TerminalManager;
    const homes: Record<string, string> = { 'att-lead': 'terminal-lead', 'att-w': 'terminal-w', 'att-plain': 'terminal-plain' };
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
    registerTerminalCapabilities(catalogue, facade, ownership, deps);
    const write = (attachment: string, sessionId: string, input: string, signal?: AbortSignal) =>
      catalogue.dispatch('terminal.write', { sessionId, input }, { ...attachmentContext(attachment), ...(signal ? { signal } : {}) }) as Promise<{ written: boolean }>;
    return { calls, catalogue, write };
  };

  const refusedWith = (refusalCode: string) => (err: unknown): boolean =>
    err instanceof CapabilityError &&
    err.code === 'POLICY_DENIED' &&
    err.details?.refusalCode === refusalCode &&
    err.message.startsWith(refusalCode);

  it('may restart the sync watcher on its bound draft theme: the line is allowed after one hrv theme info -j probe', async () => {
    const stub = installHrvStub('unpublished');
    const { write, calls } = build();
    const result = await write('att-w', 'split-w', 'hrv theme dev\r');
    assert.strictEqual(result.written, true);
    assert.deepStrictEqual(calls.writes, [{ sessionId: 'split-w', input: 'hrv theme dev\r' }]);
    assert.deepStrictEqual(stub.recorded().map((call) => call.argv.join(' ')), ['theme info -j'], 'the draft was proven once, before the keystrokes went out');
  });

  it('is refused when the bound theme is the shop\'s live theme, and nothing is written', async () => {
    installHrvStub('main');
    const { write, calls } = build();
    await assert.rejects(() => write('att-w', 'split-w', 'hrv theme dev\r'), refusedWith('REFUSED_THEME_PUSH_LIVE'));
    assert.deepStrictEqual(calls.writes, []);
  });

  it('cannot assemble a publish from chunks: the completed line is refused, the half-typed text is cleared with Ctrl-C, and nothing of the refused call is written', async () => {
    installHrvStub('unpublished');
    const { write, calls } = build();
    await write('att-w', 'split-w', 'hrv th');
    await assert.rejects(() => write('att-w', 'split-w', 'eme publish 1\r'), refusedWith('REFUSED_THEME_REMOTE_OP'));
    assert.deepStrictEqual(
      calls.writes.map((w) => w.input),
      ['hrv th', '\x03'],
      'the first chunk went out, the second did not, and the shell line was interrupted'
    );

    // The buffer is empty again: the next plain line is judged on its own.
    await write('att-w', 'split-w', 'hrv theme info\r');
    assert.strictEqual(calls.writes.at(-1)?.input, 'hrv theme info\r');
  });

  it('reads and answers a plain read action without any probe', async () => {
    const stub = installHrvStub('unpublished');
    const { write, calls } = build();
    await write('att-w', 'split-w', 'hrv theme info\r');
    assert.deepStrictEqual(calls.writes.map((w) => w.input), ['hrv theme info\r']);
    assert.deepStrictEqual(stub.recorded(), []);
  });

  it('refuses a sync whose probe does not answer inside the budget', async () => {
    installHrvStub('unpublished', 2_000);
    const { write, calls } = build({ probeTimeoutMs: 300 });
    const started = Date.now();
    await assert.rejects(() => write('att-w', 'split-w', 'hrv theme push --only sections/header.liquid\r'), refusedWith('REFUSED_THEME_PUSH_UNVERIFIED'));
    assert.ok(Date.now() - started < 1_500, 'the call answered at the probe budget, not when hrv finally returned');
    assert.deepStrictEqual(calls.writes, []);
  });

  it('cannot trust the folder after a cd: a later sync in the same terminal is unverifiable, while reads stay allowed', async () => {
    const stub = installHrvStub('unpublished');
    const { write, calls } = build();
    await write('att-w', 'split-w', 'cd ..\r');
    await assert.rejects(() => write('att-w', 'split-w', 'hrv theme push --only f\r'), refusedWith('REFUSED_THEME_PUSH_UNVERIFIED'));
    await write('att-w', 'split-w', 'hrv theme info\r');
    assert.deepStrictEqual(calls.writes.map((w) => w.input), ['cd ..\r', 'hrv theme info\r']);
    assert.deepStrictEqual(stub.recorded(), [], 'no probe ran from a folder that may no longer be the theme root');
  });

  it('is judged on the line the shell will run: an Esc sequence or history recall is refused, Backspace edits the line', async () => {
    installHrvStub('unpublished');
    const { write, calls } = build();
    // Up-arrow then Enter re-runs whatever the shell remembers: unreadable, so refused.
    await assert.rejects(() => write('att-w', 'split-w', '\x1b[A\r'), refusedWith('REFUSED_THEME_COMPLEX'));
    await assert.rejects(() => write('att-w', 'split-w', 'ec\tho\r'), refusedWith('REFUSED_THEME_COMPLEX'));
    assert.strictEqual(calls.writes.length, 0);

    // Backspace removes exactly one character: the shell runs `hrv theme info`, not `hrv theme infx`.
    await write('att-w', 'split-w', 'hrv theme infx\x7fo\r');
    assert.deepStrictEqual(calls.writes.map((w) => w.input), ['hrv theme infx\x7fo\r']);
    // The reverse: a line that only becomes a publish after editing is refused.
    await assert.rejects(() => write('att-w', 'split-w', 'hrv theme infox\x7f\x7f\x7f\x7f\x7fpublish 1\r'), refusedWith('REFUSED_THEME_REMOTE_OP'));
  });

  it('refuses every control key it cannot follow, whole chunk at once, so no key binding can reorder or erase a publish', async () => {
    installHrvStub('unpublished');
    const { write, calls } = build();
    for (const key of ['\x15', '\x00', '\x01', '\x05', '\x0b', '\x0f', '\x17', '\x1a']) {
      await assert.rejects(
        () => write('att-w', 'split-w', `hrv theme publish 1${key}\r`),
        (err: unknown) => refusedWith('REFUSED_THEME_COMPLEX')(err) && /control key/.test((err as Error).message),
        `control byte 0x${key.charCodeAt(0).toString(16)}`
      );
    }
    // Ctrl-U in particular is not an erase: whether it clears the line depends on the shell.
    await assert.rejects(() => write('att-w', 'split-w', 'hrv theme publish 1\x15hrv theme info\r'), refusedWith('REFUSED_THEME_COMPLEX'));
    assert.strictEqual(calls.writes.length, 0, 'nothing of a refused chunk is written');
    // Ctrl-C is the one key that abandons the line, and it is delivered like any other input.
    await write('att-w', 'split-w', 'hrv th\x03hrv theme info\r');
    assert.deepStrictEqual(calls.writes.map((w) => w.input), ['hrv th\x03hrv theme info\r']);
  });

  it('refuses a line the shell would join with the next one, because each physical line is judged alone', async () => {
    installHrvStub('unpublished');
    const { write, calls } = build();
    for (const line of ['hrv `', 'hrv \\', 'hrv ^', 'hrv theme info |', 'hrv theme info &&', 'hrv theme info,', 'echo "half', "echo 'half", 'foreach ($x in 1) {', 'echo (1']) {
      await assert.rejects(() => write('att-w', 'split-w', `${line}\r`), refusedWith('REFUSED_THEME_COMPLEX'), line);
    }
    assert.strictEqual(calls.writes.length, 0);
    // The second half of a split command is then never judged on its own: the first half was refused.
    await write('att-w', 'split-w', 'echo "a b" (c) {d} [e]\r');
    assert.deepStrictEqual(calls.writes.map((w) => w.input), ['echo "a b" (c) {d} [e]\r']);
  });

  it('refuses the next Enter after a Ctrl-C that was not delivered, until a Ctrl-C is delivered', async () => {
    installHrvStub('unpublished');
    let interruptWorks = false;
    const attempts: string[] = [];
    const { write, calls } = build({}, {
      writeTo: async (sessionId: string, input: string) => {
        attempts.push(input);
        if (input === '\x03' && !interruptWorks) return false;
        calls.writes.push({ sessionId, input });
        return true;
      },
    });
    await write('att-w', 'split-w', 'hrv th');
    await assert.rejects(() => write('att-w', 'split-w', 'eme publish 1\r'), (err: unknown) => refusedWith('REFUSED_THEME_REMOTE_OP')(err) && (err as CapabilityError).details?.interruptDelivered === false);
    // The shell still holds `hrv th`: the completion of it must not pass as an innocent word.
    interruptWorks = true;
    await assert.rejects(() => write('att-w', 'split-w', 'eme publish 1\r'), refusedWith('REFUSED_THEME_COMPLEX'));
    assert.deepStrictEqual(attempts, ['hrv th', '\x03', '\x03'], 'the second refusal cleared the line');
    await write('att-w', 'split-w', 'eme publish 1\r');
    assert.strictEqual(calls.writes.at(-1)?.input, 'eme publish 1\r');
  });

  it('taints the line too when the Ctrl-C write throws, and still answers with the refusal', async () => {
    installHrvStub('unpublished');
    let throwing = true;
    const { write, calls } = build({}, {
      writeTo: async (sessionId: string, input: string) => {
        if (input === '\x03' && throwing) throw new Error('daemon unreachable');
        calls.writes.push({ sessionId, input });
        return true;
      },
    });
    await write('att-w', 'split-w', 'hrv th');
    await assert.rejects(() => write('att-w', 'split-w', 'eme publish 1\r'), refusedWith('REFUSED_THEME_REMOTE_OP'));
    throwing = false;
    await assert.rejects(() => write('att-w', 'split-w', 'eme publish 1\r'), refusedWith('REFUSED_THEME_COMPLEX'));
  });

  it('does not type anything once the call was aborted, and leaves the line buffer as it was', async () => {
    installHrvStub('unpublished', 400);
    const { write, calls } = build({ probeTimeoutMs: 5_000 });
    const controller = new AbortController();
    // The first line is probed (slow), the second is left half-typed.
    const pending = write('att-w', 'split-w', 'hrv theme dev\rhrv th', controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(() => pending, (err: unknown) => err instanceof Error && /aborted/.test(err.message));
    assert.strictEqual(calls.writes.length, 0, 'nothing reached the shell');
    // The half-typed `hrv th` was never delivered, so it is not remembered: this is an unknown word, not a publish.
    await write('att-w', 'split-w', 'eme publish 1\r');
    assert.strictEqual(calls.writes.at(-1)?.input, 'eme publish 1\r');
  });

  it('gives all probes of one call a single budget', async () => {
    installHrvStub('unpublished', 800);
    const { write, calls } = build({ probeTimeoutMs: 1_400 });
    // Each probe alone fits the budget; the second one finds it spent.
    await assert.rejects(() => write('att-w', 'split-w', 'hrv theme dev\rhrv theme dev\r'), refusedWith('REFUSED_THEME_PUSH_UNVERIFIED'));
    assert.strictEqual(calls.writes.length, 0);
  });

  it('keeps the stricter reading of a write that was not confirmed: a half-typed line it may have left is not forgotten', async () => {
    installHrvStub('unpublished');
    let confirm = false;
    const { write, calls } = build({}, {
      writeTo: async (sessionId: string, input: string) => {
        calls.writes.push({ sessionId, input });
        return input === 'hrv th' ? confirm : true;
      },
    });
    const result = await write('att-w', 'split-w', 'hrv th');
    assert.strictEqual(result.written, false);
    confirm = true;
    // The daemon may have delivered `hrv th` before the call failed, so what follows cannot be judged alone.
    await assert.rejects(() => write('att-w', 'split-w', 'eme publish 1\r'), refusedWith('REFUSED_THEME_COMPLEX'));
  });

  it('cannot slip a theme command behind a bracketed paste, a CRLF or a second line in one call', async () => {
    installHrvStub('unpublished');
    const { write, calls } = build();
    await assert.rejects(() => write('att-w', 'split-w', 'echo hi\r\nhrv theme publish 1\r\n'), refusedWith('REFUSED_THEME_REMOTE_OP'));
    await assert.rejects(() => write('att-w', 'split-w', '\x1b[200~hrv theme publish 1\x1b[201~\r'), refusedWith('REFUSED_THEME_REMOTE_OP'));
    assert.deepStrictEqual(calls.writes, [], 'a refused call writes none of its lines, including the harmless first one');
  });

  it('is not slowed or changed for a caller with no worker record, nor for a Leader', async () => {
    installHrvStub('main');
    const { write, calls } = build();
    // A plain agent in its own split pane: no worker record, so the line is its own business.
    await write('att-plain', 'split-plain', 'hrv theme publish 1\r');
    // A Leader driving a worker types whatever it decides to.
    await write('att-lead', 'terminal-w', 'hrv theme publish 1\r');
    assert.deepStrictEqual(calls.writes, [
      { sessionId: 'split-plain', input: 'hrv theme publish 1\r' },
      { sessionId: 'terminal-w', input: 'hrv theme publish 1\r' },
    ]);
  });

  it('keeps each target\'s line to itself: half a line in one pane is not continued by another pane', async () => {
    installHrvStub('unpublished');
    const { write, calls } = build();
    await write('att-w', 'split-w', 'hrv th');
    // The same continuation that completes a publish in split-w is just an unknown word in split-w2.
    await write('att-w', 'split-w2', 'eme publish 1\r');
    assert.deepStrictEqual(calls.writes.map((w) => w.input), ['hrv th', 'eme publish 1\r']);
    await assert.rejects(() => write('att-w', 'split-w', 'eme publish 1\r'), refusedWith('REFUSED_THEME_REMOTE_OP'));
  });

  it('keeps the stricter reading when the write itself throws: the half line it may have left is not forgotten', async () => {
    installHrvStub('unpublished');
    let throwing = false;
    const { write } = build({}, {
      writeTo: async (_sessionId: string, input: string) => {
        if (throwing && input === 'hrv th') throw new Error('pty gone');
        return true;
      },
    });
    throwing = true;
    await assert.rejects(() => write('att-w', 'split-w', 'hrv th'), /pty gone/);
    throwing = false;
    await assert.rejects(() => write('att-w', 'split-w', 'eme publish 1\r'), refusedWith('REFUSED_THEME_COMPLEX'));
  });

  it('forgets the half-typed line of a pane it closed, and keeps it when the close did not happen', async () => {
    installHrvStub('unpublished');
    let closes = true;
    const { catalogue, write, calls } = build({}, { closeSplitSession: async () => closes });
    await write('att-w', 'split-w', 'hrv th');
    closes = false;
    assert.deepStrictEqual(await catalogue.dispatch('terminal.close', { sessionId: 'split-w' }, attachmentContext('att-w')), { closed: false });
    await assert.rejects(() => write('att-w', 'split-w', 'eme publish 1\r'), refusedWith('REFUSED_THEME_REMOTE_OP'));
    closes = true;
    assert.deepStrictEqual(await catalogue.dispatch('terminal.close', { sessionId: 'split-w' }, attachmentContext('att-w')), { closed: true });
    calls.writes.length = 0;
    await write('att-w', 'split-w', 'eme publish 1\r');
    assert.deepStrictEqual(calls.writes.map((w) => w.input), ['eme publish 1\r'], 'the closed pane no longer remembers its half line');
  });

  it('does not send Ctrl-C to a sleeping pane when it refuses a line, because that write would wake it', async () => {
    installHrvStub('unpublished');
    const sleeping = new Set<string>();
    const { write, calls } = build({}, {
      getSession: (id: string) => {
        const row = rowsOf().find((r) => r.id === id);
        return row && sleeping.has(id) ? { ...row, state: 'sleeping' } : row;
      },
    });
    await write('att-w', 'split-w', 'hrv th');
    sleeping.add('split-w');
    calls.writes.length = 0;
    await assert.rejects(() => write('att-w', 'split-w', 'eme publish 1\r'), refusedWith('REFUSED_THEME_REMOTE_OP'));
    assert.deepStrictEqual(calls.writes, [], 'nothing, not even the interrupt, reached the sleeping pane');
  });

  it('refuses a sync in a pane whose start folder is unknown, because the theme it would push cannot be verified', async () => {
    const stub = installHrvStub('unpublished');
    const { write, calls } = build({}, { listSessions: () => rowsOf().map(({ cwd: _cwd, ...row }) => row) });
    await assert.rejects(() => write('att-w', 'split-w', 'hrv theme push --only f\r'), refusedWith(THEME_PUSH_CODES.PUSH_UNVERIFIED));
    assert.deepStrictEqual(calls.writes, []);
    assert.strictEqual(stub.recorded().length, 0, 'no probe ran against a folder nobody knows');
  });

  describe('terminal.create from a worker', () => {
    it('registers the split as the same Leader\'s worker, including after the Leader flag was cleared', async () => {
      installHrvStub('unpublished');
      const { catalogue, write, calls } = build();
      const registry = LeaderRegistry.getInstance();

      const first = (await catalogue.dispatch('terminal.create', {}, attachmentContext('att-w'))) as { sessionId: string };
      assert.strictEqual(registry.workerOf(first.sessionId)?.leaderId, 'terminal-lead', 'an OMP started in the split finds a record and is gated');

      registry.setLeader('terminal-lead', false);
      assert.strictEqual(registry.workerOf('terminal-w')?.leaderId, 'terminal-lead', 'the worker outlives the cleared Leader flag');
      const second = (await catalogue.dispatch('terminal.create', {}, attachmentContext('att-w'))) as { sessionId: string };
      assert.notStrictEqual(second.sessionId, first.sessionId);
      assert.strictEqual(registry.workerOf(second.sessionId)?.leaderId, 'terminal-lead', 'the orphan\'s split is gated too');
      assert.deepStrictEqual(calls.splitCreates, ['terminal-w', 'terminal-w']);

      // The orphan is still held to the push rules through terminal.write.
      await assert.rejects(() => write('att-w', 'split-w', 'hrv theme publish 1\r'), refusedWith('REFUSED_THEME_REMOTE_OP'));
    });

    it('registers nothing for a caller that is not a worker', async () => {
      const { catalogue } = build();
      const created = (await catalogue.dispatch('terminal.create', {}, attachmentContext('att-plain'))) as { sessionId: string };
      assert.strictEqual(LeaderRegistry.getInstance().workerOf(created.sessionId), undefined);
    });

    it('starts a worker\'s split with no run history, in case a closed id is handed out again', async () => {
      const { catalogue } = build();
      const runsDir = path.join(DATA_ROOT, 'runtime', 'runs');
      const staleCard = path.join(runsDir, 'split-new-1.json');
      fs.writeFileSync(staleCard, '{}');
      await catalogue.dispatch('terminal.create', {}, attachmentContext('att-w'));
      assert.strictEqual(fs.existsSync(staleCard), false, 'a card left by the previous owner of the id is gone');
    });

    it('says so when a split that could not be recorded could not be closed either', async () => {
      const { catalogue } = build({}, { closeSplitSession: async () => false });
      const registryFile = path.join(CONFIG_DIR, 'leader-terminals.json');
      fs.rmSync(registryFile, { force: true });
      fs.mkdirSync(registryFile);
      try {
        await assert.rejects(
          () => catalogue.dispatch('terminal.create', {}, attachmentContext('att-w')),
          (err: unknown) => err instanceof CapabilityError && err.code === 'EXECUTION_ERROR' && /could not be closed: it is still open and ungated/.test(err.message) && err.details?.closed === false
        );
      } finally {
        fs.rmSync(registryFile, { recursive: true, force: true });
      }
    });
  });
});

describe('WorkerTerminalInputGate line buffer', () => {
  it('knows which lines the shell would join with the next one', () => {
    for (const line of ['a `', 'a \\', 'a ^', 'a |', 'a &&', 'a,', 'echo "x', "echo 'x", 'f {', 'f (', 'f [', 'echo "a \\" b']) {
      assert.strictEqual(lineContinues(line), true, line);
    }
    for (const line of ['', '   ', 'echo hi', 'echo "a b"', "echo 'a b'", 'echo (1) {2} [3]', 'echo ")"', 'dir C:\\x\\ -r']) {
      assert.strictEqual(lineContinues(line), false, line);
    }
  });

  it('drops a target that holds nothing first, and a target with an untrusted cwd last, when the map is full', async () => {
    const gate = new WorkerTerminalInputGate({ probeTimeoutMs: 1_000 });
    await gate.inspect('keep', 'cd ..\r', THEME_ROOT);
    for (let i = 0; i < 255; i += 1) await gate.inspect(`half-${i}`, 'x', THEME_ROOT);
    await gate.inspect('newest', 'hrv th', THEME_ROOT);

    const kept = await gate.inspect('keep', 'hrv theme push --only f\r', THEME_ROOT);
    assert.strictEqual(kept.decision, 'block', 'the folder the shell left is still not trusted');
    assert.strictEqual(kept.decision === 'block' && kept.code, THEME_PUSH_CODES.PUSH_UNVERIFIED);
    const newest = await gate.inspect('newest', 'eme publish 1\r', THEME_ROOT);
    assert.strictEqual(newest.decision === 'block' && newest.code, THEME_PUSH_CODES.REMOTE_OP, 'the newest half-typed line was kept');
  });

  it('runs the calls of one target one after another in call order, a failed call does not stop the next, and targets do not wait for each other', async () => {
    const gate = new WorkerTerminalInputGate({ probeTimeoutMs: 1_000 });
    const order: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = gate.run('t', async () => { await held; order.push('first'); });
    const failing = gate.run('t', async () => { order.push('failing'); throw new Error('boom'); });
    const last = gate.run('t', async () => { order.push('last'); });
    await gate.run('other', async () => { order.push('other'); });
    assert.deepStrictEqual(order, ['other'], 'queued calls wait for the one before them, another target does not');
    release();
    await Promise.all([first, last, assert.rejects(() => failing, /boom/)]);
    assert.deepStrictEqual(order, ['other', 'first', 'failing', 'last']);
  });
});
