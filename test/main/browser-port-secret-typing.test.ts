import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget } from '../../src/shared/control-plane-contracts';

const TARGET: BrowserTarget = {
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  runtimeId: 'run-1',
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

const ENV_NAME = 'ANTIFAN_SECRET_A2_TEST_PASSWORD';
const SECRET_VALUE = 'hunter2-never-echo';

function buildHost(typed: Array<Record<string, unknown>>): BrowserHostPort {
  return {
    getTabList: () => [{ id: 'tab-1', url: 'https://login.example/' }],
    hasTab: (id) => id === 'tab-1',
    getTabUrl: () => 'https://login.example/',
    getDocumentGeneration: () => 1,
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'img',
    evalJs: async () => ({}),
    agentType: async (params) => {
      typed.push({ ...params });
      return true;
    },
  };
}

describe('agentType secret / fromEnv (K12)', () => {
  afterEach(() => {
    delete process.env[ENV_NAME];
  });

  it('resolves fromEnv in the main process, forwards secret:true and never the variable name', async () => {
    process.env[ENV_NAME] = SECRET_VALUE;
    const typed: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(typed));
    const res = await port.agentType({ selector: 'input[type=password]', fromEnv: ENV_NAME }, TARGET);
    assert.deepEqual(res, { typed: true });
    assert.equal(typed.length, 1);
    assert.equal(typed[0]?.text, SECRET_VALUE);
    assert.equal(typed[0]?.secret, true);
    assert.equal('fromEnv' in (typed[0] ?? {}), false);
    assert.ok(!JSON.stringify(res).includes(SECRET_VALUE));
  });

  it('plain text stays non-secret unless the caller marks it', async () => {
    const typed: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(typed));
    await port.agentType({ selector: '#q', text: 'hello' }, TARGET);
    await port.agentType({ selector: '#pw', text: 'abc', secret: true }, TARGET);
    assert.equal(typed[0]?.secret, undefined);
    assert.equal(typed[1]?.secret, true);
  });

  it('refuses names outside the ANTIFAN_SECRET_ prefix without reading them', async () => {
    const typed: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(typed));
    await assert.rejects(
      () => port.agentType({ selector: '#pw', fromEnv: 'PATH' }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && err.message.includes('ANTIFAN_SECRET_')
    );
    assert.equal(typed.length, 0);
  });

  it('refuses an unset variable and a call that passes both text and fromEnv', async () => {
    const typed: Array<Record<string, unknown>> = [];
    const port = new BrowserControlPort(buildHost(typed));
    await assert.rejects(
      () => port.agentType({ selector: '#pw', fromEnv: ENV_NAME }, TARGET),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
    process.env[ENV_NAME] = SECRET_VALUE;
    await assert.rejects(
      () => port.agentType({ selector: '#pw', fromEnv: ENV_NAME, text: 'x' }, TARGET),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.equal(err.code, 'INVALID_ARGUMENT');
        assert.ok(!err.message.includes(SECRET_VALUE));
        return true;
      }
    );
    assert.equal(typed.length, 0);
  });

  it('a host failure never carries the secret value in the error text', async () => {
    process.env[ENV_NAME] = SECRET_VALUE;
    const host = buildHost([]);
    host.agentType = async () => {
      throw new CapabilityError('TARGET_OBSCURED', 'covered by overlay');
    };
    const port = new BrowserControlPort(host);
    await assert.rejects(
      () => port.agentType({ selector: '#pw', fromEnv: ENV_NAME }, TARGET),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.ok(!err.message.includes(SECRET_VALUE));
        assert.ok(!JSON.stringify(err.details ?? {}).includes(SECRET_VALUE));
        return true;
      }
    );
  });
});
