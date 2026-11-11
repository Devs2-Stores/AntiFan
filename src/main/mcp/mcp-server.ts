/**
 * AntiFan Browser Desktop — Model Context Protocol (MCP) In-Memory Server
 * Provides browser automation and inspection tool surface to AI Agents and in-memory tests.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { NativeTabHost } from '../browser/native-tab-host';
import { CapabilityTransportAdapter } from '../tools/capability-transport';
import { CapabilityError, AuthenticatedCapabilityContext, ClientInvocationIntent, makeControlPlaneId } from '../../shared/control-plane-contracts';
import { AttachmentRegistry } from '../run/attachment-registry';
import { envelope } from './result-envelope';
import { recordFallbackTelemetry, FallbackTelemetryPayload } from '../telemetry/fallback-recorder';
import { checkRequiredArgs } from '../tools/required-args';
import { buildMcpToolList } from './mcp-tool-list';
export interface BoundAttachmentSession {
  attachmentId: string;
  attachmentSecret: string;
  authorityRevision: string;
}

/**
 * Legacy and alias tool names mapped to the catalogue name they dispatch as. A Map
 * (not an object literal) so a name such as `constructor` is never resolved through
 * Object.prototype, and the table is built once instead of per call.
 */
const TOOL_ALIASES: ReadonlyMap<string, string> = new Map(Object.entries({
  'anti.browser.tabs.create': 'antifan_open_tab',
  'anti.browser.open_tab': 'antifan_open_tab',
  'anti.browser.tabs.list': 'antifan_list_tabs',
  'anti.browser.list_tabs': 'antifan_list_tabs',
  'anti.browser.tabs.activate': 'antifan_switch_tab',
  'anti.browser.switch_tab': 'antifan_switch_tab',
  'anti.browser.tabs.close': 'antifan_close_tab',
  'anti.browser.close_tab': 'antifan_close_tab',
  'anti.browser.navigate': 'antifan_navigate',
  'anti.browser.reload': 'antifan_reload',
  'anti.browser.dump_dom': 'browser.dump_dom',
  'anti.browser.dump-dom': 'browser.dump_dom',
  'anti.inspect.dump_dom': 'browser.dump_dom',
  'antifan_dump_dom': 'browser.dump_dom',
  'anti.browser.set_automation_target': 'antifan_set_automation_target',
  'anti.browser.set-automation-target': 'antifan_set_automation_target',
  'anti.browser.rebind_target': 'antifan_rebind_target',
  'anti.browser.rebind-target': 'antifan_rebind_target',
  'browser.rebind-target': 'antifan_rebind_target',
  'anti.inspect.dom': 'antifan_get_dom',
  'anti.screenshot.viewport': 'antifan_screenshot',
  'anti.screenshot.full_page': 'anti.screenshot.full_page',
  'anti.screenshot.fullpage': 'anti.screenshot.full_page',
  'antifan_screenshot_full_page': 'anti.screenshot.full_page',
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
  'anti.browser.viewport.get': 'antifan_get_viewport',
  'anti.browser.get_viewport': 'antifan_get_viewport',
  'anti.browser.viewport.set': 'antifan_set_viewport',
  'anti.browser.set_device': 'antifan_set_device_preset',
  'anti.browser.set_device_preset': 'antifan_set_device_preset',
  'anti.browser.viewport.set_preset': 'antifan_set_device_preset',
  'anti.browser.viewport.list_presets': 'antifan_list_device_presets',
  'antifan_set_device_preset': 'antifan_set_device_preset',
  'antifan_list_device_presets': 'antifan_list_device_presets',
  'anti.browser.split_review': 'antifan_toggle_split_review',
  'anti.browser.split-review': 'antifan_toggle_split_review',
  'browser.split_review': 'antifan_toggle_split_review',
  'browser.split-review': 'antifan_toggle_split_review',
  'anti.devtools.console.list': 'antifan_console_messages',
  'anti.devtools.console.errors': 'antifan_console_messages',
  'anti.devtools.console.warnings': 'antifan_console_messages',
  'anti.browser.eval': 'antifan_eval_js',
  'anti.agent.eval': 'antifan_eval_js',
  'anti.browser.evaluate': 'antifan_eval_js',
  'anti.inspect.eval': 'antifan_eval_js',
  'anti.inspect.snapshot': 'antifan_agent_snapshot',
  'anti.inspect.layout': 'anti.inspect.layout',
  'anti.inspect_layout': 'anti.inspect.layout',
  'anti.inspect.font': 'anti.inspect.font',
  'anti.inspect_font': 'anti.inspect.font',
  'browser.inspect_font': 'anti.inspect.font',
  'antifan_inspect_font': 'anti.inspect.font',
  'anti.browser.style_override': 'anti.browser.style_override',
  'anti.style_override': 'anti.browser.style_override',
  'anti.theme.preview_css': 'anti.browser.style_override',
  'anti.inspect.find': 'antifan_find',
  'anti.browser.find': 'antifan_find',
  'anti.agent.press_key': 'antifan_keyboard_press',
  'anti.browser.press_key': 'antifan_keyboard_press',
  'anti.browser.set_zoom': 'antifan_set_zoom',
  'anti.browser.zoom.set': 'antifan_set_zoom',
  'anti.theme.qa.validate': 'antifan_theme_qa_validate',
  'anti.theme.qa_validate': 'antifan_theme_qa_validate',
  'anti.theme.debug.bundle': 'antifan_theme_debug_bundle',
  'anti.theme.debug_bundle': 'antifan_theme_debug_bundle',
  'theme.qa_validate': 'antifan_theme_qa_validate',
  'theme.debug_bundle': 'antifan_theme_debug_bundle',
  'anti.theme.assert_cart': 'theme.assert_cart',
  'anti.theme.resolve_product': 'theme.resolve_product',
  'storefront.resolve_product': 'theme.resolve_product',
  'theme.resolve_product': 'theme.resolve_product',
  'anti.theme.style_override': 'theme.style_override',
  'theme.style_override': 'theme.style_override',
  'anti.theme.qa_repair.begin': 'antifan_theme_qa_repair_begin',
  'theme.qa_repair.begin': 'antifan_theme_qa_repair_begin',
  'anti.theme.qa_repair.verify': 'antifan_theme_qa_repair_verify',
  'theme.qa_repair.verify': 'antifan_theme_qa_repair_verify',
  'anti.theme.qa_rollback': 'antifan_theme_qa_rollback',
  'theme.qa_rollback': 'antifan_theme_qa_rollback',
  'anti.agent.file_upload': 'antifan_upload_file',
  'anti.agent.upload_file': 'antifan_upload_file',
  'anti.browser.upload_file': 'antifan_upload_file',
  'anti.agent.drop': 'antifan_drop_files',
  'anti.agent.file_drop': 'antifan_drop_files',
  'anti.browser.drop_files': 'antifan_drop_files',
  'anti.diagnostics.list_issues': 'antifan_list_issues',
  'anti.diagnostics.list': 'antifan_list_issues',
  'anti.diagnostics.record_issue': 'antifan_record_issue',
  'anti.diagnostics.record': 'antifan_record_issue',
  'anti.diagnostics.resolve_issue': 'antifan_resolve_issue',
  'anti.sheet.extract': 'antifan_sheet_extract',
  'sheet.extract': 'antifan_sheet_extract',
}));

