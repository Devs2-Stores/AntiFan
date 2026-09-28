/**
 * Terminal-origin CLI session authority is scoped to the project the terminal
 * lives in — measured at mint through the composition-root seams — never derived
 * from the caller's cwd or claimed project/workspace ids.
 *
 * Why this exists: `resolveWorkspaceForSession` resolves an unattributed cwd by
 * filesystem containment. A terminal living under project B but started from a
 * cwd inside project A's workspace root minted browser authority under A while
 * the operator saw the terminal in B's window — silent cross-project scope.
 * Worse, the minted attachment kept that authority even after the terminal moved
 * to another project.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { makeControlPlaneId, CapabilityError } from '../../src/shared/control-plane-contracts';
import type { TerminalManager } from '../../src/main/browser/terminal-manager';

/**
 * A terminal manager facade that knows exactly the rows the caller declares: a row present in
 * either map is a session the manager can describe, an id absent from both is unknown — the
 * distinction production reads through `sessionCapsuleId`/`sessionOwnerKey`.
 */
function makeTerminalStub(ownerBySession: Map<string, string>, capsuleBySession: Map<string, string> = new Map()) {
  return {
    sessionCapsuleId: (id: string) => capsuleBySession.get(id),
    sessionOwnerKey: (id: string) => ownerBySession.get(id),
    getStats: () => ({ sessions: 0 }),
    getSession: (id: string) => ({ id, sessionGeneration: 1, state: 'live' }),
    listSessions: () => [] as Array<{ id: string }>,
    getActiveSessionId: () => undefined as string | undefined,
    getCurrentCwd: () => undefined as string | undefined,
    writeTo: async () => {},
    createSession: async () => 'terminal-new',
    createSplitSession: async () => 'terminal-new-split',
    closeSession: async () => true,
    closeSplitSession: async () => true,
  } as unknown as TerminalManager;
}

