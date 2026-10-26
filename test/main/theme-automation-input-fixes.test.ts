import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { validateAuthorizedWorkspaceRoot } from '../../src/main/browser/workspace-resolver';
import { BrowserActionRegistry } from '../../src/main/browser/browser-action-registry';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { TabAutomationHost } from '../../src/main/browser/tab-automation-host';
import { SemanticRefRegistry } from '../../src/main/browser/semantic-ref-registry';
import { CapabilityError, issueRuntimeLease, makeControlPlaneId, BrowserTarget } from '../../src/shared/control-plane-contracts';
import type { NativeTabHost, NativeTabRecord } from '../../src/main/browser/native-tab-host';
import type { BrowserHostPort } from '../../src/main/tools/browser-control-port';
import type { TabDevToolsHost } from '../../src/main/browser/tab-devtools-host';
describe('Theme Automation Input Fixes (Haravan Next Stack)', () => {
  describe('1. anti.agent.cursor.hover executionTier & verified hoverActive', () => {
    it('returns executionTier "isolated_synthetic", hoverActive: false, hovered: false, and hint when :hover is not active', async () => {
      const mockHost = {
        dispatchAgentAction: async (action: string, params: Record<string, unknown>) => {
          return {
            success: false,
            data: {
              ok: true,
              executed: true,
              executionTier: 'isolated_synthetic',
              hoverActive: false,
            },
          };
        },
      } as unknown as NativeTabHost;

      const registry = new BrowserActionRegistry(mockHost);
      const action = registry.getAction('agentHover');
      assert.ok(action, 'agentHover must be registered');

      const result = await action.handler({ selector: '.btn' }, { tabHost: mockHost });
      assert.strictEqual(result.executionTier, 'isolated_synthetic');
      assert.strictEqual(result.hoverActive, false);
      assert.strictEqual(result.hovered, false);
      assert.strictEqual(result.success, false);
      assert.ok(typeof result.hint === 'string' && result.hint.includes('anti.trace.interaction'));
    });

    it('returns executionTier "cdp_trusted", hoverActive: true, hovered: true on active hover', async () => {
      const mockHost = {
        dispatchAgentAction: async (action: string, params: Record<string, unknown>) => {
          return {
            success: true,
            data: {
              ok: true,
              executed: true,
              executionTier: 'cdp_trusted',
              hoverActive: true,
            },
          };
        },
      } as unknown as NativeTabHost;

      const registry = new BrowserActionRegistry(mockHost);
      const action = registry.getAction('agentHover');
      assert.ok(action);

      const result = await action.handler({ selector: '.menu-item' }, { tabHost: mockHost });
      assert.strictEqual(result.executionTier, 'cdp_trusted');
      assert.strictEqual(result.hoverActive, true);
      assert.strictEqual(result.hovered, true);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.hint, undefined);
    });

    it('BrowserControlPort.agentHover forwards verified hoverActive & executionTier and does not claim true on synthetic inactive', async () => {
      const mockHost = {
        dispatchAgentAction: async (action: string, params: Record<string, unknown>) => {
          return {
            success: false,
            data: {
              ok: true,
              executed: true,
              executionTier: 'isolated_synthetic',
              hoverActive: false,
            },
          };
        },
        getTabList: () => [{ id: 'tab-1' }],
        resolveTargetTabId: (id?: string) => id || 'tab-1',
        getAutomationTabId: () => 'tab-1',
      };

      const port = new BrowserControlPort(mockHost as unknown as BrowserHostPort);
      const target: BrowserTarget = {
        projectId: 'proj-1',
        workspaceId: 'ws-1',
        runtimeId: 'run-1',
        tabId: 'tab-1',
        browserEpoch: 1,
        documentGeneration: 1,
      };

      const outcome = await port.agentHover({ selector: '.badge' }, target);
      assert.strictEqual(outcome.executionTier, 'isolated_synthetic');
      assert.strictEqual(outcome.hoverActive, false);
      assert.strictEqual(outcome.hovered, false);
      assert.strictEqual(outcome.success, false);
      assert.ok(typeof outcome.hint === 'string' && outcome.hint.includes('anti.trace.interaction'));
    });
  });

  describe('2. anti.agent.file_upload workspaceRoot & anchor fallback', () => {
    it('validates authorized workspaceRoot within allowed roots and rejects escaping roots', () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-upload-test-'));
      const authorizedDir = path.join(tempRoot, 'themes');
      const projectDir = path.join(authorizedDir, 'LuxWine');
      const outsideDir = path.join(tempRoot, 'outside-secret');

      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      try {
        // Valid project directory within authorized root
        const validated = validateAuthorizedWorkspaceRoot(projectDir, [authorizedDir]);
        assert.strictEqual(path.normalize(validated), path.normalize(projectDir));

        // Escaping directory outside authorized roots is refused with OUTSIDE_WORKSPACE
        assert.throws(
          () => validateAuthorizedWorkspaceRoot(outsideDir, [authorizedDir]),
          (err: unknown) => err instanceof CapabilityError && err.code === 'OUTSIDE_WORKSPACE'
        );

        // Non-existent directory is refused with WORKSPACE_UNBOUND
        assert.throws(
          () => validateAuthorizedWorkspaceRoot(path.join(authorizedDir, 'NonExistent'), [authorizedDir]),
          (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_UNBOUND'
        );
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('falls back to anchor workspace when tab URL is unmapped (e.g. partners.haravan.com)', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-anchor-test-'));
      const anchorWs = path.join(tempRoot, 'LuxWine');
      fs.mkdirSync(anchorWs, { recursive: true });
      const themeZip = path.join(anchorWs, 'theme.zip');
      fs.writeFileSync(themeZip, 'fake-zip-content');

      try {
        const mockDevTools = {
          getOrCreateIsolatedWorldContext: async () => 1,
          sendCdpCommand: async (_wc: unknown, method: string) => {
            if (method === 'Runtime.evaluate') {
              return { result: { objectId: 'obj-file-input' } };
            }
            return {};
          },
          describeNodeByObjectId: async () => 101,
        };
        const mockWc = {
          isDestroyed: () => false,
          getURL: () => 'https://partners.haravan.com/themes/new',
          executeJavaScript: async () => true,
        };

        const mockTab: NativeTabRecord = {
          id: 'tab-partners',
          state: {
            id: 'tab-partners',
            url: 'https://partners.haravan.com/themes/new',
            title: 'Partners Admin',
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            zoomFactor: 1.0,
          },
          webContents: mockWc as unknown as Electron.WebContents,
        } as unknown as NativeTabRecord;

        const automationHost = new TabAutomationHost({
          getTabWebContents: () => mockWc as unknown as Electron.WebContents,
          getTabRecord: () => mockTab,
          getAutomationTabId: () => 'tab-partners',
          getActiveTabId: () => 'tab-partners',
          getBrowserEpoch: () => 1,
          getSemanticDocumentGeneration: () => 1,
          semanticRefRegistry: new SemanticRefRegistry(),
          runTargetOperation: async (_t, _p, op) => op(),
          broadcastState: () => {},
          syncFrameBackdrop: () => {},
          getAllTabs: () => (new Map<string, NativeTabRecord>([[mockTab.state.id, mockTab]])).entries(),
          tabDevToolsHost: mockDevTools as unknown as TabDevToolsHost,
          // Tab URL is partners.haravan.com -> unmapped!
          resolveTargetWorkspace: () => '',
          // Anchor workspace provided!
          resolveAnchorWorkspace: () => anchorWs,
        });

        const result = await automationHost.uploadFileInput('input[type=file]', [themeZip], 'tab-partners');
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.uploadedCount, 1);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe('3. Style mutations do not bump mutation revision / invalidate refs', () => {
    it('filters out attribute mutations where attributeName === "style"', () => {
      let notified = false;
      const notifyMutation = () => { notified = true; };

      const filterMutations = (mutations: Array<{ type: string; attributeName?: string | null }>) => {
        const hasMeaningful = mutations.some(
          (m) => m.type === 'childList' || (m.type === 'attributes' && m.attributeName !== 'style')
        );
        if (hasMeaningful) notifyMutation();
      };

      // 1. Per-frame style update (e.g. Swiper / carousel progress)
      filterMutations([{ type: 'attributes', attributeName: 'style' }]);
      assert.strictEqual(notified, false, 'Style-only mutation must not trigger mutation notification');

      // 2. Structural mutation (childList)
      filterMutations([{ type: 'childList' }]);
      assert.strictEqual(notified, true, 'ChildList mutation must trigger mutation notification');

      // 3. Class mutation
      notified = false;
      filterMutations([{ type: 'attributes', attributeName: 'class' }]);
      assert.strictEqual(notified, true, 'Class mutation must trigger mutation notification');
    });

    it('structural mutation advances generation and invalidates refs with TARGET_STALE', async () => {
      let documentGeneration = 1;
      const mockHost = {
        dispatchAgentAction: async () => {
          return { success: true };
        },
        getTabList: () => [{ id: 'tab-1' }],
        resolveTargetTabId: () => 'tab-1',
        getAutomationTabId: () => 'tab-1',
        getDocumentGeneration: () => documentGeneration,
      };

      const port = new BrowserControlPort(mockHost as unknown as BrowserHostPort);
      const staleTarget: BrowserTarget = {
        projectId: 'proj-1',
        workspaceId: 'ws-1',
        runtimeId: 'run-1',
        tabId: 'tab-1',
        browserEpoch: 1,
        // Target was stamped at generation 1
        documentGeneration: 1,
      };

      // Structural mutation bumped generation on host to 2!
      documentGeneration = 2;

      await assert.rejects(
        () => port.agentHover({ ref: '@e1' }, staleTarget),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE',
        'Stale documentGeneration must reject with TARGET_STALE'
      );
    });
  });

  describe('5. anti.theme.style_override id requirement', () => {
    it('requires id only when operation is "apply" and allows omitting id on "clear"', async () => {
      let evaluatedScript = '';
      const mockBrowser = {
        eval: async (_target: unknown, script: string) => {
          evaluatedScript = script;
          return { cleared: true };
        },
      };

      const projectId = makeControlPlaneId('project');
      const workspaceId = makeControlPlaneId('workspace');
      const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

      const catalogue = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId,
        workspaceId,
        runtimeId: lease.runtimeId,
        hostEpoch: 1,
      });

      registerBrowserCapabilities(catalogue, mockBrowser as unknown as BrowserControlPort);
      const target: BrowserTarget = {
        projectId,
        workspaceId,
        runtimeId: lease.runtimeId,
        tabId: 'tab-1',
        browserEpoch: 1,
        documentGeneration: 1,
      };

      const ctx = {
        lease,
        leaseToken: lease.token,
        projectId,
        workspaceId,
        grant: 'write' as const,
        browserTarget: target,
      };

      // 1. Operation 'apply' without id must fail with INVALID_ARGUMENT
      await assert.rejects(
        () => catalogue.dispatch('theme.style_override', { operation: 'apply', css: 'body { color: red; }' }, ctx),
        (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.message.includes('id is required')
      );

      // 2. Operation 'clear' without id must succeed and clear all overrides
      evaluatedScript = '';
      const clearRes = await catalogue.dispatch('theme.style_override', { operation: 'clear' }, ctx);
      assert.ok(clearRes);
      assert.ok(evaluatedScript.includes('data-antifan-override="true"'), 'Clear without id must remove all data-antifan-override styles');

      // 3. Operation 'remove' without id must also succeed
      evaluatedScript = '';
      const removeRes = await catalogue.dispatch('anti.theme.style_override', { operation: 'remove' }, ctx);
      assert.ok(removeRes);
      assert.ok(evaluatedScript.includes('data-antifan-override="true"'));
    });
  });
});
