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

describe('ThemeTransactionRegistry ControlPlane Integration & Capability Dispatch', () => {
  it('blocks direct file.write with TRANSACTION_CONFLICT when transaction is active, and unblocks after settle', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-tx-test-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-tx-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
      });
      await runtime.initialize();

      runtime.projects.registerProject({
        id: projectId,
        name: 'Project',
        dataRoot,
        state: 'open',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      runtime.workspaces.register({
        id: workspaceId,
        projectId,
        rootPath: workspaceRoot,
        state: 'attached',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const context: CapabilityRequestContext = {
        lease: runtime.getLease(),
        leaseToken: 'token-tx-test',
        projectId,
        workspaceId,
      };

      // 1. Initially, direct file.write succeeds
      const initialFile = 'sections/header.liquid';
      const initialContent = '<header>Initial Header</header>';
      await runtime.capabilities.get('file.write')!.execute(
        { path: initialFile, content: initialContent },
        context
      );
      assert.strictEqual(
        fs.readFileSync(path.join(workspaceRoot, initialFile), 'utf-8'),
        initialContent
      );
      const initialSha256 = crypto.createHash('sha256').update(initialContent).digest('hex');

      // 2. Begin theme transaction via capability catalogue
      const themeContext: ThemeWorkspaceContext = {
        storeId: 'store-test',
        storeDomain: 'test.myharavan.com',
        themeId: '100999',
        workspaceRoot,
        targetTabId: 'tab-main',
        platform: 'haravan',
      };

      const beginRes = (await runtime.capabilities.get('theme.transaction.begin')!.execute(
        { context: themeContext },
        context
      )) as { sessionId: string; canonicalRoot: string };
      assert.ok(beginRes.sessionId.startsWith('tx-'));

      // 3. Direct file.write MUST be rejected with TRANSACTION_CONFLICT
      await assert.rejects(
        async () => {
          await runtime.capabilities.get('file.write')!.execute(
            { path: 'snippets/rogue.liquid', content: '<p>rogue</p>' },
            context
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'TRANSACTION_CONFLICT');
          return true;
        }
      );

      // 4. Mutation through theme.transaction.write_cas succeeds
      const updatedContent = '<header>Mutated Header CAS</header>';
      const casRes = (await runtime.capabilities.get('theme.transaction.write_cas')!.execute(
        {
          workspaceRoot,
          relativePath: initialFile,
          content: updatedContent,
          expectedSha256: initialSha256,
        },
        context
      )) as { relativePath: string; previousSha256: string; newSha256: string; bytesWritten: number };

      assert.strictEqual(casRes.relativePath, initialFile);
      assert.strictEqual(casRes.previousSha256, initialSha256);
      assert.strictEqual(
        fs.readFileSync(path.join(workspaceRoot, initialFile), 'utf-8'),
        updatedContent
      );

      // 5. Premature VERIFIED settlement before remote sync is rejected
      await assert.rejects(
        async () => {
          await runtime.capabilities.get('theme.transaction.settle')!.execute(
            {
              workspaceRoot,
              verdict: 'VERIFIED',
              details: { note: 'Visual inspection matched golden reference' },
            },
            context
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'SESSION_STALE');
          return true;
        }
      );

      // 6. Settle with REJECTED under default HARD_FAIL_ROLLBACK policy -> auto rollback to R0
      const settleRes = (await runtime.capabilities.get('theme.transaction.settle')!.execute(
        {
          workspaceRoot,
          verdict: 'REJECTED',
          details: { note: 'Visual regression detected' },
        },
        context
      )) as { verdict: string; rolledBack: boolean };

      assert.strictEqual(settleRes.verdict, 'REJECTED');
      assert.strictEqual(settleRes.rolledBack, true);
      assert.strictEqual(
        fs.readFileSync(path.join(workspaceRoot, initialFile), 'utf-8'),
        initialContent
      );

      // 7. Direct file.write is unblocked and succeeds again
      await runtime.capabilities.get('file.write')!.execute(
        { path: 'snippets/unblocked.liquid', content: '<p>unblocked</p>' },
        context
      );
      assert.strictEqual(
        fs.readFileSync(path.join(workspaceRoot, 'snippets/unblocked.liquid'), 'utf-8'),
        '<p>unblocked</p>'
      );
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('enforces tenancy checks rejecting mismatched projectId with WORKSPACE_UNBOUND', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-tx-tenancy-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-tx-tenancy-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
      });
      await runtime.initialize();

      const themeContext: ThemeWorkspaceContext = {
        storeId: 'store-test',
        storeDomain: 'test.myharavan.com',
        themeId: '100999',
        workspaceRoot,
        targetTabId: 'tab-main',
        platform: 'haravan',
      };

      const mismatchedContext: CapabilityRequestContext = {
        lease: runtime.getLease(),
        leaseToken: 'token-mismatch',
        projectId: makeControlPlaneId('project'), // foreign project id
        workspaceId,
      };

      await assert.rejects(
        async () => {
          await runtime.capabilities.get('theme.transaction.begin')!.execute(
            { context: themeContext },
            mismatchedContext
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'WORKSPACE_UNBOUND');
          assert.match(err.message, /tenancy mismatch/i);
          return true;
        }
      );
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('registerBrowser dynamically binds browserPort into ThemeTransactionRegistry', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-tx-browser-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-tx-browser-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
      });
      await runtime.initialize();

      let reloadedTabId = '';
      const mockHost: BrowserHostPort = {
        hasTab: () => true,
        resolveTargetTabId: (id) => id || 'tab-main',
        getTabList: () => [{ id: 'tab-main' }],
        getActiveTabId: () => 'tab-main',
        getAutomationTabId: () => 'tab-main',
        getBrowserEpoch: () => 1,
        getDocumentGeneration: () => 1,
        getMutationRevision: () => 1,
        navigate: async () => true,
        reload: async (tabId) => {
          reloadedTabId = tabId;
          return true;
        },
        getDom: async () => '<html><body></body></html>',
        captureScreenshot: async () => Buffer.from('screenshot').toString('base64'),
        evalJs: async () => true,
        isCurrentTarget: () => true,
      };

      const browserPort = new BrowserControlPort(mockHost, runtime.artifacts);
      runtime.registerBrowser(browserPort);

      // ThemeTransactionRegistry should now have the bound browser port
      const themeContext: ThemeWorkspaceContext = {
        storeId: 'store-test',
        storeDomain: 'test.myharavan.com',
        themeId: '100999',
        workspaceRoot,
        targetTabId: 'tab-main',
        platform: 'haravan',
      };

      const beginRes = await runtime.themeTransactions.begin(themeContext);
      assert.ok(beginRes.sessionId.startsWith('tx-'));
      await runtime.themeTransactions.rollback(workspaceRoot);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('enforces shop identity on config/settings_data.json: unbound workspace, absent tab, unverified tab, mismatched tab, and matching tab', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-tx-test-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-tx-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
      });
      await runtime.initialize();

      runtime.projects.registerProject({
        id: projectId,
        name: 'Project',
        dataRoot,
        state: 'open',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      runtime.workspaces.register({
        id: workspaceId,
        projectId,
        rootPath: workspaceRoot,
        state: 'attached',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      let tabEvalPayload: unknown = null;
      const mockHost: BrowserHostPort = {
        hasTab: () => true,
        resolveTargetTabId: (id) => id || 'tab-main',
        getTabList: () => [{ id: 'tab-main' }],
        getActiveTabId: () => 'tab-main',
        getAutomationTabId: () => 'tab-main',
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
        leaseToken: 'token-tx-test',
        projectId,
        workspaceId,
      };

      // Create config/ directory in workspace
      fs.mkdirSync(path.join(workspaceRoot, 'config'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, 'config', 'settings_data.json'), '{}', 'utf-8');
      const initialSha = crypto.createHash('sha256').update('{}').digest('hex');

      // Case A: workspace lacks .haravan-cli_local.json -> WORKSPACE_SHOP_UNBOUND
      const themeContextA: ThemeWorkspaceContext = {
        storeId: 'store-test',
        storeDomain: 'test.myharavan.com',
        themeId: '1001507718',
        workspaceRoot,
        targetTabId: 'tab-main',
        platform: 'haravan',
      };
      await runtime.capabilities.get('theme.transaction.begin')!.execute({ context: themeContextA }, context);

      await assert.rejects(
        async () => {
          await runtime.capabilities.get('theme.transaction.write_cas')!.execute(
            {
              workspaceRoot,
              relativePath: 'config/settings_data.json',
              content: '{"current":"v1"}',
              expectedSha256: initialSha,
            },
            context
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'WORKSPACE_SHOP_UNBOUND');
          return true;
        }
      );
      await runtime.capabilities.get('theme.transaction.rollback')!.execute({ workspaceRoot }, context);

      // Now create valid .haravan-cli_local.json for workspace
      fs.writeFileSync(
        path.join(workspaceRoot, '.haravan-cli_local.json'),
        JSON.stringify({ org_id: '200001202565', theme_id: '1001507718' }),
        'utf-8'
      );

      // Case B: empty targetTabId in write_cas -> TARGET_TAB_REQUIRED
      const themeContextB: ThemeWorkspaceContext = {
        storeId: 'store-test',
        storeDomain: 'test.myharavan.com',
        themeId: '1001507718',
        workspaceRoot,
        targetTabId: 'tab-main',
        platform: 'haravan',
      };
      await runtime.capabilities.get('theme.transaction.begin')!.execute({ context: themeContextB }, context);

      await assert.rejects(
        async () => {
          await runtime.capabilities.get('theme.transaction.write_cas')!.execute(
            {
              workspaceRoot,
              relativePath: 'config/settings_data.json',
              content: '{"current":"v2"}',
              expectedSha256: initialSha,
              targetTabId: '',
            },
            context
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'TARGET_TAB_REQUIRED');
          return true;
        }
      );
      await runtime.capabilities.get('theme.transaction.rollback')!.execute({ workspaceRoot }, context);

      // Case C: unverified tab (blank/external page, returns null or no shop) -> TAB_SHOP_UNVERIFIED
      tabEvalPayload = null; // Blank tab
      const themeContextC: ThemeWorkspaceContext = {
        storeId: 'store-test',
        storeDomain: 'test.myharavan.com',
        themeId: '1001507718',
        workspaceRoot,
        targetTabId: 'tab-main',
        platform: 'haravan',
      };
      await runtime.capabilities.get('theme.transaction.begin')!.execute({ context: themeContextC }, context);

      await assert.rejects(
        async () => {
          await runtime.capabilities.get('theme.transaction.write_cas')!.execute(
            {
              workspaceRoot,
              relativePath: 'config/settings_data.json',
              content: '{"current":"v3"}',
              expectedSha256: initialSha,
            },
            context
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'TAB_SHOP_UNVERIFIED');
          return true;
        }
      );

      // Also tab proving only theme_id but no org_id -> TAB_SHOP_UNVERIFIED (fail-closed)
      tabEvalPayload = {
        theme: { id: 1001507718 },
        shop: null,
        hstaticLinks: [],
        headSnippet: '',
      };
      await assert.rejects(
        async () => {
          await runtime.capabilities.get('theme.transaction.write_cas')!.execute(
            {
              workspaceRoot,
              relativePath: 'config/settings_data.json',
              content: '{"current":"v3-incomplete"}',
              expectedSha256: initialSha,
            },
            context
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'TAB_SHOP_UNVERIFIED');
          return true;
        }
      );
      await runtime.capabilities.get('theme.transaction.rollback')!.execute({ workspaceRoot }, context);

      // Case D: mismatched shop (tab is org=999999 theme=888888 vs workspace 200001202565 / 1001507718) -> SHOP_IDENTITY_MISMATCH
      tabEvalPayload = {
        theme: { id: '888888' },
        shop: null,
        hstaticLinks: ['https://theme.hstatic.net/999999/888888/14/style.css'],
        headSnippet: '',
      };
      await runtime.capabilities.get('theme.transaction.begin')!.execute({ context: themeContextC }, context);

      await assert.rejects(
        async () => {
          await runtime.capabilities.get('theme.transaction.write_cas')!.execute(
            {
              workspaceRoot,
              relativePath: 'config/settings_data.json',
              content: '{"current":"v4"}',
              expectedSha256: initialSha,
            },
            context
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'SHOP_IDENTITY_MISMATCH');
          assert.ok(err.message.includes('Target tab belongs to shop'));
          return true;
        }
      );
      await runtime.capabilities.get('theme.transaction.rollback')!.execute({ workspaceRoot }, context);

      // Case E: matching shop (tab proves org=200001202565 and theme=1001507718) -> write succeeds!
      tabEvalPayload = {
        theme: { id: '1001507718' },
        shop: null,
        hstaticLinks: ['https://theme.hstatic.net/200001202565/1001507718/14/style.css'],
        headSnippet: '',
      };
      await runtime.capabilities.get('theme.transaction.begin')!.execute({ context: themeContextC }, context);

      const successRes = (await runtime.capabilities.get('theme.transaction.write_cas')!.execute(
        {
          workspaceRoot,
          relativePath: 'config/settings_data.json',
          content: '{"current":"v-matched"}',
          expectedSha256: initialSha,
        },
        context
      )) as { relativePath: string; newSha256: string };

      assert.strictEqual(successRes.relativePath, 'config/settings_data.json');
      assert.strictEqual(
        fs.readFileSync(path.join(workspaceRoot, 'config', 'settings_data.json'), 'utf-8'),
        '{"current":"v-matched"}'
      );
      await runtime.capabilities.get('theme.transaction.rollback')!.execute({ workspaceRoot }, context);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('runs theme.settings_check capability offline without requiring a browser target', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-sc-test-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-sc-test-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      fs.mkdirSync(path.join(workspaceRoot, 'config'), { recursive: true });
      fs.mkdirSync(path.join(workspaceRoot, 'snippets'), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceRoot, 'config', 'settings.html'),
        '<fieldset><input type="file" name="test_logo.png" /></fieldset>',
        'utf8',
      );
      fs.writeFileSync(
        path.join(workspaceRoot, 'snippets', 'test.liquid'),
        '<img src="{{ settings[\'test_logo.png\'] }}">',
        'utf8',
      );

      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
      });
      await runtime.initialize();

      const capability = runtime.capabilities.get('theme.settings_check');
      assert.ok(capability, 'theme.settings_check should be registered');
      assert.strictEqual(capability.policy.requiresBrowserTarget, false);
      assert.strictEqual(capability.policy.risk, 'read');

      const context: CapabilityRequestContext = {
        lease: runtime.getLease(),
        leaseToken: 'token-sc-test',
        projectId,
        workspaceId,
      };

      const result = (await capability.execute(
        { workspaceRoot },
        context
      )) as {
        ok: boolean;
        failures: Array<{ rule: string; id?: string }>;
        totalFailures: number;
        refusals: unknown[];
      };

      assert.strictEqual(result.ok, false);
      assert.ok(result.totalFailures > 0);
      const uploadReads = result.failures.filter((f) => f.rule === 'HARAVAN_SETTINGS_UPLOAD_READ');
      assert.strictEqual(uploadReads.length, 1);
      assert.ok(uploadReads[0]);
      assert.strictEqual(uploadReads[0].id, 'test_logo.png');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