function register(runtime: ControlPlaneRuntime, projectId: string, workspaceId: string, rootPath: string, dataRoot: string) {
  runtime.projects.registerProject({
    id: projectId,
    name: projectId,
    dataRoot,
    state: 'open',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  runtime.workspaces.register({
    id: workspaceId,
    projectId,
    rootPath,
    state: 'attached',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function claimsFor(launch: { attachmentId: string; secret: string; runId: string; attemptId: string; projectId: string; workspaceId: string; authorityRevision: string; hostEpoch: number; grant?: string }, invocationId: string) {
  return {
    attachmentId: launch.attachmentId,
    attachmentSecret: launch.secret,
    runId: launch.runId,
    attemptId: launch.attemptId,
    projectId: launch.projectId,
    workspaceId: launch.workspaceId,
    authorityRevision: launch.authorityRevision,
    backendId: 'cli',
    hostEpoch: launch.hostEpoch,
    invocationId,
    grant: (launch.grant || 'eval') as 'eval',
  };
}

describe('ControlPlaneRuntime terminal-origin project scope', () => {
  it('mints a terminal-origin session under the terminal measured project, not the caller cwd', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-termscope-'));
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-projA-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-projB-'));
    const projA = makeControlPlaneId('project');
    const wsA = makeControlPlaneId('workspace');
    const projB = makeControlPlaneId('project');
    const wsB = makeControlPlaneId('workspace');
    try {
      const owners = new Map<string, string>([['term-b', `project:${projB}`]]);
      const runtime = new ControlPlaneRuntime({
        projectId: projA,
        workspaceId: wsA,
        dataRoot,
        workspaceRoot: rootA,
        terminal: makeTerminalStub(owners),
      });
      await runtime.initialize();
      register(runtime, projA, wsA, rootA, dataRoot);
      register(runtime, projB, wsB, rootB, dataRoot);

      // A cwd inside projA's root must NOT scope the session to projA: the
      // terminal's owner key measures projB, and that measurement wins.
      const res = await runtime.createCliSession({
        originTerminalSessionId: 'term-b',
        cwd: path.join(rootA, 'nested'),
      });
      assert.strictEqual(res.run.projectId, projB, 'the run must record the terminal project, not the cwd project');
      assert.strictEqual(res.launch.projectId, projB);
      assert.strictEqual(res.launch.workspaceId, wsB);
      const record = runtime.runs.attachments.getAttachment(res.launch.attachmentId);
      assert.ok(record);
      assert.strictEqual(record!.projectId, projB);
      assert.strictEqual(record!.originTerminalSessionId, 'term-b', 'the origin terminal is stamped for per-dispatch re-checks');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  it('refuses a caller-supplied project or workspace that conflicts with the terminal measured scope', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-termscope-'));
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-projA-'));
    const projA = makeControlPlaneId('project');
    const wsA = makeControlPlaneId('workspace');
    const projB = makeControlPlaneId('project');
    const wsB = makeControlPlaneId('workspace');
    try {
      const owners = new Map<string, string>([['term-b', `project:${projB}`]]);
      const runtime = new ControlPlaneRuntime({
        projectId: projA,
        workspaceId: wsA,
        dataRoot,
        workspaceRoot: rootA,
        terminal: makeTerminalStub(owners),
      });
      await runtime.initialize();
      register(runtime, projA, wsA, rootA, dataRoot);
      register(runtime, projB, wsB, '', dataRoot);

      await assert.rejects(
        () => runtime.createCliSession({ originTerminalSessionId: 'term-b', projectId: projA }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'PROJECT_MISMATCH'
      );
      await assert.rejects(
        () => runtime.createCliSession({ originTerminalSessionId: 'term-b', projectId: projB, workspaceId: wsA }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH'
      );
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(rootA, { recursive: true, force: true });
    }
  });

  it('fails closed when a project-claimed terminal has no single measurable workspace', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-termscope-'));
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-projA-'));
    const projA = makeControlPlaneId('project');
    const wsA = makeControlPlaneId('workspace');
    const wsA2 = makeControlPlaneId('workspace');
    try {
      // The row names a project, but that project holds two attached workspaces: the
      // measured workspace is ambiguous, which is a question about a real claim. It must
      // be refused rather than answered by whichever project the caller's cwd lands in.
      const owners = new Map<string, string>([['term-ambiguous', `project:${projA}`]]);
      const runtime = new ControlPlaneRuntime({
        projectId: projA,
        workspaceId: wsA,
        dataRoot,
        workspaceRoot: rootA,
        terminal: makeTerminalStub(owners),
      });
      await runtime.initialize();
      register(runtime, projA, wsA, rootA, dataRoot);
      runtime.workspaces.register({
        id: wsA2,
        projectId: projA,
        rootPath: rootA,
        state: 'attached',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await assert.rejects(
        () => runtime.createCliSession({ originTerminalSessionId: 'term-ambiguous' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_SCOPE_UNRESOLVED'
      );
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(rootA, { recursive: true, force: true });
    }
  });

  it('fails closed when the terminal owner stamp names a project without a usable id', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-termscope-'));
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-projA-'));
    const projA = makeControlPlaneId('project');
    const wsA = makeControlPlaneId('workspace');
    try {
      // A `project:`-prefixed stamp is a project claim even when its id did not survive.
      // Treating the empty id as "no claim" would answer the question from the caller's
      // cwd — the exact ambient fallback this gate exists to deny.
      const owners = new Map<string, string>([['term-empty', 'project:']]);
      const runtime = new ControlPlaneRuntime({
        projectId: projA,
        workspaceId: wsA,
        dataRoot,
        workspaceRoot: rootA,
        terminal: makeTerminalStub(owners),
      });
      await runtime.initialize();
      register(runtime, projA, wsA, rootA, dataRoot);

      await assert.rejects(
        () => runtime.createCliSession({ originTerminalSessionId: 'term-empty' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_SCOPE_UNRESOLVED'
      );
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(rootA, { recursive: true, force: true });
    }
  });

  it('mints from a terminal the manager reports nothing about, matching the daemon host', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-termscope-'));
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-projA-'));
    const projA = makeControlPlaneId('project');
    const wsA = makeControlPlaneId('workspace');
    try {
      // The default terminal host is a daemon, and its session summaries carry neither a
      // capsule nor an owner key, so every daemon-owned terminal reads as claiming nothing —
      // an id it never held is indistinguishable from a row it holds unclaimed. Refusing
      // this case would refuse every terminal the daemon owns: the whole surface, not an edge.
      const runtime = new ControlPlaneRuntime({
        projectId: projA,
        workspaceId: wsA,
        dataRoot,
        workspaceRoot: rootA,
        terminal: makeTerminalStub(new Map()),
      });
      await runtime.initialize();
      register(runtime, projA, wsA, rootA, dataRoot);

      const res = await runtime.createCliSession({ originTerminalSessionId: 'terminal-6' });
      assert.strictEqual(res.launch.projectId, projA);
      assert.strictEqual(
        runtime.runs.attachments.getRecord(res.launch.attachmentId)?.originTerminalSessionId,
        undefined
      );
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(rootA, { recursive: true, force: true });
    }
  });

  it('mints from an unattributed terminal without stamping a terminal-origin binding', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-termscope-'));
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-projA-'));
    const projA = makeControlPlaneId('project');
    const wsA = makeControlPlaneId('workspace');
    try {
      // Every PTY the app mints carries terminal affinity, but a row no window claimed —
      // a legacy record written before owner keys existed, the workspace-less built-in
      // project's terminal, a daemon boot shell — is attributed to nothing. It cannot be
      // foreign to any project, so the caller's own resolution stands and no origin
      // binding is recorded. The row is still one the manager knows it holds.
      const runtime = new ControlPlaneRuntime({
        projectId: projA,
        workspaceId: wsA,
        dataRoot,
        workspaceRoot: rootA,
        terminal: makeTerminalStub(new Map(), new Map([['term-legacy', 'default']])),
      });
      await runtime.initialize();
      register(runtime, projA, wsA, rootA, dataRoot);

      const res = await runtime.createCliSession({ originTerminalSessionId: 'term-legacy' });
      assert.strictEqual(res.launch.projectId, projA);
      assert.strictEqual(
        runtime.runs.attachments.getRecord(res.launch.attachmentId)?.originTerminalSessionId,
        undefined
      );
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(rootA, { recursive: true, force: true });
    }
  });

  it('refuses to mint when the bound tab measures in a different project than the terminal', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-termscope-'));
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-projA-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-projB-'));
    const projA = makeControlPlaneId('project');
    const wsA = makeControlPlaneId('workspace');
    const projB = makeControlPlaneId('project');
    const wsB = makeControlPlaneId('workspace');
    try {
      const owners = new Map<string, string>([['term-b', `project:${projB}`]]);
      const affiliation = new Map<string, { projectId?: string }>([['tab-a', { projectId: projA }], ['tab-b', {}]]);
      const runtime = new ControlPlaneRuntime({
        projectId: projA,
        workspaceId: wsA,
        dataRoot,
        workspaceRoot: rootA,
        terminal: makeTerminalStub(owners),
        resolveTabAffiliation: (tabId) => affiliation.get(tabId),
      });
      await runtime.initialize();
      register(runtime, projA, wsA, rootA, dataRoot);
      register(runtime, projB, wsB, rootB, dataRoot);

      // A tab measuring in projA must not ride a session minted from a projB terminal.
      await assert.rejects(
        () => runtime.createCliSession({ originTerminalSessionId: 'term-b', tabId: 'tab-a' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'POLICY_DENIED'
      );
      // An unmeasured tab affiliation is allowed — the bootstrap default capsule
      // legitimately carries none.
      const res = await runtime.createCliSession({ originTerminalSessionId: 'term-b', tabId: 'tab-b' });
      assert.strictEqual(res.launch.projectId, projB);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  it('revokes authority when the minting terminal moves to another project, on both dispatch paths', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-termscope-'));
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-projA-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-projB-'));
    const projA = makeControlPlaneId('project');
    const wsA = makeControlPlaneId('workspace');
    const projB = makeControlPlaneId('project');
    const wsB = makeControlPlaneId('workspace');
    try {
      const owners = new Map<string, string>([['term-b', `project:${projB}`]]);
      const runtime = new ControlPlaneRuntime({
        projectId: projA,
        workspaceId: wsA,
        dataRoot,
        workspaceRoot: rootA,
        terminal: makeTerminalStub(owners),
      });
      await runtime.initialize();
      register(runtime, projA, wsA, rootA, dataRoot);
      register(runtime, projB, wsB, rootB, dataRoot);

      const res = await runtime.createCliSession({ originTerminalSessionId: 'term-b' });
      const launch = res.launch;

      // In-scope dispatch validates on both surfaces: MCP claims and lineage intents.
      const claims = claimsFor(launch, 'inv-1');
      const ctx = runtime.runs.attachments.validateAttachment(claims);
      assert.strictEqual(ctx.projectId, projB);
      const intent = {
        requestId: 'req-1',
        idempotencyKey: 'idem-1',
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        authorityRevision: launch.authorityRevision,
        name: 'noop',
      };
      const authority = runtime.runs.attachments.resolveAuthority(intent);
      assert.strictEqual(authority.projectId, projB);

      // The terminal moves to projA — the authority minted under projB must stop.
      owners.set('term-b', `project:${projA}`);

      await assert.rejects(
        async () => runtime.runs.attachments.validateAttachment(claimsFor(launch, 'inv-2')),
        (err: unknown) => err instanceof CapabilityError && err.code === 'PROJECT_MISMATCH'
      );
      assert.throws(
        () => runtime.runs.attachments.resolveAuthority({ ...intent, requestId: 'req-2', idempotencyKey: 'idem-2' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'PROJECT_MISMATCH'
      );

      // An attachment with no terminal origin is untouched by the same move.
      const other = await runtime.createCliSession({});
      const otherCtx = runtime.runs.attachments.validateAttachment(claimsFor(other.launch, 'inv-3'));
      assert.strictEqual(otherCtx.projectId, projA);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });
});
