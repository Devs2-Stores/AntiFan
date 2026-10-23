import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import {
  makeControlPlaneId,
  CapabilityError,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
  canonicalizeWorkspaceRoot,
} from '../../src/shared/control-plane-contracts';
import { ThemeWorkspaceContext } from '../../src/shared/theme-task-context';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import type { TerminalManager } from '../../src/main/browser/terminal-manager';

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

  it('lets every project drive its own transaction and refuses foreign roots, foreign sessions and overlapping locks', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-tx-multi-'));
    const bootRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-tx-boot-'));
    const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-tx-parent-'));
    const themeRoot = path.join(parentRoot, 'timer-watch');
    const bootProjectId = makeControlPlaneId('project');
    const bootWorkspaceId = makeControlPlaneId('workspace');
    const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
    const codeOf = (expected: string, pattern?: RegExp) => (err: unknown) => {
      assert.ok(err instanceof CapabilityError);
      assert.strictEqual(err.code, expected, err.message);
      if (pattern) assert.match(err.message, pattern);
      return true;
    };

    try {
      fs.mkdirSync(path.join(themeRoot, 'sections'), { recursive: true });
      fs.mkdirSync(path.join(themeRoot, 'config'), { recursive: true });
      const original = '<section>Original</section>';
      fs.writeFileSync(path.join(themeRoot, 'sections', 'hero.liquid'), original, 'utf8');
      fs.writeFileSync(path.join(themeRoot, 'config', 'settings_data.json'), '{}', 'utf8');
      fs.writeFileSync(
        path.join(themeRoot, '.haravan-cli_local.json'),
        JSON.stringify({ org_id: '200001202565', theme_id: '100999' }),
        'utf8'
      );

      const runtime = new ControlPlaneRuntime({
        projectId: bootProjectId,
        workspaceId: bootWorkspaceId,
        dataRoot,
        workspaceRoot: bootRoot,
      });
      await runtime.initialize();

      let tabProbes = 0;
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
        evalJs: async () => {
          tabProbes += 1;
          return {
            theme: { id: '100999' },
            shop: null,
            hstaticLinks: ['https://theme.hstatic.net/200001202565/100999/14/style.css'],
            headSnippet: '',
          };
        },
        isCurrentTarget: () => true,
      };
      runtime.registerBrowser(new BrowserControlPort(mockHost, runtime.artifacts));
      // async: file.write throws synchronously, and assert.rejects only sees rejections.
      const exec = async (name: string, params: Record<string, unknown>, context: CapabilityRequestContext): Promise<unknown> =>
        runtime.capabilities.get(name)!.execute(params, context);
      const contextFor = (projectId: string, workspaceId: string): CapabilityRequestContext => ({
        lease: runtime.getLease(),
        leaseToken: `token-${projectId}`,
        projectId,
        workspaceId,
      });
      const themeContext = (workspaceRoot: string): ThemeWorkspaceContext => ({
        storeId: 'store-test',
        storeDomain: 'test.myharavan.com',
        themeId: '100999',
        workspaceRoot,
        targetTabId: 'tab-main',
        platform: 'haravan',
      });

      // A second project (the Timer Watch shape) and a third whose root contains it.
      const theme = runtime.projects.createProject('Timer Watch', dataRoot);
      const themeWs = runtime.workspaces.attach(theme.id, themeRoot);
      const umbrella = runtime.projects.createProject('Umbrella', dataRoot);
      const umbrellaWs = runtime.workspaces.attach(umbrella.id, parentRoot);
      const bootCtx = contextFor(bootProjectId, bootWorkspaceId);
      const themeCtx = contextFor(theme.id, themeWs.id);
      const umbrellaCtx = contextFor(umbrella.id, umbrellaWs.id);

      // The non-boot project begins, writes and is not mistaken for a foreign tenant.
      const begun = (await exec('theme.transaction.begin', { context: themeContext(themeRoot) }, themeCtx)) as {
        sessionId: string;
        canonicalRoot: string;
      };
      assert.ok(begun.sessionId.startsWith('tx-'));
      await exec(
        'theme.transaction.write_cas',
        { relativePath: 'sections/hero.liquid', content: '<section>Changed</section>', expectedSha256: sha(original) },
        themeCtx
      );
      assert.strictEqual(fs.readFileSync(path.join(themeRoot, 'sections', 'hero.liquid'), 'utf8'), '<section>Changed</section>');

      // Another project cannot name a root outside its own workspace...
      await assert.rejects(
        () => exec('theme.transaction.rollback', { workspaceRoot: themeRoot }, bootCtx),
        codeOf('OUTSIDE_WORKSPACE', /outside the caller's workspace/)
      );
      await assert.rejects(
        () => exec('theme.transaction.begin', { context: themeContext(themeRoot) }, bootCtx),
        codeOf('OUTSIDE_WORKSPACE')
      );
      // ...and one whose workspace contains the root still cannot drive the live owner's session.
      await assert.rejects(
        () => exec('theme.transaction.rollback', { workspaceRoot: themeRoot }, umbrellaCtx),
        codeOf('WORKSPACE_UNBOUND', /belongs to another project/)
      );
      await assert.rejects(
        () => exec('theme.transaction.settle', { workspaceRoot: themeRoot, verdict: 'REJECTED' }, umbrellaCtx),
        codeOf('WORKSPACE_UNBOUND', /belongs to another project/)
      );
      await assert.rejects(
        () =>
          exec(
            'theme.transaction.write_cas',
            {
              workspaceRoot: themeRoot,
              relativePath: 'config/settings_data.json',
              content: '{"current":"foreign"}',
              expectedSha256: sha('{}'),
            },
            umbrellaCtx
          ),
        codeOf('WORKSPACE_UNBOUND', /belongs to another project/)
      );
      assert.strictEqual(tabProbes, 0, 'foreign write_cas must be refused before probing the session tab');

      // An ancestor root overlaps the held root: begin and direct writes are locked out,
      // and the foreign session id is not disclosed.
      await assert.rejects(
        () => exec('theme.transaction.begin', { context: themeContext(parentRoot) }, umbrellaCtx),
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'TRANSACTION_CONFLICT');
          assert.match(err.message, /another project/);
          assert.ok(!err.message.includes(begun.sessionId), 'foreign session id must not leak');
          return true;
        }
      );
      await assert.rejects(
        () => exec('file.write', { path: 'timer-watch/sections/hero.liquid', content: 'x' }, umbrellaCtx),
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'TRANSACTION_CONFLICT');
          assert.ok(!err.message.includes(begun.sessionId), 'foreign session id must not leak in file.write message');
          assert.strictEqual(
            (err.details as { activeSessionId?: string } | undefined)?.activeSessionId,
            undefined,
            'foreign session id must not leak in file.write details'
          );
          return true;
        }
      );
      await assert.rejects(
        () => exec('file.write', { path: 'sections/hero.liquid', content: 'x' }, themeCtx),
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'TRANSACTION_CONFLICT');
          assert.ok(err.message.includes(begun.sessionId), 'owner sees its own session id');
          assert.strictEqual(
            (err.details as { activeSessionId?: string } | undefined)?.activeSessionId,
            begun.sessionId
          );
          return true;
        }
      );

      // A non-overlapping project transacts in parallel.
      await exec('theme.transaction.begin', { context: themeContext(bootRoot) }, bootCtx);
      await exec('theme.transaction.rollback', {}, bootCtx);

      // Once the owner's project closes, its session is orphaned: a containing workspace may discard it.
      runtime.projects.closeProject(theme.id);
      await assert.rejects(
        () => exec('theme.transaction.begin', { context: themeContext(parentRoot) }, umbrellaCtx),
        codeOf('TRANSACTION_CONFLICT', /no longer attached/)
      );
      await exec('theme.transaction.rollback', { workspaceRoot: themeRoot, reason: 'owner closed' }, umbrellaCtx);
      assert.strictEqual(fs.readFileSync(path.join(themeRoot, 'sections', 'hero.liquid'), 'utf8'), original);
      const umbrellaBegun = (await exec('theme.transaction.begin', { context: themeContext(parentRoot) }, umbrellaCtx)) as {
        sessionId: string;
      };
      assert.ok(umbrellaBegun.sessionId.startsWith('tx-'));
      await exec(
        'theme.transaction.write_cas',
        {
          relativePath: 'timer-watch/sections/hero.liquid',
          content: '<section>Umbrella Changed</section>',
          expectedSha256: sha(original),
        },
        umbrellaCtx
      );
      assert.strictEqual(
        fs.readFileSync(path.join(themeRoot, 'sections', 'hero.liquid'), 'utf8'),
        '<section>Umbrella Changed</section>'
      );

      // Re-open a child project inside parentRoot while the ancestor transaction is live:
      // the child cannot take over a live ancestor transaction.
      const child = runtime.projects.createProject('Timer Watch Reopened', dataRoot);
      const childWs = runtime.workspaces.attach(child.id, themeRoot);
      const childCtx = contextFor(child.id, childWs.id);
      const canonicalParentRoot = canonicalizeWorkspaceRoot(parentRoot);
      await assert.rejects(
        () => exec('theme.transaction.begin', { context: themeContext(themeRoot) }, childCtx),
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'TRANSACTION_CONFLICT');
          assert.ok(!err.message.includes(umbrellaBegun.sessionId), 'foreign ancestor session id must not leak');
          assert.ok(!err.message.includes(`on "${canonicalParentRoot}"`), 'foreign ancestor root must not leak');
          return true;
        }
      );
      await assert.rejects(
        () => exec('theme.transaction.rollback', {}, childCtx),
        codeOf('WORKSPACE_UNBOUND', /Project tenancy mismatch/)
      );
      assert.strictEqual(
        fs.readFileSync(path.join(themeRoot, 'sections', 'hero.liquid'), 'utf8'),
        '<section>Umbrella Changed</section>',
        'live ancestor transaction must not be rolled back by child'
      );

      // Once the ancestor project closes, its overlapping transaction is orphaned:
      // the child workspace can discard it from its own workspace root and restore R0.
      runtime.projects.closeProject(umbrella.id);
      await assert.rejects(
        () => exec('theme.transaction.begin', { context: themeContext(themeRoot) }, childCtx),
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual(err.code, 'TRANSACTION_CONFLICT');
          assert.match(err.message, /no longer attached.*call theme\.transaction\.rollback from your own workspace/);
          assert.ok(!err.message.includes(`on "${canonicalParentRoot}"`), 'foreign ancestor root must not leak');
          return true;
        }
      );
      await exec('theme.transaction.rollback', { reason: 'ancestor closed' }, childCtx);
      assert.strictEqual(
        fs.readFileSync(path.join(themeRoot, 'sections', 'hero.liquid'), 'utf8'),
        original,
        'rolling back orphaned ancestor restores R0 snapshot'
      );
      const childBegun = (await exec('theme.transaction.begin', { context: themeContext(themeRoot) }, childCtx)) as {
        sessionId: string;
      };
      assert.ok(childBegun.sessionId.startsWith('tx-'));
      await exec('theme.transaction.rollback', {}, childCtx);

      // An EXPLORATORY_HOLD session on an ancestor root that becomes orphaned can also
      // be resolved via theme.transaction.resolve_hold from the child workspace.
      const umbrellaReopened = runtime.projects.createProject('Umbrella Held', dataRoot);
      const umbrellaReopenedWs = runtime.workspaces.attach(umbrellaReopened.id, parentRoot);
      const umbrellaReopenedCtx = contextFor(umbrellaReopened.id, umbrellaReopenedWs.id);
      await exec(
        'theme.transaction.begin',
        { context: themeContext(parentRoot), policy: 'EXPLORATORY_HOLD' },
        umbrellaReopenedCtx
      );
      await exec(
        'theme.transaction.write_cas',
        {
          relativePath: 'timer-watch/sections/hero.liquid',
          content: '<section>Held Ancestor</section>',
          expectedSha256: sha(original),
        },
        umbrellaReopenedCtx
      );
      await exec('theme.transaction.settle', { verdict: 'HELD' }, umbrellaReopenedCtx);
      await assert.rejects(
        () => exec('theme.transaction.resolve_hold', { action: 'rollback' }, childCtx),
        codeOf('WORKSPACE_UNBOUND', /Project tenancy mismatch/)
      );
      runtime.projects.closeProject(umbrellaReopened.id);
      await exec('theme.transaction.resolve_hold', { action: 'rollback', reason: 'held ancestor closed' }, childCtx);
      assert.strictEqual(fs.readFileSync(path.join(themeRoot, 'sections', 'hero.liquid'), 'utf8'), original);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(bootRoot, { recursive: true, force: true });
      fs.rmSync(parentRoot, { recursive: true, force: true });
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

  it('settles VERIFIED after theme.transaction.await_sync_and_reload and refuses missing browserTarget with TARGET_REQUIRED', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-tx-sync-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-tx-sync-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    let restoreTerminal: (() => void) | undefined;
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

      let docGen = 1;
      let reloadedTabId = '';
      const mockHost: BrowserHostPort = {
        hasTab: () => true,
        resolveTargetTabId: (id) => id || 'tab-main',
        getTabList: () => [{ id: 'tab-main', url: 'https://test.myharavan.com/' }],
        getActiveTabId: () => 'tab-main',
        getAutomationTabId: () => 'tab-main',
        getBrowserEpoch: () => 1,
        getDocumentGeneration: () => docGen,
        getMutationRevision: () => 1,
        navigate: async () => true,
        reload: async (tabId) => {
          reloadedTabId = tabId;
          docGen += 1;
          return true;
        },
        getDom: async () => '<html><body></body></html>',
        captureScreenshot: async () => Buffer.from('screenshot').toString('base64'),
        evalJs: async () => true,
        isCurrentTarget: () => true,
      };

      const browserPort = new BrowserControlPort(mockHost, runtime.artifacts);
      runtime.registerBrowser(browserPort);

      let observedWaitInput: { sessionId?: string; afterSeq?: number } | undefined;
      const originalGetSession = runtime.terminal.getSession;
      const originalWaitTerminal = runtime.terminal.waitTerminal;
      restoreTerminal = () => {
        Object.assign(runtime.terminal, {
          getSession: originalGetSession,
          waitTerminal: originalWaitTerminal,
        });
      };
      Object.assign(runtime.terminal, {
        getSession: () => ({
          state: 'running',
          disposed: false,
          lastSeq: 8,
          sessionGeneration: 2,
        }),
        waitTerminal: async (input: { sessionId?: string; afterSeq?: number }) => {
          observedWaitInput = input;
          return {
            satisfied: true,
            lastSeq: 8,
            outputTail: '[14:30:05] Uploaded: snippets/banner.liquid\n',
            sessionGeneration: 2,
          };
        },
      });
      fs.mkdirSync(path.join(workspaceRoot, 'snippets'), { recursive: true });
      const initialContent = '<div class="banner">Old</div>';
      fs.writeFileSync(path.join(workspaceRoot, 'snippets', 'banner.liquid'), initialContent, 'utf8');
      const initialSha256 = crypto.createHash('sha256').update(initialContent).digest('hex');

      const baseContext: CapabilityRequestContext = {
        lease: runtime.getLease(),
        leaseToken: 'token-tx-sync',
        projectId,
        workspaceId,
      };

      const themeContext: ThemeWorkspaceContext = {
        storeId: 'store-test',
        storeDomain: 'test.myharavan.com',
        themeId: '100999',
        workspaceRoot,
        targetTabId: 'tab-main',
        platform: 'haravan',
      };

      await runtime.capabilities.get('theme.transaction.begin')!.execute(
        { context: themeContext, initialDocGen: 1 },
        baseContext
      );

      await runtime.capabilities.get('theme.transaction.write_cas')!.execute(
        {
          workspaceRoot,
          relativePath: 'snippets/banner.liquid',
          content: '<div class="banner">New</div>',
          expectedSha256: initialSha256,
        },
        baseContext
      );

      const awaitSyncCap = runtime.capabilities.get('theme.transaction.await_sync_and_reload');
      assert.ok(awaitSyncCap, 'theme.transaction.await_sync_and_reload must be registered');
      assert.ok(
        awaitSyncCap.description.includes('terminal.list') && awaitSyncCap.description.includes('snapshotThroughSeq'),
        'description must explain how to obtain cursor via terminal.list before write_cas'
      );

      await assert.rejects(
        async () => {
          await awaitSyncCap.execute(
            {
              workspaceRoot,
              cursor: { sessionId: 'term-hrv-1', sessionGeneration: 2, baselineSeq: 7 },
            },
            baseContext
          );
        },
        (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED'
      );

      const targetContext: CapabilityRequestContext = {
        ...baseContext,
        browserTarget: {
          projectId,
          workspaceId,
          runtimeId: runtime.getLease().runtimeId,
          tabId: 'tab-main',
          browserEpoch: 1,
          documentGeneration: 1,
        },
      };

      const syncReloadRes = (await awaitSyncCap.execute(
        {
          workspaceRoot,
          cursor: { sessionId: 'term-hrv-1', sessionGeneration: 2, baselineSeq: 7 },
          timeoutMs: 5000,
        },
        targetContext
      )) as {
        sync: { settled: boolean; lastSeq: number };
        reload: { reloaded: boolean; documentGeneration: number };
      };

      assert.strictEqual(syncReloadRes.sync.settled, true);
      assert.strictEqual(syncReloadRes.reload.reloaded, true);
      assert.strictEqual(syncReloadRes.reload.documentGeneration, 2);
      assert.strictEqual(reloadedTabId, 'tab-main');
      assert.strictEqual(observedWaitInput?.sessionId, 'term-hrv-1');
      assert.strictEqual(observedWaitInput?.afterSeq, 7);

      const settleRes = (await runtime.capabilities.get('theme.transaction.settle')!.execute(
        {
          workspaceRoot,
          verdict: 'VERIFIED',
          details: { note: 'Synced and verified' },
        },
        baseContext
      )) as { verdict: string; rolledBack: boolean };

      assert.strictEqual(settleRes.verdict, 'VERIFIED');
      assert.strictEqual(settleRes.rolledBack, false);
    } finally {
      restoreTerminal?.();
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('enforces terminal observe ownership on theme.transaction.await_sync_and_reload for attachment-bound callers', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-tx-term-own-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-tx-term-own-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    const waitedSessions: string[] = [];
    const terminal = {
      getSession: () => ({
        state: 'running',
        disposed: false,
        lastSeq: 5,
        sessionGeneration: 1,
      }),
      waitTerminal: async (input: { sessionId: string }) => {
        waitedSessions.push(input.sessionId);
        return {
          satisfied: true,
          lastSeq: 5,
          outputTail: '[14:30:05] Uploaded: snippets/banner.liquid\n',
          sessionGeneration: 1,
        };
      },
      getStats: () => ({ activeSessions: 3, totalCreated: 3, totalClosed: 0, bufferBytes: 0 }),
    } as unknown as TerminalManager;

    try {
      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot,
        terminal,
        terminalAuthority: {
          allowsTab: (tabId, terminalId) => tabId === 'tab-mine' && terminalId === 'terminal-mine',
          isAgentTerminal: (terminalId) => terminalId === 'terminal-mine' || terminalId === 'terminal-foreign',
          isAgentHeld: (terminalId) => terminalId === 'terminal-mine' || terminalId === 'terminal-foreign',
          bind: () => true,
          tabAffiliation: () => ({ live: true }),
        },
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

      let docGen = 1;
      const mockHost: BrowserHostPort = {
        hasTab: () => true,
        resolveTargetTabId: (id) => id || 'tab-mine',
        getTabList: () => [{ id: 'tab-mine', url: 'https://test.myharavan.com/' }],
        getActiveTabId: () => 'tab-mine',
        getAutomationTabId: () => 'tab-mine',
        getBrowserEpoch: () => 1,
        getDocumentGeneration: () => docGen,
        getMutationRevision: () => 1,
        navigate: async () => true,
        reload: async () => {
          docGen += 1;
          return true;
        },
        getDom: async () => '<html><body></body></html>',
        captureScreenshot: async () => Buffer.from('screenshot').toString('base64'),
        evalJs: async () => true,
        isCurrentTarget: () => true,
      };
      runtime.registerBrowser(new BrowserControlPort(mockHost, runtime.artifacts));

      fs.mkdirSync(path.join(workspaceRoot, 'snippets'), { recursive: true });
      const initialContent = '<div class="banner">Old</div>';
      fs.writeFileSync(path.join(workspaceRoot, 'snippets', 'banner.liquid'), initialContent, 'utf8');
      const initialSha256 = crypto.createHash('sha256').update(initialContent).digest('hex');

      const lease = runtime.getLease();
      const runId = makeControlPlaneId('run');
      const attemptId = makeControlPlaneId('attempt');
      const { launch } = await runtime.runs.attachments.issueAttachment(runId, attemptId, projectId, workspaceId, {
        backendId: 'mcp',
        lease,
        leaseToken: lease.token,
        tabId: 'tab-mine',
        grant: 'write',
      });
      const attachmentContext: AuthenticatedCapabilityContext = {
        attachmentId: launch.attachmentId,
        runId,
        attemptId,
        projectId,
        workspaceId,
        backendId: 'mcp',
        hostEpoch: lease.hostEpoch,
        invocationId: 'inv-await-sync-own',
        lease,
        leaseToken: lease.token,
        grant: 'write',
        browserTarget: {
          projectId,
          workspaceId,
          runtimeId: lease.runtimeId,
          tabId: 'tab-mine',
          browserEpoch: 1,
          documentGeneration: 1,
        },
      };

      const themeContext: ThemeWorkspaceContext = {
        storeId: 'store-test',
        storeDomain: 'test.myharavan.com',
        themeId: '100999',
        workspaceRoot,
        targetTabId: 'tab-mine',
        platform: 'haravan',
      };
      await runtime.capabilities.get('theme.transaction.begin')!.execute(
        { context: themeContext, initialDocGen: 1 },
        attachmentContext
      );
      await runtime.capabilities.get('theme.transaction.write_cas')!.execute(
        {
          workspaceRoot,
          relativePath: 'snippets/banner.liquid',
          content: '<div class="banner">New</div>',
          expectedSha256: initialSha256,
        },
        attachmentContext
      );

      const awaitSyncCap = runtime.capabilities.get('theme.transaction.await_sync_and_reload')!;
      await assert.rejects(
        async () =>
          awaitSyncCap.execute(
            {
              workspaceRoot,
              cursor: { sessionId: 'terminal-foreign', sessionGeneration: 1, baselineSeq: 4 },
              timeoutMs: 1000,
            },
            attachmentContext
          ),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_FORBIDDEN'
      );
      assert.deepStrictEqual(waitedSessions, [], 'foreign agent terminal must be refused before waitTerminal runs');

      const userSyncRes = (await awaitSyncCap.execute(
        {
          workspaceRoot,
          cursor: { sessionId: 'terminal-user', sessionGeneration: 1, baselineSeq: 4 },
          timeoutMs: 1000,
        },
        attachmentContext
      )) as { sync: { settled: boolean } };
      assert.strictEqual(userSyncRes.sync.settled, true);

      const ownSyncRes = (await awaitSyncCap.execute(
        {
          workspaceRoot,
          cursor: { sessionId: 'terminal-mine', sessionGeneration: 1, baselineSeq: 4 },
          timeoutMs: 1000,
        },
        attachmentContext
      )) as { sync: { settled: boolean } };
      assert.strictEqual(ownSyncRes.sync.settled, true);
      assert.deepStrictEqual(waitedSessions, ['terminal-user', 'terminal-mine']);

      await runtime.capabilities.get('theme.transaction.rollback')!.execute({ workspaceRoot }, attachmentContext);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('theme.settings_check passes valid Shopify sections, flags malformed section schema JSON, and flags corrupt Haravan settings_data.json', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cp-sc-shopify-'));
    const shopifyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-sc-shopify-'));
    const haravanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-sc-haravan-'));
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');

    try {
      fs.mkdirSync(path.join(shopifyRoot, 'sections'), { recursive: true });
      fs.writeFileSync(
        path.join(shopifyRoot, 'sections', 'hero.liquid'),
        '<section class="hero">{{ section.settings.heading }}</section>\n{% schema %}\n{"name":"Hero","settings":[{"type":"text","id":"heading"}]}\n{% endschema %}\n',
        'utf8'
      );

      const runtime = new ControlPlaneRuntime({
        projectId,
        workspaceId,
        dataRoot,
        workspaceRoot: shopifyRoot,
      });
      await runtime.initialize();

      const capability = runtime.capabilities.get('theme.settings_check')!;
      const context: CapabilityRequestContext = {
        lease: runtime.getLease(),
        leaseToken: 'token-sc-shopify',
        projectId,
        workspaceId,
      };

      // 1. Valid Shopify workspace with sections/*.liquid -> ok: true
      const validShopifyRes = (await capability.execute({ workspaceRoot: shopifyRoot }, context)) as {
        ok: boolean;
        failures: Array<{ rule: string; file?: string }>;
        totalFailures: number;
      };
      assert.strictEqual(validShopifyRes.ok, true);
      assert.strictEqual(validShopifyRes.totalFailures, 0);

      // 1b. A Shopify theme setting the platform reads itself (checkout_*) is never read in Liquid:
      // a warning there, not a refusal.
      fs.mkdirSync(path.join(shopifyRoot, 'config'), { recursive: true });
      fs.writeFileSync(
        path.join(shopifyRoot, 'config', 'settings_schema.json'),
        JSON.stringify([{ name: 'theme_info' }, { name: 'Checkout', settings: [{ type: 'image_picker', id: 'checkout_logo_image', label: 'Logo' }] }]),
        'utf8'
      );
      const checkoutSettingRes = (await capability.execute({ workspaceRoot: shopifyRoot }, context)) as {
        ok: boolean;
        warnings?: Array<{ rule: string; id?: string }>;
      };
      assert.strictEqual(checkoutSettingRes.ok, true);
      assert.ok(checkoutSettingRes.warnings?.some((w) => w.rule === 'dead-setting' && w.id === 'checkout_logo_image'));
      fs.rmSync(path.join(shopifyRoot, 'config'), { recursive: true, force: true });

      // 2. Malformed section schema JSON -> ok: false with SECTION_SCHEMA_JSON_INVALID
      fs.writeFileSync(
        path.join(shopifyRoot, 'sections', 'hero.liquid'),
        '<section class="hero"></section>\n{% schema %}\n{ malformed json\n{% endschema %}\n',
        'utf8'
      );
      const invalidShopifyRes = (await capability.execute({ workspaceRoot: shopifyRoot }, context)) as {
        ok: boolean;
        failures: Array<{ rule: string; file?: string }>;
        refusals: Array<{ check: string; failures: number }>;
      };
      assert.strictEqual(invalidShopifyRes.ok, false);
      assert.ok(invalidShopifyRes.failures.some((f) => f.rule === 'SECTION_SCHEMA_JSON_INVALID' && f.file === 'sections/hero.liquid'));
      assert.ok(invalidShopifyRes.refusals.some((r) => r.check === 'theme-schemas'));

      // 3. Haravan workspace with corrupt config/settings_data.json -> HARAVAN_SETTINGS_DATA_INVALID
      fs.mkdirSync(path.join(haravanRoot, 'config'), { recursive: true });
      fs.mkdirSync(path.join(haravanRoot, 'snippets'), { recursive: true });
      fs.writeFileSync(
        path.join(haravanRoot, 'config', 'settings.html'),
        '<fieldset><input type="text" name="title_text" value="Hello" /></fieldset>',
        'utf8'
      );
      fs.writeFileSync(path.join(haravanRoot, 'config', 'settings_data.json'), '{ broken json', 'utf8');
      fs.writeFileSync(path.join(haravanRoot, 'snippets', 'header.liquid'), '{{ settings.title_text }}', 'utf8');

      const corruptHaravanRes = (await capability.execute({ workspaceRoot: haravanRoot }, context)) as {
        ok: boolean;
        failures: Array<{ rule: string; file?: string }>;
      };
      assert.strictEqual(corruptHaravanRes.ok, false);
      assert.ok(
        corruptHaravanRes.failures.some(
          (f) => f.rule === 'HARAVAN_SETTINGS_DATA_INVALID' && f.file === 'config/settings_data.json'
        )
      );

      // 4. Haravan workspace with broken config/settings_schema.json -> SETTINGS_SCHEMA_JSON_INVALID
      fs.writeFileSync(path.join(haravanRoot, 'config', 'settings_data.json'), '{}', 'utf8');
      fs.writeFileSync(path.join(haravanRoot, 'config', 'settings_schema.json'), '[ { broken schema json', 'utf8');
      const brokenSchemaHaravanRes = (await capability.execute({ workspaceRoot: haravanRoot }, context)) as {
        ok: boolean;
        failures: Array<{ rule: string; file?: string }>;
        refusals: Array<{ check: string; failures: number }>;
      };
      assert.strictEqual(brokenSchemaHaravanRes.ok, false);
      assert.ok(
        brokenSchemaHaravanRes.failures.some(
          (f) => f.rule === 'SETTINGS_SCHEMA_JSON_INVALID' && f.file === 'config/settings_schema.json'
        ),
        'broken Haravan config/settings_schema.json must report SETTINGS_SCHEMA_JSON_INVALID'
      );
      assert.ok(brokenSchemaHaravanRes.refusals.some((r) => r.check === 'theme-schemas'));

      // 5. Relative workspaceRoot resolves under the caller's attached workspace root (not process.cwd())
      const subthemeRoot = path.join(shopifyRoot, 'subtheme');
      fs.mkdirSync(path.join(subthemeRoot, 'config'), { recursive: true });
      fs.writeFileSync(path.join(subthemeRoot, 'config', 'settings.html'), '<fieldset></fieldset>', 'utf8');
      fs.writeFileSync(path.join(subthemeRoot, 'config', 'settings_schema.json'), '{ invalid json', 'utf8');
      const relativeRes = (await capability.execute({ workspaceRoot: './subtheme' }, context)) as {
        ok: boolean;
        failures: Array<{ rule: string; file?: string }>;
      };
      assert.strictEqual(relativeRes.ok, false);
      assert.ok(
        relativeRes.failures.some(
          (f) => f.rule === 'SETTINGS_SCHEMA_JSON_INVALID' && f.file === 'config/settings_schema.json'
        ),
        'relative workspaceRoot must resolve against the caller workspace root'
      );

      // 6. Haravan F1GENZ workspace with unread setting + bare image_picker value -> dead-setting & image-picker-bare-value
      const f1genzRoot = path.join(haravanRoot, 'f1genz-subtheme');
      fs.mkdirSync(path.join(f1genzRoot, 'config'), { recursive: true });
      fs.writeFileSync(path.join(f1genzRoot, '.workspace-context.json'), JSON.stringify({ kind: 'theme', platform: 'haravan', branch: 'f1genz' }), 'utf8');
      fs.mkdirSync(path.join(f1genzRoot, 'snippets'), { recursive: true });
      fs.writeFileSync(
        path.join(f1genzRoot, 'config', 'settings_schema.json'),
        JSON.stringify([
          {
            name: '1. Header',
            settings: [
              { type: 'text', id: 'header_title', label: 'Header Title', default: 'Watch' },
              { type: 'text', id: 'unused_slogan', label: 'Unused Slogan', default: 'Never Read' },
              { type: 'image_picker', id: 'header_logo', label: 'Logo', default: 'https://theme.hstatic.net/1000/1000/14/logo.png' },
            ],
          },
        ]),
        'utf8'
      );
      fs.writeFileSync(
        path.join(f1genzRoot, 'config', 'settings_data.json'),
        JSON.stringify({
          current: {
            header_title: 'Watch',
            header_logo: 'logo.png',
          },
        }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(f1genzRoot, 'snippets', 'header.liquid'),
        '<h1 setting-id="header_title" setting-type="text">{{ settings.header_title }}</h1>\n{% if settings.header_logo != blank %}<img setting-id="header_logo" setting-type="image" src="{{ settings.header_logo }}">{% endif %}',
        'utf8'
      );
      const f1genzRes = (await capability.execute({ workspaceRoot: f1genzRoot }, context)) as {
        ok: boolean;
        deadInSchema: number;
        failures: Array<{ rule: string; id?: string; file?: string }>;
      };
      assert.strictEqual(f1genzRes.ok, false);
      assert.strictEqual(f1genzRes.deadInSchema, 1);
      assert.ok(
        f1genzRes.failures.some((f) => f.rule === 'dead-setting' && f.id === 'unused_slogan'),
        'theme.settings_check must surface dead-setting for unread schema settings'
      );
      assert.ok(
        f1genzRes.failures.some((f) => f.rule === 'image-picker-bare-value' && f.id === 'header_logo'),
        'theme.settings_check must surface image-picker-bare-value from checkF1genzSettingsSchema'
      );
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(shopifyRoot, { recursive: true, force: true });
      fs.rmSync(haravanRoot, { recursive: true, force: true });
    }
  });
});
