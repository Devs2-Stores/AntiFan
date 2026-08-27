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
});
