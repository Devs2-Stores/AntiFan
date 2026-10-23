/**
 * Tab share grants: a user hands one of their own tabs to the agents of its project.
 *
 * The grant widens exactly one decision, the explicit-retarget check. Everything else
 * here pins the ways it must NOT widen: another project, an expired or withdrawn grant,
 * a closed tab, session ownership, and anything an agent can call.
 *
 * Runs under plain node: the host is a prototype double and the lifecycle journal is
 * pinned to a temp directory so nothing touches the live data root.
 */
import { afterEach, after, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-share-grants-'));
process.env.ANTIFAN_RUNTIME_DIR = runtimeDir;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ANTIFAN_') && key !== 'ANTIFAN_RUNTIME_DIR') delete process.env[key];
}

import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { AntiFanMcpServer } from '../../src/main/mcp/mcp-server';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import {
  DEFAULT_TAB_SHARE_TTL_MS,
  MAX_TAB_SHARE_TTL_MS,
  TabShareGrants,
  tabShareGrants,
  type TabShareGrant,
} from '../../src/main/browser/tab-share-grants';
import { CapabilityError, issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';
import type { BrowserTarget, RuntimeLease } from '../../src/shared/control-plane-contracts';

type Affiliation = { projectId?: string; workspaceId?: string } | undefined;

const MINUTE = 60_000;

interface TestClock {
  now: () => number;
  advance: (ms: number) => void;
}

/** A clock the tests move by hand; grants stamp their expiry from it. */
function makeClock(start = Date.now()): TestClock {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

interface Fixture {
  projectId: string;
  lease: RuntimeLease;
  workspaceId: string;
  otherProjectId: string;
  otherWorkspaceId: string;
  scope: { projectId: string; workspaceId: string };
  affiliation: Record<string, Affiliation>;
  /** Every seam the retarget check consulted, in order, for the measuring test. */
  seamCalls: string[];
  grants: TabShareGrants;
  clock: TestClock;
  catalogue: CapabilityCatalogue;
  journal: Array<{ event: string; fields: Record<string, unknown> }>;
}

function makeFixture(): Fixture {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const otherProjectId = makeControlPlaneId('project');
  const otherWorkspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
  const clock = makeClock();
  const journal: Fixture['journal'] = [];
  const grants = new TabShareGrants({ now: clock.now, journal: (event, fields) => { journal.push({ event, fields }); } });
  const seamCalls: string[] = [];
  const affiliation: Record<string, Affiliation> = {
    'tab-agent': undefined,
    // a user tab: no capsule owns it, so it measures nothing
    'tab-user': undefined,
    'tab-same-project': { projectId, workspaceId },
    'tab-project-only': { projectId },
    'tab-other-project': { projectId: otherProjectId, workspaceId: otherWorkspaceId },
    'tab-other-workspace': { projectId, workspaceId: otherWorkspaceId },
  };
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId,
    workspaceId,
    runtimeId: lease.runtimeId,
    hostEpoch: 1,
    allowEval: true,
    // the session owns nothing besides its bound tab
    isTabAllowed: (bound: string, requested: string) => {
      seamCalls.push(`isTabAllowed(${requested})`);
      return bound === requested;
    },
    resolveTabAffiliation: (id: string) => {
      seamCalls.push(`resolveTabAffiliation(${id})`);
      return affiliation[id];
    },
    resolveTabId: (id: string) => (id in affiliation ? id : undefined),
    getDocumentGeneration: () => 1,
    resolveTabShareGrant: (id: string) => grants.get(id),
    noteTabShareGrantUse: (grant: TabShareGrant) => grants.noteUse(grant),
  });
  return {
    projectId, workspaceId, otherProjectId, otherWorkspaceId,
    scope: { projectId, workspaceId },
    affiliation, seamCalls, grants, clock, catalogue, journal, lease,
  };
}

