import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const agent = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'antifan-agent.cjs'));

function configDirWith(capsules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-project-selector-'));
  fs.writeFileSync(path.join(dir, 'workspace-capsules.json'), JSON.stringify({ version: 1, capsules }));
  return dir;
}

const CAPSULES = [
  { id: 'capsule-default', name: 'Default Workspace', workspacePath: 'E:\\Work' },
  { id: 'capsule-1', name: 'S2 Spa', workspacePath: 'E:\\Work\\devs2\\S2 Spa', projectId: 'project-aaa' },
  { id: 'capsule-2', name: 'S2 Spa', workspacePath: 'E:\\Work\\devs2\\Haravan\\S2 Spa', projectId: 'project-bbb' },
  { id: 'capsule-3', name: 'Lux Wine', workspacePath: 'E:\\Work\\devs2\\Lux Wine', projectId: 'project-ccc' },
  { id: 'capsule-4', name: 'Lux Wine', workspacePath: 'E:\\Work\\devs2\\Lux Wine\\copy', projectId: 'project-ccc' },
];

test('--project is parsed in both spellings and kept out of the wrapped command', () => {
  assert.deepEqual(agent.parseLauncherArgs(['--project=Lux Wine', 'omp', '-x']), { tabId: undefined, project: 'Lux Wine', commandArgs: ['omp', '-x'] });
  assert.deepEqual(agent.parseLauncherArgs(['--project', 'project-ccc', 'claude']), { tabId: undefined, project: 'project-ccc', commandArgs: ['claude'] });
});

test('--project / --tab after the wrapped command belong to that command, in every spelling', () => {
  assert.deepEqual(agent.parseLauncherArgs(['npx', 'playwright', 'test', '--project=chromium']), { tabId: undefined, project: undefined, commandArgs: ['npx', 'playwright', 'test', '--project=chromium'] });
  assert.deepEqual(agent.parseLauncherArgs(['tsc', '--project', 'x']), { tabId: undefined, project: undefined, commandArgs: ['tsc', '--project', 'x'] });
  assert.deepEqual(agent.parseLauncherArgs(['tool', '--tab=t1', '-t', 'x', '--project=']), { tabId: undefined, project: undefined, commandArgs: ['tool', '--tab=t1', '-t', 'x', '--project='] });
  assert.deepEqual(agent.parseLauncherArgs(['--project=Lux Wine', 'npx', 'playwright', 'test', '--project=chromium']), { tabId: undefined, project: 'Lux Wine', commandArgs: ['npx', 'playwright', 'test', '--project=chromium'] });
  assert.deepEqual(agent.parseLauncherArgs(['-t', 'tab-7', 'tsc', '--project', 'x']), { tabId: 'tab-7', project: undefined, commandArgs: ['tsc', '--project', 'x'] });
});

test('--project needs a value and cannot be combined with --tab', () => {
  assert.throws(() => agent.parseLauncherArgs(['--project=', 'omp']), /--project requires/);
  assert.throws(() => agent.parseLauncherArgs(['--project']), /--project requires/);
  assert.throws(() => agent.parseLauncherArgs(['--tab=t1', '--project=x', 'omp']), /cannot be combined/);
});

test('an exact project id wins over a name', () => {
  const dir = configDirWith(CAPSULES);
  assert.equal(agent.resolveProjectSelector('project-bbb', [dir]), 'project-bbb');
});

test('a unique name resolves case-insensitively, and capsules of one project do not make it ambiguous', () => {
  const dir = configDirWith(CAPSULES);
  assert.equal(agent.resolveProjectSelector('lux wine', [dir]), 'project-ccc');
});

test('an ambiguous name is an error that lists every candidate project', () => {
  const dir = configDirWith(CAPSULES);
  assert.throws(
    () => agent.resolveProjectSelector('S2 Spa', [dir]),
    (err) => err.code === 'PROJECT_AMBIGUOUS' && /project-aaa/.test(err.message) && /project-bbb/.test(err.message) && /Haravan/.test(err.message),
  );
});

test('an unknown selector names the projects that do exist, and a missing registry says where it looked', () => {
  const dir = configDirWith(CAPSULES);
  assert.throws(
    () => agent.resolveProjectSelector('nope', [dir]),
    (err) => err.code === 'PROJECT_NOT_FOUND' && /project-ccc/.test(err.message),
  );
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-project-selector-empty-'));
  assert.throws(
    () => agent.resolveProjectSelector('Lux Wine', [empty]),
    (err) => err.code === 'PROJECT_NOT_FOUND' && /no project registry/.test(err.message) && err.message.includes(empty),
  );
});

test('capsules without a projectId are never offered as projects', () => {
  const dir = configDirWith(CAPSULES);
  assert.throws(() => agent.resolveProjectSelector('Default Workspace', [dir]), (err) => err.code === 'PROJECT_NOT_FOUND');
});

test('the config dirs searched lead with the directory of the bridge file that answered', () => {
  const dirs = agent.projectConfigDirs([{ file: path.join(os.tmpdir(), 'cfg-a', 'bridge-dev.json') }, { source: 'env' }]);
  assert.equal(dirs[0], path.resolve(os.tmpdir(), 'cfg-a'));
});
