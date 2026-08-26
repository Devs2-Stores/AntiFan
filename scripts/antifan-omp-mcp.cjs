const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const definitions = [
  ['anti.browser.tabs.list', 'List tabs open in AntiFan', {}],
  ['anti.browser.tabs.create', 'Open a new AntiFan browser tab', { url: { type: 'string' } }, ['url']],
  ['anti.browser.navigate', 'Navigate the bound AntiFan tab', { url: { type: 'string' } }, ['url']],
  ['anti.browser.reload', 'Reload the bound AntiFan tab', {}],
  ['anti.inspect.dom', 'Read DOM from the bound AntiFan tab', { selector: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.screenshot.viewport', 'Capture the bound AntiFan tab', { paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.click', 'Move the Agent Cursor and click an element', { selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.move', 'Move the visible Agent Cursor without clicking', { selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.type', 'Move the Agent Cursor and type into an element', { selector: { type: 'string' }, text: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['selector', 'text']],
  ['anti.agent.cursor.scroll', 'Scroll using the Agent Cursor', { selector: { type: 'string' }, deltaY: { type: 'number' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.hover', 'Move the Agent Cursor to hover an element', { selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
  ['anti.agent.cursor.highlight', 'Highlight an element with the Agent Cursor', { selector: { type: 'string' }, paneId: { type: 'string', enum: ['desktop', 'mobile'] } }, ['selector']],
  ['anti.agent.cursor.clear', 'Clear Agent Cursor overlays', { paneId: { type: 'string', enum: ['desktop', 'mobile'] } }],
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
      'anti.agent.cursor.click': 'anti.agent.cursor.click',
      'anti.agent.cursor.move': 'anti.agent.cursor.move',
      'anti.agent.cursor.type': 'anti.agent.cursor.type',
      'anti.agent.cursor.scroll': 'anti.agent.cursor.scroll',
      'anti.agent.cursor.hover': 'anti.agent.cursor.hover',
      'anti.agent.cursor.highlight': 'anti.agent.cursor.highlight',
      'anti.agent.cursor.clear': 'anti.agent.cursor.clear',
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
server.connect(new StdioServerTransport()).catch((error) => { process.stderr.write(`${error}\n`); process.exitCode = 1; });
