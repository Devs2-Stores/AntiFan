import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../../src/main/tools/browser-capabilities';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget, type CapabilityRequestContext, type RuntimeLease } from '../../../src/shared/control-plane-contracts';

const projectId = 'proj-shot';
const workspaceId = 'ws-shot';

const lease: RuntimeLease = {
  token: 'lease-tok',
  expiresAt: Date.now() + 60_000,
  runtimeId: 'run-1',
  projectId,
  workspaceId,
  protocolVersion: 1,
  hostEpoch: 1,
  ownerPid: process.pid,
  issuedAt: Date.now(),
};

const target: BrowserTarget = {
  projectId,
  workspaceId,
  runtimeId: 'run-1',
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

function contextWith(grant: CapabilityRequestContext['grant']): CapabilityRequestContext {
  return { lease, leaseToken: 'lease-tok', projectId, workspaceId, runId: 'run-1', attemptId: 'att-1', browserTarget: target, ...(grant ? { grant } : {}) };
}

describe('screenshot saveTo', () => {
  let root = '';
  let staged = '';
  const captures: string[] = [];

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-shot-root-')));
    staged = path.join(root, '.staged-evidence.png');
    fs.writeFileSync(staged, Buffer.from('PNGBYTES'));
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function surface(): CapabilityCatalogue {
    const capture = (name: string) => async () => {
      captures.push(name);
      return { artifactRef: { path: staged }, tabId: 'tab-1' };
    };
    const port = { screenshot: capture('screenshot'), screenshotFullPage: capture('screenshotFullPage') } as unknown as BrowserControlPort;
    const workspaceRegistry = {
      get: () => ({ id: workspaceId, projectId, rootPath: root, state: 'attached', createdAt: 0, updatedAt: 0 }),
    };
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: 'run-1',
      hostEpoch: 1,
      workspaceRegistry,
    } as unknown as ConstructorParameters<typeof CapabilityCatalogue>[0]);
    registerBrowserCapabilities(catalogue, port);
    return catalogue;
  }

  const names = ['browser.screenshot', 'antifan_screenshot', 'anti.screenshot.viewport', 'anti.screenshot.full_page'];

  for (const name of names) {
    it(`${name} copies the capture inside the workspace root under a write grant and echoes savedTo`, async () => {
      const capability = surface().get(name);
      assert.ok(capability, `${name} is registered`);
      const relative = path.join('shots', `${name.replace(/[^a-z]/gi, '-')}.png`);
      const result = await capability.execute({ saveTo: relative }, contextWith('write')) as { savedTo?: string; artifactRef?: { path?: string } };
      assert.ok(result.savedTo, 'savedTo is echoed');
      const saved = path.resolve(result.savedTo);
      assert.ok(saved.startsWith(root + path.sep), `${saved} stays under ${root}`);
      assert.equal(path.basename(saved), path.basename(relative));
      assert.equal(fs.readFileSync(saved, 'utf8'), 'PNGBYTES');
      assert.equal(result.artifactRef?.path, staged, 'the receipt still names the staged artifact');
    });

    it(`${name} refuses a saveTo outside the workspace root before capturing`, async () => {
      const capability = surface().get(name);
      assert.ok(capability);
      const before = captures.length;
      const outside = path.join(path.dirname(root), 'antifan-shot-escape.png');
      await assert.rejects(
        async () => capability.execute({ saveTo: outside }, contextWith('write')),
        (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && /outside workspace root/.test(err.message)
      );
      assert.equal(captures.length, before, 'a bad destination never costs a capture');
      assert.equal(fs.existsSync(outside), false);
    });

    for (const grant of [undefined, 'execute'] as const) {
      it(`${name} refuses saveTo with POLICY_DENIED under grant ${grant ?? 'none'} and writes nothing`, async () => {
        const capability = surface().get(name);
        assert.ok(capability);
        const before = captures.length;
        const relative = path.join('denied', 'x.png');
        await assert.rejects(
          async () => capability.execute({ saveTo: relative }, contextWith(grant)),
          (err: unknown) => err instanceof CapabilityError && err.code === 'POLICY_DENIED' && err.message.includes('saveTo') && err.details?.saveTo === relative
        );
        assert.equal(captures.length, before, 'the capture never ran');
        assert.equal(fs.existsSync(path.join(root, relative)), false);
      });
    }

    it(`${name} without saveTo is unchanged and needs no write grant`, async () => {
      const capability = surface().get(name);
      assert.ok(capability);
      const result = await capability.execute({}, contextWith(undefined)) as { savedTo?: string; artifactRef?: { path?: string } };
      assert.equal(result.savedTo, undefined);
      assert.equal(result.artifactRef?.path, staged);
    });
  }
});

describe('set-viewport hideScrollbar', () => {
  function hostRecording(calls: Array<Record<string, unknown>>): BrowserHostPort {
    return {
      getTabList: () => [{ id: 'tab-1' }],
      hasTab: (id: string) => id === 'tab-1',
      getDocumentGeneration: () => 1,
      setViewportSize: async (options: Record<string, unknown>) => {
        calls.push(options);
        return true;
      },
      evalJs: async () => ({ innerWidth: 800, innerHeight: 600 }),
    } as unknown as BrowserHostPort;
  }

  for (const hideScrollbar of [true, false]) {
    it(`the port forwards hideScrollbar:${hideScrollbar} to the host and echoes scrollbarsHidden`, async () => {
      const calls: Array<Record<string, unknown>> = [];
      const port = new BrowserControlPort(hostRecording(calls));
      const result = await port.setViewport({ width: 800, height: 600, hideScrollbar }, target);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.hideScrollbar, hideScrollbar);
      assert.equal(result.scrollbarsHidden, hideScrollbar);
    });
  }

  it('leaves hideScrollbar absent for the host and the result when the caller did not ask', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(hostRecording(calls));
    const result = await port.setViewport({ width: 800, height: 600 }, target);
    assert.equal('hideScrollbar' in calls[0]!, false);
    assert.equal('scrollbarsHidden' in result, false);
  });

  for (const bad of ['true', 1, null, {}]) {
    it(`rejects non-boolean hideScrollbar ${JSON.stringify(bad)} before touching the host`, async () => {
      const calls: Array<Record<string, unknown>> = [];
      const port = new BrowserControlPort(hostRecording(calls));
      await assert.rejects(
        () => port.setViewport({ width: 800, height: 600, hideScrollbar: bad as unknown as boolean }, target),
        (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.message === 'hideScrollbar must be a boolean'
      );
      assert.equal(calls.length, 0);
    });
  }

  for (const name of ['browser.set-viewport', 'anti.browser.set_viewport', 'antifan_set_viewport']) {
    it(`${name} forwards hideScrollbar to the port`, async () => {
      const received: Array<Record<string, unknown>> = [];
      const port = { setViewport: async (params: Record<string, unknown>) => { received.push(params); return { success: true }; } } as unknown as BrowserControlPort;
      const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: 'run-1', hostEpoch: 1 });
      registerBrowserCapabilities(catalogue, port);
      const capability = catalogue.get(name);
      assert.ok(capability, `${name} is registered`);
      assert.equal((capability.inputSchema as { properties: Record<string, unknown> }).properties.hideScrollbar !== undefined, true);
      await capability.execute({ width: 800, height: 600, hideScrollbar: true }, contextWith('write'));
      assert.equal(received[0]!.hideScrollbar, true);
    });
  }
});
