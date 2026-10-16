// When a project window disappears, a session that finds its bound tab gone needs to tell a native
// closure from a destruction nobody reported. The manager writes one structured line per loss.
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { ProjectWindowManager } from '../../src/main/browser/project-window-manager';
import { ownerKey, type ProjectWindowShell, type WindowOwner } from '../../src/main/browser/project-window-shell';

const PROJECT_A: WindowOwner = { kind: 'project', projectId: 'project-aaaaaaaa-0000-4000-8000-000000000001' };

function makeShell(owner: WindowOwner): { shell: ProjectWindowShell; destroy: () => void; emitClosed: () => void } {
  let destroyed = false;
  const closedListeners = new Set<() => void>();
  const shell = {
    owner,
    window: { isDestroyed: () => destroyed },
    onClosed: (listener: () => void) => {
      closedListeners.add(listener);
      return () => { closedListeners.delete(listener); };
    },
    ownsChromeWebContents: () => false,
    disposeChrome: () => {},
  } as unknown as ProjectWindowShell;
  return {
    shell,
    destroy: () => { destroyed = true; },
    emitClosed: () => {
      destroyed = true;
      for (const listener of [...closedListeners]) listener();
    },
  };
}

describe('project window loss is logged as one structured line', () => {
  const originalWarn = console.warn;
  let lines: string[] = [];

  beforeEach(() => {
    lines = [];
    console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  });
  afterEach(() => {
    console.warn = originalWarn;
  });

  function lossEvents(): Array<Record<string, unknown>> {
    const marker = '[project-window-manager] ';
    return lines
      .filter((line) => line.startsWith(marker))
      .map((line): unknown => JSON.parse(line.slice(marker.length)))
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && 'event' in entry && (entry as Record<string, unknown>).event === 'project-window-lost');
  }

  it('names the owner and a native closure', async () => {
    const made = makeShell(PROJECT_A);
    const manager = new ProjectWindowManager({ createShell: () => made.shell });
    await manager.ensureWindow(PROJECT_A, 'agent');
    made.emitClosed();
    const events = lossEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.cause, 'native-closure');
    assert.equal(events[0]!.owner, ownerKey(PROJECT_A));
    assert.equal(typeof events[0]!.at, 'string');
  });

  it('names a window found destroyed without any closure report', async () => {
    const made = makeShell(PROJECT_A);
    const manager = new ProjectWindowManager({ createShell: () => made.shell });
    await manager.ensureWindow(PROJECT_A, 'agent');
    made.destroy();
    manager.notifyShellGone(PROJECT_A);
    const events = lossEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.cause, 'shell-gone');
    assert.equal(events[0]!.owner, ownerKey(PROJECT_A));
  });

  it('logs nothing for a window that is still alive, even when asked whether it is gone', async () => {
    const made = makeShell(PROJECT_A);
    const manager = new ProjectWindowManager({ createShell: () => made.shell });
    await manager.ensureWindow(PROJECT_A, 'agent');
    manager.notifyShellGone(PROJECT_A);
    assert.deepEqual(lossEvents(), []);
  });
});
