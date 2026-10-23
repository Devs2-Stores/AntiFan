/**
 * What a boot does with the saved tabs and the project windows that were open at the last exit.
 *
 * Two seams, both exercised through the shipping functions in `src/main/index.ts`:
 *   - `runSavedTabsMigrationAtBoot` against a throwaway profile directory (the path
 *     `savedTabsFilePath()` resolves from `ANTIFAN_USER_DATA`): the file is rewritten only when
 *     every tab has a home, a backup precedes the rewrite, and a second boot has nothing to do.
 *   - `planBootWindows` / `restoreProjectWindows`: the migration's `openProjectIds` decide which
 *     project windows open and in which order, and with none only the Terminal Manager does.
 *     The window manager is the real `ProjectWindowManager`; only the shell it builds is a
 *     double (a node test has no Electron windows), registered with its host so the restore
 *     takes `ensureProjectWindow`'s join path and never reaches the native-window wiring.
 */
import { describe, it, before, beforeEach, afterEach, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installElectronStub } from '../support/electron-stub';

// The stub must be in the require cache before src/main/index is loaded: an import that throws
// registers no case, and a file with no registered case still reports as one passing test.
installElectronStub();

// This file never relies on the roots its shell inherited (a developer shell can carry a running
// app's): the data root, config dir and profile all point at one throwaway directory before the
// main module is loaded, so nothing it persists can land anywhere else.
const pinnedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-boot-restore-env-'));
process.env.ANTIFAN_DATA_ROOT = pinnedRoot;
process.env.ANTIFAN_CONFIG_DIR = path.join(pinnedRoot, 'config');
process.env.ANTIFAN_USER_DATA = path.join(pinnedRoot, 'Profile');

import { savedTabsFilePath, type NativeTabHost } from '../../src/main/browser/native-tab-host';
import { markWindowOpen, openWindowLedgerPath } from '../../src/main/browser/open-window-ledger';
import { ProjectWindowManager, type OpenIntent } from '../../src/main/browser/project-window-manager';
import { PROJECT_WINDOWS_SAVED_TABS_VERSION } from '../../src/main/browser/saved-tabs-migration';
import { ownerKey, type ProjectWindowShell, type WindowOwner } from '../../src/main/browser/project-window-shell';
import {
  installShellForTesting,
  planBootWindows,
  projectRegistry,
  restoreProjectWindows,
  runSavedTabsMigrationAtBoot,
  setProjectWindowManagerForTesting,
} from '../../src/main/index';

const ALPHA = 'project-00000000-0000-4000-8000-0000000000a1';
const BETA = 'project-00000000-0000-4000-8000-0000000000b2';
const GAMMA = 'project-00000000-0000-4000-8000-0000000000c3';
const GONE = 'project-00000000-0000-4000-8000-0000000000ff';
const BACKUP_NAME = /^saved-tabs\.json\.pre-project-windows-\d{14}\.bak$/;

let rootDir = '';
let userDataDir = '';
let savedEnv: Record<string, string | undefined> = {};

function seedProject(projectId: string, workspaceId: string, name: string): void {
  const workspaceDir = path.join(rootDir, name.toLowerCase());
  fs.mkdirSync(workspaceDir, { recursive: true });
  projectRegistry.ensureInitialWorkspace(projectId, workspaceId, workspaceDir, rootDir);
  projectRegistry.registerProject({ ...projectRegistry.getProject(projectId), name });
}

function tab(id: string, projectId?: string): Record<string, unknown> {
  return { id, url: `https://example.test/${id}`, title: id, ...(projectId === undefined ? {} : { projectId }) };
}

/** The hub-era layout: every tab of every project under the one shared `web` record. */
function writeLegacyDocument(web: { tabs: Array<Record<string, unknown>>; activeProjectId?: string }): Buffer {
  // Tab indentation and a trailing newline: a rewrite through JSON.stringify could not
  // reproduce these bytes, so a byte-identical file proves nothing rewrote it.
  const raw = Buffer.from(
    `${JSON.stringify({ version: 2, owners: { web: { updatedAt: 5, ...web } }, updatedAt: 100 }, null, '\t')}\n`,
    'utf8',
  );
  fs.writeFileSync(savedTabsFilePath(), raw);
  return raw;
}

function backupsInProfile(): string[] {
  return fs.readdirSync(userDataDir).filter((name) => name.includes('.pre-project-windows-'));
}

function readOwners(): Record<string, { tabs: Array<{ id: string }> }> {
  const document = JSON.parse(fs.readFileSync(savedTabsFilePath(), 'utf8')) as { owners: Record<string, { tabs: Array<{ id: string }> }> };
  return document.owners;
}

