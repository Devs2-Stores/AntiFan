/**
 * Every fail-closed authority refusal names the next legitimate call in `details.recovery`,
 * and a typed failure keeps its own code and details all the way to the bridge client.
 * The refusal conditions themselves are pinned by their own suites; this file pins only
 * that the refusal is actionable and that the relay does not flatten it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { TabAmbientAuthority } from '../../src/main/browser/tab-ambient-authority';
import { TabAuthorityDirectory } from '../../src/main/browser/tab-authority-directory';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';
import type { ProjectWindowShell } from '../../src/main/browser/project-window-shell';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { CapabilityTransportAdapter, describeRelayedFailure } from '../../src/main/tools/capability-transport';
import {
  CapabilityError,
  issueRuntimeLease,
  makeControlPlaneId,
  type BrowserTarget,
} from '../../src/shared/control-plane-contracts';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function detailsOf(err: unknown): Record<string, unknown> {
  if (err && typeof err === 'object' && 'details' in err) {
    const details = err.details;
    if (details && typeof details === 'object') return Object.fromEntries(Object.entries(details));
  }
  return {};
}

function codeOf(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;
}

function assertActionable(err: unknown, code: string, context: string): true {
  assert.strictEqual(codeOf(err), code, `${context}: wrong code`);
  const recovery = detailsOf(err).recovery;
  assert.strictEqual(typeof recovery, 'string', `${context}: details.recovery must be a string`);
  assert.ok((recovery as string).trim().length > 0, `${context}: details.recovery must not be empty`);
  return true;
}

function refusalOf(act: () => unknown): unknown {
  try {
    act();
  } catch (err) {
    return err;
  }
  return assert.fail('expected a refusal');
}

const STAND_IN_POLICY = {
  effect: 'idempotent-write',
  risk: 'write',
  requiresBrowserTarget: false,
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
} as const;

function registerStandIn(catalogue: CapabilityCatalogue, name: string, execute: () => unknown): void {
  catalogue.register({
    name,
    description: `stand-in for ${name}`,
    risk: 'write',
    requiresBrowserTarget: false,
    policy: STAND_IN_POLICY,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => execute(),
  });
}

// ---------------------------------------------------------------------------
// Tab ambient authority
// ---------------------------------------------------------------------------

describe('tab ambient authority refusals', () => {
  function shell(projectId: string): ProjectWindowShell {
    return {
      owner: { kind: 'project', projectId },
      window: { isDestroyed: () => false },
    } as unknown as ProjectWindowShell;
  }

  function host(ownerKeyValue: string, tabs: readonly string[] = []): NativeTabHost {
    return {
      windowOwnerKey: () => ownerKeyValue,
      canHostTabs: () => ownerKeyValue.startsWith('project:'),
      hasTab: (id: string) => tabs.includes(id),
      getAutomationTabId: () => null,
    } as unknown as NativeTabHost;
  }

  it('TARGET_REQUIRED with several windows carries live project ids and a recovery', () => {
    const directory = new TabAuthorityDirectory();
    directory.register(shell('project-a'), host('project:project-a'));
    directory.register(shell('project-b'), host('project:project-b'));
    const refusal = refusalOf(() => new TabAmbientAuthority({ directory }).ambientHostOrThrow());

    assertActionable(refusal, 'TARGET_REQUIRED', 'several windows');
    assert.deepStrictEqual(detailsOf(refusal).liveProjectIds, ['project-a', 'project-b']);
    assert.strictEqual(detailsOf(refusal).liveHosts, 2);
  });

  it('TARGET_REQUIRED lists project windows only, never the terminal manager', () => {
    const directory = new TabAuthorityDirectory();
    directory.register(shell('project-a'), host('project:project-a'));
    directory.register(shell('project-b'), host('project:project-b'));
    directory.register(shell('manager'), host('unassigned'));
    const refusal = refusalOf(() => new TabAmbientAuthority({ directory }).ambientHostOrThrow('project-unknown'));

    assertActionable(refusal, 'TARGET_REQUIRED', 'mixed windows');
    assert.deepStrictEqual(detailsOf(refusal).liveProjectIds, ['project-a', 'project-b']);
    assert.strictEqual(detailsOf(refusal).liveHosts, 2);
    assert.strictEqual(detailsOf(refusal).projectId, 'project-unknown');
  });

  it('TARGET_REQUIRED with no live window carries a recovery', () => {
    const refusal = refusalOf(() => new TabAmbientAuthority({ directory: new TabAuthorityDirectory() }).ambientHostOrThrow());

    assertActionable(refusal, 'TARGET_REQUIRED', 'no window');
    assert.deepStrictEqual(detailsOf(refusal).liveProjectIds, []);
  });

  it('TARGET_STALE for an explicit dead tab carries a recovery and may be rebound', () => {
    const directory = new TabAuthorityDirectory();
    directory.register(shell('project-a'), host('project:project-a'));
    const refusal = refusalOf(() => new TabAmbientAuthority({ directory }).hostForTabOrBootstrap('tab-dead'));

    assertActionable(refusal, 'TARGET_STALE', 'dead explicit tab');
    assert.strictEqual(detailsOf(refusal).tabId, 'tab-dead');
    assert.strictEqual(detailsOf(refusal).canRebind, true);
  });

  it('POLICY_DENIED for a tab created on another project\'s anchor carries a recovery', () => {
    const directory = new TabAuthorityDirectory();
    directory.register(shell('project-a'), host('project:project-a', ['tab-anchor']));
    const refusal = refusalOf(() => new TabAmbientAuthority({ directory }).hostForNewTab('tab-anchor', 'project-b'));

    assertActionable(refusal, 'POLICY_DENIED', 'foreign anchor');
    assert.strictEqual(detailsOf(refusal).windowProjectId, 'project-a');
  });
});

// ---------------------------------------------------------------------------
// Attachment registry
// ---------------------------------------------------------------------------

describe('attachment registry refusals', () => {
  async function issue(options: { originTerminalSessionId?: string } = {}) {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const registry = new AttachmentRegistry();
    const { launch } = await registry.issueAttachment(makeControlPlaneId('run'), makeControlPlaneId('attempt'), projectId, workspaceId, {
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      grant: 'write',
      tabId: 'tab-1',
      backendId: 'codex',
      browserTarget: { projectId, workspaceId, runtimeId: lease.runtimeId, tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 },
      ...options,
    });
    return { registry, launch, projectId, workspaceId };
  }

  it('REVISION_STALE names the recovery and says resending is safe', async () => {
    const { registry, launch } = await issue();
    await registry.updateAttachmentTab(launch.attachmentId, 'tab-1', 2);
    const record = registry.getAttachment(launch.attachmentId);
    assert.ok(record);

    const refusal = refusalOf(() => registry.validateLiveExecution(record, launch.authorityRevision, 'idem-first'));

    assertActionable(refusal, 'REVISION_STALE', 'rotated revision');
    assert.match(String(detailsOf(refusal).recovery), /resend|resending/i);
  });

  it('REVISION_STALE is refused before the invocation nonce is consumed', async () => {
    const { registry, launch } = await issue();
    const fresh = await registry.updateAttachmentTab(launch.attachmentId, 'tab-1', 2);
    assert.ok(fresh);
    const record = registry.getAttachment(launch.attachmentId);
    assert.ok(record);

    assert.throws(
      () => registry.validateLiveExecution(record, launch.authorityRevision, 'idem-same'),
      (err: unknown) => codeOf(err) === 'REVISION_STALE'
    );
    assert.doesNotThrow(
      () => registry.validateLiveExecution(record, fresh, 'idem-same'),
      'the same invocation id must still be usable once the live revision is presented'
    );
    assert.throws(
      () => registry.validateLiveExecution(record, fresh, 'idem-same'),
      (err: unknown) => codeOf(err) === 'REPLAY_DENIED',
      'a nonce is consumed only by an accepted invocation'
    );
  });

  it('PROJECT_MISMATCH for a terminal that moved to another project carries a recovery', async () => {
    const { registry, launch } = await issue({ originTerminalSessionId: 'term-1' });
    registry.setTerminalProjectScopeResolver(() => ({ projectId: 'project-elsewhere', workspaceId: 'workspace-elsewhere' }));
    const record = registry.getAttachment(launch.attachmentId);
    assert.ok(record);

    const refusal = refusalOf(() => registry.validateLiveExecution(record, launch.authorityRevision));

    assertActionable(refusal, 'PROJECT_MISMATCH', 'moved terminal');
    assert.strictEqual(detailsOf(refusal).resolvedProjectId, 'project-elsewhere');
  });

  it('POLICY_DENIED for a terminal-origin binding on a foreign tab names the tab and a recovery', async () => {
    const { registry, launch, projectId, workspaceId } = await issue({ originTerminalSessionId: 'term-1' });
    registry.setTerminalProjectScopeResolver(() => ({ projectId, workspaceId }));
    registry.setTabAffiliationResolver(() => ({ projectId: 'project-elsewhere', workspaceId: 'workspace-elsewhere' }));
    const record = registry.getAttachment(launch.attachmentId);
    assert.ok(record);

    const refusal = refusalOf(() => registry.validateLiveExecution(record, launch.authorityRevision));

    assertActionable(refusal, 'POLICY_DENIED', 'foreign bound tab');
    assert.strictEqual(detailsOf(refusal).boundTabId, 'tab-1');
    assert.strictEqual(detailsOf(refusal).measuredTabProjectId, 'project-elsewhere');
  });

  it('rebinding onto a foreign project or workspace carries a recovery', async () => {
    const { registry, launch, projectId } = await issue();
    registry.setTabAffiliationResolver(() => ({ projectId: 'project-elsewhere' }));
    await assert.rejects(
      () => registry.updateAttachmentTab(launch.attachmentId, 'tab-foreign', 1),
      (err: unknown) => assertActionable(err, 'PROJECT_MISMATCH', 'foreign project rebind') && detailsOf(err).attachmentProjectId === projectId
    );

    registry.setTabAffiliationResolver(() => ({ projectId, workspaceId: 'workspace-elsewhere' }));
    await assert.rejects(
      () => registry.updateAttachmentTab(launch.attachmentId, 'tab-foreign', 1),
      (err: unknown) => assertActionable(err, 'WORKSPACE_MISMATCH', 'foreign workspace rebind')
    );
  });
});

// ---------------------------------------------------------------------------
// Capability transport
// ---------------------------------------------------------------------------

interface TransportHarnessOptions {
  liveTabs?: string[];
  /** Tabs that measure into the attachment's own project and workspace. */
  sameProjectTabs?: string[];
  failoverTab?: string;
  browserCapabilities?: boolean;
}

