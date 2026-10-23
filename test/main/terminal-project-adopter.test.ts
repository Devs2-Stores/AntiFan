/**
 * Adoption wiring: a terminal that belongs to no project is given one exactly once, from the
 * folder TerminalManager recorded for it, and refused with a typed, actionable error when no
 * project can be chosen. The decision rules live in terminal-project-adoption.test.ts.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { createTerminalProjectAdopter, folderHoldsSeveralProjects, type TerminalProjectAdopterDeps } from '../../src/main/project/terminal-project-adopter';

const WORK_ROOT = 'E:\\Work';
const LUX = { projectId: 'project-00000000-0000-4000-8000-0000000000a1', workspacePaths: ['E:\\Work\\themes\\Lux Shoes'] };

function makeAdopter(opts: {
  cwd?: string;
  ownerKeys?: Record<string, string | undefined>;
  projects?: TerminalProjectAdopterDeps['knownProjects'] extends () => infer R ? R : never;
  stampRefuses?: boolean;
  workRoot?: string;
}) {
  const ownerKeys: Record<string, string | undefined> = { ...(opts.ownerKeys ?? {}) };
  const stamps: Array<{ id: string; ownerKey: string; capsuleId: string | undefined }> = [];
  const created: string[] = [];
  const adopt = createTerminalProjectAdopter({
    sessionCwd: () => opts.cwd,
    sessionOwnerKey: (id) => ownerKeys[id],
    knownProjects: () => opts.projects ?? [LUX],
    projectForFolder: (folder) => {
      created.push(folder);
      return { projectId: 'project-00000000-0000-4000-8000-0000000000b2' };
    },
    capsuleIdForProject: (projectId) => `capsule-of-${projectId}`,
    stampOwner: (id, ownerKey, capsuleId) => {
      if (opts.stampRefuses) return false;
      stamps.push({ id, ownerKey, capsuleId });
      ownerKeys[id] = ownerKey;
      return true;
    },
    workRoot: opts.workRoot ?? WORK_ROOT,
    homeDir: 'C:\\Users\\Admin',
  });
  return { adopt, stamps, created };
}

describe('terminal project adopter', () => {
  it('stamps the project that contains the terminal folder, once', async () => {
    const { adopt, stamps, created } = makeAdopter({ cwd: 'E:\\Work\\themes\\Lux Shoes\\Haravan' });
    await adopt('term-1');
    await adopt('term-1');
    assert.deepEqual(stamps, [{ id: 'term-1', ownerKey: `project:${LUX.projectId}`, capsuleId: `capsule-of-${LUX.projectId}` }]);
    assert.deepEqual(created, [], 'a folder inside a known project must not mint a new one');
  });

  it('creates a project for a folder inside the work root that no project contains', async () => {
    const { adopt, stamps, created } = makeAdopter({ cwd: 'E:\\Work\\apps\\Fresh' });
    await adopt('term-2');
    assert.deepEqual(created, ['E:\\Work\\apps\\Fresh']);
    assert.equal(stamps.length, 1);
    assert.match(stamps[0]!.ownerKey, /^project:project-/);
  });

  it('never touches a terminal that already names a project', async () => {
    const { adopt, stamps, created } = makeAdopter({
      cwd: 'E:\\Work\\apps\\Fresh',
      ownerKeys: { 'term-3': `project:${LUX.projectId}` },
    });
    await adopt('term-3');
    assert.deepEqual(stamps, []);
    assert.deepEqual(created, []);
  });

  it('refuses the work root with a typed, actionable error and stamps nothing', async () => {
    const { adopt, stamps } = makeAdopter({ cwd: WORK_ROOT });
    await assert.rejects(() => adopt('term-4'), (err: unknown) => {
      assert.ok(err instanceof CapabilityError);
      assert.equal(err.code, 'TERMINAL_SCOPE_UNRESOLVED');
      const details = err.details as Record<string, unknown>;
      assert.equal(details.reason, 'WORK_ROOT');
      assert.equal(typeof details.recovery, 'string');
      return true;
    });
    assert.deepEqual(stamps, []);
  });

  it('refuses a terminal with no recorded folder instead of guessing one', async () => {
    const { adopt, stamps } = makeAdopter({ cwd: undefined });
    await assert.rejects(() => adopt('term-5'), (err: unknown) => err instanceof CapabilityError && err.code === 'TERMINAL_SCOPE_UNRESOLVED');
    assert.deepEqual(stamps, []);
  });
});

describe('grouping folders on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-adopt-'));
  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const mk = (...parts: string[]): string => {
    const dir = path.join(root, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const touch = (dir: string, rel: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '');
  };
  const adoptFrom = (cwd: string) => makeAdopter({ cwd, workRoot: root, projects: [] });

  it('lets a folder with a project marker of its own become a project even with theme folders below it', async () => {
    const lux = mk('Lux Shoes');
    mk('Lux Shoes', '.antifan');
    touch(mk('Lux Shoes', 'Haravan'), 'layout/theme.liquid');
    touch(mk('Lux Shoes', 'Sapo'), 'layouts/theme.bwt');
    assert.equal(folderHoldsSeveralProjects(lux), false);
    const { adopt, created } = adoptFrom(lux);
    await adopt('term-lux');
    assert.deepEqual(created, [lux]);
  });

  it('refuses a folder whose grandchildren are theme roots, typed and with recovery', async () => {
    const themes = mk('themes');
    touch(mk('themes', 'Acme', 'Haravan'), 'layout/theme.liquid');
    touch(mk('themes', 'Beta', 'Shopify'), 'config/settings_schema.json');
    assert.equal(folderHoldsSeveralProjects(themes), true);
    const { adopt, stamps, created } = adoptFrom(themes);
    await assert.rejects(() => adopt('term-themes'), (err: unknown) => {
      assert.ok(err instanceof CapabilityError);
      assert.equal(err.code, 'TERMINAL_SCOPE_UNRESOLVED');
      const details = err.details as Record<string, unknown>;
      assert.equal(details.reason, 'GROUPING_FOLDER');
      assert.equal(details.folder, themes);
      assert.match(String(details.recovery), /Terminal Manager/);
      return true;
    });
    assert.deepEqual(stamps, []);
    assert.deepEqual(created, []);
  });

  it('refuses a folder whose children are repositories or packages, but not one with a single project', async () => {
    const apps = mk('apps');
    mk('apps', 'one', '.git');
    touch(mk('apps', 'two'), 'package.json');
    mk('apps', 'plain');
    assert.equal(folderHoldsSeveralProjects(apps), true);
    await assert.rejects(() => adoptFrom(apps).adopt('term-apps'), (err: unknown) => err instanceof CapabilityError);

    const tools = mk('tools');
    mk('tools', 'only', '.git');
    mk('tools', 'plain');
    assert.equal(folderHoldsSeveralProjects(tools), false);
  });

  it('creates a project for an empty new folder and for one that does not exist yet', async () => {
    const fresh = mk('Fresh Client');
    const missing = path.join(root, 'Not Created Yet');
    assert.equal(folderHoldsSeveralProjects(fresh), false);
    assert.equal(folderHoldsSeveralProjects(missing), false);
    for (const [index, cwd] of [fresh, missing].entries()) {
      const { adopt, created } = adoptFrom(cwd);
      await adopt(`term-new-${index}`);
      assert.deepEqual(created, [cwd]);
    }
  });

  it('does not count dependency trees, dot-folders, or the insides of a project', () => {
    const mixed = mk('mixed');
    touch(mk('mixed', 'node_modules', 'left-pad'), 'package.json');
    touch(mk('mixed', 'node_modules', 'right-pad'), 'package.json');
    mk('mixed', '.cache', 'one', '.git');
    mk('mixed', '.cache', 'two', '.git');
    mk('mixed', 'app', '.git');
    touch(mk('mixed', 'app', 'pkg-a'), 'package.json');
    touch(mk('mixed', 'app', 'pkg-b'), 'package.json');
    assert.equal(folderHoldsSeveralProjects(mixed), false);
  });

  it('stops reading after a bounded number of folders', () => {
    const wide = mk('wide');
    for (let i = 0; i < 450; i += 1) mk('wide', `a${String(i).padStart(3, '0')}`);
    mk('wide', 'zz-one', '.git');
    mk('wide', 'zz-two', '.git');
    assert.equal(folderHoldsSeveralProjects(wide), false);
  });
});
