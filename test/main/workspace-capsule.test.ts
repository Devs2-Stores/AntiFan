import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceCapsuleManager } from '../../src/main/project/workspace-capsule';

describe('WorkspaceCapsuleManager', () => {
  it('persists capsule state and restores the active capsule', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsules-'));
    const statePath = path.join(root, 'capsules.json');
    const first = new WorkspaceCapsuleManager({ filePath: statePath, idFactory: () => 'one', now: () => 100 });
    const capsule = first.create('Theme QA', path.join(root, 'workspace'), { appZoomFactor: 1.1, sidebarWidth: 420 });
    first.updateState(capsule.id, { terminalTabs: [{ id: 'terminal-1', name: 'Terminal 1', cwd: capsule.workspacePath, splitRatio: 0.65 }] });
    const second = new WorkspaceCapsuleManager({ filePath: statePath, now: () => 200 });
    assert.equal(second.getActive()?.name, 'Theme QA');
    assert.equal(second.getActive()?.state.appZoomFactor, 1.1);
    assert.equal(second.getActive()?.state.terminalTabs[0]?.splitRatio, 0.65);
    assert.equal(second.getActive()?.state.sidebarWidth, 420);
  });

  it('switches capsules without cross-contaminating state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsules-'));
    const manager = new WorkspaceCapsuleManager({ filePath: path.join(root, 'capsules.json'), idFactory: (() => { let n = 0; return () => String(++n); })() });
    const first = manager.create('One', path.join(root, 'one'), { sidebarWidth: 300 });
    const second = manager.create('Two', path.join(root, 'two'), { sidebarWidth: 450 });
    assert.equal(manager.switchTo(second.id).workspacePath, path.join(root, 'two'));
    assert.equal(manager.getActive()?.state.sidebarWidth, 450);
    assert.equal(manager.get(first.id).state.sidebarWidth, 300);
  });

  it('defaults sidebarOpen to false and preserves user sidebar state across updates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsules-'));
    const manager = new WorkspaceCapsuleManager({ filePath: path.join(root, 'capsules.json') });
    const capsule = manager.create('Default WS', path.join(root, 'default'));
    assert.strictEqual(capsule.state.sidebarOpen, false);

    manager.updateState(capsule.id, { sidebarOpen: false });
    assert.strictEqual(manager.get(capsule.id).state.sidebarOpen, false);

    const opened = manager.create('Explicit Open', path.join(root, 'open'), { sidebarOpen: true });
    assert.strictEqual(opened.state.sidebarOpen, true);
  });

  it('lists all capsules and supports creating from folder paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsules-list-'));
    const manager = new WorkspaceCapsuleManager({ filePath: path.join(root, 'capsules.json') });
    manager.create('Workspace A', path.join(root, 'dir-a'));
    manager.create('Workspace B', path.join(root, 'dir-b'));
    const list = manager.list();
    assert.equal(list.length, 2);
    assert.equal(list[0]?.name, 'Workspace A');
    assert.equal(list[1]?.name, 'Workspace B');
  });
});
