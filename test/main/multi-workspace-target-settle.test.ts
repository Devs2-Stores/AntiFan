import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { deriveCapsulePartition } from '../../src/main/browser/browser-session-partition';
import {
  makeControlPlaneId,
  issueRuntimeLease,
  BrowserTarget,
} from '../../src/shared/control-plane-contracts';

describe('Multi-Workspace Target Settle & Capsule Partition Isolation (Phase 04)', () => {
  it('accepts targets belonging to any registered secondary workspace in controlPlane.workspaces', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-phase4-'));
    try {
      const projectId = makeControlPlaneId('project');
      const wsPrimary = makeControlPlaneId('workspace');
      const wsSecondary = makeControlPlaneId('workspace');

      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId: wsPrimary,
        dataRoot,
        allowEval: false,
      });
      // Ensure secondary workspace is attached
      runtime.workspaces.ensureInitialWorkspace(projectId, wsSecondary, path.join(dataRoot, 'secondary'), dataRoot);
      const lease = runtime.getLease();

      // Create a mock NativeTabHost with controlPlane attached
      const mockTabs = new Map<string, any>([
        ['tab-primary', { state: { url: 'https://haravan.com' } }],
        ['tab-secondary', { state: { url: 'https://sapo.vn' } }],
      ]);

      const host = {
        tabs: mockTabs,
        controlPlane: runtime,
        activeTabId: 'tab-primary',
        documentGenerations: new Map([
          ['tab-primary', 1],
          ['tab-secondary', 3],
        ]),
        getDocumentGeneration(tId?: string) {
          return this.documentGenerations.get(tId || this.activeTabId) || 1;
        },
        isCurrentTarget: (target: BrowserTarget) => {
          return NativeTabHost.prototype.isCurrentTarget.call(host, target);
        },
      };

      // 1. Primary workspace target at gen 1 -> VALID
      const targetPrimary: BrowserTarget = {
        projectId,
        workspaceId: wsPrimary,
        runtimeId: lease.runtimeId,
        tabId: 'tab-primary',
        browserEpoch: 1,
        documentGeneration: 1,
      };
      assert.strictEqual(host.isCurrentTarget(targetPrimary), true);

      // 2. Secondary registered workspace target at gen 3 -> VALID
      const targetSecondary: BrowserTarget = {
        projectId,
        workspaceId: wsSecondary,
        runtimeId: lease.runtimeId,
        tabId: 'tab-secondary',
        browserEpoch: 1,
        documentGeneration: 3,
      };
      assert.strictEqual(host.isCurrentTarget(targetSecondary), true, 'Secondary workspace registered in controlPlane.workspaces must be accepted');

      // 3. Stale document generation on secondary workspace -> REJECTED
      const staleSecondary: BrowserTarget = {
        ...targetSecondary,
        documentGeneration: 2, // Host is at 3
      };
      assert.strictEqual(host.isCurrentTarget(staleSecondary), false, 'Stale documentGeneration must be rejected');

      // 4. Unknown unregistered workspace -> REJECTED
      const unknownWsTarget: BrowserTarget = {
        ...targetPrimary,
        workspaceId: makeControlPlaneId('workspace'),
      };
      assert.strictEqual(host.isCurrentTarget(unknownWsTarget), false, 'Unregistered workspace must be rejected');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('guarantees deterministic session partition derivation per capsule and user agent mode', () => {
    const part1 = deriveCapsulePartition('haravan-store-1', 'clean');
    const part2 = deriveCapsulePartition('sapo-store-2', 'clean');
    const part1Native = deriveCapsulePartition('haravan-store-1', 'native');

    assert.strictEqual(part1, 'persist:capsule-haravan-store-1');
    assert.strictEqual(part2, 'persist:capsule-sapo-store-2');
    assert.strictEqual(part1Native, 'persist:capsule-haravan-store-1-native');

    // Partitions must be distinct
    assert.notStrictEqual(part1, part2);
    assert.notStrictEqual(part1, part1Native);
  });
});