function portHost(overrides: Partial<BrowserHostPort>): BrowserHostPort {
  return {
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'data:image/png;base64,mock',
    getTabList: () => [{ id: 'tab-1' }],
    hasTab: (id: string) => id === 'tab-1',
    getDocumentGeneration: () => 1,
    evalJs: async () => ({}),
    ...overrides,
  } as BrowserHostPort;
}

async function transportHarness(options: TransportHarnessOptions = {}) {
  const liveTabs = new Set(options.liveTabs ?? ['tab-1']);
  const sameProjectTabs = new Set(options.sameProjectTabs ?? []);
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
    getDocumentGeneration: () => 1,
    resolveTabAffiliation: (id: string) => (sameProjectTabs.has(id) ? { projectId, workspaceId } : undefined),
    resolveFailoverTabId: () => options.failoverTab,
  });
  if (options.browserCapabilities !== false) {
    registerBrowserCapabilities(
      catalogue,
      new BrowserControlPort(portHost({
        hasTab: (id: string) => liveTabs.has(id),
        getTabList: () => Array.from(liveTabs).map((id) => ({ id })),
        getAutomationTabId: () => 'tab-1',
        resolveTargetTabId: (id: string) => (liveTabs.has(id) ? id : undefined),
        isTabAllowed: (bound: string, candidate: string) => bound === candidate,
      }))
    );
  }
  const registry = new AttachmentRegistry();
  const transport = new CapabilityTransportAdapter(catalogue, registry);
  const { launch } = await registry.issueAttachment(makeControlPlaneId('run'), makeControlPlaneId('attempt'), projectId, workspaceId, {
    lease,
    leaseToken: lease.token,
    hostEpoch: 1,
    grant: 'write',
    tabId: 'tab-1',
    backendId: 'codex',
    browserTarget: { projectId, workspaceId, runtimeId: lease.runtimeId, tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 },
  });
  const intent = (name: string, params: Record<string, unknown> = {}, overrides: { authorityRevision?: string; idempotencyKey?: string } = {}) => ({
    requestId: makeControlPlaneId('request'),
    idempotencyKey: overrides.idempotencyKey ?? makeControlPlaneId('idempotency'),
    attachmentId: launch.attachmentId,
    attachmentSecret: launch.secret,
    authorityRevision: overrides.authorityRevision ?? launch.authorityRevision,
    name,
    params,
  });
  return { catalogue, registry, transport, launch, intent, liveTabs };
}

