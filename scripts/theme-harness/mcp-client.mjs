/**
 * Bridge discovery + MCP stdio client for the live layers.
 *
 * The harness reaches the running AntiFan Desktop app through
 * `scripts/antifan-omp-mcp.cjs`, spawned as a stdio MCP child — the same
 * pattern `scripts/smoke-theme-golden-live.cjs` uses. The child connects to
 * the live bridge over the pairing/socket machinery it already owns; this
 * module only discovers the bridge endpoint (delegated to the launcher's
 * single candidate authority, `scripts/antifan-agent.cjs`) and hands the
 * child a pinned bootstrap plus `ANTIFAN_BRIDGE_PID` so its failover
 * discovery is enabled for the same instance.
 *
 * Nothing here fabricates a session: when no bridge candidate exists the
 * caller gets `ok:false` and the layer reports BLOCKED.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveBridgeCandidates } = require('../antifan-agent.cjs');

const MCP_SERVER = 'scripts/antifan-omp-mcp.cjs';
const DEFAULT_TOOL_TIMEOUT_MS = 240_000;

/**
 * Discover the best live bridge candidate.
 * @returns {{ ok: true, candidate: {host:string, port:number, token:string, pid:number|null, file:string|null} }
 *   | { ok: false, reason: string }}
 */
export function discoverBridge() {
  let candidates;
  try {
    candidates = resolveBridgeCandidates();
  } catch (err) {
    return { ok: false, reason: `bridge discovery failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, reason: 'BRIDGE_NOT_RUNNING: no AntiFan Desktop bridge endpoint discovered (no env pin, no discovery file)' };
  }
  const best = candidates[0];
  return {
    ok: true,
    candidate: {
      host: best.host || '127.0.0.1',
      port: best.port,
      token: best.token || '',
      pid: typeof best.pid === 'number' ? best.pid : null,
      file: best.file || null,
    },
  };
}

/** A bridge description safe to persist in evidence — no token, no secret. */
export function sanitizeBridge(candidate) {
  if (!candidate) return null;
  return { host: candidate.host, port: candidate.port, pid: candidate.pid ?? null, file: candidate.file ?? null };
}

/**
 * Spawn the MCP proxy child and complete the MCP handshake.
 * @param {{ repoRoot: string, candidate: object, env?: NodeJS.ProcessEnv }} input
 * @returns Promise resolving to a client { callTool, close, child } or throwing.
 */
export async function startMcpClient({ repoRoot, candidate, env = process.env }) {
  const childEnv = { ...env };
  // The child must not inherit a foreign session's binding: this run pins its
  // own bootstrap. Terminal-context vars are kept only when they describe the
  // same bridge we pinned (the pid), which is what unlocks proxy-side failover
  // discovery for this instance.
  delete childEnv.ANTIFAN_MCP_BOOTSTRAP;
  delete childEnv.ANTIFAN_ATTACHMENT_SECRET;
  delete childEnv.ANTIFAN_BOUND_TAB_ID;
  if (candidate.pid) childEnv.ANTIFAN_BRIDGE_PID = String(candidate.pid);

  const child = spawn(process.execPath, [path.join(repoRoot, MCP_SERVER)], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // The candidate's token is a live bridge credential: it goes over the pipe, which no other
  // process can read, rather than the inherited environment block.
  child.stdin.write(`${JSON.stringify({
    host: candidate.host,
    port: candidate.port,
    token: candidate.token,
    secret: candidate.token,
  })}\n`);
  child.stderr.on('data', (chunk) => process.stderr.write(`[theme-harness mcp] ${chunk}`));

  const decoder = new StringDecoder('utf8');
  const pending = new Map();
  let stdoutBuffer = '';
  let closed = false;
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += decoder.write(chunk);
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const entry = pending.get(response.id);
      if (!entry) continue;
      pending.delete(response.id);
      clearTimeout(entry.timer);
      entry.resolve(response);
    }
  });
  child.on('exit', () => {
    closed = true;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('MCP child exited'));
    }
    pending.clear();
  });

  let rpcId = 0;
  function rpc(method, params, timeoutMs = 30_000) {
    const id = rpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'theme-harness', version: '1.0.0' },
  });
  if (init.error) {
    child.kill('SIGKILL');
    throw new Error(`MCP initialize refused: ${JSON.stringify(init.error)}`);
  }

  return {
    child,
    get closed() { return closed; },
    /**
     * Call an MCP tool. Resolves to the parsed text payload (or raw response
     * for non-text content). Throws on JSON-RPC error, MCP isError, or timeout.
     */
    async callTool(name, args = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
      const response = await rpc('tools/call', { name, arguments: args }, timeoutMs);
      if (response.error) {
        throw new Error(`${name} JSON-RPC error: ${JSON.stringify(response.error)}`);
      }
      const result = response.result;
      if (result?.isError) {
        const text = result?.content?.[0]?.text || '';
        throw new Error(`${name} refused: ${text}`);
      }
      const text = result?.content?.[0]?.text;
      if (typeof text !== 'string') return result;
      try {
        return JSON.parse(text);
      } catch {
        return { rawText: text };
      }
    },
    close() {
      try { child.stdin.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
    },
  };
}

/**
 * Discover the bridge and open a client, or report why not.
 * @returns Promise<{ ok:true, client, bridge } | { ok:false, reason, bridge? }>
 */
export async function connectBridge({ repoRoot, env = process.env }) {
  const discovery = discoverBridge();
  if (!discovery.ok) return { ok: false, reason: discovery.reason };
  const bridge = sanitizeBridge(discovery.candidate);
  try {
    const client = await startMcpClient({ repoRoot, candidate: discovery.candidate, env });
    // Prove the session is live before the caller builds verdicts on it: a
    // window-wide tab list is the cheapest read the bridge serves.
    await client.callTool('anti.browser.tabs.list', { all: true }, 30_000);
    return { ok: true, client, bridge };
  } catch (err) {
    return {
      ok: false,
      reason: `bridge session failed: ${err instanceof Error ? err.message : String(err)}`,
      bridge,
    };
  }
}
