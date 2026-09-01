import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TabAutomationHost } from '../../src/main/browser/tab-automation-host';
import { SemanticRefRegistry } from '../../src/main/browser/semantic-ref-registry';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { TabDevToolsHost } from '../../src/main/browser/tab-devtools-host';

describe('TabAutomationHost: Upload & Drag-Drop Automation Security & CDP Parity', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-upload-drop-'));
  const testFile1 = path.join(tmpRoot, 'photo.png');
  const testFile2 = path.join(tmpRoot, 'sub', 'doc.pdf');
  const outsideFile = path.join(os.tmpdir(), 'outside-secret.txt');

  before(() => {
    fs.mkdirSync(path.join(tmpRoot, 'sub'), { recursive: true });
    fs.writeFileSync(testFile1, 'fake-png-content');
    fs.writeFileSync(testFile2, 'fake-pdf-content');
    fs.writeFileSync(outsideFile, 'secret-data');
  });

  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(outsideFile, { force: true });
    } catch {}
  });

  function createHarness(options?: {
    workspaceRoot?: string;
    hasDevTools?: boolean;
    cdpFail?: boolean;
  }) {
    const registry = new SemanticRefRegistry();
    const cdpCommandsSent: Array<{ method: string; params: unknown }> = [];

    const mockWc: any = {
      id: 42,
      isDestroyed: () => false,
      getURL: () => 'https://example.com/products/test',
      executeJavaScript: async (code: string) => {
        if (code.includes('zero-dim')) {
          return null;
        }
        if (code.includes('valid-drop-zone')) {
          return { x: 150, y: 250 };
        }
        return { ok: true, count: 1 };
      },
    };

    const mockDevToolsHost: any = options?.hasDevTools !== false ? {
      sendCdpCommand: async (_wc: any, method: string, params: any) => {
        if (options?.cdpFail) {
          throw new Error('CDP Hardware Error: Target closed');
        }
        cdpCommandsSent.push({ method, params });
        if (method === 'Runtime.evaluate') {
          return { result: { objectId: 'obj-file-input-42' } };
        }
        if (method === 'DOM.describeNode') {
          return 9901; // backendNodeId
        }
        return {};
      },
      describeNodeByObjectId: async (_wc: any, objectId: string) => {
        if (objectId === 'obj-file-input-42') return 9901;
        return undefined;
      },
      getOrCreateIsolatedWorldContext: async () => 1004,
    } : undefined;

    const tabRecord: any = {
      state: { id: 'tab-1', url: 'https://example.com/products/test' },
      terminalSessionId: 'sess-1',
    };

    const host = new TabAutomationHost({
      getTabWebContents: () => mockWc,
      getTabRecord: () => tabRecord,
      getAutomationTabId: () => 'tab-1',
      getActiveTabId: () => 'tab-1',
      getBrowserEpoch: () => 1,
      getSemanticDocumentGeneration: () => 1,
      semanticRefRegistry: registry,
      runTargetOperation: async (_tabId, _paneId, op) => op(),
      broadcastState: () => {},
      syncFrameBackdrop: () => {},
      getAllTabs: () => [][Symbol.iterator](),
      tabDevToolsHost: mockDevToolsHost,
      getTabTerminalSession: () => (options?.workspaceRoot ? 'sess-1' : undefined),
      resolveTargetWorkspace: (sessId) => (sessId === 'sess-1' && options?.workspaceRoot ? options.workspaceRoot : ''),
    });

    return { host, registry, cdpCommandsSent, mockWc };
  }

  it('1. Rejects upload/drop with WORKSPACE_UNBOUND when target tab has no bound workspace', async () => {
    const { host } = createHarness({ workspaceRoot: undefined });

    await assert.rejects(
      async () => host.uploadFileInput('input[type="file"]', [testFile1]),
      (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_UNBOUND'
    );

    await assert.rejects(
      async () => host.dropFiles('#drop-area', [testFile1]),
      (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_UNBOUND'
    );
  });

  it('2. Rejects outside-workspace file paths with OUTSIDE_WORKSPACE (traversal security)', async () => {
    const { host } = createHarness({ workspaceRoot: tmpRoot });

    await assert.rejects(
      async () => host.uploadFileInput('input[type="file"]', [outsideFile]),
      (err: unknown) => err instanceof CapabilityError && err.code === 'OUTSIDE_WORKSPACE'
    );

    await assert.rejects(
      async () => host.dropFiles('#drop-area', [outsideFile]),
      (err: unknown) => err instanceof CapabilityError && err.code === 'OUTSIDE_WORKSPACE'
    );
  });

  it('3. Rejects invalid arguments (non-existent file, empty array, empty ref)', async () => {
    const { host } = createHarness({ workspaceRoot: tmpRoot });

    await assert.rejects(
      async () => host.uploadFileInput('input[type="file"]', [path.join(tmpRoot, 'missing.txt')]),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );

    await assert.rejects(
      async () => host.dropFiles('', [testFile1]),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('4. Successfully uploads file with DOM.setFileInputFiles and exact backendNodeId payload', async () => {
    const { host, cdpCommandsSent } = createHarness({ workspaceRoot: tmpRoot });

    const res = await host.uploadFileInput('input[type="file"]', [testFile1, testFile2]);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.uploadedCount, 2);

    const setFilesCmd = cdpCommandsSent.find((c) => c.method === 'DOM.setFileInputFiles');
    assert.ok(setFilesCmd, 'Must issue DOM.setFileInputFiles CDP command');
    assert.deepStrictEqual(setFilesCmd.params, {
      files: [fs.realpathSync(testFile1), fs.realpathSync(testFile2)],
      backendNodeId: 9901,
    });
  });

  it('5. Rejects missing semantic ref with REF_NOT_FOUND without throwing CSS syntax error', async () => {
    const { host } = createHarness({ workspaceRoot: tmpRoot });

    await assert.rejects(
      async () => host.uploadFileInput('@e999', [testFile1]),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_NOT_FOUND'
    );

    await assert.rejects(
      async () => host.dropFiles('@e999', [testFile1]),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_NOT_FOUND'
    );
  });

  it('6. Rejects zero-dimension drop target with REF_NOT_FOUND', async () => {
    const { host } = createHarness({ workspaceRoot: tmpRoot });

    await assert.rejects(
      async () => host.dropFiles('.zero-dim-target', [testFile1]),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_NOT_FOUND'
    );
  });

  it('7. Dispatches valid CDP Input.dispatchDragEvent sequence for dropFiles', async () => {
    const { host, cdpCommandsSent } = createHarness({ workspaceRoot: tmpRoot });

    const res = await host.dropFiles('.valid-drop-zone', [testFile1]);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.droppedCount, 1);

    const dragEvents = cdpCommandsSent.filter((c) => c.method === 'Input.dispatchDragEvent');
    assert.strictEqual(dragEvents.length, 3);
    assert.strictEqual((dragEvents[0]?.params as any).type, 'dragEnter');
    assert.strictEqual((dragEvents[1]?.params as any).type, 'dragOver');
    assert.strictEqual((dragEvents[2]?.params as any).type, 'drop');
    assert.strictEqual((dragEvents[2]?.params as any).x, 150);
    assert.strictEqual((dragEvents[2]?.params as any).y, 250);
  });

  it('8. Propagates CDP drag failure fail-closed', async () => {
    const { host } = createHarness({ workspaceRoot: tmpRoot, cdpFail: true });

    await assert.rejects(
      async () => host.dropFiles('.valid-drop-zone', [testFile1]),
      (err: unknown) => err instanceof CapabilityError && err.code === 'CAPABILITY_NOT_FOUND'
    );
  });

  it('9. Resolves semantic ref descriptor-path (shadow/iframe) and invokes Runtime.callFunctionOn on exact objectId', async () => {
    const { host, registry, cdpCommandsSent } = createHarness({ workspaceRoot: tmpRoot });

    // Seed semantic ref @e1 into registry with path pointing to shadow DOM file input
    const collection = registry.beginCollection({
      tabId: 'tab-1',
      paneId: 'desktop',
      browserEpoch: 1,
      documentGeneration: 1,
      documentUrl: 'https://example.com/products/test',
    });

    registry.publishSnapshot({
      tabId: 'tab-1',
      paneId: 'desktop',
      nonce: collection.nonce,
      sequence: collection.sequence,
      browserEpoch: 1,
      documentGeneration: 1,
      documentUrl: 'https://example.com/products/test',
      rawDescriptors: [
        {
          id: 'shadow-file-input',
          role: 'textbox',
          label: 'Upload File',
          path: [
            { kind: 'dom', index: 0, tag: 'div', id: 'custom-widget' },
            { kind: 'shadow', index: 0, tag: 'shadow-root' },
            { kind: 'dom', index: 1, tag: 'input', id: 'shadow-file-input' },
          ],
          rect: { x: 10, y: 20, width: 100, height: 30, centerX: 60, centerY: 35 },
          fingerprint: { tag: 'input', id: 'shadow-file-input' },
        },
      ],
    });

    const res = await host.uploadFileInput('@e1', [testFile1]);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.uploadedCount, 1);

    // Verify DOM.setFileInputFiles called with backendNodeId
    const setFilesCmd = cdpCommandsSent.find((c) => c.method === 'DOM.setFileInputFiles');
    assert.ok(setFilesCmd);
    assert.strictEqual((setFilesCmd.params as any).backendNodeId, 9901);

    // Verify Runtime.callFunctionOn invoked on the resolved objectId
    const callFnCmd = cdpCommandsSent.find((c) => c.method === 'Runtime.callFunctionOn');
    assert.ok(callFnCmd, 'Must invoke Runtime.callFunctionOn on the exact resolved objectId');
    assert.strictEqual((callFnCmd.params as any).objectId, 'obj-file-input-42');
  });
});
