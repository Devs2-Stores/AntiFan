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
    }
  } catch (e) {}
});

function sendRequest(method, params) {
  const id = msgId++;
  const payload = { jsonrpc: '2.0', id, method, params };
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    mcpProc.stdin.write(JSON.stringify(payload) + '\n');
  });
}

async function main() {
  await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'antifan-capability-mapper', version: '1.0.0' },
  });

  const listRes = await sendRequest('tools/list', {});
  const tools = listRes.result?.tools || [];

  mcpProc.kill();

  const categories = {
    browser: [],
    inspect: [],
    capture: [],
    theme: [],
    verification: [],
    agent_cursor: [],
    artifact: [],
    other: [],
  };

  for (const tool of tools) {
    let cat = 'other';
    if (tool.name.startsWith('anti.browser.') || tool.name.startsWith('browser.')) cat = 'browser';
    else if (tool.name.startsWith('anti.inspect.')) cat = 'inspect';
    else if (tool.name.startsWith('anti.screenshot.') || tool.name.startsWith('anti.reference.') || tool.name.startsWith('anti.visual.')) cat = 'capture';
    else if (tool.name.startsWith('theme.') || tool.name.startsWith('anti.theme.') || tool.name.startsWith('storefront.')) cat = 'theme';
    else if (tool.name.startsWith('anti.verification.') || tool.name === 'anti.spec.validate_gate') cat = 'verification';
    else if (tool.name.startsWith('anti.agent.')) cat = 'agent_cursor';
    else if (tool.name.startsWith('anti.artifact.') || tool.name.startsWith('file.')) cat = 'artifact';

    categories[cat].push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      category: cat,
    });
  }

  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/antifan-mcp-capability-map.json', JSON.stringify({
    totalTools: tools.length,
    categories,
    tools,
  }, null, 2));

  let md = `# AntiFan MCP Capability Map (Audit §2, Mandate v2.0)\n\n`;
  md += `Total Registered Tools: **${tools.length}**\n\n`;

  for (const [catName, catTools] of Object.entries(categories)) {
    md += `## ${catName.toUpperCase()} (${catTools.length} tools)\n\n`;
    md += `| Tool Name | Purpose | When to Use |\n`;
    md += `|-----------|---------|-------------|\n`;
    for (const t of catTools) {
      const desc = (t.description || '').replace(/\n/g, ' ').slice(0, 120);
      md += `| \`${t.name}\` | ${desc} | Mandatory AntiFan MCP path |\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync('reports/antifan-mcp-capability-map.md', md);
  console.log(`[OK] Generated capability map: ${tools.length} tools categorized.`);
}

main().catch(console.error);
