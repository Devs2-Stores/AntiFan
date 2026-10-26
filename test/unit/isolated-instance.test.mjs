// isolated-instance.test.mjs — the throwaway world a probe boots the main process in. Its one job
// is that nothing a probe does can reach the developer's real profile, data root or capsules, even
// when the probe was started from an AntiFan terminal that exports its own ANTIFAN_* values.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createIsolatedInstance } = require('../../scripts/lib/isolated-instance.cjs');

const PROJECTS = [
  { projectId: 'project-a', workspaceId: 'workspace-a', capsuleId: 'capsule-a', name: 'Alpha', dir: 'alpha' },
  { projectId: 'project-b', workspaceId: 'workspace-b', capsuleId: 'capsule-b', name: 'Beta', dir: 'beta' },
];

function create(overrides = {}, env = {}) {
  const instance = createIsolatedInstance({
    prefix: 'antifan-isolated-test-',
    projects: PROJECTS,
    bridgePortBase: 22000,
    bridgePortSpan: 50,
    env,
    ...overrides,
  });
  return { instance, env };
}

test('pins every storage variable inside the temp root, overriding inherited live values', (t) => {
  const { instance, env } = create({}, {
    ANTIFAN_DATA_ROOT: 'E:\\Work\\.antifan-data',
    ANTIFAN_CONFIG_DIR: 'E:\\Work\\.antifan-data\\config',
    ANTIFAN_USER_DATA: 'E:\\live\\Profile',
    ANTIFAN_USER_DATA_DIR: 'E:\\live\\Profile',
    ANTIFAN_USE_TERMINAL_DAEMON: '1',
    ANTIFAN_BRIDGE_PORT: '20130',
  });
  t.after(() => instance.dispose());

  const inside = (value) => path.relative(instance.tempRoot, value).startsWith('..') === false;
  for (const name of ['ANTIFAN_DATA_ROOT', 'ANTIFAN_CONFIG_DIR', 'ANTIFAN_USER_DATA', 'ANTIFAN_USER_DATA_DIR']) {
    assert.ok(inside(env[name]), `${name} (${env[name]}) must live inside ${instance.tempRoot}`);
  }
  assert.equal(env.ANTIFAN_USE_TERMINAL_DAEMON, '0', 'the detached daemon outlives the probe, so it is off by default');
  assert.notEqual(env.ANTIFAN_BRIDGE_PORT, '20130', 'the live bridge port is never reused');
  assert.equal(env.ANTIFAN_BRIDGE_PORT, String(22000 + (process.pid % 50)));
  assert.equal(instance.bridgePort, Number(env.ANTIFAN_BRIDGE_PORT));
  assert.equal(env.ANTIFAN_PROJECT_ID, 'project-a', 'the first project is the boot project');
  assert.equal(env.ANTIFAN_WORKSPACE_ID, 'workspace-a');
  assert.equal(env.ANTIFAN_WORKSPACE_ROOT, undefined, 'the workspace root is only pinned on request');
});

test('seeds a capsule registry with one entry per project, each folder present', (t) => {
  const { instance } = create();
  t.after(() => instance.dispose());

  const registry = JSON.parse(fs.readFileSync(path.join(instance.configDir, 'workspace-capsules.json'), 'utf8'));
  assert.equal(registry.activeCapsuleId, 'capsule-a');
  assert.deepEqual(registry.capsules.map((entry) => entry.projectId), ['project-a', 'project-b']);
  for (const entry of registry.capsules) {
    assert.equal(entry.migrationMarker, 'explicit');
    assert.ok(fs.statSync(entry.workspacePath).isDirectory(), `${entry.workspacePath} exists`);
    assert.ok(entry.workspacePath.startsWith(instance.tempRoot));
  }
  assert.deepEqual(instance.projects.map((project) => path.basename(project.path)), ['alpha', 'beta']);
  assert.equal(instance.projects[0].name, 'Alpha');
  assert.equal('dir' in instance.projects[0], false, 'the folder name is replaced by the resolved path');
});

test('exports the boot project folder as the workspace root when asked, and routes the daemon only when asked', (t) => {
  const { instance, env } = create({ pinWorkspaceRoot: true, terminalDaemon: true });
  t.after(() => instance.dispose());

  assert.equal(env.ANTIFAN_WORKSPACE_ROOT, instance.projects[0].path);
  assert.equal(env.ANTIFAN_USE_TERMINAL_DAEMON, '1');
});

test('dispose removes the whole world and is safe to call twice', () => {
  const { instance } = create();
  assert.ok(fs.existsSync(instance.tempRoot));
  instance.dispose();
  assert.equal(fs.existsSync(instance.tempRoot), false);
  assert.doesNotThrow(() => instance.dispose());
});

test('refuses incomplete input before it creates anything', () => {
  assert.throws(() => createIsolatedInstance({ prefix: '', projects: PROJECTS, bridgePortBase: 1, bridgePortSpan: 1, env: {} }), /prefix/);
  assert.throws(() => createIsolatedInstance({ prefix: 'x-', projects: [], bridgePortBase: 1, bridgePortSpan: 1, env: {} }), /project/);
  assert.throws(() => createIsolatedInstance({ prefix: 'x-', projects: PROJECTS, bridgePortBase: 1, bridgePortSpan: 0, env: {} }), /bridgePort/);
  assert.throws(
    () => createIsolatedInstance({ prefix: 'x-', projects: [{ ...PROJECTS[0], capsuleId: '' }], bridgePortBase: 1, bridgePortSpan: 1, env: {} }),
    /project\.capsuleId/,
  );
});