describe('capability transport refusals', () => {
  it('a foreign retarget is TARGET_MISMATCH naming the bound tab, the rebind tool and the reopen path', async () => {
    const { transport, intent } = await transportHarness({ liveTabs: ['tab-1', 'tab-other'] });
    const res = await transport.dispatchIntent(intent('browser.rebind-target', { tabId: 'tab-other' }));

    assert.strictEqual(res.ok, false);
    assertActionable(res.error, 'TARGET_MISMATCH', 'foreign retarget');
    assert.strictEqual(detailsOf(res.error).recovery, 'anti.browser.rebind_target');
    assert.strictEqual(typeof detailsOf(res.error).alternativeRecovery, 'string');
    assert.strictEqual(detailsOf(res.error).boundTabId, 'tab-1');
  });

  it('an anchor tab outside the attachment authority is TARGET_MISMATCH with the rebind recovery', async () => {
    const { transport, intent } = await transportHarness({ liveTabs: ['tab-1', 'tab-other'] });
    const res = await transport.dispatchIntent(intent('anti.browser.tabs.create', { url: 'https://example.test/', anchorTabId: 'tab-other' }));

    assert.strictEqual(res.ok, false);
    assertActionable(res.error, 'TARGET_MISMATCH', 'foreign anchor');
    assert.strictEqual(detailsOf(res.error).recovery, 'anti.browser.rebind_target');
    assert.strictEqual(detailsOf(res.error).boundTabId, 'tab-1');
    assert.match(res.error?.message ?? '', /another project, session or window/);
  });

  it('a dead anchor tab is TARGET_STALE with a recovery', async () => {
    const { transport, intent } = await transportHarness();
    const res = await transport.dispatchIntent(intent('anti.browser.tabs.create', { url: 'https://example.test/', anchorTabId: 'tab-gone' }));

    assert.strictEqual(res.ok, false);
    assertActionable(res.error, 'TARGET_STALE', 'dead anchor');
  });

  it('a stale authority revision answers REVISION_STALE with a recovery and a retry on the live revision executes once', async () => {
    const { catalogue, registry, transport, launch, intent } = await transportHarness({ browserCapabilities: false });
    let executions = 0;
    registerStandIn(catalogue, 'anti.test.effect', () => {
      executions += 1;
      return { done: true };
    });
    const fresh = await registry.updateAttachmentTab(launch.attachmentId, 'tab-1', 2);
    assert.ok(fresh);

    const stale = intent('anti.test.effect', {}, { idempotencyKey: 'idem-resend-me' });
    const refused = await transport.dispatchIntent(stale);
    assert.strictEqual(refused.ok, false);
    assertActionable(refused.error, 'REVISION_STALE', 'stale revision');
    assert.strictEqual(executions, 0, 'a refused call must not execute');

    const retried = await transport.dispatchIntent({ ...stale, authorityRevision: fresh });
    assert.strictEqual(retried.ok, true, JSON.stringify(retried.error));
    assert.strictEqual(executions, 1);
  });
});

