/**
 * AntiFan Browser Desktop — Unified Browser Action Registry (Extensibility Phase 1)
 * Central dispatch router for all Browser Actions invoked via MCP Stdio, WebSocket RPC, or Plugins.
 */
import { NativeTabHost } from './native-tab-host';
import { AntiFanBridgeStatus, ChatMessage } from '../../shared/contracts';

export interface ActionDefinition<TParams = Record<string, any>, TResult = any> {
  name: string;
  mcpName?: string;
  aliases?: string[];
  description: string;
  isHighRisk?: boolean;
  inputSchema?: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  handler: (params: TParams, context: { tabHost: NativeTabHost }) => Promise<TResult> | TResult;
}

export class BrowserActionRegistry {
  private actions: Map<string, ActionDefinition<any, any>> = new Map();
  private tabHost: NativeTabHost;

  constructor(tabHost: NativeTabHost) {
    this.tabHost = tabHost;
    this.registerCoreActions();
  }

  public registerAction<TParams = Record<string, any>, TResult = any>(action: ActionDefinition<TParams, TResult>): void {
    this.actions.set(action.name, action);
    if (action.mcpName) {
      this.actions.set(action.mcpName, action);
    }
    if (Array.isArray(action.aliases)) {
      for (const alias of action.aliases) {
        this.actions.set(alias, action);
      }
    }
  }

  public getAction(name: string): ActionDefinition | undefined {
    return this.actions.get(name);
  }

  public listMcpTools(includeHighRisk = false): Array<{ name: string; description: string; inputSchema: any }> {
    const seen = new Set<string>();
    const tools: Array<{ name: string; description: string; inputSchema: any }> = [];

    for (const action of this.actions.values()) {
      const toolName = action.mcpName || `antifan_${action.name.replace(/([A-Z])/g, '_$1').toLowerCase()}`;
      if (seen.has(toolName)) continue;
      seen.add(toolName);

      if (action.isHighRisk && !includeHighRisk) continue;

      tools.push({
        name: toolName,
        description: action.description,
        inputSchema: action.inputSchema || { type: 'object', properties: {} },
      });
    }

    return tools;
  }

  public async execute(actionName: string, params: Record<string, any> = {}, allowHighRisk = false): Promise<any> {
    const action = this.actions.get(actionName);
    if (!action) {
      throw new Error(`Unknown browser action: ${actionName}`);
    }

    if (action.isHighRisk && !allowHighRisk) {
      throw new Error(`Action "${actionName}" is high-risk and is currently disabled.`);
    }

    return await action.handler(params, { tabHost: this.tabHost });
  }

