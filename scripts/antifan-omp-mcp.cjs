const crypto = require('node:crypto');
const http = require('node:http');
const { WebSocket } = require('ws');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const definitions = [
  ['anti.browser.tabs.list', 'List active tabs in live AntiFan Desktop Browser GUI. Primary browser tool for theme development and live tab management.', {}],
  ['anti.browser.tabs.create', 'Open a new tab in live AntiFan Desktop Browser GUI. ALWAYS PREFER this over generic browser tools when working with storefronts, web previews, and theme testing.', { url: { type: 'string' } }, ['url']],
  ['anti.browser.tabs.activate', 'Switch the active tab in live AntiFan Desktop Browser GUI by tabId.', { tabId: { type: 'string' } }, ['tabId']],
  ['anti.browser.tabs.close', 'Close a tab in live AntiFan Desktop Browser GUI by tabId.', { tabId: { type: 'string' } }, ['tabId']],
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

/**
 * Fetch raw binary artifact bytes over HTTP from BridgeServer using single-header authentication.
 */
function fetchArtifactBinary(bootstrap, artifactId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: bootstrap.port,
      path: `/api/artifacts/${encodeURIComponent(artifactId)}`,
      method: 'GET',
      headers: {
        'x-antifan-attachment-secret': bootstrap.secret,
      },
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          let errMsg = `Artifact download failed with status ${res.statusCode}`;
          try {
            const errObj = JSON.parse(buffer.toString('utf8'));
            if (errObj && errObj.error) errMsg = errObj.error;
          } catch {}
          return reject(new Error(JSON.stringify({ code: 'ARTIFACT_READ_ERROR', message: errMsg })));
        }
        resolve({
          data: buffer.toString('base64'),
          mimeType: res.headers['content-type'] || 'image/png',
        });
      });
    });

    req.on('error', (err) => {
      reject(new Error(JSON.stringify({ code: 'ARTIFACT_FETCH_ERROR', message: `Artifact fetch failed: ${err.message}` })));
    });

    req.end();
  });
}

// ─── Multiplexed Persistent Dispatch Socket ──────────────────────────────────
let dispatchWs = null;
let dispatchConnecting = null;
const pendingDispatchCalls = new Map(); // id -> { resolve, reject, timer }

function ensureDispatchSocket(bootstrap) {
  if (dispatchWs && dispatchWs.readyState === WebSocket.OPEN) {
    return Promise.resolve(dispatchWs);
  }
  if (dispatchConnecting) {
    return dispatchConnecting;
  }

  const tokenParam = (bootstrap.token || bootstrap.secret) ? `?token=${encodeURIComponent(bootstrap.token || bootstrap.secret)}` : '';
  const url = `ws://127.0.0.1:${bootstrap.port}${tokenParam}`;

  dispatchConnecting = new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      dispatchConnecting = null;
      return reject(err);
    }

    const connectTimer = setTimeout(() => {
      dispatchConnecting = null;
      try { ws.close(); } catch {}
      reject(new Error(JSON.stringify({ code: 'TIMEOUT', message: 'AntiFan Dispatch WebSocket connection timed out' })));
    }, 5000);

    ws.once('open', () => {
      clearTimeout(connectTimer);
      dispatchWs = ws;
      dispatchConnecting = null;

      ws.on('message', (raw) => {
        try {
          const response = JSON.parse(raw.toString());
          if (!response || !response.id || !pendingDispatchCalls.has(response.id)) return;
          const entry = pendingDispatchCalls.get(response.id);
          pendingDispatchCalls.delete(response.id);
          clearTimeout(entry.timer);
          response.success
            ? entry.resolve(response.data)
            : entry.reject(new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response.error || { code: 'CAPABILITY_ERROR', message: 'AntiFan RPC failed' })));
        } catch {}
      });

      resolve(ws);
    });

    ws.once('error', (err) => {
      clearTimeout(connectTimer);
      dispatchConnecting = null;
      if (dispatchWs === ws) dispatchWs = null;
      for (const [, entry] of pendingDispatchCalls.entries()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(JSON.stringify({ code: 'CONNECTION_ERROR', message: `Dispatch WebSocket error: ${err.message}` })));
      }
      pendingDispatchCalls.clear();
      reject(err);
    });

    ws.once('close', () => {
      clearTimeout(connectTimer);
      dispatchConnecting = null;
      if (dispatchWs === ws) dispatchWs = null;
      for (const [, entry] of pendingDispatchCalls.entries()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(JSON.stringify({ code: 'CONNECTION_CLOSED', message: 'Dispatch WebSocket closed while request in flight' })));
      }
      pendingDispatchCalls.clear();
    });
  });

  return dispatchConnecting;
}

