import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { registerTerminalCapabilities, TERMINAL_WAIT_MAX_TIMEOUT_MS } from '../../src/main/tools/terminal-capabilities';
import {
  BROWSER_EVAL_MAX_TIMEOUT_MS,
  BROWSER_WAIT_MAX_TIMEOUT_MS,
  BrowserControlPort,
  type BrowserHostPort,
} from '../../src/main/tools/browser-control-port';
import type { TerminalManager } from '../../src/main/browser/terminal-manager';
import { issueRuntimeLease } from '../../src/shared/control-plane-contracts';

const projectId = 'project-33333333-3333-4333-8333-333333333333';
const workspaceId = 'workspace-33333333-3333-4333-8333-333333333333';
const lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);

/**
 * The transport aborts a handler at `policy.timeoutMs - policy.cancellationAckTimeoutMs`
 * (`capability-transport.ts`). Every capability whose caller-visible cap is a duration
 * must therefore finish its own timer, plus the margin it reserves to answer, before
 * that execution deadline; otherwise a call asked for the documented maximum is killed
 * by the transport as an abort instead of answering with its own typed timeout.
 */
function buildCatalogue(): CapabilityCatalogue {
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId,
    workspaceId,
    runtimeId: lease.runtimeId,
    hostEpoch: 1,
    getActiveLease: () => lease,
  });
  const host = { getTabList: () => [], getManagedTabIds: () => new Set<string>() } as unknown as BrowserHostPort;
  registerBrowserCapabilities(catalogue, new BrowserControlPort(host));
  registerTerminalCapabilities(catalogue, { getSession: () => undefined } as unknown as TerminalManager);
  return catalogue;
}

function executionDeadlineMs(catalogue: CapabilityCatalogue, name: string): number {
  const policy = catalogue.getPolicy(name);
  assert.ok(policy, `${name} must be registered`);
  const timeoutMs = policy.timeoutMs as number;
  const ack = policy.cancellationAckTimeoutMs as number;
  assert.ok(ack > 0 && ack <= timeoutMs, `${name} declares a usable cancellation ack`);
  return timeoutMs - ack;
}

describe('capability budgets leave room for the documented cap inside the execution deadline', () => {
  const catalogue = buildCatalogue();

  const rows: Array<{ name: string; capMs: number; marginMs: number }> = [
    { name: 'terminal.wait', capMs: TERMINAL_WAIT_MAX_TIMEOUT_MS, marginMs: 2_000 },
    // The queued-reuse wait of a create is 15s; the execution deadline has to outlast it.
    { name: 'terminal.create', capMs: 15_000, marginMs: 0 },
    { name: 'browser.wait', capMs: BROWSER_WAIT_MAX_TIMEOUT_MS, marginMs: 2_000 },
    { name: 'anti.browser.wait', capMs: BROWSER_WAIT_MAX_TIMEOUT_MS, marginMs: 2_000 },
    { name: 'browser.eval', capMs: BROWSER_EVAL_MAX_TIMEOUT_MS, marginMs: 1_000 },
    { name: 'anti.browser.evaluate', capMs: BROWSER_EVAL_MAX_TIMEOUT_MS, marginMs: 1_000 },
  ];

  for (const row of rows) {
    it(`${row.name}: cap ${row.capMs}ms + ${row.marginMs}ms margin fits the execution deadline`, () => {
      const deadline = executionDeadlineMs(catalogue, row.name);
      assert.ok(
        row.capMs + row.marginMs <= deadline,
        `${row.name} cap ${row.capMs}ms + margin ${row.marginMs}ms exceeds the ${deadline}ms execution deadline (policy.timeoutMs - cancellationAckTimeoutMs)`,
      );
    });
  }

  it('keeps every browser budget below the proxy ceiling so the raise cannot outlive the client call', () => {
    for (const name of ['browser.wait', 'anti.browser.wait', 'browser.eval', 'anti.browser.evaluate']) {
      assert.ok((catalogue.getPolicy(name)?.timeoutMs as number) < 240_000, `${name} policy stays under the 240s proxy client timeout`);
    }
  });
});
