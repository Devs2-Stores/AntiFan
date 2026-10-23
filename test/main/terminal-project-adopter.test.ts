/**
 * Adoption wiring: a terminal that belongs to no project is given one exactly once, from the
 * folder TerminalManager recorded for it, and refused with a typed, actionable error when no
 * project can be chosen. The decision rules live in terminal-project-adoption.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { createTerminalProjectAdopter, type TerminalProjectAdopterDeps } from '../../src/main/project/terminal-project-adopter';

const WORK_ROOT = 'E:\\Work';
const LUX = { projectId: 'project-00000000-0000-4000-8000-0000000000a1', workspacePaths: ['E:\\Work\\themes\\Lux Shoes'] };

function makeAdopter(opts: {
  cwd?: string;
  ownerKeys?: Record<string, string | undefined>;
  projects?: TerminalProjectAdopterDeps['knownProjects'] extends () => infer R ? R : never;
  stampRefuses?: boolean;
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
    workRoot: WORK_ROOT,
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
