import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

describe('Phase 01: Secure Screenshot & Server-Side Artifact Resolver', () => {
  let tempDir: string;
  let bridgeServer: BridgeServer;
  let attachmentRegistry: AttachmentRegistry;
  let controlPlaneRuntime: ControlPlaneRuntime;
  let port: number;
  let testSecret: string;
  let testAttachmentId: string;
  let testRunId: string;
  let testAttemptId: string;
  let testProjectId: string;
  let testWorkspaceId: string;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-test-artifacts-'));
    port = 0;

    testRunId = makeControlPlaneId('run');
    testAttemptId = makeControlPlaneId('attempt');
    testProjectId = makeControlPlaneId('project');
    testWorkspaceId = makeControlPlaneId('workspace');

    attachmentRegistry = new AttachmentRegistry();
    const lease = issueRuntimeLease(testProjectId, testWorkspaceId, 60000, 1);
    const issued = attachmentRegistry.issueAttachment(
      testRunId,
      testAttemptId,
      testProjectId,
      testWorkspaceId,
      {
        backendId: 'test-backend',
        lease,
        leaseToken: crypto.randomUUID(),
      }
    );
    testSecret = issued.launch.secret;
    testAttachmentId = issued.record.id;
    controlPlaneRuntime = new ControlPlaneRuntime({
      dataRoot: tempDir,
      projectId: testProjectId,
      workspaceId: testWorkspaceId,
    });
    class MockTabHost extends EventEmitter {
      getTabList() { return []; }
      async captureScreenshot() { return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='; }
    }
    const mockTabHost = new MockTabHost() as unknown as NativeTabHost;
    bridgeServer = new BridgeServer(
      mockTabHost,
      port,
      false,
      undefined,
      undefined,
      attachmentRegistry,
      '127.0.0.1',
      controlPlaneRuntime
    );
    port = await bridgeServer.start();
  });
  after(() => {
    bridgeServer.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function httpRequest(options: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
  }): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer; json?: any }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer; json?: any }>();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          let json: any = undefined;
          try {
            json = JSON.parse(body.toString('utf8'));
          } catch {}
          resolve({
            statusCode: res.statusCode || 500,
            headers: res.headers,
            body,
            json,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
    return promise;
  }

  it('1. Rejects queries containing URL tokens with 401 SECRETS_IN_URL_FORBIDDEN', async () => {
    const res = await httpRequest({
      path: `/api/artifacts/artifact-123?token=${testSecret}`,
      headers: {
        'x-antifan-attachment-secret': testSecret,
      },
    });
    assert.strictEqual(res.statusCode, 401);
    assert.ok(res.json?.error?.includes('SECRETS_IN_URL_FORBIDDEN'));
  });

  it('2. Rejects requests presenting only bridgeToken without attachment secret with 401', async () => {
    const bridgeToken = (bridgeServer as any).token;
    const res = await httpRequest({
      path: `/api/artifacts/artifact-123`,
      headers: {
        Authorization: `Bearer ${bridgeToken}`,
      },
    });
    assert.strictEqual(res.statusCode, 401);
    assert.ok(res.json?.error?.includes('ATTACHMENT_SECRET_REQUIRED'));
  });

  it('3. Rejects requests with invalid or expired attachment secret', async () => {
    const res = await httpRequest({
      path: `/api/artifacts/artifact-123`,
      headers: {
        'x-antifan-attachment-secret': 'invalid-secret-token',
      },
    });
    assert.strictEqual(res.statusCode, 401);
  });

  it('4. Rejects cross-run artifact access attempts with 403 ATTACHMENT_MISMATCH', async () => {
    const otherRunId = makeControlPlaneId('run');
    const otherAttemptId = makeControlPlaneId('attempt');
    const fakePng = Buffer.from('fake-png-data', 'utf8');
    const crossRef = controlPlaneRuntime.artifacts.stage({
      kind: 'screenshot',
      mime: 'image/png',
      data: fakePng,
      runId: otherRunId,
      attemptId: otherAttemptId,
      projectId: testProjectId,
      workspaceId: testWorkspaceId,
    });

    const res = await httpRequest({
      path: `/api/artifacts/${crossRef.id}`,
      headers: {
        'x-antifan-attachment-secret': testSecret,
      },
    });

    assert.strictEqual(res.statusCode, 403);
    assert.ok(res.json?.error?.includes('ATTACHMENT_MISMATCH'));
  });

  it('5. Rejects truncated artifacts with 422 PAYLOAD_TRUNCATED', async () => {
    const bigData = Buffer.alloc(2000, 1);
    const truncatedRef = controlPlaneRuntime.artifacts.stage({
      kind: 'screenshot',
      mime: 'image/png',
      data: bigData,
      runId: testRunId,
      attemptId: testAttemptId,
      projectId: testProjectId,
      workspaceId: testWorkspaceId,
      maxBytes: 100,
    });
    assert.strictEqual(truncatedRef.truncated, true);

    const res = await httpRequest({
      path: `/api/artifacts/${truncatedRef.id}`,
      headers: {
        'x-antifan-attachment-secret': testSecret,
      },
    });

    assert.strictEqual(res.statusCode, 422);
    assert.ok(res.json?.error?.includes('PAYLOAD_TRUNCATED'));
  });

  it('6. Streams authentic binary bytes when ownership matches and artifact is valid', async () => {
    const validPngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const validRef = controlPlaneRuntime.artifacts.stage({
      kind: 'screenshot',
      mime: 'image/png',
      data: validPngBytes,
      runId: testRunId,
      attemptId: testAttemptId,
      projectId: testProjectId,
      workspaceId: testWorkspaceId,
    });
    assert.strictEqual(validRef.truncated, false);

    const res = await httpRequest({
      path: `/api/artifacts/${validRef.id}`,
      headers: {
        'x-antifan-attachment-secret': testSecret,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'image/png');
    assert.strictEqual(res.headers['content-length'], String(validPngBytes.length));
    assert.ok(res.body.equals(validPngBytes), 'Received binary bytes must match staged bytes');
  });
});
