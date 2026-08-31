import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildIsolatedExecutorScript,
  ISOLATED_AGENT_WORLD_ID,
  validateActionResponse,
} from '../../src/main/browser/semantic-ref-executor';
import {
  validateActionRequest,
  RendererActionRequest,
} from '../../src/main/browser/semantic-ref-types';
import { TabAutomationHost } from '../../src/main/browser/tab-automation-host';
import { CapabilityError, issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { BrowserActionRegistry } from '../../src/main/browser/browser-action-registry';
describe('Phase 02: Controlled Inputs & Dual-Tier Synthetic/CDP Interaction Engine', () => {
  describe('RendererActionRequest Contract with Trusted Flag', () => {
    it('validates and accepts trusted: true and trusted: false in action requests', () => {
      const baseReq: RendererActionRequest = {
        action: 'type',
        selector: '#search-input',
        text: 'Haravan Theme Pro',
        clear: true,
        trusted: true,
        nonce: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        documentUrl: 'https://store.example.com',
      };

      const validatedTrusted = validateActionRequest(baseReq);
      assert.equal(validatedTrusted.action, 'type');
      assert.equal(validatedTrusted.trusted, true);
      assert.equal(validatedTrusted.text, 'Haravan Theme Pro');
      assert.equal(validatedTrusted.clear, true);

      const validatedUntrusted = validateActionRequest({ ...baseReq, trusted: false });
      assert.equal(validatedUntrusted.trusted, false);

      const validatedOmitted = validateActionRequest({ ...baseReq, trusted: undefined });
      assert.equal(validatedOmitted.trusted, undefined);
    });
  });

  describe('Tier 1: Prototype Descriptor Setter Stealing & Event Cascade in World 1004', () => {
    it('generates executor script containing native prototype setter stealing and composed event cascade', () => {
      const script = buildIsolatedExecutorScript({
        action: 'type',
        selector: 'input[name="q"]',
        text: 'test query',
        clear: true,
        nonce: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        documentUrl: 'https://example.com',
      });

      // Assert script contains prototype chain walking and setter stealing
      assert.ok(script.includes('setNativeValue'), 'Must include setNativeValue helper');
      assert.ok(script.includes('Object.getPrototypeOf'), 'Must walk prototype chain');
      assert.ok(script.includes('Object.getOwnPropertyDescriptor'), 'Must extract property descriptor');
      assert.ok(script.includes('descriptor.set.call'), 'Must invoke native prototype setter');

      // Assert script dispatches complete synthetic event sequence
      assert.ok(script.includes('beforeinput'), 'Must dispatch beforeinput event');
      assert.ok(script.includes('insertText'), 'Must specify insertText inputType');
      assert.ok(script.includes('composed: true'), 'Must set composed: true for shadow DOM crossing');
      assert.ok(script.includes('change'), 'Must dispatch change event');
      assert.ok(script.includes('contenteditable'), 'Must support contenteditable elements');
    });

    it('simulates React 18 controlled input value tracker and validates synthetic cascade execution', () => {
      // Mock DOM environment simulating React controlled input value tracking
      const events: Array<{ type: string; bubbles: boolean; composed: boolean; data?: string; isTrusted: boolean }> = [];
      let nativeSetterCalled = false;
      let internalReactTrackerVal = '';

      // Define standard HTMLInputElement prototype
      class MockHTMLElement {
        isContentEditable = false;
        getAttribute() { return null; }
        scrollIntoView() {}
        focus() {}
        getBoundingClientRect() {
          return { x: 10, y: 10, width: 100, height: 30, top: 10, left: 10, right: 110, bottom: 40 };
        }
        dispatchEvent(event: any) {
          events.push({
            type: event.type,
            bubbles: event.bubbles,
            composed: event.composed,
            data: event.data,
            isTrusted: Boolean(event.isTrusted),
          });
          return true;
        }
      }

      class MockHTMLInputElement extends MockHTMLElement {
        private _val = '';
        get value() { return this._val; }
        set value(v: string) {
          nativeSetterCalled = true;
          this._val = v;
        }
      }

      // Simulate React 18 overriding the instance/prototype setter to track user interaction vs programmatic sets
      const inputInstance = new MockHTMLInputElement();
      const originalDescriptor = Object.getOwnPropertyDescriptor(MockHTMLInputElement.prototype, 'value')!;
      
      Object.defineProperty(inputInstance, 'value', {
        get() { return originalDescriptor.get!.call(this); },
        set(v: string) {
          // React tracker intercepts property assignment
          internalReactTrackerVal = v;
          originalDescriptor.set!.call(this, v);
        },
        configurable: true,
      });

      // Construct Mock Document and Window
      const mockDocument = {
        querySelector: (sel: string) => sel === '#react-input' ? inputInstance : null,
        elementFromPoint: () => null,
      };

      const evalScript = `
        const document = mockDoc;
        const window = { getSelection: () => null, location: { href: 'https://example.com' } };
        const InputEvent = class {
          constructor(type, init = {}) {
            this.type = type;
            this.bubbles = Boolean(init.bubbles);
            this.cancelable = Boolean(init.cancelable);
            this.composed = Boolean(init.composed);
            this.data = init.data;
            this.inputType = init.inputType;
            this.isTrusted = false;
          }
        };
        const Event = class {
          constructor(type, init = {}) {
            this.type = type;
            this.bubbles = Boolean(init.bubbles);
            this.cancelable = Boolean(init.cancelable);
            this.composed = Boolean(init.composed);
            this.isTrusted = false;
          }
        };
        return ${buildIsolatedExecutorScript({
          action: 'type',
          selector: '#react-input',
          text: 'Haravan Checkout',
          clear: true,
          nonce: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
          documentUrl: 'https://example.com',
        })};
      `;
      // Execute script in mock environment
      const executeInEnv = new Function('mockDoc', evalScript);
      const res = executeInEnv(mockDocument);

      assert.equal(res.ok, true);
      assert.equal(res.executed, true);
      assert.equal(inputInstance.value, 'Haravan Checkout');
      assert.equal(nativeSetterCalled, true, 'Native prototype setter must be called');

      // Verify event order: beforeinput -> input -> change
      assert.equal(events.length, 3);
      const ev0 = events[0]!;
      assert.equal(ev0.type, 'beforeinput');
      assert.equal(ev0.composed, true);
      assert.equal(ev0.data, 'Haravan Checkout');
      assert.equal(ev0.isTrusted, false, 'Synthetic events must have isTrusted: false');

      const ev1 = events[1]!;
      assert.equal(ev1.type, 'input');
      assert.equal(ev1.composed, true);
      assert.equal(ev1.data, 'Haravan Checkout');

      const ev2 = events[2]!;
      assert.equal(ev2.type, 'change');
      assert.equal(ev2.composed, true);
    });
  });
  describe('Tier 2: CDP Hardware-Level Trusted Event Dispatch Integration', () => {
    it('dispatches to CDP Input.insertText when trusted: true is specified on TabAutomationHost', async () => {
      const cdpCommands: Array<{ command: string; params: any }> = [];
      let debuggerAttached = false;

      const mockWebContents = {
        isDestroyed: () => false,
        getURL: () => 'https://example.com/checkout',
        executeJavaScriptInIsolatedWorld: async (_worldId: number, _script: string) => {
          return { ok: true, executed: true };
        },
        debugger: {
          isAttached: () => debuggerAttached,
          attach: (_version: string) => { debuggerAttached = true; },
          detach: () => { debuggerAttached = false; },
          sendCommand: async (command: string, params: any) => {
            cdpCommands.push({ command, params });
            return {};
          },
        },
      };

      const mockContext: any = {
        getTabWebContents: () => mockWebContents,
        getTabRecord: (_id: string) => ({
          state: { id: 'tab-1', aiState: 'idle' },
          focusedPane: 'desktop',
        }),
        getAutomationTabId: () => 'tab-1',
        getActiveTabId: () => 'tab-1',
        getBrowserEpoch: () => 1,
        getSemanticDocumentGeneration: () => 1,
        runTargetOperation: async (_id: string, _pane: any, op: any) => op(),
        broadcastState: () => {},
        syncFrameBackdrop: () => {},
      };

      const host = new TabAutomationHost(mockContext);

      const result = await host.agentType({
        selector: '#secure-otp-field',
        text: '884920',
        clear: true,
        trusted: true,
        tabId: 'tab-1',
      });

      assert.equal(result, true);
      assert.equal(cdpCommands.length, 5, 'Must send 4 clear key events + 1 insertText command');
      const selectAllDown = cdpCommands.find((c) => c.command === 'Input.dispatchKeyEvent' && c.params.code === 'KeyA' && c.params.type === 'keyDown')!;
      assert.ok(selectAllDown);
      const expectedModifier = process.platform === 'darwin' ? 4 : 2;
      assert.equal(selectAllDown.params.modifiers, expectedModifier, `CDP SelectAll modifier must be ${expectedModifier} (Meta: 4 on Darwin, Control: 2 on Win/Linux)`);
      const insertCmd = cdpCommands.find((c) => c.command === 'Input.insertText')!;
      assert.ok(insertCmd);
      assert.equal(insertCmd.params.text, '884920');
    });

    it('fails closed and aborts insertion when CDP clear sendCommand rejects', async () => {
      const cdpCommands: Array<{ command: string; params: any }> = [];
      const mockWebContents = {
        isDestroyed: () => false,
        getURL: () => 'https://example.com/checkout',
        executeJavaScriptInIsolatedWorld: async () => ({ ok: true, executed: true }),
        debugger: {
          isAttached: () => true,
          attach: () => {},
          detach: () => {},
          sendCommand: async (command: string, params: any) => {
            cdpCommands.push({ command, params });
            if (command === 'Input.dispatchKeyEvent') {
              throw new Error('Target window detached during clear');
            }
            return {};
          },
        },
      };

      const mockContext: any = {
        getTabWebContents: () => mockWebContents,
        getTabRecord: (_id: string) => ({
          state: { id: 'tab-1', aiState: 'idle' },
          focusedPane: 'desktop',
        }),
        getAutomationTabId: () => 'tab-1',
        getActiveTabId: () => 'tab-1',
        getBrowserEpoch: () => 1,
        getSemanticDocumentGeneration: () => 1,
        runTargetOperation: async (_id: string, _pane: any, op: any) => op(),
        broadcastState: () => {},
        syncFrameBackdrop: () => {},
      };

      const host = new TabAutomationHost(mockContext);
      const actionRes = await host.dispatchAgentAction('type', {
        selector: '#fail-field',
        text: 'should-not-insert',
        clear: true,
        trusted: true,
        tabId: 'tab-1',
      });

      assert.equal(actionRes.success, false);
      assert.ok(actionRes.reason?.includes('CDP trusted clear failed: Target window detached during clear'));
      const inserted = cdpCommands.some((c) => c.command === 'Input.insertText');
      assert.equal(inserted, false, 'Must NOT proceed to Input.insertText if clear fails');
    });
    it('fails closed and detects navigation when document generation increments during trusted type execution', async () => {
      let generation = 1;
      const mockWebContents = {
        isDestroyed: () => false,
        getURL: () => 'https://example.com/checkout',
        executeJavaScriptInIsolatedWorld: async () => ({ ok: true, executed: true }),
        debugger: {
          isAttached: () => true,
          attach: () => {},
          detach: () => {},
          sendCommand: async (command: string, _params: any) => {
            if (command === 'Input.insertText') {
              // Simulate page navigation during typing
              generation = 2;
            }
            return {};
          },
        },
      };

      const mockContext: any = {
        getTabWebContents: () => mockWebContents,
        getTabRecord: (_id: string) => ({
          state: { id: 'tab-1', aiState: 'idle' },
          focusedPane: 'desktop',
        }),
        getAutomationTabId: () => 'tab-1',
        getActiveTabId: () => 'tab-1',
        getBrowserEpoch: () => 1,
        getSemanticDocumentGeneration: () => generation,
        runTargetOperation: async (_id: string, _pane: any, op: any) => op(),
        broadcastState: () => {},
        syncFrameBackdrop: () => {},
      };

      const host = new TabAutomationHost(mockContext);
      const actionRes = await host.dispatchAgentAction('type', {
        selector: '#nav-field',
        text: 'test-nav',
        clear: true,
        trusted: true,
        tabId: 'tab-1',
      });

      assert.equal(actionRes.success, false);
      assert.equal(actionRes.reason, 'Document navigated during action execution');

      // Also test host.agentType direct method returns false
      generation = 1;
      const typeResult = await host.agentType({
        selector: '#nav-field',
        text: 'test-nav',
        clear: true,
        trusted: true,
        tabId: 'tab-1',
      });
      assert.equal(typeResult, false, 'agentType must return false when document generation increments');
    });

    it('fails closed when webContents is destroyed during trusted type execution', async () => {
      let destroyed = false;
      const mockWebContents = {
        isDestroyed: () => destroyed,
        getURL: () => 'https://example.com/checkout',
        executeJavaScriptInIsolatedWorld: async () => ({ ok: true, executed: true }),
        debugger: {
          isAttached: () => true,
          attach: () => {},
          detach: () => {},
          sendCommand: async (command: string, _params: any) => {
            if (command === 'Input.insertText') {
              destroyed = true;
            }
            return {};
          },
        },
      };

      const mockContext: any = {
        getTabWebContents: () => mockWebContents,
        getTabRecord: (_id: string) => ({
          state: { id: 'tab-1', aiState: 'idle' },
          focusedPane: 'desktop',
        }),
        getAutomationTabId: () => 'tab-1',
        getActiveTabId: () => 'tab-1',
        getBrowserEpoch: () => 1,
        getSemanticDocumentGeneration: () => 1,
        runTargetOperation: async (_id: string, _pane: any, op: any) => op(),
        broadcastState: () => {},
        syncFrameBackdrop: () => {},
      };

      const host = new TabAutomationHost(mockContext);
      const actionRes = await host.dispatchAgentAction('type', {
        selector: '#destroy-field',
        text: 'test-destroy',
        clear: true,
        trusted: true,
        tabId: 'tab-1',
      });

      assert.equal(actionRes.success, false);
      assert.equal(actionRes.reason, 'Document navigated during action execution');
    });
    it('routes trusted: true through CapabilityCatalogue and BrowserControlPort end-to-end', async () => {

      let receivedParams: any = null;
      const mockHost: any = {
        getTabList: () => [{ id: 'tab-1', url: 'https://example.com' }],
        agentType: async (p: any) => {
          receivedParams = p;
          return true;
        },
      };

      const controlPort = new BrowserControlPort(mockHost, { stage: async (a: any) => a } as any);
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
      registerBrowserCapabilities(catalogue, controlPort);

      const context = {
        lease,
        leaseToken: lease.token,
        projectId,
        workspaceId,
        grant: 'write' as const,
        browserTarget: {
          tabId: 'tab-1',
          browserEpoch: 1,
          documentGeneration: 1,
          projectId,
          workspaceId,
          runtimeId: lease.runtimeId,
        },
      };

      // Execute canonical browser.agent-type capability
      const capResult = await catalogue.get('browser.agent-type')!.execute({
        selector: '#otp-code',
        text: '998811',
        clear: true,
        trusted: true,
        tabId: 'tab-1',
      }, context);

      assert.deepEqual(capResult, { typed: true });
      assert.equal(receivedParams.trusted, true);
      assert.equal(receivedParams.text, '998811');
      assert.equal(receivedParams.clear, true);

      // Execute anti.agent.cursor.type alias
      receivedParams = null;
      const aliasResult = await catalogue.get('anti.agent.cursor.type')!.execute({
        ref: '@e1',
        text: '554433',
        trusted: true,
        tabId: 'tab-1',
      }, context);

      assert.deepEqual(aliasResult, { typed: true });
      assert.equal(receivedParams.trusted, true);
      assert.equal(receivedParams.ref, '@e1');
      assert.equal(receivedParams.text, '554433');
    });

    it('dispatches trusted: true through BrowserActionRegistry', async () => {
      let actionReceivedParams: any = null;
      const mockTabHost: any = {
        agentType: async (p: any) => {
          actionReceivedParams = p;
          return true;
        },
      };
      const registry = new BrowserActionRegistry(mockTabHost);

      const result = await registry.execute('antifan_agent_type', {
        selector: '#login-pass',
        text: 'SecretPass123',
        trusted: true,
      });

      assert.equal(result.success, true);
      assert.equal(actionReceivedParams.trusted, true);
      assert.equal(actionReceivedParams.text, 'SecretPass123');
    });
  });
});
