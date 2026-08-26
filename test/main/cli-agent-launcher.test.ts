import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RunService } from '../../src/main/run/run-service';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { ChatStore } from '../../src/main/chat/chat-store';
import { EventStore } from '../../src/main/session/event-store';
import { ReceiptStore } from '../../src/main/session/receipt-store';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { RuntimeLease, CapabilityError } from '../../src/shared/control-plane-contracts';
import { resolveScriptsDir } from '../../src/main/browser/terminal-manager';

function makeMockLease(overrides: Partial<RuntimeLease> = {}): RuntimeLease {
  const now = Date.now();
  return {
    runtimeId: 'binding-test123456789012345',
    token: 'tok-mock-lease-1234567890',
    protocolVersion: 1,
    hostEpoch: 1,
    ownerPid: process.pid,
    issuedAt: now,
    expiresAt: now + 3600000,
    projectId: 'project-test12345678901234',
    workspaceId: 'workspace-test123456789012',
    ...overrides,
  };
}

describe('CLI Session and Agent Launcher Lifecycle', () => {
  it('RunService.createCliSession and endCliSession manage full session and PID attachment lifecycle', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cli-test-'));
    const projectId = 'project-12345678901234567890';
    const workspaceId = 'workspace-12345678901234567890';
    const chats = new ChatStore();
    const events = new EventStore({ filePath: path.join(tempDir, 'events.jsonl'), projectId, workspaceId });
    const receipts = new ReceiptStore({ filePath: path.join(tempDir, 'receipts.jsonl') });
    const runs = new RunService(chats, events, receipts, () => tempDir);
    const lease = makeMockLease({ projectId, workspaceId });

    // 1. Create CLI Session with immediate ownerPid binding
    const session = runs.createCliSession({
      projectId,
      workspaceId,
      backendId: 'cli',
      grant: 'write',
      ttlMs: 60000,
      ownerPid: 12345,
      lease,
      leaseToken: lease.token,
    });

    assert.ok(session.run.id.startsWith('run-'), 'Run ID should have run- prefix');
    assert.ok(session.attempt.id.startsWith('attempt-'), 'Attempt ID should have attempt- prefix');
    assert.strictEqual(session.run.state, 'streaming', 'Run state should be streaming');
    assert.strictEqual(session.attempt.state, 'running', 'Attempt state should be running');
    assert.ok(session.launch.secret.length >= 32, 'Launch secret should be non-empty and secure');
    assert.strictEqual(runs.getAttemptProcessPid(session.attempt.id), 12345, 'Process PID should be bound immediately on attempt');

    // 2. Validate attachment with matching ownerPid
    const validWithPid = runs.attachments.validateAttachment({
      attachmentId: session.launch.attachmentId,
      attachmentSecret: session.launch.secret,
      runId: session.run.id,
      attemptId: session.attempt.id,
      projectId,
      workspaceId,
      invocationId: 'inv-1-valid',
      ownerPid: 12345,
    });
    assert.strictEqual(validWithPid.attachmentId, session.launch.attachmentId);
    assert.strictEqual(validWithPid.attemptId, session.attempt.id);
    // 3. Reject validation with mismatched ownerPid
    assert.throws(
      () =>
        runs.attachments.validateAttachment({
          attachmentId: session.launch.attachmentId,
          attachmentSecret: session.launch.secret,
          runId: session.run.id,
          attemptId: session.attempt.id,
          projectId,
          workspaceId,
          invocationId: 'inv-2-mismatch',
          ownerPid: 99999, // Wrong PID
        }),
      (err: unknown) => {
        if (err instanceof CapabilityError) {
          return err.code === 'PROCESS_MISMATCH';
        }
        return false;
      }
    );

    // 4. Reject replay with duplicate invocationId
    assert.throws(
      () =>
        runs.attachments.validateAttachment({
          attachmentId: session.launch.attachmentId,
          attachmentSecret: session.launch.secret,
          runId: session.run.id,
          attemptId: session.attempt.id,
          projectId,
          workspaceId,
          invocationId: 'inv-1-valid',
          ownerPid: 12345,
        }),
      (err: unknown) => {
        if (err instanceof CapabilityError) {
          return err.code === 'REPLAY_DENIED';
        }
        return false;
      }
    );

    // 5. End CLI Session and verify state transitions and revocation
    const endResult = runs.endCliSession(session.run.id, session.attempt.id, 'completed');
    assert.strictEqual(endResult.ok, true);

    const updatedRun = runs.getRun(session.run.id);
    assert.strictEqual(updatedRun?.state, 'completed', 'Run should be transitioned to completed');
    const updatedAttempt = runs.getAttempt(session.attempt.id);
    assert.strictEqual(updatedAttempt?.state, 'completed', 'Attempt should be transitioned to completed');

    // 6. Verification after end: attachment must be revoked
    assert.throws(
      () =>
        runs.attachments.validateAttachment({
          attachmentId: session.launch.attachmentId,
          attachmentSecret: session.launch.secret,
          runId: session.run.id,
          attemptId: session.attempt.id,
          projectId,
          workspaceId,
          invocationId: 'inv-3-post-end',
          ownerPid: 12345,
        }),
      (err: unknown) => {
        if (err instanceof CapabilityError) {
          return err.code === 'ATTACHMENT_STALE';
        }
        return false;
      }
    );

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('ControlPlaneRuntime - createCliSession and endCliSession integration', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cpr-cli-test-'));
    const projectId = 'project-22345678901234567890';
    const workspaceId = 'workspace-22345678901234567890';

    const runtime = new ControlPlaneRuntime({
      projectId,
      workspaceId,
      dataRoot: tempDir,
      workspaceRoot: tempDir,
      hostEpoch: 1,
    });

    const cliSession = runtime.createCliSession({
      grant: 'write',
      ownerPid: 54321,
    });

    assert.strictEqual(cliSession.run.projectId, projectId);
    assert.strictEqual(cliSession.run.workspaceId, workspaceId);
    assert.strictEqual(runtime.runs.getAttemptProcessPid(cliSession.attempt.id), 54321);

    // Verify secret authentication before session termination
    assert.strictEqual(runtime.runs.attachments.verifyAttachmentSecret(cliSession.launch.attachmentId, cliSession.launch.secret), true);
    assert.strictEqual(runtime.runs.attachments.verifyAttachmentSecret(cliSession.launch.attachmentId, 'invalid-secret-12345'), false);
    // Verify secret authentication fails after expiration
    const expiredSession = runtime.createCliSession({
      grant: 'read',
      ownerPid: 54321,
      ttlMs: 25,
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(runtime.runs.attachments.verifyAttachmentSecret(expiredSession.launch.attachmentId, expiredSession.launch.secret), false);
    const endRes = runtime.endCliSession(cliSession.run.id, cliSession.attempt.id, 'failed', 'Agent error');
    assert.strictEqual(endRes.ok, true);

    // Verify secret authentication is revoked post termination
    assert.strictEqual(runtime.runs.attachments.verifyAttachmentSecret(cliSession.launch.attachmentId, cliSession.launch.secret), false);
    const updatedRun = runtime.runs.getRun(cliSession.run.id);
    assert.strictEqual(updatedRun?.state, 'failed');
    const updatedAttempt = runtime.runs.getAttempt(cliSession.attempt.id);
    assert.strictEqual(updatedAttempt?.state, 'failed');
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('handles user cancellation (SIGINT/SIGTERM) with interrupted state transition and immediate revocation', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cpr-cancel-test-'));
    const projectId = 'project-32345678901234567890';
    const workspaceId = 'workspace-32345678901234567890';

    const runtime = new ControlPlaneRuntime({
      projectId,
      workspaceId,
      dataRoot: tempDir,
      workspaceRoot: tempDir,
      hostEpoch: 1,
    });

    const cliSession = runtime.createCliSession({
      grant: 'write',
      ownerPid: 98765,
    });

    assert.strictEqual(cliSession.run.state, 'streaming');
    assert.strictEqual(cliSession.attempt.state, 'running');

    // Simulate SIGINT / cancellation
    const cancelRes = runtime.endCliSession(
      cliSession.run.id,
      cliSession.attempt.id,
      'cancelled',
      'User interrupted via SIGINT'
    );
    assert.strictEqual(cancelRes.ok, true);

    const updatedRun = runtime.runs.getRun(cliSession.run.id);
    assert.strictEqual(updatedRun?.state, 'interrupted', 'Run should transition to interrupted on cancel');
    const updatedAttempt = runtime.runs.getAttempt(cliSession.attempt.id);
    assert.strictEqual(updatedAttempt?.state, 'interrupted', 'Attempt should transition to interrupted on cancel');

    // Verify rejection of any subsequent invocation
    assert.throws(
      () =>
        runtime.runs.attachments.validateAttachment({
          attachmentId: cliSession.launch.attachmentId,
          attachmentSecret: cliSession.launch.secret,
          runId: cliSession.run.id,
          attemptId: cliSession.attempt.id,
          projectId,
          workspaceId,
          invocationId: 'inv-cancelled-post',
          ownerPid: 98765,
        }),
      (err: unknown) => {
        if (err instanceof CapabilityError) {
          return err.code === 'ATTACHMENT_STALE' || err.code === 'ATTEMPT_NOT_ACTIVE';
        }
        return false;
      }
    );

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });
  it('CLI Launcher Files and Packaging Verification', () => {
    const rootDir = process.cwd();
    const launcherPath = path.resolve(rootDir, 'scripts', 'antifan-agent.cjs');
    const cmdWrapperPath = path.resolve(rootDir, 'scripts', 'antifan-agent.cmd');
    const packageJsonPath = path.resolve(rootDir, 'package.json');
    assert.ok(fs.existsSync(launcherPath), 'scripts/antifan-agent.cjs should exist');
    assert.ok(fs.existsSync(cmdWrapperPath), 'scripts/antifan-agent.cmd should exist');

    const content = fs.readFileSync(launcherPath, 'utf8');
    assert.ok(content.startsWith('#!/usr/bin/env node'), 'Should have node shebang');
    assert.ok(content.includes('antifan.cli.startSession'), 'Should invoke startSession RPC');
    assert.ok(content.includes('ANTIFAN_MCP_BOOTSTRAP'), 'Should inject ANTIFAN_MCP_BOOTSTRAP');

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    assert.strictEqual(pkg.bin['antifan-agent'], './scripts/antifan-agent.cjs', 'package.json bin should map antifan-agent');
    assert.ok(pkg.scripts.agent, 'package.json should have agent script');

    const resolvedDir = resolveScriptsDir();
    assert.ok(resolvedDir !== undefined, 'resolveScriptsDir() must return a defined string');
    assert.ok(fs.existsSync(resolvedDir), 'resolveScriptsDir() must return an existing directory');
    assert.ok(fs.existsSync(path.join(resolvedDir, 'antifan-agent.cjs')), 'resolveScriptsDir() must contain antifan-agent.cjs');
  });
});