describe('capability transport binding changes', () => {
  it('reports the failover tab when a dead binding heals onto a live one', async () => {
    const { catalogue, transport, intent } = await transportHarness({ liveTabs: ['tab-2'], failoverTab: 'tab-2', browserCapabilities: false });
    registerStandIn(catalogue, 'anti.test.noop', () => ({ ok: true }));

    const res = await transport.dispatchIntent(intent('anti.test.noop'));

    assert.strictEqual(res.ok, true, JSON.stringify(res.error));
    assert.deepStrictEqual(res.bindingChanged, { oldTabId: 'tab-1', newTabId: 'tab-2', reason: 'heal-failover' });
    assert.ok(res.replacementAuthorityRevision, 'the healed binding is rotated onto the attachment');
  });

  it('reports the tab a call opened as the new binding', async () => {
    const { catalogue, transport, intent } = await transportHarness({ liveTabs: ['tab-1', 'tab-3'], browserCapabilities: false });
    registerStandIn(catalogue, 'browser.open-tab', () => ({ tabId: 'tab-3', documentGeneration: 1 }));

    const res = await transport.dispatchIntent(intent('browser.open-tab'));

    assert.strictEqual(res.ok, true, JSON.stringify(res.error));
    assert.deepStrictEqual(res.bindingChanged, { oldTabId: 'tab-1', newTabId: 'tab-3', reason: 'open-tab' });
  });

  it('reports a rebind onto a same-project tab', async () => {
    const { catalogue, transport, intent } = await transportHarness({ liveTabs: ['tab-1', 'tab-2'], sameProjectTabs: ['tab-2'], browserCapabilities: false });
    registerStandIn(catalogue, 'browser.rebind-target', () => ({ tabId: 'tab-2', documentGeneration: 1 }));

    const res = await transport.dispatchIntent(intent('browser.rebind-target', { tabId: 'tab-2' }));

    assert.strictEqual(res.ok, true, JSON.stringify(res.error));
    assert.deepStrictEqual(res.bindingChanged, { oldTabId: 'tab-1', newTabId: 'tab-2', reason: 'rebind' });
  });

  it('does not report a binding change when the call stays on the bound tab', async () => {
    const { catalogue, transport, intent } = await transportHarness({ browserCapabilities: false });
    registerStandIn(catalogue, 'anti.browser.navigate', () => ({ tabId: 'tab-1', documentGeneration: 2 }));

    const res = await transport.dispatchIntent(intent('anti.browser.navigate'));

    assert.strictEqual(res.ok, true, JSON.stringify(res.error));
    assert.ok(res.replacementAuthorityRevision, 'the generation still rotates');
    assert.strictEqual('bindingChanged' in res, false);
  });

  it('a plain read on a live binding reports nothing', async () => {
    const { catalogue, transport, intent } = await transportHarness({ browserCapabilities: false });
    registerStandIn(catalogue, 'anti.test.noop', () => ({ ok: true }));

    const res = await transport.dispatchIntent(intent('anti.test.noop'));

    assert.strictEqual(res.ok, true, JSON.stringify(res.error));
    assert.strictEqual('bindingChanged' in res, false);
  });
});