describe('tab share grant registry', () => {
  it('expires a grant at its TTL and treats the boundary as expired', () => {
    const clock = makeClock();
    const grants = new TabShareGrants({ now: clock.now });
    const grant = grants.grant('tab-a', 'project-a', 5 * MINUTE);
    assert.strictEqual(grant.expiresAt - grant.grantedAt, 5 * MINUTE);

    clock.advance(5 * MINUTE - 1);
    assert.ok(grants.get('tab-a'), 'one millisecond before expiry the grant is live');
    clock.advance(1);
    assert.strictEqual(grants.get('tab-a'), undefined, 'at expiry the grant is gone');
    assert.deepStrictEqual(grants.all(), [], 'an expired grant is not listed');
  });

  it('uses the default TTL when none is given and clamps a longer one to the maximum', () => {
    const clock = makeClock();
    const grants = new TabShareGrants({ now: clock.now });
    assert.strictEqual(grants.grant('tab-default', 'project-a').expiresAt - clock.now(), DEFAULT_TAB_SHARE_TTL_MS);
    assert.strictEqual(grants.grant('tab-long', 'project-a', 24 * 60 * MINUTE).expiresAt - clock.now(), MAX_TAB_SHARE_TTL_MS);
    assert.strictEqual(grants.grant('tab-nan', 'project-a', Number.NaN).expiresAt - clock.now(), DEFAULT_TAB_SHARE_TTL_MS);
    assert.strictEqual(grants.grant('tab-neg', 'project-a', -5).expiresAt - clock.now(), DEFAULT_TAB_SHARE_TTL_MS);
  });

  it('revokes a grant and reports whether one was live', () => {
    const grants = new TabShareGrants();
    grants.grant('tab-a', 'project-a');
    assert.strictEqual(grants.revoke('tab-a'), true);
    assert.strictEqual(grants.get('tab-a'), undefined);
    assert.strictEqual(grants.revoke('tab-a'), false, 'a second revoke finds nothing');
  });

  it('drops the grant of a closed tab and leaves other tabs alone', () => {
    const grants = new TabShareGrants();
    grants.grant('tab-a', 'project-a');
    grants.grant('tab-b', 'project-a');
    grants.revokeForClosedTab('tab-a');
    assert.strictEqual(grants.get('tab-a'), undefined);
    assert.ok(grants.get('tab-b'));
  });

  it('replaces an earlier grant for the same tab', () => {
    const clock = makeClock();
    const grants = new TabShareGrants({ now: clock.now });
    grants.grant('tab-a', 'project-a', MINUTE);
    clock.advance(30_000);
    const second = grants.grant('tab-a', 'project-b', 10 * MINUTE);
    assert.strictEqual(grants.get('tab-a')?.projectId, 'project-b');
    assert.strictEqual(grants.get('tab-a')?.expiresAt, second.expiresAt);
    assert.strictEqual(grants.all().length, 1);
  });

  it('refuses a grant without a tab or a project', () => {
    const grants = new TabShareGrants();
    assert.throws(() => grants.grant('', 'project-a'));
    assert.throws(() => grants.grant('tab-a', '  '));
    assert.strictEqual(grants.all().length, 0);
  });

  it('journals grant, use, revoke and expiry, and survives a throwing journal', () => {
    const clock = makeClock();
    const events: string[] = [];
    const grants = new TabShareGrants({ now: clock.now, journal: (event) => { events.push(event); } });
    const grant = grants.grant('tab-a', 'project-a', MINUTE);
    grants.noteUse(grant);
    grants.revoke('tab-a');
    grants.grant('tab-b', 'project-a', MINUTE);
    clock.advance(MINUTE);
    grants.get('tab-b');
    assert.deepStrictEqual(events, [
      'tab-share-grant.granted',
      'tab-share-grant.used',
      'tab-share-grant.revoked',
      'tab-share-grant.granted',
      'tab-share-grant.expired',
    ]);

    const faulty = new TabShareGrants({ journal: () => { throw new Error('journal down'); } });
    assert.ok(faulty.grant('tab-a', 'project-a'), 'a failing journal must not stop the grant');
    assert.strictEqual(faulty.revoke('tab-a'), true);
  });
});

