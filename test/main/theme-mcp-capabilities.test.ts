import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserTarget, CapabilityRequestContext } from '../../src/shared/control-plane-contracts';
import { ArtifactStore } from '../../src/main/tools/artifact-store';

describe('Theme QA MCP Capabilities', () => {
  const defaultOptions = {
    runtime: { mode: 'standalone' as const, lifecycle: 'active' as const },
    projectId: 'project-12345678901234567890',
    workspaceId: 'workspace-12345678901234567890',
    runtimeId: 'binding-12345678901234567890',
  };

  it('registers theme.qa_validate and theme.debug_bundle with aliases', () => {
    const catalogue = new CapabilityCatalogue(defaultOptions);
    const browser = new BrowserControlPort({
      getTabList: () => [{ id: 'tab-1' }],
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html><body><div>Test</div></body></html>',
      captureScreenshot: async () => Buffer.from('png').toString('base64'),
      evalJs: async () => null,
    });
    registerBrowserCapabilities(catalogue, browser);

    const tools = catalogue.list({ grant: 'read' });
    const toolNames = tools.map((t) => t.name);

    assert.ok(toolNames.includes('theme.qa_validate'));
    assert.ok(toolNames.includes('theme.debug_bundle'));
    assert.ok(toolNames.includes('antifan_theme_qa_validate'));
    assert.ok(toolNames.includes('antifan_theme_debug_bundle'));
  });

  it('executes theme.debug_bundle returning platform and liquid error scans', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-mcp-qa-'));
    const catalogue = new CapabilityCatalogue(defaultOptions);
    const artifactStore = new ArtifactStore({ root: path.join(root, 'artifacts') });
    const browser = new BrowserControlPort(
      {
        getTabList: () => [{ id: 'tab-1' }],
        navigate: () => true,
        reload: () => true,
        getDom: async () => '<html><body><div>Shopify theme</div></body></html>',
        captureScreenshot: async () => Buffer.from('png').toString('base64'),
        evalJs: async () => null,
      },
      artifactStore
    );
    registerBrowserCapabilities(catalogue, browser);

    const target: BrowserTarget = {
      projectId: 'project-12345678901234567890',
      workspaceId: 'workspace-12345678901234567890',
      runtimeId: 'binding-12345678901234567890',
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const context: CapabilityRequestContext = {
      lease: {
        token: 'token-1',
        runtimeId: target.runtimeId,
        expiresAt: Date.now() + 60000,
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        protocolVersion: 1,
        hostEpoch: 1,
        ownerPid: process.pid,
        issuedAt: Date.now(),
      },
      leaseToken: 'token-1',
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      browserTarget: target,
      grant: 'read',
    };

    const res = (await catalogue.dispatch('theme.debug_bundle', { tabId: 'tab-1' }, context)) as {
      target: BrowserTarget;
      platform: { platform: string };
      liquid: { hasErrors: boolean };
    };

    assert.ok(res);
    assert.strictEqual(res.target.tabId, 'tab-1');
    assert.ok(res.platform);
    assert.strictEqual(res.liquid.hasErrors, false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
