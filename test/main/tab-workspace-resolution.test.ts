import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { AntiFanTab } from '../../src/shared/contracts';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { CockpitPort } from '../../src/main/tools/cockpit-port';
import { resolveWorkspaceFromUrl } from '../../src/main/browser/workspace-resolver';

/** Expected workspace for a storefront URL, independent of where the repo is checked out (worktrees). */
function classifiedWorkspace(url: string): string {
  const ws = resolveWorkspaceFromUrl(url);
  assert.ok(ws, `fixture URL ${url} must classify to a workspace`);
  return path.normalize(ws).toLowerCase();
}

/**
 * Regression coverage for the tab-scoped workspace resolver.
 *
 * Defect: `cockpit.resolveTabWorkspaceRoot` dropped the tabId and every
 * tab-facing surface funnelled through `resolveTargetWorkspace`, whose Step 2
 * returned the process-global ACTIVE capsule. A tab stamped with the S2 Spa
 * capsule therefore resolved `E:\Work\apps\Pancake` whenever Pancake was the
 * active capsule — checklist state and QA receipts landed in a foreign root.
 *
 * The resolver is fail-closed by contract: an unresolvable tab returns '' and
 * must never fall back to the active capsule or a global terminal CWD.
 */

interface TabShell {
  state: AntiFanTab;
}

interface CapsuleRecord {
  id: string;
  workspacePath: string;
  name?: string;
}

interface ResolverHost {
  tabs: Map<string, TabShell>;
  activeTabId: string;
  capsuleManager: { list(): CapsuleRecord[]; getActive(): CapsuleRecord | undefined };
  windowWorkspaceAffiliation: { workspacePath: string } | null;
  controlPlane?: { getWorkspaceRoot(): string };
  getTabTerminalSession(tabId?: string): string | undefined;
  listTerminalSessionIds(): string[];
  getTerminalAgentAffinity(sessionId?: string | number, generation?: number | string): { tabId?: string; managedTabIds?: string[]; status: string } | undefined;
  resolveTabWorkspace(tabId?: string, tabUrl?: string): string;
  resolveTargetWorkspace(targetSessionId?: string, tabUrl?: string): string;
  resolveWindowWorkspaceRoot(): string;
}

interface TerminalManagerOverride {
  listSessions: () => Array<{ id: string; name: string; cwd: string; state?: string }>;
  getActiveSessionId: () => string;
  getSession: (id: string) => { id: string; name: string; cwd: string } | undefined;
}

function baseTab(id: string, url: string): TabShell {
  return {
    state: { id, url, title: 'Test', isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1 } as AntiFanTab,
  };
}

function createResolverHost(tabIds: string[]): ResolverHost {
  const host = Object.create(NativeTabHost.prototype) as unknown as ResolverHost;
  host.tabs = new Map(tabIds.map((id) => [id, baseTab(id, 'https://unknown-shop.example/')]));
  host.activeTabId = tabIds[0] ?? '';
  // Real seams start empty: tests seat the tier they exercise.
  host.capsuleManager = { list: () => [], getActive: () => undefined };
  host.windowWorkspaceAffiliation = null;
  // The real listTerminalSessionIds/getTerminalAgentAffinity walk TerminalManager
  // internals and private affinity maps; tests pin terminal bindings via
  // tab.state.terminalSessionId and keep affinity scans inert.
  host.listTerminalSessionIds = () => [];
  host.getTerminalAgentAffinity = () => undefined;
  return host;
}

