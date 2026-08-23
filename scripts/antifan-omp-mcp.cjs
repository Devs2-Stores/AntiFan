const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const definitions = [
  ['anti.browser.tabs.list', 'List tabs open in AntiFan', {}],
  ['anti.browser.tabs.create', 'Open a new AntiFan browser tab', { url: { type: 'string' } }, ['url']],
  ['anti.browser.navigate', 'Navigate the bound AntiFan tab', { url: { type: 'string' } }, ['url']],
  ['anti.browser.reload', 'Reload the bound AntiFan tab', {}],
  ['anti.inspect.dom', 'Read DOM from the bound AntiFan tab', { selector: { type: 'string' } }],
  ['anti.screenshot.viewport', 'Capture the bound AntiFan tab', {}],
  ['anti.agent.cursor.click', 'Move the Agent Cursor and click an element', { selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }],
  ['anti.agent.cursor.move', 'Move the visible Agent Cursor without clicking', { selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }],
  ['anti.agent.cursor.type', 'Move the Agent Cursor and type into an element', { selector: { type: 'string' }, text: { type: 'string' } }, ['selector', 'text']],
  ['anti.agent.cursor.scroll', 'Scroll using the Agent Cursor', { selector: { type: 'string' }, deltaY: { type: 'number' } }],
  ['anti.agent.cursor.hover', 'Move the Agent Cursor to hover an element', { selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }],
  ['anti.agent.cursor.highlight', 'Highlight an element with the Agent Cursor', { selector: { type: 'string' } }, ['selector']],
  ['anti.agent.cursor.clear', 'Clear Agent Cursor overlays', {}],
];

function readBridge() {
  const root = path.join(os.homedir(), '.antifan');
  for (const name of ['bridge-dev.json', 'bridge.json']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  throw new Error('AntiFan is not running');
}

async function invoke(method, params = {}) {
  const info = readBridge();
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}?token=${encodeURIComponent(info.token)}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AntiFan Bridge connection timed out')), 3000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  const call = (id, rpcMethod, rpcParams) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`AntiFan RPC timed out: ${rpcMethod}`)), 15000);
    const handler = (raw) => {
      const response = JSON.parse(raw.toString());
      if (response.id !== id) return;
      clearTimeout(timer);
      ws.off('message', handler);
      response.success ? resolve(response.data) : reject(new Error(response.error || `AntiFan RPC failed: ${rpcMethod}`));
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method: rpcMethod, params: rpcParams }));
  });
  try {
    const binding = await call('binding', 'antifan.getRuntimeBinding', {});
    if (method === 'anti.browser.tabs.create') return await call('openTab', 'openTab', params);
    const mapped = {
      'anti.browser.tabs.list': 'browser.list-tabs',
      'anti.browser.navigate': 'browser.navigate',
      'anti.browser.reload': 'browser.reload',
      'anti.inspect.dom': 'browser.dom',
      'anti.screenshot.viewport': 'browser.screenshot',
    }[method];
    const legacy = {
      'anti.agent.cursor.click': 'antifan.agentClick',
      'anti.agent.cursor.move': 'antifan.agentMove',
      'anti.agent.cursor.type': 'antifan.agentType',
      'anti.agent.cursor.scroll': 'antifan.agentScroll',
      'anti.agent.cursor.hover': 'antifan.agentHover',
      'anti.agent.cursor.highlight': 'antifan.agentHighlight',
      'anti.agent.cursor.clear': 'antifan.agentClear',
    }[method];
    if (legacy) return await call('agent', legacy, { ...params, tabId: binding.browserTarget && binding.browserTarget.tabId });
    return await call('tool', mapped, {
      ...params,
      runtimeLease: binding.lease,
      leaseToken: binding.lease.token,
      projectId: binding.projectId,
      workspaceId: binding.workspaceId,
      context: { browserTarget: binding.browserTarget, grant: mapped === 'browser.navigate' || mapped === 'browser.reload' ? 'write' : 'read' },
    });
  } finally {
    ws.close();
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
