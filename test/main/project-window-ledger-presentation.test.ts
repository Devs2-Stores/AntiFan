/**
 * Which windows the open-window ledger lists for the next boot: those a person could see.
 *
 * The ledger is the boot restore's only evidence of what was on screen at the last exit. A key
 * written when a window is built listed a window an agent created hidden for its own work, and
 * the next boot then put that window on screen although nobody had opened it.
 *
 * Both cases drive the shipping creation path in `src/main/index.ts` (`ensureProjectWindow`
 * through `projectWindowAuthority` and `restoreProjectWindows`, the boot presenter included)
 * against a throwaway profile. The real `ProjectWindowManager` owns the shells; only the native
 * window and the tab host are doubles, since a node test has no Electron. The window double
 * mirrors what Electron 43 was measured to do: hidden at construction, and `show` /
 * `showInactive` both emit `show`.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { installElectronStub } from '../support/electron-stub';

// The stub must be in the require cache before src/main/index is loaded.
installElectronStub();

// Every root points at one throwaway directory before the main module is loaded, so nothing
// this file persists can land in a developer shell's live profile.
const pinnedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-window-ledger-'));
process.env.ANTIFAN_DATA_ROOT = pinnedRoot;
process.env.ANTIFAN_CONFIG_DIR = path.join(pinnedRoot, 'config');
process.env.ANTIFAN_USER_DATA = path.join(pinnedRoot, 'Profile');
fs.mkdirSync(process.env.ANTIFAN_USER_DATA, { recursive: true });

import { savedTabsFilePath, type NativeTabHost } from '../../src/main/browser/native-tab-host';
import { openWindowLedgerPath, readOpenWindowLedger } from '../../src/main/browser/open-window-ledger';
import { ProjectWindowManager } from '../../src/main/browser/project-window-manager';
import { ownerKey, type ProjectWindowShell, type WindowOwner } from '../../src/main/browser/project-window-shell';
import {
  projectRegistry,
  projectWindowAuthority,
  restoreProjectWindows,
  setProjectWindowHostFactoryForTesting,
  setProjectWindowManagerForTesting,
} from '../../src/main/index';

const AGENT_PROJECT = 'project-00000000-0000-4000-8000-0000000000d4';
const RESTORED_PROJECT = 'project-00000000-0000-4000-8000-0000000000e5';

/** The native window as Main drives it: hidden when built, shown only by a presenter. */
class WindowDouble extends EventEmitter {
  private visible = false;

  public constructor(public readonly id: number) {
    super();
  }

  public isDestroyed(): boolean { return false; }
  public isVisible(): boolean { return this.visible; }
  public isMinimized(): boolean { return false; }
  public isFocused(): boolean { return false; }
  public center(): void {}
  public maximize(): void {}
  public restore(): void {}
  public focus(): void {}
  public show(): void { this.present(); }
  public showInactive(): void { this.present(); }

  private present(): void {
    if (this.visible) return;
    this.visible = true;
    this.emit('show');
  }
}

/** A tab host that takes every wiring call the creation path makes and hosts no tab. */
function hostDouble(): NativeTabHost {
  const answers: Record<string, unknown> = {
    resolveTerminalCreationTarget: () => ({ cwd: '', source: 'test' }),
    getTabList: () => [],
  };
  return new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop === 'string' && prop in answers) return answers[prop];
      // Not a thenable: the host travels inside resolved promises.
      return prop === 'then' ? undefined : () => undefined;
    },
  }) as unknown as NativeTabHost;
}

const windows = new Map<string, WindowDouble>();

function listedForNextBoot(key: string): boolean {
  return readOpenWindowLedger(openWindowLedgerPath(savedTabsFilePath()))?.has(key) === true;
}

describe('open-window ledger lists only windows a person could see', () => {
  before(() => {
    for (const [projectId, name] of [[AGENT_PROJECT, 'agent-work'], [RESTORED_PROJECT, 'restored']] as const) {
      const workspaceDir = path.join(pinnedRoot, 'workspaces', name);
      fs.mkdirSync(workspaceDir, { recursive: true });
      projectRegistry.ensureInitialWorkspace(projectId, projectId.replace('project-', 'workspace-'), workspaceDir, pinnedRoot);
    }
    setProjectWindowHostFactoryForTesting(() => hostDouble());
    setProjectWindowManagerForTesting(new ProjectWindowManager({
      createShell: (owner: WindowOwner) => {
        const window = new WindowDouble(windows.size + 1);
        windows.set(ownerKey(owner), window);
        return {
          owner,
          window,
          title: ownerKey(owner),
          onClosed: () => () => {},
          onCloseRequest: () => {},
          ownsChromeWebContents: () => false,
          disposeChrome: () => {},
        } as unknown as ProjectWindowShell;
      },
    }));
  });

  after(() => {
    setProjectWindowManagerForTesting(null);
    setProjectWindowHostFactoryForTesting(null);
    fs.rmSync(pinnedRoot, { recursive: true, force: true });
  });

  it('never lists a window created hidden for agent work, so no boot puts it on screen', async () => {
    const key = `project:${AGENT_PROJECT}`;
    const entry = await projectWindowAuthority.ensureProjectWindow({ kind: 'project', projectId: AGENT_PROJECT }, 'agent');
    // Past the 300 ms first-paint fallback a presented window would have used.
    await delay(350);

    assert.equal(entry.ownerKey, key);
    assert.equal(windows.get(key)?.isVisible(), false, 'agent work never presents its window');
    assert.equal(listedForNextBoot(key), false, 'a window nobody could see is not listed for the next boot');
  });

  it('lists a restored window when it is presented, not while it waits for its first paint', async () => {
    const key = `project:${RESTORED_PROJECT}`;
    const [outcome] = await restoreProjectWindows([RESTORED_PROJECT]);
    assert.equal(outcome?.status, 'restored');
    assert.equal(listedForNextBoot(key), false, 'the window is not on screen before its first paint');

    windows.get(key)?.emit('ready-to-show');

    assert.equal(windows.get(key)?.isVisible(), true, 'the boot presenter shows a restored window');
    assert.equal(listedForNextBoot(key), true, 'the presented window is listed for the next boot');
  });
});
