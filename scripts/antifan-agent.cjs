#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — Per-Agent CLI Launcher
 * Authenticates with local AntiFan Bridge, acquires an ephemeral MCP attachment session,
 * injects credentials into the target AI CLI (omp, claude, codex, etc.),
 * and cleanly revokes attachment tokens upon process exit.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocket } = require('ws');

function printUsage() {
  console.log(`
AntiFan Agent Launcher (v1.0.0)
Usage:
  antifan <command> [args...]
  antifan-agent <command> [args...]

Examples:
  antifan omp
  antifan claude
  antifan codex
  antifan npm test
Description:
  Wraps any AI coding agent or CLI, granting it zero-trust, temporary access
  to control the live AntiFan Desktop Chromium instance.
`);
}

function resolveBridgeInfo() {
  const configDir = path.join(os.homedir(), '.antifan');
  const candidates = [
    path.join(configDir, 'bridge.json'),
    path.join(configDir, 'bridge-dev.json'),
    path.join(os.homedir(), '.gemini', 'antifan_bridge.json'),
    path.join(os.homedir(), '.gemini', 'antifan_bridge_dev.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.port === 'number') {
          return {
            port: parsed.port,
            host: parsed.host || '127.0.0.1',
            token: parsed.token || process.env.ANTIFAN_BRIDGE_TOKEN || '',
            isDev: Boolean(parsed.isDev),
          };
        }
      } catch {}
    }
  }

  // Fallback to environment variables if present
  if (process.env.ANTIFAN_BRIDGE_PORT) {
    return {
      port: parseInt(process.env.ANTIFAN_BRIDGE_PORT, 10),
      host: process.env.ANTIFAN_BRIDGE_HOST || '127.0.0.1',
      token: process.env.ANTIFAN_BRIDGE_TOKEN || '',
      isDev: false,
    };
  }

  return null;
}

function rpcCall(ws, method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`RPC timeout waiting for ${method}`));
    }, timeoutMs);

    function onMessage(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          if (msg.success) {
            resolve(msg.data);
          } else {
            reject(new Error(msg.error || `RPC ${method} failed`));
          }
        }
      } catch {}
    }

    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    printUsage();
    process.exit(0);
  }

  const bridgeInfo = resolveBridgeInfo();
  if (!bridgeInfo) {
    console.error('\x1b[31m[antifan-agent] Error: AntiFan Browser is not running.\x1b[0m');
    console.error('[antifan-agent] Please launch AntiFan Browser Desktop before running this agent.');
    process.exit(1);
  }

  const tokenParam = bridgeInfo.token ? `?token=${encodeURIComponent(bridgeInfo.token)}` : '';
  const wsUrl = `ws://${bridgeInfo.host}:${bridgeInfo.port}${tokenParam}`;
  let ws;
  try {
    ws = new WebSocket(wsUrl, {
      headers: bridgeInfo.token ? { Authorization: `Bearer ${bridgeInfo.token}` } : {},
    });
    await new Promise((resolve, reject) => {
      const connectTimer = setTimeout(() => reject(new Error('WebSocket connection timed out')), 5000);
      ws.on('open', () => {
        clearTimeout(connectTimer);
        resolve();
      });
      ws.on('error', (err) => {
        clearTimeout(connectTimer);
        reject(err);
      });
    });
  } catch (err) {
    console.error(`\x1b[31m[antifan-agent] Failed to connect to AntiFan Bridge on ${wsUrl}: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  let session;
  const boundPid = process.pid;
  try {
    session = await rpcCall(ws, 'antifan.cli.startSession', {
      backendId: 'cli',
      grant: 'write',
      ownerPid: boundPid,
      ttlMs: 3600000,
    });
  } catch (err) {
    console.error(`\x1b[31m[antifan-agent] Failed to obtain CLI session lease: ${err.message}\x1b[0m`);
    try { ws.close(); } catch {}
    process.exit(1);
  }
  const childEnv = {
    ...process.env,
    ANTIFAN_MCP_PORT: String(session.port || bridgeInfo.port),
    ANTIFAN_ATTACHMENT_SECRET: session.secret,
    ANTIFAN_ATTACHMENT_ID: session.attachmentId,
    ANTIFAN_RUN_ID: session.runId,
    ANTIFAN_ATTEMPT_ID: session.attemptId,
    ANTIFAN_PROJECT_ID: session.projectId,
    ANTIFAN_WORKSPACE_ID: session.workspaceId,
    ANTIFAN_OWNER_PID: String(boundPid),
    ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
      port: session.port || bridgeInfo.port,
      secret: session.secret,
      attachmentId: session.attachmentId,
      runId: session.runId,
      attemptId: session.attemptId,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      token: session.bridgeToken,
      ownerPid: boundPid,
    }),
  };

  const command = args[0];
  const commandArgs = args.slice(1);

  console.log(`\x1b[36m[antifan-agent] Attached session ${session.attachmentId.slice(0, 16)}... to ${command}\x1b[0m`);

  const child = spawn(command, commandArgs, {
    stdio: 'inherit',
    env: childEnv,
    shell: true,
  });

  let cleanedUp = false;
  const heartbeatInterval = setInterval(async () => {
    if (cleanedUp) return;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        await rpcCall(ws, 'antifan.cli.renewSession', {
          attachmentId: session.attachmentId,
          secret: session.secret,
          ownerPid: boundPid,
          extensionMs: 7200000,
        }, 3000);
      }
    } catch {}
  }, 30_000);
  heartbeatInterval.unref?.();

  async function cleanup(outcome = 'completed', error = undefined) {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeatInterval);
    try {
      if (ws.readyState === WebSocket.OPEN) {
        await rpcCall(ws, 'antifan.cli.endSession', {
          runId: session.runId,
          attemptId: session.attemptId,
          attachmentId: session.attachmentId,
          secret: session.secret,
          outcome,
          error,
        }, 3000);
      }
    } catch {}
    try { ws.close(); } catch {}
  }

  child.on('error', async (err) => {
    console.error(`\x1b[31m[antifan-agent] Failed to spawn ${command}: ${err.message}\x1b[0m`);
    await cleanup('failed', err.message);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    await cleanup('cancelled', 'User interrupted via SIGINT');
    process.exit(130);
  });

  process.on('SIGTERM', async () => {
    await cleanup('cancelled', 'Process terminated via SIGTERM');
    process.exit(143);
  });

  child.on('exit', async (code, signal) => {
    const outcome = (code === 0 && !signal) ? 'completed' : (signal ? 'cancelled' : 'failed');
    await cleanup(outcome, signal ? `Signal: ${signal}` : (code !== 0 ? `Exit code: ${code}` : undefined));
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error('[antifan-agent] Unexpected error:', err);
  process.exit(1);
});
