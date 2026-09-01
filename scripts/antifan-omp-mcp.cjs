const crypto = require('node:crypto');
const http = require('node:http');
const { WebSocket } = require('ws');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const definitions = [
  ['anti.browser.tabs.list', 'List active tabs in live AntiFan Desktop Browser GUI. Primary browser tool for theme development and live tab management.', {}],
  ['anti.browser.tabs.create', 'Open a new tab in live AntiFan Desktop Browser GUI without stealing focus.', { url: { type: 'string' } }, ['url']],
  ['anti.browser.tabs.activate', 'Switch the active tab visible to the user in live AntiFan Desktop Browser GUI by tabId. (Do not call for automated background operations).', { tabId: { type: 'string' } }, ['tabId']],
  ['anti.browser.tabs.close', 'Close a tab in live AntiFan Desktop Browser GUI by tabId.', { tabId: { type: 'string' } }, ['tabId']],
  ['anti.browser.navigate', 'Navigate active or background tab in live AntiFan Desktop Browser GUI.', { url: { type: 'string' }, tabId: { type: 'string' } }, ['url']],
  ['anti.browser.reload', 'Reload active or background tab in live AntiFan Desktop Browser GUI.', { tabId: { type: 'string' } }],
  ['anti.inspect.dom', 'Read DOM elements and computed attributes from AntiFan Desktop tab (supports desktop and mobile split panes). Operates directly against background tab.', { selector: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.screenshot.viewport', 'Capture high-fidelity viewport screenshot from live AntiFan Desktop GUI (supports desktop and mobile split panes). Operates directly against background tab.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.click', 'Move visual Agent Cursor and click an element in live AntiFan Desktop tab without stealing visual focus.', { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.move', 'Move visible Agent Cursor without clicking in live AntiFan Desktop tab.', { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.type', 'Move visual Agent Cursor and type into an input element in live AntiFan Desktop tab without stealing visual focus.', { selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['text']],
  ['anti.agent.cursor.scroll', 'Scroll active or background tab using visual Agent Cursor in live AntiFan Desktop tab.', { selector: { type: 'string' }, ref: { type: 'string' }, deltaY: { type: 'number' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.hover', 'Move visual Agent Cursor to hover over an element in live AntiFan Desktop tab.', { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.highlight', 'Highlight a DOM element with visual Agent Cursor overlay in live AntiFan Desktop tab.', { selector: { type: 'string' }, ref: { type: 'string' }, label: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.clear', 'Clear all active Agent Cursor overlays in live AntiFan Desktop tab.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['browser_find', 'Search the accessibility snapshot of the current page for text or a regular expression.', { text: { type: 'string' }, regex: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['browser_press_key', 'Send native keyboard key press (Enter, Escape, Tab, Backspace, Arrow keys, etc.) or combination (Control+a) to the active tab', { key: { type: 'string' }, tabId: { type: 'string' } }, ['key']],
  ['theme.qa_validate', 'Run the authoritative Theme QA verification workflow for the bound storefront tab and workspace.', { tabId: { type: 'string' }, workspaceRoot: { type: 'string' } }],
  ['theme.debug_bundle', 'Return an atomic storefront diagnostic bundle with platform, Liquid, overflow, and HS findings.', { tabId: { type: 'string' } }],
  ['theme.assert_cart', 'Inspect passive storefront cart contract telemetry without adding synthetic items.', { tabId: { type: 'string' } }],
  ['anti.agent.file_upload', 'Upload local files into a file input element in live AntiFan Desktop tab without native file dialogs.', { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['refOrSelector', 'filePaths']],
  ['anti.agent.drop', 'Dispatch native drag and drop file transfer onto a target drop zone element in live AntiFan Desktop tab.', { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['refOrSelector', 'filePaths']],
  ['anti.inspect.snapshot', 'Capture an accessible semantic snapshot of elements indexed with monotonic @e1..@eN references.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.browser.evaluate', 'Execute JavaScript expression in page context with depth-capped circular protection.', { expression: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['expression']],
  ['anti.telemetry.record_fallback', 'Record sanitized fallback telemetry when invoking Playwright after an AntiFan capability failure.', { primaryTool: { type: 'string' }, fallbackTool: { type: 'string' }, fallbackResult: { type: 'string', enum: ['SUCCESS', 'FAILED', 'SKIPPED'] }, sessionId: { type: 'string' }, targetUrl: { type: 'string' }, errorCode: { type: 'string' }, errorMessage: { type: 'string' }, durationMs: { type: 'number' }, notes: { type: 'string' } }, ['primaryTool', 'fallbackTool', 'fallbackResult']],
];

let currentAuthorityRevision = null;

function getBootstrap() {
  if (process.env.ANTIFAN_MCP_BOOTSTRAP) {
    try {
      const b = JSON.parse(process.env.ANTIFAN_MCP_BOOTSTRAP);
      if (b.authorityRevision && !currentAuthorityRevision) {
        currentAuthorityRevision = b.authorityRevision;
      }
      return {
        ...b,
        authorityRevision: currentAuthorityRevision || b.authorityRevision,
        ownerPid: b.ownerPid || (process.env.ANTIFAN_OWNER_PID ? parseInt(process.env.ANTIFAN_OWNER_PID, 10) : undefined),
      };
    } catch {
      return null;
    }
  }
  if (process.env.ANTIFAN_ATTACHMENT_SECRET) {
    if (process.env.ANTIFAN_AUTHORITY_REVISION && !currentAuthorityRevision) {
      currentAuthorityRevision = process.env.ANTIFAN_AUTHORITY_REVISION;
    }
    return {
      port: parseInt(process.env.ANTIFAN_MCP_PORT || '20129', 10),
      secret: process.env.ANTIFAN_ATTACHMENT_SECRET,
      attachmentId: process.env.ANTIFAN_ATTACHMENT_ID,
      authorityRevision: currentAuthorityRevision || process.env.ANTIFAN_AUTHORITY_REVISION,
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
    req.setTimeout(15000, () => {
      req.destroy(new Error('ARTIFACT_STREAM_TIMEOUT'));
    });

    req.on('error', (err) => {
      reject(new Error(JSON.stringify({ code: 'ARTIFACT_FETCH_ERROR', message: `Artifact fetch failed: ${err.message}` })));
    });

    req.end();
  });
}

const CAPABILITY_MAP = Object.freeze({
  'anti.browser.tabs.list': 'browser.list-tabs',
  'anti.browser.tabs.create': 'browser.open-tab',
  'anti.browser.tabs.activate': 'browser.switch-tab',
  'anti.browser.tabs.close': 'browser.close-tab',
  'anti.browser.navigate': 'browser.navigate',
  'anti.browser.reload': 'browser.reload',
  'anti.inspect.dom': 'browser.dom',
  'anti.inspect.snapshot': 'anti.inspect.snapshot',
  'anti.browser.evaluate': 'anti.browser.evaluate',
  'anti.screenshot.viewport': 'browser.screenshot',
  'anti.agent.cursor.click': 'browser.agent-click',
  'anti.agent.cursor.move': 'browser.agent-hover',
  'anti.agent.cursor.type': 'browser.agent-type',
  'anti.agent.cursor.scroll': 'browser.agent-scroll',
  'anti.agent.cursor.hover': 'browser.agent-hover',
  'anti.agent.cursor.highlight': 'browser.agent-highlight',
  'anti.agent.cursor.clear': 'browser.agent-clear',
  'anti.agent.file_upload': 'anti.agent.file_upload',
  'anti.agent.drop': 'anti.agent.drop',
  'anti.telemetry.record_fallback': 'anti.telemetry.record_fallback',
  'browser_find': 'antifan_find',
  'browser_press_key': 'browser.keyboard-press',
  'theme.qa_validate': 'theme.qa_validate',
  'theme.debug_bundle': 'theme.debug_bundle',
  'theme.assert_cart': 'theme.assert_cart',
});
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

  const authHeaders = {};
  if (bootstrap.secret) authHeaders['X-Antifan-Attachment-Secret'] = bootstrap.secret;
  if (bootstrap.token) authHeaders['Authorization'] = `Bearer ${bootstrap.token}`;
  const tokenParam = (bootstrap.token || bootstrap.secret) ? `?token=${encodeURIComponent(bootstrap.token || bootstrap.secret)}` : '';
  const url = `ws://127.0.0.1:${bootstrap.port}${tokenParam}`;

  dispatchConnecting = new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url, { headers: authHeaders });
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
          if (response.success) {
            if (response.data && typeof response.data === 'object') {
              if (response.data.authorityRevision) {
                currentAuthorityRevision = response.data.authorityRevision;
              }
              if (response.data.data !== undefined) {
                entry.resolve(response.data.data);
                return;
              }
            }
            entry.resolve(response.data);
          } else {
            entry.reject(new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response.error || { code: 'CAPABILITY_ERROR', message: 'AntiFan RPC failed' })));
          }
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

  const mapped = CAPABILITY_MAP[method] || method;
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
          attachmentId: bootstrap.attachmentId,
          attachmentSecret: bootstrap.secret,
          authorityRevision: currentAuthorityRevision || bootstrap.authorityRevision,
          attachmentClaims: {
            attachmentSecret: bootstrap.secret,
            attachmentId: bootstrap.attachmentId,
            authorityRevision: currentAuthorityRevision || bootstrap.authorityRevision,
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
  const authHeaders = {};
  if (bootstrap.secret) authHeaders['X-Antifan-Attachment-Secret'] = bootstrap.secret;
  if (bootstrap.token) authHeaders['Authorization'] = `Bearer ${bootstrap.token}`;
  let ws;
  try {
    ws = new WebSocket(heartbeatUrl(bootstrap), { headers: authHeaders });
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
      if (
        request.params.name === 'anti.screenshot.viewport' ||
        request.params.name === 'antifan_screenshot' ||
        (typeof data.mime === 'string' && data.mime.startsWith('image/'))
      ) {
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