describe('explicit retarget with a share grant', () => {
  it('measures which clause refuses a user tab: the affiliation compare, after both seams answered', () => {
    const fx = makeFixture();

    // Every guard is satisfied (scope complete, resolver present) and the session gate
    // answers false, so the only remaining reason to refuse is the measured comparison:
    // a user tab measures no capsule, and `undefined` is not the attachment's project.
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', fx.scope), false);
    assert.deepStrictEqual(fx.seamCalls, ['isTabAllowed(tab-user)', 'resolveTabAffiliation(tab-user)']);

    // Contrast: an incomplete scope refuses at the guard, before the affiliation seam is read.
    fx.seamCalls.length = 0;
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', { projectId: fx.projectId }), false);
    assert.deepStrictEqual(fx.seamCalls, ['isTabAllowed(tab-user)'], 'the guard clause never reaches the affiliation seam');
  });

  it('refuses a user tab when nobody shared it', () => {
    const fx = makeFixture();
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', fx.scope), false);
  });

  it('accepts an unmeasured user tab that holds a live grant for the session project, and journals the use', () => {
    const fx = makeFixture();
    fx.grants.grant('tab-user', fx.projectId);
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', fx.scope), true);
    assert.deepStrictEqual(
      fx.journal.filter((entry) => entry.event === 'tab-share-grant.used').map((entry) => entry.fields),
      [{ tabId: 'tab-user', projectId: fx.projectId }],
    );
  });

  it('accepts a tab measured into the session project, with the workspace unmeasured, when it holds a grant', () => {
    const fx = makeFixture();
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-project-only', fx.scope), false, 'no grant, no adoption');
    fx.grants.grant('tab-project-only', fx.projectId);
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-project-only', fx.scope), true);
  });

  it('still accepts a same-project tab without any grant and does not journal a grant use', () => {
    const fx = makeFixture();
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-same-project', fx.scope), true);
    assert.deepStrictEqual(fx.journal, []);
  });

  it('refuses a tab measured into another project even with a grant for the session project', () => {
    const fx = makeFixture();
    fx.grants.grant('tab-other-project', fx.projectId);
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-other-project', fx.scope), false);
    fx.grants.grant('tab-other-project', fx.otherProjectId);
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-other-project', fx.scope), false, 'a grant for the tab\'s own project does not reach this session');
  });

  it('refuses a tab measured into another workspace of the same project even with a grant', () => {
    const fx = makeFixture();
    fx.grants.grant('tab-other-workspace', fx.projectId);
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-other-workspace', fx.scope), false);
  });

  it('refuses a user tab whose grant belongs to a different project than the session', () => {
    const fx = makeFixture();
    fx.grants.grant('tab-user', fx.otherProjectId);
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', fx.scope), false);
  });

  it('refuses a grant that has expired', () => {
    const fx = makeFixture();
    fx.grants.grant('tab-user', fx.projectId, 5 * MINUTE);
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', fx.scope), true);
    fx.clock.advance(5 * MINUTE);
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', fx.scope), false);
  });

  it('refuses an expired grant even when the registry hands back a stale entry', () => {
    const fx = makeFixture();
    const stale: TabShareGrant = { tabId: 'tab-user', projectId: fx.projectId, grantedAt: 1, expiresAt: Date.now() - 1 };
    const projectId = fx.projectId;
    const lease = issueRuntimeLease(projectId, fx.workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId: fx.workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      isTabAllowed: (bound: string, requested: string) => bound === requested,
      resolveTabAffiliation: () => undefined,
      resolveTabShareGrant: () => stale,
    });
    assert.strictEqual(catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', fx.scope), false);
  });

  it('refuses after the grant is revoked', () => {
    const fx = makeFixture();
    fx.grants.grant('tab-user', fx.projectId);
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', fx.scope), true);
    fx.grants.revoke('tab-user');
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', fx.scope), false);
  });

  it('refuses after the shared tab closes', () => {
    const fx = makeFixture();
    fx.grants.grant('tab-user', fx.projectId);
    fx.grants.revokeForClosedTab('tab-user');
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', fx.scope), false);
  });

  it('refuses a grant when the host cannot measure affiliation or the scope is incomplete', () => {
    const fx = makeFixture();
    fx.grants.grant('tab-user', fx.projectId);
    const lease = issueRuntimeLease(fx.projectId, fx.workspaceId, 30_000, 1);
    const unmeasured = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      isTabAllowed: (bound: string, requested: string) => bound === requested,
      resolveTabShareGrant: (id: string) => fx.grants.get(id),
    });
    assert.strictEqual(unmeasured.isTabAllowedForRetarget('tab-agent', 'tab-user', fx.scope), false, 'a grant cannot stand in for a measurement that was never taken');
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', { projectId: fx.projectId }), false);
    assert.strictEqual(fx.catalogue.isTabAllowedForRetarget('tab-agent', 'tab-user', {}), false);
  });

  it('never widens the session gate: a granted tab is still foreign to ordinary dispatch', async () => {
    const fx = makeFixture();
    fx.grants.grant('tab-user', fx.projectId);
    assert.strictEqual(fx.catalogue.isTabAllowed('tab-agent', 'tab-user'), false);

    const policyBase = { schedulerLane: 'short-passive' as const, duplicateMode: 'in-process-join' as const, recordedVisibility: 'tenant-scoped' as const, timeoutMs: 15000, retentionPolicy: 'run-durable' as const, ownerCancellationBehavior: 'abort-immediate' as const, subscriberDisconnectBehavior: 'abort-when-unobserved' as const, cancellationAckTimeoutMs: 5000, policyVersion: 1 };
    fx.catalogue.register({
      name: 'probe.write',
      description: 'write probe',
      risk: 'write',
      requiresBrowserTarget: true,
      policy: { ...policyBase, effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, schedulerLane: 'viewport-gate', receiptReadPermission: 'write' },
      inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
      execute: (_params, ctx) => ctx.browserTarget?.tabId,
    });
    const lease = fx.lease;
    const boundTarget: BrowserTarget = { tabId: 'tab-agent', projectId: fx.projectId, workspaceId: fx.workspaceId, runtimeId: lease.runtimeId, browserEpoch: 1, documentGeneration: 1 };
    await assert.rejects(
      () => fx.catalogue.dispatch('probe.write', { tabId: 'tab-user' }, { lease, leaseToken: lease.token, projectId: fx.projectId, workspaceId: fx.workspaceId, grant: 'write', browserTarget: { ...boundTarget } }),
      (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_MISMATCH',
      'a write against a granted tab keeps failing: the grant feeds retarget only',
    );
  });

  it('gives the refused write a recovery that names the bound tab', async () => {
    const fx = makeFixture();
    const policyBase = { schedulerLane: 'short-passive' as const, duplicateMode: 'in-process-join' as const, recordedVisibility: 'tenant-scoped' as const, timeoutMs: 15000, retentionPolicy: 'run-durable' as const, ownerCancellationBehavior: 'abort-immediate' as const, subscriberDisconnectBehavior: 'abort-when-unobserved' as const, cancellationAckTimeoutMs: 5000, policyVersion: 1 };
    fx.catalogue.register({
      name: 'probe.write',
      description: 'write probe',
      risk: 'write',
      requiresBrowserTarget: true,
      policy: { ...policyBase, effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, schedulerLane: 'viewport-gate', receiptReadPermission: 'write' },
      inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
      execute: (_params, ctx) => ctx.browserTarget?.tabId,
    });
    const lease = fx.lease;
    const boundTarget: BrowserTarget = { tabId: 'tab-agent', projectId: fx.projectId, workspaceId: fx.workspaceId, runtimeId: lease.runtimeId, browserEpoch: 1, documentGeneration: 1 };
    await assert.rejects(
      () => fx.catalogue.dispatch('probe.write', { tabId: 'tab-user' }, { lease, leaseToken: lease.token, projectId: fx.projectId, workspaceId: fx.workspaceId, grant: 'write', browserTarget: { ...boundTarget } }),
      (error: unknown) => {
        assert.ok(error instanceof CapabilityError);
        assert.strictEqual(error.code, 'TARGET_MISMATCH');
        const details = error.details;
        assert.ok(details, 'the refusal carries details');
        assert.strictEqual(details.boundTabId, 'tab-agent');
        assert.strictEqual(details.requestedTabId, 'tab-user');
        assert.deepStrictEqual(details.candidateTabIds, ['tab-agent']);
        assert.match(String(details.recovery), /anti\.browser\.rebind_target/);
        assert.match(String(details.recovery), /anti\.browser\.tabs\.create/);
        return true;
      },
    );
  });

  it('gives the unknown-target refusal a recovery next to its rebind tool', async () => {
    const fx = makeFixture();
    const policyBase = { schedulerLane: 'short-passive' as const, duplicateMode: 'in-process-join' as const, recordedVisibility: 'tenant-scoped' as const, timeoutMs: 15000, retentionPolicy: 'run-durable' as const, ownerCancellationBehavior: 'abort-immediate' as const, subscriberDisconnectBehavior: 'abort-when-unobserved' as const, cancellationAckTimeoutMs: 5000, policyVersion: 1 };
    fx.catalogue.register({
      name: 'probe.read',
      description: 'read probe',
      risk: 'read',
      requiresBrowserTarget: true,
      policy: { ...policyBase, effect: 'read', risk: 'read', requiresBrowserTarget: true, receiptReadPermission: 'read' },
      inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
      execute: (_params, ctx) => ctx.browserTarget?.tabId,
    });
    const lease = fx.lease;
    const boundTarget: BrowserTarget = { tabId: 'tab-agent', projectId: fx.projectId, workspaceId: fx.workspaceId, runtimeId: lease.runtimeId, browserEpoch: 1, documentGeneration: 1 };
    await assert.rejects(
      () => fx.catalogue.dispatch('probe.read', { tabId: 'tab-missing' }, { lease, leaseToken: lease.token, projectId: fx.projectId, workspaceId: fx.workspaceId, grant: 'read', browserTarget: { ...boundTarget } }),
      (error: unknown) => {
        assert.ok(error instanceof CapabilityError);
        assert.strictEqual(error.code, 'TARGET_MISMATCH');
        const details = error.details;
        assert.ok(details);
        assert.strictEqual(details.rebindTool, 'anti.browser.rebind_target');
        assert.strictEqual(details.liveTabId, 'tab-agent');
        assert.match(String(details.recovery), /tab-agent/);
        return true;
      },
    );
  });
});