describe('resolveTabWorkspace precedence', () => {
  const tm = TerminalManager.getInstance() as unknown as TerminalManagerOverride;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-tab-ws-'));
  const s2SpaDir = path.join(tempRoot, 'S2 Spa');
  const pancakeDir = path.join(tempRoot, 'Pancake');
  const termDir = path.join(tempRoot, 'term-cwd');
  const windowDir = path.join(tempRoot, 'window-ws');
  let liveSessions: Array<{ id: string; name: string; cwd: string; state?: string }> = [];

  before(() => {
    for (const dir of [s2SpaDir, pancakeDir, termDir, windowDir]) fs.mkdirSync(dir, { recursive: true });
    liveSessions = [
      { id: 'term-a', name: 'Terminal A', cwd: termDir, state: 'running' },
      { id: 'term-b', name: 'Terminal B', cwd: pancakeDir, state: 'running' },
    ];
    tm.listSessions = () => liveSessions;
    tm.getActiveSessionId = () => 'term-b';
    tm.getSession = (id: string) => liveSessions.find((s) => s.id === id);
  });
  beforeEach(() => {
    tm.listSessions = () => liveSessions;
    tm.getActiveSessionId = () => 'term-b';
    tm.getSession = (id: string) => liveSessions.find((s) => s.id === id);
  });

  after(() => {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  });

  it('a tab stamped with the S2 Spa capsule resolves S2 Spa even while Pancake is the active capsule (the reported repro)', () => {
    const host = createResolverHost(['tab-s2']);
    host.tabs.get('tab-s2')!.state.capsuleId = 'capsule-s2spa';
    host.capsuleManager = {
      list: () => [
        { id: 'capsule-s2spa', workspacePath: s2SpaDir },
        { id: 'capsule-pancake', workspacePath: pancakeDir },
      ],
      getActive: () => ({ id: 'capsule-pancake', workspacePath: pancakeDir }),
    };

    const resolved = host.resolveTabWorkspace('tab-s2');
    assert.strictEqual(resolved, path.normalize(s2SpaDir), 'stamped capsule wins over the process-global active capsule');
  });

  it('a stamped capsule also wins for the tab that is merely active by default arg', () => {
    const host = createResolverHost(['tab-s2']);
    host.tabs.get('tab-s2')!.state.capsuleId = 'capsule-s2spa';
    host.capsuleManager = {
      list: () => [{ id: 'capsule-s2spa', workspacePath: s2SpaDir }],
      getActive: () => ({ id: 'capsule-pancake', workspacePath: pancakeDir }),
    };
    assert.strictEqual(host.resolveTabWorkspace(), path.normalize(s2SpaDir));
  });

  it('a bound terminal session CWD wins when no capsule is stamped', () => {
    const host = createResolverHost(['tab-1']);
    host.tabs.get('tab-1')!.state.terminalSessionId = 'term-a';
    host.capsuleManager = { list: () => [], getActive: () => ({ id: 'capsule-pancake', workspacePath: pancakeDir }) };
    host.windowWorkspaceAffiliation = { workspacePath: windowDir };

    assert.strictEqual(host.resolveTabWorkspace('tab-1'), path.normalize(termDir));
  });

  it('an auto terminal binding is skipped (dynamic focus tracking is not a pinned binding)', () => {
    const host = createResolverHost(['tab-1']);
    host.tabs.get('tab-1')!.state.terminalSessionId = 'auto';
    host.windowWorkspaceAffiliation = { workspacePath: windowDir };

    assert.strictEqual(host.resolveTabWorkspace('tab-1'), path.normalize(windowDir), 'auto falls through to window affiliation');
  });

  it('the owning window affiliation wins when no capsule or terminal binding exists', () => {
    const host = createResolverHost(['tab-1']);
    host.windowWorkspaceAffiliation = { workspacePath: windowDir };

    assert.strictEqual(host.resolveTabWorkspace('tab-1'), path.normalize(windowDir));
  });

  it('a storefront URL is classified when no capsule, terminal, or window tier resolves', () => {
    const host = createResolverHost(['tab-1']);
    host.tabs.get('tab-1')!.state.url = 'https://antifan.myharavan.com/';

    const resolved = host.resolveTabWorkspace('tab-1');
    // DEFAULT_WORKSPACE_ROOTS literals carry a lowercase drive letter; the
    // Windows filesystem is case-insensitive, so identity is by content.
    assert.strictEqual(resolved.toLowerCase(), classifiedWorkspace('https://antifan.myharavan.com/'), 'antifan.myharavan.com classifies to its mapped workspace');
  });

  it('a dead capsule path falls through to the next tier instead of claiming it', () => {
    const host = createResolverHost(['tab-1']);
    host.tabs.get('tab-1')!.state.capsuleId = 'capsule-dead';
    host.capsuleManager = {
      list: () => [{ id: 'capsule-dead', workspacePath: path.join(tempRoot, 'deleted-dir') }],
      getActive: () => undefined,
    };
    host.windowWorkspaceAffiliation = { workspacePath: windowDir };

    assert.strictEqual(host.resolveTabWorkspace('tab-1'), path.normalize(windowDir));
  });

  it('fails closed to an empty string for an unresolvable tab — never the active capsule, never a global CWD', () => {
    const host = createResolverHost(['tab-x']);
    host.tabs.get('tab-x')!.state.url = 'https://unmapped-domain.invalid/';
    host.capsuleManager = { list: () => [{ id: 'capsule-pancake', workspacePath: pancakeDir }], getActive: () => ({ id: 'capsule-pancake', workspacePath: pancakeDir }) };
    host.controlPlane = { getWorkspaceRoot: () => pancakeDir };

    assert.strictEqual(host.resolveTabWorkspace('tab-x'), '');
  });

  it('ignores a stamped capsuleId that no live capsule owns', () => {
    const host = createResolverHost(['tab-x']);
    host.tabs.get('tab-x')!.state.capsuleId = 'capsule-ghost';
    host.tabs.get('tab-x')!.state.url = 'https://unmapped-domain.invalid/';
    host.capsuleManager = { list: () => [], getActive: () => ({ id: 'capsule-pancake', workspacePath: pancakeDir }) };

    assert.strictEqual(host.resolveTabWorkspace('tab-x'), '');
  });

  it('resolveTargetWorkspace: a classifiable tab URL outranks the ambient active capsule and active terminal', () => {
    const host = createResolverHost(['tab-1']);
    host.capsuleManager = { list: () => [], getActive: () => ({ id: 'capsule-pancake', workspacePath: pancakeDir }) };

    const resolved = host.resolveTargetWorkspace(undefined, 'https://antifan.myharavan.com/');
    assert.strictEqual(resolved.toLowerCase(), classifiedWorkspace('https://antifan.myharavan.com/'), 'URL classification beats the active Pancake capsule');
  });

  it('resolveTargetWorkspace: an unclassifiable tab URL still falls back to the active capsule', () => {
    const host = createResolverHost(['tab-1']);
    host.capsuleManager = { list: () => [], getActive: () => ({ id: 'capsule-pancake', workspacePath: pancakeDir }) };

    assert.strictEqual(host.resolveTargetWorkspace(undefined, 'https://unmapped-domain.invalid/'), path.normalize(pancakeDir));
  });

  it('resolveTargetWorkspace: an explicit terminal session cwd still wins over the tab URL', () => {
    const host = createResolverHost(['tab-1']);

    assert.strictEqual(host.resolveTargetWorkspace('term-a', 'https://antifan.myharavan.com/'), path.normalize(termDir));
  });
});