export class AntiFanMcpServer {
  private tabHost: NativeTabHost;
  private isHighRiskAllowed: boolean;
  private readonly transport?: CapabilityTransportAdapter;
  private boundSession?: BoundAttachmentSession;

  constructor(
    tabHost: NativeTabHost,
    isHighRiskAllowed = false,
    transport?: CapabilityTransportAdapter,
    boundSession?: BoundAttachmentSession
  ) {
    this.tabHost = tabHost;
    this.isHighRiskAllowed = isHighRiskAllowed;
    this.transport = transport;
    this.boundSession = boundSession || this.resolveEnvBoundSession();
  }

  private resolveEnvBoundSession(): BoundAttachmentSession | undefined {
    const attachmentId = process.env.ANTIFAN_ATTACHMENT_ID;
    const attachmentSecret = process.env.ANTIFAN_ATTACHMENT_SECRET;
    const authorityRevision = process.env.ANTIFAN_AUTHORITY_REVISION;
    if (attachmentId && attachmentSecret && authorityRevision) {
      return { attachmentId, attachmentSecret, authorityRevision };
    }
    return undefined;
  }

  public setBoundSession(session: BoundAttachmentSession): void {
    this.boundSession = { ...session };
  }

  public getBoundSession(): BoundAttachmentSession | undefined {
    return this.boundSession ? { ...this.boundSession } : undefined;
  }

