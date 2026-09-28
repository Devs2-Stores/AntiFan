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

function createFakeHost(tabs: string[], auxiliarySurfaces?: Record<number, RoutedSurface>): NativeTabHost {
  const tabSet = new Set(tabs);
  return {
    hasTab: (tabId: string) => tabSet.has(tabId),
    surfaceForWebContents: (id: number) => auxiliarySurfaces?.[id],
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
});