describe('runThemeQa workspace root', () => {
  it('passes an empty workspaceRoot to validateThemeQa for an unresolvable tab — never the control-plane root, never the caller candidate', async () => {
    // Regression: runThemeQa previously fell back to
    // controlPlane.getWorkspaceRoot() when the tab resolved nothing, so QA
    // receipts could be steered into a foreign project root.
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'af-qa-leak-root-'));
    try {
      const host = createResolverHost(['tab-x']) as ResolverHost & {
        controlPlane: {
          getWorkspaceRoot(): string;
          getLease(): { projectId: string; workspaceId: string; runtimeId: string; hostEpoch: number };
          validateThemeQa(target: unknown, input: { workspaceRoot: string; signal: AbortSignal }): Promise<unknown>;
        };
        documentGenerations: Map<string, number>;
        asyncQaQueue: { enqueue(tabId: string, gen: number, work: (signal: AbortSignal) => Promise<void>): void };
        broadcastState: () => void;
        runThemeQa(tabId: string, options?: { workspaceRoot?: string }): Promise<{ ok: boolean }>;
      };
      host.tabs.get('tab-x')!.state.url = 'https://unmapped-domain.invalid/';
      host.documentGenerations = new Map();
      host.broadcastState = () => {};
      // Run the queued work inline so runThemeQa's promise settles.
      host.asyncQaQueue = {
        enqueue: (_tabId, _gen, work) => { void work(new AbortController().signal); },
      };

      let capturedWorkspaceRoot: string | undefined;
      host.controlPlane = {
        getWorkspaceRoot: () => foreign,
        getLease: () => ({ projectId: 'p', workspaceId: 'w', runtimeId: 'r', hostEpoch: 1 }),
        validateThemeQa: async (_target, input) => {
          capturedWorkspaceRoot = input.workspaceRoot;
          return { summary: { passed: true, criticalCount: 0 }, findings: {}, artifacts: [] };
        },
      };

      const result = await host.runThemeQa('tab-x', { workspaceRoot: foreign });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(capturedWorkspaceRoot, '', 'an unresolvable tab must QA against a provisional root, never the control-plane root or a caller-supplied foreign root');
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });
});