describe('rebind through the transport gate', () => {
  async function bindSession(fx: Fixture) {
    const lease = fx.lease;
    const catalogue = fx.catalogue;
    // The port runs its own rebind check on top of the transport gate, so the double answers
    // the same seams the real host does: session ownership, measured affiliation, share grants.
    const mockHost = {
      getTabList: () => Object.keys(fx.affiliation).map((id) => ({ id, url: `https://${id}.example/`, title: id })),
      getActiveTabId: () => 'tab-agent',
      getManagedTabIds: (bound: string) => new Set([bound]),
      isTabAllowed: (bound: string, requested: string) => bound === requested,
      resolveTargetTabId: (id?: string | null) => (id && id in fx.affiliation ? id : undefined),
      resolveTabAffiliation: (id: string) => fx.affiliation[id],
      getTabShareGrant: (id: string) => fx.grants.get(id),
      getAutomationTabId: () => 'tab-agent',
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => '',
      evalJs: async () => null,
    };
    registerBrowserCapabilities(catalogue, new BrowserControlPort(mockHost));
    const registry = new AttachmentRegistry();
    const server = new AntiFanMcpServer(mockHost as unknown as NativeTabHost, false, new CapabilityTransportAdapter(catalogue, registry));
    const { launch } = await registry.issueAttachment(makeControlPlaneId('run'), makeControlPlaneId('attempt'), fx.projectId, fx.workspaceId, {
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      grant: 'write',
      tabId: 'tab-agent',
      backendId: 'codex',
      browserTarget: { projectId: fx.projectId, workspaceId: fx.workspaceId, runtimeId: lease.runtimeId, tabId: 'tab-agent', browserEpoch: 1, documentGeneration: 1 },
    });
    server.setBoundSession({ attachmentId: launch.attachmentId, attachmentSecret: launch.secret, authorityRevision: launch.authorityRevision });
    return server;
  }

  it('refuses a user tab with a recovery, then rebinds once the user shares it, then refuses again after revocation', async () => {
    const fx = makeFixture();
    const server = await bindSession(fx);

    const refused = await server.callTool('anti.browser.rebind_target', { tabId: 'tab-user' });
    assert.strictEqual(refused.isError, true);
    const refusal = JSON.parse(refused.content[0]?.text || '{}');
    assert.strictEqual(refusal.code, 'TARGET_MISMATCH');
    assert.strictEqual(refusal.details.recovery, 'anti.browser.rebind_target');
    assert.strictEqual(refusal.details.boundTabId, 'tab-agent');

    fx.grants.grant('tab-user', fx.projectId);
    const rebound = await server.callTool('anti.browser.rebind_target', { tabId: 'tab-user' });
    assert.strictEqual(rebound.isError, undefined, 'a shared tab of the session project can be rebound');

    fx.grants.revoke('tab-user');
    const again = await server.callTool('anti.browser.rebind_target', { tabId: 'tab-user' });
    assert.strictEqual(again.isError, true, 'a withdrawn share refuses again');
  });

  it('refuses a cross-project tab through the transport even when it is shared', async () => {
    const fx = makeFixture();
    const server = await bindSession(fx);
    fx.grants.grant('tab-other-project', fx.projectId);
    fx.grants.grant('tab-other-project', fx.otherProjectId);
    const refused = await server.callTool('anti.browser.rebind_target', { tabId: 'tab-other-project' });
    assert.strictEqual(refused.isError, true);
    assert.strictEqual(JSON.parse(refused.content[0]?.text || '{}').code, 'TARGET_MISMATCH');
  });
});

