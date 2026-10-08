import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { makeControlPlaneId, CapabilityError, CapabilityRequestContext } from '../../src/shared/control-plane-contracts';
import { ThemeWorkspaceContext } from '../../src/shared/theme-task-context';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { planToolCall } from '../../src/omp-hooks/edit-guard-policy';
import { resolveWorkspaceShape } from '../../src/omp-hooks/theme-paths';

describe('Multi-Tenant Shop Isolation Proof (Task 6.3)', () => {
  it('prevents cross-contamination between TestVyan and Vyantechnology sharing same org_id', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-shop-iso-data-'));
    const testVyanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-testvyan-ws-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      // 1. Setup workspace TestVyan (org_id: 200000878093, themeId: 1001510621)
      const testVyanCliLocal = {
        org_id: '200000878093',
        theme_id: '1001510621',
        theme_name: 'Test sao chép',
        theme_org_id: '200000878093',
      };
      fs.writeFileSync(
        path.join(testVyanRoot, '.haravan-cli_local.json'),
        JSON.stringify(testVyanCliLocal, null, 2),
        'utf-8'
      );
      fs.mkdirSync(path.join(testVyanRoot, 'config'), { recursive: true });
      const initialSettings = JSON.stringify({ current: 'testvyan-initial' });
      fs.writeFileSync(
        path.join(testVyanRoot, 'config', 'settings_data.json'),
        initialSettings,
        'utf-8'
      );
      const initialSha = crypto.createHash('sha256').update(initialSettings).digest('hex');

      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot: testVyanRoot,
      });
      await runtime.initialize();

      runtime.projects.registerProject({
        id: projectId,
        name: 'Shop Isolation Project',
        dataRoot,
        state: 'open',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      runtime.workspaces.register({
        id: workspaceId,
        projectId,
        rootPath: testVyanRoot,
        state: 'attached',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      let tabEvalPayload: unknown = null;
      const mockHost: BrowserHostPort = {
        hasTab: () => true,
        resolveTargetTabId: (id) => id || 'tab-vyantech',
        getTabList: () => [{ id: 'tab-vyantech' }],
        getActiveTabId: () => 'tab-vyantech',
        getAutomationTabId: () => 'tab-vyantech',
        getBrowserEpoch: () => 1,
        getDocumentGeneration: () => 1,
        getMutationRevision: () => 1,
        navigate: async () => true,
        reload: async () => true,
        getDom: async () => '<html><body></body></html>',
        captureScreenshot: async () => Buffer.from('screenshot').toString('base64'),
        evalJs: async () => tabEvalPayload,
        isCurrentTarget: () => true,
      };

      const browserPort = new BrowserControlPort(mockHost, runtime.artifacts);
      runtime.registerBrowser(browserPort);

      const context: CapabilityRequestContext = {
        lease: runtime.getLease(),
        leaseToken: 'token-shop-iso',
        projectId,
        workspaceId,
      };

      // 2. Attempt theme.transaction.write_cas targeting config/settings_data.json
      //    using a simulated tab for Vyantechnology (org_id: 200000878093, themeId: 1001509080)
      tabEvalPayload = {
        theme: { id: '1001509080' },
        shop: null,
        hstaticLinks: ['https://theme.hstatic.net/200000878093/1001509080/14/style.css'],
        headSnippet: '',
      };

      const themeContext: ThemeWorkspaceContext = {
        storeId: 'store-vyan',
        storeDomain: 'vyantechnology.com',
        themeId: '1001510621',
        workspaceRoot: testVyanRoot,
        targetTabId: 'tab-vyantech',
        platform: 'haravan',
      };

      await runtime.capabilities.get('theme.transaction.begin')!.execute({ context: themeContext }, context);

      // 3. Verify write_cas throws CapabilityError('SHOP_IDENTITY_MISMATCH')
      await assert.rejects(
        async () => {
          await runtime.capabilities.get('theme.transaction.write_cas')!.execute(
            {
              workspaceRoot: testVyanRoot,
              relativePath: 'config/settings_data.json',
              content: '{"current":"cross-tenant-write-attempt"}',
              expectedSha256: initialSha,
            },
            context
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError, 'Error should be a CapabilityError');
          assert.strictEqual(err.code, 'SHOP_IDENTITY_MISMATCH');
          assert.ok(
            err.message.includes('org=200000878093 theme=1001509080'),
            'Message must cite tab shop credentials'
          );
          assert.ok(
            err.message.includes('org=200000878093 theme=1001510621'),
            'Message must cite workspace shop credentials'
          );
          return true;
        }
      );

      await runtime.capabilities.get('theme.transaction.rollback')!.execute({ workspaceRoot: testVyanRoot }, context);

      // 4. Verify that when tab matches TestVyan (themeId: 1001510621), write_cas succeeds
      tabEvalPayload = {
        theme: { id: '1001510621' },
        shop: null,
        hstaticLinks: ['https://theme.hstatic.net/200000878093/1001510621/14/style.css'],
        headSnippet: '',
      };

      await runtime.capabilities.get('theme.transaction.begin')!.execute({ context: themeContext }, context);
      const writeResult = (await runtime.capabilities.get('theme.transaction.write_cas')!.execute(
        {
          workspaceRoot: testVyanRoot,
          relativePath: 'config/settings_data.json',
          content: '{"current":"testvyan-legitimate-update"}',
          expectedSha256: initialSha,
        },
        context
      )) as { relativePath: string; newSha256: string };

      assert.strictEqual(writeResult.relativePath, 'config/settings_data.json');
      assert.strictEqual(
        fs.readFileSync(path.join(testVyanRoot, 'config', 'settings_data.json'), 'utf-8'),
        '{"current":"testvyan-legitimate-update"}'
      );
      await runtime.capabilities.get('theme.transaction.rollback')!.execute({ workspaceRoot: testVyanRoot }, context);

      // 5. A native OMP write to config/settings_data.json is no longer a policy refusal in
      //    any mode: the edit-guard hook gates it on a scoped `hrv theme fetch` instead
      //    (REFUSED_SETTINGS_DATA_FETCH_FAILED), so the pure policy must let it through.
      const shape = resolveWorkspaceShape(testVyanRoot);
      // (fast additionally depends on the writable set, covered by test/unit/edit-guard.test.mjs.)
      for (const mode of ['unset', 'core', 'direct'] as const) {
        for (const tool of ['write', 'edit']) {
          const plan = planToolCall({
            mode,
            tool,
            input: { path: 'config/settings_data.json', content: '{"current": {}}' },
            shape,
          });
          assert.strictEqual(plan.decision, 'allow', `${tool} in ${mode}`);
        }
      }
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(testVyanRoot, { recursive: true, force: true });
    }
  });
});
