import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('OMP MCP stdio proxy security & bootstrap fail-closed contract', () => {
  it('wires persistent heartbeat renewal to the stdio lifecycle (same-terminal MCP sessions never expire while alive)', () => {
    const scriptPath = fs.existsSync(path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs'))
      ? path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs')
      : path.resolve(__dirname, '../../scripts/antifan-omp-mcp.cjs');
    const content = fs.readFileSync(scriptPath, 'utf8');

    assert.ok(content.includes('startHeartbeat'), 'Proxy must define a heartbeat kick-off');
    assert.ok(content.includes('renewBinding'), 'Proxy must define the renew RPC helper');
    assert.ok(content.includes('antifan.cli.renewSession'), 'Heartbeat must call antifan.cli.renewSession');
    assert.ok(content.includes('extensionMs'), 'Heartbeat must request an explicit extension window');
    assert.ok(content.includes('setInterval'), 'Heartbeat must run on an interval');
    assert.ok(content.includes("process.stdin.on('close',"), 'Heartbeat must stop when stdio closes');
    assert.ok(content.includes('SIGINT'), 'Heartbeat must stop on SIGINT');
    assert.ok(content.includes('SIGTERM'), 'Heartbeat must stop on SIGTERM');
    assert.ok(content.includes('stopHeartbeat'), 'Proxy must be able to stop the heartbeat');
    assert.ok(content.includes('server.connect('), 'Proxy must still connect the stdio server');
  });
  it('contains zero references to home directory, bridge json files, getRuntimeBinding, or openTab', () => {
    const scriptPath = fs.existsSync(path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs'))
      ? path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs')
      : path.resolve(__dirname, '../../scripts/antifan-omp-mcp.cjs');
    const content = fs.readFileSync(scriptPath, 'utf8');

    // Asserts no filesystem access or bridge credential discovery
    assert.strictEqual(content.includes('readBridge'), false, 'Must not define or call readBridge');
    assert.strictEqual(content.includes('bridge-dev.json'), false, 'Must not inspect bridge-dev.json');
    assert.strictEqual(content.includes('bridge.json'), false, 'Must not inspect bridge.json');
    assert.strictEqual(content.includes('.antifan'), false, 'Must not inspect ~/.antifan');
    assert.strictEqual(content.includes('getRuntimeBinding'), false, 'Must not call getRuntimeBinding');
    assert.strictEqual(content.includes('openTab'), false, 'Must not call openTab');
    assert.strictEqual(content.includes("require('node:fs')"), false, 'Must not require node:fs');
  });

  it('fails closed with MCP_CONTEXT_REQUIRED when no bootstrap is in environment', async () => {
    // Spawn child process running the proxy and request list tools and call tool without bootstrap
    const { spawn } = await import('node:child_process');
    const scriptPath = fs.existsSync(path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs'))
      ? path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs')
      : path.resolve(__dirname, '../../scripts/antifan-omp-mcp.cjs');

    const env = { ...process.env };
    delete env.ANTIFAN_MCP_BOOTSTRAP;
    delete env.ANTIFAN_ATTACHMENT_SECRET;
    delete env.ANTIFAN_ATTACHMENT_ID;

    const child = spawn(process.execPath, [scriptPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const sendJsonRpc = (msg: any) => {
      child.stdin.write(JSON.stringify(msg) + '\n');
    };

    let received = '';
    const responsePromise = new Promise<any>((resolve) => {
      child.stdout.on('data', (chunk) => {
        received += chunk.toString();
        const lines = received.split('\n');
        for (const line of lines) {
          if (line.trim().length > 0) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.id === 1) {
                resolve(parsed);
              }
            } catch {}
          }
        }
      });
    });

    // Send initialize request
    sendJsonRpc({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });

    // Send a tool call
    sendJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'anti.browser.tabs.list',
        arguments: {},
      },
    });

    const res = await responsePromise;
    child.kill();

    assert.ok(res.result.isError, 'Tool call must return isError: true when bootstrap is absent');
    const errorText = res.result.content[0].text;
    assert.ok(errorText.includes('MCP_CONTEXT_REQUIRED'), 'Must return MCP_CONTEXT_REQUIRED error code');
  });
  it('keeps ONE long-lived heartbeat connection alive across renewals on a real ws server', async () => {
    const { spawn } = await import('node:child_process');
    const { WebSocketServer } = await import('ws');
    const scriptPath = fs.existsSync(path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs'))
      ? path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs')
      : path.resolve(__dirname, '../../scripts/antifan-omp-mcp.cjs');

    // Local bridge stand-in. The real bridge emits antifan:init on connect and
    // answers antifan.cli.renewSession — the heartbeat must ignore the init
    // event and renew repeatedly over the SAME socket (never reconnect).
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    // listen() is async: address() is undefined until the listening event fires.
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as any).port;
    let connections = 0;
    const renewParams: any[] = [];
    wss.on('connection', (socket) => {
      connections += 1;
      socket.send(JSON.stringify({ type: 'event', event: 'antifan:init', data: { status: 'ok' } }));
      socket.on('message', (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.method !== 'antifan.cli.renewSession') return;
        renewParams.push(msg.params);
        socket.send(JSON.stringify({ id: 'hb', success: true, data: { expiresAt: Date.now() + 7_200_000 } }));
      });
    });
    // Deadline race only — no wall-clock state to advance.
    const deadline = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('heartbeat behavioral test timed out')), 10_000);
      t.unref?.();
    });

    const env = {
      ...process.env,
      ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
        port,
        secret: 'test-secret-for-behavioral',
        attachmentId: 'binding-behavioral-test',
        runId: 'r-behavioral',
        attemptId: 'a-behavioral',
        projectId: 'p-behavioral',
        workspaceId: 'w-behavioral',
        ownerPid: 424_242,
      }),
      // Fast interval for the test; production default stays 30_000.
      ANTIFAN_HEARTBEAT_MS: '200',
    };
    const child = spawn(process.execPath, [scriptPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? -1)));

    try {
      // Wait for two renewals on the fixed 200ms interval (deadline-capped).
      await Promise.race([
        new Promise<void>((resolve) => {
          const check = () => { if (renewParams.length >= 2) resolve(); else setImmediate(check); };
          check();
        }),
        deadline,
      ]);

      assert.strictEqual(connections, 1, 'Heartbeat must reuse one connection, never reconnect per renewal');
      assert.ok(renewParams.length >= 2, 'Heartbeat must renew repeatedly on the persistent socket');
      for (const params of renewParams) {
        assert.strictEqual(params.attachmentId, 'binding-behavioral-test');
        assert.strictEqual(params.secret, 'test-secret-for-behavioral');
        assert.strictEqual(params.ownerPid, 424_242);
        assert.strictEqual(params.extensionMs, 7_200_000);
      }
    } finally {
      child.kill();
      await Promise.race([exited, deadline]);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('injects authorityRevision from ANTIFAN_MCP_BOOTSTRAP into capability dispatch intents', async () => {
    const { spawn } = await import('node:child_process');
    const { WebSocketServer } = await import('ws');
    const scriptPath = fs.existsSync(path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs'))
      ? path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs')
      : path.resolve(__dirname, '../../scripts/antifan-omp-mcp.cjs');

    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as any).port;
    let dispatchReceived: any = null;

    wss.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'event', event: 'antifan:init', data: { status: 'ok' } }));
      socket.on('message', (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.method === 'antifan.capability.dispatch') {
          dispatchReceived = msg.params;
          socket.send(JSON.stringify({
            id: msg.id,
            success: true,
            data: {
              data: [{ id: 'tab-1', url: 'https://store.example.com' }],
              authorityRevision: 'rev-updated-2',
            },
          }));
        }
      });
    });

    const env = {
      ...process.env,
      ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
        port,
        secret: 'test-secret-rev',
        attachmentId: 'binding-rev-test',
        authorityRevision: 'rev-initial-1',
        runId: 'r-rev',
        attemptId: 'a-rev',
        projectId: 'p-rev',
        workspaceId: 'w-rev',
      }),
    };

    const child = spawn(process.execPath, [scriptPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const sendJsonRpc = (msg: any) => {
      child.stdin.write(JSON.stringify(msg) + '\n');
    };

    let received = '';
    const responsePromise = new Promise<any>((resolve) => {
      child.stdout.on('data', (chunk) => {
        received += chunk.toString();
        const lines = received.split('\n');
        for (const line of lines) {
          if (line.trim().length > 0) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.id === 2) {
                resolve(parsed);
              }
            } catch {}
          }
        }
      });
    });

    try {
      sendJsonRpc({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'anti.browser.tabs.list',
          arguments: {},
        },
      });

      const res = await responsePromise;
      assert.strictEqual(res.result.isError, undefined);
      assert.ok(dispatchReceived, 'Dispatch must be received on WebSocket');
      assert.strictEqual(dispatchReceived.authorityRevision, 'rev-initial-1');
      assert.strictEqual(dispatchReceived.attachmentId, 'binding-rev-test');
      assert.strictEqual(dispatchReceived.attachmentSecret, 'test-secret-rev');
    } finally {
      child.kill();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('registers anti.artifact.read and clamps limit to <= 32768 bytes on dispatch', async () => {
    const { spawn } = await import('node:child_process');
    const { WebSocketServer } = await import('ws');
    const scriptPath = fs.existsSync(path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs'))
      ? path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs')
      : path.resolve(__dirname, '../../scripts/antifan-omp-mcp.cjs');

    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as any).port;

    let dispatchReceived: any = null;
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.method === 'antifan.capability.dispatch') {
            dispatchReceived = msg.params;
            ws.send(JSON.stringify({
              id: msg.id,
              success: true,
              data: {
                data: {
                  chunk: 'dGVzdA==',
                  bytesRead: 4,
                  totalBytes: 4,
                  hasMore: false,
                },
              },
            }));
          }
        } catch {}
      });
    });

    const bootstrap = {
      port,
      secret: 'secret-artifact-clamp',
      attachmentId: 'att-artifact-clamp',
      authorityRevision: 'rev-clamp-1',
    };

    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ANTIFAN_MCP_BOOTSTRAP: JSON.stringify(bootstrap) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const sendJsonRpc = (msg: any) => child.stdin.write(JSON.stringify(msg) + '\n');

    let received = '';
    const responsePromise = new Promise<any>((resolve) => {
      child.stdout.on('data', (chunk) => {
        received += chunk.toString();
        const lines = received.split('\n');
        for (const line of lines) {
          if (line.trim().length > 0) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.id === 10) resolve(parsed);
            } catch {}
          }
        }
      });
    });

    try {
      sendJsonRpc({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      });

      // Request artifact.read with limit: 1048576 (1MB) - proxy must clamp to 32768 (32KB)
      sendJsonRpc({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'anti.artifact.read',
          arguments: {
            artifactId: 'artifact-test-123',
            offset: 0,
            limit: 1048576,
          },
        },
      });

      const res = await responsePromise;
      assert.strictEqual(res.result.isError, undefined);
      assert.ok(dispatchReceived, 'Dispatch must be received on WebSocket');
      assert.strictEqual(dispatchReceived.name, 'artifact.read');
      assert.strictEqual(dispatchReceived.params.limit, 32768, 'Proxy must clamp limit to <= 32768 bytes');
    } finally {
      child.kill();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('preserves ArtifactRef metadata without saturating stdio when payload >= 64KB', async () => {
    const { spawn } = await import('node:child_process');
    const { WebSocketServer } = await import('ws');
    const scriptPath = fs.existsSync(path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs'))
      ? path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs')
      : path.resolve(__dirname, '../../scripts/antifan-omp-mcp.cjs');

    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as any).port;

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.method === 'antifan.capability.dispatch') {
            ws.send(JSON.stringify({
              id: msg.id,
              success: true,
              data: {
                data: {
                  id: 'artifact-large-dom-1',
                  byteLength: 150000,
                  sha256: 'abc123sha',
                  mime: 'text/html',
                },
              },
            }));
          }
        } catch {}
      });
    });

    const bootstrap = {
      port,
      secret: 'secret-artifact-large',
      attachmentId: 'att-artifact-large',
      authorityRevision: 'rev-large-1',
    };

    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ANTIFAN_MCP_BOOTSTRAP: JSON.stringify(bootstrap) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const sendJsonRpc = (msg: any) => child.stdin.write(JSON.stringify(msg) + '\n');

    let received = '';
    const responsePromise = new Promise<any>((resolve) => {
      child.stdout.on('data', (chunk) => {
        received += chunk.toString();
        const lines = received.split('\n');
        for (const line of lines) {
          if (line.trim().length > 0) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.id === 20) resolve(parsed);
            } catch {}
          }
        }
      });
    });

    try {
      sendJsonRpc({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      });

      sendJsonRpc({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'anti.inspect.dom',
          arguments: { selector: 'body' },
        },
      });

      const res = await responsePromise;
      assert.strictEqual(res.result.isError, undefined);
      const textContent = res.result.content[0].text;
      const parsedRef = JSON.parse(textContent);
      assert.strictEqual(parsedRef._type, 'ArtifactRef');
      assert.strictEqual(parsedRef.id, 'artifact-large-dom-1');
      assert.strictEqual(parsedRef.byteLength, 150000);
      assert.ok(parsedRef.message.includes('ArtifactRef'), 'Must explain artifact reference for large payload');
    } finally {
      child.kill();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('returns raw ArtifactRef metadata for anti.artifact.stat without content hydration', async () => {
    const { spawn } = await import('node:child_process');
    const { WebSocketServer } = await import('ws');
    const scriptPath = fs.existsSync(path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs'))
      ? path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs')
      : path.resolve(__dirname, '../../scripts/antifan-omp-mcp.cjs');

    const expectedStat = {
      id: 'artifact-small-dom-1',
      runId: 'run-1',
      attemptId: 'att-1',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      kind: 'dom',
      path: 'artifacts/run-1/dom.html',
      byteLength: 512,
      sha256: 'smallsha256hash',
      mime: 'text/html',
      truncated: false,
      redacted: false,
      createdAt: 1725280000000,
    };

    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as any).port;

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.method === 'antifan.capability.dispatch') {
            ws.send(JSON.stringify({
              id: msg.id,
              success: true,
              data: {
                data: expectedStat,
              },
            }));
          }
        } catch {}
      });
    });

    const bootstrap = {
      port,
      secret: 'secret-stat-test',
      attachmentId: 'att-stat-test',
      authorityRevision: 'rev-stat-1',
    };

    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ANTIFAN_MCP_BOOTSTRAP: JSON.stringify(bootstrap) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const sendJsonRpc = (msg: any) => child.stdin.write(JSON.stringify(msg) + '\n');

    let received = '';
    const responsePromise = new Promise<any>((resolve) => {
      child.stdout.on('data', (chunk) => {
        received += chunk.toString();
        const lines = received.split('\n');
        for (const line of lines) {
          if (line.trim().length > 0) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.id === 30) resolve(parsed);
            } catch {}
          }
        }
      });
    });

    try {
      sendJsonRpc({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      });

      sendJsonRpc({
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: {
          name: 'anti.artifact.stat',
          arguments: { artifactId: 'artifact-small-dom-1' },
        },
      });

      const res = await responsePromise;
      assert.strictEqual(res.result.isError, undefined);
      const textContent = res.result.content[0].text;
      const parsedStat = JSON.parse(textContent);
      assert.strictEqual(parsedStat.id, 'artifact-small-dom-1');
      assert.strictEqual(parsedStat.byteLength, 512);
      assert.strictEqual(parsedStat.sha256, 'smallsha256hash');
      assert.strictEqual(parsedStat.kind, 'dom');
      assert.strictEqual(parsedStat.mime, 'text/html');
    } finally {
      child.kill();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('routes evaluate on background tab headlessly without invoking switch-tab', async () => {
    const { spawn } = await import('node:child_process');
    const { WebSocketServer } = await import('ws');
    const scriptPath = fs.existsSync(path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs'))
      ? path.resolve(__dirname, '../../../scripts/antifan-omp-mcp.cjs')
      : path.resolve(__dirname, '../../scripts/antifan-omp-mcp.cjs');

    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as any).port;

    const dispatchedNames: string[] = [];
    let evaluateReceivedParams: any = null;

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.method === 'antifan.capability.dispatch') {
            dispatchedNames.push(msg.params?.name);
            if (msg.params?.name === 'anti.browser.evaluate') {
              evaluateReceivedParams = msg.params?.params;
              ws.send(JSON.stringify({
                id: msg.id,
                success: true,
                data: {
                  data: { result: 'evaluation-success' },
                },
              }));
            } else {
              ws.send(JSON.stringify({
                id: msg.id,
                success: true,
                data: { data: { switched: true } },
              }));
            }
          }
        } catch {}
      });
    });

    const bootstrap = {
      port,
      secret: 'secret-eval-no-switch',
      attachmentId: 'att-eval-no-switch',
      authorityRevision: 'rev-eval-1',
      tabId: 'tab-user-foreground',
    };

    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ANTIFAN_MCP_BOOTSTRAP: JSON.stringify(bootstrap) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const sendJsonRpc = (msg: any) => child.stdin.write(JSON.stringify(msg) + '\n');

    let received = '';
    const responsePromise = new Promise<any>((resolve) => {
      child.stdout.on('data', (chunk) => {
        received += chunk.toString();
        const lines = received.split('\n');
        for (const line of lines) {
          if (line.trim().length > 0) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.id === 40) resolve(parsed);
            } catch {}
          }
        }
      });
    });

    try {
      sendJsonRpc({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      });

      // Execute evaluate on a different tabId (background tab)
      sendJsonRpc({
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/call',
        params: {
          name: 'anti.browser.evaluate',
          arguments: {
            expression: 'document.title',
            tabId: 'tab-agent-background',
          },
        },
      });

      const res = await responsePromise;
      assert.strictEqual(res.result.isError, undefined);
      assert.ok(evaluateReceivedParams, 'Evaluate capability must be dispatched');
      assert.strictEqual(evaluateReceivedParams.tabId, 'tab-agent-background');
      assert.strictEqual(
        dispatchedNames.includes('browser.switch-tab'),
        false,
        `Expected zero switch-tab calls, but received: ${JSON.stringify(dispatchedNames)}`
      );
    } finally {
      child.kill();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