describe('browser port explicit rebind with a share grant', () => {
  function makePort(fx: Fixture, withGrantSeam: boolean): { port: BrowserControlPort; target: BrowserTarget } {
    const lease = fx.lease;
    const host = {
      getTabList: () => Object.keys(fx.affiliation).map((id) => ({ id, url: `https://${id}.example/`, title: id })),
      getActiveTabId: () => 'tab-agent',
      getAutomationTabId: () => 'tab-agent',
      getManagedTabIds: (bound: string) => new Set([bound]),
      isTabAllowed: (bound: string, requested: string) => bound === requested,
      resolveTargetTabId: (id?: string | null) => (id && id in fx.affiliation ? id : undefined),
      resolveTabAffiliation: (id: string) => fx.affiliation[id],
      ...(withGrantSeam ? { getTabShareGrant: (id: string) => fx.grants.get(id) } : {}),
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => '',
      evalJs: async () => null,
    };
    const target: BrowserTarget = { projectId: fx.projectId, workspaceId: fx.workspaceId, runtimeId: lease.runtimeId, tabId: 'tab-agent', browserEpoch: 1, documentGeneration: 1 };
    return { port: new BrowserControlPort(host), target };
  }

  function refusesWith(code: string): (error: unknown) => boolean {
    return (error: unknown) => error instanceof CapabilityError && error.code === code;
  }

  it('rebinds a shared, unmeasured user tab of the session project', () => {
    const fx = makeFixture();
    const { port, target } = makePort(fx, true);
    fx.grants.grant('tab-user', fx.projectId);
    const result = port.rebindTarget({ tabId: 'tab-user' }, target);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.tabId, 'tab-user');
  });

  it('refuses a user tab nobody shared', () => {
    const fx = makeFixture();
    const { port, target } = makePort(fx, true);
    assert.throws(() => port.rebindTarget({ tabId: 'tab-user' }, target), refusesWith('TARGET_MISMATCH'));
  });

  it('refuses a grant that has expired or was withdrawn', () => {
    const fx = makeFixture();
    const { port, target } = makePort(fx, true);
    fx.grants.grant('tab-user', fx.projectId, 5 * MINUTE);
    fx.clock.advance(5 * MINUTE);
    assert.throws(() => port.rebindTarget({ tabId: 'tab-user' }, target), refusesWith('TARGET_MISMATCH'));

    fx.grants.grant('tab-user', fx.projectId);
    fx.grants.revoke('tab-user');
    assert.throws(() => port.rebindTarget({ tabId: 'tab-user' }, target), refusesWith('TARGET_MISMATCH'));
  });

  it('refuses a stale grant entry whose expiry has passed even if the host still returns it', () => {
    const fx = makeFixture();
    const { port, target } = makePort(fx, true);
    const originalGet = fx.grants.get.bind(fx.grants);
    fx.grants.get = (id: string) => (id === 'tab-user' ? { tabId: id, projectId: fx.projectId, grantedAt: 1, expiresAt: Date.now() - 1 } : originalGet(id));
    assert.throws(() => port.rebindTarget({ tabId: 'tab-user' }, target), refusesWith('TARGET_MISMATCH'));
  });

  it('refuses a grant issued for another project', () => {
    const fx = makeFixture();
    const { port, target } = makePort(fx, true);
    fx.grants.grant('tab-user', fx.otherProjectId);
    assert.throws(() => port.rebindTarget({ tabId: 'tab-user' }, target), refusesWith('TARGET_MISMATCH'));
  });

  it('refuses a tab measured into another project or workspace even with a grant for the session project', () => {
    const fx = makeFixture();
    const { port, target } = makePort(fx, true);
    fx.grants.grant('tab-other-project', fx.projectId);
    fx.grants.grant('tab-other-workspace', fx.projectId);
    assert.throws(() => port.rebindTarget({ tabId: 'tab-other-project' }, target), refusesWith('TARGET_MISMATCH'));
    assert.throws(() => port.rebindTarget({ tabId: 'tab-other-workspace' }, target), refusesWith('TARGET_MISMATCH'));
  });

  it('reads the process-wide registry when the host answers no grant seam', () => {
    const fx = makeFixture();
    const { port, target } = makePort(fx, false);
    try {
      assert.throws(() => port.rebindTarget({ tabId: 'tab-user' }, target), refusesWith('TARGET_MISMATCH'));
      tabShareGrants.grant('tab-user', fx.projectId);
      assert.strictEqual(port.rebindTarget({ tabId: 'tab-user' }, target).tabId, 'tab-user');
    } finally {
      tabShareGrants.revoke('tab-user');
    }
  });
});

