#!/usr/bin/env node
const crypto = require('node:crypto');
const http = require('node:http');
const { WebSocket } = require('ws');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const definitions = [
  ['anti.browser.tabs.list', 'List tabs in the live AntiFan Desktop Browser GUI (every tab in the window by default; pass all: false to list only the tabs this session owns). Primary browser tool for theme development and live tab management.', { all: { type: 'boolean', default: true, description: 'List every tab in the browser window (default). Pass false to restrict the list to the tabs this session owns.' } }],
  ['anti.browser.tabs.create', 'Open a new tab in live AntiFan Desktop Browser GUI without stealing focus.', { url: { type: 'string' } }, ['url']],
  ['anti.browser.tabs.activate', 'Switch the active tab visible to the user in live AntiFan Desktop Browser GUI by tabId.', { tabId: { type: 'string' } }, ['tabId']],
  ['anti.browser.tabs.close', 'Close a tab in live AntiFan Desktop Browser GUI by tabId.', { tabId: { type: 'string' } }, ['tabId']],
  ['anti.browser.navigate', 'Navigate active or background tab in live AntiFan Desktop Browser GUI.', { url: { type: 'string' }, tabId: { type: 'string' } }, ['url']],
  ['anti.browser.reload', 'Reload active or background tab in live AntiFan Desktop Browser GUI.', { tabId: { type: 'string' } }],
  ['anti.inspect.dom', 'Read DOM elements and computed attributes from AntiFan Desktop tab (supports desktop and mobile split panes). Operates directly against background tab.', { selector: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.screenshot.viewport', 'Capture high-fidelity viewport screenshot from live AntiFan Desktop GUI (supports desktop and mobile split panes, format: jpeg/png). Viewport-only: full_page:true is rejected; use anti.screenshot.full_page for entire document height.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, format: { type: 'string', enum: ['jpeg', 'png'] }, quality: { type: 'number' } }],
  ['anti.screenshot.full_page', 'Capture canonical CDP full-page evidence (entire document scroll height) and stage it under the evidence lease.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'number' } }],
  ['anti.reference.capture', 'Capture a reference from a live page: materialize lazily-mounted content, settle, then stage the settled DOM (and optionally a screenshot) so later measurements describe the page a comparator actually rasterizes.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, selector: { type: 'string' }, screenshot: { type: 'boolean' }, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'number' } }],
  ['anti.browser.set_viewport', 'Set the bound tab viewport dimensions and device emulation, verified against the size the tab actually measures.', { width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' }, deviceScaleFactor: { type: 'number' }, tabId: { type: 'string' }, reload: { type: 'boolean' } }, ['width', 'height']],
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
  ['anti.theme.style_override', 'In-memory ephemeral CSS stylesheet override for safe theme testing without writing files to disk (bypasses CLI watchers).', { operation: { type: 'string', enum: ['apply', 'clear'] }, id: { type: 'string' }, css: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['operation', 'id']],
  ['theme.style_override', 'In-memory ephemeral CSS stylesheet override for safe theme testing without writing files to disk (bypasses CLI watchers).', { operation: { type: 'string', enum: ['apply', 'clear'] }, id: { type: 'string' }, css: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['operation', 'id']],
  ['anti.agent.file_upload', 'Upload local files into a file input element in live AntiFan Desktop tab without native file dialogs.', { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['refOrSelector', 'filePaths']],
  ['anti.agent.drop', 'Dispatch native drag and drop file transfer onto a target drop zone element in live AntiFan Desktop tab.', { refOrSelector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['refOrSelector', 'filePaths']],
  ['anti.inspect.snapshot', 'Capture an accessible semantic snapshot of elements indexed with monotonic @e1..@eN references (supports selector and viewportOnly filtering).', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, selector: { type: 'string' }, viewportOnly: { type: 'boolean' } }],
  ['anti.browser.evaluate', 'Execute JavaScript expression in page context with depth-capped circular protection. Refuses a tab with no laid-out surface (0x0 CSS px) unless allowDegradedSurface is set.', { expression: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, allowDegradedSurface: { type: 'boolean', description: 'Run even when the tab reports a 0x0 surface (diagnostic escape hatch; the page is not laid out and most measurements will be meaningless)' } }, ['expression']],
  ['anti.telemetry.record_fallback', 'Record sanitized fallback telemetry when invoking Playwright after an AntiFan capability failure.', { primaryTool: { type: 'string' }, fallbackTool: { type: 'string' }, fallbackResult: { type: 'string', enum: ['SUCCESS', 'FAILED', 'SKIPPED'] }, sessionId: { type: 'string' }, targetUrl: { type: 'string' }, errorCode: { type: 'string' }, errorMessage: { type: 'string' }, durationMs: { type: 'number' }, notes: { type: 'string' } }, ['primaryTool', 'fallbackTool', 'fallbackResult']],
  ['anti.inspect.styles', 'Inspect computed CSS styles, box model, typography, layout, and CSS variables for an element (supports @ref or CSS selector).', { selector: { type: 'string' }, ref: { type: 'string' }, properties: { type: 'array', items: { type: 'string' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.inspect.region', 'Inspect spatial region bounds, collecting intersecting visible DOM elements with coordinates and z-index.', { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, selector: { type: 'string' }, ref: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.trace.interaction', 'Trace an interactive action (click, hover, focus, type, scroll) capturing pre/post DOM changes, style deltas, and layout shifts.', { action: { type: 'string', enum: ['click', 'hover', 'focus', 'type', 'scroll'] }, selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, deltaY: { type: 'number' }, settleMs: { type: 'number' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['action']],
  ['anti.visual.compare', 'Compare current viewport or tab against baseline screenshot with pixel-level diffing, element selection, dynamic masking, and configurable tolerance.', { baselineScreenshotRef: { type: 'string' }, comparisonTabId: { type: 'string' }, tolerance: { type: 'number' }, selector: { type: 'string' }, clipRect: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } }, maskSelectors: { type: 'array', items: { type: 'string' } }, maskOptionalSelectors: { type: 'array', items: { type: 'string' } }, normalizeScroll: { type: 'boolean' }, fullPage: { type: 'boolean', description: 'Capture and compare entire document scroll height' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.media.freeze', 'Freeze or unfreeze dynamic media (videos, audios, CSS animations, requestAnimationFrame) in tab to enable deterministic visual comparisons.', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, freeze: { type: 'boolean', description: 'True to freeze media and pause animations; false to resume' } }],
  ['anti.inspect.page_inventory', 'Scan entire physical page structure from y=0 to scrollHeight, returning list of all sections, coordinates, heights, and layout groups (chống sót header/footer/newsletter).', { tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.inspect.style_diff', 'Compare computed CSS styles and box-model metrics between elements on two tabs (or two selectors).', { selector: { type: 'string', description: 'CSS selector of target element on tab 1' }, comparisonSelector: { type: 'string', description: 'CSS selector on tab 2 (defaults to selector)' }, tabId: { type: 'string' }, comparisonTabId: { type: 'string' }, properties: { type: 'array', items: { type: 'string' }, description: 'CSS properties to compare' } }, ['selector']],
  ['anti.spec.validate_gate', 'Validate HTML Specification against target page to certify HTML_SPEC_READY status before theme compilation.', { specTabId: { type: 'string' }, targetTabId: { type: 'string' }, tolerance: { type: 'number' } }],
  ['anti.agent.sequence', 'Execute an atomic multi-step action sequence (navigate, click, type, scroll, hover, pressKey, wait, screenshot, snapshot) in 1 roundtrip with auto-wait and navigation guards.', { actions: { type: 'array', items: { type: 'object' } }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, stopOnError: { type: 'boolean' } }, ['actions']],
  ['anti.artifact.read', 'Read an authorized artifact by ID with bounded chunk size (clamped to max 32KB per frame).', { artifactId: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, ['artifactId']],
  ['anti.artifact.stat', 'Retrieve metadata and size information for an authorized artifact.', { artifactId: { type: 'string' } }, ['artifactId']],
  ['browser.set-viewport', 'Set the bound Chromium tab viewport dimensions and device emulation.', { width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' }, deviceScaleFactor: { type: 'number' }, tabId: { type: 'string' }, reload: { type: 'boolean' } }, ['width', 'height']],
  ['file.read', 'Read a file relative to the authoritative workspace root.', { path: { type: 'string' }, maxBytes: { type: 'number' } }, ['path']],
  ['file.write', 'Write a file relative to the authoritative workspace root with boundary enforcement.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']],
  ['anti.theme.resolve_element', 'Map a live DOM element to bounded, correlated local theme source candidates.', { selector: { type: 'string' }, ref: { type: 'string' }, workspaceRoot: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.inspect.matched_styles', 'Inspect live CDP matched CSS and classify active versus overridden declarations.', { nodeId: { type: 'number' }, selector: { type: 'string' }, ref: { type: 'string' }, tabId: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] }, stylesheetUrlMap: { type: 'object' } }],
  ['anti.inspect.responsive_matrix', 'Probe document and target overflow at the five standard responsive widths.', { selector: { type: 'string' }, tabId: { type: 'string' } }],
  ['anti.verification.record_claim', 'Record a live verification claim as UNVERIFIED with explicit proof obligations.', { claim: { type: 'string' }, category: { type: 'string', enum: ['INTERACTION', 'LAYOUT', 'RESPONSIVE', 'CUSTOM'] }, actor: { type: 'string', enum: ['agent', 'user'] }, tabId: { type: 'string' }, selector: { type: 'string' }, expectedHeight: { type: 'number' }, expectedSections: { type: 'number' }, tolerance: { type: 'number' }, proofObligations: { type: 'array', maxItems: 50, items: { type: 'object', properties: { id: { type: 'string' }, metric: { type: 'string', description: 'Obligation metric identifier (required)' }, tolerance: { type: 'number' }, critical: { type: 'boolean' }, expected: {} }, required: ['metric'] } }, linkedIssueId: { type: 'string' } }, ['claim', 'tabId', 'category']],
  ['anti.verification.verify_claim', 'Evaluate a recorded claim against fresh live browser evidence and persist an authoritative receipt.', { claimId: { type: 'string' }, witnessObservation: { type: 'string' }, semanticFailureObservation: { type: 'string' } }, ['claimId']],
  ['anti.verification.list', 'List recorded verification claims and their current verdicts.', { verdict: { type: 'string' }, category: { type: 'string' } }],
];

let currentAuthorityRevision = null;
let dynamicBootstrap = null;

function resolveBridgeCandidates() {
  // Fail-closed, bootstrap-only authority: the OMP proxy connects exclusively to
  // the explicit bridge endpoint supplied via environment. It MUST NOT discover
  // bridge credentials from disk — ambient endpoint discovery is the fail-open
  // vector dual-plane eliminates.
  const parsedBootstrap = (() => {
    if (process.env.ANTIFAN_MCP_BOOTSTRAP) {
      try {
        const b = JSON.parse(process.env.ANTIFAN_MCP_BOOTSTRAP);
        if (b && typeof b.port === 'number' && b.port > 0) return b;
      } catch {}
    }
    if (process.env.ANTIFAN_ATTACHMENT_SECRET) {
      const port = parseInt(process.env.ANTIFAN_MCP_PORT || '20129', 10);
      if (port > 0) {
        return {
          port,
          host: process.env.ANTIFAN_HOST || '127.0.0.1',
          token: process.env.ANTIFAN_ATTACHMENT_SECRET,
          secret: process.env.ANTIFAN_ATTACHMENT_SECRET,
          runId: process.env.ANTIFAN_RUN_ID,
          attemptId: process.env.ANTIFAN_ATTEMPT_ID,
          projectId: process.env.ANTIFAN_PROJECT_ID,
          workspaceId: process.env.ANTIFAN_WORKSPACE_ID,
        };
      }
    }
    return null;
  })();

  if (!parsedBootstrap) return [];

  const host = parsedBootstrap.host || '127.0.0.1';
  const port = parsedBootstrap.port;
  const token = parsedBootstrap.token || parsedBootstrap.secret || '';
  return [
    {
      source: 'env',
      host,
      port,
      token,
      secret: parsedBootstrap.secret || token,
      pid: parsedBootstrap.ownerPid,
      pidAlive: parsedBootstrap.ownerPid ? true : null,
      startedAt: 0,
      isDev: Boolean(parsedBootstrap.isDev),
    },
  ];
}

// Disk discovery is delegated to the launcher's single candidate authority; the
// proxy keeps no filesystem or credential-discovery logic of its own. Failover is
// enabled only for a terminal-scoped agent session, so an unattended or
// hand-invoked proxy stays bootstrap-only and fail-closed.
const { resolveBridgeCandidates: discoverLocalCandidates, compareCandidates: compareBridgeCandidates } = require('./antifan-agent.cjs');

function hasTerminalInstanceContext() {
  return Boolean(
    process.env.ANTIFAN_TERMINAL_AFFINITY_SESSION_ID ||
    process.env.ANTIFAN_TERMINAL_PARENT_SESSION_ID ||
    process.env.ANTIFAN_TERMINAL_SESSION_ID ||
    process.env.ANTIFAN_BRIDGE_PID
  );
}

function resolveFailoverCandidates() {
  const pinnedCandidates = resolveBridgeCandidates().map((c) => ({ ...c, pinned: true, provenance: 'env' }));
  if (!hasTerminalInstanceContext()) return pinnedCandidates;
  const seen = new Set(pinnedCandidates.map((c) => `${c.host}:${c.port}`));
  const discovered = discoverLocalCandidates().filter((c) => !seen.has(`${c.host}:${c.port}`));
  return [...pinnedCandidates, ...discovered].sort(compareBridgeCandidates);
}

function getBootstrap() {
  if (dynamicBootstrap && dynamicBootstrap.secret) {
    if (currentAuthorityRevision) {
      dynamicBootstrap.authorityRevision = currentAuthorityRevision;
    }
    return dynamicBootstrap;
  }
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
  'anti.screenshot.full_page': 'anti.screenshot.full_page',
  'anti.reference.capture': 'anti.reference.capture',
  'anti.browser.set_viewport': 'browser.set-viewport',
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

// ─── Client Dispatch Budgets and Failure Classification (contract §2.6) ──────
// Client budgets MUST exceed the bounded server policy budget so a hung
// capability is bounded server-side first: the client then observes a typed
// terminal (or pending-cleanup) receipt instead of abandoning the invocation and
// replaying unknown work.
const CLIENT_TIMEOUT_MS = Object.freeze({
  'browser.visual_compare': 240000,
  'anti.visual.compare': 240000,
  'anti.screenshot.full_page': 150000,
  'anti.reference.capture': 130000,
  'browser.screenshot': 45000,
  'browser.set-viewport': 45000,
  'theme.qa_validate': 60000,
  'anti.theme.qa_validate': 60000,
});
const DEFAULT_CLIENT_TIMEOUT_MS = 30000;

// Operation outcomes, never transport faults: they describe what the capability
// did, so no reconnect, authority autoheal, or replay may follow them.
const OPERATION_TIMEOUT_CODES = new Set(['TIMEOUT', 'EXECUTION_TIMEOUT', 'EXECUTION_TIMEOUT_PENDING_CLEANUP']);

// Only transport/auth faults may retry, and only with the original identity.
const RETRYABLE_TRANSPORT_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ERROR',
  'CONNECTION_FAILED',
  'AUTHENTICATION_DENIED',
  'UNAUTHORIZED',
  'UNAUTHENTICATED',
  'REVISION_STALE',
  'ATTACHMENT_INVALID',
  'BOOTSTRAP_INVALID',
  'PAIRING_CHALLENGE_FAILED',
  'PAIRING_EXCHANGE_FAILED',
]);

function resolveClientTimeoutMs(method, mapped) {
  return CLIENT_TIMEOUT_MS[method] ?? CLIENT_TIMEOUT_MS[mapped] ?? DEFAULT_CLIENT_TIMEOUT_MS;
}

function transportError(code, message, details) {
  const err = new Error(typeof message === 'string' && message.length > 0 ? message : code);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function isRetryableTransportError(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (OPERATION_TIMEOUT_CODES.has(code)) return false;
  if (RETRYABLE_TRANSPORT_CODES.has(code)) return true;
  const text = String((err && err.message) || err || '');
  if (OPERATION_TIMEOUT_CODES.has(text)) return false;
  return /CONNECTION_CLOSED|CONNECTION_ERROR|CONNECTION_FAILED|Unauthorized|missing or invalid token|AUTHENTICATION_DENIED/i.test(text);
}

/**
 * One invocation identity per logical call. `idempotencyKey` is the ledger join
 * key; it is minted once and reused across eligible transport retries so a retry
 * joins the original invocation instead of minting a new one.
 */
function resolveInvocationIdentity(callerRequestId, params) {
  const p = params && typeof params === 'object' ? params : {};
  const explicitKey = typeof p.idempotencyKey === 'string' && p.idempotencyKey.trim() ? p.idempotencyKey.trim() : null;
  const explicitRequest = typeof p.requestId === 'string' && p.requestId.trim() ? p.requestId.trim() : null;
  const caller = callerRequestId !== undefined && callerRequestId !== null && String(callerRequestId).trim()
    ? String(callerRequestId).trim()
    : null;
  return {
    requestId: explicitRequest || (caller ? `req-mcp-${caller}` : `req-${crypto.randomUUID()}`),
    idempotencyKey: explicitKey || (caller ? `idem-mcp-${caller}` : `idem-${crypto.randomUUID()}`),
  };
}

function persistAuthorityRevision(revision) {
  if (typeof revision === 'string' && revision.startsWith('rev_')) {
    currentAuthorityRevision = revision;
  }
}

/**
 * Nonterminal surface for EXECUTION_TIMEOUT_PENDING_CLEANUP: the invocation owns
 * resources and has no terminal receipt yet. It is joinable only by its own
 * identity (re-issue with the same idempotencyKey).
 */
function buildPendingCleanupResult(payload, entry) {
  const details = payload && typeof payload.details === 'object' && payload.details !== null ? payload.details : {};
  const invocationId = typeof details.invocationId === 'string'
    ? details.invocationId
    : (typeof payload.invocationId === 'string' ? payload.invocationId : null);
  return {
    _type: 'PENDING_CLEANUP',
    code: 'EXECUTION_TIMEOUT_PENDING_CLEANUP',
    message: typeof payload.message === 'string' && payload.message
      ? payload.message
      : 'Capability execution timed out with owned-resource cleanup still pending. No terminal receipt exists yet.',
    invocationId,
    cleanupPending: true,
    terminal: false,
    joinableBy: 'idempotencyKey',
    requestId: entry.requestId,
    idempotencyKey: entry.idempotencyKey,
  };
}

// ─── Multiplexed Persistent Dispatch Socket ──────────────────────────────────
let dispatchWs = null;
let dispatchConnecting = null;
const pendingDispatchCalls = new Map(); // id -> { resolve, reject, timer }

function wireDispatchSocket(ws) {
  ws.on('message', (raw) => {
    try {
      const response = JSON.parse(raw.toString());
      if (!response || !response.id) {
        return;
      }
      const payload = response.data && typeof response.data === 'object' ? response.data : null;
      if (payload) {
        const rev = payload.replacementAuthorityRevision || payload.authorityRevision;
        if (rev) {
          persistAuthorityRevision(rev);
        }
      }
      if (!pendingDispatchCalls.has(response.id)) {
        return;
      }
      const entry = pendingDispatchCalls.get(response.id);
      pendingDispatchCalls.delete(response.id);
      clearTimeout(entry.timer);
      if (response.success) {
        if (response.data && typeof response.data === 'object') {
          persistAuthorityRevision(response.data.authorityRevision || response.data.replacementAuthorityRevision);
          if (response.data.data !== undefined) {
            entry.resolve(response.data.data);
            return;
          }
        }
        entry.resolve(response.data);
      } else {
        const payload = response.data && typeof response.data === 'object' ? response.data : {};
        persistAuthorityRevision(payload.replacementAuthorityRevision || payload.authorityRevision);
        const code = typeof payload.code === 'string' && payload.code
          ? payload.code
          : (typeof response.error === 'string' && response.error.includes(':')
            ? response.error.slice(0, response.error.indexOf(':'))
            : 'CAPABILITY_ERROR');
        if (code === 'EXECUTION_TIMEOUT_PENDING_CLEANUP') {
          // Nonterminal: the invocation still owns resources. Surface the typed
          // pending state; never reject into the retry path.
          process.stderr.write(`[MCP Proxy RPC Pending Cleanup] ${JSON.stringify(response)}\n`);
          entry.resolve(buildPendingCleanupResult(payload, entry));
          return;
        }
        process.stderr.write(`[MCP Proxy RPC Error] ${JSON.stringify(response)}\n`);
        const errorText = typeof response.error === 'string' && response.error
          ? response.error
          : JSON.stringify(payload.code ? payload : { code: 'CAPABILITY_ERROR', message: 'AntiFan RPC failed' });
        entry.reject(transportError(code, errorText, payload.details));
      }
    } catch {}
  });

  ws.once('error', (err) => {
    dispatchConnecting = null;
    if (dispatchWs === ws) dispatchWs = null;
    for (const [, entry] of pendingDispatchCalls.entries()) {
      clearTimeout(entry.timer);
      entry.reject(transportError('CONNECTION_ERROR', JSON.stringify({ code: 'CONNECTION_ERROR', message: `Dispatch WebSocket error: ${err.message}` })));
    }
    pendingDispatchCalls.clear();
  });

  ws.once('close', () => {
    dispatchConnecting = null;
    if (dispatchWs === ws) dispatchWs = null;
    for (const [, entry] of pendingDispatchCalls.entries()) {
      clearTimeout(entry.timer);
      entry.reject(transportError('CONNECTION_CLOSED', JSON.stringify({ code: 'CONNECTION_CLOSED', message: 'Dispatch WebSocket closed while request in flight' })));
    }
    pendingDispatchCalls.clear();
  });
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

async function autohealSession() {
  const candidates = resolveFailoverCandidates();
  if (candidates.length === 0) {
    process.stderr.write('MCP_BRIDGE_OFFLINE: AntiFan Desktop Bridge is not running (no candidates discovered).\n');
    return null;
  }
  for (const candidate of candidates) {
    try {
      let authSecret = candidate.token || '';
      let pairedExchange = null;
      if (!authSecret) {
        pairedExchange = await performPairingExchange(candidate.host, candidate.port);
        authSecret = pairedExchange.secret;
      }

      const wsUrl = `ws://${candidate.host}:${candidate.port}`;
      const headers = {};
      if (pairedExchange && pairedExchange.secret) {
        headers['x-antifan-attachment-secret'] = pairedExchange.secret;
        headers['Authorization'] = `Bearer ${pairedExchange.secret}`;
      } else if (authSecret) {
        headers['Authorization'] = `Bearer ${authSecret}`;
        headers['x-antifan-attachment-secret'] = authSecret;
      }
      const ws = new WebSocket(wsUrl, { headers });

      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try { ws.close(); } catch {}
            reject(new Error('Autoheal WebSocket timeout'));
          }
        }, 15000);

        ws.once('open', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        });
        ws.once('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
        ws.once('close', (code, reason) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`Autoheal WebSocket closed early (${code}): ${reason || ''}`));
          }
        });
      });

      const startId = 'autoheal-' + crypto.randomUUID();
      const session = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('startSession timeout')), 5000);
        const onMsg = (raw) => {
          try {
            const resp = JSON.parse(raw.toString());
            if (resp && resp.id === startId) {
              clearTimeout(timer);
              ws.removeListener('message', onMsg);
              if (resp.success && resp.data) {
                resolve(resp.data);
              } else {
                reject(new Error(resp.error || 'startSession failed'));
              }
            }
          } catch {}
        };
        ws.on('message', onMsg);
        const rawTerminalId = process.env.ANTIFAN_TERMINAL_AFFINITY_SESSION_ID || process.env.ANTIFAN_TERMINAL_PARENT_SESSION_ID || process.env.ANTIFAN_TERMINAL_SESSION_ID;
        const rawGeneration = process.env.ANTIFAN_TERMINAL_AFFINITY_GENERATION || process.env.ANTIFAN_TERMINAL_GENERATION;
        ws.send(JSON.stringify({
          id: startId,
          method: 'antifan.cli.startSession',
          params: {
            backendId: 'cli',
            grant: 'eval',
            cwd: process.cwd(),
            attachmentId: pairedExchange?.attachmentId || undefined,
            terminalSessionId: rawTerminalId ? String(rawTerminalId).trim() : undefined,
            terminalGeneration: rawGeneration ? String(rawGeneration).trim() : undefined,
          },
        }));
      });
      if (!session || !session.attachmentId || !session.secret || !session.authorityRevision || !session.tabId) {
        const missing = [
          !session?.attachmentId && 'attachmentId',
          !session?.secret && 'secret',
          !session?.authorityRevision && 'authorityRevision',
          !session?.tabId && 'tabId',
        ].filter(Boolean).join(', ');
        const err = new Error(`BOOTSTRAP_INVALID: Bridge startSession response missing mandatory fields (${missing})`);
        err.code = 'BOOTSTRAP_INVALID';
        throw err;
      }

      dynamicBootstrap = {
        port: candidate.port,
        host: candidate.host,
        secret: session.secret,
        attachmentId: session.attachmentId,
        authorityRevision: session.authorityRevision,
        runId: session.runId,
        attemptId: session.attemptId,
        projectId: session.projectId,
        workspaceId: session.workspaceId,
        tabId: session.tabId,
        token: candidate.token || session.secret,
      };
      currentAuthorityRevision = session.authorityRevision;

      // The healed endpoint may be a different instance than the one this session
      // was pinned to: say so, and rebind to the tab that instance actually gave us
      // (the previously bound tab does not exist there).
      const rawPinnedPid = parseInt(process.env.ANTIFAN_BRIDGE_PID || '', 10);
      const pinnedPid = Number.isInteger(rawPinnedPid) && rawPinnedPid > 0 ? rawPinnedPid : null;
      const answeredPid = typeof session.runtimePid === 'number' && Number.isInteger(session.runtimePid) && session.runtimePid > 0
        ? session.runtimePid
        : null;
      if (pinnedPid !== null && answeredPid !== pinnedPid) {
        process.stderr.write(`[AntiFan Autoheal] FOREIGN_INSTANCE_ATTACH: pinned pid ${pinnedPid} did not answer; attached to ${candidate.host}:${candidate.port} (pid ${answeredPid === null ? 'unknown' : answeredPid})\n`);
      }
      process.env.ANTIFAN_BOUND_TAB_ID = session.tabId;

      // Wire the dispatch socket before the heartbeat so no recovery path can
      // observe an unbound dispatcher while the binding is being rebound.
      dispatchWs = ws;
      wireDispatchSocket(ws);
      startHeartbeat(dynamicBootstrap);
      return dynamicBootstrap;
    } catch (err) {
      process.stderr.write(`[AntiFan Autoheal] Candidate ${candidate.host}:${candidate.port} failed: ${err.message}\n`);
    }
  }
  process.stderr.write('MCP_BRIDGE_OFFLINE: All candidate AntiFan Desktop Bridge endpoints failed to connect.\n');
  return null;
}

async function ensureDispatchSocket(bootstrap) {
  if (dispatchWs && dispatchWs.readyState === WebSocket.OPEN) {
    return dispatchWs;
  }
  if (dispatchConnecting) {
    return dispatchConnecting;
  }

  dispatchConnecting = (async () => {
    if (bootstrap && bootstrap.port && (bootstrap.token || bootstrap.secret)) {
      try {
        const authHeaders = {};
        if (bootstrap.secret) {
          authHeaders['X-Antifan-Attachment-Secret'] = bootstrap.secret;
          authHeaders['Authorization'] = `Bearer ${bootstrap.secret}`;
        }
        if (bootstrap.token && !authHeaders['Authorization']) {
          authHeaders['Authorization'] = `Bearer ${bootstrap.token}`;
        }
        const url = `ws://127.0.0.1:${bootstrap.port}`;

        const ws = new WebSocket(url, { headers: authHeaders });
        await new Promise((resolve, reject) => {
          let settled = false;
          const connectTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              try { ws.close(); } catch {}
              reject(new Error('Connection timeout'));
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
          ws.once('close', (code) => {
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              reject(new Error(`Closed early with code ${code}`));
            }
          });
        });

        dispatchWs = ws;
        wireDispatchSocket(ws);
        return ws;
      } catch (err) {
        process.stderr.write(`[AntiFan MCP] Initial connection failed (${err.message}). Autohealing...\n`);
      }
    }

    const healed = await autohealSession();
    if (healed && dispatchWs && dispatchWs.readyState === WebSocket.OPEN) {
      return dispatchWs;
    }

    throw transportError('CONNECTION_FAILED', JSON.stringify({ code: 'CONNECTION_FAILED', message: 'Unable to connect to live AntiFan Desktop bridge after autoheal' }));
  })().finally(() => {
    dispatchConnecting = null;
  });

  return dispatchConnecting;
}

async function invoke(method, params = {}, callerRequestId) {
  let bootstrap = getBootstrap();
  if (!bootstrap || !bootstrap.secret) {
    try {
      await autohealSession();
    } catch (err) {
      process.stderr.write(`[AntiFan MCP] Autoheal failed: ${err.message}\n`);
    }
    bootstrap = getBootstrap();
    if (!bootstrap || !bootstrap.secret) {
      process.stderr.write('MCP_BRIDGE_OFFLINE: AntiFan Desktop Bridge unavailable\n');
      throw transportError('MCP_CONTEXT_REQUIRED', JSON.stringify({ code: 'MCP_CONTEXT_REQUIRED', message: 'OMP MCP proxy requires an authoritative Main bootstrap' }));
    }
  }

  const mapped = CAPABILITY_MAP[method] || method;
  const timeoutMs = resolveClientTimeoutMs(method, mapped);
  // Invocation identity is minted ONCE per logical call, outside the retryable
  // dispatch function: an eligible transport retry resends the same
  // requestId/idempotencyKey and therefore joins the original ledger entry
  // instead of minting a new invocation.
  const identity = resolveInvocationIdentity(callerRequestId, params);
  // Transport-only arguments are consumed here and never forwarded to the
  // capability. The remaining params are frozen for the life of the invocation so
  // a retry stays digest-identical to the original (the ledger joins on digest).
  const effectiveParams = { ...params };
  delete effectiveParams.idempotencyKey;
  delete effectiveParams.requestId;
  delete effectiveParams.callerRequestId;
  const boundTabId = bootstrap.tabId || process.env.ANTIFAN_BOUND_TAB_ID;
  if (!effectiveParams.tabId && boundTabId) {
    effectiveParams.tabId = boundTabId;
  }
  if (mapped === 'artifact.read') {
    const rawLimit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 32768;
    effectiveParams.limit = Math.min(rawLimit, 32768); // Bounded chunk size: <= 32 KiB per frame
  }

  const sendDispatch = async (currentBoot) => {
    const ws = await ensureDispatchSocket(currentBoot);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingDispatchCalls.delete(id);
        // Client budget exhaustion is an operation outcome, not a transport
        // fault: never reconnect and never replay. The server still owns the
        // invocation; a late response is discarded by the unknown-id guard in
        // wireDispatchSocket and leaves the socket usable.
        reject(transportError('TIMEOUT', JSON.stringify({ code: 'TIMEOUT', message: `AntiFan RPC timed out: ${mapped}` })));
      }, timeoutMs);

      pendingDispatchCalls.set(id, {
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
        resolve: (data) => {
          if (mapped === 'browser.switch-tab' && effectiveParams.tabId) {
            currentBoot.tabId = effectiveParams.tabId;
            process.env.ANTIFAN_BOUND_TAB_ID = effectiveParams.tabId;
          } else if (mapped === 'browser.open-tab' && data && typeof data === 'object' && typeof data.tabId === 'string') {
            currentBoot.tabId = data.tabId;
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
            requestId: identity.requestId,
            idempotencyKey: identity.idempotencyKey,
            attachmentId: currentBoot.attachmentId,
            attachmentSecret: currentBoot.secret,
            authorityRevision: currentAuthorityRevision || currentBoot.authorityRevision,
            attachmentClaims: {
              attachmentSecret: currentBoot.secret,
              attachmentId: currentBoot.attachmentId,
              authorityRevision: currentAuthorityRevision || currentBoot.authorityRevision,
              runId: currentBoot.runId,
              attemptId: currentBoot.attemptId,
              projectId: currentBoot.projectId,
              workspaceId: currentBoot.workspaceId,
              ownerPid: currentBoot.ownerPid,
            },
          },
        }));
      } catch (err) {
        clearTimeout(timer);
        pendingDispatchCalls.delete(id);
        reject(err);
      }
    });
  };

  try {
    return await sendDispatch(bootstrap);
  } catch (err) {
    // Only connection/auth faults may retry; operation timeouts never do.
    if (!isRetryableTransportError(err)) throw err;
    const errStr = String(err?.message || err);
    process.stderr.write(`[AntiFan MCP] Connection or auth issue detected (${errStr}). Autohealing...\n`);
    if (dispatchWs) {
      try { dispatchWs.close(); } catch {}
      dispatchWs = null;
    }
    const healed = await autohealSession();
    if (healed && healed.secret) {
      return await sendDispatch(healed);
    }
    throw err;
  }
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
  return `ws://127.0.0.1:${bootstrap.port}`;
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
  if (bootstrap.secret) {
    authHeaders['X-Antifan-Attachment-Secret'] = bootstrap.secret;
    authHeaders['Authorization'] = `Bearer ${bootstrap.secret}`;
  }
  if (bootstrap.token && !authHeaders['Authorization']) {
    authHeaders['Authorization'] = `Bearer ${bootstrap.token}`;
  }
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
  stopHeartbeat(); // idempotent re-bind: never leave two intervals or a stale binding
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
    // Nonterminal pending-cleanup: the invocation still owns resources and has no
    // receipt yet. Surface it as a typed non-error result carrying the identity
    // required to join (re-issue with the same idempotencyKey).
    if (data && typeof data === 'object' && data._type === 'PENDING_CLEANUP') {
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    // For stat tools, directly return raw ArtifactRef metadata without hydration
    const isStat = request.params.name === 'anti.artifact.stat' ||
      request.params.name === 'artifact.stat' ||
      request.params.name === 'artifact_stat';
    if (isStat) {
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    // Screenshot capabilities return an evidence envelope ({ok, artifactRef,
    // receipt, sha256, byteLength}); older builds returned the raw ArtifactRef.
    // Both shapes resolve through the same artifact fetch.
    const ref = data && typeof data === 'object' && data.artifactRef && typeof data.artifactRef === 'object'
      ? data.artifactRef
      : data;
    const isScreenshotCapability = request.params.name === 'anti.screenshot.viewport' ||
      request.params.name === 'antifan_screenshot' ||
      request.params.name === 'anti.screenshot.full_page' ||
      request.params.name === 'anti.screenshot.fullpage' ||
      request.params.name === 'antifan_screenshot_full_page';

    // Handle ArtifactRef resolution from ArtifactStore for content-fetching capabilities
    if (ref && typeof ref === 'object' && typeof ref.id === 'string' && ref.id.startsWith('artifact-')) {
      const isImage = isScreenshotCapability ||
        (typeof ref.mime === 'string' && ref.mime.startsWith('image/'));
      if (isImage) {
        const artifactPayload = await fetchArtifactBinary(bootstrap, ref.id);
        return resolveImageArtifactResponse(ref, artifactPayload);
      }

      // If text artifact exceeds 64 KiB, return ArtifactRef metadata to prevent stdio pipe saturation
      const byteSize = typeof ref.byteLength === 'number'
        ? ref.byteLength
        : (typeof ref.bytes === 'number' ? ref.bytes : (typeof data.byteLength === 'number' ? data.byteLength : null));
      if (byteSize !== null && byteSize >= 65536) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                _type: 'ArtifactRef',
                id: ref.id,
                byteLength: byteSize,
                sha256: ref.sha256 || data.sha256,
                mime: ref.mime || data.mime || 'text/plain',
                message: 'Large payload (>=64KB) preserved as ArtifactRef to prevent stdio buffer saturation. Read via artifact.read or HTTP endpoint.',
              }, null, 2),
            },
          ],
        };
      }

      // Small text artifact (<64KB)
      const artifactPayload = await fetchArtifactBinary(bootstrap, ref.id);
      const textContent = Buffer.from(artifactPayload.data, 'base64').toString('utf8');
      if (textContent.length >= 65536) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                _type: 'ArtifactRef',
                id: ref.id,
                byteLength: textContent.length,
                sha256: ref.sha256 || data.sha256,
                mime: ref.mime || data.mime || 'text/plain',
                message: 'Large payload (>=64KB) preserved as ArtifactRef to prevent stdio buffer saturation. Read via artifact.read or HTTP endpoint.',
              }, null, 2),
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: textContent }] };
    }

    if (isScreenshotCapability) {
      throw new Error(JSON.stringify({ code: 'CAPABILITY_ERROR', message: 'Expected ArtifactRef metadata from screenshot capability' }));
    }

    return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
  }
});
function resolveImageArtifactResponse(data, artifactPayload) {
  if (!artifactPayload || !artifactPayload.data || artifactPayload.data.length === 0) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error: EMPTY_ARTIFACT: Image artifact payload is empty (0 bytes) for artifact '${data && data.id ? data.id : 'unknown'}'.`,
        },
      ],
    };
  }
  const detectedMime = artifactPayload.data.startsWith('/9j/')
    ? 'image/jpeg'
    : artifactPayload.data.startsWith('iVBORw0KGgo')
    ? 'image/png'
    : artifactPayload.data.startsWith('UklGR')
    ? 'image/webp'
    : (artifactPayload.mimeType || (data && data.mime) || 'image/png');
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

if (require.main === module) {
  if (process.stdin.isTTY && !process.env.ANTIFAN_MCP_BOOTSTRAP) {
    const candidates = resolveBridgeCandidates();
    if (candidates.length === 0) {
      process.stderr.write('MCP_BRIDGE_OFFLINE: AntiFan Desktop Bridge is not running.\n');
      process.exit(1);
    }
  }
  server.connect(new StdioServerTransport())
    .then(() => startHeartbeat(getBootstrap()))
    .catch((error) => {
      stopHeartbeat();
      process.stderr.write(`MCP_BRIDGE_OFFLINE: ${error}\n`);
      process.exit(1);
    });
}

module.exports = {
  resolveImageArtifactResponse,
  fetchArtifactBinary,
  definitions,
  CLIENT_TIMEOUT_MS,
  resolveClientTimeoutMs,
};

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
