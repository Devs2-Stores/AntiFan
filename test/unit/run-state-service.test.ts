import type nodeAssert from 'node:assert';
const { describe, test, before, after } = require('node:test');
const assert: typeof nodeAssert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Stage TypeScript files as .mts in a temporary directory for ESM dynamic loading in Node.
// __dirname is test/unit in source and .compiled/test/unit after tsc — probe the
// anchor file so both layouts resolve the real repository root.
let repoRoot = path.resolve(__dirname, '..', '..');
if (!fs.existsSync(path.join(repoRoot, 'src', 'shared', 'contracts.ts'))) {
  repoRoot = path.resolve(repoRoot, '..');
}
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-run-state-stage-'));

// 1. Stage contracts.mts
fs.mkdirSync(path.join(stageDir, 'shared'), { recursive: true });
fs.writeFileSync(
  path.join(stageDir, 'shared', 'contracts.mts'),
  fs.readFileSync(path.join(repoRoot, 'src', 'shared', 'contracts.ts'), 'utf8'),
);

// 2. Stage bridge-health.mts exporting isPidAlive (the only symbol run-state-service imports from bridge)
fs.mkdirSync(path.join(stageDir, 'main', 'bridge'), { recursive: true });
fs.writeFileSync(
  path.join(stageDir, 'main', 'bridge', 'bridge-health.mts'),
  `export function isPidAlive(pid: number): boolean {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      return (err as { code?: string })?.code === 'EPERM';
    }
  }`,
);
// 3. Stage run-state-service.mts with rewritten module specifiers
fs.mkdirSync(path.join(stageDir, 'main', 'run'), { recursive: true });
const runStateSrc = fs.readFileSync(path.join(repoRoot, 'src', 'main', 'run', 'run-state-service.ts'), 'utf8')
  .replace("from '../../shared/contracts.js'", "from '../../shared/contracts.mts'")
  .replace("from '../bridge/bridge-health.js'", "from '../bridge/bridge-health.mts'");
fs.writeFileSync(path.join(stageDir, 'main', 'run', 'run-state-service.mts'), runStateSrc);

interface RunCardLike {
  terminalSessionId: string;
  ompSessionId?: string;
  state: string;
  stale: boolean;
  mode: string;
  runSeq: number;
  runStartedAt?: number;
  lastEventAt?: number;
  lastTool?: string;
  promptHead?: string;
  cwd?: string;
  capsuleId?: string;
  viewOnly: boolean;
  controlPlane?: { runId: string; attemptId?: string; backendId: string };
  changes?: { files: string[]; fileCount: number; blockedCount: number };
}

interface RunStateServiceConstructor {
  new (options: unknown): {
    start(): void;
    stop(): void;
    sweepSync(): void;
    on(event: string, listener: () => void): unknown;
    removeListener(event: string, listener: () => void): unknown;
    getRunsSync(): RunCardLike[];
    runCardsForWindow(runs: RunCardLike[], senderId?: string | number): RunCardLike[];
    readChanges(cwd?: string, ompSessionId?: string, runSeq?: number): { files: string[]; fileCount: number; blockedCount: number } | undefined;
    pruneSync(): void;
    syncBriefsSync(explicitSessions?: unknown[]): void;
  };
}

let RunStateService: RunStateServiceConstructor;
let RUN_STALE_MS: number;
let RUN_PRUNE_ENDED_MS: number;
let RUN_CHANGES_MAX_FILES: number;

