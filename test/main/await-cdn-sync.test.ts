// await_cdn_sync hashes a CDN asset against a local file: it must not depend on the tab's DOM
// generation unless it also reloads the tab. A dead bound tab must read as "no longer exists, rebind"
// instead of a generic isolation refusal, and a route sweep that fails must not strand the binding.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { BrowserTarget, issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

const CSS = 'body{color:red}';

function makeTarget(tabId = 'tab-1', documentGeneration = 1): BrowserTarget {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
  return { tabId, browserEpoch: 1, documentGeneration, runtimeId: lease.runtimeId, projectId, workspaceId };
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cdn-sync-gen-'));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'theme.css'), CSS, 'utf8');
  return root;
}

function host(overrides: Partial<BrowserHostPort>): BrowserHostPort {
  return {
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'data:image/png;base64,mock',
    getTabList: () => [{ id: 'tab-1' }],
    hasTab: (id: string) => id === 'tab-1',
    getDocumentGeneration: () => 1,
    evalJs: async () => ({ url: 'https://shop.example.com/assets/theme.css', text: CSS }),
    ...overrides,
  } as BrowserHostPort;
}

function code(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : '';
}

function detailsOf(source: unknown): Record<string, unknown> | undefined {
  if (!source || typeof source !== 'object' || !('details' in source)) return undefined;
  const details = source.details;
  return details && typeof details === 'object' ? Object.fromEntries(Object.entries(details)) : undefined;
}

function recovery(err: unknown): unknown {
  return detailsOf(err)?.recovery;
}

function isDigest(value: unknown): value is { names: string[]; digest: string; count: number } {
  return Boolean(
    value && typeof value === 'object'
    && 'names' in value && Array.isArray(value.names)
    && 'digest' in value && typeof value.digest === 'string'
    && 'count' in value && typeof value.count === 'number'
  );
}

describe('await_cdn_sync and the document generation fence', () => {
  it('hashes the asset on a drifted generation when it does not reload', async () => {
    let reloads = 0;
    const port = new BrowserControlPort(host({ getDocumentGeneration: () => 3, reload: () => { reloads += 1; return true; } }));
    const res = await port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'theme.css', workspaceRoot: workspace(), reloadOnMatch: false, timeoutMs: 200, pollIntervalMs: 50 });
    assert.strictEqual(res.synced, true);
    assert.strictEqual(res.reloaded, false);
    assert.strictEqual(res.cdnSha256, crypto.createHash('sha256').update(CSS).digest('hex'));
    assert.strictEqual(reloads, 0);
  });

  it('keeps the fence when the call reloads the tab', async () => {
    let reloads = 0;
    const port = new BrowserControlPort(host({ getDocumentGeneration: () => 3, reload: () => { reloads += 1; return true; } }));
    await assert.rejects(
      port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'theme.css', workspaceRoot: workspace(), reloadOnMatch: true, timeoutMs: 200, pollIntervalMs: 50 }),
      (err: unknown) => code(err) === 'TARGET_STALE'
    );
    assert.strictEqual(reloads, 0);
  });

  it('keeps the fence by default, because the default reloads', async () => {
    const port = new BrowserControlPort(host({ getDocumentGeneration: () => 3 }));
    await assert.rejects(
      port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'theme.css', workspaceRoot: workspace(), timeoutMs: 200, pollIntervalMs: 50 }),
      (err: unknown) => code(err) === 'TARGET_STALE'
    );
  });
});