describe('what an agent can reach', () => {
  it('registers no capability that creates, lists or revokes a share grant', () => {
    const fx = makeFixture();
    const mockHost = {
      getTabList: () => [{ id: 'tab-agent', url: 'https://example.com/' }],
      getActiveTabId: () => 'tab-agent',
      navigate: () => true,
      reload: () => true,
      getDom: async () => '',
      captureScreenshot: async () => '',
      evalJs: async () => null,
    };
    registerBrowserCapabilities(fx.catalogue, new BrowserControlPort(mockHost));
    const names = fx.catalogue.listAll().map((entry) => entry.name);
    assert.ok(names.length > 0, 'the catalogue registered its browser surface');
    assert.deepStrictEqual(names.filter((name) => /share|grant/i.test(name)), []);
  });
});

describe('NativeTabHost share gesture', () => {
  type TabRow = { state: Record<string, unknown>; projectId?: string };
  type CapsuleRow = { id: string; projectId?: string };

  afterEach(() => {
    for (const grant of tabShareGrants.all()) tabShareGrants.revoke(grant.tabId);
  });
  after(() => {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  function makeHost(options: { owner?: Record<string, unknown>; tabs: Record<string, TabRow>; capsules?: CapsuleRow[] }): NativeTabHost {
    const host = Object.create(NativeTabHost.prototype) as unknown as Record<string, unknown>;
    host.shell = { owner: options.owner ?? { kind: 'unassigned' } };
    host.tabs = new Map(Object.entries(options.tabs));
    host.capsuleManager = { list: () => options.capsules ?? [] };
    host.sessionTabPools = new Map();
    host.terminalAgentAffinity = new Map();
    return host as unknown as NativeTabHost;
  }

  const userTab = (projectId?: string, extra: Record<string, unknown> = {}): TabRow => ({
    state: { id: 'x', ephemeral: false, ...extra },
    ...(projectId ? { projectId } : {}),
  });

  it('shares a user tab under the project it was stamped with', () => {
    const host = makeHost({ tabs: { 'tab-user': userTab('project-a') } });
    const result = host.shareTabWithAgent('tab-user');
    assert.ok(result.ok);
    if (result.ok) {
      assert.strictEqual(result.grant.projectId, 'project-a');
      assert.strictEqual(result.grant.tabId, 'tab-user');
    }
    assert.strictEqual(host.getTabShareGrant('tab-user')?.projectId, 'project-a');
    assert.deepStrictEqual(host.getTabShareMenuState('tab-user'), { available: true, shared: true });
  });

  it('shares a tab of a project window that carries no stamp under that window\'s project', () => {
    const host = makeHost({ owner: { kind: 'project', projectId: 'project-win' }, tabs: { 'tab-user': userTab() } });
    const result = host.shareTabWithAgent('tab-user');
    assert.ok(result.ok);
    assert.strictEqual(host.getTabShareGrant('tab-user')?.projectId, 'project-win');
  });

  it('takes the project from the measured capsule and refuses a tab whose stamp disagrees with it', () => {
    const capsules = [{ id: 'cap-1', projectId: 'project-b' }];
    const measuredOnly = makeHost({ tabs: { 'tab-user': userTab(undefined, { capsuleId: 'cap-1' }) }, capsules });
    assert.ok(measuredOnly.shareTabWithAgent('tab-user').ok);
    assert.strictEqual(measuredOnly.getTabShareGrant('tab-user')?.projectId, 'project-b');

    tabShareGrants.revoke('tab-user');
    const conflicting = makeHost({ tabs: { 'tab-user': userTab('project-a', { capsuleId: 'cap-1' }) }, capsules });
    assert.deepStrictEqual(conflicting.shareTabWithAgent('tab-user'), { ok: false, reason: 'PROJECT_AMBIGUOUS' });
    assert.strictEqual(conflicting.getTabShareGrant('tab-user'), undefined);
  });

  it('refuses to share an agent surface, a tab with no project, an unknown tab and a boot project', () => {
    const host = makeHost({
      tabs: {
        'tab-agent': userTab('project-a', { ephemeral: true }),
        'tab-loose': userTab(),
        'tab-boot': userTab('project-00000000-0000-4000-8000-000000000001'),
      },
    });
    assert.deepStrictEqual(host.shareTabWithAgent('tab-agent'), { ok: false, reason: 'AGENT_TAB' });
    assert.deepStrictEqual(host.shareTabWithAgent('tab-loose'), { ok: false, reason: 'NO_PROJECT' });
    assert.deepStrictEqual(host.shareTabWithAgent('tab-boot'), { ok: false, reason: 'NO_PROJECT' });
    assert.deepStrictEqual(host.shareTabWithAgent('tab-missing'), { ok: false, reason: 'NO_TAB' });
    assert.deepStrictEqual(tabShareGrants.all(), []);
    assert.deepStrictEqual(host.getTabShareMenuState('tab-agent'), { available: false, shared: false });
    assert.deepStrictEqual(host.getTabShareMenuState('tab-loose'), { available: false, shared: false });
    assert.deepStrictEqual(host.getTabShareMenuState(undefined), { available: false, shared: false });
  });

  it('offers sharing for a shareable tab and revokes through the same host', () => {
    const host = makeHost({ tabs: { 'tab-user': userTab('project-a') } });
    assert.deepStrictEqual(host.getTabShareMenuState('tab-user'), { available: true, shared: false });
    host.shareTabWithAgent('tab-user');
    assert.strictEqual(host.revokeTabShare('tab-user'), true);
    assert.strictEqual(host.getTabShareGrant('tab-user'), undefined);
    assert.deepStrictEqual(host.getTabShareMenuState('tab-user'), { available: true, shared: false });
    assert.strictEqual(host.revokeTabShare('tab-user'), false);
  });

  it('never makes a shared tab part of the session pool: primary authority is unchanged', () => {
    const host = makeHost({ tabs: { 'tab-user': userTab('project-a'), 'tab-agent': userTab('project-a') } });
    host.shareTabWithAgent('tab-user');
    assert.strictEqual(host.isTabAllowedForPrimary('tab-agent', 'tab-user'), false);
    assert.strictEqual(host.isTabAllowed('tab-agent', 'tab-user'), false);
  });

  it('drops the grant when the tab is closed', () => {
    const host = makeHost({ tabs: { 'tab-user': userTab('project-a') } });
    host.shareTabWithAgent('tab-user');
    const record = { state: { url: 'https://example.com/page', ephemeral: false }, projectId: 'project-a' };
    (host as unknown as { recordTabClosedTelemetry: (id: string, row: unknown, source: string) => void })
      .recordTabClosedTelemetry('tab-user', record, 'test');
    assert.strictEqual(host.getTabShareGrant('tab-user'), undefined);
    assert.strictEqual(tabShareGrants.get('tab-user'), undefined);
  });

  it('expires a host-issued grant on its own clock', () => {
    const host = makeHost({ tabs: { 'tab-user': userTab('project-a') } });
    const result = host.shareTabWithAgent('tab-user', 1);
    assert.ok(result.ok);
    const waitUntil = Date.now() + 5;
    while (Date.now() < waitUntil) { /* the grant's TTL is 1 ms; let it pass */ }
    assert.strictEqual(host.getTabShareGrant('tab-user'), undefined);
  });
});
