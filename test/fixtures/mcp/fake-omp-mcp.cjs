#!/usr/bin/env node
/**
 * Stdio JSON-RPC double for `AntiFanMcpClient` unit tests.
 *
 * The client spawns its MCP server as a child process, so the only way to exercise its
 * request/response handling without a live AntiFan Desktop attachment is to hand it a server
 * double. This answers the three calls the client makes (`initialize`, `tools/list`,
 * `tools/call`) and returns an `isError` result for `anti.browser.fail`, which is how the real
 * server reports a failed capability dispatch.
 */
const readline = require('node:readline');

const TOOL_NAMES = [
  'anti.browser.tabs.list',
  'anti.browser.navigate',
  'anti.browser.reload',
  'anti.inspect.dom',
  'anti.inspect.snapshot',
  'anti.screenshot.full_page',
  'anti.screenshot.viewport',
  'anti.agent.cursor.click',
  'anti.agent.cursor.type',
  'anti.agent.cursor.move',
  'anti.agent.cursor.hover',
  'anti.agent.cursor.scroll',
  'anti.agent.cursor.drag',
  'anti.agent.sequence',
  'anti.media.freeze',
  'anti.visual.compare',
  'anti.verification.record_claim',
  'anti.verification.verify_claim',
  'anti.artifact.read',
  'anti.artifact.stat',
  'theme.qa_validate',
  'theme.resolve_product',
  'theme.debug_bundle',
  'theme.style_override',
  'theme.assert_cart',
  'browser_press_key',
  'browser_find',
  'file.read',
  'file.write',
  'storefront.resolve_product',
  'anti.browser.tabs.create',
  'anti.browser.tabs.activate',
  'anti.browser.tabs.close',
  'anti.browser.rebind_target',
  'anti.browser.set_automation_target',
  'anti.browser.set_viewport',
  'anti.browser.get_viewport',
  'anti.browser.dump_dom',
  'anti.browser.evaluate',
  'anti.browser.evaluate_frame',
  'anti.agent.cursor.highlight',
  'anti.agent.cursor.clear',
  'anti.agent.file_upload',
  'anti.agent.drop',
  'anti.inspect.styles',
  'anti.inspect.region',
  'anti.inspect.page_inventory',
  'anti.inspect.style_diff',
  'anti.inspect.matched_styles',
  'anti.inspect.responsive_matrix',
  'anti.reference.capture',
  'anti.spec.validate_gate',
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (request.method === 'initialize') {
    reply(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-omp-mcp', version: '0.0.0-fixture' },
    });
    return;
  }

  if (request.method === 'tools/list') {
    reply(request.id, { tools: TOOL_NAMES.map((name) => ({ name, description: 'fixture', inputSchema: { type: 'object' } })) });
    return;
  }

  if (request.method === 'tools/call') {
    const name = request.params?.name;
    if (name === 'anti.browser.tabs.list') {
      reply(request.id, {
        content: [{ type: 'text', text: JSON.stringify([{ id: 'tab-1', url: 'https://example.test/' }, { id: 'tab-2', url: 'https://example.test/two' }]) }],
      });
      return;
    }
    if (name === 'anti.browser.fail') {
      reply(request.id, {
        isError: true,
        content: [{ type: 'text', text: 'REVISION_STALE: Authority revision is inactive for new execution' }],
      });
      return;
    }
    reply(request.id, { isError: true, content: [{ type: 'text', text: `UNKNOWN_TOOL: ${name}` }] });
    return;
  }

  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } })}\n`
  );
});
