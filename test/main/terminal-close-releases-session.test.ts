import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installElectronStub } from '../support/electron-stub';

installElectronStub();

import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { makeControlPlaneId, issueRuntimeLease } from '../../src/shared/control-plane-contracts';
import {
  collectCloseLiveUse,
  projectLiveUseAttachments,
  terminalGonePredicate,
  type CloseLiveUseAttachmentRecord,
  type CloseLiveUsePort,
  type CloseLiveUseTerminalState,
} from '../../src/main/browser/close-live-use';
import { PageCloseReservations, type LiveUseRequest } from '../../src/main/browser/project-close-coordinator';

/**
 * Closing a worker's terminal must release what the agent session minted from it. The
 * owner pid sweep alone cannot: the MCP proxy that holds the binding can outlive the
 * shell for seconds (or be shared), and the socket-close release waits out a grace
 * period, so the project window's own "terminals stopped" close ran into a live
 * attachment and a streaming run and was refused as busy. The terminal the attachment
 * was minted from is the second proof of a gone owner, matched by exact id only.
 */
describe('terminal close releases the sessions minted from it', () => {
  const PAGE = 'tab-epres';
  const PAGE_REQUEST: LiveUseRequest = { scope: 'page', ownerKey: null, pageIds: [PAGE], auxiliaryKeys: [] };

  function makeRuntime() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-term-release-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-term-release-ws-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runtime = new ControlPlaneRuntime({ projectId, workspaceId, dataRoot, workspaceRoot });
    return { runtime, dataRoot, workspaceRoot, projectId, workspaceId };
  }

  function cleanup(roots: string[]) {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }

  type Runtime = ControlPlaneRuntime;

  /** The close gate's read of this runtime, assembled the way the composition root does. */
  function livePort(runtime: Runtime, runIds: string[]): CloseLiveUsePort {
    return {
      admission: () => new PageCloseReservations(),
      operationCounters: () => ({}),
      ledgerInFlight: () => 0,
      runs: () => runIds.map((runId) => ({ runId, state: runtime.runs.getRun(runId).state })),
      attachments: () => {
        const records: CloseLiveUseAttachmentRecord[] = [];
        for (const id of runtime.runs.attachments.getActiveRecordIds()) {
          const record = runtime.runs.attachments.getRecord(id);
          if (!record) continue;
          records.push({
            id: record.id,
            state: record.state,
            expiresAt: record.expiresAt,
            runId: record.runId,
            tabId: record.tabId,
            backendId: record.backendId,
          });
        }
        return projectLiveUseAttachments(records, Date.now(), () => undefined);
      },
      affinities: () => [],
      terminalState: () => ({ available: true, sessions: [] }),
    };
  }

  async function mint(
    runtime: Runtime,
    projectId: string,
    workspaceId: string,
    tabId: string,
    originTerminalSessionId: string | undefined
  ) {
    const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
    return await runtime.runs.createCliSession({
      projectId,
      workspaceId,
      tabId,
      // The owner process is alive: this is the proxy that outlives the shell, so the
      // pid sweep correctly keeps the binding and only the terminal can release it.
      ownerPid: process.pid,
      lease,
      leaseToken: lease.token,
      ...(originTerminalSessionId ? { originTerminalSessionId } : {}),
    });
  }

  const closed = (id: string): CloseLiveUseTerminalState => ({ available: true, sessions: [{ id, state: 'closed' }] });

  it('frees the page and ends the run once the origin terminal is closed', async () => {
    const { runtime, dataRoot, workspaceRoot, projectId, workspaceId } = makeRuntime();
    try {
      const session = await mint(runtime, projectId, workspaceId, PAGE, 'terminal-1216');
      const port = livePort(runtime, [session.run.id]);

      const before = collectCloseLiveUse(PAGE_REQUEST, port);
      assert.equal(before.state, 'busy', 'a live binding and a streaming run hold the page');
      assert.equal(runtime.runs.getRun(session.run.id).state, 'streaming');

      const gone = terminalGonePredicate(closed('terminal-1216'));
      assert.ok(gone, 'a readable terminal list yields a predicate');
      const released = await runtime.runs.releaseGoneTerminalSessions(gone);

      assert.deepEqual(released.revoked, [session.launch.attachmentId]);
      assert.deepEqual(released.interrupted, [session.run.id]);
      assert.equal(runtime.runs.attachments.getRecord(session.launch.attachmentId)?.state, 'revoked');
      assert.equal(runtime.runs.getRun(session.run.id).state, 'interrupted');
      assert.equal(collectCloseLiveUse(PAGE_REQUEST, livePort(runtime, [session.run.id])).state, 'idle');
    } finally {
      cleanup([dataRoot, workspaceRoot]);
    }
  });

  it('treats a terminal that vanished from the list as gone', async () => {
    const { runtime, dataRoot, workspaceRoot, projectId, workspaceId } = makeRuntime();
    try {
      const session = await mint(runtime, projectId, workspaceId, PAGE, 'terminal-1216');
      const gone = terminalGonePredicate({ available: true, sessions: [{ id: 'terminal-9', state: 'running' }] });
      assert.ok(gone);
      const released = await runtime.runs.releaseGoneTerminalSessions(gone);
      assert.deepEqual(released.revoked, [session.launch.attachmentId]);
    } finally {
      cleanup([dataRoot, workspaceRoot]);
    }
  });

  it('keeps every session that does not belong to the closed terminal', async () => {
    const { runtime, dataRoot, workspaceRoot, projectId, workspaceId } = makeRuntime();
    try {
      const doomed = await mint(runtime, projectId, workspaceId, PAGE, 'terminal-1216');
      const sibling = await mint(runtime, projectId, workspaceId, 'tab-toda', 'terminal-1215');
      const leader = await mint(runtime, projectId, workspaceId, 'tab-leader', 'terminal-100');
      const external = await mint(runtime, projectId, workspaceId, 'tab-external', undefined);

      const gone = terminalGonePredicate({
        available: true,
        sessions: [
          { id: 'terminal-1216', state: 'closed' },
          { id: 'terminal-1215', state: 'running' },
          { id: 'terminal-100', state: 'sleeping' },
        ],
      });
      assert.ok(gone);
      const released = await runtime.runs.releaseGoneTerminalSessions(gone);

      assert.deepEqual(released.revoked, [doomed.launch.attachmentId]);
      assert.deepEqual(released.interrupted, [doomed.run.id]);
      for (const alive of [sibling, leader, external]) {
        assert.equal(runtime.runs.attachments.getRecord(alive.launch.attachmentId)?.state, 'active');
        assert.equal(runtime.runs.getRun(alive.run.id).state, 'streaming');
      }
    } finally {
      cleanup([dataRoot, workspaceRoot]);
    }
  });

  it('releases nothing when the terminal list cannot be read, or reports no state for the terminal', async () => {
    const { runtime, dataRoot, workspaceRoot, projectId, workspaceId } = makeRuntime();
    try {
      const session = await mint(runtime, projectId, workspaceId, PAGE, 'terminal-1216');

      assert.equal(terminalGonePredicate({ available: false, detail: 'the terminal host daemon is not connected' }), undefined);

      const unknownState = terminalGonePredicate({ available: true, sessions: [{ id: 'terminal-1216' }] });
      assert.ok(unknownState);
      const released = await runtime.runs.releaseGoneTerminalSessions(unknownState);
      assert.deepEqual(released.revoked, []);
      assert.equal(runtime.runs.attachments.getRecord(session.launch.attachmentId)?.state, 'active');
      assert.equal(runtime.runs.getRun(session.run.id).state, 'streaming');
    } finally {
      cleanup([dataRoot, workspaceRoot]);
    }
  });

  it('keeps the binding when the predicate itself throws', async () => {
    const { runtime, dataRoot, workspaceRoot, projectId, workspaceId } = makeRuntime();
    try {
      const session = await mint(runtime, projectId, workspaceId, PAGE, 'terminal-1216');
      const released = await runtime.runs.releaseGoneTerminalSessions(() => {
        throw new Error('terminal host unreadable');
      });
      assert.deepEqual(released.revoked, []);
      assert.equal(runtime.runs.attachments.getRecord(session.launch.attachmentId)?.state, 'active');
    } finally {
      cleanup([dataRoot, workspaceRoot]);
    }
  });
});