describe('saved-tabs migration at boot', () => {
  before(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-boot-restore-'));
    savedEnv = {
      ANTIFAN_USER_DATA: process.env.ANTIFAN_USER_DATA,
      ANTIFAN_USER_DATA_DIR: process.env.ANTIFAN_USER_DATA_DIR,
      ANTIFAN_PROJECT_ID: process.env.ANTIFAN_PROJECT_ID,
    };
    seedProject(ALPHA, 'workspace-00000000-0000-4000-8000-0000000000a1', 'Alpha');
    seedProject(BETA, 'workspace-00000000-0000-4000-8000-0000000000b2', 'Beta');
    seedProject(GAMMA, 'workspace-00000000-0000-4000-8000-0000000000c3', 'Gamma');
  });

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(rootDir, 'profile-'));
    process.env.ANTIFAN_USER_DATA = userDataDir;
    delete process.env.ANTIFAN_USER_DATA_DIR;
    delete process.env.ANTIFAN_PROJECT_ID;
  });

  afterEach(() => {
    setProjectWindowManagerForTesting(null);
  });

  after(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(pinnedRoot, { recursive: true, force: true });
  });

  it('gives a tab whose project is gone a home in an open project window, which then reopens', async () => {
    // `lost` is stamped with a project the registry no longer holds and no project is
    // presented or listed in the ledger. With no project record on disk yet, the first open
    // project takes it, re-stamped, and that window is reopened so the tab is not hidden.
    writeLegacyDocument({ tabs: [tab('ok', BETA), tab('lost', GONE)] });

    const outcome = await runSavedTabsMigrationAtBoot();

    assert.equal(outcome.persisted, true);
    assert.deepEqual(outcome.unplacedTabIds, []);
    const owners = readOwners() as Record<string, { tabs: Array<{ id: string; projectId?: string }> }>;
    assert.deepEqual(owners[`project:${BETA}`]?.tabs.map((row) => row.id), ['ok']);
    assert.deepEqual(owners[`project:${ALPHA}`]?.tabs.map((row) => [row.id, row.projectId]), [['lost', ALPHA]]);
    assert.equal(owners[`project:${GONE}`], undefined, 'a window record was made for a project Main does not know');
    assert.deepEqual(outcome.openProjectIds, [ALPHA]);
  });

  it('leaves the file byte-identical, writes no backup and names the tab when no project is open', async () => {
    // No open project at all: the Terminal Manager hosts no tabs, so `lost` has no home and
    // the migration must not rewrite anything.
    const original = writeLegacyDocument({ tabs: [tab('lost', GONE)] });
    const reopen = [ALPHA, BETA, GAMMA].map((id) => projectRegistry.getProject(id));
    for (const project of reopen) projectRegistry.closeProject(project.id);
    let outcome: Awaited<ReturnType<typeof runSavedTabsMigrationAtBoot>>;
    try {
      outcome = await runSavedTabsMigrationAtBoot();
    } finally {
      for (const project of reopen) {
        projectRegistry.registerProject(project);
        for (const workspace of projectRegistry.listWorkspaces(project.id)) {
          projectRegistry.registerWorkspace({ ...workspace, state: 'attached' });
        }
      }
    }

    assert.equal(outcome.persisted, false);
    assert.deepEqual(outcome.unplacedTabIds, ['lost']);
    assert.equal(outcome.backupPath, null);
    assert.ok(fs.readFileSync(savedTabsFilePath()).equals(original), 'the saved tabs file was rewritten');
    assert.deepEqual(backupsInProfile(), [], 'a backup was taken for a migration that wrote nothing');
  });

  it('rewrites the file at the project-window version behind exactly one backup, once', async () => {
    const original = writeLegacyDocument({ tabs: [tab('a1', ALPHA), tab('b1', BETA), tab('a2', ALPHA)], activeProjectId: ALPHA });

    const first = await runSavedTabsMigrationAtBoot();

    assert.equal(first.migrated, true);
    assert.equal(first.persisted, true);
    assert.deepEqual(first.unplacedTabIds, []);
    assert.deepEqual(first.openProjectIds, [ALPHA]);
    const rewritten = JSON.parse(fs.readFileSync(savedTabsFilePath(), 'utf8')) as { version: number };
    assert.equal(rewritten.version, PROJECT_WINDOWS_SAVED_TABS_VERSION);
    const owners = readOwners();
    assert.deepEqual(owners[`project:${ALPHA}`]?.tabs.map((row) => row.id), ['a1', 'a2']);
    assert.deepEqual(owners[`project:${BETA}`]?.tabs.map((row) => row.id), ['b1']);
    assert.equal(owners.web, undefined, 'the shared record outlived the migration');

    const backups = backupsInProfile();
    assert.equal(backups.length, 1);
    assert.match(backups[0]!, BACKUP_NAME);
    assert.equal(first.backupPath, path.join(userDataDir, backups[0]!));
    assert.ok(fs.readFileSync(first.backupPath!).equals(original), 'the backup is not the pre-migration file');

    const afterFirst = fs.readFileSync(savedTabsFilePath());
    const second = await runSavedTabsMigrationAtBoot();

    assert.equal(second.migrated, false);
    assert.equal(second.persisted, false);
    assert.equal(second.backupPath, null);
    assert.deepEqual(second.unplacedTabIds, []);
    assert.deepEqual(backupsInProfile(), backups, 'a second boot took another backup');
    assert.ok(fs.readFileSync(savedTabsFilePath()).equals(afterFirst), 'a second boot rewrote the file');
  });

  it('reopens the presented project first, then the ledger windows, without the ones Main no longer knows', async () => {
    writeLegacyDocument({ tabs: [tab('g1', GAMMA)], activeProjectId: GAMMA });
    const ledger = openWindowLedgerPath(savedTabsFilePath());
    for (const key of [`project:${BETA}`, `project:${GONE}`, `project:${GAMMA}`, `project:${ALPHA}`]) markWindowOpen(ledger, key);

    const outcome = await runSavedTabsMigrationAtBoot();

    // The ledger reads back sorted by key; the presented project leads and is not repeated.
    assert.deepEqual(outcome.openProjectIds, [GAMMA, ALPHA, BETA]);
  });
});

