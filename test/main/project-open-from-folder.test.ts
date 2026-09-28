/**
 * Opening a project from an arbitrary folder through Main's own picker.
 *
 * The cases drive the real `openProjectWindow` through its chrome route
 * (`antifan:project:open`) with only the Electron dialogs scripted: the project picker's
 * answer index and the folder chooser's file list are the user, everything between them —
 * the spec's button order, the filesystem validation, the registry's adoption and
 * ambiguity checks, and the fail-closed refusal before any record moves — is shipping code.
 *
 * What a node test can and cannot see bounds the assertions honestly. The Electron stub
 * never resolves `app.whenReady()`, so `capsuleManager` and `projectWindows` stay null: a
 * folder open that needs to mint records must fail closed before mutating (asserted
 * through the shared `projectRegistry` and the capsule-store file under the thrown-away
 * data root), and an adopted folder resolves to its project id but cannot open a window.
 * The OPENED/FOCUSED half of the same path is owned by the Electron e2e lane.
 */
import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { installElectronStub } from '../support/electron-stub';

// The stub must sit in the require cache before src/main/index is loaded: an import that
// throws registers no case, and a file with no registered case still reports as passing.
installElectronStub();

// Storage lives in a throwaway root: importing src/main/index creates the storage
// directories on load, and the capsule store under config/ is the durability surface the
// assertions read. ANTIFAN_CONFIG_DIR is cleared so every consumer resolves the same root
// instead of inheriting a runner-provided one.
const TEST_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-open-folder-data-'));
process.env.ANTIFAN_DATA_ROOT = TEST_DATA_ROOT;
delete process.env.ANTIFAN_CONFIG_DIR;

// The dialogs are the user. `showMessageBox` answers by button position — the folder
// action is always the second-to-last button of the spec the shipping code hands down —
// and `showOpenDialog` returns the scripted chooser answer.
type PickerReply = 'folder' | 'cancel' | number;

let pickerScript: PickerReply = 'cancel';
let messageBoxCalls = 0;
let openDialogCalls = 0;
let folderAnswer: { canceled: true; filePaths: string[] } | { canceled: false; filePaths: string[] } = {
  canceled: true,
  filePaths: [],
};

