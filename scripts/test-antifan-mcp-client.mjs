import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const sessionData = JSON.parse(fs.readFileSync('.canary/state/canary-session.json', 'utf8'));

const bootstrapObj = {
  port: sessionData.port,
  secret: sessionData.secret,
  token: sessionData.secret,
  attachmentId: sessionData.attachmentId,
  authorityRevision: sessionData.authorityRevision,
  runId: sessionData.runId,
  attemptId: sessionData.attemptId,
  projectId: sessionData.projectId,
  workspaceId: sessionData.workspaceId,
  tabId: sessionData.tabId,
  ownerPid: sessionData.instancePid,
};

const env = {
  ...process.env,
  ANTIFAN_MCP_BOOTSTRAP: JSON.stringify(bootstrapObj),
  ANTIFAN_ATTACHMENT_ID: sessionData.attachmentId,
  ANTIFAN_ATTACHMENT_SECRET: sessionData.secret,
  ANTIFAN_AUTHORITY_REVISION: sessionData.authorityRevision,
  ANTIFAN_MCP_PORT: String(sessionData.port),
};

console.log('[MCP Client] Spawning node scripts/antifan-omp-mcp.cjs with live bootstrap...');
const mcpProc = spawn(process.execPath, ['scripts/antifan-omp-mcp.cjs'], {
  env,
  stdio: ['pipe', 'pipe', 'inherit'],
});

let msgId = 1;
const pending = new Map();

const rl = readline.createInterface({
  input: mcpProc.stdout,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const json = JSON.parse(trimmed);
    if (json.id && pending.has(json.id)) {
      const { resolve } = pending.get(json.id);
      pending.delete(json.id);
      resolve(json);
    } else {
      console.log('[MCP Notification/Log]:', json);
    }
  } catch (e) {
    console.log('[MCP Raw stdout]:', trimmed);
  }
});

function sendRequest(method, params) {
  const id = msgId++;
  const payload = {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    mcpProc.stdin.write(JSON.stringify(payload) + '\n');
  });
}

async function run() {
  console.log('[MCP Client] Initializing...');
  const initRes = await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'antifan-test-client', version: '1.0.0' },
  });
  console.log('[OK] Initialize result:', JSON.stringify(initRes).slice(0, 200));

  console.log('[MCP Client] Listing tools...');
  const listRes = await sendRequest('tools/list', {});
  const tools = listRes.result?.tools || [];
  console.log(`[OK] Discovered ${tools.length} AntiFan MCP tools!`);
  console.log('Sample tools:', tools.slice(0, 10).map(t => t.name));

  console.log('[MCP Client] Invoking anti.browser.tabs.list...');
  const tabsRes = await sendRequest('tools/call', {
    name: 'anti.browser.tabs.list',
    arguments: { all: true },
  });
  console.log('[OK] anti.browser.tabs.list result:', JSON.stringify(tabsRes).slice(0, 300));

  mcpProc.kill();
}

run().catch(err => {
  console.error('[FAIL]', err);
  mcpProc.kill();
  process.exit(1);
});
