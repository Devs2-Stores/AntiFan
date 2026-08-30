import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { extensionCookieImportSetDetails } from '../../src/main/browser/chrome-profile-sync';
import { makeControlPlaneId } from '../../src/shared/control-plane-contracts';

class MockSession {
  public cookiesList: Array<Record<string, unknown>> = [];
  public flushed = false;

  public cookies = {
    set: async (details: Record<string, unknown>) => {
      this.cookiesList.push(details);
    },
    flushStore: async () => {
      this.flushed = true;
    },
  };
}

class MockTabHostWithSessions extends EventEmitter {
  public tab1Session = new MockSession();
  public tab2Session = new MockSession();
  public activeSession = new MockSession();
  public partitionSession = new MockSession();

  private tabs = new Map<string, { id: string; url: string }>([
    ['tab-1', { id: 'tab-1', url: 'https://google.com' }],
    ['tab-2', { id: 'tab-2', url: 'https://github.com' }],
  ]);
  private activeTabId = 'tab-1';

  getTabList() {
    return Array.from(this.tabs.values());
  }
  getActiveTabId() {
    return this.activeTabId;
  }
  getActiveTab() {
    return this.tabs.get(this.activeTabId);
  }
  getTab(id: string) {
    return this.tabs.get(id);
  }
  getTabSession(tabId: string): MockSession | null {
    if (tabId === 'tab-1') return this.tab1Session;
    if (tabId === 'tab-2') return this.tab2Session;
    return null;
  }
  getActiveTabSession(): MockSession {
    return this.activeSession;
  }
  getPartitionSession(_partition: string): MockSession {
    return this.partitionSession;
  }
  async captureScreenshot(): Promise<string> {
    return 'mock-base64';
  }
}

function requestHttp(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        let resBody = '';
        res.on('data', (chunk) => (resBody += chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: resBody,
          });
        });
      }
    );
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