  private advertisedSchemaCache?: Map<string, Record<string, unknown>>;

  /**
   * The input schema this session advertises for a tool, resolved once. The advertised
   * surface is fixed for the session's lifetime (static tools, the paired catalogue's
   * tools and the high-risk switch are all decided at construction), so a per-session
   * cache cannot go stale, and the lookup costs no bridge round-trip per call.
   */
  private async advertisedInputSchema(toolName: string): Promise<Record<string, unknown> | undefined> {
    if (!this.advertisedSchemaCache) {
      const { tools } = await this.listTools();
      const cache = new Map<string, Record<string, unknown>>();
      for (const tool of tools) {
        if (tool.inputSchema && typeof tool.inputSchema === 'object') {
          cache.set(tool.name, tool.inputSchema as Record<string, unknown>);
        }
      }
      this.advertisedSchemaCache = cache;
    }
    return this.advertisedSchemaCache.get(toolName);
  }

  public async listTools(): Promise<{ tools: Tool[] }> {
    return {
      tools: buildMcpToolList(this.transport, this.isHighRiskAllowed).map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    };
  }

  public async callTool(toolName: string, args: Record<string, unknown> = {}, callerRequestId?: string): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> {
    const name = TOOL_ALIASES.get(toolName) ?? toolName;
    const a = (args || {}) as Record<string, unknown>;
    if (!a.tabId && a.id) a.tabId = a.id;
    if (toolName === 'anti.devtools.console.errors') a.level = 3;
    if (toolName === 'anti.devtools.console.warnings') a.level = 2;

    if (!this.transport) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'MCP_CONTEXT_REQUIRED', message: 'Authoritative transport is required for MCP tool execution' }) }],
      };
    }
    if (
      a.attachmentClaims !== undefined ||
      a.attachmentId !== undefined ||
      a.attachmentSecret !== undefined ||
      a.authorityRevision !== undefined ||
      a.secret !== undefined ||
      a.revision !== undefined ||
      a.runtimeLease !== undefined ||
      a.leaseToken !== undefined
    ) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'INVALID_ARGUMENT', message: 'Authority credentials and attachment claims must not be passed in tool arguments' }) }],
      };
    }

    const session = this.boundSession;
    if (!session || !session.attachmentId || !session.attachmentSecret || !session.authorityRevision) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'ATTACHMENT_REQUIRED', message: 'No authoritative attachment bound to MCP session' }) }],
      };
    }

    // The advertised schema is enforced here, at the single entry every tools/call passes
    // through, because this surface dispatches along two paths: a name that has a legacy
    // equivalent never reaches CapabilityCatalogue.dispatchAuthenticated. Measured with
    // the gate placed only there: the catalogue-only anti.telemetry.record_fallback was
    // correctly refused, while anti.browser.tabs.activate, anti.browser.rebind_target and
    // anti.browser.set_automation_target still ACCEPTED an omitted required `tabId` and
    // acted on a tab the caller never named. Authority and credential checks stay ahead of
    // this on purpose, so they keep reporting their own codes.
    const advertisedSchema = await this.advertisedInputSchema(toolName);
    const requiredArgsRefusal = checkRequiredArgs(toolName, advertisedSchema, a);
    if (requiredArgsRefusal) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            code: 'INVALID_ARGUMENT',
            message: requiredArgsRefusal.message,
            details: {
              capability: toolName,
              missing: requiredArgsRefusal.missing,
              unsatisfiedAlternatives: requiredArgsRefusal.unsatisfiedAlternatives,
            },
          }),
        }],
      };
    }

    const transportArgs = { ...a };
    delete transportArgs.context;
    // projectId is stripped for every tool EXCEPT the ones that expose it as a
    // fail-closed scope selector: tabs.list, tabs.get and tabs.create. Their
    // execute contracts require the declared selector to equal the authenticated
    // target scope and refuse it otherwise, so forwarding it can never widen
    // authority. Everywhere else the strip stands — caller-supplied scope
    // fields never reach a capability.
    if (name !== 'antifan_list_tabs' && name !== 'browser.list-tabs' && name !== 'antifan_open_tab' && name !== 'browser.open-tab' && name !== 'anti.browser.tabs.create' && name !== 'anti.browser.tabs.list' && name !== 'anti.browser.tabs.get') {
      delete transportArgs.projectId;
    }
    delete transportArgs.workspaceId;
    delete transportArgs.idempotencyKey;
    delete transportArgs.callerRequestId;
    const requestId = callerRequestId ? `req-mcp-${callerRequestId}` : makeControlPlaneId('request');
    const idempotencyKey = callerRequestId ? `idem-mcp-${callerRequestId}` : makeControlPlaneId('idempotency');
    const intent: ClientInvocationIntent = {
      requestId,
      idempotencyKey,
      attachmentId: session.attachmentId,
      attachmentSecret: session.attachmentSecret,
      authorityRevision: session.authorityRevision,
      name,
      params: transportArgs,
    };
    const result = await this.transport.dispatchIntent(intent);
    if (result.ok) {
      if (result.replacementAuthorityRevision) {
        this.boundSession = {
          ...session,
          authorityRevision: result.replacementAuthorityRevision,
        };
      }
      const responseEnvelope = envelope(
        result.data,
        {},
        result.requestId,
        result.invocationId,
        result.replacementAuthorityRevision
      );
      return { content: [{ type: 'text', text: JSON.stringify(responseEnvelope) }] };
    }
    if (result.replacementAuthorityRevision) {
      this.boundSession = {
        ...session,
        authorityRevision: result.replacementAuthorityRevision,
      };
    }
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          code: result.error?.code || 'CAPABILITY_ERROR',
          message: result.error?.message || 'Capability execution failed',
          details: result.error?.details,
          requestId: result.requestId,
          invocationId: result.invocationId,
          ...(result.replacementAuthorityRevision ? { authorityRevision: result.replacementAuthorityRevision } : {}),
        }),
      }],
    };
  }
}
function isAgentCapabilityName(name: string): boolean {
  return name === 'browser.keyboard-press'
    || name === 'antifan_keyboard_press'
    || name.startsWith('browser.agent-')
    || name.startsWith('antifan_agent_')
    || name === 'anti.agent.sequence';
}

