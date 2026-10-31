// Network inspection reads one tab's traffic, so an explicit tabId must pass the same tab
// authorization as the DOM readers: both registrations require a bound browser target and share
// the passive lane of anti.inspect.dom.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import type { BrowserControlPort } from '../../src/main/tools/browser-control-port';

function catalogueWithBrowserCapabilities(): CapabilityCatalogue {
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId: 'proj-net',
    workspaceId: 'ws-net',
    runtimeId: 'rt-net',
  });
  registerBrowserCapabilities(catalogue, {} as unknown as BrowserControlPort);
  return catalogue;
}

describe('network inspection capability policy', () => {
  for (const name of ['browser.inspect-network', 'anti.inspect.network']) {
    it(`${name} requires a browser target and runs in the passive lane like anti.inspect.dom`, () => {
      const catalogue = catalogueWithBrowserCapabilities();
      const capability = catalogue.get(name);
      const dom = catalogue.get('anti.inspect.dom');
      assert.ok(capability, `${name} is registered`);
      assert.ok(dom, 'anti.inspect.dom is registered');
      assert.strictEqual(capability.requiresBrowserTarget, true);
      assert.strictEqual(capability.policy.requiresBrowserTarget, true);
      assert.strictEqual(capability.policy.schedulerLane, dom.policy.schedulerLane);
      assert.strictEqual(capability.policy.risk, 'read');
    });
  }
});