describe('a dead bound tab says it no longer exists and names the rebind tool, but only for the bound tab itself', () => {
  const dead = (overrides: Partial<BrowserHostPort> = {}) => host({
    hasTab: (id: string) => id === 'tab-user',
    getTabList: () => [{ id: 'tab-user' }],
    getAutomationTabId: () => 'tab-1',
    resolveTargetTabId: (id: string) => (id === 'tab-user' ? 'tab-user' : undefined),
    isTabAllowed: () => false,
    ...overrides,
  });

  it('awaitCdnSync on the dead bound tab', async () => {
    const port = new BrowserControlPort(dead());
    await assert.rejects(
      port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'theme.css', workspaceRoot: workspace(), reloadOnMatch: false }),
      (err: unknown) => code(err) === 'TARGET_STALE' && /no longer exists/.test(messageOf(err)) && recovery(err) === 'anti.browser.rebind_target'
    );
  });

  it('awaitCdnSync naming the dead bound tab explicitly', async () => {
    const port = new BrowserControlPort(dead());
    await assert.rejects(
      port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'theme.css', workspaceRoot: workspace(), reloadOnMatch: false, tabId: 'tab-1' }),
      (err: unknown) => code(err) === 'TARGET_STALE' && /no longer exists/.test(messageOf(err)) && recovery(err) === 'anti.browser.rebind_target'
    );
  });

  it('a write naming a live foreign tab while the bound tab is dead stays an isolation refusal', async () => {
    const port = new BrowserControlPort(dead());
    await assert.rejects(
      port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'theme.css', workspaceRoot: workspace(), tabId: 'tab-user' }),
      (err: unknown) => code(err) === 'TARGET_MISMATCH'
    );
  });

  it('setAutomationTarget', () => {
    const port = new BrowserControlPort(dead({ setAutomationTabId: () => undefined }));
    assert.throws(
      () => port.setAutomationTarget('tab-user'),
      (err: unknown) => code(err) === 'TARGET_STALE' && recovery(err) === 'anti.browser.rebind_target'
    );
  });

  it('rebindTarget onto a foreign tab under a dead prior binding stays an isolation refusal', () => {
    const port = new BrowserControlPort(dead());
    assert.throws(
      () => port.rebindTarget({ tabId: 'tab-user' }, makeTarget('tab-1', 1)),
      (err: unknown) => code(err) === 'TARGET_MISMATCH'
    );
  });

  it('closeTab of a foreign tab under a dead bound tab stays an isolation refusal', () => {
    const port = new BrowserControlPort(dead({ closeTab: () => true }));
    assert.throws(
      () => port.closeTab('tab-user', { target: makeTarget('tab-1', 1) }),
      (err: unknown) => code(err) === 'TARGET_MISMATCH'
    );
  });

  it('switchTab to a foreign tab under a dead bound tab stays an isolation refusal', () => {
    const port = new BrowserControlPort(dead({ switchTab: () => true }));
    assert.throws(
      () => port.switchTab('tab-user', { target: makeTarget('tab-1', 1) }),
      (err: unknown) => code(err) === 'TARGET_MISMATCH'
    );
  });

  it('a live bound tab that merely refuses a foreign tab stays an isolation refusal', async () => {
    const port = new BrowserControlPort(host({
      hasTab: (id: string) => id === 'tab-1' || id === 'tab-user',
      getTabList: () => [{ id: 'tab-1' }, { id: 'tab-user' }],
      resolveTargetTabId: (id: string) => id,
      isTabAllowed: () => false,
    }));
    await assert.rejects(
      port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'theme.css', workspaceRoot: workspace(), tabId: 'tab-user' }),
      (err: unknown) => code(err) === 'TARGET_MISMATCH'
    );
  });
});