class HostFailure extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'HostFailure';
  }
}

const TYPED_FAILURES: ReadonlyArray<{ code: string; make: () => unknown; details: Record<string, unknown> }> = [
  {
    code: 'EVAL_EXCEPTION',
    make: () => new CapabilityError('EVAL_EXCEPTION', 'TypeError: x is not a function', { name: 'TypeError', stackFirstLine: 'at <anonymous>:1:1' }),
    details: { name: 'TypeError', stackFirstLine: 'at <anonymous>:1:1' },
  },
  {
    code: 'INVALID_SELECTOR',
    make: () => new HostFailure('INVALID_SELECTOR', "Selector 'a >> nth=0' is not valid CSS", { selector: 'a >> nth=0', recovery: 'Pass a CSS selector or an @eN ref only' }),
    details: { selector: 'a >> nth=0', recovery: 'Pass a CSS selector or an @eN ref only' },
  },
  {
    code: 'TAB_NOT_ATTACHED',
    make: () => ({ code: 'TAB_NOT_ATTACHED', message: "Tab 'tab-1' has no attached WebContents", details: { tabId: 'tab-1', paneId: 'desktop' } }),
    details: { tabId: 'tab-1', paneId: 'desktop' },
  },
  {
    code: 'NO_RENDER_SURFACE',
    make: () => new HostFailure('NO_RENDER_SURFACE', 'The tab reports no laid-out surface (0x0 CSS px)', { tabId: 'tab-1', vw: 0, vh: 0 }),
    details: { tabId: 'tab-1', vw: 0, vh: 0 },
  },
];

