/**
 * AntiFan Browser Desktop — Tab authority directory tests
 *
 * Tests the window-to-host registry that shared services use to resolve
 * tabs and chrome senders across multiple project windows.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TabAuthorityDirectory } from '../../src/main/browser/tab-authority-directory';
import type { ProjectWindowShell, ChromeSurface } from '../../src/main/browser/project-window-shell';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';
import type { RoutedSurface } from '../../src/main/browser/ipc-router';

interface FakeShellControl {
  shell: ProjectWindowShell;
  setDestroyed(destroyed: boolean): void;
}

function createFakeShell(options: {
  destroyed?: boolean;
  surfaces?: Record<number, ChromeSurface>;
} = {}): FakeShellControl {
  let isDestroyed = options.destroyed ?? false;
  const shell = {
    window: {
      isDestroyed: () => isDestroyed,
    },
    chromeSurfaceFor: (webContentsId: number): ChromeSurface | undefined => options.surfaces?.[webContentsId],
  } as unknown as ProjectWindowShell;

  return {
    shell,
    setDestroyed(destroyed: boolean) {
      isDestroyed = destroyed;
    },
  };
}

function createFakeHost(
  tabs: string[],
  auxiliarySurfaces?: Record<number, RoutedSurface>,
  affinities: Record<string, 'alive' | 'closed'> = {},
): NativeTabHost {
  const tabSet = new Set(tabs);
  return {
    hasTab: (tabId: string) => tabSet.has(tabId),
    surfaceForWebContents: (id: number) => auxiliarySurfaces?.[id],
    getTerminalAgentAffinity: (terminalId: string) => (affinities[terminalId] ? { status: affinities[terminalId] } : undefined),
  } as unknown as NativeTabHost;
}

describe('TabAuthorityDirectory', () => {
  it('returns the host whose hasTab is true and undefined otherwise', () => {
    const directory = new TabAuthorityDirectory();
    const shellA = createFakeShell().shell;
    const shellB = createFakeShell().shell;
    const hostA = createFakeHost(['tab-1', 'tab-2']);
    const hostB = createFakeHost(['tab-3']);

    directory.register(shellA, hostA);
    directory.register(shellB, hostB);

    assert.equal(directory.hostForTab('tab-1'), hostA);
    assert.equal(directory.hostForTab('tab-2'), hostA);
    assert.equal(directory.hostForTab('tab-3'), hostB);
    assert.equal(directory.hostForTab('tab-unknown'), undefined);
  });

  it('skips a destroyed window even when hasTab would match', () => {
    const directory = new TabAuthorityDirectory();
    const controlA = createFakeShell();
    const controlB = createFakeShell();
    const hostA = createFakeHost(['tab-1']);
    const hostB = createFakeHost(['tab-2']);

    directory.register(controlA.shell, hostA);
    directory.register(controlB.shell, hostB);

    assert.equal(directory.hostForTab('tab-1'), hostA);
    assert.equal(directory.hostForTab('tab-2'), hostB);

    // Destroy window A
    controlA.setDestroyed(true);

    assert.equal(directory.hostForTab('tab-1'), undefined);
    assert.equal(directory.hostForTab('tab-2'), hostB);
  });

  it('resolves sender to the shell chrome surface and undefined for an unknown id', () => {
    const directory = new TabAuthorityDirectory();
    const shellA = createFakeShell({
      surfaces: { 101: 'toolbar', 102: 'sidebar' },
    }).shell;
    const hostA = createFakeHost([]);

    directory.register(shellA, hostA);

    const resolvedToolbar = directory.resolveSender(101);
    assert.deepEqual(resolvedToolbar, { host: hostA, surface: 'toolbar' });

    const resolvedSidebar = directory.resolveSender(102);
    assert.deepEqual(resolvedSidebar, { host: hostA, surface: 'sidebar' });

    const resolvedUnknown = directory.resolveSender(999);
    assert.equal(resolvedUnknown, undefined);
  });

  it('skips destroyed windows during sender resolution', () => {
    const directory = new TabAuthorityDirectory();
    const controlA = createFakeShell({
      surfaces: { 101: 'toolbar' },
    });
    const hostA = createFakeHost([]);

    directory.register(controlA.shell, hostA);
    assert.ok(directory.resolveSender(101));

    controlA.setDestroyed(true);
    assert.equal(directory.resolveSender(101), undefined);
  });

  it('resolves sender through host auxiliary surface when shell does not own it', () => {
    const directory = new TabAuthorityDirectory();
    const shell = createFakeShell().shell;
    const host = createFakeHost([], { 201: 'frameBackdrop' });

    directory.register(shell, host);

    const resolved = directory.resolveSender(201);
    assert.deepEqual(resolved, { host, surface: 'frameBackdrop' });
  });

  it('ignores destroyed windows in liveShellCount', () => {
    const directory = new TabAuthorityDirectory();
    const controlA = createFakeShell();
    const controlB = createFakeShell();
    const hostA = createFakeHost([]);
    const hostB = createFakeHost([]);

    directory.register(controlA.shell, hostA);
    directory.register(controlB.shell, hostB);

    assert.equal(directory.liveShellCount(), 2);

    controlA.setDestroyed(true);
    assert.equal(directory.liveShellCount(), 1);

    controlB.setDestroyed(true);
    assert.equal(directory.liveShellCount(), 0);
  });

  it('stops all lookups after unregister', () => {
    const directory = new TabAuthorityDirectory();
    const shellA = createFakeShell({ surfaces: { 101: 'toolbar' } }).shell;
    const hostA = createFakeHost(['tab-1']);

    directory.register(shellA, hostA);

    assert.equal(directory.hostForTab('tab-1'), hostA);
    assert.equal(directory.hostForShell(shellA), hostA);
    assert.ok(directory.resolveSender(101));
    assert.equal(directory.liveShellCount(), 1);
    assert.deepEqual(directory.hosts(), [hostA]);

    directory.unregister(shellA);

    assert.equal(directory.hostForTab('tab-1'), undefined);
    assert.equal(directory.hostForShell(shellA), undefined);
    assert.equal(directory.resolveSender(101), undefined);
    assert.equal(directory.liveShellCount(), 0);
    assert.deepEqual(directory.hosts(), []);
  });

  describe('agentHoldsTerminal — what keeps an `agent:` row read-only to the manager', () => {
    it('holds a bridge-minted row while the tab its owner key names is open, with no affinity bound', () => {
      const directory = new TabAuthorityDirectory();
      const window = createFakeShell();
      directory.register(window.shell, createFakeHost(['tab-agent']));

      assert.equal(directory.agentHoldsTerminal('terminal-1', 'agent:tab-agent'), true, 'the minting agent is alive while its tab is');
      assert.equal(directory.terminalHasLiveAgentAffinity('terminal-1'), false, 'the MCP plane still sees no affinity');

      window.setDestroyed(true);
      assert.equal(directory.agentHoldsTerminal('terminal-1', 'agent:tab-agent'), false, 'its window gone, nothing holds the row');
    });

    it('holds a row through a live affinity on any window, even after the minting tab closed', () => {
      const directory = new TabAuthorityDirectory();
      directory.register(createFakeShell().shell, createFakeHost([]));
      directory.register(createFakeShell().shell, createFakeHost(['tab-other'], undefined, { 'terminal-1': 'alive' }));

      assert.equal(directory.agentHoldsTerminal('terminal-1', 'agent:tab-gone'), true);
      assert.equal(directory.terminalHasLiveAgentAffinity('terminal-1'), true);
    });

    it('releases an orphan: minting tab gone, affinity closed', () => {
      const directory = new TabAuthorityDirectory();
      directory.register(createFakeShell().shell, createFakeHost(['tab-other'], undefined, { 'terminal-1': 'closed' }));

      assert.equal(directory.agentHoldsTerminal('terminal-1', 'agent:tab-gone'), false);
    });

    it('holds `agent:unbound` only through an affinity, never through a tab named "unbound"', () => {
      const directory = new TabAuthorityDirectory();
      directory.register(createFakeShell().shell, createFakeHost(['unbound']));

      assert.equal(directory.agentHoldsTerminal('terminal-1', 'agent:unbound'), false);
      directory.register(createFakeShell().shell, createFakeHost([], undefined, { 'terminal-1': 'alive' }));
      assert.equal(directory.agentHoldsTerminal('terminal-1', 'agent:unbound'), true);
    });

    it('never claims a project-owned or ownerless row through a tab id', () => {
      const directory = new TabAuthorityDirectory();
      directory.register(createFakeShell().shell, createFakeHost(['proj-a']));

      assert.equal(directory.agentHoldsTerminal('terminal-1', 'project:proj-a'), false);
      assert.equal(directory.agentHoldsTerminal('terminal-1', undefined), false);
    });
  });
});
