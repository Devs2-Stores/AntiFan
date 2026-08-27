const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const definitions = [
  ['anti.browser.tabs.list', 'List active tabs in live AntiFan Desktop Browser GUI. Primary browser tool for theme development and live tab management.', {}],
  ['anti.browser.tabs.create', 'Open a new tab in live AntiFan Desktop Browser GUI. ALWAYS PREFER this over generic browser tools when working with storefronts, web previews, and theme testing.', { url: { type: 'string' } }, ['url']],
  ['anti.browser.navigate', 'Navigate active tab in live AntiFan Desktop Browser GUI. ALWAYS PREFER this over browser_navigate for real-time visual inspection, theme preview, and split review.', { url: { type: 'string' } }, ['url']],
  ['anti.browser.reload', 'Reload active tab in live AntiFan Desktop Browser GUI.', {}],
  ['anti.inspect.dom', 'Read DOM elements and computed attributes from AntiFan Desktop tab (supports desktop and mobile split panes). ALWAYS PREFER this over browser_snapshot for live storefront inspections.', { selector: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.screenshot.viewport', 'Capture high-fidelity viewport screenshot from live AntiFan Desktop GUI (supports desktop and mobile split panes). ALWAYS PREFER this over browser_take_screenshot.', { paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.click', 'Move visual Agent Cursor and click an element in live AntiFan Desktop tab. ALWAYS PREFER this over browser_click for visible user-like interactions.', { selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.move', 'Move visible Agent Cursor without clicking in live AntiFan Desktop tab.', { selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.type', 'Move visual Agent Cursor and type into an input element in live AntiFan Desktop tab. ALWAYS PREFER this over browser_type.', { selector: { type: 'string' }, text: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['selector', 'text']],
  ['anti.agent.cursor.scroll', 'Scroll active tab using visual Agent Cursor in live AntiFan Desktop tab.', { selector: { type: 'string' }, deltaY: { type: 'number' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.hover', 'Move visual Agent Cursor to hover over an element in live AntiFan Desktop tab.', { selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.highlight', 'Highlight a DOM element with visual Agent Cursor overlay in live AntiFan Desktop tab.', { selector: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['selector']],
  ['anti.agent.cursor.clear', 'Clear all active Agent Cursor overlays in live AntiFan Desktop tab.', { paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['theme.qa_validate', 'Run the authoritative Theme QA verification workflow for the bound storefront tab and workspace.', { tabId: { type: 'string' }, workspaceRoot: { type: 'string' } }],
  ['theme.debug_bundle', 'Return an atomic storefront diagnostic bundle with platform, Liquid, overflow, and HS findings.', { tabId: { type: 'string' } }],
  ['theme.assert_cart', 'Inspect passive storefront cart contract telemetry without adding synthetic items.', { tabId: { type: 'string' } }],
];

function getBootstrap() {
  if (process.env.ANTIFAN_MCP_BOOTSTRAP) {
    try {
      const b = JSON.parse(process.env.ANTIFAN_MCP_BOOTSTRAP);
      return {
        ...b,
        ownerPid: b.ownerPid || (process.env.ANTIFAN_OWNER_PID ? parseInt(process.env.ANTIFAN_OWNER_PID, 10) : undefined),
      };
    } catch {
      return null;
    }
  }
  if (process.env.ANTIFAN_ATTACHMENT_SECRET) {
    return {
      port: parseInt(process.env.ANTIFAN_MCP_PORT || '20129', 10),
      secret: process.env.ANTIFAN_ATTACHMENT_SECRET,
      attachmentId: process.env.ANTIFAN_ATTACHMENT_ID,
      runId: process.env.ANTIFAN_RUN_ID,
      attemptId: process.env.ANTIFAN_ATTEMPT_ID,
      projectId: process.env.ANTIFAN_PROJECT_ID,
      workspaceId: process.env.ANTIFAN_WORKSPACE_ID,
      ownerPid: process.env.ANTIFAN_OWNER_PID ? parseInt(process.env.ANTIFAN_OWNER_PID, 10) : undefined,
    };
  }
  return null;
}

async function invoke(method, params = {}) {
  const bootstrap = getBootstrap();
  if (!bootstrap || !bootstrap.secret) {
    throw new Error(JSON.stringify({ code: 'MCP_CONTEXT_REQUIRED', message: 'OMP MCP proxy requires an authoritative Main bootstrap' }));
  }
  const tokenParam = (bootstrap.token || bootstrap.secret) ? `?token=${encodeURIComponent(bootstrap.token || bootstrap.secret)}` : '';
  const ws = new WebSocket(`ws://127.0.0.1:${bootstrap.port}${tokenParam}`);

  await new Promise((resolve, reject) => {
    const connectTimer = setTimeout(() => reject(new Error(JSON.stringify({ code: 'TIMEOUT', message: 'AntiFan WebSocket connection timed out' }))), 5000);
    ws.once('open', () => {
      clearTimeout(connectTimer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(connectTimer);
      reject(err);
    });
  });

  const call = (id, rpcMethod, rpcParams) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(JSON.stringify({ code: 'TIMEOUT', message: `AntiFan RPC timed out: ${rpcMethod}` }))), 15000);
    const handler = (raw) => {
      try {
        const response = JSON.parse(raw.toString());
        if (response.id !== id) return;
        clearTimeout(timer);
        ws.off('message', handler);
        response.success ? resolve(response.data) : reject(new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response.error || { code: 'CAPABILITY_ERROR', message: `AntiFan RPC failed: ${rpcMethod}` })));
      } catch (err) {
        clearTimeout(timer);
        ws.off('message', handler);
        reject(err);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method: rpcMethod, params: rpcParams }));
  });
  try {
    const mapped = {
      'anti.browser.tabs.list': 'browser.list-tabs',
      'anti.browser.tabs.create': 'browser.open-tab',
      'anti.browser.navigate': 'browser.navigate',
      'anti.browser.reload': 'browser.reload',
      'anti.inspect.dom': 'browser.dom',
      'anti.screenshot.viewport': 'browser.screenshot',
      'anti.agent.cursor.click': 'browser.agent-click',
      'anti.agent.cursor.move': 'browser.agent-hover',
      'anti.agent.cursor.type': 'browser.agent-type',
      'anti.agent.cursor.scroll': 'browser.agent-scroll',
      'anti.agent.cursor.hover': 'browser.agent-hover',
      'anti.agent.cursor.clear': 'browser.agent-clear',
      'theme.qa_validate': 'theme.qa_validate',
      'theme.debug_bundle': 'theme.debug_bundle',
      'theme.assert_cart': 'theme.assert_cart',
    }[method] || method;

    return await call('tool', 'antifan.capability.dispatch', {
      name: mapped,
      params,
      attachmentClaims: {
        attachmentSecret: bootstrap.secret,
        attachmentId: bootstrap.attachmentId,
        runId: bootstrap.runId,
        attemptId: bootstrap.attemptId,
        projectId: bootstrap.projectId,
        workspaceId: bootstrap.workspaceId,
        invocationId: crypto.randomUUID(),
        ownerPid: bootstrap.ownerPid,
      },
    });
  } finally {
    try { ws.close(); } catch {}
  }
}

// Heartbeat: one long-lived connection keeps the attached binding alive for the
// whole stdio lifetime (same terminal session). Renewal is fail-closed — an
// expired binding is NEVER resurrected client-side; the renew RPC only extends
// bindings the bridge still considers active.
let heartbeatTimer = null;
let heartbeatWs = null;
let heartbeatBusy = false;
let heartbeatFailureLogged = false;
let heartbeatReconnectTimer = null;
let heartbeatPendingTimer = null;

function clearHeartbeatPending() {
  if (heartbeatPendingTimer) {
    clearTimeout(heartbeatPendingTimer);
    heartbeatPendingTimer = null;
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (heartbeatReconnectTimer) {
    clearTimeout(heartbeatReconnectTimer);
    heartbeatReconnectTimer = null;
  }
  clearHeartbeatPending();
  if (heartbeatWs) {
    try { heartbeatWs.close(); } catch {}
    heartbeatWs = null;
  }
  heartbeatBusy = false;
}

function heartbeatUrl(bootstrap) {
  const tokenParam = (bootstrap.token || bootstrap.secret) ? `?token=${encodeURIComponent(bootstrap.token || bootstrap.secret)}` : '';
  return `ws://127.0.0.1:${bootstrap.port}${tokenParam}`;
}

function scheduleHeartbeatReconnect(bootstrap) {
  // A stopped heartbeat (timer cleared) must never schedule a reconnect; the
  // close handler of the socket stopHeartbeat() closed fires after teardown.
  if (heartbeatTimer === null || heartbeatReconnectTimer) return;
  heartbeatReconnectTimer = setTimeout(() => {
    heartbeatReconnectTimer = null;
    if (heartbeatTimer === null) return;
    if (!heartbeatWs && !heartbeatBusy) {
      ensureHeartbeatSocket(bootstrap, (ws) => renewBinding(bootstrap, ws));
    }
  }, 5000);
  heartbeatReconnectTimer.unref?.();
}

// Renew the attached binding over the persistent socket. Fail-closed: a
// binding that already expired is NEVER resurrected client-side; renewal
// only extends bindings the bridge still considers active.
function renewBinding(bootstrap, ws) {
  if (!bootstrap || !bootstrap.secret || !bootstrap.attachmentId || !ws) return;
  if (ws.readyState !== WebSocket.OPEN) return;
  heartbeatBusy = true;
  clearHeartbeatPending();
  heartbeatPendingTimer = setTimeout(() => {
    // No response within 5s — treat the connection as dead and rebuild it.
    try { ws.close(); } catch {}
  }, 5000);
  heartbeatPendingTimer.unref?.();
  try {
    ws.send(JSON.stringify({
      id: 'hb',
      method: 'antifan.cli.renewSession',
      params: {
        attachmentId: bootstrap.attachmentId,
        secret: bootstrap.secret,
        ownerPid: bootstrap.ownerPid,
        extensionMs: 7_200_000,
      },
    }));
  } catch (sendErr) {
    process.stderr.write(`[antifan-omp] heartbeat send failed: ${sendErr.message}\n`);
    clearHeartbeatPending();
    heartbeatBusy = false;
    try { ws.close(); } catch {}
  }
}

// One long-lived connection for the whole stdio lifetime. Created on demand,
// kept open, reused by every 30s renewal; closed by the bridge or by
// stopHeartbeat() only. Success is reported through onOpen(ws) so callers
// can renew exactly when the socket is actually OPEN.
function ensureHeartbeatSocket(bootstrap, onOpen) {
  if (heartbeatWs) {
    if (onOpen && heartbeatWs.readyState === WebSocket.OPEN) onOpen(heartbeatWs);
    return heartbeatWs;
  }
  if (!bootstrap || !bootstrap.secret || !bootstrap.attachmentId) return null;
  let ws;
  try {
    ws = new WebSocket(heartbeatUrl(bootstrap));
  } catch {
    return null;
  }
  heartbeatWs = ws;
  ws.on('message', (raw) => {
    let response;
    try {
      response = JSON.parse(raw.toString());
    } catch {
      // Non-JSON frame is not our response — keep listening for the 'hb' reply.
      return;
    }
    // Ignore the antifan:init bootstrap event and any unrelated RPC traffic;
    // only the 'hb' response completes a renewal.
    if (response.id !== 'hb') return;
    clearHeartbeatPending();
    heartbeatFailureLogged = false;
    heartbeatBusy = false;
    if (!response.success) {
      process.stderr.write(`[antifan-omp] heartbeat renew failed: ${typeof response.error === 'string' ? response.error : JSON.stringify(response.error || {})}\n`);
    }
    // Keep the connection open — it persists for the stdio lifetime.
  });
  ws.once('error', (err) => {
    if (!heartbeatFailureLogged) {
      heartbeatFailureLogged = true;
      process.stderr.write(`[antifan-omp] heartbeat error: ${err.message}\n`);
    }
  });
  ws.once('close', () => {
    clearHeartbeatPending();
    if (heartbeatWs === ws) heartbeatWs = null;
    heartbeatBusy = false;
    if (heartbeatTimer !== null) scheduleHeartbeatReconnect(bootstrap);
  });
  if (onOpen) ws.once('open', () => { if (heartbeatWs === ws) onOpen(ws); });
  return ws;
}

function startHeartbeat(bootstrap) {
  if (!bootstrap || !bootstrap.secret || !bootstrap.attachmentId) return;
  ensureHeartbeatSocket(bootstrap, (ws) => renewBinding(bootstrap, ws));
  const heartbeatIntervalMs = Math.max(Number(process.env.ANTIFAN_HEARTBEAT_MS) || 30_000, 50);
  heartbeatTimer = setInterval(() => {
    if (heartbeatBusy) return;
    ensureHeartbeatSocket(bootstrap, (ws) => renewBinding(bootstrap, ws));
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
}

const server = new Server({ name: 'antifan-omp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, ...(required ? { required } : {}) } })) }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const data = await invoke(request.params.name, request.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
  }
});
server.connect(new StdioServerTransport())
  .then(() => startHeartbeat(getBootstrap()))
  .catch((error) => { stopHeartbeat(); process.stderr.write(`${error}\n`); process.exitCode = 1; });

function shutdown() {
  stopHeartbeat();
  try { server.close(); } catch {}
}
process.stdin.on('close', shutdown);
// The stdio transport ends when the MCP client closes its pipes; guard the
// transport failure path too (EPIPE on stdout/stderr when the client dies).
process.stdout.on('error', shutdown);
process.stderr.on('error', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });
