import { BrowserTarget, CapabilityError, ArtifactRef, assertExactBrowserTarget, digestText } from '../../shared/control-plane-contracts';

export interface BrowserHostPort {
  getTabList(): unknown[];
  getActiveTabId?(): string;
  createTab?(url?: string, activate?: boolean): string;
  closeTab?(tabId: string): boolean;
  switchTab?(tabId: string): boolean;
  navigate(tabId: string, url: string): boolean;
  reload(tabId: string): boolean;
  getDom(selector?: string, tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<string>;
  captureScreenshot(rect?: unknown, tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<string>;
  evalJs(expression: string, tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<unknown>;
  getDiagnostics?(tabId?: string, level?: number | string): { console: unknown[]; failures: unknown[] };
  runResponsiveCheck?(tabId: string): Promise<Record<string, unknown>>;
  agentTrajectory?(params: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string }): Promise<Record<string, unknown>>;
  agentMove?(args: { selector?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentClick?(params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentType?(params: { selector: string; text: string; clear?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentScroll?(params: { deltaY?: number; selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentHover?(params: { selector?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentHighlight?(params: { selector: string; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentClear?(tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<boolean>;
  agentSnapshot?(tabId?: string, paneId?: 'desktop' | 'mobile'): Promise<string>;
  sendKeyboardPress?(params: { key: string; modifiers?: string[]; tabId?: string }): Promise<{ success: boolean; key: string; modifiers: string[] }>;
  setViewportSize?(options: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string }): boolean;
  setDevicePreset?(tabId: string, presetId: string): boolean;
  getDevicePresets?(): unknown[];
  setZoom?(tabId: string, zoomFactor: number): boolean;
  toggleInspect?(): boolean;
  isCurrentTarget?(target: BrowserTarget): boolean;
}

export interface BrowserArtifactSink {
  stage(input: { kind: ArtifactRef['kind']; mime: string; data: string | Buffer; runId: string; attemptId: string; maxBytes?: number }): Promise<ArtifactRef> | ArtifactRef;
}

export class BrowserControlPort {
  constructor(private readonly host: BrowserHostPort, private readonly artifacts?: BrowserArtifactSink) {}

  listTabs(context: { target?: BrowserTarget }): unknown[] {
    if (context.target) assertTarget(context.target);
    return this.host.getTabList();
  }

  navigate(target: BrowserTarget, url: string, explicitTabId?: string): { navigated: boolean; target: BrowserTarget } {
    const tabId = this.resolveTargetTab(target, explicitTabId);
    if (!url || !/^https?:\/\//i.test(url)) throw new CapabilityError('INVALID_ARGUMENT', 'Navigation requires an http(s) URL');
    return { navigated: this.host.navigate(tabId, url), target: { ...target, tabId } };
  }

  reload(target: BrowserTarget, explicitTabId?: string): { reloaded: boolean; target: BrowserTarget } {
    const tabId = this.resolveTargetTab(target, explicitTabId);
    return { reloaded: this.host.reload(tabId), target: { ...target, tabId } };
  }

  async dom(target: BrowserTarget, runId: string, attemptId: string, selector?: string, explicitTabId?: string, paneId?: 'desktop' | 'mobile'): Promise<ArtifactRef | string> {
    const tabId = this.resolveTargetTab(target, explicitTabId);
    const html = await this.host.getDom(selector, tabId, paneId);
    return this.artifacts ? this.artifacts.stage({ kind: 'dom', mime: 'text/html', data: html, runId, attemptId, maxBytes: 512 * 1024 }) : limit(html, 512 * 1024);
  }

  async screenshot(target: BrowserTarget, runId: string, attemptId: string, explicitTabId?: string, paneId?: 'desktop' | 'mobile'): Promise<ArtifactRef | string> {
    const tabId = this.resolveTargetTab(target, explicitTabId);
    const base64 = await this.host.captureScreenshot(undefined, tabId, paneId);
    const buffer = Buffer.from(base64, 'base64');
    return this.artifacts ? this.artifacts.stage({ kind: 'screenshot', mime: 'image/png', data: buffer, runId, attemptId, maxBytes: 8 * 1024 * 1024 }) : limit(base64, 8 * 1024 * 1024);
  }
  async eval(target: BrowserTarget, expression: string, explicitTabId?: string, paneId?: 'desktop' | 'mobile'): Promise<unknown> {
    const tabId = this.resolveTargetTab(target, explicitTabId);
    if (!expression.trim()) throw new CapabilityError('INVALID_ARGUMENT', 'JavaScript expression is required');
    return this.host.evalJs(expression, tabId, paneId);
  }

  openTab(options: { url?: string; activate?: boolean } = {}): { tabId: string } {
    if (!this.host.createTab) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'createTab is not supported by host');
    return { tabId: this.host.createTab(options.url, false) };
  }
  closeTab(tabId: string): { closed: boolean } {
    if (!this.host.closeTab) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'closeTab is not supported by host');
    return { closed: this.host.closeTab(tabId) };
  }

  switchTab(tabId: string): { switched: boolean } {
    if (!this.host.switchTab) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'switchTab is not supported by host');
    return { switched: this.host.switchTab(tabId) };
  }

  diagnostics(tabId?: string, level?: number | string): { console: unknown[]; failures: unknown[] } {
    if (!this.host.getDiagnostics) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'getDiagnostics is not supported by host');
    return this.host.getDiagnostics(tabId, level);
  }

  async responsiveCheck(tabId: string): Promise<Record<string, unknown>> {
    if (!this.host.runResponsiveCheck) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'runResponsiveCheck is not supported by host');
    return this.host.runResponsiveCheck(tabId);
  }

  async agentTrajectory(args: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string }, target?: BrowserTarget): Promise<Record<string, unknown>> {
    if (!this.host.agentTrajectory) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentTrajectory is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId);
    return (await this.host.agentTrajectory({ ...args, tabId })) as Record<string, unknown>;
  }

  async agentMove(args: { selector?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ moved: boolean }> {
    if (!this.host.agentMove) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentMove is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId);
    return { moved: await this.host.agentMove({ ...args, tabId }) };
  }

  async agentClick(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ clicked: boolean }> {
    if (!this.host.agentClick) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentClick is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId);
    return { clicked: await this.host.agentClick({ ...args, tabId }) };
  }

  async agentType(args: { selector: string; text: string; clear?: boolean; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ typed: boolean }> {
    if (!this.host.agentType) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentType is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId);
    return { typed: await this.host.agentType({ ...args, tabId }) };
  }
  async keyboardPress(args: { key: string; modifiers?: string[]; tabId?: string }, target?: BrowserTarget): Promise<{ success: boolean; key: string; modifiers: string[] }> {
    if (!this.host.sendKeyboardPress) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'sendKeyboardPress is not supported by host');
    if (!args || typeof args.key !== 'string' || args.key.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'key must be a non-empty string');
    }
    const effectiveTabId = this.resolveTargetTab(target, args.tabId);
    try {
      return await this.host.sendKeyboardPress({ ...args, tabId: effectiveTabId });
    } catch (err: unknown) {
      if (err instanceof CapabilityError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Tab not found')) {
        throw new CapabilityError('CAPABILITY_NOT_FOUND', msg);
      }
      throw new CapabilityError('INVALID_ARGUMENT', msg);
    }
  }
  async agentScroll(args: { deltaY?: number; selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ scrolled: boolean }> {
    if (!this.host.agentScroll) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentScroll is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId);
    return { scrolled: await this.host.agentScroll({ ...args, tabId }) };
  }

  async agentHover(args: { selector?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ hovered: boolean }> {
    if (!this.host.agentHover) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentHover is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId);
    return { hovered: await this.host.agentHover({ ...args, tabId }) };
  }

  async agentHighlight(args: { selector: string; label?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }, target?: BrowserTarget): Promise<{ highlighted: boolean }> {
    if (!this.host.agentHighlight) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentHighlight is not supported by host');
    const tabId = this.resolveTargetTab(target, args.tabId);
    return { highlighted: await this.host.agentHighlight({ ...args, tabId }) };
  }
  async agentClear(options?: { tabId?: string; paneId?: 'desktop' | 'mobile' } | string, target?: BrowserTarget): Promise<{ cleared: boolean }> {
    if (!this.host.agentClear) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentClear is not supported by host');
    const tabId = typeof options === 'string' ? options : options?.tabId;
    const paneId = typeof options === 'object' ? options?.paneId : undefined;
    const effectiveTabId = this.resolveTargetTab(target, tabId);
    return { cleared: await this.host.agentClear(effectiveTabId, paneId) };
  }

  async agentSnapshot(options?: { tabId?: string; paneId?: 'desktop' | 'mobile' } | string, target?: BrowserTarget): Promise<{ snapshot: string }> {
    if (!this.host.agentSnapshot) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'agentSnapshot is not supported by host');
    const tabId = typeof options === 'string' ? options : options?.tabId;
    const paneId = typeof options === 'object' ? options?.paneId : undefined;
    const effectiveTabId = this.resolveTargetTab(target, tabId);
    return { snapshot: await this.host.agentSnapshot(effectiveTabId, paneId) };
  }

  setViewport(options: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string }, target?: BrowserTarget): { success: boolean; width: number; height: number; mobile?: boolean; presetId: string } {
    if (!this.host.setViewportSize) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'setViewportSize is not supported by host');
    if (typeof options.width !== 'number' || options.width <= 0 || typeof options.height !== 'number' || options.height <= 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'width and height must be positive numbers');
    }
    const effectiveTabId = this.resolveTargetTab(target, options.tabId);
    const ok = this.host.setViewportSize({ ...options, tabId: effectiveTabId });
    if (!ok) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Failed to set viewport on tab ${effectiveTabId}`);
    return {
      success: ok,
      width: options.width,
      height: options.height,
      mobile: options.mobile ?? (options.width < 600),
      presetId: `custom-${options.width}x${options.height}`,
    };
  }

  setDevicePreset(options: { presetId: string; tabId?: string }, target?: BrowserTarget): { success: boolean; presetId: string } {
    if (!this.host.setDevicePreset) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'setDevicePreset is not supported by host');
    if (!options.presetId || typeof options.presetId !== 'string') {
      throw new CapabilityError('INVALID_ARGUMENT', 'presetId is required and must be a string');
    }
    const effectiveTabId = this.resolveTargetTab(target, options.tabId);
    const ok = this.host.setDevicePreset(effectiveTabId, options.presetId);
    if (!ok) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Failed to set device preset ${options.presetId} on tab ${effectiveTabId}`);
    return { success: ok, presetId: options.presetId };
  }

  listDevicePresets(): unknown[] {
    if (!this.host.getDevicePresets) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'getDevicePresets is not supported by host');
    return this.host.getDevicePresets();
  }

  setZoom(options: { zoomFactor: number; tabId?: string }, target?: BrowserTarget): { success: boolean; zoomFactor: number } {
    if (!this.host.setZoom) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'setZoom is not supported by host');
    if (typeof options.zoomFactor !== 'number' || !Number.isFinite(options.zoomFactor) || options.zoomFactor < 0.25 || options.zoomFactor > 5.0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'zoomFactor must be a number between 0.25 and 5.0');
    }
    const effectiveTabId = this.resolveTargetTab(target, options.tabId);
    const ok = this.host.setZoom(effectiveTabId, options.zoomFactor);
    if (!ok) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Failed to set zoom on tab ${effectiveTabId}`);
    return { success: ok, zoomFactor: options.zoomFactor };
  }

  toggleInspect(): { inspecting: boolean } {
    if (!this.host.toggleInspect) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'toggleInspect is not supported by host');
    return { inspecting: this.host.toggleInspect() };
  }
  private resolveTargetTab(target?: BrowserTarget, explicitTabId?: string): string {
    const resolved = explicitTabId ?? target?.tabId ?? (this.host.getActiveTabId ? this.host.getActiveTabId() : undefined);
    if (!resolved) {
      throw new CapabilityError('INVALID_ARGUMENT', 'No tab ID specified and no active target bound');
    }
    if (!this.host.getTabList().some((tab: any) => tab && tab.id === resolved)) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown tab ID: ${resolved}`);
    }
    if (!explicitTabId && target) {
      assertTarget(target);
      this.assertCurrent(target);
    }
    return resolved;
  }

  private assertCurrent(target: BrowserTarget): void {
    if (this.host.isCurrentTarget && !this.host.isCurrentTarget(target)) throw new CapabilityError('TARGET_STALE', 'Browser target no longer matches the current tab document');
  }
}

function assertTarget(target: BrowserTarget): void {
  assertExactBrowserTarget(target, { projectId: target.projectId, workspaceId: target.workspaceId, runtimeId: target.runtimeId });
  if (!Number.isInteger(target.browserEpoch) || target.browserEpoch < 1 || !Number.isInteger(target.documentGeneration) || target.documentGeneration < 1) throw new CapabilityError('TARGET_STALE', 'Browser target epoch and document generation are required');
}

function limit(value: string, max: number): string { return value.length > max ? `${value.slice(0, max)}...[truncated:${digestText(value).slice(0, 12)}]` : value; }