describe('CockpitPort consumes the tab-scoped resolver', () => {
  it('resolveScope forwards the bound tabId and derives a non-provisional scope from the resolved root', () => {
    const s2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cockpit-s2-'));
    try {
      const calls: Array<{ tabId: string; tabUrl: string }> = [];
      const host = {
        hasTab: (tabId: string) => tabId === 'tab-s2',
        getTabUrl: (tabId: string) => (tabId === 'tab-s2' ? 'https://s2-spa.myharavan.com/' : ''),
        getThemeQaState: () => ({ status: 'idle', issueCount: 0, updatedAt: 0 }),
        checklistLoad: () => ({ scope: '', workspaceRoot: '', items: [], baseUpdatedAt: 0 }),
        checklistMutate: () => ({ ok: true }),
        checklistSave: () => ({ ok: true }),
        navigateAndWait: async () => true,
        runThemeQa: async () => ({ ok: true }),
        resolveTabWorkspaceRoot: (tabId: string, tabUrl?: string) => {
          calls.push({ tabId, tabUrl: tabUrl ?? '' });
          // A tab stamped with the S2 Spa capsule resolves S2 Spa — this seam
          // used to receive no tabId and fall back to the active capsule.
          return tabId === 'tab-s2' ? s2Dir : '';
        },
      };
      const port = new CockpitPort(host as never);

      const identity = port.resolveScope('tab-s2');
      assert.deepStrictEqual(calls, [{ tabId: 'tab-s2', tabUrl: 'https://s2-spa.myharavan.com/' }], 'tabId and live URL reach the resolver');
      assert.strictEqual(identity.workspaceRoot, s2Dir);
      assert.strictEqual(identity.isProvisional, false, 'the stamped tab must not degrade to a provisional scope');
      assert.strictEqual(identity.scope.includes('unknown-workspace'), false);
      assert.strictEqual(identity.scope.startsWith('https://s2-spa.myharavan.com@'), true, 'scope is pinned to the tab origin');
    } finally {
      fs.rmSync(s2Dir, { recursive: true, force: true });
    }
  });

  it('resolveScope degrades to a provisional scope when the tab owns no workspace', () => {
    const host = {
      hasTab: () => true,
      getTabUrl: () => 'https://s2-spa.myharavan.com/',
      getThemeQaState: () => ({ status: 'idle', issueCount: 0, updatedAt: 0 }),
      checklistLoad: () => ({ scope: '', workspaceRoot: '', items: [], baseUpdatedAt: 0 }),
      checklistMutate: () => ({ ok: true }),
      checklistSave: () => ({ ok: true }),
      navigateAndWait: async () => true,
      runThemeQa: async () => ({ ok: true }),
      resolveTabWorkspaceRoot: () => '',
    };
    const port = new CockpitPort(host as never);
    const identity = port.resolveScope('tab-x');
    assert.strictEqual(identity.workspaceRoot, '');
    assert.strictEqual(identity.isProvisional, true);
    assert.strictEqual(identity.scope.includes('unknown-workspace'), true, 'unresolvable tabs stay provisional rather than borrowing the active capsule');
  });
});