const electron = require('electron') as {
  dialog: {
    showMessageBox: (options: unknown) => Promise<{ response: number }>;
    showOpenDialog: (options: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  BrowserWindow: unknown;
};

electron.dialog.showMessageBox = async (options: unknown) => {
  messageBoxCalls += 1;
  const buttons = (options as { buttons?: string[] } | undefined)?.buttons ?? [];
  if (pickerScript === 'folder') return { response: buttons.length - 2 };
  if (pickerScript === 'cancel') return { response: buttons.length - 1 };
  return { response: pickerScript };
};

electron.dialog.showOpenDialog = async () => {
  openDialogCalls += 1;
  return folderAnswer;
};

// No window exists under the stub, so both dialogs must take their unparented overloads:
// a focused window the test cannot see must never become a dialog's parent, and the
// picker event's fake sender must not resolve to a window either.
const browserWindowStub = electron.BrowserWindow as {
  getFocusedWindow?: () => unknown;
  fromWebContents?: (sender: unknown) => unknown;
};
browserWindowStub.getFocusedWindow = () => null;
browserWindowStub.fromWebContents = () => null;

import { createChromeRouteHarness } from '../support/chrome-route-harness';
import { makeControlPlaneId } from '../../src/shared/control-plane-contracts';
import type { ProjectOpenResult } from '../../src/shared/contracts';
import { PROJECT_WINDOW_ROUTES, projectWindowAuthority } from '../../src/main/index';

const PROJECT_OPEN_CHANNEL = 'antifan:project:open';

// The route's surface gate needs a host to attribute the sender to; the channel under
// test never touches it, so a bare double satisfies the contract (the harness itself
// documents this cast for sender resolution).
const harness = createChromeRouteHarness({
  host: {} as unknown as NativeTabHost,
  routes: PROJECT_WINDOW_ROUTES,
});

function openViaPicker(): Promise<ProjectOpenResult> {
  return harness.invoke(PROJECT_OPEN_CHANNEL, {}) as Promise<ProjectOpenResult>;
}

function capsuleStorePath(): string {
  return path.join(TEST_DATA_ROOT, 'config', 'workspace-capsules.json');
}

function freshFolder(): string {
  // realpathSync mirrors the production boundary: the chooser answer is validated through
  // the filesystem, so the test hands over a real directory in its resolved spelling.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-open-folder-')));
}

function registry() {
  return projectWindowAuthority.projectRegistry();
}

after(() => {
  fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});

describe('open project from folder', () => {
  it('answers CANCELLED and touches nothing when the picker itself is dismissed', async () => {
    pickerScript = 'cancel';
    const openCallsBefore = openDialogCalls;
    const projectsBefore = registry().listProjects().length;

    const result = await openViaPicker();

    assert.strictEqual(result.status, 'CANCELLED');
    assert.strictEqual(openDialogCalls, openCallsBefore, 'a dismissed picker never reaches the folder chooser');
    assert.strictEqual(registry().listProjects().length, projectsBefore, 'a dismissal creates no project');
    assert.strictEqual(fs.existsSync(capsuleStorePath()), false, 'a dismissal writes no capsule record');
  });

  it('answers CANCELLED and creates nothing when the folder chooser is dismissed', async () => {
    pickerScript = 'folder';
    folderAnswer = { canceled: true, filePaths: [] };
    const projectsBefore = registry().listProjects().length;

    const result = await openViaPicker();

    assert.strictEqual(result.status, 'CANCELLED');
    assert.strictEqual(registry().listProjects().length, projectsBefore, 'a chooser the user closed mints no project');
    assert.strictEqual(fs.existsSync(capsuleStorePath()), false, 'a chooser the user closed writes no capsule record');
  });

  it('refuses a fresh folder closed rather than mint a project that cannot persist', async () => {
    // A project record without a capsule affiliation vanishes at the next boot and takes
    // the window's identity with it, so a build with no capsule store must refuse before
    // the first record moves. That fail-closed boundary is the part of the fresh-folder
    // contract a node test can observe; the OPENED window needs live Electron.
    const dir = freshFolder();
    try {
      pickerScript = 'folder';
      folderAnswer = { canceled: false, filePaths: [dir] };
      const projectsBefore = registry().listProjects().length;

      const result = await openViaPicker();

      assert.deepStrictEqual(result, { status: 'FAILED', reason: 'PROJECT_FOLDER_INVALID' });
      assert.strictEqual(registry().listProjects().length, projectsBefore, 'the refusal happens before any project record');
      assert.deepStrictEqual(registry().findWorkspacesByRoot(dir), [], 'no workspace attaches to the refused folder');
      assert.strictEqual(fs.existsSync(capsuleStorePath()), false, 'the refusal happens before any capsule record');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a folder already attached to a known project resolves to that project instead of minting a second one', async () => {
    // The registry is the identity of record: a second project for one directory would
    // leave two windows whose terminals share a working directory but not a close gate.
    const dir = freshFolder();
    try {
      const dataRoot = path.join(TEST_DATA_ROOT, 'control-plane');
      const adopted = registry().createProject('Adopted Project', dataRoot);
      registry().ensureInitialWorkspace(adopted.id, makeControlPlaneId('workspace'), dir, dataRoot);
      const projectsBefore = registry().listProjects().length;

      pickerScript = 'folder';
      folderAnswer = { canceled: false, filePaths: [dir] };

      const result = await openViaPicker();

      // The adopted id must ride the outcome even though the window factory itself cannot
      // run without live Electron — the FAILED tail is the test environment, the id is
      // the adoption contract.
      assert.strictEqual(result.status, 'FAILED');
      assert.strictEqual('projectId' in result ? result.projectId : '', adopted.id, 'the folder answered the project that already owns it');
      assert.match('reason' in result ? result.reason : '', /window manager/i, 'the refusal is the absent window factory, not the folder');
      assert.strictEqual(registry().listProjects().length, projectsBefore, 'an adopted folder never mints a duplicate project');
      assert.deepStrictEqual(
        registry().findWorkspacesByRoot(dir).map((workspace) => workspace.projectId),
        [adopted.id],
        'the folder still belongs to exactly the one project that claimed it',
      );
      assert.strictEqual(fs.existsSync(capsuleStorePath()), false, 'an adopted folder creates no capsule record');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a folder two attached workspaces share rather than tie-break between them', async () => {
    // Two projects rooted at one folder is ambiguity, not a choice: picking either would
    // hand the user's click to a project they never named.
    const dir = freshFolder();
    try {
      const dataRoot = path.join(TEST_DATA_ROOT, 'control-plane');
      const first = registry().createProject('First Claimant', dataRoot);
      const second = registry().createProject('Second Claimant', dataRoot);
      registry().ensureInitialWorkspace(first.id, makeControlPlaneId('workspace'), dir, dataRoot);
      registry().ensureInitialWorkspace(second.id, makeControlPlaneId('workspace'), dir, dataRoot);
      const projectsBefore = registry().listProjects().length;

      pickerScript = 'folder';
      folderAnswer = { canceled: false, filePaths: [dir] };

      const result = await openViaPicker();

      assert.deepStrictEqual(result, { status: 'FAILED', reason: 'AMBIGUOUS_PROJECT_FOLDER' });
      assert.strictEqual(registry().listProjects().length, projectsBefore, 'an ambiguous folder mints no third project');
      assert.strictEqual(registry().findWorkspacesByRoot(dir).length, 2, 'both claims stay attached and undisturbed');
      assert.strictEqual(fs.existsSync(capsuleStorePath()), false, 'an ambiguous folder writes no capsule record');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a path that does not exist and a path that is a file, identically and without mutation', async () => {
    // The chooser's answer is validated through the real filesystem before it can become
    // a workspace root: a workspace anchors PTY cwd and preview containment, so a missing
    // or non-directory path must die at the boundary.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-open-folder-invalid-'));
    try {
      pickerScript = 'folder';
      const projectsBefore = registry().listProjects().length;

      folderAnswer = { canceled: false, filePaths: [path.join(parent, 'does-not-exist')] };
      const missing = await openViaPicker();
      assert.deepStrictEqual(missing, { status: 'FAILED', reason: 'PROJECT_FOLDER_INVALID' });

      const file = path.join(parent, 'a-file.txt');
      fs.writeFileSync(file, 'x');
      folderAnswer = { canceled: false, filePaths: [file] };
      const notDirectory = await openViaPicker();
      assert.deepStrictEqual(notDirectory, { status: 'FAILED', reason: 'PROJECT_FOLDER_INVALID' });

      assert.strictEqual(registry().listProjects().length, projectsBefore, 'an invalid folder creates no project');
      assert.strictEqual(fs.existsSync(capsuleStorePath()), false, 'an invalid folder writes no capsule record');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('an explicit project id bypasses the picker and is still refused by name when unknown', async () => {
    // The folder flow must not weaken the named-open validation: an id Main never issued
    // is refused before any dialog opens.
    const messageCallsBefore = messageBoxCalls;
    const openCallsBefore = openDialogCalls;
    const malformed = await (harness.invoke(PROJECT_OPEN_CHANNEL, { projectId: 'not-a-project-id' }) as Promise<ProjectOpenResult>);
    assert.deepStrictEqual(malformed, { status: 'FAILED', reason: 'INVALID_PROJECT_ID' });

    const unknown = await (harness.invoke(
      PROJECT_OPEN_CHANNEL,
      { projectId: 'project-00000000-0000-4000-8000-0000000000ff' },
    ) as Promise<ProjectOpenResult>);
    assert.strictEqual(unknown.status, 'FAILED');
    assert.strictEqual('reason' in unknown ? unknown.reason : '', 'UNKNOWN_PROJECT');
    assert.strictEqual('projectId' in unknown ? unknown.projectId : '', 'project-00000000-0000-4000-8000-0000000000ff');

    assert.strictEqual(messageBoxCalls, messageCallsBefore, 'a named project never opens the picker');
    assert.strictEqual(openDialogCalls, openCallsBefore, 'a named project never opens the folder chooser');
  });
});
