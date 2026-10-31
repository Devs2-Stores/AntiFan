// theme.qa_validate takes the per-tab QA run lock for the whole workflow run, hands the workflow the
// request's abort signal, and publishes the finished report to the cockpit row without letting a
// publishing failure change what the call returns.
import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import type { CockpitPort } from '../../src/main/tools/cockpit-port';
import { BrowserTarget, CapabilityError, CapabilityRequestContext } from '../../src/shared/control-plane-contracts';
import type { ThemeQaWorkflow } from '../../src/main/qa/theme-qa-workflow';
import { acquireQaRunLock, resetQaRunLocksForTests } from '../../src/main/qa/qa-run-lock';

const defaultOptions = {
  runtime: { mode: 'standalone' as const, lifecycle: 'active' as const },
  projectId: 'project-12345678901234567890',
  workspaceId: 'workspace-12345678901234567890',
  runtimeId: 'binding-12345678901234567890',
};

const makeBoundBrowser = () =>
  new BrowserControlPort({
    getTabList: () => [{ id: 'tab-1', url: 'https://store.example.com/products/demo' }],
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => Buffer.from('png').toString('base64'),
    evalJs: async () => null,
  });

const makeBoundContext = (signal?: AbortSignal): CapabilityRequestContext => {
  const target: BrowserTarget = { projectId: defaultOptions.projectId, workspaceId: defaultOptions.workspaceId, runtimeId: defaultOptions.runtimeId, tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 };
  return {
    lease: { token: 'token-1', runtimeId: target.runtimeId, expiresAt: Date.now() + 60000, projectId: target.projectId, workspaceId: target.workspaceId, protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now() },
    leaseToken: 'token-1',
    projectId: target.projectId,
    workspaceId: target.workspaceId,
    browserTarget: target,
    grant: 'read',
    ...(signal ? { signal } : {}),
  };
};

const withThemeRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-lock-state-'));
  fs.mkdirSync(path.join(root, 'layout'), { recursive: true });
  fs.writeFileSync(path.join(root, 'layout', 'theme.liquid'), '', 'utf8');
  try {
    await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const passReport = { summary: { passed: true, verdict: 'PASS', criticalCount: 0 } };

interface Deferred {
  promise: Promise<Record<string, unknown>>;
  resolve: (report: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}
const deferred = (): Deferred => Promise.withResolvers<Record<string, unknown>>() as Deferred;

/** Workflow double that records each input and answers from the supplied factory. */
const recordingWorkflow = (answer: () => Promise<Record<string, unknown>>) => {
  const inputs: Array<Record<string, unknown>> = [];
  const workflow = { validate: async (input: Record<string, unknown>) => { inputs.push(input); return answer(); } } as unknown as ThemeQaWorkflow;
  return { workflow, inputs };
};

const isBusy = (error: unknown): boolean => error instanceof CapabilityError && error.code === 'QA_BUSY';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => resetQaRunLocksForTests());

describe('theme.qa_validate run lock', () => {
  it('refuses a second run on the same tab while the first is still measuring', async () => {
    await withThemeRoot(async (root) => {
      const pending = deferred();
      const { workflow, inputs } = recordingWorkflow(() => pending.promise);
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), workflow, () => root);
      const first = catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext());
      await settle();
      await assert.rejects(catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext()), isBusy);
      assert.strictEqual(inputs.length, 1, 'the refused run never reached the workflow');
      pending.resolve(passReport);
      await first;
      const third = catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext());
      await third;
      assert.strictEqual(inputs.length, 2, 'the tab is free once the first run finished');
    });
  });

  it('releases the tab when the workflow throws', async () => {
    await withThemeRoot(async (root) => {
      let calls = 0;
      const { workflow } = recordingWorkflow(async () => {
        calls += 1;
        if (calls === 1) throw new Error('scanner failed');
        return passReport;
      });
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), workflow, () => root);
      await assert.rejects(catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext()), /scanner failed/);
      await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext());
      assert.strictEqual(calls, 2);
    });
  });

  it('hands the request abort signal to the workflow and keeps the tab held after the abort until the run stops', async () => {
    await withThemeRoot(async (root) => {
      const pending = deferred();
      const { workflow, inputs } = recordingWorkflow(() => pending.promise);
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), workflow, () => root);
      const controller = new AbortController();
      const first = catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext(controller.signal));
      await settle();
      assert.strictEqual(inputs[0]?.signal, controller.signal, 'the workflow sees the caller signal');
      controller.abort();
      await assert.rejects(
        catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext()),
        isBusy,
        'an aborted request does not free a tab whose run is still measuring'
      );
      pending.reject(new CapabilityError('TARGET_STALE', 'aborted'));
      await assert.rejects(first);
      assert.doesNotThrow(() => acquireQaRunLock('tab-1').release(), 'the run stopped, so the tab is free');
    });
  });
});

describe('theme.qa_validate cockpit state row', () => {
  const makeCockpit = (publish: (tabId: string, report: unknown) => boolean) => ({ publishThemeQaState: publish }) as unknown as CockpitPort;

  it('publishes the finished report for the QA tab after the receipt step', async () => {
    await withThemeRoot(async (root) => {
      const { workflow } = recordingWorkflow(async () => ({ ...passReport }));
      const published: Array<{ tabId: string; report: Record<string, unknown> }> = [];
      const catalogue = new CapabilityCatalogue(defaultOptions);
      const cockpit = makeCockpit((tabId, report) => {
        published.push({ tabId, report: report as Record<string, unknown> });
        return true;
      });
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), workflow, () => root, undefined, undefined, cockpit);
      const returned = (await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext())) as Record<string, unknown>;
      assert.strictEqual(published.length, 1);
      assert.strictEqual(published[0]!.tabId, 'tab-1');
      assert.deepStrictEqual((published[0]!.report.summary as Record<string, unknown>).verdict, 'PASS');
      assert.ok(published[0]!.report.receipt, 'the row is published after the receipt step, so it carries the receipt result');
      assert.strictEqual((returned.summary as Record<string, unknown>).verdict, 'PASS');
    });
  });

  it('a publishing failure never changes what the call returns', async () => {
    await withThemeRoot(async (root) => {
      const { workflow } = recordingWorkflow(async () => ({ ...passReport }));
      const catalogue = new CapabilityCatalogue(defaultOptions);
      const cockpit = makeCockpit(() => {
        throw new Error('row store unavailable');
      });
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), workflow, () => root, undefined, undefined, cockpit);
      const returned = (await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext())) as Record<string, unknown>;
      assert.strictEqual((returned.summary as Record<string, unknown>).verdict, 'PASS');
    });
  });

  it('publishes nothing when the run is refused before a report exists', async () => {
    await withThemeRoot(async (root) => {
      const { workflow } = recordingWorkflow(async () => ({ ...passReport }));
      const published: unknown[] = [];
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), workflow, () => root, undefined, undefined, makeCockpit((_tabId, report) => {
        published.push(report);
        return true;
      }));
      const held = acquireQaRunLock('tab-1');
      await assert.rejects(catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext()), isBusy);
      held.release();
      assert.deepStrictEqual(published, []);
    });
  });
});
