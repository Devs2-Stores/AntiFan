/**
 * AntiFan Browser Desktop — Model Context Protocol (MCP) Stdio Server
 * Provides browser automation and inspection tools directly to AI Agents via standard stdio.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { NativeTabHost } from '../browser/native-tab-host';

export class AntiFanMcpServer {
  private server: Server;
  private tabHost: NativeTabHost;
  private isHighRiskAllowed: boolean;

  constructor(tabHost: NativeTabHost, isHighRiskAllowed = false) {
    this.tabHost = tabHost;
    this.isHighRiskAllowed = isHighRiskAllowed;

    this.server = new Server(
      {
        name: 'antifan-browser-desktop',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    const tools: Tool[] = [
      {
        name: 'antifan_open_tab',
        description: 'Open a new Chromium browser tab in AntiFan Desktop',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to navigate to' },
          },
        },
      },
      {
        name: 'antifan_list_tabs',
        description: 'List all open Chromium browser tabs with their IDs, titles, and URLs',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'antifan_switch_tab',
        description: 'Switch to an open tab by its ID',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'string', description: 'Tab ID' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'antifan_close_tab',
        description: 'Close an open tab by its ID',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'string', description: 'Tab ID' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'antifan_navigate',
        description: 'Navigate the current or specified tab to a URL',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Target URL' },
            tabId: { type: 'string', description: 'Optional Tab ID' },
          },
          required: ['url'],
        },
      },
      {
        name: 'antifan_reload',
        description: 'Reload the current or specified tab',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'string', description: 'Optional Tab ID' },
          },
        },
      },
      {
        name: 'antifan_get_dom',
        description: 'Extract the full HTML or a specific selector subtree from the active tab',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector (optional)' },
          },
        },
      },
      {
        name: 'antifan_screenshot',
        description: 'Capture a native GPU pixel-perfect screenshot of the active tab (returns base64 PNG)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'antifan_toggle_inspect',
        description: 'Toggle interactive element inspection mode in the active tab',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'antifan_agent_click',
        description: 'Agent Browser: Animate AI cursor, ripple pulse, and click element or (x, y) coordinates',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of element to click' },
            x: { type: 'number', description: 'Optional viewport X coordinate' },
            y: { type: 'number', description: 'Optional viewport Y coordinate' },
            label: { type: 'string', description: 'Human-readable action description banner' },
          },
        },
      },
      {
        name: 'antifan_agent_type',
        description: 'Agent Browser: Animate AI cursor, focus input, and type text with typing indicator',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of input/textarea to type into' },
            text: { type: 'string', description: 'Text string to type' },
            clear: { type: 'boolean', description: 'Whether to clear existing text before typing' },
          },
          required: ['selector', 'text'],
        },
      },
      {
        name: 'antifan_agent_scroll',
        description: 'Agent Browser: Scroll the page smoothly by deltaY pixels or to a specific element',
        inputSchema: {
          type: 'object',
          properties: {
            deltaY: { type: 'number', description: 'Pixels to scroll (positive = down, negative = up)' },
            selector: { type: 'string', description: 'Optional element selector to scroll into view' },
          },
        },
      },
      {
        name: 'antifan_agent_hover',
        description: 'Agent Browser: Animate AI cursor to hover over an element or coordinate',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of element to hover' },
            x: { type: 'number', description: 'Viewport X' },
            y: { type: 'number', description: 'Viewport Y' },
            label: { type: 'string', description: 'Hover badge label' },
          },
        },
      },
      {
        name: 'antifan_agent_highlight',
        description: 'Agent Browser: Visually highlight an element with a glowing neon border and title badge',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of element to highlight' },
            label: { type: 'string', description: 'Badge label text' },
          },
          required: ['selector'],
        },
      },
      {
        name: 'antifan_agent_clear',
        description: 'Agent Browser: Clear AI cursor, banners, and visual highlights from the webpage',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];

    if (this.isHighRiskAllowed) {
      tools.push({
        name: 'antifan_eval_js',
        description: 'Execute arbitrary JavaScript expression in the active tab (requires high-risk mode)',
        inputSchema: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'JavaScript code to execute' },
          },
          required: ['expression'],
        },
      });
    }

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      const a = args as Record<string, any>;

      try {
        switch (name) {
          case 'antifan_open_tab': {
            const tabId = this.tabHost.createTab(a.url);
            return { content: [{ type: 'text', text: JSON.stringify({ tabId, success: true }) }] };
          }

          case 'antifan_list_tabs': {
            const tabs = this.tabHost.getTabList();
            const activeTabId = this.tabHost.getActiveTabId();
            return { content: [{ type: 'text', text: JSON.stringify({ tabs, activeTabId }) }] };
          }

          case 'antifan_switch_tab': {
            const ok = this.tabHost.switchTab(a.tabId);
            return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
          }

          case 'antifan_close_tab': {
            const ok = this.tabHost.closeTab(a.tabId);
            return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
          }

          case 'antifan_navigate': {
            const ok = this.tabHost.navigate(a.tabId || this.tabHost.getActiveTabId(), a.url);
            return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
          }

          case 'antifan_reload': {
            const ok = this.tabHost.reload(a.tabId || this.tabHost.getActiveTabId());
            return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
          }

          case 'antifan_get_dom': {
            const html = await this.tabHost.getDom(a.selector);
            return { content: [{ type: 'text', text: html }] };
          }

          case 'antifan_screenshot': {
            const imageBase64 = await this.tabHost.captureScreenshot();
            return {
              content: [
                {
                  type: 'text',
                  text: `Captured ${imageBase64.length} base64 bytes PNG screenshot.`,
                },
                {
                  type: 'image',
                  data: imageBase64,
                  mimeType: 'image/png',
                },
              ],
            };
          }

          case 'antifan_toggle_inspect': {
            const inspecting = this.tabHost.toggleInspect();
            return { content: [{ type: 'text', text: JSON.stringify({ inspecting, success: true }) }] };
          }

          case 'antifan_agent_click': {
            const ok = await this.tabHost.agentClick({
              selector: a.selector,
              x: a.x,
              y: a.y,
              label: a.label,
              tabId: a.tabId,
            });
            return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
          }

          case 'antifan_agent_type': {
            const ok = await this.tabHost.agentType({
              selector: a.selector,
              text: a.text,
              clear: a.clear,
              tabId: a.tabId,
            });
            return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
          }

          case 'antifan_agent_scroll': {
            const ok = await this.tabHost.agentScroll({
              deltaY: a.deltaY,
              selector: a.selector,
              tabId: a.tabId,
            });
            return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
          }

          case 'antifan_agent_hover': {
            const ok = await this.tabHost.agentHover({
              selector: a.selector,
              x: a.x,
              y: a.y,
              label: a.label,
              tabId: a.tabId,
            });
            return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
          }

          case 'antifan_agent_highlight': {
            const ok = await this.tabHost.agentHighlight({
              selector: a.selector,
              label: a.label,
              tabId: a.tabId,
            });
            return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
          }

          case 'antifan_agent_clear': {
            const ok = await this.tabHost.agentClear(a.tabId);
            return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
          }

          case 'antifan_eval_js': {
            if (!this.isHighRiskAllowed) {
              return { isError: true, content: [{ type: 'text', text: 'High risk tool eval_js is disabled' }] };
            }
            const result = await this.tabHost.evalJs(a.expression);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }

          default:
            return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `Tool error: ${errorMsg}` }] };
      }
    });
  }

  public async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