/** A shell double the real manager can own: only what ProjectWindowManager itself touches. */
function makeShell(owner: WindowOwner): ProjectWindowShell {
  return {
    owner,
    window: { isDestroyed: () => false },
    onClosed: () => () => {},
    ownsChromeWebContents: () => false,
    disposeChrome: () => {},
  } as unknown as ProjectWindowShell;
}

describe('boot window plan and restore', () => {
  const created: Array<{ key: string; intent: OpenIntent }> = [];
  const releases: Array<() => void> = [];
  let failFor = new Set<string>();
  const savedProjectEnv = process.env.ANTIFAN_PROJECT_ID;

  beforeEach(() => {
    created.length = 0;
    failFor = new Set();
    delete process.env.ANTIFAN_PROJECT_ID;
    setProjectWindowManagerForTesting(new ProjectWindowManager({
      createShell: (owner, intent) => {
        const key = ownerKey(owner);
        if (failFor.has(key)) throw new Error(`no window for ${key}`);
        created.push({ key, intent });
        const shell = makeShell(owner);
        // Registered with a host so `ensureProjectWindow` joins instead of wiring a native window.
        releases.push(installShellForTesting(shell, {} as unknown as NativeTabHost));
        return shell;
      },
    }));
  });

  afterEach(() => {
    setProjectWindowManagerForTesting(null);
    for (const release of releases.splice(0)) release();
    if (savedProjectEnv === undefined) delete process.env.ANTIFAN_PROJECT_ID;
    else process.env.ANTIFAN_PROJECT_ID = savedProjectEnv;
  });

  it('starts on the first project window that was open and restores the others behind it, in order', () => {
    assert.deepEqual(planBootWindows([BETA, ALPHA, GAMMA], undefined), {
      bootOwner: { kind: 'project', projectId: BETA },
      restoreProjectIds: [ALPHA, GAMMA],
    });
  });

  it('starts on the project the environment names, ahead of the ledger, without opening it twice', () => {
    process.env.ANTIFAN_PROJECT_ID = GAMMA;
    assert.deepEqual(planBootWindows([ALPHA, GAMMA, BETA], GAMMA), {
      bootOwner: { kind: 'project', projectId: GAMMA },
      restoreProjectIds: [ALPHA, BETA],
    });
  });

  it('starts on the Terminal Manager alone when no project window was open', () => {
    assert.deepEqual(planBootWindows([], undefined), { bootOwner: { kind: 'unassigned' }, restoreProjectIds: [] });
  });

  it('never resurrects a window for a project Main no longer knows', () => {
    assert.deepEqual(planBootWindows([GONE, ALPHA, GONE], undefined), {
      bootOwner: { kind: 'project', projectId: ALPHA },
      restoreProjectIds: [],
    });
    assert.deepEqual(planBootWindows([GONE], undefined), { bootOwner: { kind: 'unassigned' }, restoreProjectIds: [] });
  });

  it('opens the restored project windows one after another with the unfocused restore intent', async () => {
    const outcomes = await restoreProjectWindows([ALPHA, BETA, GAMMA]);

    assert.deepEqual(created, [
      { key: `project:${ALPHA}`, intent: 'restore' },
      { key: `project:${BETA}`, intent: 'restore' },
      { key: `project:${GAMMA}`, intent: 'restore' },
    ]);
    assert.deepEqual(outcomes.map((row) => [row.projectId, row.status]), [[ALPHA, 'restored'], [BETA, 'restored'], [GAMMA, 'restored']]);
  });

  it('skips an unknown project and keeps restoring the windows behind a failing one', async () => {
    failFor.add(`project:${BETA}`);

    const outcomes = await restoreProjectWindows([GONE, BETA, GAMMA]);

    assert.deepEqual(outcomes.map((row) => [row.projectId, row.status]), [[GONE, 'skipped'], [BETA, 'failed'], [GAMMA, 'restored']]);
    assert.deepEqual(created.map((row) => row.key), [`project:${GAMMA}`], 'a refused window must not stop the next one');
  });

  it('restores nothing when there is nothing to restore', async () => {
    assert.deepEqual(await restoreProjectWindows(planBootWindows([], undefined).restoreProjectIds), []);
    assert.deepEqual(created, []);
  });
});