async function invoke(method, params = {}) {
  const bootstrap = getBootstrap();
  if (!bootstrap || !bootstrap.secret) {
    throw new Error(JSON.stringify({ code: 'MCP_CONTEXT_REQUIRED', message: 'OMP MCP proxy requires an authoritative Main bootstrap' }));
  }

  const ws = await ensureDispatchSocket(bootstrap);
  const id = crypto.randomUUID();
  const timeoutMs = (method === 'theme.qa_validate' || method === 'anti.theme.qa_validate') ? 60000 : 15000;

  const mapped = {
    'anti.browser.tabs.list': 'browser.list-tabs',
    'anti.browser.tabs.create': 'browser.open-tab',
    'anti.browser.tabs.activate': 'browser.switch-tab',
    'anti.browser.tabs.close': 'browser.close-tab',
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

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDispatchCalls.delete(id);
      reject(new Error(JSON.stringify({ code: 'TIMEOUT', message: `AntiFan RPC timed out: ${mapped}` })));
    }, timeoutMs);

    pendingDispatchCalls.set(id, { resolve, reject, timer });

    try {
      ws.send(JSON.stringify({
        id,
        method: 'antifan.capability.dispatch',
        params: {
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
        },
      }));
    } catch (err) {
      clearTimeout(timer);
      pendingDispatchCalls.delete(id);
      reject(err);
    }
  });
}

// ─── Dedicated Isolated Heartbeat Channel ────────────────────────────────────
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

function renewBinding(bootstrap, ws) {
  if (!bootstrap || !bootstrap.secret || !bootstrap.attachmentId || !ws) return;
  if (ws.readyState !== WebSocket.OPEN) return;
  heartbeatBusy = true;
  clearHeartbeatPending();
  heartbeatPendingTimer = setTimeout(() => {
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
      return;
    }
    if (response.id !== 'hb') return;
    clearHeartbeatPending();
    heartbeatFailureLogged = false;
    heartbeatBusy = false;
    if (!response.success) {
      process.stderr.write(`[antifan-omp] heartbeat renew failed: ${typeof response.error === 'string' ? response.error : JSON.stringify(response.error || {})}\n`);
    }
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

// ─── MCP Server Initialization ───────────────────────────────────────────────
const server = new Server({ name: 'antifan-omp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: definitions.map(([name, description, properties, required]) => ({
    name,
    description,
    inputSchema: { type: 'object', properties, ...(required ? { required } : {}) },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const bootstrap = getBootstrap();
    const data = await invoke(request.params.name, request.params.arguments || {});

    // Handle ArtifactRef resolution from ArtifactStore
    if (data && typeof data === 'object' && typeof data.id === 'string' && data.id.startsWith('artifact-')) {
      const artifactPayload = await fetchArtifactBinary(bootstrap, data.id);
      if (request.params.name === 'anti.screenshot.viewport' || request.params.name === 'antifan_screenshot' || (typeof data.mime === 'string' && data.mime.startsWith('image/'))) {
        return {
          content: [
            {
              type: 'image',
              data: artifactPayload.data,
              mimeType: artifactPayload.mimeType || data.mime || 'image/png',
            },
          ],
        };
      }
      // Text artifact (e.g. DOM inspection, HTML, logs)
      const textContent = Buffer.from(artifactPayload.data, 'base64').toString('utf8');
      return { content: [{ type: 'text', text: textContent }] };
    }

    if (request.params.name === 'anti.screenshot.viewport' || request.params.name === 'antifan_screenshot') {
      throw new Error(JSON.stringify({ code: 'CAPABILITY_ERROR', message: 'Expected ArtifactRef metadata from screenshot capability' }));
    }

    return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
  }
});

server.connect(new StdioServerTransport())
  .then(() => startHeartbeat(getBootstrap()))
  .catch((error) => {
    stopHeartbeat();
    process.stderr.write(`${error}\n`);
    process.exitCode = 1;
  });

function shutdown() {
  stopHeartbeat();
  if (dispatchWs) {
    try { dispatchWs.close(); } catch {}
    dispatchWs = null;
  }
  for (const [, entry] of pendingDispatchCalls.entries()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(JSON.stringify({ code: 'SHUTDOWN', message: 'MCP server shutting down' })));
  }
  pendingDispatchCalls.clear();
  try { server.close(); } catch {}
}

process.stdin.on('close', shutdown);
process.stdout.on('error', shutdown);
process.stderr.on('error', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });
