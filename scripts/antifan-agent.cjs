#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — Per-Agent CLI Launcher
 * Authenticates with local AntiFan Bridge, acquires an ephemeral MCP attachment session,
 * injects credentials into the target AI CLI (omp, claude, codex, etc.),
 * and cleanly revokes attachment tokens upon process exit.
 */

const spawn = require('cross-spawn');
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
  antifan mcp
  antifan omp
  antifan claude
  antifan codex
  antifan npm test
Description:
  Wraps any AI coding agent or CLI, granting it zero-trust, temporary access
  to control the live AntiFan Desktop Chromium instance.
`);
}

function resolveBridgeCandidates() {
  const candidates = [];
  const seenTargets = new Set();

  // 1. Explicit environment variables take top priority
  if (process.env.ANTIFAN_BRIDGE_PORT) {
    const port = parseInt(process.env.ANTIFAN_BRIDGE_PORT, 10);
    const host = process.env.ANTIFAN_BRIDGE_HOST || '127.0.0.1';
    const token = process.env.ANTIFAN_BRIDGE_TOKEN || '';
    if (!Number.isNaN(port) && port > 0) {
      const targetKey = `${host}:${port}:${token}`;
      seenTargets.add(targetKey);
      candidates.push({
        source: 'env',
        file: null,
        port,
        host,
        token,
        pid: null,
        pidAlive: true,
        startedAt: Date.now() + 100000,
        isDev: false,
      });
    }
  }

  // 2. Discover configuration directories across Drive E and standard locations
  const candidateDirs = [
    process.env.ANTIFAN_CONFIG_DIR,
    process.env.ANTIFAN_DATA_ROOT ? path.join(process.env.ANTIFAN_DATA_ROOT, 'config') : null,
    path.join('E:', 'Work', '.antifan-data', 'config'),
    path.join('E:\\', 'Work', '.antifan-data', 'config'),
    path.join('E:', '.antifan-data', 'config'),
    path.join('D:', 'Work', '.antifan-data', 'config'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'antifan-browser-desktop', 'data', 'config') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'antifan-data', 'config') : null,
    path.join(os.homedir(), '.antifan'),
    path.join(os.homedir(), '.gemini'),
  ].filter(Boolean);

  const fileNames = ['bridge-dev.json', 'bridge.json', 'antifan_bridge_dev.json', 'antifan_bridge.json'];
  const seenFiles = new Set();

  for (const dir of candidateDirs) {
    for (const name of fileNames) {
      const filePath = path.resolve(dir, name);
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);

      if (fs.existsSync(filePath)) {
        try {
          const stat = fs.statSync(filePath);
          const raw = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.port === 'number' && parsed.port > 0) {
            const host = parsed.host || '127.0.0.1';
            const port = parsed.port;
            const token = parsed.token || '';
            const targetKey = `${host}:${port}:${token}`;
            if (seenTargets.has(targetKey)) continue;
            seenTargets.add(targetKey);

            let pidAlive = null;
            if (parsed.pid && typeof parsed.pid === 'number') {
              try {
                process.kill(parsed.pid, 0);
                pidAlive = true;
              } catch (err) {
                pidAlive = err.code === 'EPERM' ? true : false;
              }
            }

            candidates.push({
              source: 'file',
              file: filePath,
              port,
              host,
              token,
              pid: parsed.pid,
              pidAlive,
              startedAt: parsed.startedAt || stat.mtimeMs || 0,
              isDev: Boolean(parsed.isDev),
            });
          }
        } catch {}
      }
    }
  }

  // Sort candidates:
  // 1. Live processes (2) > env/unknown (1) > dead processes (0)
  // 2. Dev before prod if same liveness rank
  // 3. Newer startedAt timestamp before older
  candidates.sort(compareCandidates);

  return candidates;
}

function getLivenessRank(pidAlive) {
  if (pidAlive === true) return 2;
  if (pidAlive === null) return 1;
  return 0;
}

function compareCandidates(a, b) {
  const livenessDiff = getLivenessRank(b.pidAlive) - getLivenessRank(a.pidAlive);
  if (livenessDiff !== 0) return livenessDiff;

  const devDiff = (b.isDev ? 1 : 0) - (a.isDev ? 1 : 0);
  if (devDiff !== 0) return devDiff;

  return (b.startedAt || 0) - (a.startedAt || 0);
}


async function acquireBridgeSession(candidates, boundPid) {
  const errors = [];
  for (const candidate of candidates) {
    const sanitizedEndpoint = `ws://${candidate.host}:${candidate.port}`;
    const tokenParam = candidate.token ? `?token=${encodeURIComponent(candidate.token)}` : '';
    const wsUrl = `${sanitizedEndpoint}${tokenParam}`;
    let ws;
    try {
      ws = new WebSocket(wsUrl, {
        headers: candidate.token ? { Authorization: `Bearer ${candidate.token}` } : {},
      });

      await new Promise((resolve, reject) => {
        let settled = false;
        const connectTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('WebSocket connection timed out'));
          }
        }, 3000);

        ws.once('open', () => {
          if (!settled) {
            settled = true;
            clearTimeout(connectTimer);
            resolve();
          }
        });
        ws.once('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(connectTimer);
            reject(err);
          }
        });
        ws.once('close', (code, reason) => {
          if (!settled) {
            settled = true;
            clearTimeout(connectTimer);
            reject(new Error(`WebSocket closed early with code ${code}: ${reason.toString() || 'Unauthorized'}`));
          }
        });
      });

      const session = await rpcCall(ws, 'antifan.cli.startSession', {
        backendId: 'cli',
        grant: 'eval',
        ownerPid: boundPid,
        ttlMs: 3600000,
      }, 5000);

      if (!session || !session.attachmentId || !session.secret) {
        throw new Error('Invalid session payload received from bridge');
      }

      return { ws, bridgeInfo: candidate, session };
    } catch (err) {
      errors.push(`${sanitizedEndpoint} (${candidate.file || candidate.source || 'endpoint'}): ${err.message}`);
      try { ws?.close(); } catch {}
    }
  }
  throw new Error(`All candidate endpoints failed to authenticate or connect:\n  - ${errors.join('\n  - ')}`);
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

  const candidates = resolveBridgeCandidates();
  if (candidates.length === 0) {
    console.error('\x1b[31m[antifan-agent] Error: AntiFan Browser is not running.\x1b[0m');
    console.error('[antifan-agent] Please launch AntiFan Browser Desktop before running this agent.');
    process.exit(1);
  }

  const boundPid = process.pid;
  let bridgeAcquisition;
  try {
    bridgeAcquisition = await acquireBridgeSession(candidates, boundPid);
  } catch (err) {
    console.error(`\x1b[31m[antifan-agent] Failed to connect to AntiFan Bridge:\x1b[0m\n${err.message}`);
    console.error('[antifan-agent] Please verify that AntiFan Browser Desktop is running and responsive.');
    process.exit(1);
  }
  const { ws, bridgeInfo, session } = bridgeAcquisition;
  const sanitizedParentEnv = { ...process.env };
  delete sanitizedParentEnv.ANTIFAN_BRIDGE_TOKEN;
  delete sanitizedParentEnv.ANTIFAN_BRIDGE_PORT;
  delete sanitizedParentEnv.ANTIFAN_BRIDGE_HOST;

  const childEnv = {
    ...sanitizedParentEnv,
    ANTIFAN_MCP_PORT: String(session.port || bridgeInfo.port),
    ANTIFAN_ATTACHMENT_SECRET: session.secret,
    ANTIFAN_ATTACHMENT_ID: session.attachmentId,
    ANTIFAN_AUTHORITY_REVISION: session.authorityRevision,
    ANTIFAN_RUN_ID: session.runId,
    ANTIFAN_ATTEMPT_ID: session.attemptId,
    ANTIFAN_PROJECT_ID: session.projectId,
    ANTIFAN_WORKSPACE_ID: session.workspaceId,
    ANTIFAN_OWNER_PID: String(boundPid),
    ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
      port: session.port || bridgeInfo.port,
      secret: session.secret,
      attachmentId: session.attachmentId,
      authorityRevision: session.authorityRevision,
      runId: session.runId,
      attemptId: session.attemptId,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      token: session.bridgeToken,
      ownerPid: boundPid,
    }),
  };
  const { command, commandArgs } = resolveAgentCommand(args, __dirname);

  console.error(`\x1b[36m[antifan-agent] Attached session ${session.attachmentId.slice(0, 16)}... to ${args[0]}\x1b[0m`);

  const child = spawnAgentChild(command, commandArgs, childEnv);

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