describe('Bridge Cookie Import Endpoint & Target Isolation', () => {
  it('unit test: extensionCookieImportSetDetails handles Unix epoch seconds, RFC 6265bis, and sameSite', () => {
    const futureUnix = Math.floor(Date.now() / 1000) + 3600;
    const pastUnix = Math.floor(Date.now() / 1000) - 3600;

    // 1. Valid persistent cookie
    const validCookie = extensionCookieImportSetDetails({
      name: 'SID',
      value: 'valid-sid-value',
      domain: '.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
      expirationDate: futureUnix,
    });
    assert.ok(validCookie);
    assert.strictEqual(validCookie?.name, 'SID');
    assert.strictEqual(validCookie?.value, 'valid-sid-value');
    assert.strictEqual(validCookie?.url, 'https://google.com/');
    assert.strictEqual(validCookie?.domain, '.google.com');
    assert.strictEqual(validCookie?.expirationDate, futureUnix);
    assert.strictEqual(validCookie?.sameSite, 'no_restriction');

    // 2. Expired persistent cookie must be skipped (null)
    const expiredCookie = extensionCookieImportSetDetails({
      name: 'EXPIRED',
      value: 'old-val',
      domain: '.google.com',
      expirationDate: pastUnix,
    });
    assert.strictEqual(expiredCookie, null);

    // 3. __Host- cookie must not have domain attribute per RFC 6265bis
    const hostCookie = extensionCookieImportSetDetails({
      name: '__Host-GAPS',
      value: 'secret-host-val',
      domain: 'accounts.google.com',
      path: '/',
      secure: true,
    });
    assert.ok(hostCookie);
    assert.strictEqual(hostCookie?.name, '__Host-GAPS');
    assert.strictEqual(hostCookie?.domain, undefined);
    assert.strictEqual(hostCookie?.url, 'https://accounts.google.com/');

    // 4. Secure cookie with sameSite 'unspecified' must remain 'unspecified' (never converted to no_restriction)
    const unspecifiedCookie = extensionCookieImportSetDetails({
      name: 'SECURE_UNSPECIFIED',
      value: 'secure-unspecified-val',
      domain: '.google.com',
      path: '/',
      secure: true,
      sameSite: 'unspecified',
    });
    assert.ok(unspecifiedCookie);
    assert.strictEqual(unspecifiedCookie?.sameSite, 'unspecified');

    // 5. sameSite 'lax' and 'strict' exact preservation
    const laxCookie = extensionCookieImportSetDetails({
      name: 'LAX_COOKIE',
      value: 'lax-val',
      domain: '.google.com',
      sameSite: 'lax',
    });
    assert.strictEqual(laxCookie?.sameSite, 'lax');

    const strictCookie = extensionCookieImportSetDetails({
      name: 'STRICT_COOKIE',
      value: 'strict-val',
      domain: '.google.com',
      sameSite: 'strict',
    });
    assert.strictEqual(strictCookie?.sameSite, 'strict');

    // 6. Session cookie (no expirationDate) must not have expirationDate set
    const sessionCookie = extensionCookieImportSetDetails({
      name: 'SESSION_ONLY',
      value: 'session-val',
      domain: '.google.com',
    });
    assert.ok(sessionCookie);
    assert.strictEqual(sessionCookie?.expirationDate, undefined);

    // 7. Domain vs Host-only cookie:
    // Domain cookie (with leading dot) sets details.domain
    const dotDomainCookie = extensionCookieImportSetDetails({
      name: 'DOMAIN_COOKIE',
      value: 'dot-val',
      domain: '.example.com',
    });
    assert.strictEqual(dotDomainCookie?.domain, '.example.com');
    assert.strictEqual(dotDomainCookie?.url, 'http://example.com/');

    // Host-only cookie (without leading dot) omits details.domain
    const hostOnlyCookie = extensionCookieImportSetDetails({
      name: 'HOST_ONLY_COOKIE',
      value: 'host-val',
      domain: 'sub.example.com',
    });
    assert.strictEqual(hostOnlyCookie?.domain, undefined);
    assert.strictEqual(hostOnlyCookie?.url, 'http://sub.example.com/');

    // 8. Invalid / empty cookie returns null
    assert.strictEqual(extensionCookieImportSetDetails(null as unknown as Parameters<typeof extensionCookieImportSetDetails>[0]), null);
    assert.strictEqual(extensionCookieImportSetDetails({ name: '', value: 'test' }), null);
    assert.strictEqual(extensionCookieImportSetDetails({ name: 'test', value: 'val', domain: '' }), null);
  });

  it('rejects unauthenticated requests with 401 and never exposes master token on status', async () => {
    const mockHost = new MockTabHostWithSessions() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    const port = await server.start();

    // 1. /status must never leak the master token
    const statusRes = await requestHttp(port, 'GET', '/status');
    assert.strictEqual(statusRes.status, 200);
    const statusBody = JSON.parse(statusRes.body) as Record<string, unknown>;
    assert.strictEqual(statusBody['token'], undefined);

    // 2. Cookie import without token must return 401
    const resNoToken = await requestHttp(port, 'POST', '/api/cookies/import', {}, JSON.stringify({ cookies: [] }));
    assert.strictEqual(resNoToken.status, 401);

    // 3. Invalid token -> 401
    const resBadToken = await requestHttp(
      port,
      'POST',
      '/api/cookies/import',
      { Authorization: 'Bearer invalid-token-123' },
      JSON.stringify({ cookies: [] })
    );
    assert.strictEqual(resBadToken.status, 401);

    server.dispose();
  });

  it('handles CORS OPTIONS preflight correctly with allowed extension origins', async () => {
    const mockHost = new MockTabHostWithSessions() as unknown as NativeTabHost;
    const server = new BridgeServer(mockHost, 0);
    const port = await server.start();

    const preflight = await requestHttp(port, 'OPTIONS', '/api/cookies/import', {
      Origin: 'chrome-extension://bnhjdjiikfahdpfmfhnfhmfjpcmannpm',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type, Authorization',
    });

    assert.strictEqual(preflight.status, 204);
    assert.strictEqual(preflight.headers['access-control-allow-origin'], 'chrome-extension://bnhjdjiikfahdpfmfhnfhmfjpcmannpm');
    assert.ok(String(preflight.headers['access-control-allow-methods']).includes('POST'));

    server.dispose();
  });

  it('imports cookies strictly into the targeted tab session without leaking to others', async () => {
    const mockHost = new MockTabHostWithSessions();
    const server = new BridgeServer(mockHost as unknown as NativeTabHost, 0);
    const port = await server.start();
    const token = server.getToken();

    const futureUnix = Math.floor(Date.now() / 1000) + 7200;
    const payload = {
      tabId: 'tab-2',
      cookies: [
        {
          name: 'SESSION_ID',
          value: 'secret_github_session',
          domain: '.github.com',
          path: '/',
          secure: true,
          httpOnly: true,
          expirationDate: futureUnix,
        },
      ],
    };

    const res = await requestHttp(
      port,
      'POST',
      '/api/cookies/import',
      {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://bnhjdjiikfahdpfmfhnfhmfjpcmannpm',
      },
      JSON.stringify(payload)
    );

    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body) as { success: boolean; importedCount: number; targetTabId: string };
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.importedCount, 1);
    assert.strictEqual(body.targetTabId, 'tab-2');

    // VERIFICATION OF ISOLATION:
    // Tab-2 received the cookie
    assert.strictEqual(mockHost.tab2Session.cookiesList.length, 1);
    const firstCookie = mockHost.tab2Session.cookiesList[0];
    assert.ok(firstCookie);
    assert.strictEqual(firstCookie['name'], 'SESSION_ID');
    assert.strictEqual(mockHost.tab2Session.flushed, true);

    // Tab-1 and other sessions MUST be completely untouched (0 cookies)
    assert.strictEqual(mockHost.tab1Session.cookiesList.length, 0);
    assert.strictEqual(mockHost.activeSession.cookiesList.length, 0);
    assert.strictEqual(mockHost.partitionSession.cookiesList.length, 0);

    server.dispose();
  });

  it('rejects invalid or destroyed tabId with 400', async () => {
    const mockHost = new MockTabHostWithSessions();
    const server = new BridgeServer(mockHost as unknown as NativeTabHost, 0);
    const port = await server.start();
    const token = server.getToken();

    const res = await requestHttp(
      port,
      'POST',
      '/api/cookies/import',
      {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({ tabId: 'non-existent-tab', cookies: [{ name: 'A', value: 'B', domain: 'x.com' }] })
    );

    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body) as { success: boolean; error: string };
    assert.strictEqual(body.success, false);
    assert.ok(body.error.includes('Target tabId'));

    server.dispose();
  });

  it('enforces attachment token boundary: cannot target other tabs or partitions', async () => {
    const mockHost = new MockTabHostWithSessions();
    const registry = new AttachmentRegistry();
    const lease = {
      runtimeId: makeControlPlaneId('binding'),
      projectId: makeControlPlaneId('project'),
      workspaceId: makeControlPlaneId('workspace'),
      token: 'tok-1',
      protocolVersion: 1,
      hostEpoch: 1,
      ownerPid: process.pid,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    const { launch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'test-backend',
      lease,
      leaseToken: 'lease-tok',
      tabId: 'tab-1', // bound strictly to tab-1
    });
    const attachmentToken = launch.secret;

    const server = new BridgeServer(
      mockHost as unknown as NativeTabHost,
      0,
      false,
      undefined,
      undefined,
      registry
    );
    const port = await server.start();

    // 1. Attachment token attempting to target tab-2 (mismatch) must be rejected with 403
    const resMismatchTab = await requestHttp(
      port,
      'POST',
      '/api/cookies/import',
      {
        Authorization: `Bearer ${attachmentToken}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({ tabId: 'tab-2', cookies: [] })
    );
    assert.strictEqual(resMismatchTab.status, 403);

    // 2. Attachment token attempting to target partition must be rejected with 403
    const resPartition = await requestHttp(
      port,
      'POST',
      '/api/cookies/import',
      {
        Authorization: `Bearer ${attachmentToken}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({ partition: 'persist:custom', cookies: [] })
    );
    assert.strictEqual(resPartition.status, 403);

    // 3. Attachment token targeting its bound tab-1 succeeds
    const resBound = await requestHttp(
      port,
      'POST',
      '/api/cookies/import',
      {
        Authorization: `Bearer ${attachmentToken}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({ tabId: 'tab-1', cookies: [{ name: 'AUTH_TEST', value: '123', domain: '.google.com' }] })
    );
    assert.strictEqual(resBound.status, 200);
    assert.strictEqual(mockHost.tab1Session.cookiesList.length, 1);

    server.dispose();
  });
});
