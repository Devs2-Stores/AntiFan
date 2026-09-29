/**
 * Project appearance (colour/star) through Main: the handler validates and refuses without
 * touching the record, the list inventory reads it back from the registry, and removing a
 * project forgets it durably.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installElectronStub } from '../support/electron-stub';

installElectronStub();

import { ProjectPreferences } from '../../src/main/project/project-preferences';
import {
  projectRegistry,
  removeProjectEntry,
  setProjectAppearanceEntry,
} from '../../src/main/index';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
const PROJECT_A = 'project-00000000-0000-4000-8000-0000000000e1';
const WORKSPACE_A = 'workspace-00000000-0000-4000-8000-0000000000e1';
const PROJECT_GHOST = 'project-00000000-0000-4000-8000-0000000000ee';
const PROJECT_FAIL = 'project-00000000-0000-4000-8000-0000000000e2';
const WORKSPACE_FAIL = 'workspace-00000000-0000-4000-8000-0000000000e2';

let tmpDir = '';
let prefsFile = '';
let workspaceAPath = '';

describe('Project appearance', () => {

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-appearance-'));
    // No web window exists under node: removal purges persisted tabs host-free, so the
    // suite pins the saved-tabs file into its own scratch dir via ANTIFAN_USER_DATA.
    process.env.ANTIFAN_USER_DATA = path.join(tmpDir, 'user-data');
    fs.mkdirSync(process.env.ANTIFAN_USER_DATA, { recursive: true });
    prefsFile = path.join(tmpDir, 'project-preferences.json');
    workspaceAPath = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspaceAPath, { recursive: true });
    projectRegistry.attachAppearanceStore(new ProjectPreferences(prefsFile));
    projectRegistry.ensureInitialWorkspace(PROJECT_A, WORKSPACE_A, workspaceAPath, tmpDir);
    const holder = TerminalManager as unknown as { instance?: unknown };
    holder.instance = {
      listSessions: () => [],
      sessionOwnerKey: () => undefined,
      sessionCapsuleId: () => undefined,
      closeSession: async () => true,
    };
  });

  after(() => {
    (TerminalManager as unknown as { instance?: unknown }).instance = undefined;
    delete process.env.ANTIFAN_USER_DATA;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
  it('sets colour and star, reports them, and the record reads them back', () => {
    const result = setProjectAppearanceEntry({ projectId: PROJECT_A, color: '#FF8800', starred: true });
    assert.deepStrictEqual(result, { status: 'UPDATED', projectId: PROJECT_A, color: '#ff8800', starred: true });
    assert.strictEqual(projectRegistry.getProject(PROJECT_A).color, '#ff8800');
    assert.strictEqual(new ProjectPreferences(prefsFile).get(PROJECT_A).starred, true);
  });

  it('refuses bad input and leaves the stored appearance untouched', () => {
    assert.strictEqual(setProjectAppearanceEntry({ projectId: PROJECT_A, color: 'orange' }).status, 'FAILED');
    assert.strictEqual(setProjectAppearanceEntry({ projectId: PROJECT_A, color: 5 }).status, 'FAILED');
    assert.strictEqual(setProjectAppearanceEntry({ projectId: PROJECT_A, starred: 'yes' }).status, 'FAILED');
    assert.strictEqual(setProjectAppearanceEntry({ projectId: PROJECT_A }).status, 'FAILED');
    assert.strictEqual(setProjectAppearanceEntry({ projectId: 'nope', starred: true }).status, 'FAILED');
    assert.strictEqual(setProjectAppearanceEntry(null).status, 'FAILED');
    assert.strictEqual(setProjectAppearanceEntry({ projectId: PROJECT_GHOST, starred: true }).status, 'UNKNOWN_PROJECT');
    assert.strictEqual(projectRegistry.getProject(PROJECT_A).color, '#ff8800');
    assert.strictEqual(projectRegistry.getProject(PROJECT_A).starred, true);
  });

  it('null clears the colour, false clears the star', () => {
    const cleared = setProjectAppearanceEntry({ projectId: PROJECT_A, color: null, starred: false });
    assert.deepStrictEqual(cleared, { status: 'UPDATED', projectId: PROJECT_A });
  });

  it('removing a project forgets its appearance durably', async () => {
    setProjectAppearanceEntry({ projectId: PROJECT_A, color: '#123456', starred: true });
    const removed = await removeProjectEntry({ projectId: PROJECT_A });
    assert.strictEqual(removed.status, 'REMOVED');
    assert.deepStrictEqual(new ProjectPreferences(prefsFile).get(PROJECT_A), {});
  });

  it('a removal whose appearance deletion cannot be persisted fails, keeps the project, and succeeds on retry', async () => {
    // Own project, so this case does not depend on what the removal case above left behind.
    const workspace = path.join(tmpDir, 'ws-fail');
    fs.mkdirSync(workspace, { recursive: true });
    projectRegistry.ensureInitialWorkspace(PROJECT_FAIL, WORKSPACE_FAIL, workspace, tmpDir);
    setProjectAppearanceEntry({ projectId: PROJECT_FAIL, color: '#654321', starred: true });
    // Break the store's file: a directory at that path makes the atomic rename fail.
    fs.rmSync(prefsFile, { force: true });
    fs.mkdirSync(prefsFile);
    try {
      const failed = await removeProjectEntry({ projectId: PROJECT_FAIL });
      assert.deepStrictEqual(failed, { status: 'FAILED', projectId: PROJECT_FAIL, reason: 'APPEARANCE_NOT_CLEARED' });
      assert.strictEqual(projectRegistry.getProject(PROJECT_FAIL).state, 'open', 'no record changed on a refused removal');
      assert.strictEqual(projectRegistry.getProject(PROJECT_FAIL).starred, true, 'memory still agrees with what disk would hold');
    } finally {
      fs.rmSync(prefsFile, { recursive: true, force: true });
    }
    const retried = await removeProjectEntry({ projectId: PROJECT_FAIL });
    assert.strictEqual(retried.status, 'REMOVED');
    assert.deepStrictEqual(new ProjectPreferences(prefsFile).get(PROJECT_FAIL), {});
  });
});