describe('the transport at the capability boundary', () => {
  async function harness(liveGeneration: { value: number }, opts: { liveTabs?: string[]; browserCapabilities?: boolean } = {}) {
    const liveTabs = new Set(opts.liveTabs ?? ['tab-1']);
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      resolveTabId: (id: string) => (liveTabs.has(id) ? id : undefined),
      isTabAllowed: (bound: string, candidate: string) => bound === candidate,
      getDocumentGeneration: () => liveGeneration.value,
    });
    const mockHost = host({
      hasTab: (id: string) => liveTabs.has(id),
      getTabList: () => Array.from(liveTabs).map((id) => ({ id })),
      getAutomationTabId: () => 'tab-1',
      resolveTargetTabId: (id: string) => (liveTabs.has(id) ? id : undefined),
      isTabAllowed: (bound: string, candidate: string) => bound === candidate,
      getDocumentGeneration: () => liveGeneration.value,
    });
    if (opts.browserCapabilities !== false) registerBrowserCapabilities(catalogue, new BrowserControlPort(mockHost));
    const registry = new AttachmentRegistry();
    const transport = new CapabilityTransportAdapter(catalogue, registry);
    const { launch } = await registry.issueAttachment(makeControlPlaneId('run'), makeControlPlaneId('attempt'), projectId, workspaceId, {
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      grant: 'write',
      tabId: 'tab-1',
      backendId: 'codex',
      browserTarget: { projectId, workspaceId, runtimeId: lease.runtimeId, tabId: 'tab-1', browserEpoch: 1, documentGeneration: liveGeneration.value },
    });
    const intent = (name: string, params: Record<string, unknown>, authorityRevision = launch.authorityRevision) => ({
      requestId: makeControlPlaneId('request'),
      idempotencyKey: makeControlPlaneId('idempotency'),
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision,
      name,
      params,
    });
    return { catalogue, registry, transport, launch, intent, liveTabs };
  }

  it('a catalogue miss is typed so the proxy can tell it from a host gap', async () => {
    const { transport, intent } = await harness({ value: 1 });
    const res = await transport.dispatchIntent(intent('anti.theme.not_registered', {}));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error?.code, 'CAPABILITY_NOT_FOUND');
    assert.match(res.error?.message ?? '', /not found in catalogue/);
    assert.deepStrictEqual(res.error?.details, { catalogueMiss: true, capability: 'anti.theme.not_registered' });
  });

  it('answers the registered-name digest the proxy compares on its first catalogue miss', async () => {
    const { catalogue, transport, intent } = await harness({ value: 1 });
    const res = await transport.dispatchIntent(intent('catalogue.digest', {}));
    assert.strictEqual(res.ok, true);
    const data = res.data;
    assert.ok(isDigest(data), 'the digest answer has names, digest and count');
    const expected = catalogue.listAll().map((d) => d.name).sort();
    assert.deepStrictEqual(data.names, expected);
    assert.strictEqual(data.count, expected.length);
    assert.strictEqual(data.digest, crypto.createHash('sha256').update(expected.join('\n')).digest('hex'));
    assert.ok(data.names.includes('anti.theme.await_cdn_sync'));
  });

  it('refuses the digest to a caller that does not hold the attachment secret', async () => {
    const { transport, intent } = await harness({ value: 1 });
    const res = await transport.dispatchIntent({ ...intent('catalogue.digest', {}), attachmentSecret: 'wrong' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error?.code, 'AUTHENTICATION_DENIED');
  });

  it('rebinding from a dead bound tab onto a foreign live tab stays an isolation refusal', async () => {
    const live = { value: 1 };
    const { transport, intent, liveTabs } = await harness(live, { liveTabs: ['tab-1', 'tab-user'] });
    liveTabs.delete('tab-1');
    const res = await transport.dispatchIntent(intent('browser.rebind-target', { tabId: 'tab-user' }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error?.code, 'TARGET_MISMATCH');
  });

  it('rebinding to a tab outside the session scope stays an isolation refusal even when that tab is gone', async () => {
    const { transport, intent } = await harness({ value: 1 });
    const res = await transport.dispatchIntent(intent('browser.rebind-target', { tabId: 'tab-vanished' }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error?.code, 'TARGET_MISMATCH');
  });

  it('a live bound tab refusing a foreign tab stays TARGET_MISMATCH', async () => {
    const { transport, intent } = await harness({ value: 1 }, { liveTabs: ['tab-1', 'tab-other'] });
    const res = await transport.dispatchIntent(intent('browser.rebind-target', { tabId: 'tab-other' }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error?.code, 'TARGET_MISMATCH');
  });

  it('a refused foreign retarget explains the foreign tab and keeps the rebind recovery', async () => {
    const { transport, intent } = await harness({ value: 1 }, { liveTabs: ['tab-1', 'tab-other'] });
    const res = await transport.dispatchIntent(intent('browser.rebind-target', { tabId: 'tab-other' }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error?.code, 'TARGET_MISMATCH');
    assert.match(res.error?.message ?? '', /another project, session or window/);
    assert.strictEqual(recovery(res.error), 'anti.browser.rebind_target');
  });

  it("rebind 'auto' is not read as a foreign tab id: the port decides, so a missing candidate is TARGET_REQUIRED", async () => {
    const { transport, intent } = await harness({ value: 1 });
    const res = await transport.dispatchIntent(intent('browser.rebind-target', { tabId: 'auto' }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error?.code, 'TARGET_REQUIRED');
  });

  it('a route sweep that fails after moving the tab leaves the binding on the settled generation', async () => {
    const live = { value: 24 };
    const { catalogue, registry, transport, launch, intent } = await harness(live, { browserCapabilities: false });
    catalogue.register({
      name: 'anti.qa.batch_matrix',
      description: 'sweep stand-in that moves the document and then fails',
      risk: 'write',
      requiresBrowserTarget: true,
      policy: {
        effect: 'idempotent-write',
        risk: 'write',
        requiresBrowserTarget: true,
        schedulerLane: 'unbounded',
        duplicateMode: 'reject-concurrent',
        recordedVisibility: 'tenant-scoped',
        receiptReadPermission: 'write',
        timeoutMs: 30000,
        retentionPolicy: 'run-durable',
        ownerCancellationBehavior: 'abort-immediate',
        subscriberDisconnectBehavior: 'abort-when-unobserved',
        cancellationAckTimeoutMs: 5000,
        policyVersion: 1,
      },
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        live.value = 41;
        throw new Error('route 9 failed');
      },
    });
    const res = await transport.dispatchIntent(intent('anti.qa.batch_matrix', {}));
    assert.strictEqual(res.ok, false);
    assert.ok(res.replacementAuthorityRevision, 'the failure response carries the rotated authority revision');
    const { authority } = registry.authenticateLineage(launch.attachmentId, launch.secret, { authorityRevision: res.replacementAuthorityRevision });
    assert.strictEqual(authority.browserTarget?.documentGeneration, 41);
    assert.strictEqual(authority.browserTarget?.tabId, 'tab-1');
  });
});

describe('batch_matrix stops sweeping when the invocation is aborted', () => {
  it('does not navigate to a route once the signal fired, and returns the tab to where it started', async () => {
    const navigations: string[] = [];
    let currentUrl = 'https://shop.example.com/start';
    const port = new BrowserControlPort(host({
      getTabUrl: () => currentUrl,
      navigate: (url: string) => { navigations.push(url); currentUrl = url; return true; },
    }));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      port.runBatchMatrix(makeTarget('tab-1', 1), { routes: ['/collections/all', '/pages/lien-he'] }, { signal: controller.signal }),
      (err: unknown) => code(err) === 'ABORTED'
    );
    assert.deepStrictEqual(navigations, []);
    assert.strictEqual(currentUrl, 'https://shop.example.com/start');
  });
});

describe('await_cdn_sync on a Liquid source', () => {
  const COMPILED = 'body{color:red}.promo{display:none}';
  const poll = { reloadOnMatch: false, timeoutMs: 200, pollIntervalMs: 50 };

  function liquidHost(overrides: Partial<BrowserHostPort> = {}, probes: string[] = []): BrowserHostPort {
    return host({
      evalJs: async (expression: string) => {
        probes.push(expression);
        return { url: 'https://shop.example.com/assets/theme.css?v=7', text: COMPILED };
      },
      ...overrides,
    });
  }

  it('refuses a .liquid asset without expectations and points at sync:wait, without touching the page', async () => {
    const probes: string[] = [];
    const port = new BrowserControlPort(liquidHost({}, probes));
    await assert.rejects(
      port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'assets/theme.css.liquid', ...poll }),
      (err: unknown) => code(err) === 'INVALID_ARGUMENT' && /expectContains/.test(messageOf(err)) && /sync:wait/.test(messageOf(err))
    );
    assert.strictEqual(probes.length, 0);
  });

  it('polls the compiled asset (same name without .liquid) and syncs once every expectation holds', async () => {
    const probes: string[] = [];
    const port = new BrowserControlPort(liquidHost({}, probes));
    const res = await port.awaitCdnSync(makeTarget('tab-1', 1), {
      assetPath: 'assets/theme.css.liquid',
      expectContains: ['color:red'],
      expectNotContains: ['.legacy-banner'],
      ...poll,
    });
    assert.strictEqual(res.synced, true);
    assert.strictEqual(res.compiledAsset, 'theme.css');
    assert.strictEqual(res.localSha256, undefined, 'a Liquid source has no comparable local bytes');
    assert.strictEqual(res.cdnSha256, crypto.createHash('sha256').update(COMPILED).digest('hex'));
    assert.ok(probes[0]!.includes(JSON.stringify('theme.css')), 'the probe looks for the compiled file name');
    assert.ok(!probes[0]!.includes('theme.css.liquid'));
  });

  it('needs no workspace: nothing is read from disk for a Liquid source', async () => {
    const port = new BrowserControlPort(liquidHost({ resolveTabWorkspace: () => '' }));
    const res = await port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'assets/theme.css.liquid', expectContains: ['color:red'], ...poll });
    assert.strictEqual(res.synced, true);
  });

  it('reports the missing string while the compiled asset is still the old one', async () => {
    const port = new BrowserControlPort(liquidHost());
    const res = await port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'assets/theme.css.liquid', expectContains: ['.new-header'], ...poll });
    assert.strictEqual(res.synced, false);
    assert.deepStrictEqual(res.unmetExpectations, { missing: ['.new-header'], forbidden: [] });
  });

  it('reports a forbidden string that is still present', async () => {
    const port = new BrowserControlPort(liquidHost());
    const res = await port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'assets/theme.css.liquid', expectNotContains: ['.promo'], ...poll });
    assert.strictEqual(res.synced, false);
    assert.deepStrictEqual(res.unmetExpectations, { missing: [], forbidden: ['.promo'] });
  });

  it('keeps polling until the asset catches up', async () => {
    let calls = 0;
    const port = new BrowserControlPort(liquidHost({
      evalJs: async () => {
        calls += 1;
        return { url: 'https://shop.example.com/assets/theme.css', text: calls < 3 ? COMPILED : `${COMPILED}.new-header{top:0}` };
      },
    }));
    const res = await port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'assets/theme.css.liquid', expectContains: ['.new-header'], reloadOnMatch: false, timeoutMs: 1000, pollIntervalMs: 50 });
    assert.strictEqual(res.synced, true);
    assert.strictEqual(res.attempts, 3);
  });

  it('adds the expectations to the hash check on a plain asset', async () => {
    const port = new BrowserControlPort(liquidHost());
    const res = await port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'theme.css', workspaceRoot: workspace(), expectContains: ['.never-there'], ...poll });
    assert.strictEqual(res.synced, false, 'the bytes match but the expectation does not');
    assert.deepStrictEqual(res.unmetExpectations, { missing: ['.never-there'], forbidden: [] });
  });

  it('keeps the generation fence when it reloads and drops it when it does not', async () => {
    const drifted = liquidHost({ getDocumentGeneration: () => 3 });
    const port = new BrowserControlPort(drifted);
    await assert.rejects(
      port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'assets/theme.css.liquid', expectContains: ['color:red'], timeoutMs: 200, pollIntervalMs: 50 }),
      (err: unknown) => code(err) === 'TARGET_STALE'
    );
    const res = await port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'assets/theme.css.liquid', expectContains: ['color:red'], ...poll });
    assert.strictEqual(res.synced, true);
  });

  it('refuses malformed expectations', async () => {
    const port = new BrowserControlPort(liquidHost());
    for (const expectContains of ['color:red', [''], [1], Array.from({ length: 21 }, (_, i) => `s${i}`)]) {
      await assert.rejects(
        // Deliberately off-contract input: the boundary must refuse it, not coerce it.
        port.awaitCdnSync(makeTarget('tab-1', 1), { assetPath: 'assets/theme.css.liquid', expectContains: expectContains as never, ...poll }),
        (err: unknown) => code(err) === 'INVALID_ARGUMENT'
      );
    }
  });
});
