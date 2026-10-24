import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities, resolveFrameSelector } from '../../src/main/tools/browser-capabilities';
import type { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { checkRequiredArgs } from '../../src/main/tools/required-args';
import { CapabilityError, type BrowserTarget, type CapabilityRequestContext, type RuntimeLease } from '../../src/shared/control-plane-contracts';

const projectId = 'proj-surface';
const workspaceId = 'ws-surface';

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

const context: CapabilityRequestContext = {
  lease,
  leaseToken: 'lease-tok',
  projectId,
  workspaceId,
  runId: 'run-1',
  attemptId: 'att-1',
  browserTarget: target,
  grant: 'write',
};

interface Call {
  method: string;
  args: unknown[];
}

/** A port that records the calls the surface forwards; no capability here touches anything else. */
function surface(): { catalogue: CapabilityCatalogue; calls: Call[] } {
  const calls: Call[] = [];
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return { ok: true };
  };
  const stub = {
    agentType: record('agentType'),
    uploadFileInput: record('uploadFileInput'),
    evalInFrame: record('evalInFrame'),
    jsDialog: record('jsDialog'),
  };
  const port = stub as unknown as BrowserControlPort;
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId,
    workspaceId,
    runtimeId: 'run-1',
    hostEpoch: 1,
  });
  registerBrowserCapabilities(catalogue, port);
  return { catalogue, calls };
}

function properties(catalogue: CapabilityCatalogue, name: string): Record<string, { type?: string; enum?: string[] }> {
  const schema = catalogue.get(name)?.inputSchema as { properties?: Record<string, { type?: string; enum?: string[] }> } | undefined;
  assert.ok(schema?.properties, `${name} must declare properties`);
  return schema.properties;
}

describe('typing a secret', () => {
  for (const name of ['anti.agent.cursor.type', 'browser.agent-type', 'antifan_agent_type']) {
    it(`${name} accepts fromEnv and secret and no longer demands text`, () => {
      const { catalogue } = surface();
      const props = properties(catalogue, name);
      assert.equal(props.fromEnv?.type, 'string');
      assert.equal(props.secret?.type, 'boolean');
      const schema = catalogue.get(name)?.inputSchema as Record<string, unknown>;
      assert.equal(checkRequiredArgs(name, schema, { fromEnv: 'ANTIFAN_SECRET_SHOP_PASSWORD', ref: '@e1' }), undefined);
      assert.equal(checkRequiredArgs(name, schema, { text: 'hello', ref: '@e1' }), undefined);
      assert.ok(checkRequiredArgs(name, schema, { ref: '@e1' }), 'a call naming neither text nor fromEnv is refused');
    });
  }

  it('forwards fromEnv and secret to the port without resolving them here', async () => {
    const { catalogue, calls } = surface();
    const capability = catalogue.get('anti.agent.cursor.type');
    assert.ok(capability);
    await capability.execute({ ref: '@e1', fromEnv: 'ANTIFAN_SECRET_SHOP_PASSWORD', secret: true }, context);
    const forwarded = calls[0]!.args[0] as Record<string, unknown>;
    assert.equal(forwarded.fromEnv, 'ANTIFAN_SECRET_SHOP_PASSWORD');
    assert.equal(forwarded.secret, true);
    assert.equal('text' in forwarded, false, 'the capability layer never turns the variable name into text');
  });
});

describe('choosing a child frame', () => {
  it('evaluate_frame advertises every selector and requires none of them by schema', () => {
    const { catalogue } = surface();
    const props = properties(catalogue, 'anti.browser.evaluate_frame');
    assert.equal(props.frameUrl?.type, 'string');
    assert.equal(props.frameId?.type, 'number');
    assert.equal(props.frameIndex?.type, 'number');
    assert.equal(props.frameSelector?.type, 'string');
    const schema = catalogue.get('anti.browser.evaluate_frame')?.inputSchema as { required?: string[] };
    assert.ok(!schema.required?.includes('frameUrl'));
  });

  it('a bare frameUrl stays a string for every existing caller', () => {
    assert.equal(resolveFrameSelector({ frameUrl: 'web.haravan.app' }), 'web.haravan.app');
  });

  it('the other selectors travel as an object', () => {
    assert.deepEqual(resolveFrameSelector({ frameId: 7 }), { frameId: 7 });
    assert.deepEqual(resolveFrameSelector({ frameIndex: 0 }), { index: 0 });
    assert.deepEqual(resolveFrameSelector({ frameSelector: 'iframe#launcher' }), { selector: 'iframe#launcher' });
  });

  it('naming no frame, or several, is refused with the valid fields', () => {
    for (const params of [{}, { frameUrl: 'a', frameIndex: 1 }, { frameId: 1, frameSelector: 'iframe' }]) {
      assert.throws(
        () => resolveFrameSelector(params),
        (error: unknown) => {
          assert.ok(error instanceof CapabilityError);
          assert.equal(error.code, 'INVALID_ARGUMENT');
          assert.deepEqual(error.details?.validFields, ['frameUrl', 'frameId', 'frameIndex', 'frameSelector']);
          return true;
        }
      );
    }
    assert.throws(() => resolveFrameSelector({ frameId: -1 }), (error: unknown) => error instanceof CapabilityError && error.code === 'INVALID_ARGUMENT');
    assert.throws(() => resolveFrameSelector({ frameIndex: 1.5 }), (error: unknown) => error instanceof CapabilityError && error.code === 'INVALID_ARGUMENT');
    assert.throws(() => resolveFrameSelector({ frameSelector: '  ' }), (error: unknown) => error instanceof CapabilityError && error.code === 'INVALID_ARGUMENT');
  });

  it('evaluate_frame hands the port the resolved frame argument', async () => {
    const { catalogue, calls } = surface();
    const capability = catalogue.get('anti.browser.evaluate_frame');
    assert.ok(capability);
    await capability.execute({ expression: '1+1', frameSelector: 'iframe#launcher' }, context);
    await capability.execute({ expression: '1+1', frameUrl: 'launcher' }, context);
    assert.deepEqual(calls[0]!.args[2], { selector: 'iframe#launcher' });
    assert.equal(calls[1]!.args[2], 'launcher');
  });
});

describe('uploading through a file chooser', () => {
  for (const name of ['anti.agent.file_upload', 'browser.upload-file', 'antifan_upload_file']) {
    it(`${name} advertises viaFileChooser and forwards it`, async () => {
      const { catalogue, calls } = surface();
      assert.equal(properties(catalogue, name).viaFileChooser?.type, 'boolean');
      const capability = catalogue.get(name);
      assert.ok(capability);
      await capability.execute({ refOrSelector: '#drop', filePaths: ['E:/x/a.png'], viaFileChooser: true, workspaceRoot: 'E:/x' }, context);
      const forwarded = calls[0]!.args[0] as Record<string, unknown>;
      assert.equal(forwarded.viaFileChooser, true);
      assert.equal(forwarded.refOrSelector, '#drop');
    });
  }
});

describe('reading the JavaScript dialog', () => {
  it('accepts read as the alias of get', async () => {
    const { catalogue, calls } = surface();
    assert.ok(properties(catalogue, 'anti.browser.dialog').action?.enum?.includes('read'));
    const capability = catalogue.get('anti.browser.dialog');
    assert.ok(capability);
    await capability.execute({ action: 'read' }, context);
    await capability.execute({ action: 'accept' }, context);
    assert.equal((calls[0]!.args[0] as { action: string }).action, 'get');
    assert.equal((calls[1]!.args[0] as { action: string }).action, 'accept');
  });
});
