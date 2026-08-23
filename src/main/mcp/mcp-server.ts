/**
 * AntiFan Browser Desktop — Model Context Protocol (MCP) Stdio Server
 * Provides browser automation and inspection tools directly to AI Agents via standard stdio.
 */
import { ChromeProfileSyncManager } from '../browser/chrome-profile-sync';
import { DEVICE_PRESETS } from '../browser/device-presets';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { NativeTabHost } from '../browser/native-tab-host';
import { CapabilityTransportAdapter } from '../tools/capability-transport';
import { CapabilityRequestContext } from '../../shared/control-plane-contracts';
import { envelope, requestId } from './result-envelope';

export class AntiFanMcpServer {
  private server: Server;
  private tabHost: NativeTabHost;
  private isHighRiskAllowed: boolean;
  private readonly transport?: CapabilityTransportAdapter;

  constructor(tabHost: NativeTabHost, isHighRiskAllowed = false, transport?: CapabilityTransportAdapter) {
    this.tabHost = tabHost;
    this.isHighRiskAllowed = isHighRiskAllowed;
    this.transport = transport;

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
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return this.listTools();
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.callTool(request.params.name, (request.params.arguments || {}) as Record<string, unknown>);
    });
  }

  public getStaticTools(): Tool[] {
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
        description: 'Extract the full HTML or a specific selector subtree from the active tab (or specified tabId)',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector (optional)' },
            tabId: { type: 'string', description: 'Optional tab ID. If specified, operates on this tab and switches to it.' },
          },
        },
      },
      {
        name: 'antifan_screenshot',
        description: 'Capture a native GPU pixel-perfect screenshot of the active tab (or specified tabId, returns base64 PNG)',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'string', description: 'Optional tab ID. If specified, operates on this tab and switches to it.' },
          },
        },
      },
      {
        name: 'antifan_toggle_inspect',
        description: 'Toggle interactive element inspection mode in the active tab (or specified tabId)',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'string', description: 'Optional tab ID' },
          },
        },
      },
      {
        name: 'antifan_agent_snapshot',
        description: 'Agent Browser: Capture interactive ARIA semantic snapshot with compact @e1, @e2 element references',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'string', description: 'Optional tab ID' },
          },
        },
      },
      {
        name: 'antifan_agent_click',
        description: 'Agent Browser: Animate AI cursor, ripple pulse, and click element, ref (@e1), or (x, y) coordinates (auto-switches to target tab)',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of element to click' },
            ref: { type: 'string', description: 'Interactive ARIA snapshot ref (e.g. @e1)' },
            x: { type: 'number', description: 'Optional viewport X coordinate' },
            y: { type: 'number', description: 'Optional viewport Y coordinate' },
            label: { type: 'string', description: 'Human-readable action description banner' },
            tabId: { type: 'string', description: 'Optional target tab ID. If specified, automatically activates and focuses this tab.' },
          },
        },
      },
      {
        name: 'antifan_agent_type',
        description: 'Agent Browser: Animate AI cursor, focus input, and type text with typing indicator (auto-switches to target tab)',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of input/textarea to type into' },
            ref: { type: 'string', description: 'Interactive ARIA snapshot ref (e.g. @e1)' },
            text: { type: 'string', description: 'Text string to type' },
            clear: { type: 'boolean', description: 'Whether to clear existing text before typing' },
            tabId: { type: 'string', description: 'Optional target tab ID. If specified, automatically activates and focuses this tab.' },
          },
          required: ['text'],
        },
      },
      {
        name: 'antifan_agent_scroll',
        description: 'Agent Browser: Scroll the page smoothly by deltaY pixels or to a specific element (auto-switches to target tab)',
        inputSchema: {
          type: 'object',
          properties: {
            deltaY: { type: 'number', description: 'Pixels to scroll (positive = down, negative = up)' },
            selector: { type: 'string', description: 'Optional element selector to scroll into view' },
            ref: { type: 'string', description: 'Optional interactive ARIA snapshot ref (e.g. @e1)' },
            tabId: { type: 'string', description: 'Optional target tab ID. If specified, automatically activates and focuses this tab.' },
          },
        },
      },
      {
        name: 'antifan_agent_hover',
        description: 'Agent Browser: Animate AI cursor to hover over an element, ref (@e1), or coordinate (auto-switches to target tab)',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of element to hover' },
            ref: { type: 'string', description: 'Interactive ARIA snapshot ref (e.g. @e1)' },
            x: { type: 'number', description: 'Viewport X' },
            y: { type: 'number', description: 'Viewport Y' },
            label: { type: 'string', description: 'Hover badge label' },
            tabId: { type: 'string', description: 'Optional target tab ID. If specified, automatically activates and focuses this tab.' },
          },
        },
      },
      {
        name: 'antifan_agent_highlight',
        description: 'Agent Browser: Visually highlight an element with a glowing neon border and title badge (auto-switches to target tab)',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of element to highlight' },
            ref: { type: 'string', description: 'Interactive ARIA snapshot ref (e.g. @e1)' },
            label: { type: 'string', description: 'Badge label text' },
            tabId: { type: 'string', description: 'Optional target tab ID. If specified, automatically activates and focuses this tab.' },
          },
        },
      },
      {
        name: 'antifan_agent_clear',
        description: 'Agent Browser: Clear AI cursor, banners, and visual highlights from the webpage',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'string', description: 'Optional target tab ID' },
          },
        },
      },
      {
        name: 'antifan_keyboard_press',
        description: 'Agent Browser: Send native keyboard key press (Enter, Escape, Tab, Backspace, Arrow keys, etc.) or combination (Ctrl+A) to the active tab',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Key name (e.g. "Enter", "Escape", "Tab", "Backspace", "ArrowDown", "a", "1")' },
            modifiers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional modifier keys: ["control", "shift", "alt", "meta"] (or shorthand: ["ctrl", "cmd"])',
            },
            tabId: { type: 'string', description: 'Optional target tab ID' },
          },
          required: ['key'],
        },
      },
      {
        name: 'antifan_agent_trajectory',
        description: 'Agent Browser: Execute continuous multi-step cubic Bézier cursor trajectory & actions with in-page micro-jitter (auto-switches to target tab)',
        inputSchema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              description: 'Sequential steps for cursor movement, clicks, typing, scrolling, or hovering',
              items: {
                type: 'object',
                properties: {
                  target: { type: 'string', description: 'CSS selector target' },
                  selector: { type: 'string', description: 'Alternative selector field' },
                  x: { type: 'number', description: 'Viewport X' },
                  y: { type: 'number', description: 'Viewport Y' },
                  action: { type: 'string', enum: ['move', 'hover', 'click', 'type', 'scroll', 'wait'], description: 'Action type' },
                  text: { type: 'string', description: 'Text to type for action=type' },
                  deltaY: { type: 'number', description: 'Scroll delta for action=scroll' },
                  dwellMs: { type: 'number', description: 'Dwell time in milliseconds' },
                  label: { type: 'string', description: 'Action badge label' },
                  isCritical: { type: 'boolean', description: 'Whether failure halts trajectory' },
                },
              },
            },
            speed: { type: 'string', enum: ['fast', 'natural', 'slow'], description: 'Movement speed profile' },
            smoothScroll: { type: 'boolean', description: 'Whether to use smooth scrolling' },
            tabId: { type: 'string', description: 'Optional target tab ID. If specified, automatically activates and focuses this tab.' },
          },
          required: ['steps'],
        },
      },
      {
        name: 'antifan_console_messages',
        description: 'List captured Chromium console messages for a tab',
        inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, level: { type: 'number' } } },
      },
      {
        name: 'antifan_network_failures',
        description: 'List captured main-frame load failures for a tab',
        inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
      },
      {
        name: 'antifan_responsive_check',
        description: 'Scan the current tab for horizontal overflow and offending elements',
        inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
      },
      {
        name: 'antifan_set_viewport',
        description: 'Set browser responsive viewport dimensions (Playwright setViewportSize parity) with width, height, and mobile emulation',
        inputSchema: {
          type: 'object',
          properties: {
            width: { type: 'number', description: 'Viewport width in pixels (e.g. 375, 412, 768, 1440, 1920)' },
            height: { type: 'number', description: 'Viewport height in pixels (e.g. 667, 844, 915, 1024, 1080)' },
            mobile: { type: 'boolean', description: 'Enable mobile touch emulation and viewport meta tags' },
            deviceScaleFactor: { type: 'number', description: 'Device pixel ratio (e.g. 2 for Retina/OLED, 1 for Standard)' },
            tabId: { type: 'string', description: 'Optional target tab ID (defaults to active tab)' },
          },
          required: ['width', 'height'],
        },
      },
      {
        name: 'antifan_set_device_preset',
        description: 'Emulate a real device preset (iPhone, iPad, Galaxy, Pixel, MacBook, 4K, Desktop) on the active tab',
        inputSchema: {
          type: 'object',
          properties: {
            presetId: {
              type: 'string',
              description: 'Preset ID: e.g. "iphone-16-pro", "iphone-16-promax", "iphone-se", "galaxy-s24-ultra", "pixel-9-pro", "ipad-pro-12", "ipad-air-11", "desktop-fhd", "laptop-mac", "responsive"',
            },
            tabId: { type: 'string', description: 'Optional target tab ID' },
          },
          required: ['presetId'],
        },
      },
      {
        name: 'antifan_list_device_presets',
        description: 'List all available responsive device presets with their resolutions and categories',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'antifan_set_zoom',
        description: 'Set zoom factor for a Chromium tab (between 0.25 and 5.0)',
        inputSchema: {
          type: 'object',
          properties: {
            zoomFactor: { type: 'number', minimum: 0.25, maximum: 5.0, description: 'Zoom factor between 0.25 (25%) and 5.0 (500%)' },
            tabId: { type: 'string', description: 'Optional target tab ID' },
          },
          required: ['zoomFactor'],
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
            tabId: { type: 'string', description: 'Optional tab ID to execute within' },
          },
          required: ['expression'],
        },
      });
    }
    return tools;
  }

  public async listTools(): Promise<{ tools: Tool[] }> {
    return { tools: buildMcpToolList(this.getStaticTools(), this.transport, this.isHighRiskAllowed) };
  }

  public async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> {
    const aliasMap: Record<string, string> = {
      'anti.browser.tabs.create': 'antifan_open_tab',
      'anti.browser.tabs.list': 'antifan_list_tabs',
      'anti.browser.tabs.activate': 'antifan_switch_tab',
      'anti.browser.tabs.close': 'antifan_close_tab',
      'anti.browser.navigate': 'antifan_navigate',
      'anti.browser.reload': 'antifan_reload',
      'anti.inspect.dom': 'antifan_get_dom',
      'anti.screenshot.viewport': 'antifan_screenshot',
      'anti.browser.click': 'antifan_agent_click',
      'anti.browser.type': 'antifan_agent_type',
      'anti.browser.scroll': 'antifan_agent_scroll',
      'anti.browser.hover': 'antifan_agent_hover',
      'anti.browser.highlight': 'antifan_agent_highlight',
      'anti.browser.clear': 'antifan_agent_clear',
      'anti.agent.cursor.click': 'antifan_agent_click',
      'anti.agent.cursor.type': 'antifan_agent_type',
      'anti.agent.cursor.scroll': 'antifan_agent_scroll',
      'anti.agent.cursor.hover': 'antifan_agent_hover',
      'anti.agent.cursor.highlight': 'antifan_agent_highlight',
      'anti.agent.cursor.clear': 'antifan_agent_clear',
      'anti.agent.cursor.move': 'antifan_agent_hover',
      'anti.agent.cursor.trajectory': 'antifan_agent_trajectory',
      'anti.browser.trajectory': 'antifan_agent_trajectory',
      'anti.browser.viewport.set': 'antifan_set_viewport',
      'anti.browser.set_device': 'antifan_set_device_preset',
      'anti.browser.viewport.set_preset': 'antifan_set_device_preset',
      'anti.browser.viewport.list_presets': 'antifan_list_device_presets',
      'anti.devtools.console.list': 'antifan_console_messages',
      'anti.devtools.console.errors': 'antifan_console_messages',
      'anti.devtools.console.warnings': 'antifan_console_messages',
      'anti.browser.eval': 'antifan_eval_js',
      'anti.agent.eval': 'antifan_eval_js',
      'anti.browser.set_zoom': 'antifan_set_zoom',
      'anti.browser.zoom.set': 'antifan_set_zoom',
    };
    const name = aliasMap[toolName] || toolName;
    const a = (args || {}) as Record<string, any>;
    if (!a.tabId && a.id) a.tabId = a.id;
    if (toolName === 'anti.devtools.console.errors') a.level = 3;
    if (toolName === 'anti.devtools.console.warnings') a.level = 2;
    const rid = requestId(a.requestId);
    const evidence = () => { const tab = a.tabId ? this.tabHost.getTabList().find((item) => item.id === a.tabId) : this.tabHost.getActiveTab(); return { tabId: tab?.id, url: tab?.url, title: tab?.title, themeError: tab?.themeError || null }; };
    const resultText = (data: unknown) => JSON.stringify({ ...envelope(data, { ...evidence(), timestamp: Date.now() }), requestId: rid });
    const requireTab = () => { if (a.tabId && !this.tabHost.getTabList().some((item) => item.id === a.tabId)) throw new Error(`Unknown tabId: ${a.tabId}`); };
      try {
        if (this.transport && typeof a.runtimeLease === 'object' && typeof a.projectId === 'string' && typeof a.workspaceId === 'string') {
          const context = a.context as Partial<CapabilityRequestContext> | undefined;
          const result = await this.transport.dispatch(name, a, {
            lease: a.runtimeLease,
            leaseToken: typeof a.leaseToken === 'string' ? a.leaseToken : '',
            projectId: a.projectId,
            workspaceId: a.workspaceId,
            runId: context?.runId,
            attemptId: context?.attemptId,
            browserTarget: context?.browserTarget,
            grant: context?.grant,
          });
          return result.ok ? { content: [{ type: 'text', text: JSON.stringify(result.data) }] } : { isError: true, content: [{ type: 'text', text: JSON.stringify(result.error) }] };
        }
        switch (name) {
          case 'antifan_console_messages': {
            requireTab();
            const result = this.tabHost.getDiagnostics(a.tabId, a.level);
            return { content: [{ type: 'text', text: resultText(result.console) }] };
          }
          case 'antifan_network_failures': {
            requireTab();
            const result = this.tabHost.getDiagnostics(a.tabId);
            return { content: [{ type: 'text', text: resultText(result.failures) }] };
          }
          case 'antifan_responsive_check': {
            requireTab();
            const result = await this.tabHost.runResponsiveCheck(a.tabId);
            return { content: [{ type: 'text', text: resultText(result) }] };
          }
          case 'antifan_open_tab': {
            const tabId = this.tabHost.createTab(a.url);
            return { content: [{ type: 'text', text: resultText({ tabId, success: true }) }] };
          }

          case 'antifan_list_tabs': {
            const tabs = this.tabHost.getTabList();
            const activeTabId = this.tabHost.getActiveTabId();
            return { content: [{ type: 'text', text: resultText({ tabs, activeTabId }) }] };
          }

          case 'antifan_switch_tab': {
            requireTab();
            const ok = this.tabHost.switchTab(a.tabId);
            return { content: [{ type: 'text', text: resultText({ success: ok }) }] };
          }

          case 'antifan_close_tab': {
            requireTab();
            const ok = this.tabHost.closeTab(a.tabId);
            return { content: [{ type: 'text', text: resultText({ success: ok }) }] };
          }

          case 'antifan_navigate': {
            requireTab();
            const ok = this.tabHost.navigate(a.tabId || this.tabHost.getActiveTabId(), a.url);
            const tab = a.tabId ? this.tabHost.getTabList().find((item) => item.id === a.tabId) : this.tabHost.getActiveTab();
            return { content: [{ type: 'text', text: resultText({ success: ok, themeError: tab?.themeError || null }) }] };
          }

          case 'antifan_reload': {
            requireTab();
            const ok = this.tabHost.reload(a.tabId || this.tabHost.getActiveTabId());
            const tab = a.tabId ? this.tabHost.getTabList().find((item) => item.id === a.tabId) : this.tabHost.getActiveTab();
            return { content: [{ type: 'text', text: resultText({ success: ok, themeError: tab?.themeError || null }) }] };
          }

          case 'antifan_get_dom': {
            requireTab();
            const html = await this.tabHost.getDom(a.selector, a.tabId);
            const tab = a.tabId ? this.tabHost.getTabList().find((item) => item.id === a.tabId) : this.tabHost.getActiveTab();
            return { content: [{ type: 'text', text: resultText({ html, themeError: tab?.themeError || null }) }] };
          }

          case 'antifan_screenshot': {
            requireTab();
            const imageBase64 = await this.tabHost.captureScreenshot(undefined, a.tabId);
            return {
              content: [
                {
                  type: 'text',
                  text: resultText({ bytes: imageBase64.length, mimeType: 'image/png' }),
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

          case 'antifan_agent_snapshot': {
            requireTab();
            const snapshot = await this.tabHost.agentSnapshot(a.tabId);
            return { content: [{ type: 'text', text: snapshot }] };
          }

          case 'antifan_agent_click': {
            requireTab();
            const targetSelector = a.ref || a.selector;
            if (!targetSelector && (a.x === undefined || a.y === undefined)) {
              return { isError: true, content: [{ type: 'text', text: 'Missing selector, ref, or (x, y) coordinates' }] };
            }
            const ok = await this.tabHost.agentClick({
              selector: targetSelector,
              x: a.x,
              y: a.y,
              label: a.label,
              tabId: a.tabId,
            });
            return { content: [{ type: 'text', text: resultText({ success: ok }) }] };
          }

          case 'antifan_agent_type': {
            requireTab();
            const targetSelector = a.ref || a.selector;
            if (!targetSelector) {
              return { isError: true, content: [{ type: 'text', text: 'Missing selector or ref' }] };
            }
            if (typeof a.text !== 'string') {
              return { isError: true, content: [{ type: 'text', text: 'Missing or invalid text to type' }] };
            }
            const ok = await this.tabHost.agentType({
              selector: targetSelector,
              text: a.text,
              clear: a.clear,
              tabId: a.tabId,
            });
            return { content: [{ type: 'text', text: resultText({ success: ok }) }] };
          }
          case 'antifan_keyboard_press': {
            requireTab();
            if (typeof a.key !== 'string' || a.key.trim().length === 0) {
              return { isError: true, content: [{ type: 'text', text: 'Missing or invalid key' }] };
            }
            try {
              const result = await this.tabHost.sendKeyboardPress({
                key: a.key,
                modifiers: a.modifiers,
                tabId: a.tabId,
              });
              return { content: [{ type: 'text', text: resultText(result) }] };
            } catch (err: any) {
              return { isError: true, content: [{ type: 'text', text: err?.message || String(err) }] };
            }
          }

          case 'antifan_agent_scroll': {
            requireTab();
            const targetSelector = a.ref || a.selector;
            if (a.deltaY === undefined && !targetSelector) {
              return { isError: true, content: [{ type: 'text', text: 'Missing deltaY or selector/ref to scroll' }] };
            }
            const ok = await this.tabHost.agentScroll({
              deltaY: a.deltaY,
              selector: targetSelector,
              tabId: a.tabId,
            });
            return { content: [{ type: 'text', text: resultText({ success: ok }) }] };
          }
          case 'antifan_agent_trajectory': {
            requireTab();
            if (!Array.isArray(a.steps) || a.steps.length === 0) {
              return { isError: true, content: [{ type: 'text', text: 'Missing or empty steps array' }] };
            }
            const result = await this.tabHost.agentTrajectory({
              steps: a.steps,
              speed: a.speed,
              smoothScroll: a.smoothScroll,
              tabId: a.tabId,
            });
            return { content: [{ type: 'text', text: resultText(result) }] };
          }


          case 'antifan_agent_hover': {
            requireTab();
            const targetSelector = a.ref || a.selector;
            if (!targetSelector && (a.x === undefined || a.y === undefined)) {
              return { isError: true, content: [{ type: 'text', text: 'Missing selector, ref, or (x, y) coordinates' }] };
            }
            const ok = await this.tabHost.agentHover({
              selector: targetSelector,
              x: a.x,
              y: a.y,
              label: a.label,
              tabId: a.tabId,
            });
            return { content: [{ type: 'text', text: resultText({ success: ok }) }] };
          }

          case 'antifan_agent_highlight': {
            requireTab();
            const targetSelector = a.ref || a.selector;
            if (!targetSelector) {
              return { isError: true, content: [{ type: 'text', text: 'Missing selector or ref' }] };
            }
            const ok = await this.tabHost.agentHighlight({
              selector: targetSelector,
              label: a.label,
              tabId: a.tabId,
            });
            return { content: [{ type: 'text', text: resultText({ success: ok }) }] };
          }

          case 'antifan_get_chrome_profiles': {
            const profiles = ChromeProfileSyncManager.getInstance().getAvailableProfiles();
            return { content: [{ type: 'text', text: JSON.stringify({ profiles }) }] };
          }

          case 'antifan_sync_chrome_profile': {
            const profileId = a.profileId || 'Default';
            const result = await ChromeProfileSyncManager.getInstance().syncProfile(profileId);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }

          case 'antifan_agent_clear': {
            const ok = await this.tabHost.agentClear(a.tabId);
            return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
          }
          case 'antifan_set_viewport': {
            requireTab();
            const ok = this.tabHost.setViewportSize({
              width: Number(a.width),
              height: Number(a.height),
              mobile: a.mobile,
              deviceScaleFactor: a.deviceScaleFactor,
              tabId: a.tabId,
            });
            return { content: [{ type: 'text', text: resultText({ success: ok, width: a.width, height: a.height, mobile: a.mobile ?? (a.width < 600) }) }] };
          }

          case 'antifan_set_device_preset': {
            requireTab();
            const tabId = a.tabId || this.tabHost.getActiveTabId();
            const ok = this.tabHost.setDevicePreset(tabId, a.presetId);
            return { content: [{ type: 'text', text: resultText({ success: ok, presetId: a.presetId }) }] };
          }

          case 'antifan_list_device_presets': {
            const presets = this.tabHost.getDevicePresets ? this.tabHost.getDevicePresets() : DEVICE_PRESETS;
            return { content: [{ type: 'text', text: JSON.stringify({ presets }) }] };
          }
          case 'antifan_set_zoom': {
            requireTab();
            const tabId = a.tabId || this.tabHost.getActiveTabId();
            const rawZoom = a.zoomFactor !== undefined ? a.zoomFactor : a.zoom;
            if (rawZoom === undefined || rawZoom === null) {
              return { isError: true, content: [{ type: 'text', text: 'zoomFactor is required' }] };
            }
            const zoomVal = typeof rawZoom === 'number' ? rawZoom : Number(rawZoom);
            if (!Number.isFinite(zoomVal) || zoomVal < 0.25 || zoomVal > 5.0) {
              return { isError: true, content: [{ type: 'text', text: 'zoomFactor must be a number between 0.25 and 5.0' }] };
            }
            const ok = this.tabHost.setZoom ? this.tabHost.setZoom(tabId, zoomVal) : false;
            return { content: [{ type: 'text', text: resultText({ success: ok, zoomFactor: zoomVal }) }] };
          }

          case 'antifan_eval_js': {
            if (!this.isHighRiskAllowed) {
              return { isError: true, content: [{ type: 'text', text: 'High risk tool eval_js is disabled' }] };
            }
            requireTab();
            const result = await this.tabHost.evalJs(a.expression, a.tabId);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          }

          default:
            return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `Tool error: ${errorMsg}` }] };
      }
  }

  public async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  public async stop(): Promise<void> {
    try {
      await this.server.close();
    } catch {}
  }
}
export function buildMcpToolList(staticTools: Tool[], transport?: CapabilityTransportAdapter, isHighRiskAllowed = false): Tool[] {
  let listed: Tool[] = [];
  if (transport) {
    const grants: Array<'read' | 'write' | 'eval'> = ['read', 'write'];
    if (isHighRiskAllowed) grants.push('eval');
    const toolMap = new Map<string, Tool>();
    for (const grant of grants) {
      for (const item of transport.list({ grant })) {
        if (!toolMap.has(item.name)) {
          toolMap.set(item.name, {
            name: item.name,
            description: item.description,
            inputSchema: item.inputSchema as Tool['inputSchema'],
          });
        }
      }
    }
    listed = Array.from(toolMap.values());
  } else {
    listed = staticTools;
  }
  const aliases = listed.filter((item) => item.name.startsWith('antifan_')).flatMap((item) => {
    const generated: Tool[] = [];
    if (item.name === 'antifan_open_tab') generated.push({ ...item, name: 'anti.browser.tabs.create' });
    if (item.name === 'antifan_list_tabs') generated.push({ ...item, name: 'anti.browser.tabs.list' });
    if (item.name === 'antifan_switch_tab') generated.push({ ...item, name: 'anti.browser.tabs.activate' });
    if (item.name === 'antifan_close_tab') generated.push({ ...item, name: 'anti.browser.tabs.close' });
    if (item.name === 'antifan_navigate') generated.push({ ...item, name: 'anti.browser.navigate' });
    if (item.name === 'antifan_reload') generated.push({ ...item, name: 'anti.browser.reload' });
    if (item.name === 'antifan_get_dom') generated.push({ ...item, name: 'anti.inspect.dom' });
    if (item.name === 'antifan_screenshot') generated.push({ ...item, name: 'anti.screenshot.viewport' });
    if (item.name === 'antifan_agent_click') generated.push({ ...item, name: 'anti.browser.click' }, { ...item, name: 'anti.agent.cursor.click' });
    if (item.name === 'antifan_agent_type') generated.push({ ...item, name: 'anti.browser.type' }, { ...item, name: 'anti.agent.cursor.type' });
    if (item.name === 'antifan_agent_scroll') generated.push({ ...item, name: 'anti.browser.scroll' }, { ...item, name: 'anti.agent.cursor.scroll' });
    if (item.name === 'antifan_agent_hover') generated.push({ ...item, name: 'anti.browser.hover' }, { ...item, name: 'anti.agent.cursor.hover' }, { ...item, name: 'anti.agent.cursor.move' });
    if (item.name === 'antifan_agent_highlight') generated.push({ ...item, name: 'anti.browser.highlight' }, { ...item, name: 'anti.agent.cursor.highlight' });
    if (item.name === 'antifan_agent_clear') generated.push({ ...item, name: 'anti.browser.clear' }, { ...item, name: 'anti.agent.cursor.clear' });
    if (item.name === 'antifan_agent_trajectory') generated.push({ ...item, name: 'anti.browser.trajectory' }, { ...item, name: 'anti.agent.cursor.trajectory' });
    if (item.name === 'antifan_set_viewport') generated.push({ ...item, name: 'anti.browser.viewport.set' });
    if (item.name === 'antifan_set_device_preset') generated.push({ ...item, name: 'anti.browser.set_device' }, { ...item, name: 'anti.browser.viewport.set_preset' });
    if (item.name === 'antifan_list_device_presets') generated.push({ ...item, name: 'anti.browser.viewport.list_presets' });
    if (item.name === 'antifan_set_zoom') generated.push({ ...item, name: 'anti.browser.set_zoom' }, { ...item, name: 'anti.browser.zoom.set' });
    return generated;
  });
  const diagnosticAliases = listed.some((item) => item.name === 'antifan_console_messages')
    ? [
        { ...listed.find((item) => item.name === 'antifan_console_messages')!, name: 'anti.devtools.console.errors' },
        { ...listed.find((item) => item.name === 'antifan_console_messages')!, name: 'anti.devtools.console.warnings' },
      ]
    : [];
  return [...listed, ...aliases, ...diagnosticAliases];
}
