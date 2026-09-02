/**
 * AntiFan Browser Desktop — Tab Automation Host Sub-Controller
 * Encapsulates Agent Visual Cursor, Action Dispatching, Bézier Trajectory Execution,
 * Isolated World (World 1004) Script Evaluation, and Semantic Snapshot Generation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SplitPaneId } from '../../shared/contracts';
import { CapabilityError } from '../../shared/control-plane-contracts';
import { AGENT_BROWSER_SCRIPT } from './agent-browser';
import { SemanticRefRegistry, makeTargetKey, SnapshotFindResult } from './semantic-ref-registry';
import {
  buildIsolatedExecutorScript,
  buildIsolatedCollectorScript,
  ISOLATED_AGENT_WORLD_ID,
  validateActionResponse,
} from './semantic-ref-executor';
import {
  buildInspectStylesIsolatedScript,
  buildInspectRegionIsolatedScript,
} from './scripts/advanced-inspection-scripts';
import type { SemanticElementDescriptor } from './semantic-ref-types';
import { generateCollectionNonce, validateCollectionEnvelope } from './semantic-ref-types';
import type { NativeTabRecord } from './native-tab-host';
import type { TabDevToolsHost } from './tab-devtools-host';

export interface TabAutomationContext {
  getTabWebContents: (tabId?: string, paneId?: SplitPaneId) => Electron.WebContents | null;
  getTabRecord: (tabId: string) => NativeTabRecord | undefined;
  getAutomationTabId: () => string | null;
  getActiveTabId: () => string;
  getBrowserEpoch: () => number;
  getSemanticDocumentGeneration: (tabId: string, paneId?: string) => number;
  getLegacyDocumentGeneration?: (tabId: string) => number;
  semanticRefRegistry: SemanticRefRegistry;
  runTargetOperation: <T>(tabId: string, paneId: SplitPaneId | undefined, operation: () => Promise<T>) => Promise<T>;
  broadcastState: () => void;
  syncFrameBackdrop: () => void;
  getAllTabs: () => IterableIterator<[string, NativeTabRecord]>;
  applyTabThrottling?: () => void;
  tabDevToolsHost?: TabDevToolsHost;
  resolveTargetWorkspace?: (targetSessionId?: string, tabUrl?: string) => string;
  getTabTerminalSession?: (tabId: string) => string | undefined;
}

function validatePathConfinement(rawFilePath: string, rawWorkspaceRoot: string): string {
  if (typeof rawFilePath !== 'string' || !rawFilePath.trim()) {
    throw new CapabilityError('INVALID_ARGUMENT', 'File path must be a non-empty string');
  }
  if (typeof rawWorkspaceRoot !== 'string' || !rawWorkspaceRoot.trim()) {
    throw new CapabilityError('WORKSPACE_UNBOUND', 'No authoritative workspace root bound to target tab');
  }

  const absPath = path.resolve(rawFilePath);
  const absRoot = path.resolve(rawWorkspaceRoot);

  if (!fs.existsSync(absPath)) {
    throw new CapabilityError('INVALID_ARGUMENT', `File does not exist on disk: ${rawFilePath}`);
  }
  if (!fs.existsSync(absRoot)) {
    throw new CapabilityError('WORKSPACE_UNBOUND', `Authoritative workspace root does not exist on disk: ${rawWorkspaceRoot}`);
  }

  const realFile = fs.realpathSync(absPath);
  const realRoot = fs.realpathSync(absRoot);

  const rel = path.relative(realRoot, realFile);
  const isEscaped =
    rel.startsWith('..') ||
    path.isAbsolute(rel) ||
    (process.platform === 'win32' && /^[a-zA-Z]:/.test(rel));

  if (isEscaped) {
    throw new CapabilityError(
      'OUTSIDE_WORKSPACE',
      `Access denied: File path "${rawFilePath}" escapes authoritative workspace root "${rawWorkspaceRoot}"`
    );
  }

  return realFile;
}

export class TabAutomationHost {
  private readonly ctx: TabAutomationContext;
  public agentWorkingTimers = new Map<string, NodeJS.Timeout>();
  public agentWorkingRefs = new Map<string, number>();

  constructor(ctx: TabAutomationContext) {
    this.ctx = ctx;
  }

  public activateAgentVisualGlow(tabId: string): void {
    const tab = this.ctx.getTabRecord(tabId);
    if (!tab) return;
    const script = `(() => {
      try {
        if (typeof window.__antifanAgentActive === 'function') {
          window.__antifanAgentActive();
        }
      } catch {}
    })()`;
    if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.executeJavaScript(script).catch(() => {});
    }
    if (tab.mobileView?.webContents && !tab.mobileView.webContents.isDestroyed()) {
      tab.mobileView.webContents.executeJavaScript(script).catch(() => {});
    }
    this.ctx.syncFrameBackdrop();
  }

  public deactivateAgentVisualGlow(tabId: string): void {
    const tab = this.ctx.getTabRecord(tabId);
    if (!tab) return;
    const script = `(() => {
      try {
        if (typeof window.__antifanAgentClear === 'function') {
          window.__antifanAgentClear();
        }
      } catch {}
    })()`;
    if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.executeJavaScript(script).catch(() => {});
    }
    if (tab.mobileView?.webContents && !tab.mobileView.webContents.isDestroyed()) {
      tab.mobileView.webContents.executeJavaScript(script).catch(() => {});
    }
    this.ctx.syncFrameBackdrop();
  }

  public beginTabAgentWorking(tabId: string): void {
    const target = this.ctx.getTabRecord(tabId);
    if (!target) return;
    this.agentWorkingRefs.set(tabId, (this.agentWorkingRefs.get(tabId) || 0) + 1);
    if (target.state.aiState !== 'agent_working') {
      target.state.aiState = 'agent_working';
      this.ctx.broadcastState();
      this.ctx.applyTabThrottling?.();
    }
    this.activateAgentVisualGlow(tabId);
  }
  public clearTabAgentWorking(tabId: string): void {
    const timer = this.agentWorkingTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.agentWorkingTimers.delete(tabId);
    this.agentWorkingRefs.delete(tabId);
    this.deactivateAgentVisualGlow(tabId);
    this.ctx.applyTabThrottling?.();
  }
  public endTabAgentWorking(tabId: string): void {
    const refs = (this.agentWorkingRefs.get(tabId) || 0) - 1;
    if (refs > 0) {
      this.agentWorkingRefs.set(tabId, refs);
      return;
    }
    this.agentWorkingRefs.delete(tabId);
    if (!this.agentWorkingTimers.has(tabId)) {
      const target = this.ctx.getTabRecord(tabId);
      if (target?.state.aiState === 'agent_working') {
        target.state.aiState = 'idle';
        this.ctx.broadcastState();
        this.ctx.applyTabThrottling?.();
      }
      this.deactivateAgentVisualGlow(tabId);
    }
  }

  public async withTabAgentWorking<T>(tabId: string, action: () => Promise<T>): Promise<T> {
    this.beginTabAgentWorking(tabId);
    try {
      return await action();
    } finally {
      this.endTabAgentWorking(tabId);
    }
  }

  public markTabAgentWorking(tabId?: string, durationMs = 5000): void {
    const targetId = tabId || this.ctx.getActiveTabId();
    const tab = this.ctx.getTabRecord(targetId);
    if (!tab) return;

    tab.state.aiState = 'agent_working';
    this.ctx.broadcastState();
    this.ctx.applyTabThrottling?.();
    this.activateAgentVisualGlow(targetId);

    const existingTimer = this.agentWorkingTimers.get(targetId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      if ((this.agentWorkingRefs.get(targetId) || 0) === 0) {
        const current = this.ctx.getTabRecord(targetId);
        if (current?.state.aiState === 'agent_working') {
          current.state.aiState = 'idle';
          this.ctx.broadcastState();
          this.ctx.applyTabThrottling?.();
        }
        this.deactivateAgentVisualGlow(targetId);
      }
      this.agentWorkingTimers.delete(targetId);
    }, durationMs);
    if (typeof timer?.unref === 'function') {
      timer.unref();
    }

    this.agentWorkingTimers.set(targetId, timer);
  }
  public setTabAiState(tabId: string, aiState: 'idle' | 'thinking' | 'streaming' | 'completed' | 'agent_working'): void {
    const tab = this.ctx.getTabRecord(tabId);
    if (!tab) return;
    tab.state.aiState = aiState;
    this.ctx.broadcastState();
    this.ctx.applyTabThrottling?.();
  }
  public clearAllAgentWorking(): void {
    for (const [, timer] of this.agentWorkingTimers.entries()) {
      clearTimeout(timer);
    }
    this.agentWorkingTimers.clear();
    this.agentWorkingRefs.clear();
    for (const [tabId, tab] of this.ctx.getAllTabs()) {
      if (tab.state.aiState === 'agent_working') {
        tab.state.aiState = 'idle';
      }
      this.deactivateAgentVisualGlow(tabId);
    }
    this.ctx.broadcastState();
    this.ctx.syncFrameBackdrop();
    this.ctx.applyTabThrottling?.();
  }

  public async ensureAgentBrowserInjected(tabId?: string, paneId?: SplitPaneId): Promise<boolean> {
    const targetId = tabId || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) return false;
    const wc = this.ctx.getTabWebContents(target.state.id, paneId || target.focusedPane);
    if (!wc) return false;
    try {
      await wc.executeJavaScript(AGENT_BROWSER_SCRIPT);
      return true;
    } catch {
      return false;
    }
  }
  public async executeInIsolatedWorld(wc: Electron.WebContents, script: string): Promise<unknown> {
    if ((wc as any).mainFrame && typeof (wc as any).mainFrame.executeJavaScriptInIsolatedWorld === 'function') {
      return await (wc as any).mainFrame.executeJavaScriptInIsolatedWorld(ISOLATED_AGENT_WORLD_ID, [{ code: script }]);
    }
    if (typeof (wc as any).executeJavaScriptInIsolatedWorld === 'function') {
      return await (wc as any).executeJavaScriptInIsolatedWorld(ISOLATED_AGENT_WORLD_ID, [{ code: script }]);
    }
    throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Isolated world execution (world 1004) is not supported in this WebContents environment');
  }
  private async executeTrustedType(
    wc: Electron.WebContents,
    focusScript: string,
    text: string,
    clear?: boolean
  ): Promise<{ success: boolean; data?: unknown; reason?: string }> {
    // 1. Focus element and select in isolated world
    const rawRes = await this.executeInIsolatedWorld(wc, focusScript);
    const res = validateActionResponse(rawRes);
    if (!res.ok) {
      return { success: false, reason: res.error || 'Failed to focus element for trusted type' };
    }

    // 2. Attach debugger if needed
    if (!wc.debugger) {
      return { success: false, reason: 'Debugger interface not available on WebContents' };
    }
    if (!wc.debugger.isAttached()) {
      try {
        wc.debugger.attach('1.3');
      } catch (attachErr) {
        return {
          success: false,
          reason: `Failed to attach debugger for trusted input: ${attachErr instanceof Error ? attachErr.message : String(attachErr)}`,
        };
      }
    }

    // 3. If clear is requested, send CDP SelectAll + Backspace to generate authentic trusted deletion events
    if (clear) {
      try {
        const isMac = process.platform === 'darwin';
        const modifierFlag = isMac ? 4 : 2; // Meta (4) on Darwin, Control (2) on Win/Linux
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          modifiers: modifierFlag,
          windowsVirtualKeyCode: 65,
          code: 'KeyA',
          key: 'a',
        });
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          modifiers: modifierFlag,
          windowsVirtualKeyCode: 65,
          code: 'KeyA',
          key: 'a',
        });
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          windowsVirtualKeyCode: 8,
          code: 'Backspace',
          key: 'Backspace',
        });
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          windowsVirtualKeyCode: 8,
          code: 'Backspace',
          key: 'Backspace',
        });
      } catch (clearErr) {
        return {
          success: false,
          reason: `CDP trusted clear failed: ${clearErr instanceof Error ? clearErr.message : String(clearErr)}`,
        };
      }
    }
    // 4. Issue CDP Input.insertText exactly once
    try {
      await wc.debugger.sendCommand('Input.insertText', { text });
      return { success: true, data: { ok: true, executed: true, tier: 'cdp_trusted', rect: res.rect } };
    } catch (cdpErr) {
      return {
        success: false,
        reason: `CDP Input.insertText failed: ${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}`,
      };
    }
  }

  private async executeTrustedClick(
    wc: Electron.WebContents,
    focusScript?: string,
    x?: number,
    y?: number
  ): Promise<{ success: boolean; data?: unknown; reason?: string; fallbackNeeded?: boolean; executionTier?: 'cdp_trusted' | 'isolated_synthetic' }> {
    let clickX = x;
    let clickY = y;
    let rect: { x: number; y: number; width: number; height: number; centerX?: number; centerY?: number } | undefined = undefined;

    if (focusScript) {
      const rawRes = await this.executeInIsolatedWorld(wc, focusScript);
      const res = validateActionResponse(rawRes);
      if (!res.ok) {
        return { success: false, reason: res.error || 'Failed to resolve element for trusted click', fallbackNeeded: true };
      }
      rect = res.rect;
      if (typeof clickX !== 'number' || typeof clickY !== 'number') {
        if (rect && typeof rect.centerX === 'number' && typeof rect.centerY === 'number') {
          clickX = rect.centerX;
          clickY = rect.centerY;
        }
      }
    }

    if (typeof clickX !== 'number' || typeof clickY !== 'number') {
      return { success: false, reason: 'Coordinates could not be resolved for CDP click', fallbackNeeded: true };
    }

    if (!wc.debugger) {
      return { success: false, fallbackNeeded: true, reason: 'Debugger interface not available' };
    }

    if (!wc.debugger.isAttached()) {
      try {
        wc.debugger.attach('1.3');
      } catch (attachErr) {
        console.warn(`[tab-automation-host] wc.debugger busy, using synthetic click fallback: ${attachErr instanceof Error ? attachErr.message : String(attachErr)}`);
        return { success: false, fallbackNeeded: true, reason: 'Debugger busy' };
      }
    }

    let dispatchStage: 'none' | 'moved' | 'pressed' | 'released' = 'none';
    try {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: clickX,
        y: clickY,
      });
      dispatchStage = 'moved';

      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: clickX,
        y: clickY,
        button: 'left',
        clickCount: 1,
      });
      dispatchStage = 'pressed';

      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: clickX,
        y: clickY,
        button: 'left',
        clickCount: 1,
      });
      dispatchStage = 'released';

      return {
        success: true,
        executionTier: 'cdp_trusted',
        data: { ok: true, executed: true, tier: 'cdp_trusted', executionTier: 'cdp_trusted', x: clickX, y: clickY, rect },
      };
    } catch (cdpErr) {
      const errMsg = cdpErr instanceof Error ? cdpErr.message : String(cdpErr);
      if (dispatchStage === 'pressed') {
        try {
          await Promise.race([
            wc.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: clickX,
              y: clickY,
              button: 'left',
              clickCount: 1,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Cleanup release timed out')), 1000)),
          ]);
        } catch {
          // Bounded cleanup error ignored
        }
        // Never cross tiers after button press emitted
        return {
          success: false,
          fallbackNeeded: false,
          executionTier: 'cdp_trusted',
          reason: `CDP mouse release failed after mousePressed: ${errMsg}`,
        };
      }

      return {
        success: false,
        fallbackNeeded: true,
        executionTier: 'cdp_trusted',
        reason: `CDP dispatch failed: ${errMsg}`,
      };
    }
  }

  private async executeTrustedHover(
    wc: Electron.WebContents,
    focusScript?: string,
    x?: number,
    y?: number
  ): Promise<{ success: boolean; data?: unknown; reason?: string; fallbackNeeded?: boolean; executionTier?: 'cdp_trusted' | 'isolated_synthetic' }> {
    let hoverX = x;
    let hoverY = y;
    let rect: { x: number; y: number; width: number; height: number; centerX?: number; centerY?: number } | undefined = undefined;

    if (focusScript) {
      const rawRes = await this.executeInIsolatedWorld(wc, focusScript);
      const res = validateActionResponse(rawRes);
      if (!res.ok) {
        return { success: false, reason: res.error || 'Failed to resolve element for trusted hover', fallbackNeeded: true };
      }
      rect = res.rect;
      if (typeof hoverX !== 'number' || typeof hoverY !== 'number') {
        if (rect && typeof rect.centerX === 'number' && typeof rect.centerY === 'number') {
          hoverX = rect.centerX;
          hoverY = rect.centerY;
        }
      }
    }

    if (typeof hoverX !== 'number' || typeof hoverY !== 'number') {
      return { success: false, reason: 'Coordinates could not be resolved for CDP hover', fallbackNeeded: true };
    }
    if (!wc.debugger) {
      return { success: false, fallbackNeeded: true, reason: 'Debugger interface not available' };
    }

    if (!wc.debugger.isAttached()) {
      try {
        wc.debugger.attach('1.3');
      } catch (attachErr) {
        console.warn(`[tab-automation-host] wc.debugger busy, using synthetic hover fallback: ${attachErr instanceof Error ? attachErr.message : String(attachErr)}`);
        return { success: false, fallbackNeeded: true, reason: 'Debugger busy' };
      }
    }

    try {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: hoverX,
        y: hoverY,
      });
      return {
        success: true,
        executionTier: 'cdp_trusted',
        data: { ok: true, executed: true, tier: 'cdp_trusted', executionTier: 'cdp_trusted', x: hoverX, y: hoverY, rect },
      };
    } catch (cdpErr) {
      console.warn(`[tab-automation-host] CDP Input.dispatchMouseEvent (mouseMoved) failed, using fallback: ${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}`);
      return {
        success: false,
        fallbackNeeded: true,
        executionTier: 'cdp_trusted',
        reason: `CDP dispatch failed: ${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}`,
      };
    }
  }
  public async dispatchAgentAction(
    action: 'click' | 'type' | 'move' | 'hover' | 'scroll' | 'highlight' | 'clear' | 'trajectory',
    params: {
      selector?: string;
      ref?: string;
      x?: number;
      y?: number;
      text?: string;
      clear?: boolean;
      trusted?: boolean;
      deltaY?: number;
      label?: string;
      tabId?: string;
      paneId?: SplitPaneId;
      steps?: Array<Record<string, unknown>>;
      speed?: 'fast' | 'natural' | 'slow';
      smoothScroll?: boolean;
    }
  ): Promise<{ success: boolean; data?: unknown; reason?: string }> {
    const targetId = params.tabId || this.ctx.getAutomationTabId() || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) {
      return { success: false, reason: `Tab '${targetId}' not found` };
    }

    const splitHasLiveMobile = Boolean(target.state.splitMode && target.mobileView && !target.mobileView.webContents.isDestroyed());
    const effectivePane: SplitPaneId = params.paneId || (splitHasLiveMobile ? (target.focusedPane || target.state.splitFocusedPane || 'desktop') : 'desktop');

    // 1. Ref Mode — Strict Fail-Closed Main Resolution & Synchronous World-1004 Execution
    if (typeof params.ref === 'string' && params.ref.trim().length > 0) {
      const refToken = params.ref.trim();

      return this.withTabAgentWorking(targetId, async () => {
        return await this.ctx.runTargetOperation(targetId, effectivePane, async () => {
          const curTab = this.ctx.getTabRecord(targetId);
          if (!curTab) return { success: false, reason: 'Tab closed' };
          const wc = this.ctx.getTabWebContents(targetId, effectivePane);
          if (!wc || wc.isDestroyed()) return { success: false, reason: 'WebContents destroyed' };

          const curEpoch = this.ctx.getBrowserEpoch();
          const curGen = this.ctx.getSemanticDocumentGeneration(targetId, effectivePane);
          const curUrl = wc.getURL();

          let descriptor: SemanticElementDescriptor;
          try {
            if (!this.ctx.semanticRefRegistry) {
              throw new CapabilityError('RUNTIME_DRAINING', 'Ref registry is not available');
            }
            descriptor = this.ctx.semanticRefRegistry.resolveRef({
              tabId: targetId,
              paneId: effectivePane,
              browserEpoch: curEpoch,
              documentGeneration: curGen,
              documentUrl: curUrl,
            }, refToken);
          } catch (err: unknown) {
            const reason = err instanceof Error ? err.message : String(err);
            return { success: false, reason };
          }

          if (this.ctx.getSemanticDocumentGeneration(targetId, effectivePane) !== curGen || wc.isDestroyed()) {
            return { success: false, reason: 'Document navigated during preflight' };
          }

          try {
            if (params.trusted !== false && action === 'click') {
              const focusScript = buildIsolatedExecutorScript({
                action: 'focus',
                ref: refToken,
                descriptor,
                documentUrl: curUrl,
                nonce: descriptor.nonce,
              });
              const trustedRes = await this.executeTrustedClick(wc, focusScript, params.x, params.y);
              if (trustedRes.success) {
                if (this.ctx.getSemanticDocumentGeneration(targetId, effectivePane) !== curGen || wc.isDestroyed()) {
                  return { success: false, reason: 'Document navigated during action execution' };
                }
                return trustedRes;
              }
              if (!trustedRes.fallbackNeeded) {
                return trustedRes;
              }
            }

            if (params.trusted !== false && action === 'hover') {
              const focusScript = buildIsolatedExecutorScript({
                action: 'focus',
                ref: refToken,
                descriptor,
                documentUrl: curUrl,
                nonce: descriptor.nonce,
              });
              const trustedRes = await this.executeTrustedHover(wc, focusScript, params.x, params.y);
              if (trustedRes.success) {
                if (this.ctx.getSemanticDocumentGeneration(targetId, effectivePane) !== curGen || wc.isDestroyed()) {
                  return { success: false, reason: 'Document navigated during action execution' };
                }
                return trustedRes;
              }
              if (!trustedRes.fallbackNeeded) {
                return trustedRes;
              }
            }
            if (params.trusted && action === 'type' && typeof params.text === 'string') {
              const focusScript = buildIsolatedExecutorScript({
                action: 'focus',
                ref: refToken,
                descriptor,
                clear: params.clear,
                documentUrl: curUrl,
                nonce: descriptor.nonce,
              });
              const trustedRes = await this.executeTrustedType(wc, focusScript, params.text, params.clear);
              if (this.ctx.getSemanticDocumentGeneration(targetId, effectivePane) !== curGen || wc.isDestroyed()) {
                return { success: false, reason: 'Document navigated during action execution' };
              }
              return trustedRes;
            }

            const script = buildIsolatedExecutorScript({
              action: action as any,
              ref: refToken,
              descriptor,
              text: params.text,
              clear: params.clear,
              trusted: params.trusted,
              deltaY: params.deltaY,
              documentUrl: curUrl,
              nonce: descriptor.nonce,
            });

            const rawRes = await this.executeInIsolatedWorld(wc, script);
            const res = validateActionResponse(rawRes);

            if (this.ctx.getSemanticDocumentGeneration(targetId, effectivePane) !== curGen || wc.isDestroyed()) {
              return { success: false, reason: 'Document navigated during action execution' };
            }

            if (!res.ok) {
              return { success: false, reason: res.error, data: { ...res, executionTier: 'isolated_synthetic' } };
            }

            return { success: res.executed, data: { ...res, executionTier: 'isolated_synthetic' } };
          } catch (err: unknown) {
            const reason = err instanceof Error ? err.message : String(err);
            return { success: false, reason };
          }
        });
      });
    }

    // 2. Explicit Selector / Coordinate / Non-ref Mode (FIFO synchronized with target operations)
    return this.withTabAgentWorking(targetId, async () => {
      return await this.ctx.runTargetOperation(targetId, effectivePane, async () => {
        const wc = this.ctx.getTabWebContents(targetId, effectivePane);
        if (!wc || wc.isDestroyed()) return { success: false, reason: 'WebContents destroyed' };

        try {
          if (action === 'trajectory') {
            const trajRes = await this.agentTrajectoryInternal(params, effectivePane);
            return { success: Boolean(trajRes.success), data: trajRes };
          }
          if (action === 'clear') {
            await this.executeInIsolatedWorld(wc, `(() => {
              const ids = ['__antifan_agent_overlay__', '__antifan_agent_cursor__', '__antifan_agent_highlight__', '__antifan_agent_banner__', '__antifan_agent_style__'];
              for (let i = 0; i < ids.length; i++) {
                const el = document.getElementById(ids[i]);
                if (el) el.remove();
              }
              return { ok: true, executed: true };
            })()`);
            return { success: true };
          }
          if (params.trusted !== false && action === 'click') {
            const focusScript = params.selector ? buildIsolatedExecutorScript({
              action: 'focus',
              selector: params.selector,
              x: params.x,
              y: params.y,
              documentUrl: wc.getURL(),
              nonce: generateCollectionNonce(),
            }) : undefined;
            const curGen = this.ctx.getSemanticDocumentGeneration(targetId, effectivePane);
            const trustedRes = await this.executeTrustedClick(wc, focusScript, params.x, params.y);
            if (trustedRes.success) {
              if (this.ctx.getSemanticDocumentGeneration(targetId, effectivePane) !== curGen || wc.isDestroyed()) {
                return { success: false, reason: 'Document navigated during action execution' };
              }
              return trustedRes;
            }
            if (!trustedRes.fallbackNeeded) {
              return trustedRes;
            }
          }

          if (params.trusted !== false && action === 'hover') {
            const focusScript = params.selector ? buildIsolatedExecutorScript({
              action: 'focus',
              selector: params.selector,
              x: params.x,
              y: params.y,
              documentUrl: wc.getURL(),
              nonce: generateCollectionNonce(),
            }) : undefined;
            const curGen = this.ctx.getSemanticDocumentGeneration(targetId, effectivePane);
            const trustedRes = await this.executeTrustedHover(wc, focusScript, params.x, params.y);
            if (trustedRes.success) {
              if (this.ctx.getSemanticDocumentGeneration(targetId, effectivePane) !== curGen || wc.isDestroyed()) {
                return { success: false, reason: 'Document navigated during action execution' };
              }
              return trustedRes;
            }
            if (!trustedRes.fallbackNeeded) {
              return trustedRes;
            }
          }
          if (params.trusted && action === 'type' && typeof params.text === 'string') {
            const focusScript = buildIsolatedExecutorScript({
              action: 'focus',
              selector: params.selector,
              x: params.x,
              y: params.y,
              clear: params.clear,
              documentUrl: wc.getURL(),
              nonce: generateCollectionNonce(),
            });
            const curGen = this.ctx.getSemanticDocumentGeneration(targetId, effectivePane);
            const trustedRes = await this.executeTrustedType(wc, focusScript, params.text, params.clear);
            if (this.ctx.getSemanticDocumentGeneration(targetId, effectivePane) !== curGen || wc.isDestroyed()) {
              return { success: false, reason: 'Document navigated during action execution' };
            }
            return trustedRes;
          }

          const script = buildIsolatedExecutorScript({
            action: action as any,
            selector: params.selector,
            x: params.x,
            y: params.y,
            text: params.text,
            clear: params.clear,
            deltaY: params.deltaY,
            documentUrl: wc.getURL(),
            nonce: generateCollectionNonce(),
          });
          const rawRes = await this.executeInIsolatedWorld(wc, script);
          const res = validateActionResponse(rawRes);
          if (!res.ok) {
            return { success: false, reason: res.error, data: { ...res, executionTier: 'isolated_synthetic' } };
          }
          return { success: res.executed, data: { ...res, executionTier: 'isolated_synthetic' } };
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          return { success: false, reason };
        }
      });
    });
  }

  public async agentClick(params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const res = await this.dispatchAgentAction('click', params);
    return res.success;
  }

  public async agentType(params: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const res = await this.dispatchAgentAction('type', params);
    return res.success;
  }
  public async agentScroll(params: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const res = await this.dispatchAgentAction('scroll', params);
    return res.success;
  }

  public async agentHover(params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const res = await this.dispatchAgentAction('hover', params);
    return res.success;
  }

  public async agentMove(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    return this.agentHover(args);
  }

  public async agentHighlight(params: { selector?: string; ref?: string; label?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const res = await this.dispatchAgentAction('highlight', params as any);
    return res.success;
  }

  public async agentClear(tabId?: string, paneId?: SplitPaneId): Promise<boolean> {
    const target = this.ctx.getTabRecord(tabId || this.ctx.getAutomationTabId() || this.ctx.getActiveTabId());
    if (!target) return false;
    const wc = this.ctx.getTabWebContents(target.state.id, paneId || target.focusedPane);
    if (!wc) return false;
    try {
      await wc.executeJavaScript(`(() => {
        if (window.__antifanAgentClear) {
          window.__antifanAgentClear();
        }
      })()`);
      return true;
    } catch {
      return false;
    }
  }

  public async agentTrajectoryInternal(
    params: { steps?: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: SplitPaneId },
    paneId?: SplitPaneId
  ): Promise<Record<string, unknown>> {
    const targetId = params?.tabId || this.ctx.getAutomationTabId() || this.ctx.getActiveTabId();
    const steps = Array.isArray(params?.steps) ? params.steps : null;
    const totalSteps = steps ? steps.length : 0;
    if (!steps || totalSteps === 0) {
      return { success: false, executedSteps: 0, totalSteps: 0, reason: 'Missing or invalid steps array' };
    }
    let normalizedSteps: Array<Record<string, unknown>>;
    try {
      normalizedSteps = steps.map((step, index) => {
        if (!step || typeof step !== 'object') throw new Error(`Trajectory step ${index} must be an object`);
        const candidate = step as Record<string, unknown>;
        const action = candidate.action || candidate.type;
        if (action !== 'move' && action !== 'hover' && action !== 'click' && action !== 'type' && action !== 'scroll') {
          throw new Error(`Unsupported trajectory action at step ${index}: ${String(action || 'missing')}`);
        }
        return { ...candidate, action };
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Invalid trajectory steps';
      return { success: false, executedSteps: 0, totalSteps, reason };
    }

    const tab = this.ctx.getTabRecord(targetId);
    if (!tab) {
      return { success: false, executedSteps: 0, totalSteps, reason: 'Target tab is unavailable' };
    }
    const effectivePane = paneId || params?.paneId || (tab.state.splitMode ? (tab.focusedPane || tab.state.splitFocusedPane || 'desktop') : 'desktop');
    const wc = this.ctx.getTabWebContents(targetId, effectivePane);
    if (!wc || wc.isDestroyed()) {
      return { success: false, executedSteps: 0, totalSteps, reason: 'Target webContents is unavailable' };
    }

    const generationBefore = this.ctx.getSemanticDocumentGeneration(targetId, effectivePane);
    const legacyDocGenBefore = this.ctx.getLegacyDocumentGeneration?.(targetId) || 0;
    const urlBefore = wc.getURL();

    if (!await this.ensureAgentBrowserInjected(targetId, effectivePane)) {
      return { success: false, executedSteps: 0, totalSteps, reason: 'Agent browser injection failed' };
    }

    try {
      const result = await wc.executeJavaScript(`window.__antifanAgentTrajectory(${JSON.stringify(normalizedSteps)}, ${JSON.stringify({ speed: params?.speed, smoothScroll: params?.smoothScroll })})`);
      const generationChanged = this.ctx.getSemanticDocumentGeneration(targetId, effectivePane) !== generationBefore || (this.ctx.getLegacyDocumentGeneration?.(targetId) || 0) !== legacyDocGenBefore;
      const urlChanged = wc.isDestroyed() || wc.getURL() !== urlBefore;
      const obj = result && typeof result === 'object' ? result as Record<string, unknown> : null;
      const rawExecuted = obj?.executedSteps;
      const rawTotal = obj?.totalSteps;
      const hasValidExecuted = typeof rawExecuted === 'number' && Number.isInteger(rawExecuted) && rawExecuted >= 0 && rawExecuted <= totalSteps;
      const hasValidTotal = typeof rawTotal === 'number' && Number.isInteger(rawTotal) && rawTotal === totalSteps;
      const executedSteps = hasValidExecuted ? rawExecuted as number : 0;
      const invalidResult = !obj || typeof obj.success !== 'boolean' || !hasValidExecuted || !hasValidTotal;
      const countsMatch = hasValidExecuted && hasValidTotal && executedSteps === totalSteps;
      const interrupted = generationChanged || urlChanged;
      const reason = interrupted
        ? (typeof obj?.reason === 'string' ? obj.reason : 'Interrupted by navigation or document change')
        : invalidResult
          ? 'Trajectory returned an invalid result'
          : !countsMatch
            ? (typeof obj?.reason === 'string' ? obj.reason : 'Trajectory did not complete all steps')
            : (typeof obj?.reason === 'string' ? obj.reason : undefined);
      return {
        ...(obj || {}),
        success: !interrupted && !invalidResult && countsMatch && obj?.success === true,
        executedSteps,
        totalSteps,
        ...(reason ? { reason } : {}),
      };
    } catch (err) {
      console.error('[tab-automation-host] agentTrajectory error:', err);
      return { success: false, executedSteps: 0, totalSteps, reason: 'Trajectory execution failed' };
    }
  }

  public async agentTrajectory(params: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: SplitPaneId }): Promise<Record<string, unknown>> {
    const res = await this.dispatchAgentAction('trajectory', params);
    if (res.data && typeof res.data === 'object') {
      return res.data as Record<string, unknown>;
    }
    return { success: res.success, executedSteps: 0, totalSteps: params?.steps?.length || 0, reason: res.reason };
  }

  private async internalCollectSnapshot(targetId: string, effectivePane: SplitPaneId, selector?: string): Promise<string> {
    const curTab = this.ctx.getTabRecord(targetId);
    if (!curTab) return '';
    const curWc = this.ctx.getTabWebContents(targetId, effectivePane);
    if (!curWc || curWc.isDestroyed()) return '';

    const curEpoch = this.ctx.getBrowserEpoch();
    const curGen = this.ctx.getSemanticDocumentGeneration(targetId, effectivePane);
    const curUrl = curWc.getURL();

    let collectionSession;
    try {
      if (!this.ctx.semanticRefRegistry) {
        return '';
      }
      collectionSession = this.ctx.semanticRefRegistry.beginCollection({
        tabId: targetId,
        paneId: effectivePane,
        browserEpoch: curEpoch,
        documentGeneration: curGen,
        documentUrl: curUrl,
      });
    } catch (err: unknown) {
      console.error('[tab-automation-host] beginCollection error:', err);
      return '';
    }

    try {
      const collectorScript = buildIsolatedCollectorScript(collectionSession.nonce, curUrl, selector);
      const rawRes = await this.executeInIsolatedWorld(curWc, collectorScript);
      const rawDescriptors = validateCollectionEnvelope(rawRes, collectionSession.nonce, curUrl);

      if (this.ctx.getSemanticDocumentGeneration(targetId, effectivePane) !== curGen || curWc.isDestroyed() || curWc.getURL() !== curUrl) {
        this.ctx.semanticRefRegistry.invalidateTarget(targetId, effectivePane);
        return '';
      }

      const published = this.ctx.semanticRefRegistry.publishSnapshot({
        tabId: targetId,
        paneId: effectivePane,
        nonce: collectionSession.nonce,
        sequence: collectionSession.sequence,
        browserEpoch: curEpoch,
        documentGeneration: curGen,
        documentUrl: curUrl,
        rawDescriptors,
      });

      return published.formattedText;
    } catch (err: unknown) {
      this.ctx.semanticRefRegistry.invalidateTarget(targetId, effectivePane);
      const msg = err instanceof Error ? err.message : String(err || 'isolated collection failed');
      return `[Semantic Snapshot Error: ${msg}]`;
    }
  }

  public async agentSnapshot(tabId?: string, paneId?: SplitPaneId, selector?: string): Promise<string> {
    const targetId = tabId || this.ctx.getAutomationTabId() || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) return '';
    const splitHasLiveMobile = Boolean(target.state.splitMode && target.mobileView && !target.mobileView.webContents.isDestroyed());
    const effectivePane: SplitPaneId = paneId || (splitHasLiveMobile ? (target.focusedPane || target.state.splitFocusedPane || 'desktop') : 'desktop');
    const wc = this.ctx.getTabWebContents(targetId, effectivePane);
    if (!wc || wc.isDestroyed()) return '';
    return await this.ctx.runTargetOperation(targetId, effectivePane, async () => {
      return await this.internalCollectSnapshot(targetId, effectivePane, selector);
    });
  }

  public async agentFind(params: {
    text?: string;
    regex?: string;
    tabId?: string;
    paneId?: SplitPaneId;
    maxMatches?: number;
  }): Promise<SnapshotFindResult> {
    const targetId = params.tabId || this.ctx.getAutomationTabId() || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) {
      throw new CapabilityError('TARGET_STALE', `Target tab not found: ${targetId}`);
    }

    const splitHasLiveMobile = Boolean(target.state.splitMode && target.mobileView && !target.mobileView.webContents.isDestroyed());
    const effectivePane: SplitPaneId = params.paneId || (splitHasLiveMobile ? (target.focusedPane || target.state.splitFocusedPane || 'desktop') : 'desktop');
    const wc = this.ctx.getTabWebContents(targetId, effectivePane);
    if (!wc || wc.isDestroyed()) {
      throw new CapabilityError('TARGET_STALE', `WebContents destroyed for tab ${targetId}`);
    }

    return await this.ctx.runTargetOperation(targetId, effectivePane, async () => {
      const curEpoch = this.ctx.getBrowserEpoch();
      const curGen = this.ctx.getSemanticDocumentGeneration(targetId, effectivePane);
      const curUrl = wc.getURL();

      const existing = this.ctx.semanticRefRegistry.getActiveRecord({
        tabId: targetId,
        paneId: effectivePane,
        browserEpoch: curEpoch,
        documentGeneration: curGen,
        documentUrl: curUrl,
      });

      if (!existing || existing.descriptors.size === 0) {
        await this.internalCollectSnapshot(targetId, effectivePane);
      }

      return this.ctx.semanticRefRegistry.findInSnapshot({
        tabId: targetId,
        paneId: effectivePane,
        text: params.text,
        regex: params.regex,
        maxMatches: params.maxMatches,
      });
    });
  }

  public async uploadFileInput(
    refOrSelector: string,
    filePaths: string[],
    tabId?: string,
    paneId?: SplitPaneId
  ): Promise<{ success: boolean; uploadedCount: number; reason?: string }> {
    const targetId = tabId || this.ctx.getAutomationTabId() || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) return { success: false, uploadedCount: 0, reason: 'Target tab not found' };

    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return { success: false, uploadedCount: 0, reason: 'filePaths array is required and must not be empty' };
    }

    const targetSessionId = this.ctx.getTabTerminalSession?.(targetId);
    const curTabUrl = target.state?.url || '';
    const targetWorkspace = this.ctx.resolveTargetWorkspace?.(targetSessionId, curTabUrl) || '';
    if (!targetWorkspace) {
      throw new CapabilityError('WORKSPACE_UNBOUND', 'No authoritative workspace bound to target tab session');
    }

    const resolvedPaths = filePaths.map((p) => validatePathConfinement(p, targetWorkspace));
    const splitHasLiveMobile = Boolean(target.state.splitMode && target.mobileView && !target.mobileView.webContents.isDestroyed());
    const effectivePane: SplitPaneId = paneId || (splitHasLiveMobile ? (target.focusedPane || target.state.splitFocusedPane || 'desktop') : 'desktop');
    const wc = this.ctx.getTabWebContents(targetId, effectivePane);
    if (!wc || wc.isDestroyed()) return { success: false, uploadedCount: 0, reason: 'WebContents destroyed' };

    return await this.ctx.runTargetOperation(targetId, effectivePane, async () => {
      let resolvedObjectId: string | undefined;
      let resolvedNodeId: number | undefined;
      const targetRef = String(refOrSelector || '').trim();
      if (!targetRef) {
        throw new CapabilityError('INVALID_ARGUMENT', 'refOrSelector is required for uploadFileInput');
      }
      const isRef = targetRef.startsWith('@') || /^e\d+$/i.test(targetRef);

      if (!this.ctx.tabDevToolsHost) {
        throw new CapabilityError('CAPABILITY_NOT_FOUND', 'CDP TabDevToolsHost is required for file upload');
      }

      if (isRef) {
        if (!this.ctx.semanticRefRegistry) {
          throw new CapabilityError('REF_NOT_FOUND', `Semantic ref registry unavailable for ${refOrSelector}`);
        }
        const normRef = targetRef.startsWith('@') ? targetRef : `@${targetRef}`;
        const curEpoch = this.ctx.getBrowserEpoch();
        const curGen = this.ctx.getSemanticDocumentGeneration(targetId, effectivePane);
        const curUrl = wc.getURL();
        const desc = this.ctx.semanticRefRegistry.resolveRef(
          {
            tabId: targetId,
            paneId: effectivePane,
            browserEpoch: curEpoch,
            documentGeneration: curGen,
            documentUrl: curUrl,
          },
          normRef
        );
        if (!desc) {
          throw new CapabilityError('REF_NOT_FOUND', `Semantic reference not found: ${refOrSelector}`);
        }
        const isolatedCtxId = await this.ctx.tabDevToolsHost.getOrCreateIsolatedWorldContext?.(wc);
        const evalParams: Record<string, unknown> = {
          expression: `(() => {
            const desc = ${JSON.stringify(desc)};
            function resolveTraversalPath(path) {
              if (!Array.isArray(path) || path.length === 0) return null;
              let current = document;
              for (let i = 0; i < path.length; i++) {
                const step = path[i];
                if (!step || typeof step !== 'object') return null;
                if (step.kind === 'dom') {
                  const children = Array.from(current.children || []);
                  let candidate = children[step.index] || null;
                  if (!candidate && step.id) {
                    if (typeof current.getElementById === 'function') candidate = current.getElementById(step.id);
                    if (!candidate && typeof document.getElementById === 'function') candidate = document.getElementById(step.id);
                  }
                  if (!candidate) return null;
                  current = candidate;
                } else if (step.kind === 'shadow') {
                  if (!current.shadowRoot) return null;
                  current = current.shadowRoot;
                } else if (step.kind === 'iframe') {
                  if (!current.contentDocument) return null;
                  current = current.contentDocument;
                } else {
                  return null;
                }
              }
              return current instanceof Element ? current : null;
            }

            let el = resolveTraversalPath(desc.path);
            if (!el && desc.id) el = document.getElementById(desc.id);
            if (!el && desc.fingerprint?.id) el = document.getElementById(desc.fingerprint.id);
            if (el && el.tagName !== 'INPUT' && typeof el.querySelector === 'function') {
              el = el.querySelector('input[type="file"]') || el;
            }
            return el;
          })()`,
          returnByValue: false,
        };
        if (isolatedCtxId) {
          evalParams.contextId = isolatedCtxId;
        }

        const evalRes = await this.ctx.tabDevToolsHost.sendCdpCommand<{ result?: { objectId?: string } }>(
          wc,
          'Runtime.evaluate',
          evalParams
        );
        if (evalRes?.result?.objectId) {
          resolvedObjectId = evalRes.result.objectId;
          resolvedNodeId = await this.ctx.tabDevToolsHost.describeNodeByObjectId(wc, evalRes.result.objectId);
        }
      } else {
        const evalRes = await this.ctx.tabDevToolsHost.sendCdpCommand<{ result?: { objectId?: string } }>(
          wc,
          'Runtime.evaluate',
          {
            expression: `document.querySelector(${JSON.stringify(targetRef)})`,
            returnByValue: false,
          }
        );
        if (evalRes?.result?.objectId) {
          resolvedObjectId = evalRes.result.objectId;
          resolvedNodeId = await this.ctx.tabDevToolsHost.describeNodeByObjectId(wc, evalRes.result.objectId);
        }
      }

      if (!resolvedNodeId || !resolvedObjectId) {
        throw new CapabilityError('REF_NOT_FOUND', `Could not resolve target file input element: ${refOrSelector}`);
      }
      await this.ctx.tabDevToolsHost.sendCdpCommand(wc, 'DOM.setFileInputFiles', {
        files: resolvedPaths,
        backendNodeId: resolvedNodeId,
      });

      // Dispatch input & change events directly on the resolved RemoteObject handle without global querySelector
      try {
        await this.ctx.tabDevToolsHost.sendCdpCommand(wc, 'Runtime.callFunctionOn', {
          objectId: resolvedObjectId,
          functionDeclaration: `function() {
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          }`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CapabilityError('NODE_DETACHED', `Failed to dispatch input/change events on file input: ${msg}`);
      }

      return { success: true, uploadedCount: resolvedPaths.length };
    });
  }

  public async dropFiles(
    refOrSelector: string,
    filePaths: string[],
    tabId?: string,
    paneId?: SplitPaneId
  ): Promise<{ success: boolean; droppedCount: number; reason?: string }> {
    const targetRef = String(refOrSelector || '').trim();
    if (!targetRef) {
      throw new CapabilityError('INVALID_ARGUMENT', 'refOrSelector is required for dropFiles');
    }

    const targetId = tabId || this.ctx.getAutomationTabId() || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) return { success: false, droppedCount: 0, reason: 'Target tab not found' };

    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return { success: false, droppedCount: 0, reason: 'filePaths array is required and must not be empty' };
    }

    const targetSessionId = this.ctx.getTabTerminalSession?.(targetId);
    const curTabUrl = target.state?.url || '';
    const targetWorkspace = this.ctx.resolveTargetWorkspace?.(targetSessionId, curTabUrl) || '';
    if (!targetWorkspace) {
      throw new CapabilityError('WORKSPACE_UNBOUND', 'No authoritative workspace bound to target tab session');
    }

    const resolvedPaths = filePaths.map((p) => validatePathConfinement(p, targetWorkspace));
    const splitHasLiveMobile = Boolean(target.state.splitMode && target.mobileView && !target.mobileView.webContents.isDestroyed());
    const effectivePane: SplitPaneId = paneId || (splitHasLiveMobile ? (target.focusedPane || target.state.splitFocusedPane || 'desktop') : 'desktop');
    const wc = this.ctx.getTabWebContents(targetId, effectivePane);
    if (!wc || wc.isDestroyed()) return { success: false, droppedCount: 0, reason: 'WebContents destroyed' };

    if (!this.ctx.tabDevToolsHost) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', 'CDP TabDevToolsHost is required for native drag-drop');
    }

    return await this.ctx.runTargetOperation(targetId, effectivePane, async () => {
      // 1. Resolve target element coordinates strictly without @eN fallback to querySelector
      const targetSel = JSON.stringify(targetRef);
      const isRef = targetRef.startsWith('@') || /^e\d+$/i.test(targetRef);

      let dropCoords: { x: number; y: number } | null = null;

      if (isRef) {
        if (!this.ctx.semanticRefRegistry) {
          throw new CapabilityError('REF_NOT_FOUND', `Semantic ref registry unavailable for ${refOrSelector}`);
        }
        const normRef = targetRef.startsWith('@') ? targetRef : `@${targetRef}`;
        const curEpoch = this.ctx.getBrowserEpoch();
        const curGen = this.ctx.getSemanticDocumentGeneration(targetId, effectivePane);
        const desc = this.ctx.semanticRefRegistry.resolveRef(
          {
            tabId: targetId,
            paneId: effectivePane,
            browserEpoch: curEpoch,
            documentGeneration: curGen,
            documentUrl: curTabUrl,
          },
          normRef
        );
        if (!desc || !desc.rect || desc.rect.width <= 0 || desc.rect.height <= 0) {
          throw new CapabilityError('REF_NOT_FOUND', `Semantic drop target not found or has zero dimensions: ${refOrSelector}`);
        }
        dropCoords = { x: desc.rect.centerX, y: desc.rect.centerY };
      } else {
        const coordsRes = (await wc.executeJavaScript(`(() => {
          const el = document.querySelector(${targetSel});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return null;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`)) as { x?: number; y?: number } | null;

        if (!coordsRes || typeof coordsRes.x !== 'number' || typeof coordsRes.y !== 'number') {
          throw new CapabilityError('REF_NOT_FOUND', `Target drop element not found or has zero dimensions: ${refOrSelector}`);
        }
        dropCoords = { x: coordsRes.x, y: coordsRes.y };
      }

      if (!dropCoords) {
        throw new CapabilityError('REF_NOT_FOUND', `Target drop coordinates could not be resolved: ${refOrSelector}`);
      }

      const dropX = dropCoords.x;
      const dropY = dropCoords.y;
      // 2. Dispatch CDP-native Input.dispatchDragEvent with fail-closed error propagation
      try {
        const dragData = {
          items: [],
          files: resolvedPaths,
          dragOperationsMask: 1,
        };
        await this.ctx.tabDevToolsHost!.sendCdpCommand(wc, 'Input.dispatchDragEvent', {
          type: 'dragEnter',
          x: dropX,
          y: dropY,
          data: dragData,
        });
        await this.ctx.tabDevToolsHost!.sendCdpCommand(wc, 'Input.dispatchDragEvent', {
          type: 'dragOver',
          x: dropX,
          y: dropY,
          data: dragData,
        });
        await this.ctx.tabDevToolsHost!.sendCdpCommand(wc, 'Input.dispatchDragEvent', {
          type: 'drop',
          x: dropX,
          y: dropY,
          data: dragData,
        });
        return { success: true, droppedCount: resolvedPaths.length };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CapabilityError('CAPABILITY_NOT_FOUND', `CDP Input.dispatchDragEvent failed: ${msg}`);
      }
    });
  }
  public async inspectStyles(params: {
    selector?: string;
    ref?: string;
    properties?: string[];
    tabId?: string;
    paneId?: SplitPaneId;
  }): Promise<Record<string, unknown>> {
    const targetId = params.tabId || this.ctx.getAutomationTabId() || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', `Tab '${targetId}' not found`);
    }

    const splitHasLiveMobile = Boolean(target.state.splitMode && target.mobileView && !target.mobileView.webContents.isDestroyed());
    const effectivePane: SplitPaneId = params.paneId || (splitHasLiveMobile ? (target.focusedPane || target.state.splitFocusedPane || 'desktop') : 'desktop');

    return await this.ctx.runTargetOperation(targetId, effectivePane, async () => {
      const wc = this.ctx.getTabWebContents(targetId, effectivePane);
      if (!wc || wc.isDestroyed()) {
        throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Target WebContents is destroyed or unavailable');
      }

      let descriptor: SemanticElementDescriptor | undefined;
      const curEpoch = this.ctx.getBrowserEpoch();
      const curGen = this.ctx.getSemanticDocumentGeneration(targetId, effectivePane);
      const curUrl = wc.getURL();

      if (typeof params.ref === 'string' && params.ref.trim().length > 0) {
        if (!this.ctx.semanticRefRegistry) {
          throw new CapabilityError('RUNTIME_DRAINING', 'Semantic ref registry is not available');
        }
        const normRef = params.ref.trim().startsWith('@') ? params.ref.trim() : `@${params.ref.trim()}`;
        try {
          descriptor = this.ctx.semanticRefRegistry.resolveRef({
            tabId: targetId,
            paneId: effectivePane,
            browserEpoch: curEpoch,
            documentGeneration: curGen,
            documentUrl: curUrl,
          }, normRef);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new CapabilityError('REF_NOT_FOUND', msg);
        }
      }

      const script = buildInspectStylesIsolatedScript({
        descriptor,
        selector: params.selector,
        properties: params.properties,
        documentUrl: curUrl,
      });

      const rawRes = await this.executeInIsolatedWorld(wc, script);
      const res = rawRes as { ok: boolean; data?: Record<string, unknown>; error?: string; code?: string } | null;

      if (!res || !res.ok) {
        const errCode = res?.code === 'REF_NOT_FOUND' ? 'REF_NOT_FOUND'
          : res?.code === 'INVALID_SELECTOR' ? 'INVALID_ARGUMENT'
          : res?.code === 'REF_DOCUMENT_MUTATED' ? 'TARGET_STALE'
          : 'NODE_DETACHED';
        throw new CapabilityError(errCode, res?.error || 'Failed to inspect element styles');
      }

      return res.data || {};
    });
  }

  public async inspectRegion(params: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    selector?: string;
    ref?: string;
    tabId?: string;
    paneId?: SplitPaneId;
  }): Promise<Record<string, unknown>> {
    const targetId = params.tabId || this.ctx.getAutomationTabId() || this.ctx.getActiveTabId();
    const target = this.ctx.getTabRecord(targetId);
    if (!target) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', `Tab '${targetId}' not found`);
    }

    const splitHasLiveMobile = Boolean(target.state.splitMode && target.mobileView && !target.mobileView.webContents.isDestroyed());
    const effectivePane: SplitPaneId = params.paneId || (splitHasLiveMobile ? (target.focusedPane || target.state.splitFocusedPane || 'desktop') : 'desktop');

    return await this.ctx.runTargetOperation(targetId, effectivePane, async () => {
      const wc = this.ctx.getTabWebContents(targetId, effectivePane);
      if (!wc || wc.isDestroyed()) {
        throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Target WebContents is destroyed or unavailable');
      }

      let descriptor: SemanticElementDescriptor | undefined;
      const curEpoch = this.ctx.getBrowserEpoch();
      const curGen = this.ctx.getSemanticDocumentGeneration(targetId, effectivePane);
      const curUrl = wc.getURL();

      if (typeof params.ref === 'string' && params.ref.trim().length > 0) {
        if (!this.ctx.semanticRefRegistry) {
          throw new CapabilityError('RUNTIME_DRAINING', 'Semantic ref registry is not available');
        }
        const normRef = params.ref.trim().startsWith('@') ? params.ref.trim() : `@${params.ref.trim()}`;
        try {
          descriptor = this.ctx.semanticRefRegistry.resolveRef({
            tabId: targetId,
            paneId: effectivePane,
            browserEpoch: curEpoch,
            documentGeneration: curGen,
            documentUrl: curUrl,
          }, normRef);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new CapabilityError('REF_NOT_FOUND', msg);
        }
      }

      const script = buildInspectRegionIsolatedScript({
        descriptor,
        selector: params.selector,
        x: params.x,
        y: params.y,
        width: params.width,
        height: params.height,
        documentUrl: curUrl,
      });

      const rawRes = await this.executeInIsolatedWorld(wc, script);
      const res = rawRes as { ok: boolean; data?: Record<string, unknown>; error?: string; code?: string } | null;

      if (!res || !res.ok) {
        const errCode = res?.code === 'REF_NOT_FOUND' ? 'REF_NOT_FOUND'
          : res?.code === 'INVALID_SELECTOR' ? 'INVALID_ARGUMENT'
          : res?.code === 'REF_DOCUMENT_MUTATED' ? 'TARGET_STALE'
          : 'NODE_DETACHED';
        throw new CapabilityError(errCode, res?.error || 'Failed to inspect spatial region');
      }

      return res.data || {};
    });
  }
  public dispose(): void {
    for (const [, timer] of this.agentWorkingTimers.entries()) {
      clearTimeout(timer);
    }
    this.agentWorkingTimers.clear();
    this.agentWorkingRefs.clear();
  }
}