function agentCapabilitySucceeded(name: string, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const result = data as Record<string, unknown>;
  if (name === 'browser.keyboard-press' || name === 'antifan_keyboard_press') return result.success === true;
  if (name.endsWith('agent-click') || name === 'antifan_agent_click') return result.clicked === true;
  if (name.endsWith('agent-type') || name === 'antifan_agent_type') return result.typed === true;
  if (name.endsWith('agent-scroll') || name === 'antifan_agent_scroll') return result.scrolled === true;
  if (name.endsWith('agent-hover') || name === 'antifan_agent_hover') return result.hovered === true;
  if (name.endsWith('agent-highlight') || name === 'antifan_agent_highlight') return result.highlighted === true;
  if (name.endsWith('agent-clear') || name === 'antifan_agent_clear') return result.cleared === true;
  if (name.endsWith('agent-move') || name === 'antifan_agent_move') return result.moved === true;
  if (name.endsWith('agent-trajectory') || name === 'antifan_agent_trajectory') return result.success === true;
  if (name.endsWith('agent-snapshot') || name === 'antifan_agent_snapshot') return typeof result.snapshot === 'string';
  if (name.endsWith('agent-sequence') || name === 'antifan_agent_sequence' || name === 'anti.agent.sequence') return result.success === true;
  return false;
}
