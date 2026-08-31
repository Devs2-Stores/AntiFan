/**
 * AntiFan Browser Desktop — Unified Browser Action Registry (Extensibility Phase 1)
 * Central dispatch router for all Browser Actions invoked via MCP Stdio, WebSocket RPC, or Plugins.
 */
import { NativeTabHost } from './native-tab-host';
import { AntiFanBridgeStatus } from '../../shared/contracts';

export interface ActionDefinition<TParams = Record<string, any>, TResult = any> {
  name: string;
  mcpName?: string;
  aliases?: string[];
  description: string;
  isHighRisk?: boolean;
  inputSchema?: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[]; items?: { type: string } }>;
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
    // 1b. Set Automation Target Tab
    this.registerAction({
      name: 'setAutomationTarget',
      mcpName: 'antifan_set_automation_target',
      aliases: ['antifan.setAutomationTarget', 'setAutomationTabId', 'antifan.setAutomationTabId'],
      description: 'Explicitly set the active automation tab in AntiFan Desktop',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Tab ID to target for automation' },
        },
        required: ['tabId'],
      },
      handler: (params: { tabId: string }, { tabHost }) => {
        const cleanId = params?.tabId && typeof params.tabId === 'string' ? params.tabId.trim() : '';
        if (!cleanId) throw new Error('tabId is required');
        if (!tabHost.setAutomationTabId || !tabHost.getTabList) {
          throw new Error('setAutomationTabId is not supported by host');
        }
        const tabs = tabHost.getTabList() || [];
        const exists = tabs.some(t => Boolean(t && typeof t === 'object' && 'id' in t && (t as { id: unknown }).id === cleanId));
        if (!exists) {
          throw new Error(`Tab with id '${cleanId}' not found`);
        }
        tabHost.setAutomationTabId(cleanId);
        return { tabId: cleanId, success: true };
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
      description: 'Extract the full HTML or a specific selector subtree from the active tab (or specified tabId/paneId)',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector (optional)' },
          tabId: { type: 'string', description: 'Optional tab ID' },
          paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
        },
      },
      handler: async (params: { selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, { tabHost }) => {
        const html = await tabHost.getDom(params?.selector, params?.tabId, params?.paneId);
        return { html };
      },
    });
    // 10. Capture Screenshot
    this.registerAction({
      name: 'captureScreenshot',
      mcpName: 'antifan_screenshot',
      aliases: ['antifan.captureScreenshot', 'screenshot'],
      description: 'Capture a native GPU pixel-perfect screenshot of the active tab (or specified tabId/paneId, returns base64 PNG)',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Optional tab ID' },
          paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
        },
      },
      handler: async (params: { tabId?: string; paneId?: 'desktop' | 'mobile' }, { tabHost }) => {
        const imageBase64 = await tabHost.captureScreenshot(undefined, params?.tabId, params?.paneId);
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
        const tabs = tabHost.getTabList();
        const activeTabId = tabHost.getActiveTabId();
        return {
          active: true,
          port: 20129,
          clientCount: 0,
          activeTabId,
          tabCount: tabs.length,
          inspecting: false,
        };
      },
    });

    // 15. Agent Snapshot
    this.registerAction({
      name: 'agentSnapshot',
      mcpName: 'antifan_agent_snapshot',
      aliases: ['antifan.agentSnapshot', 'anti.browser.snapshot', 'snapshot'],
      description: 'Capture interactive ARIA semantic snapshot with compact @e1, @e2 element references',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Optional tab ID' },
          paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
        },
      },
      handler: async (params: { tabId?: string; paneId?: 'desktop' | 'mobile' }, { tabHost }) => {
        const snapshot = await tabHost.agentSnapshot(params?.tabId, params?.paneId);
        return { snapshot, success: true };
      },
    });
    // 16. Agent Click
    this.registerAction({
      name: 'agentClick',
      mcpName: 'antifan_agent_click',
      aliases: ['antifan.agentClick', 'anti.browser.click', 'anti.agent.cursor.click'],
      description: 'Click an element or coordinate using agent cursor (supports @ref like @e1 or CSS selector)',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector or element text' },
          ref: { type: 'string', description: 'Interactive snapshot element reference (e.g. @e1)' },
          x: { type: 'number', description: 'Optional explicit X viewport coordinate' },
          y: { type: 'number', description: 'Optional explicit Y viewport coordinate' },
          label: { type: 'string', description: 'Optional visual action label' },
          tabId: { type: 'string', description: 'Optional tab ID' },
          paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
        },
      },
      handler: async (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, { tabHost }) => {
        const clicked = await tabHost.agentClick(params);
        return { clicked, success: clicked };
      },
    });

    // 17. Agent Type
    this.registerAction({
      name: 'agentType',
      mcpName: 'antifan_agent_type',
      aliases: ['antifan.agentType', 'anti.browser.type', 'anti.agent.cursor.type'],
      description: 'Type text into an input element using agent cursor (supports @ref like @e1 or CSS selector)',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the input' },
          ref: { type: 'string', description: 'Interactive snapshot element reference (e.g. @e1)' },
          text: { type: 'string', description: 'Text to type into the target element' },
          clear: { type: 'boolean', description: 'Clear existing text before typing' },
          tabId: { type: 'string', description: 'Optional tab ID' },
          paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
        },
        required: ['text'],
      },
      handler: async (params: { selector?: string; ref?: string; text: string; clear?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, { tabHost }) => {
        const typed = await tabHost.agentType(params as any);
        return { typed, success: typed };
      },
    });

    // 18. Agent Hover
    this.registerAction({
      name: 'agentHover',
      mcpName: 'antifan_agent_hover',
      aliases: ['antifan.agentHover', 'anti.browser.hover', 'anti.agent.cursor.hover', 'anti.agent.cursor.move'],
      description: 'Hover virtual cursor over an element or coordinate (supports @ref or CSS selector)',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector or element text' },
          ref: { type: 'string', description: 'Interactive snapshot element reference (e.g. @e1)' },
          x: { type: 'number', description: 'Optional explicit X viewport coordinate' },
          y: { type: 'number', description: 'Optional explicit Y viewport coordinate' },
          label: { type: 'string', description: 'Optional visual action label' },
          tabId: { type: 'string', description: 'Optional tab ID' },
          paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
        },
      },
      handler: async (params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, { tabHost }) => {
        const hovered = await tabHost.agentHover(params);
        return { hovered, success: hovered };
      },
    });

    // 19. Agent Scroll
    this.registerAction({
      name: 'agentScroll',
      mcpName: 'antifan_agent_scroll',
      aliases: ['antifan.agentScroll', 'anti.browser.scroll', 'anti.agent.cursor.scroll'],
      description: 'Scroll active page or container using virtual agent scroll (supports @ref or CSS selector)',
      inputSchema: {
        type: 'object',
        properties: {
          deltaY: { type: 'number', description: 'Vertical scroll delta in pixels (default: 400)' },
          selector: { type: 'string', description: 'Optional container selector to scroll' },
          ref: { type: 'string', description: 'Interactive snapshot element reference (e.g. @e1)' },
          tabId: { type: 'string', description: 'Optional tab ID' },
          paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
        },
      },
      handler: async (params: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, { tabHost }) => {
        const scrolled = await tabHost.agentScroll(params);
        return { scrolled, success: scrolled };
      },
    });

    // 20. Agent Highlight
    this.registerAction({
      name: 'agentHighlight',
      mcpName: 'antifan_agent_highlight',
      aliases: ['antifan.agentHighlight', 'anti.agent.cursor.highlight'],
      description: 'Visually highlight an element on page with neon border and badge',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of element to highlight' },
          ref: { type: 'string', description: 'Interactive snapshot element reference (e.g. @e1)' },
          label: { type: 'string', description: 'Badge label text' },
          tabId: { type: 'string', description: 'Optional tab ID' },
          paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
        },
      },
      handler: async (params: { selector?: string; ref?: string; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, { tabHost }) => {
        const highlighted = await tabHost.agentHighlight(params as any);
        return { highlighted, success: highlighted };
      },
    });

    // 21. Agent Clear
    this.registerAction({
      name: 'agentClear',
      mcpName: 'antifan_agent_clear',
      aliases: ['antifan.agentClear', 'anti.agent.cursor.clear'],
      description: 'Clear AI cursor, highlights, and visual banners from the active page',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Optional tab ID' },
          paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
        },
      },
      handler: async (params: { tabId?: string; paneId?: 'desktop' | 'mobile' }, { tabHost }) => {
        const cleared = await tabHost.agentClear(params?.tabId, params?.paneId);
        return { cleared, success: cleared };
      },
    });

    // 22. Agent Trajectory
    this.registerAction({
      name: 'agentTrajectory',
      mcpName: 'antifan_agent_trajectory',
      aliases: ['antifan.agentTrajectory', 'anti.agent.trajectory', 'trajectory'],
      description: 'Execute continuous multi-step cubic Bézier cursor trajectory and actions',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', description: 'Array of trajectory action steps', items: { type: 'object' } },
          speed: { type: 'string', enum: ['fast', 'natural', 'slow'], description: 'Movement speed profile' },
          smoothScroll: { type: 'boolean', description: 'Whether to use smooth scrolling' },
          tabId: { type: 'string', description: 'Optional tab ID' },
          paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
        },
        required: ['steps'],
      },
      handler: async (params: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, { tabHost }) => {
        const result = await tabHost.agentTrajectory(params);
        return { ...result, success: Boolean(result && typeof result === 'object' && (result as { success?: boolean }).success) };
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
          tabId: { type: 'string', description: 'Optional tab ID' },
          paneId: { type: 'string', enum: ['desktop', 'mobile'], description: 'Optional split review pane' },
        },
        required: ['expression'],
      },
      handler: async (params: { expression: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, { tabHost }) => {
        const result = await tabHost.evalJs(params.expression, params.tabId, params.paneId);
        return { result };
      },
    });
  }
}