function resolveAgentCommand(args, scriptsDir = __dirname) {
  if (!args || args.length === 0) {
    return { command: '', commandArgs: [], isMcpAlias: false };
  }
  const rawCommand = args[0];
  const restArgs = args.slice(1);

  if (rawCommand === 'mcp' || rawCommand === 'mcp-server' || rawCommand === 'stdio' || rawCommand === 'omp-mcp') {
    return {
      command: process.execPath,
      commandArgs: [path.resolve(scriptsDir, 'antifan-omp-mcp.cjs'), ...restArgs],
      isMcpAlias: true,
    };
  }

  return {
    command: rawCommand,
    commandArgs: restArgs,
    isMcpAlias: false,
  };
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[antifan-agent] Unexpected error:', err);
    process.exit(1);
  });
} else {
  module.exports = {
    resolveBridgeCandidates,
    getLivenessRank,
    compareCandidates,
    acquireBridgeSession,
    spawnAgentChild,
    resolveAgentCommand,
  };
}

function spawnAgentChild(command, commandArgs, env, spawnOptions = {}) {
  const finalEnv = { ...(env || process.env) };
  delete finalEnv.ANTIFAN_BRIDGE_TOKEN;
  delete finalEnv.ANTIFAN_BRIDGE_PORT;
  delete finalEnv.ANTIFAN_BRIDGE_HOST;

  const { env: _ignoredEnv, ...restOptions } = spawnOptions;
  return spawn(command, commandArgs, {
    stdio: 'inherit',
    windowsHide: true,
    ...restOptions,
    env: finalEnv,
  });
}
