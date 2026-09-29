/**
 * The Manager's stored-project inventory: every registry record is reconciled, including
 * closed ones the picker refuses to offer, and a live project is never STALE.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installElectronStub } from '../support/electron-stub';

installElectronStub();

import { projectRegistry, projectStoredStatuses } from '../../src/main/index';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { ProjectPreferences } from '../../src/main/project/project-preferences';

const P_OK = 'project-00000000-0000-4000-8000-0000000000f1';
const W_OK = 'workspace-00000000-0000-4000-8000-0000000000f1';
const P_GONE_CLOSED = 'project-00000000-0000-4000-8000-0000000000f2';
const W_GONE_CLOSED = 'workspace-00000000-0000-4000-8000-0000000000f2';
const P_GONE_LIVE = 'project-00000000-0000-4000-8000-0000000000f3';
const W_GONE_LIVE = 'workspace-00000000-0000-4000-8000-0000000000f3';

let tmpDir = '';

describe('Project stored statuses', () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-stored-'));
    projectRegistry.attachAppearanceStore(new ProjectPreferences(path.join(tmpDir, 'appearance.json')));
    const make = (projectId: string, workspaceId: string, name: string) => {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir, { recursive: true });
      projectRegistry.ensureInitialWorkspace(projectId, workspaceId, dir, tmpDir);
      return dir;
    };
    make(P_OK, W_OK, 'ok');
    fs.rmSync(make(P_GONE_CLOSED, W_GONE_CLOSED, 'gone-closed'), { recursive: true, force: true });
    projectRegistry.closeProject(P_GONE_CLOSED);
    fs.rmSync(make(P_GONE_LIVE, W_GONE_LIVE, 'gone-live'), { recursive: true, force: true });
    const holder = TerminalManager as unknown as { instance?: unknown };
    holder.instance = {
      listSessions: () => [{ id: 's-live', state: 'running' }],
      sessionOwnerKey: (id: string) => (id === 's-live' ? `project:${P_GONE_LIVE}` : undefined),
      sessionCapsuleId: () => undefined,
      closeSession: async () => true,
    };
  });

  after(() => {
    (TerminalManager as unknown as { instance?: unknown }).instance = undefined;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('classifies open-resumable DEAD, closed-and-gone STALE, and live-with-missing-path LIVE', () => {
    const byId = new Map(projectStoredStatuses().map((row) => [row.projectId, row]));
    assert.strictEqual(byId.get(P_OK)?.status, 'DEAD');
    assert.strictEqual(byId.get(P_GONE_CLOSED)?.status, 'STALE');
    assert.strictEqual(byId.get(P_GONE_LIVE)?.status, 'LIVE');
  });

  it('carries saved appearance on stored rows — including closed ones the picker drops', () => {
    projectRegistry.setProjectAppearance(P_GONE_CLOSED, { color: '#ff0055', starred: true });
    const byId = new Map(projectStoredStatuses().map((row) => [row.projectId, row]));
    assert.strictEqual(byId.get(P_GONE_CLOSED)?.color, '#ff0055', 'a STALE row lost its saved colour');
    assert.strictEqual(byId.get(P_GONE_CLOSED)?.starred, true, 'a STALE row lost its star');
    assert.strictEqual(byId.get(P_OK)?.color, undefined, 'a bare row invented a colour');
    projectRegistry.setProjectAppearance(P_GONE_CLOSED, { color: null, starred: false });
  });
});
