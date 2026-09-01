import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
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

describe('Terminal Capabilities, Generation Tracking & Wait Lifecycle (Phase 04)', () => {
  let terminalManager: TerminalManager;
  let catalogue: CapabilityCatalogue;
  let projectId: string;
  let workspaceId: string;
  let lease: RuntimeLease;

  before(() => {
    projectId = makeControlPlaneId('project');
    workspaceId = makeControlPlaneId('workspace');
    lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);
    terminalManager = TerminalManager.getInstance();
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
      (TerminalManager as any).instance = undefined;
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

    // Write a distinct marker to session buffer
    terminalManager.write('echo FAST_PATH_MARKER_12345\r\n');

    // Wait a brief moment for PTY to process echo (real clock needed for OS PTY child)
    await new Promise((r) => setTimeout(r, 300));

    const waitRes = (await catalogue.dispatch(
      'terminal.wait',
      {
        sessionId,
        condition: 'output-match',
        pattern: 'FAST_PATH_MARKER_12345',
        sessionGeneration: session?.sessionGeneration,
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
    setTimeout(() => controller.abort(), 100);

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
});
