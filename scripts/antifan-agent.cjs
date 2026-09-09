#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — Per-Agent CLI Launcher
 * Authenticates with local AntiFan Bridge, acquires an ephemeral MCP attachment session,
 * injects credentials into the target AI CLI (omp, claude, codex, etc.),
 * and cleanly revokes attachment tokens upon process exit.
 */

const spawn = require('cross-spawn');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocket } = require('ws');

function printUsage() {
  console.log(`
AntiFan Agent Launcher (v1.0.0)
Usage:
  antifan [--tab=<tabId>] <command> [args...]
  antifan-agent [--tab=<tabId>] <command> [args...]

Options:
  --tab=<tabId>, -t <tabId>   Explicitly bind to a Chromium tab ID

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
    process.env.APPDATA ? path.join(process.env.APPDATA, 'AntiFan', 'data', 'config') : null,
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


function httpJsonPost(host, port, requestPath, payload) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload || {});
    const req = http.request({
      hostname: host,
      port: port,
      path: requestPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const msg = parsed.message || parsed.error || `HTTP ${res.statusCode}`;
            reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)));
          }
        } catch {
          reject(new Error(`Failed to parse JSON response (${res.statusCode}): ${data}`));
        }
      });
    });
    req.setTimeout(15000, () => {
      req.destroy(new Error('Pairing request timeout'));
    });
    req.on('error', (err) => {
      reject(err);
    });
    req.write(postData);
    req.end();
  });
}

async function performPairingExchange(host, port) {
  const challenge = await httpJsonPost(host, port, '/api/pairing/challenge', {});
  const code = challenge?.code;
  if (!challenge?.success || !code) {
    throw new Error(`PAIRING_CHALLENGE_FAILED: ${challenge?.message || challenge?.error || 'No challenge code returned'}`);
  }
  const exchange = await httpJsonPost(host, port, '/api/pairing/exchange', {
    code,
    clientClass: 'mcp',
  });
  if (!exchange?.success || !exchange?.secret) {
    throw new Error(`PAIRING_EXCHANGE_FAILED: ${exchange?.message || exchange?.error || 'No secret returned'}`);
  }
  return exchange;
}

async function acquireBridgeSession(candidates, boundPid, explicitTabId) {
  const errors = [];
  for (const candidate of candidates) {
    const wsUrl = `ws://${candidate.host}:${candidate.port}`;
    let ws;
    let authSecret = candidate.token || '';
    let pairedExchange = null;
    try {
      if (!authSecret) {
        pairedExchange = await performPairingExchange(candidate.host, candidate.port);
        authSecret = pairedExchange.secret;
      }

      const headers = {};
      if (pairedExchange && pairedExchange.secret) {
        headers['x-antifan-attachment-secret'] = pairedExchange.secret;
        headers['Authorization'] = `Bearer ${pairedExchange.secret}`;
      } else if (authSecret) {
        headers['Authorization'] = `Bearer ${authSecret}`;
        headers['x-antifan-attachment-secret'] = authSecret;
      }

      ws = new WebSocket(wsUrl, { headers });

      await new Promise((resolve, reject) => {
        let settled = false;
        const connectTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('WebSocket connection timed out'));
          }
        }, 15000);

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
            reject(new Error(`WebSocket closed early with code ${code}: ${reason?.toString() || 'Unauthorized'}`));
          }
        });
      });

      const rawTerminalId = process.env.ANTIFAN_TERMINAL_AFFINITY_SESSION_ID || process.env.ANTIFAN_TERMINAL_PARENT_SESSION_ID || process.env.ANTIFAN_TERMINAL_SESSION_ID;
      const rawGen = process.env.ANTIFAN_TERMINAL_AFFINITY_GENERATION || process.env.ANTIFAN_TERMINAL_GENERATION;
      const session = await rpcCall(ws, 'antifan.cli.startSession', {
        backendId: 'cli',
        grant: 'eval',
        ownerPid: boundPid,
        ttlMs: 3600000,
        tabId: explicitTabId || undefined,
        terminalSessionId: rawTerminalId ? String(rawTerminalId).trim() : undefined,
        terminalGeneration: rawGen ? String(rawGen).trim() : undefined,
        attachmentId: pairedExchange?.attachmentId || undefined,
      }, 5000);
      const targetTabId = session?.tabId || explicitTabId;
      if (!session || !session.attachmentId || !session.secret || !session.authorityRevision || !targetTabId) {
        const missing = [
          !session?.attachmentId && 'attachmentId',
          !session?.secret && 'secret',
          !session?.authorityRevision && 'authorityRevision',
          !targetTabId && 'tabId',
        ].filter(Boolean).join(', ');
        const err = new Error(`BOOTSTRAP_INVALID: Bridge startSession response missing mandatory fields (${missing})`);
        err.code = 'BOOTSTRAP_INVALID';
        err.missing = missing;
        throw err;
      }

      return { ws, bridgeInfo: candidate, session };
    } catch (err) {
      errors.push(`${wsUrl} (${candidate.file || candidate.source || 'endpoint'}): ${err.message}`);
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

function parseLauncherArgs(argv) {
  let explicitTabId = undefined;
  const commandArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--tab=')) {
      const val = arg.slice('--tab='.length).trim();
      if (!val) {
        throw new Error('--tab requires a non-empty tabId.');
      }
      explicitTabId = val;
    } else if (arg === '--tab' || arg === '-t') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        explicitTabId = argv[i + 1].trim();
        i++;
      } else {
        throw new Error('--tab requires a non-empty tabId.');
      }
    } else {
      commandArgs.push(arg);
    }
  }
  return { tabId: explicitTabId, commandArgs };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs[0] === '-h' || rawArgs[0] === '--help') {
    printUsage();
    process.exit(0);
  }

  let parsed;
  try {
    parsed = parseLauncherArgs(rawArgs);
  } catch (err) {
    console.error(`\x1b[31m[antifan-agent] Error: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  const explicitTabId = parsed.tabId;
  const args = parsed.commandArgs;
  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }
  const candidates = resolveBridgeCandidates();
  if (candidates.length === 0) {
    console.error('MCP_BRIDGE_OFFLINE: AntiFan Browser Desktop is not running.');
    console.error('[antifan-agent] Please launch AntiFan Browser Desktop before running this agent.');
    process.exit(1);
  }

  const boundPid = process.pid;
  let bridgeAcquisition;
  try {
    bridgeAcquisition = await acquireBridgeSession(candidates, boundPid, explicitTabId);
  } catch (err) {
    console.error(`MCP_BRIDGE_OFFLINE: Failed to connect to AntiFan Bridge after bounded attempts:\n${err.message}`);
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
    ANTIFAN_BOUND_TAB_ID: session.tabId || explicitTabId || '',
    ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
      port: session.port || bridgeInfo.port,
      secret: session.secret,
      attachmentId: session.attachmentId,
      authorityRevision: session.authorityRevision,
      runId: session.runId,
      attemptId: session.attemptId,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      tabId: session.tabId || explicitTabId,
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
    performPairingExchange,
    spawnAgentChild,
    resolveAgentCommand,
    parseLauncherArgs,
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