describe('RunStateService Suite', () => {
  let tempRoot: string;
  let runsDir: string;
  let workspaceDir: string;
  let clockTime = 100_000;

  before(async () => {
    // Dynamic import to load staged ESM .mts in a CommonJS test environment
    const mod = await import(pathToFileURL(path.join(stageDir, 'main', 'run', 'run-state-service.mts')).href);
    RunStateService = mod.RunStateService;
    RUN_STALE_MS = mod.RUN_STALE_MS;
    RUN_PRUNE_ENDED_MS = mod.RUN_PRUNE_ENDED_MS;
    RUN_CHANGES_MAX_FILES = mod.RUN_CHANGES_MAX_FILES;

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-run-state-test-'));
    runsDir = path.join(tempRoot, 'runtime', 'runs');
    workspaceDir = path.join(tempRoot, 'workspace');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.antifan', 'edit-guard'), { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(stageDir, { recursive: true, force: true });
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  });

  test('1. fresh run card projection', () => {
    clockTime = 100_000;
    const sessionMap = new Map([
      ['session-fresh', { id: 'session-fresh', capsuleId: 'cap-1' }],
    ]);

    const service = new RunStateService({
      runsDir,
      lookupSession: (id: string) => sessionMap.get(id),
      lookupCapsule: () => 'cap-1',
      isProcessAlive: (pid: number) => pid === 1234,
      clock: () => clockTime,
      watch: false,
    });

    const runFile = path.join(runsDir, 'session-fresh.json');
    fs.writeFileSync(
      runFile,
      JSON.stringify({
        schema: 1,
        terminalSessionId: 'session-fresh',
        ompSessionId: 'omp-fresh-1',
        pid: 1234,
        cwd: workspaceDir,
        mode: 'direct',
        state: 'running',
        runSeq: 3,
        runStartedAt: 95_000,
        lastEventAt: 99_000,
        lastTool: 'edit',
        promptHead: 'Implement run card feature',
        updatedAt: 99_500,
      }),
      'utf8',
    );

    const runs = service.getRunsSync();
    assert.strictEqual(runs.length, 1);
    const card = runs[0];
    assert.ok(card);
    assert.strictEqual(card.terminalSessionId, 'session-fresh');
    assert.strictEqual(card.ompSessionId, 'omp-fresh-1');
    assert.strictEqual(card.state, 'running');
    assert.strictEqual(card.stale, false);
    assert.strictEqual(card.mode, 'direct');
    assert.strictEqual(card.runSeq, 3);
    assert.strictEqual(card.runStartedAt, 95_000);
    assert.strictEqual(card.lastEventAt, 99_000);
    assert.strictEqual(card.lastTool, 'edit');
    assert.strictEqual(card.promptHead, 'Implement run card feature');
    assert.strictEqual(card.capsuleId, 'cap-1');
    assert.strictEqual(card.viewOnly, false);
  });

  test('2. stale projection for dead pid and for old heartbeat', () => {
    clockTime = 100_000;
    const sessionMap = new Map([
      ['session-dead-pid', { id: 'session-dead-pid' }],
      ['session-old-beat', { id: 'session-old-beat' }],
    ]);

    const service = new RunStateService({
      runsDir,
      lookupSession: (id: string) => sessionMap.get(id),
      isProcessAlive: (pid: number) => pid === 5555, // 4444 is dead
      clock: () => clockTime,
      watch: false,
    });

    // Dead PID run file (updated recently, but process is dead)
    fs.writeFileSync(
      path.join(runsDir, 'session-dead-pid.json'),
      JSON.stringify({
        schema: 1,
        terminalSessionId: 'session-dead-pid',
        ompSessionId: 'omp-dead',
        pid: 4444, // dead
        cwd: workspaceDir,
        mode: 'fast',
        state: 'running',
        runSeq: 1,
        updatedAt: clockTime - 5_000,
      }),
      'utf8',
    );

    // Old heartbeat run file (process alive, but updatedAt older than RUN_STALE_MS = 45s)
    fs.writeFileSync(
      path.join(runsDir, 'session-old-beat.json'),
      JSON.stringify({
        schema: 1,
        terminalSessionId: 'session-old-beat',
        ompSessionId: 'omp-slow',
        pid: 5555, // alive
        cwd: workspaceDir,
        mode: 'core',
        state: 'waiting_user',
        runSeq: 1,
        updatedAt: clockTime - (RUN_STALE_MS + 1_000), // > 45s
      }),
      'utf8',
    );

    const runs = service.getRunsSync();
    const deadPidCard = runs.find((r) => r.terminalSessionId === 'session-dead-pid');
    const oldBeatCard = runs.find((r) => r.terminalSessionId === 'session-old-beat');

    assert.ok(deadPidCard);
    assert.strictEqual(deadPidCard.state, 'ended', 'dead pid must project as ended');
    assert.strictEqual(deadPidCard.stale, true, 'dead pid must project as stale');

    assert.ok(oldBeatCard);
    assert.strictEqual(oldBeatCard.state, 'ended', 'heartbeat older than RUN_STALE_MS must project as ended');
    assert.strictEqual(oldBeatCard.stale, true, 'heartbeat older than RUN_STALE_MS must project as stale');

    // Clean up
    fs.unlinkSync(path.join(runsDir, 'session-dead-pid.json'));
    fs.unlinkSync(path.join(runsDir, 'session-old-beat.json'));
  });

  test('3. ended surviving naturally without becoming stale', () => {
    clockTime = 100_000;
    const service = new RunStateService({
      runsDir,
      lookupSession: (id: string) => ({ id }),
      isProcessAlive: () => false, // even if pid is dead
      clock: () => clockTime,
      watch: false,
    });

    // Run file with state: 'ended' written by session_shutdown
    fs.writeFileSync(
      path.join(runsDir, 'session-ended.json'),
      JSON.stringify({
        schema: 1,
        terminalSessionId: 'session-ended',
        ompSessionId: 'omp-ended',
        pid: 7777,
        cwd: workspaceDir,
        mode: 'direct',
        state: 'ended',
        runSeq: 1,
        updatedAt: clockTime - 100_000, // old heartbeat
      }),
      'utf8',
    );

    const runs = service.getRunsSync();
    const endedCard = runs.find((r) => r.terminalSessionId === 'session-ended');

    assert.ok(endedCard);
    assert.strictEqual(endedCard.state, 'ended');
    assert.strictEqual(endedCard.stale, false, 'ended surviving natural shutdown must not project stale: true');

    fs.unlinkSync(path.join(runsDir, 'session-ended.json'));
  });

  test('4. *.brief.json never read as a run file and never pruned by a run-file rule', () => {
    clockTime = 100_000;
    const service = new RunStateService({
      runsDir,
      lookupSession: (id: string) => (id === 'session-with-brief' ? { id } : undefined),
      isProcessAlive: () => true,
      clock: () => clockTime,
      watch: false,
    });

    const briefPath = path.join(runsDir, 'session-with-brief.brief.json');
    fs.writeFileSync(
      briefPath,
      JSON.stringify({
        schema: 1,
        terminalSessionId: 'session-with-brief',
        capsuleId: 'cap-brief',
        briefSeq: 1234,
        brief: { siteName: 'Test Brief Store' },
        updatedAt: clockTime,
      }),
      'utf8',
    );

    // Projection: must carve out *.brief.json
    const runs = service.getRunsSync();
    const briefAsRun = runs.find((r) => r.terminalSessionId === 'session-with-brief');
    assert.strictEqual(briefAsRun, undefined, 'brief file must NEVER be projected as a run card');

    // Prune: brief file must NOT be deleted by run-file rules (missing terminalSessionId, etc.)
    service.pruneSync();
    assert.ok(fs.existsSync(briefPath), 'brief mirror must survive prune when its session is live');

    fs.unlinkSync(briefPath);
  });

  test('5. prune of an ended-for-24h file, of a run file whose session is gone, and of an orphaned control dir', () => {
    clockTime = 200_000_000;
    const liveSessions = new Set(['session-live', 'session-ended-recent', 'session-boundary']);

    const service = new RunStateService({
      runsDir,
      lookupSession: (id: string) => (liveSessions.has(id) ? { id } : undefined),
      isProcessAlive: () => true,
      clock: () => clockTime,
      watch: false,
    });

    // 1. Ended for > 24h (strictly greater than RUN_PRUNE_ENDED_MS = 86_400_000 ms)
    const oldEndedPath = path.join(runsDir, 'session-ended-old.json');
    fs.writeFileSync(
      oldEndedPath,
      JSON.stringify({
        schema: 1,
        terminalSessionId: 'session-ended-old',
        ompSessionId: 'omp-ended-old',
        pid: 1001,
        state: 'ended',
        runSeq: 1,
        updatedAt: clockTime - (RUN_PRUNE_ENDED_MS + 10), // strictly > 24h
      }),
      'utf8',
    );
    liveSessions.add('session-ended-old');

    // 2. Ended at EXACT boundary (now - endedAt === RUN_PRUNE_ENDED_MS) -> MUST NOT BE PRUNED under strictly > 24h rule
    const boundaryPath = path.join(runsDir, 'session-boundary.json');
    fs.writeFileSync(
      boundaryPath,
      JSON.stringify({
        schema: 1,
        terminalSessionId: 'session-boundary',
        ompSessionId: 'omp-boundary',
        pid: 1002,
        state: 'ended',
        runSeq: 1,
        updatedAt: clockTime - RUN_PRUNE_ENDED_MS, // exactly 24h
      }),
      'utf8',
    );

    // 3. Run file whose session is gone
    const goneSessionPath = path.join(runsDir, 'session-gone.json');
    fs.writeFileSync(
      goneSessionPath,
      JSON.stringify({
        schema: 1,
        terminalSessionId: 'session-gone',
        ompSessionId: 'omp-gone',
        pid: 1003,
        state: 'running',
        runSeq: 1,
        updatedAt: clockTime,
      }),
      'utf8',
    );

    // 4. Orphaned control directory (no live run file references this ompSessionId)
    const orphanControlDir = path.join(runsDir, 'control', 'omp-orphaned-dir');
    fs.mkdirSync(orphanControlDir, { recursive: true });
    fs.writeFileSync(path.join(orphanControlDir, 'req1.json'), JSON.stringify({ nonce: 1 }));

    // Run prune
    service.pruneSync();

    assert.strictEqual(fs.existsSync(oldEndedPath), false, 'ended for > 24h must be pruned');
    assert.strictEqual(fs.existsSync(boundaryPath), true, 'ended at exactly 24h boundary must survive (> 24h rule)');
    assert.strictEqual(fs.existsSync(goneSessionPath), false, 'run file whose session is gone must be pruned');
    assert.strictEqual(fs.existsSync(orphanControlDir), false, 'orphaned control dir must be removed');

    // Clean up boundary
    try { fs.unlinkSync(boundaryPath); } catch {}
  });

  test('6. brief mirror write and delete on capsule change', () => {
    clockTime = 200_000;
    const session = { id: 'session-capsule-test', capsuleId: 'cap-alpha' };
    const capsuleBriefs = new Map<string, { brief: unknown; updatedAt: number }>([
      ['cap-alpha', { brief: { storefrontUrl: 'https://alpha.store', siteName: 'Alpha Store' }, updatedAt: 1111 }],
      ['cap-beta', { brief: { storefrontUrl: 'https://beta.store', siteName: 'Beta Store' }, updatedAt: 2222 }],
    ]);

    const service = new RunStateService({
      runsDir,
      lookupSession: (id: string) => (id === session.id ? session : undefined),
      lookupCapsule: (id: string) => (id === session.id ? session.capsuleId : undefined),
      lookupCapsuleBrief: (cid: string) => capsuleBriefs.get(cid),
      clock: () => clockTime,
      watch: false,
    });

    const briefFilePath = path.join(runsDir, `${session.id}.brief.json`);

    // 1. Initial write
    service.syncBriefsSync([session]);
    assert.ok(fs.existsSync(briefFilePath), 'brief file should be written');
    let briefContent = JSON.parse(fs.readFileSync(briefFilePath, 'utf8'));
    assert.strictEqual(briefContent.capsuleId, 'cap-alpha');
    assert.strictEqual(briefContent.briefSeq, 1111);
    assert.strictEqual(briefContent.brief.siteName, 'Alpha Store');

    // 2. Capsule change: move to cap-beta
    session.capsuleId = 'cap-beta';
    service.syncBriefsSync([session]);
    assert.ok(fs.existsSync(briefFilePath));
    briefContent = JSON.parse(fs.readFileSync(briefFilePath, 'utf8'));
    assert.strictEqual(briefContent.capsuleId, 'cap-beta');
    assert.strictEqual(briefContent.briefSeq, 2222);
    assert.strictEqual(briefContent.brief.siteName, 'Beta Store');

    // 3. Brief cleared: set brief to null
    capsuleBriefs.set('cap-beta', { brief: null, updatedAt: 3333 });
    service.syncBriefsSync([session]);
    assert.strictEqual(fs.existsSync(briefFilePath), false, 'brief mirror must be deleted when brief clears');
  });

  test('7. change-review reader (allow rows deduped and capped, refused rows counted, absent log ⇒ no changes)', () => {
    const service = new RunStateService({
      runsDir,
      clock: () => clockTime,
      watch: false,
    });

    const ompSessionId = 'omp-changes-test';
    const logPath = path.join(workspaceDir, '.antifan', 'edit-guard', `${ompSessionId}.jsonl`);

    // Generate rows:
    // 30 unique allowed paths (files should cap at 24, fileCount should be 30)
    // 2 duplicate allowed rows
    // 4 refused/blocked rows
    // 2 rows for a different runSeq (runSeq: 2, should be ignored)
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      lines.push(JSON.stringify({
        ts: new Date().toISOString(),
        runSeq: 1,
        mode: 'direct',
        tool: 'write',
        path: `src/file-${i}.ts`,
        decision: 'allow',
        code: 'ALLOW_DIRECT_POLICY',
      }));
    }
    // Duplicates for file-1, file-2
    lines.push(JSON.stringify({ runSeq: 1, decision: 'allow', path: 'src/file-1.ts' }));
    lines.push(JSON.stringify({ runSeq: 1, decision: 'allow', path: 'src/file-2.ts' }));

    // Refused rows
    lines.push(JSON.stringify({ runSeq: 1, decision: 'block', path: 'src/blocked-1.ts', code: 'POLICY_DENIED' }));
    lines.push(JSON.stringify({ runSeq: 1, decision: 'block', path: 'src/blocked-2.ts', code: 'POLICY_DENIED' }));
    lines.push(JSON.stringify({ runSeq: 1, decision: 'refuse', path: 'src/blocked-3.ts', code: 'READ_ONLY' }));
    lines.push(JSON.stringify({ runSeq: 1, decision: 'block', path: 'src/blocked-4.ts', code: 'POLICY_DENIED' }));

    // Different runSeq (runSeq 2)
    lines.push(JSON.stringify({ runSeq: 2, decision: 'allow', path: 'src/other.ts' }));
    lines.push(JSON.stringify({ runSeq: 2, decision: 'block', path: 'src/other-blocked.ts' }));

    fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');

    // 1. Read existing log
    const changes = service.readChanges(workspaceDir, ompSessionId, 1);
    assert.ok(changes, 'changes should be present for readable log');
    assert.strictEqual(changes.files.length, 24, 'files list must be capped at 24');
    assert.strictEqual(changes.fileCount, 30, 'fileCount must be total deduped allowed files (30)');
    assert.strictEqual(changes.blockedCount, 4, 'refused rows must count into blockedCount (4)');

    // Ensure refused paths are NOT in files
    assert.strictEqual(changes.files.includes('src/blocked-1.ts'), false);
    assert.strictEqual(changes.files.includes('src/other.ts'), false);

    // 2. Absent log => changes absent (undefined), never an error
    const absentChanges = service.readChanges(workspaceDir, 'non-existent-omp', 1);
    assert.strictEqual(absentChanges, undefined, 'absent log must yield undefined changes, never throw');

    // 3. Workspace without .antifan => changes absent
    const noWorkspaceChanges = service.readChanges(tempRoot, ompSessionId, 1);
    assert.strictEqual(noWorkspaceChanges, undefined, 'workspace without .antifan must yield undefined changes');
  });

  test('8. viewOnly for an agent-owned row', () => {
    const sessionMap = new Map<string, { id: string; ownerKey: string; agentHeld?: boolean }>([
      ['session-agent', { id: 'session-agent', ownerKey: 'agent:auto-builder-1', agentHeld: true }],
      ['session-agent-released', { id: 'session-agent-released', ownerKey: 'agent:closed-tab', agentHeld: false }],
      ['session-user', { id: 'session-user', ownerKey: 'user:default' }],
    ]);

    const service = new RunStateService({
      runsDir,
      lookupSession: (id: string) => sessionMap.get(id),
      clock: () => clockTime,
      watch: false,
      isManagerSender: (senderId: unknown) => senderId === 'manager-window',
    });

    const baseRuns: RunCardLike[] = [
      {
        terminalSessionId: 'session-agent',
        state: 'running',
        stale: false,
        mode: 'direct',
        runSeq: 1,
        viewOnly: true,
      },
      {
        terminalSessionId: 'session-user',
        state: 'running',
        stale: false,
        mode: 'direct',
        runSeq: 1,
        viewOnly: false,
      },
      {
        terminalSessionId: 'session-agent-released',
        state: 'running',
        stale: false,
        mode: 'direct',
        runSeq: 1,
        viewOnly: true,
      },
    ];

    // Receiving window is manager
    const managerCards = service.runCardsForWindow(baseRuns, 'manager-window');
    const agentCardInManager = managerCards.find((c) => c.terminalSessionId === 'session-agent');
    const userCardInManager = managerCards.find((c) => c.terminalSessionId === 'session-user');
    assert.strictEqual(agentCardInManager?.viewOnly, true, 'agent-owned row in manager must have viewOnly: true');
    assert.strictEqual(userCardInManager?.viewOnly, false, 'user-owned row in manager must have viewOnly: false');
    const releasedCardInManager = managerCards.find((c) => c.terminalSessionId === 'session-agent-released');
    assert.strictEqual(releasedCardInManager?.viewOnly, false, 'an agent row no agent holds any more is operable from the manager');

    // Receiving window is a project window (not manager)
    const projectCards = service.runCardsForWindow(baseRuns, 'project-window');
    const agentCardInProject = projectCards.find((c) => c.terminalSessionId === 'session-agent');
    assert.strictEqual(agentCardInProject?.viewOnly, false, 'agent-owned row in non-manager window must have viewOnly: false');
  });

  test('9. sweep emits change only when the run-file set changes or prune deletes', () => {
    const sweepRunsDir = path.join(tempRoot, 'sweep-emit-runs');
    fs.mkdirSync(sweepRunsDir, { recursive: true });

    const liveSessions = new Set(['sweep-live']);
    const service = new RunStateService({
      runsDir: sweepRunsDir,
      lookupSession: (id: string) => (liveSessions.has(id) ? { id } : undefined),
      isProcessAlive: () => true,
      clock: () => clockTime,
      watch: false,
    });

    let changes = 0;
    const onChange = () => { changes += 1; };
    service.on('change', onChange);

    // First observation of the (currently empty) run-file set announces it.
    service.sweepSync();
    assert.strictEqual(changes, 1, 'the first sweep emits once so surfaces seed');

    // Nothing changed since that emit: a quiet sweep must not emit again.
    service.sweepSync();
    service.sweepSync();
    assert.strictEqual(changes, 1, 'a no-op sweep never re-announces an unchanged set');

    // A real run file appearing since the last emit is a change.
    const runPath = path.join(sweepRunsDir, 'sweep-live.json');
    const writeRun = (updatedAt: number) => fs.writeFileSync(
      runPath,
      JSON.stringify({
        schema: 1,
        terminalSessionId: 'sweep-live',
        ompSessionId: 'omp-sweep',
        pid: 4242,
        cwd: workspaceDir,
        mode: 'direct',
        state: 'running',
        runSeq: 1,
        updatedAt,
      }),
      'utf8',
    );
    writeRun(clockTime);
    service.sweepSync();
    assert.strictEqual(changes, 2, 'a new run file since the last emit must emit');

    // Same file, same bytes: still no emit.
    service.sweepSync();
    assert.strictEqual(changes, 2);

    // A heartbeat rewrite changes mtime+size observation: emit once, then quiet.
    writeRun(clockTime + 1000);
    service.sweepSync();
    assert.strictEqual(changes, 3, 'a run-file rewrite must emit');
    service.sweepSync();
    assert.strictEqual(changes, 3);

    // Session gone → prune removes the run file inside sweepSync: the deletion
    // itself is the change even if the fingerprint were somehow identical.
    liveSessions.delete('sweep-live');
    service.sweepSync();
    assert.strictEqual(fs.existsSync(runPath), false);
    assert.strictEqual(changes, 4, 'prune deleting the run file must emit');

    // Converged: deleting again prunes nothing and emits nothing.
    service.sweepSync();
    assert.strictEqual(changes, 4);

    service.removeListener('change', onChange);
  });

  test('10. sweep announces a run turning stale with no file change (hard kill, heartbeat age)', () => {
    const staleRunsDir = path.join(tempRoot, 'sweep-stale-runs');
    fs.mkdirSync(staleRunsDir, { recursive: true });
    let alive = true;
    let now = 500_000;
    const service = new RunStateService({
      runsDir: staleRunsDir,
      lookupSession: (id: string) => ({ id }),
      isProcessAlive: () => alive,
      clock: () => now,
      staleMs: 45_000,
      watch: false,
    });
    const writeRun = (id: string) => fs.writeFileSync(
      path.join(staleRunsDir, `${id}.json`),
      JSON.stringify({ schema: 1, terminalSessionId: id, ompSessionId: `omp-${id}`, pid: 7777, cwd: workspaceDir, mode: 'direct', state: 'running', runSeq: 1, updatedAt: now }),
      'utf8',
    );
    writeRun('stale-run');

    let changes = 0;
    service.on('change', () => { changes += 1; });
    service.sweepSync();
    assert.strictEqual(changes, 1);
    assert.strictEqual(service.getRunsSync()[0]?.state, 'running');

    // The agent process is killed hard: its run file never records 'ended'.
    alive = false;
    service.sweepSync();
    assert.strictEqual(changes, 2, 'a dead pid must re-announce so the card leaves running');
    assert.strictEqual(service.getRunsSync()[0]?.state, 'ended');
    service.sweepSync();
    assert.strictEqual(changes, 2, 'the stale verdict is announced once');

    // A live pid whose heartbeat ages past staleMs flips the same way.
    alive = true;
    writeRun('aging-run');
    service.sweepSync();
    const afterWrite = changes;
    now += 46_000;
    service.sweepSync();
    assert.strictEqual(changes, afterWrite + 1, 'heartbeat aging past staleMs must re-announce');
  });

  test('11. an orphan control-dir removal that fails or is delete-pending neither emits nor retries before the cooldown', () => {
    const backoffRunsDir = path.join(tempRoot, 'backoff-runs');
    const orphanDir = path.join(backoffRunsDir, 'control', 'omp-held');
    fs.mkdirSync(orphanDir, { recursive: true });
    let now = 1_000_000;
    const service = new RunStateService({
      runsDir: backoffRunsDir,
      lookupSession: () => undefined,
      isProcessAlive: () => true,
      clock: () => now,
      watch: false,
    });
    // Windows refuses to remove a dir another process still watches; simulate
    // that refusal through the shared builtin so the service sees EPERM.
    const { syncBuiltinESMExports } = require('node:module');
    const realRmSync = fs.rmSync;
    const realExistsSync = fs.existsSync;
    let rmAttempts = 0;
    // Past the 60 s retry cooldown.
    const afterCooldown = 61_000;
    let changes = 0;
    service.on('change', () => { changes += 1; });
    try {
      fs.rmSync = (target: string, opts: unknown) => {
        if (path.resolve(target) === path.resolve(orphanDir)) {
          rmAttempts += 1;
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        return realRmSync(target, opts);
      };
      syncBuiltinESMExports();

      service.sweepSync();
      assert.strictEqual(rmAttempts, 1, 'the orphan removal is attempted once');
      assert.strictEqual(changes, 1, 'only the first observation of the run-file set is announced');
      service.sweepSync();
      service.sweepSync();
      assert.strictEqual(rmAttempts, 1, 'no synchronous retry inside the cooldown');
      assert.strictEqual(changes, 1, 'a failed removal changes nothing and must not emit');

      now += afterCooldown;
      service.sweepSync();
      assert.strictEqual(rmAttempts, 2, 'retried once the cooldown elapses');
      assert.strictEqual(changes, 1);

      // A delete-pending dir is still listed and stats as a directory, but
      // existsSync reports it gone: removal must not even be attempted.
      fs.existsSync = (target: string) => (
        path.resolve(target) === path.resolve(orphanDir) ? false : realExistsSync(target)
      );
      syncBuiltinESMExports();
      now += afterCooldown;
      service.sweepSync();
      assert.strictEqual(rmAttempts, 2, 'a delete-pending dir is skipped without a removal attempt');
      assert.strictEqual(changes, 1, 'skipping a delete-pending dir is not a change');
    } finally {
      fs.rmSync = realRmSync;
      fs.existsSync = realExistsSync;
      syncBuiltinESMExports();
    }

    now += afterCooldown;
    service.sweepSync();
    assert.strictEqual(fs.existsSync(orphanDir), false, 'removal succeeds once the holder lets go');
    assert.strictEqual(changes, 2, 'the successful removal is announced');
  });

  test('12. readChanges serves an unchanged edit-guard log from cache and re-reads it after an append', () => {
    const ompSessionId = 'omp-cache-append';
    const logPath = path.join(workspaceDir, '.antifan', 'edit-guard', `${ompSessionId}.jsonl`);
    fs.writeFileSync(logPath, `${JSON.stringify({ runSeq: 1, decision: 'allow', path: 'a.liquid' })}\n`, 'utf8');
    const service = new RunStateService({ runsDir, watch: false, clock: () => clockTime });

    const first = service.readChanges(workspaceDir, ompSessionId, 1);
    assert.deepStrictEqual(first?.files, ['a.liquid']);
    assert.strictEqual(service.readChanges(workspaceDir, ompSessionId, 1), first, 'an unchanged log is not re-parsed');
    fs.appendFileSync(logPath, `${JSON.stringify({ runSeq: 1, decision: 'allow', path: 'b.liquid' })}\n`, 'utf8');
    const after = service.readChanges(workspaceDir, ompSessionId, 1);
    assert.deepStrictEqual(after?.files, ['a.liquid', 'b.liquid'], 'an append must invalidate the cached summary');
    assert.strictEqual(service.readChanges(workspaceDir, ompSessionId, 2)?.fileCount, 0, 'a different runSeq is not served from cache');
  });
});
