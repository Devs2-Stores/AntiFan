// Shared fixture for the anti.browser.evaluate tests: a host that counts surface probes and evaluations,
// and the registered capability driven the way the transport drives it.
import * as assert from 'node:assert/strict';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';

export const EVAL_TARGET: BrowserTarget = {
  tabId: 'tab-1',
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  runtimeId: 'runtime-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

export const SURFACE = { vw: 1280, vh: 800, dpr: 1, scrollX: 0, scrollY: 0, docH: 4000, readyState: 'complete', hidden: false };

export interface EvalHostCounters { probes: number; evals: number }

export function makeEvalHost(opts: {
  probe?: () => Promise<unknown>;
  evalJs?: () => Promise<unknown>;
}): { host: BrowserHostPort; counters: EvalHostCounters } {
  const counters: EvalHostCounters = { probes: 0, evals: 0 };
  const host = {
    hasTab: () => true,
    getTabList: () => [{ id: 'tab-1' }],
    getDocumentGeneration: () => 1,
    isCurrentTarget: () => true,
    isTabAllowed: () => true,
    readRenderSurface: async () => {
      counters.probes += 1;
      return opts.probe ? opts.probe() : SURFACE;
    },
    evalJs: async () => {
      counters.evals += 1;
      return opts.evalJs ? opts.evalJs() : 'page title';
    },
  } as unknown as BrowserHostPort;
  return { host, counters };
}

export function evaluateCapability(host: BrowserHostPort): (params: Record<string, unknown>) => Promise<unknown> {
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId: EVAL_TARGET.projectId,
    workspaceId: EVAL_TARGET.workspaceId,
    runtimeId: EVAL_TARGET.runtimeId,
    hostEpoch: 1,
    resolveTabId: (id: string) => (id === 'tab-1' ? id : undefined),
    isTabAllowed: (bound: string, candidate: string) => bound === candidate,
    getDocumentGeneration: () => 1,
  });
  registerBrowserCapabilities(catalogue, new BrowserControlPort(host));
  const capability = catalogue.get('anti.browser.evaluate');
  assert.ok(capability, 'anti.browser.evaluate is registered');
  return (params) => Promise.resolve(capability.execute(params as never, { browserTarget: EVAL_TARGET } as never));
}