  private registerCoreActions(): void {
    // 1. Open Tab
    this.registerAction({
      name: 'openTab',
      mcpName: 'antifan_open_tab',
      aliases: ['antifan.openTab'],
      description: 'Open a new Chromium browser tab in AntiFan Desktop',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
        },
      },
      handler: (params: { url?: string }, { tabHost }) => {
        const tabId = tabHost.createTab(params?.url);
        return { tabId, success: true };
      },
    });

    // 2. List Tabs / Get Tabs
    this.registerAction({
      name: 'listTabs',
      mcpName: 'antifan_list_tabs',
      aliases: ['getTabs', 'antifan.getTabs', 'antifan.listTabs'],
      description: 'List all open Chromium browser tabs with their IDs, titles, and URLs',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: (_params: Record<string, any>, { tabHost }) => {
        return {
          tabs: tabHost.getTabList(),
          activeTabId: tabHost.getActiveTabId(),
        };
      },
    });

    // 3. Switch Tab
    this.registerAction({
      name: 'switchTab',
      mcpName: 'antifan_switch_tab',
      aliases: ['antifan.switchTab'],
      description: 'Switch to an open tab by its ID',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Tab ID' },
        },
        required: ['tabId'],
      },
      handler: (params: { tabId: string }, { tabHost }) => {
        const ok = tabHost.switchTab(params.tabId);
        return { switched: ok, success: ok };
      },
    });

    // 4. Close Tab
    this.registerAction({
      name: 'closeTab',
      mcpName: 'antifan_close_tab',
      aliases: ['antifan.closeTab'],
      description: 'Close an open tab by its ID',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Tab ID' },
        },
        required: ['tabId'],
      },
      handler: (params: { tabId: string }, { tabHost }) => {
        const ok = tabHost.closeTab(params.tabId);
        return { closed: ok, success: ok };
      },
    });

    // 5. Navigate
    this.registerAction({
      name: 'navigate',
      mcpName: 'antifan_navigate',
      aliases: ['antifan.navigate'],
      description: 'Navigate the current or specified tab to a URL',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL' },
          tabId: { type: 'string', description: 'Optional Tab ID' },
        },
        required: ['url'],
      },
      handler: (params: { url: string; tabId?: string }, { tabHost }) => {
        const targetTabId = params.tabId || tabHost.getActiveTabId();
        const ok = tabHost.navigate(targetTabId, params.url);
        return { navigated: ok, success: ok };
      },
    });

    // 6. Reload
    this.registerAction({
      name: 'reload',
      mcpName: 'antifan_reload',
      aliases: ['antifan.reload'],
      description: 'Reload the current or specified tab',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Optional Tab ID' },
        },
      },
      handler: (params: { tabId?: string }, { tabHost }) => {
        const targetTabId = params.tabId || tabHost.getActiveTabId();
        const ok = tabHost.reload(targetTabId);
        return { reloaded: ok, success: ok };
      },
    });

    // 7. Go Back
    this.registerAction({
      name: 'goBack',
      aliases: ['antifan.goBack'],
      description: 'Go back in browser navigation history',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Optional Tab ID' },
        },
      },
      handler: (params: { tabId?: string }, { tabHost }) => {
        const targetTabId = params.tabId || tabHost.getActiveTabId();
        const ok = tabHost.goBack(targetTabId);
        return { wentBack: ok, success: ok };
      },
    });

    // 8. Go Forward
    this.registerAction({
      name: 'goForward',
      aliases: ['antifan.goForward'],
      description: 'Go forward in browser navigation history',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Optional Tab ID' },
        },
      },
      handler: (params: { tabId?: string }, { tabHost }) => {
        const targetTabId = params.tabId || tabHost.getActiveTabId();
        const ok = tabHost.goForward(targetTabId);
        return { wentForward: ok, success: ok };
      },
    });

    // 9. Get DOM
    this.registerAction({
      name: 'getDom',
      mcpName: 'antifan_get_dom',
      aliases: ['getDOM', 'antifan.getDOM', 'antifan.getDom'],
      description: 'Extract the full HTML or a specific selector subtree from the active tab',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector (optional)' },
        },
      },
      handler: async (params: { selector?: string }, { tabHost }) => {
        const html = await tabHost.getDom(params?.selector);
        return { html };
      },
    });

    // 10. Capture Screenshot
    this.registerAction({
      name: 'captureScreenshot',
      mcpName: 'antifan_screenshot',
      aliases: ['antifan.captureScreenshot', 'screenshot'],
      description: 'Capture a native GPU pixel-perfect screenshot of the active tab (returns base64 PNG)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_params: Record<string, any>, { tabHost }) => {
        const imageBase64 = await tabHost.captureScreenshot();
        return { imageBase64 };
      },
    });

    // 11. Toggle Inspect
    this.registerAction({
      name: 'toggleInspect',
      mcpName: 'antifan_toggle_inspect',
      aliases: ['antifan.toggleInspect'],
      description: 'Toggle interactive element inspection mode in the active tab',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: (_params: Record<string, any>, { tabHost }) => {
        const inspecting = tabHost.toggleInspect();
        return { inspecting, success: true };
      },
    });

    // 12. Toggle Sidebar
    this.registerAction({
      name: 'toggleSidebar',
      aliases: ['antifan.toggleSidebar'],
      description: 'Toggle the AI Chat Sidebar view',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: (_params: Record<string, any>, { tabHost }) => {
        const isOpen = tabHost.toggleSidebar();
        return { isOpen, success: true };
      },
    });

    // 13. Push Agent Message
    this.registerAction({
      name: 'pushAgentMessage',
      aliases: ['antifan.pushAgentMessage'],
      description: 'Push an assistant message into the AI Chat Sidebar',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'object', description: 'ChatMessage payload' },
        },
        required: ['message'],
      },
      handler: (params: { message?: ChatMessage }, { tabHost }) => {
        if (!params?.message) {
          throw new Error('Missing message in payload');
        }
        tabHost.pushAgentMessage(params.message as ChatMessage);
        return { pushed: true, success: true };
      },
    });

    // 14. Get Status
    this.registerAction({
      name: 'getStatus',
      aliases: ['antifan.getStatus'],
      description: 'Get active bridge status and tab metrics',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: (_params: Record<string, any>, { tabHost }) => {
        const status: AntiFanBridgeStatus = {
          active: true,
          port: 20129,
          clientCount: 0,
          activeTabId: tabHost.getActiveTabId(),
          tabCount: tabHost.getTabList().length,
          inspecting: false,
        };
        return status;
      },
    });

    // 15. Eval JS (High Risk)
    this.registerAction({
      name: 'evalJs',
      mcpName: 'antifan_eval_js',
      aliases: ['evalJS', 'antifan.evalJS', 'antifan.evalJs'],
      description: 'Execute arbitrary JavaScript expression in the active tab (requires high-risk mode)',
      isHighRisk: true,
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'JavaScript code to execute' },
        },
        required: ['expression'],
      },
      handler: async (params: { expression: string }, { tabHost }) => {
        const result = await tabHost.evalJs(params.expression);
        return { result };
      },
    });
  }
}
