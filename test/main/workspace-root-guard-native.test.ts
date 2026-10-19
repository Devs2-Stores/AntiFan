// A QA run filed under a folder that is not the tab's theme proves nothing about the theme being
// edited. The native host's QA entry point refuses such a root before running anything, records the
// reason on the tab's QA state, and forwards the caller's grading options untouched otherwise.
import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { AntiFanTab } from '../../src/shared/contracts';

interface QaInput {
  workspaceRoot: string;
  profile?: string;
  thresholds?: unknown;
  viewports?: unknown;
  multiBreakpoint?: boolean;
}

interface QaHost {
  tabs: Map<string, { state: AntiFanTab }>;
  activeTabId: string;
  capsuleManager: { list(): Array<{ id: string; workspacePath: string }>; getActive(): undefined };
  windowWorkspaceAffiliation: null;
  controlPlane: {
    getLease(): { projectId: string; workspaceId: string; runtimeId: string; hostEpoch: number };
    validateThemeQa(target: unknown, input: QaInput & { signal: AbortSignal }): Promise<unknown>;
  };
  documentGenerations: Map<string, number>;
  tabThemeQaStates: Map<string, unknown>;
  asyncQaQueue: { enqueue(tabId: string, gen: number, work: (signal: AbortSignal) => Promise<void>): void };
  broadcastState: () => void;
  listTerminalSessionIds: () => string[];
  getTerminalAgentAffinity: () => undefined;
  guardQaWorkspaceRoot(candidate: string | undefined, resolvedRoot: string): { root: string; refusal?: { code: string; message: string } };
  getThemeQaState(tabId?: string): { status: string; error?: string };
  runThemeQa(tabId: string, options?: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
}

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function makeTheme(dir: string): string {
  fs.mkdirSync(path.join(dir, 'layout'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'layout', 'theme.liquid'), '<html></html>', 'utf8');
  return dir;
}

function sameDir(left: string, right: string): boolean {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}

function harness(workspacePath: string): { host: QaHost; inputs: QaInput[] } {
  const host = Object.create(NativeTabHost.prototype) as unknown as QaHost;
  host.tabs = new Map([['tab-1', {
    state: { id: 'tab-1', url: 'https://unknown-shop.example/', title: 'Test', isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1, capsuleId: 'capsule-1' } as AntiFanTab,
  }]]);
  host.activeTabId = 'tab-1';
  host.capsuleManager = { list: () => [{ id: 'capsule-1', workspacePath }], getActive: () => undefined };
  host.windowWorkspaceAffiliation = null;
  host.listTerminalSessionIds = () => [];
  host.getTerminalAgentAffinity = () => undefined;
  host.documentGenerations = new Map();
  host.tabThemeQaStates = new Map();
  host.broadcastState = () => {};
  host.asyncQaQueue = { enqueue: (_tabId, _gen, work) => { void work(new AbortController().signal); } };
  const inputs: QaInput[] = [];
  host.controlPlane = {
    getLease: () => ({ projectId: 'p', workspaceId: 'w', runtimeId: 'r', hostEpoch: 1 }),
    validateThemeQa: async (_target, input) => {
      inputs.push(input);
      return { summary: { passed: true, criticalCount: 0 }, findings: {}, artifacts: [] };
    },
  };
  return { host, inputs };
}

describe('native host QA root guard', () => {
  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a tab workspace that holds no theme: no QA runs, the tab state carries the reason', async () => {
    const { host, inputs } = harness(tempDir('af-guard-empty-'));
    const result = await host.runThemeQa('tab-1', {});
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /^WORKSPACE_NOT_THEME:/);
    assert.equal(inputs.length, 0, 'validateThemeQa must not run against a non-theme root');
    const state = host.getThemeQaState('tab-1');
    assert.equal(state.status, 'error');
    assert.match(state.error ?? '', /WORKSPACE_NOT_THEME/);
  });

  it('names the diacritic sibling that holds the theme when the tab is bound to the ASCII-folded stray', async () => {
    const parent = tempDir('af-guard-parent-');
    const stray = path.join(parent, 'Thiet ke');
    fs.mkdirSync(stray, { recursive: true });
    const real = makeTheme(path.join(parent, 'Thiết kế'));
    const { host, inputs } = harness(stray);
    const result = await host.runThemeQa('tab-1', {});
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /WORKSPACE_NOT_THEME/);
    assert.ok((result.error ?? '').includes(real), `the refusal must point at ${real}: ${result.error}`);
    assert.equal(inputs.length, 0);
  });

  it('refuses a caller root outside the tab workspace', async () => {
    const tabRoot = makeTheme(tempDir('af-guard-tab-'));
    const foreign = makeTheme(tempDir('af-guard-foreign-'));
    const { host, inputs } = harness(tabRoot);
    const result = await host.runThemeQa('tab-1', { workspaceRoot: foreign });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /^WORKSPACE_MISMATCH:/);
    assert.equal(inputs.length, 0);
    assert.equal(host.getThemeQaState('tab-1').status, 'error');
  });

  it('runs on a theme root and forwards profile, thresholds, viewports and multiBreakpoint untouched', async () => {
    const root = makeTheme(tempDir('af-guard-theme-'));
    const { host, inputs } = harness(root);
    const thresholds = { minTextPx: 12, minTapHitPx: 32 };
    const viewports = [{ w: 667, h: 375 }, { w: 1366, h: 600 }];
    const result = await host.runThemeQa('tab-1', { workspaceRoot: root, profile: 'build-strict', thresholds, viewports, multiBreakpoint: true });
    assert.equal(result.ok, true);
    assert.equal(inputs.length, 1);
    assert.ok(sameDir(inputs[0]!.workspaceRoot, root));
    assert.equal(inputs[0]!.profile, 'build-strict');
    assert.deepEqual(inputs[0]!.thresholds, thresholds);
    assert.deepEqual(inputs[0]!.viewports, viewports);
    assert.equal(inputs[0]!.multiBreakpoint, true);
  });

  it('leaves the grading options undefined when the caller names none, so the workflow defaults apply', async () => {
    const root = makeTheme(tempDir('af-guard-defaults-'));
    const { host, inputs } = harness(root);
    await host.runThemeQa('tab-1', {});
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.profile, undefined);
    assert.equal(inputs[0]!.thresholds, undefined);
    assert.equal(inputs[0]!.viewports, undefined);
    assert.equal(inputs[0]!.multiBreakpoint, undefined);
  });

  it('guardQaWorkspaceRoot keeps an unresolvable tab provisional instead of refusing it', () => {
    const { host } = harness(tempDir('af-guard-unused-'));
    assert.deepEqual(host.guardQaWorkspaceRoot('anything', ''), { root: '' });
  });

  it('guardQaWorkspaceRoot refuses a plain folder and accepts it only once theme markers exist', () => {
    const dir = tempDir('af-guard-plain-');
    const { host } = harness(dir);
    assert.equal(host.guardQaWorkspaceRoot(undefined, dir).refusal?.code, 'WORKSPACE_NOT_THEME');
    makeTheme(dir);
    const accepted = host.guardQaWorkspaceRoot(undefined, dir);
    assert.equal(accepted.refusal, undefined);
    assert.ok(sameDir(accepted.root, dir));
  });
});
