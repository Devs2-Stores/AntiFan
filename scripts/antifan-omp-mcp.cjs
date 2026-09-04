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
  ['anti.screenshot.viewport', 'Capture high-fidelity viewport screenshot from live AntiFan Desktop GUI (supports desktop and mobile split panes, format: jpeg/png).', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, format: { type: 'string', enum: ['jpeg', 'png'] }, quality: { type: 'number' }, fullPage: { type: 'boolean', description: 'Capture entire scrollable page height instead of visible viewport' } }],
  ['anti.agent.cursor.click', 'Move visual Agent Cursor and click an element in live AntiFan Desktop tab without stealing visual focus.', { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.move', 'Move visible Agent Cursor without clicking in live AntiFan Desktop tab.', { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.type', 'Move visual Agent Cursor and type into an input element in live AntiFan Desktop tab without stealing visual focus.', { selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['text']],
  ['anti.agent.cursor.scroll', 'Scroll active or background tab using visual Agent Cursor in live AntiFan Desktop tab.', { selector: { type: 'string' }, ref: { type: 'string' }, deltaY: { type: 'number' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.hover', 'Move visual Agent Cursor to hover over an element in live AntiFan Desktop tab.', { selector: { type: 'string' }, ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.highlight', 'Highlight a DOM element with visual Agent Cursor overlay in live AntiFan Desktop tab.', { selector: { type: 'string' }, ref: { type: 'string' }, label: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.clear', 'Clear all active Agent Cursor overlays in live AntiFan Desktop tab.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['browser_find', 'Search the accessibility snapshot of the current page for text, pattern, query, or a regular expression.', { text: { type: 'string' }, pattern: { type: 'string' }, query: { type: 'string' }, regex: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['browser_press_key', 'Send native keyboard key press (Enter, Escape, Tab, Backspace, Arrow keys, etc.) or combination (Control+a) to the active tab', { key: { type: 'string' }, tabId: { type: 'string' } }, ['key']],
  ['theme.qa_validate', 'Run the authoritative Theme QA verification workflow for the bound storefront tab and workspace.', { tabId: { type: 'string' }, workspaceRoot: { type: 'string' } }],
  ['theme.debug_bundle', 'Return an atomic storefront diagnostic bundle with platform, Liquid, overflow, and HS findings.', { tabId: { type: 'string' } }],
  ['theme.assert_cart', 'Inspect passive storefront cart contract telemetry without adding synthetic items.', { tabId: { type: 'string' } }],
  ['theme.resolve_product', 'Auto-resolve complete storefront product variant matrix, pricing, SKU, and availability.', { handle: { type: 'string' }, tabId: { type: 'string' } }],
  ['storefront.resolve_product', 'Auto-resolve complete storefront product variant matrix, pricing, SKU, and availability.', { handle: { type: 'string' }, tabId: { type: 'string' } }],
  ['anti.agent.file_upload', 'Upload local files into a file input element in live AntiFan Desktop tab without native file dialogs.', { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['refOrSelector', 'filePaths']],
  ['anti.agent.drop', 'Dispatch native drag and drop file transfer onto a target drop zone element in live AntiFan Desktop tab.', { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['refOrSelector', 'filePaths']],
  ['anti.inspect.snapshot', 'Capture an accessible semantic snapshot of elements indexed with monotonic @e1..@eN references (supports selector and viewportOnly filtering).', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, selector: { type: 'string' }, viewportOnly: { type: 'boolean' } }],
  ['anti.browser.evaluate', 'Execute JavaScript expression in page context with depth-capped circular protection.', { expression: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['expression']],
  ['anti.telemetry.record_fallback', 'Record sanitized fallback telemetry when invoking Playwright after an AntiFan capability failure.', { primaryTool: { type: 'string' }, fallbackTool: { type: 'string' }, fallbackResult: { type: 'string', enum: ['SUCCESS', 'FAILED', 'SKIPPED'] }, sessionId: { type: 'string' }, targetUrl: { type: 'string' }, errorCode: { type: 'string' }, errorMessage: { type: 'string' }, durationMs: { type: 'number' }, notes: { type: 'string' } }, ['primaryTool', 'fallbackTool', 'fallbackResult']],
  ['anti.inspect.styles', 'Inspect computed CSS styles, box model, typography, layout, and CSS variables for an element (supports @ref or CSS selector).', { selector: { type: 'string' }, ref: { type: 'string' }, properties: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.inspect.region', 'Inspect spatial region bounds, collecting intersecting visible DOM elements with coordinates and z-index.', { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, selector: { type: 'string' }, ref: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.trace.interaction', 'Trace an interactive action (click, hover, focus, type, scroll) capturing pre/post DOM changes, style deltas, and layout shifts.', { action: { type: 'string', enum: ['click', 'hover', 'focus', 'type', 'scroll'] }, selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, deltaY: { type: 'number' }, settleMs: { type: 'number' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['action']],
  ['anti.visual.compare', 'Compare current viewport or tab against baseline screenshot with pixel-level diffing, element selection, dynamic masking, and configurable tolerance.', { baselineScreenshotRef: { type: 'string' }, comparisonTabId: { type: 'string' }, tolerance: { type: 'number' }, selector: { type: 'string' }, clipRect: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } }, maskSelectors: { type: 'array', items: { type: 'string' } }, normalizeScroll: { type: 'boolean' }, fullPage: { type: 'boolean', description: 'Capture and compare entire document scroll height' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.media.freeze', 'Freeze or unfreeze dynamic media (videos, audios, CSS animations, requestAnimationFrame) in tab to enable deterministic visual comparisons.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, freeze: { type: 'boolean', description: 'True to freeze media and pause animations; false to resume' } }],
  ['anti.inspect.page_inventory', 'Scan entire physical page structure from y=0 to scrollHeight, returning list of all sections, coordinates, heights, and layout groups (chống sót header/footer/newsletter).', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.inspect.style_diff', 'Compare computed CSS styles and box-model metrics between elements on two tabs (or two selectors).', { selector: { type: 'string', description: 'CSS selector of target element on tab 1' }, comparisonSelector: { type: 'string', description: 'CSS selector on tab 2 (defaults to selector)' }, tabId: { type: 'string' }, comparisonTabId: { type: 'string' }, properties: { type: 'array', items: { type: 'string' }, description: 'CSS properties to compare' } }, ['selector']],
  ['anti.spec.validate_gate', 'Validate HTML Specification against target page to certify HTML_SPEC_READY status before theme compilation.', { specTabId: { type: 'string' }, targetTabId: { type: 'string' }, tolerance: { type: 'number' } }],
  ['anti.agent.sequence', 'Execute an atomic multi-step action sequence (navigate, click, type, scroll, hover, pressKey, wait, screenshot, snapshot) in 1 roundtrip with auto-wait and navigation guards.', { actions: { type: 'array', items: { type: 'object' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, stopOnError: { type: 'boolean' } }, ['actions']],
  ['anti.artifact.read', 'Read an authorized artifact by ID with bounded chunk size (clamped to max 32KB per frame).', { artifactId: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, ['artifactId']],
  ['anti.artifact.stat', 'Retrieve metadata and size information for an authorized artifact.', { artifactId: { type: 'string' } }, ['artifactId']],
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
        tabId: b.tabId || process.env.ANTIFAN_BOUND_TAB_ID || undefined,
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
      tabId: process.env.ANTIFAN_BOUND_TAB_ID || undefined,
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
async function fetchArtifactBinary(bootstrap, artifactId) {
  function fetchChunk(offset = 0, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: bootstrap.port,
        path: `/api/artifacts/${encodeURIComponent(artifactId)}?offset=${offset}&limit=${limit}`,
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
          const hasMore = res.headers['x-artifact-has-more'] === 'true';
          const totalBytes = parseInt(res.headers['x-artifact-total-bytes'] || '0', 10) || buffer.length;
          const mimeType = res.headers['content-type'] || 'image/png';
          resolve({
            buffer,
            hasMore,
            totalBytes,
            mimeType,
          });
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error('ARTIFACT_STREAM_TIMEOUT'));
      });

      req.on('error', (err) => {
        reject(new Error(JSON.stringify({ code: 'ARTIFACT_FETCH_ERROR', message: `Artifact fetch failed: ${err.message}` })));
      });

      req.end();
    });
  }

  const collectedChunks = [];
  let currentOffset = 0;
  let finalMimeType = 'application/octet-stream';
  const CHUNK_SIZE = 1024 * 1024;

  while (true) {
    const chunkRes = await fetchChunk(currentOffset, CHUNK_SIZE);
    collectedChunks.push(chunkRes.buffer);
    finalMimeType = chunkRes.mimeType;
    currentOffset += chunkRes.buffer.length;

    if (!chunkRes.hasMore || chunkRes.buffer.length === 0) {
      break;
    }
  }

  const fullBuffer = Buffer.concat(collectedChunks);
  return {
    data: fullBuffer.toString('base64'),
    mimeType: finalMimeType,
  };
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
  'anti.inspect.styles': 'browser.inspect_styles',
  'anti.inspect.region': 'browser.inspect_region',
  'anti.trace.interaction': 'browser.trace_interaction',
  'anti.visual.compare': 'browser.visual_compare',
  'anti.media.freeze': 'browser.media-freeze',
  'anti.inspect.page_inventory': 'browser.page-inventory',
  'anti.inspect.style_diff': 'anti.inspect.style_diff',
  'anti.spec.validate_gate': 'anti.spec.validate_gate',
  'anti.telemetry.record_fallback': 'anti.telemetry.record_fallback',
  'anti.agent.sequence': 'browser.agent-sequence',
  'browser_find': 'browser.find',
  'theme.assert_cart': 'theme.assert_cart',
  'anti.artifact.read': 'artifact.read',
  'artifact.read': 'artifact.read',
  'artifact_read': 'artifact.read',
  'anti.artifact.stat': 'artifact.stat',
  'artifact.stat': 'artifact.stat',
  'artifact_stat': 'artifact.stat',
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
          if (!response || !response.id || !pendingDispatchCalls.has(response.id)) {
            return;
          }
          const entry = pendingDispatchCalls.get(response.id);
          pendingDispatchCalls.delete(response.id);
          clearTimeout(entry.timer);
          if (response.success) {
            if (response.data && typeof response.data === 'object') {
              if (response.data.authorityRevision) {
                currentAuthorityRevision = response.data.authorityRevision;
              } else if (response.data.replacementAuthorityRevision) {
                currentAuthorityRevision = response.data.replacementAuthorityRevision;
              }
              if (response.data.data !== undefined) {
                entry.resolve(response.data.data);
                return;
              }
            }
            entry.resolve(response.data);
          } else {
            process.stderr.write(`[MCP Proxy RPC Error] ${JSON.stringify(response)}\n`);
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

async function invoke(method, params = {}, callerRequestId) {
  const bootstrap = getBootstrap();
  if (!bootstrap || !bootstrap.secret) {
    throw new Error(JSON.stringify({ code: 'MCP_CONTEXT_REQUIRED', message: 'OMP MCP proxy requires an authoritative Main bootstrap' }));
  }

  const ws = await ensureDispatchSocket(bootstrap);
  const id = crypto.randomUUID();
  const timeoutMs = (method === 'theme.qa_validate' || method === 'anti.theme.qa_validate') ? 60000 : 30000;
  const mapped = CAPABILITY_MAP[method] || method;
  let effectiveParams = { ...params };
  const boundTabId = bootstrap.tabId || process.env.ANTIFAN_BOUND_TAB_ID;
  if (!effectiveParams.tabId && boundTabId) {
    effectiveParams.tabId = boundTabId;
  }
  if (mapped === 'artifact.read') {
    const rawLimit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 32768;
    effectiveParams = {
      ...effectiveParams,
      limit: Math.min(rawLimit, 32768), // Bounded chunk size: <= 32 KiB per frame
    };
  }
  const requestId = callerRequestId ? `req-mcp-${callerRequestId}-${crypto.randomUUID()}` : `req-${crypto.randomUUID()}`;
  const idempotencyKey = callerRequestId ? `idem-mcp-${callerRequestId}-${crypto.randomUUID()}` : `idem-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDispatchCalls.delete(id);
      reject(new Error(JSON.stringify({ code: 'TIMEOUT', message: `AntiFan RPC timed out: ${mapped}` })));
    }, timeoutMs);

    pendingDispatchCalls.set(id, {
      resolve: (data) => {
        if (mapped === 'browser.switch-tab' && effectiveParams.tabId) {
          bootstrap.tabId = effectiveParams.tabId;
          process.env.ANTIFAN_BOUND_TAB_ID = effectiveParams.tabId;
        } else if (mapped === 'browser.open-tab' && data && typeof data === 'object' && typeof data.tabId === 'string') {
          bootstrap.tabId = data.tabId;
          process.env.ANTIFAN_BOUND_TAB_ID = data.tabId;
        }
        resolve(data);
      },
      reject,
      timer,
    });

    try {
      ws.send(JSON.stringify({
        id,
        method: 'antifan.capability.dispatch',
        params: {
          name: mapped,
          params: effectiveParams,
          requestId,
          idempotencyKey,
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

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const bootstrap = getBootstrap();
    const callerRequestId = extra && (typeof extra.requestId === 'string' || typeof extra.requestId === 'number')
      ? String(extra.requestId)
      : undefined;
    const data = await invoke(request.params.name, request.params.arguments || {}, callerRequestId);
    // For stat tools, directly return raw ArtifactRef metadata without hydration
    const isStat = request.params.name === 'anti.artifact.stat' ||
      request.params.name === 'artifact.stat' ||
      request.params.name === 'artifact_stat';
    if (isStat) {
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    // Handle ArtifactRef resolution from ArtifactStore for content-fetching capabilities
    if (data && typeof data === 'object' && typeof data.id === 'string' && data.id.startsWith('artifact-')) {
      const isImage = request.params.name === 'anti.screenshot.viewport' ||
        request.params.name === 'antifan_screenshot' ||
        (typeof data.mime === 'string' && data.mime.startsWith('image/'));
      if (isImage) {
        const artifactPayload = await fetchArtifactBinary(bootstrap, data.id);
        const detectedMime = artifactPayload.data.startsWith('/9j/')
          ? 'image/jpeg'
          : artifactPayload.data.startsWith('iVBORw0KGgo')
          ? 'image/png'
          : artifactPayload.data.startsWith('UklGR')
          ? 'image/webp'
          : (artifactPayload.mimeType || data.mime || 'image/png');
        return {
          content: [
            {
              type: 'image',
              data: artifactPayload.data,
              mimeType: detectedMime,
            },
          ],
        };
      }

      // If text artifact exceeds 64 KiB, return ArtifactRef metadata to prevent stdio pipe saturation
      const byteSize = typeof data.byteLength === 'number'
        ? data.byteLength
        : (typeof data.bytes === 'number' ? data.bytes : null);
      if (byteSize !== null && byteSize >= 65536) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                _type: 'ArtifactRef',
                id: data.id,
                byteLength: byteSize,
                sha256: data.sha256,
                mime: data.mime || 'text/plain',
                message: 'Large payload (>=64KB) preserved as ArtifactRef to prevent stdio buffer saturation. Read via artifact.read or HTTP endpoint.',
              }, null, 2),
            },
          ],
        };
      }

      // Small text artifact (<64KB)
      const artifactPayload = await fetchArtifactBinary(bootstrap, data.id);
      const textContent = Buffer.from(artifactPayload.data, 'base64').toString('utf8');
      if (textContent.length >= 65536) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                _type: 'ArtifactRef',
                id: data.id,
                byteLength: textContent.length,
                sha256: data.sha256,
                mime: data.mime || 'text/plain',
                message: 'Large payload (>=64KB) preserved as ArtifactRef to prevent stdio buffer saturation. Read via artifact.read or HTTP endpoint.',
              }, null, 2),
            },
          ],
        };
      }
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