describe('typed failures keep their code and details through the transport', () => {
  for (const failure of TYPED_FAILURES) {
    it(`${failure.code} is not flattened to a generic capability error`, async () => {
      const { catalogue, transport, intent } = await transportHarness({ browserCapabilities: false });
      registerStandIn(catalogue, 'anti.test.fail', () => {
        throw failure.make();
      });

      const res = await transport.dispatchIntent(intent('anti.test.fail'));

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error?.code, failure.code);
      assert.deepStrictEqual(res.error?.details, failure.details);
      assert.ok((res.error?.message ?? '').length > 0);
    });
  }

  it('a throw that names no code is the only thing labelled CAPABILITY_ERROR', async () => {
    const { catalogue, transport, intent } = await transportHarness({ browserCapabilities: false });
    registerStandIn(catalogue, 'anti.test.fail', () => {
      throw new Error('plain failure');
    });

    const res = await transport.dispatchIntent(intent('anti.test.fail'));

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error?.code, 'CAPABILITY_ERROR');
    assert.strictEqual(res.error?.message, 'plain failure');
    assert.strictEqual(res.error?.details, undefined);
  });

  it('describeRelayedFailure drops details that are not a plain object', () => {
    assert.deepStrictEqual(describeRelayedFailure({ code: 'NO_RENDER_SURFACE', message: 'm', details: ['not', 'a', 'record'] }), { code: 'NO_RENDER_SURFACE', message: 'm' });
    assert.deepStrictEqual(describeRelayedFailure({ code: 'X', message: 'm', details: 'text' }), { code: 'X', message: 'm' });
    assert.strictEqual(describeRelayedFailure('boom').code, 'CAPABILITY_ERROR');
    assert.strictEqual(describeRelayedFailure(undefined).code, 'CAPABILITY_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Bridge relay
// ---------------------------------------------------------------------------

class BridgeHostDouble extends EventEmitter {
  getTabList() { return []; }
  hasTab() { return false; }
  getActiveTabId() { return null; }
  getActiveTab() { return undefined; }
  isCurrentTarget() { return true; }
  getDocumentGeneration() { return 1; }
}

describe('bridge relay of dispatch results', () => {
  async function bridge() {
    const projectId = 'project-12345678901234567890';
    const workspaceId = 'workspace-12345678901234567890';
    const runtimeId = 'binding-12345678901234567890';
    const lease = {
      runtimeId,
      projectId,
      workspaceId,
      token: 'active-lease-token',
      protocolVersion: 1,
      hostEpoch: 1,
      ownerPid: process.pid,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });
    const registry = new AttachmentRegistry();
    const transport = new CapabilityTransportAdapter(catalogue, registry);
    const server = new BridgeServer(new BridgeHostDouble() as unknown as NativeTabHost, 0, false, transport, undefined, registry);
    const port = await server.start();
    const { launch } = await registry.issueAttachment('run-12345678901234567890', 'attempt-12345678901234567890', projectId, workspaceId, {
      backendId: 'codex',
      grant: 'write',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-antifan-attachment-secret': launch.secret } });
    const opened = Promise.withResolvers<void>();
    ws.on('open', () => opened.resolve());
    ws.on('error', opened.reject);
    await opened.promise;
    let seq = 0;
    const dispatch = (name: string) => {
      const answer = Promise.withResolvers<{ success: boolean; data?: Record<string, unknown>; error?: string }>();
      const id = `relay-${++seq}`;
      const handler = (raw: unknown) => {
        const parsed = JSON.parse(String(raw));
        if (parsed.id === id) {
          ws.off('message', handler);
          answer.resolve(parsed);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({
        id,
        method: 'antifan.capability.dispatch',
        params: {
          name,
          params: {},
          attachmentId: launch.attachmentId,
          attachmentSecret: launch.secret,
          authorityRevision: launch.authorityRevision,
          idempotencyKey: `idem-${id}-${'x'.repeat(12)}`,
        },
      }));
      return answer.promise;
    };
    return { catalogue, transport, server, ws, dispatch };
  }

  it('relays bindingChanged in the dispatch data when a call opened a tab', async () => {
    const { catalogue, server, ws, dispatch } = await bridge();
    try {
      registerStandIn(catalogue, 'browser.open-tab', () => ({ tabId: 'tab-new', documentGeneration: 1 }));

      const resp = await dispatch('browser.open-tab');

      assert.strictEqual(resp.success, true, JSON.stringify(resp));
      assert.deepStrictEqual(resp.data?.bindingChanged, { newTabId: 'tab-new', reason: 'open-tab' });
      assert.strictEqual(typeof resp.data?.replacementAuthorityRevision, 'string');
    } finally {
      ws.close();
      server.dispose();
    }
  });

  it('omits bindingChanged when the binding did not move', async () => {
    const { catalogue, server, ws, dispatch } = await bridge();
    try {
      registerStandIn(catalogue, 'anti.test.noop', () => ({ ok: true }));

      const resp = await dispatch('anti.test.noop');

      assert.strictEqual(resp.success, true, JSON.stringify(resp));
      assert.strictEqual('bindingChanged' in (resp.data ?? {}), false);
    } finally {
      ws.close();
      server.dispose();
    }
  });

  it('relays the code and details of a typed handler failure', async () => {
    const { catalogue, server, ws, dispatch } = await bridge();
    try {
      registerStandIn(catalogue, 'anti.test.fail', () => {
        throw new HostFailure('NO_RENDER_SURFACE', 'The tab reports no laid-out surface', { tabId: 'tab-1', vw: 0, vh: 0 });
      });

      const resp = await dispatch('anti.test.fail');

      assert.strictEqual(resp.success, false);
      assert.strictEqual(resp.data?.code, 'NO_RENDER_SURFACE');
      assert.deepStrictEqual(resp.data?.details, { tabId: 'tab-1', vw: 0, vh: 0 });
      assert.match(resp.error ?? '', /^NO_RENDER_SURFACE:/);
    } finally {
      ws.close();
      server.dispose();
    }
  });

  it('relays the code and details of a typed failure the transport itself throws', async () => {
    const { transport, server, ws, dispatch } = await bridge();
    try {
      Object.assign(transport, {
        dispatchIntent: async () => {
          throw new HostFailure('EVAL_EXCEPTION', 'TypeError: boom', { name: 'TypeError', tabId: 'tab-1' });
        },
      });

      const resp = await dispatch('anti.test.anything');

      assert.strictEqual(resp.success, false);
      assert.strictEqual(resp.data?.code, 'EVAL_EXCEPTION');
      assert.deepStrictEqual(resp.data?.details, { name: 'TypeError', tabId: 'tab-1' });
      assert.match(resp.error ?? '', /^EVAL_EXCEPTION: TypeError: boom/);
    } finally {
      ws.close();
      server.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Browser control port refusals reached through an unreachable bound tab
// ---------------------------------------------------------------------------

describe('browser control port isolation refusals', () => {
  function target(tabId = 'tab-1'): BrowserTarget {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    return { tabId, browserEpoch: 1, documentGeneration: 1, runtimeId: lease.runtimeId, projectId, workspaceId };
  }

  const deadBoundHost = (overrides: Partial<BrowserHostPort> = {}) => portHost({
    hasTab: (id: string) => id === 'tab-user',
    getTabList: () => [{ id: 'tab-user' }],
    getAutomationTabId: () => 'tab-1',
    resolveTargetTabId: (id: string) => (id === 'tab-user' ? 'tab-user' : undefined),
    isTabAllowed: () => false,
    ...overrides,
  });

  it('setAutomationTarget on a dead binding is TARGET_STALE with a recovery', () => {
    const port = new BrowserControlPort(deadBoundHost({ setAutomationTabId: () => undefined }));
    assertActionable(refusalOf(() => port.setAutomationTarget('tab-user')), 'TARGET_STALE', 'set target');
  });

  it('rebindTarget onto a foreign tab is TARGET_MISMATCH with a recovery', () => {
    const port = new BrowserControlPort(deadBoundHost());
    assertActionable(refusalOf(() => port.rebindTarget({ tabId: 'tab-user' }, target())), 'TARGET_MISMATCH', 'rebind');
  });

  it('closeTab of a foreign tab is TARGET_MISMATCH with a recovery', () => {
    const port = new BrowserControlPort(deadBoundHost({ closeTab: () => true }));
    assertActionable(refusalOf(() => port.closeTab('tab-user', { target: target() })), 'TARGET_MISMATCH', 'close');
  });

  it('switchTab to a foreign tab is TARGET_MISMATCH with a recovery', () => {
    const port = new BrowserControlPort(deadBoundHost({ switchTab: () => true }));
    assertActionable(refusalOf(() => port.switchTab('tab-user', { target: target() })), 'TARGET_MISMATCH', 'switch');
  });
});
