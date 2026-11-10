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
import { approvalsDirOf, normalizeRoot } from '../../src/omp-hooks/theme-push-approval';
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
    await assert.rejects(() => write('att-w', 'split-w', 'hrv theme push --only sections/header.liquid --nodelete\r'), refusedWith('REFUSED_THEME_PUSH_UNVERIFIED'));
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

  it('gates a caller with no worker record like a worker: a theme publish is refused, an ordinary line is delivered unchanged', async () => {
    installHrvStub('main');
    const { write, calls } = build();
    await assert.rejects(() => write('att-plain', 'split-plain', 'hrv theme publish 1\r'), refusedWith('REFUSED_THEME_REMOTE_OP'));
    await write('att-plain', 'split-plain', 'echo ok\r');
    assert.deepStrictEqual(calls.writes, [{ sessionId: 'split-plain', input: 'echo ok\r' }]);
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

  it('serialises concurrent writes to one pane through the capability: a slow probe does not let a later write overtake it', async () => {
    installHrvStub('unpublished', 300);
    const { write, calls } = build();
    // Fired without awaiting, as an agent running parallel tool calls would.
    const settled = await Promise.allSettled([
      write('att-w', 'split-w', 'hrv theme dev\r'),
      write('att-w', 'split-w', 'hrv th'),
      write('att-w', 'split-w', 'eme publish 1\r'),
    ]);
    assert.deepStrictEqual(settled.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected']);
    assert.deepStrictEqual(calls.writes.map((w) => w.input), ['hrv theme dev\r', 'hrv th', '\x03']);
    const refusal = settled[2] as PromiseRejectedResult;
    assert.ok(refusedWith('REFUSED_THEME_REMOTE_OP')(refusal.reason), 'the completed publish is refused as a remote operation');
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

  describe('a push to the bound theme', () => {
    const PUSH = 'hrv theme push --only assets/a.css sections/hero.liquid --nodelete';
    const approvalsDir = (): string => approvalsDirOf(DATA_ROOT);
    const kept = (): string[] => (fs.existsSync(approvalsDir()) ? fs.readdirSync(approvalsDir()).sort() : []);
    const approve = (): string => {
      fs.mkdirSync(approvalsDir(), { recursive: true });
      const id = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      fs.writeFileSync(
        path.join(approvalsDir(), `${id}.json`),
        JSON.stringify({
          schema: 'leader-push-approval/1',
          id,
          leader: 'terminal-lead',
          worker: 'terminal-w',
          job: null,
          themeId: '1001507144',
          cwd: normalizeRoot(THEME_ROOT),
          files: ['assets/a.css', 'sections/hero.liquid'],
          quote: 'ok, push lên đi',
          approvedAt: now,
          expiresAt: now + 30 * 60_000,
        })
      );
      return id;
    };

    beforeEach(() => {
      fs.rmSync(approvalsDir(), { recursive: true, force: true });
    });

    for (const role of ['main', 'unpublished'] as const) {
      it(`is written as typed on a ${role === 'main' ? 'live' : 'copy'} theme once hrv theme info reports the bound id, with no approval spent`, async () => {
        const stub = installHrvStub(role);
        const { write, calls } = build();
        const id = approve();
        const lines = [PUSH, 'hrv theme push --nodelete -x config/settings_data.json', 'hrv theme push --only config/settings_data.json --nodelete'];
        for (const line of lines) {
          const result = await write('att-w', 'split-w', `${line}\r`);
          assert.strictEqual(result.written, true, line);
        }
        assert.deepStrictEqual(calls.writes.map((w) => w.input), lines.map((line) => `${line}\r`));
        assert.strictEqual(stub.recorded().length, lines.length, 'one probe per line, before its keystrokes went out');
        assert.deepStrictEqual(kept(), [`${id}.json`], 'no push needs an approval');
      });
    }

    it('stays refused on the live theme when the line leaves the rule, and nothing is written', async () => {
      installHrvStub('main');
      const { write, calls } = build();
      for (const [line, code] of [
        [`${PUSH} --force`, THEME_PUSH_CODES.PUSH_SCOPE],
        [`${PUSH} --prune`, THEME_PUSH_CODES.PUSH_SCOPE],
        ['hrv theme push --only assets/a.css', THEME_PUSH_CODES.PUSH_NODELETE],
        ['hrv theme push', THEME_PUSH_CODES.PUSH_NODELETE],
        ['hrv theme push --nodelete', THEME_PUSH_CODES.PUSH_SETTINGS_DATA],
        ['hrv theme push 999 --only assets/a.css', THEME_PUSH_CODES.PUSH_FOREIGN_THEME],
        [`${PUSH} && echo done`, THEME_PUSH_CODES.COMPLEX],
        [`${PUSH}; echo done`, THEME_PUSH_CODES.COMPLEX],
        ['hrv theme dev', THEME_PUSH_CODES.PUSH_LIVE],
        ['hrv theme publish 1001507144', THEME_PUSH_CODES.REMOTE_OP],
        ['shopify theme push', THEME_PUSH_CODES.PUSH_SCOPE],
        ['sapo theme push', THEME_PUSH_CODES.REMOTE_OP],
      ] as const) {
        await assert.rejects(() => write('att-w', 'split-w', `${line}\r`), refusedWith(code), line);
      }
      assert.deepStrictEqual(calls.writes, []);
    });

    it('is refused when hrv theme info reports another theme id than the bound one', async () => {
      const dir = fs.mkdtempSync(path.join(SCRATCH_DIR, 'hrv-other-'));
      const script = path.join(dir, 'hrv.mjs');
      fs.writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify({ theme_id: 777, name: 'Other', role: 'unpublished', org_id: '200001' }))});`);
      process.env[HRV_COMMAND_ENV] = `"${process.execPath}" "${script}"`;
      const { write, calls } = build();
      await assert.rejects(() => write('att-w', 'split-w', `${PUSH}\r`), refusedWith(THEME_PUSH_CODES.PUSH_UNVERIFIED));
      assert.deepStrictEqual(calls.writes, []);
    });

    it('refuses a worker that tries to record an approval through the terminal, and writes nothing', async () => {
      installHrvStub('main');
      const { write, calls } = build();
      for (const line of [
        'node E:/Work/apps/AntiFan/scripts/leader/leader-job.mjs approve-push --worker terminal-w --theme 1001507144 --cwd . --files a --quote q',
        'echo {} > %ANTIFAN_DATA_ROOT%\\runtime\\leader-push-approvals\\x.json',
      ]) {
        await assert.rejects(() => write('att-w', 'split-w', `${line}\r`), refusedWith('REFUSED_THEME_APPROVAL_SELF'), line);
      }
      assert.deepStrictEqual(calls.writes, []);
      assert.deepStrictEqual(kept(), []);
    });
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

  describe('a Leader\'s chat message to the agent CLI of a worker pane', () => {
    const runsDir = path.join(DATA_ROOT, 'runtime', 'runs');
    const writeRun = (terminalId: string, state: 'idle' | 'running' | 'waiting_user' | 'ended', extra: { updatedAt?: number } = {}): void => {
      fs.writeFileSync(
        path.join(runsDir, `${terminalId}.json`),
        JSON.stringify({
          schema: 1,
          terminalSessionId: terminalId,
          ompSessionId: `omp-${terminalId}`,
          pid: process.pid,
          cwd: THEME_ROOT,
          mode: 'unset',
          state,
          runSeq: 1,
          runStartedAt: 1,
          lastEventAt: 2,
          promptHead: 'prompt',
          updatedAt: extra.updatedAt ?? Date.now(),
        }),
        'utf8'
      );
    };
    beforeEach(() => {
      for (const name of fs.readdirSync(runsDir)) fs.rmSync(path.join(runsDir, name), { force: true });
    });
    after(() => {
      for (const name of fs.readdirSync(runsDir)) fs.rmSync(path.join(runsDir, name), { force: true });
    });

    const setup = (facadeOverrides: Record<string, unknown> = {}) => {
      const built = build({ deliveryWaitMs: 0 }, facadeOverrides);
      const send = (sessionId: string, args: Record<string, unknown>, attachment = 'att-lead') =>
        built.catalogue.dispatch('terminal.write', { sessionId, ...args }, attachmentContext(attachment)) as Promise<{ written: boolean; message?: string }>;
      return { ...built, send };
    };
    const invalidArgument = (err: unknown): boolean => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT';

    it('delivers prose that a shell line would refuse (trailing comma, open bracket, a backticked CLI mention) and presses Enter, never Ctrl-C', async () => {
      writeRun('split-w', 'idle');
      const { send, calls } = setup();
      const text = 'Chạy `hrv theme dev`, rồi báo lại (xong,';
      const result = await send('split-w', { message: text });
      assert.strictEqual(result.written, true);
      assert.deepStrictEqual(calls.writes, [
        { sessionId: 'split-w', input: text },
        { sessionId: 'split-w', input: '\r' },
      ]);
    });

    it('cannot be used to run a history-recalled line: input, ctrl-c, up, then a message is refused and no Enter follows the up', async () => {
      writeRun('split-w', 'idle');
      const { send, calls } = setup();
      await send('split-w', { input: '!hrv theme publish 1 #' });
      await send('split-w', { key: 'ctrl-c' });
      await send('split-w', { key: 'up' });
      await assert.rejects(
        () => send('split-w', { message: 'chạy đi' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'POLICY_DENIED'
      );
      assert.deepStrictEqual(calls.writes.map((w) => w.input), ['!hrv theme publish 1 #', '\x03', '\x1b[A']);
      // Ctrl-C clears the taint: the next message goes through.
      await send('split-w', { key: 'ctrl-c' });
      const result = await send('split-w', { message: 'chạy đi' });
      assert.strictEqual(result.written, true);
    });

    it('refuses up+enter on an idle run, still delivers down,down,enter as one write while an ask dialog is open, and keeps esc and side arrows agent-owned', async () => {
      writeRun('split-w', 'idle');
      const { send, calls } = setup();
      await assert.rejects(() => send('split-w', { keys: ['up', 'enter'] }), refusedWith('REFUSED_THEME_COMPLEX'));
      assert.deepStrictEqual(calls.writes.filter((w) => w.input !== '\x03'), []);
      await send('split-w', { keys: ['left', 'right'] });
      await send('split-w', { key: 'esc' });
      const ok = await send('split-w', { message: 'hello' });
      assert.strictEqual(ok.written, true, 'left, right and esc left no taint behind');

      writeRun('split-w', 'waiting_user');
      calls.writes.length = 0;
      const answered = await send('split-w', { keys: ['down', 'down', 'enter'] });
      assert.strictEqual(answered.written, true);
      assert.deepStrictEqual(calls.writes.map((w) => w.input), ['\x1b[B\x1b[B\r']);
    });

    it('refuses a message while an ask dialog is open, even with force', async () => {
      writeRun('split-w', 'waiting_user');
      const { send, calls } = setup();
      const waiting = (err: unknown): boolean => err instanceof CapabilityError && err.code === 'TERMINAL_BUSY' && /ask dialog/.test(err.message);
      await assert.rejects(() => send('split-w', { message: 'hello' }), waiting);
      await assert.rejects(() => send('split-w', { message: 'hello', force: true }), waiting);
      assert.deepStrictEqual(calls.writes, []);
    });

    it('judges the whole message while a turn runs with force:true: a theme command anywhere is refused, prose passes, esc still works', async () => {
      writeRun('split-w', 'running');
      const { send, calls } = setup();
      await assert.rejects(() => send('split-w', { message: 'cd theme && hrv theme publish 1', force: true }), refusedWith('REFUSED_THEME_REMOTE_OP'));
      assert.strictEqual(calls.writes.length, 0);
      await send('split-w', { key: 'esc', force: true });
      const result = await send('split-w', { message: 'bạn làm tiếp nhé', force: true });
      assert.strictEqual(result.written, true);
      assert.deepStrictEqual(calls.writes.map((w) => w.input), ['\x1b', 'bạn làm tiếp nhé', '\r']);
    });

    it('refuses a message that starts with a slash command, and delivers one that has a slash later', async () => {
      writeRun('split-w', 'idle');
      const { send, calls } = setup();
      await assert.rejects(() => send('split-w', { message: '/exit' }), invalidArgument);
      await assert.rejects(() => send('split-w', { message: '  /new' }), invalidArgument);
      assert.deepStrictEqual(calls.writes, []);
      const result = await send('split-w', { message: 'a/b' });
      assert.strictEqual(result.written, true);
      for (const hidden of ['\u00ad/exit', '\u061c!x', '\u2066x']) {
        await assert.rejects(() => send('split-w', { message: hidden }), invalidArgument);
      }
    });

    it('judges a message whose first word is a theme command as a shell line and writes nothing', async () => {
      writeRun('split-w', 'idle');
      const { send, calls } = setup();
      await assert.rejects(() => send('split-w', { message: 'hrv theme publish 1' }), refusedWith('REFUSED_THEME_REMOTE_OP'));
      await assert.rejects(() => send('split-w', { message: '  hrv theme publish 1' }), refusedWith('REFUSED_THEME_REMOTE_OP'));
      assert.deepStrictEqual(calls.writes, []);
    });

    it('refuses every message that starts with a shell or code passthrough sigil, and writes nothing', async () => {
      writeRun('split-w', 'idle');
      const { send, calls } = setup();
      for (const message of [
        '!!hrv theme publish 1',
        '!cd . && hrv theme push --force',
        "$import os; os.system('hrv theme publish 1')",
        '!cd other-folder',
        '  !ls',
        '$ hrv theme publish 1',
        '!hrv theme publish 1',
        '&x',
        '>x',
      ]) {
        await assert.rejects(() => send('split-w', { message }), invalidArgument, message);
      }
      assert.deepStrictEqual(calls.writes, []);
    });

    it('refuses a sigil message at the gate too, so the refusal does not depend on the argument layer', async () => {
      const gate = new WorkerTerminalInputGate({ probeTimeoutMs: 1_000 });
      for (const message of ['!!hrv theme publish 1', ' $x', '&x', '>x']) {
        const verdict = await gate.inspectMessage('t', message, THEME_ROOT);
        assert.strictEqual(verdict.decision, 'block', message);
        assert.strictEqual(verdict.decision === 'block' && verdict.code, THEME_PUSH_CODES.COMPLEX);
        assert.strictEqual(verdict.decision === 'block' && verdict.interruptPending, false);
      }
      assert.strictEqual((await gate.inspectMessage('t', 'giá $5, xong chưa!', THEME_ROOT)).decision, 'allow');
    });

    it('delivers prose that carries a sigil later in the line', async () => {
      writeRun('split-w', 'idle');
      const { send, calls } = setup();
      const text = 'giá $5, xong chưa!';
      const result = await send('split-w', { message: text });
      assert.strictEqual(result.written, true);
      assert.deepStrictEqual(calls.writes.map((w) => w.input), [text, '\r']);
    });

    it('never points a refused command at message: a Leader input that starts with a sigil or a theme command is refused without the hint', async () => {
      installHrvStub('main');
      const { send, calls } = setup();
      await assert.rejects(
        () => send('split-w', { input: '!hrv theme publish 1\r' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'POLICY_DENIED' && !/message/.test(err.message)
      );
      assert.deepStrictEqual(calls.writes, []);
    });

    it('is refused, with nothing written, for a pane without a run file, with an ended run or with a stale run', async () => {
      const { send, calls } = setup();
      const notRunning = (err: unknown): boolean => err instanceof CapabilityError && err.code === 'OMP_NOT_RUNNING' && /message is only for a pane running the agent CLI/.test(err.message) && /input/.test(err.message);
      await assert.rejects(() => send('split-w', { message: 'hello' }), notRunning);
      writeRun('split-w', 'ended');
      await assert.rejects(() => send('split-w', { message: 'hello' }), notRunning);
      writeRun('split-w', 'idle', { updatedAt: Date.now() - 10 * 60_000 });
      await assert.rejects(() => send('split-w', { message: 'hello' }), notRunning);
      assert.deepStrictEqual(calls.writes, []);
    });

    it('is TERMINAL_BUSY while a turn runs, and force:true types it anyway', async () => {
      writeRun('split-w', 'running');
      const { send, calls } = setup();
      await assert.rejects(() => send('split-w', { message: 'hello' }), (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_BUSY');
      assert.strictEqual(calls.writes.length, 0);
      const forced = await send('split-w', { message: 'hello', force: true });
      assert.strictEqual(forced.written, true);
      assert.deepStrictEqual(calls.writes.map((w) => w.input), ['hello', '\r']);
    });

    it('refuses a multi-line message, a tab, a control character, an empty one and one over the line cap as INVALID_ARGUMENT', async () => {
      writeRun('split-w', 'idle');
      const { send, calls } = setup();
      // C1 controls, Unicode line separators and invisible format characters are refused too: a zero-width
      // character in front of `!` would otherwise hide the passthrough sigil from the leading-character rule.
      for (const message of ['a\nb', 'a\r\nb', 'a\tb', 'a\x1bb', '   ', 'x'.repeat(8 * 1024 + 1), 'a\u0085b', 'a\u2028b', '\u200b!ls', '\ufeff$x', 'a\u202eb']) {
        await assert.rejects(() => send('split-w', { message }), invalidArgument, JSON.stringify(message.slice(0, 20)));
      }
      await assert.rejects(() => send('split-w', { message: 'a\nb' }), (err: unknown) => err instanceof CapabilityError && /file/.test(err.message));
      assert.deepStrictEqual(calls.writes, []);
    });

    it('is refused while the pane holds text typed earlier that was never entered, and leaves that text alone', async () => {
      writeRun('split-w', 'idle');
      const { send, calls } = setup();
      await send('split-w', { input: 'echo half' });
      await assert.rejects(
        () => send('split-w', { message: 'hello' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'POLICY_DENIED' && /Clear the line first/.test(err.message)
      );
      assert.deepStrictEqual(calls.writes.map((w) => w.input), ['echo half'], 'no Ctrl-C and nothing of the message');
      // The held text is still tracked: a later Enter completes exactly that line.
      await send('split-w', { key: 'enter' });
      assert.strictEqual(calls.writes.at(-1)?.input, '\r');
    });

    it('is refused for a worker caller, and together with input, key or keys', async () => {
      writeRun('split-w', 'idle');
      const { send, calls } = setup();
      await assert.rejects(() => send('split-w', { message: 'hello' }, 'att-w'), invalidArgument);
      await assert.rejects(() => send('split-w', { message: 'hello', input: 'x' }), invalidArgument);
      await assert.rejects(() => send('split-w', { message: 'hello', key: 'enter' }), invalidArgument);
      await assert.rejects(() => send('split-w', { message: 'hello', keys: ['enter'] }), invalidArgument);
      assert.deepStrictEqual(calls.writes, []);
    });

    it('does not press Enter when the agent ended after the text was typed: the text is cleared and the result says written:false', async () => {
      writeRun('split-w', 'idle');
      const writes: string[] = [];
      const { send } = setup({
        writeTo: async (_sessionId: string, input: string) => {
          writes.push(input);
          if (input === 'bye') writeRun('split-w', 'ended');
          return true;
        },
      });
      const result = await send('split-w', { message: 'bye' });
      assert.strictEqual(result.written, false);
      assert.match(result.message ?? '', /Enter was NOT sent/);
      assert.deepStrictEqual(writes, ['bye', '\x03'], 'the typed text is erased the way a refused line is, and no Enter follows');
    });

    it('keeps judging input as a shell line: a theme command into a shell pane is refused as before, and a continuation refusal for a Leader names `message`', async () => {
      installHrvStub('main');
      const { send, calls } = setup();
      await assert.rejects(() => send('split-w', { input: 'hrv theme dev\r' }), refusedWith('REFUSED_THEME_PUSH_LIVE'));
      await assert.rejects(
        () => send('split-w', { input: 'Chạy lệnh này,\r' }),
        (err: unknown) => refusedWith('REFUSED_THEME_COMPLEX')(err) && /pass it as `message`/.test((err as Error).message)
      );
      await assert.rejects(
        () => send('split-w', { input: 'ec\tho x\r' }),
        (err: unknown) => refusedWith('REFUSED_THEME_COMPLEX')(err) && /pass it as `message`/.test((err as Error).message)
      );
      assert.deepStrictEqual(calls.writes.map((w) => w.input).filter((input) => input !== '\x03'), []);
      // A worker is not a Leader: the same refusal carries no hint.
      await assert.rejects(
        () => send('split-w', { input: 'Chạy lệnh này,\r' }, 'att-w'),
        (err: unknown) => refusedWith('REFUSED_THEME_COMPLEX')(err) && !/`message`/.test((err as Error).message)
      );
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
