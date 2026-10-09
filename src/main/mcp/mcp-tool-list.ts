/**
 * MCP tool advertisement: the catalogue tools a transport exposes plus their
 * generated anti.* aliases. Kept free of runtime imports from the MCP SDK so
 * the tab host can render the tool list without loading the SDK server stack.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { CapabilityTransportAdapter } from '../tools/capability-transport';

export type McpAdvertisedTool = Tool & { risk?: string };

export function buildMcpToolList(staticTools: Tool[], transport?: CapabilityTransportAdapter, isHighRiskAllowed = false): McpAdvertisedTool[] {
  if (!transport) {
    return [];
  }
  const grants: Array<'read' | 'write' | 'eval'> = ['read', 'write'];
  if (isHighRiskAllowed) grants.push('eval');
  const toolMap = new Map<string, McpAdvertisedTool>();
  for (const grant of grants) {
    for (const item of transport.list({ grant })) {
      if (!toolMap.has(item.name)) {
        toolMap.set(item.name, {
          name: item.name,
          description: item.description,
          inputSchema: item.inputSchema as Tool['inputSchema'],
          risk: item.risk,
        });
      }
    }
  }
  const listed = Array.from(toolMap.values());
  const aliases = listed.filter((item) => item.name.startsWith('antifan_') || item.name.startsWith('theme.')).flatMap((item) => {
    const generated: McpAdvertisedTool[] = [];
    if (item.name === 'antifan_open_tab') generated.push({ ...item, name: 'anti.browser.tabs.create' });
    if (item.name === 'antifan_list_tabs') generated.push({ ...item, name: 'anti.browser.tabs.list' });
    if (item.name === 'antifan_switch_tab') generated.push({ ...item, name: 'anti.browser.tabs.activate' });
    if (item.name === 'antifan_close_tab') generated.push({ ...item, name: 'anti.browser.tabs.close' });
    if (item.name === 'antifan_navigate') generated.push({ ...item, name: 'anti.browser.navigate' });
    if (item.name === 'antifan_reload') generated.push({ ...item, name: 'anti.browser.reload' });
    if (item.name === 'antifan_get_dom') generated.push({ ...item, name: 'anti.inspect.dom' });
    if (item.name === 'antifan_screenshot') generated.push({ ...item, name: 'anti.screenshot.viewport' }, { ...item, name: 'anti.screenshot.full_page', description: 'Capture full-page screenshot of entire scrollable page height using CDP' });
    if (item.name === 'antifan_agent_click') generated.push({ ...item, name: 'anti.browser.click' }, { ...item, name: 'anti.agent.cursor.click' });
    if (item.name === 'antifan_agent_type') generated.push({ ...item, name: 'anti.browser.type' }, { ...item, name: 'anti.agent.cursor.type' });
    if (item.name === 'antifan_agent_scroll') generated.push({ ...item, name: 'anti.browser.scroll' }, { ...item, name: 'anti.agent.cursor.scroll' });
    if (item.name === 'antifan_agent_hover') generated.push({ ...item, name: 'anti.browser.hover' }, { ...item, name: 'anti.agent.cursor.hover' }, { ...item, name: 'anti.agent.cursor.move' });
    if (item.name === 'antifan_agent_highlight') generated.push({ ...item, name: 'anti.browser.highlight' }, { ...item, name: 'anti.agent.cursor.highlight' });
    if (item.name === 'antifan_agent_clear') generated.push({ ...item, name: 'anti.browser.clear' }, { ...item, name: 'anti.agent.cursor.clear' });
    if (item.name === 'antifan_agent_trajectory') generated.push({ ...item, name: 'anti.browser.trajectory' }, { ...item, name: 'anti.agent.cursor.trajectory' });
    if (item.name === 'antifan_get_viewport') generated.push({ ...item, name: 'anti.browser.viewport.get' }, { ...item, name: 'anti.browser.get_viewport', description: 'Get browser viewport dimensions, DPR, device preset, and layout surface state without applying overrides' });
    if (item.name === 'antifan_set_viewport') generated.push({ ...item, name: 'anti.browser.viewport.set' }, { ...item, name: 'anti.browser.set_viewport', description: 'Set browser responsive viewport dimensions and prove the tab measured them' });
    if (item.name === 'antifan_set_device_preset') generated.push({ ...item, name: 'anti.browser.set_device' }, { ...item, name: 'anti.browser.viewport.set_preset' }, { ...item, name: 'anti.browser.set_device_preset' });
    if (item.name === 'antifan_list_device_presets') generated.push({ ...item, name: 'anti.browser.viewport.list_presets' });
    if (item.name === 'antifan_toggle_split_review') generated.push({ ...item, name: 'anti.browser.split_review' }, { ...item, name: 'browser.split_review' });
    if (item.name === 'antifan_theme_qa_validate') generated.push({ ...item, name: 'anti.theme.qa.validate' }, { ...item, name: 'anti.theme.qa_validate' });
    if (item.name === 'antifan_theme_debug_bundle') generated.push({ ...item, name: 'anti.theme.debug.bundle' }, { ...item, name: 'anti.theme.debug_bundle' });
    if (item.name === 'antifan_theme_qa_repair_begin') generated.push({ ...item, name: 'anti.theme.qa_repair.begin' }, { ...item, name: 'theme.qa_repair.begin' });
    if (item.name === 'antifan_theme_qa_repair_verify') generated.push({ ...item, name: 'anti.theme.qa_repair.verify' }, { ...item, name: 'theme.qa_repair.verify' });
    if (item.name === 'antifan_theme_qa_rollback') generated.push({ ...item, name: 'anti.theme.qa_rollback' }, { ...item, name: 'theme.qa_rollback' });
    if (item.name === 'theme.assert_cart') generated.push({ ...item, name: 'anti.theme.assert_cart' });
    if (item.name === 'theme.resolve_product' || item.name === 'antifan_theme_resolve_product') generated.push({ ...item, name: 'anti.theme.resolve_product' }, { ...item, name: 'storefront.resolve_product' });
    if (item.name === 'theme.style_override') generated.push({ ...item, name: 'anti.theme.style_override' });
    if (item.name === 'antifan_set_zoom') generated.push({ ...item, name: 'anti.browser.set_zoom' }, { ...item, name: 'anti.browser.zoom.set' });
    if (item.name === 'antifan_agent_snapshot') generated.push({ ...item, name: 'anti.inspect.snapshot' });
    if (item.name === 'antifan_eval_js') generated.push({ ...item, name: 'anti.browser.evaluate' }, { ...item, name: 'anti.inspect.eval' });
    if (item.name === 'antifan_upload_file') generated.push({ ...item, name: 'anti.agent.file_upload' }, { ...item, name: 'anti.agent.upload_file' }, { ...item, name: 'anti.browser.upload_file' });
    if (item.name === 'antifan_drop_files') generated.push({ ...item, name: 'anti.agent.drop' }, { ...item, name: 'anti.agent.file_drop' }, { ...item, name: 'anti.browser.drop_files' });
    if (item.name === 'browser.dump_dom' || item.name === 'antifan_dump_dom') generated.push({ ...item, name: 'anti.browser.dump_dom' }, { ...item, name: 'anti.inspect.dump_dom' });
    if (item.name === 'antifan_set_automation_target') generated.push({ ...item, name: 'anti.browser.set_automation_target' }, { ...item, name: 'anti.browser.set-automation-target' });
    return generated;
  });
  const diagnosticAliases = listed.some((item) => item.name === 'antifan_console_messages')
    ? [
        { ...listed.find((item) => item.name === 'antifan_console_messages')!, name: 'anti.devtools.console.errors' },
        { ...listed.find((item) => item.name === 'antifan_console_messages')!, name: 'anti.devtools.console.warnings' },
      ]
    : [];
  // A generated alias must never shadow or duplicate a real catalogue tool:
  // duplicate names make the advertised schema ambiguous, and the first match
  // may be the wrong one.
  const emitted = new Set(toolMap.keys());
  const uniqueAliases = [...aliases, ...diagnosticAliases].filter((item) => {
    if (emitted.has(item.name)) return false;
    emitted.add(item.name);
    return true;
  });
  return [...listed, ...uniqueAliases];
}
