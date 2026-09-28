import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findCapsuleByRoot,
  findReusableCapsule,
  WorkspaceCapsuleManager,
  resolveUniqueAffiliationByRoot,
  type WorkspaceCapsule,
} from '../../src/main/project/workspace-capsule';
import { ProjectRegistry } from '../../src/main/project/project-registry';

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

  it('explicit affiliation round-trips through a reopen', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsules-affil-'));
    const statePath = path.join(root, 'capsules.json');
    const projects = new ProjectRegistry();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-proj-'));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-'));
    const project = projects.createProject('Test Project', projectDir);
    const workspace = projects.attachWorkspace(project.id, workspaceDir);

    const manager = new WorkspaceCapsuleManager({
      filePath: statePath,
      affiliationAuthority: { projectRegistry: projects },
      now: () => 1000,
    });
    const capsule = manager.create('Affiliated Capsule', workspaceDir);
    assert.strictEqual(capsule.migrationMarker, 'legacy');
    assert.strictEqual(capsule.projectId, undefined);
    assert.strictEqual(capsule.workspaceId, undefined);

    const affiliated = manager.setAffiliation(capsule.id, {
      projectId: project.id,
      workspaceId: workspace.id,
    });
    assert.strictEqual(affiliated.projectId, project.id);
    assert.strictEqual(affiliated.workspaceId, workspace.id);
    assert.strictEqual(affiliated.migrationMarker, 'explicit');

    // Reopen manager from persisted statePath
    const reopened = new WorkspaceCapsuleManager({
      filePath: statePath,
      affiliationAuthority: { projectRegistry: projects },
      now: () => 2000,
    });
    const loaded = reopened.get(capsule.id);
    assert.strictEqual(loaded.projectId, project.id);
    assert.strictEqual(loaded.workspaceId, workspace.id);
    assert.strictEqual(loaded.migrationMarker, 'explicit');
  });

  it('a version-1 file loads unchanged and gains no invented affiliation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsules-v1-'));
    const statePath = path.join(root, 'capsules.json');
    const wsPath = path.join(root, 'legacy-workspace');
    fs.mkdirSync(wsPath, { recursive: true });

    const v1Data = {
      version: 1,
      activeCapsuleId: 'capsule-v1',
      capsules: [
        {
          id: 'capsule-v1',
          name: 'Legacy Capsule',
          workspacePath: wsPath,
          state: {
            browserTabs: [],
            terminalTabs: [],
            sidebarOpen: false,
            sidebarWidth: 380,
            appZoomFactor: 1,
            devicePresetId: 'responsive',
          },
          createdAt: 100,
          updatedAt: 100,
        },
      ],
      updatedAt: 100,
    };
    fs.writeFileSync(statePath, JSON.stringify(v1Data, null, 2), 'utf8');

    const manager = new WorkspaceCapsuleManager({ filePath: statePath });
    const capsule = manager.get('capsule-v1');

    assert.strictEqual(capsule.name, 'Legacy Capsule');
    assert.strictEqual(capsule.workspacePath, path.resolve(wsPath));
    assert.strictEqual(capsule.projectId, undefined);
    assert.strictEqual(capsule.workspaceId, undefined);
    assert.strictEqual(capsule.migrationMarker, 'legacy');
    assert.strictEqual(manager.getActive()?.id, 'capsule-v1');
  });

  it('a version-1 file re-persists as version 2 idempotently (loading twice does not alter records)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsules-v1-repersist-'));
    const statePath = path.join(root, 'capsules.json');
    const wsPath = path.join(root, 'legacy-workspace');
    fs.mkdirSync(wsPath, { recursive: true });

    const v1Data = {
      version: 1,
      activeCapsuleId: 'capsule-v1',
      capsules: [
        {
          id: 'capsule-v1',
          name: 'Legacy Capsule',
          workspacePath: wsPath,
          state: {
            browserTabs: [],
            terminalTabs: [],
            sidebarOpen: true,
            sidebarWidth: 400,
            appZoomFactor: 1.2,
            devicePresetId: 'desktop',
          },
          createdAt: 500,
          updatedAt: 500,
        },
      ],
      updatedAt: 500,
    };
    fs.writeFileSync(statePath, JSON.stringify(v1Data, null, 2), 'utf8');

    // First load
    const manager1 = new WorkspaceCapsuleManager({ filePath: statePath, now: () => 500 });
    const records1 = manager1.list();
    assert.strictEqual(records1[0]?.projectId, undefined);
    assert.strictEqual(records1[0]?.workspaceId, undefined);

    // Re-persist as version 2 via switchTo
    manager1.switchTo('capsule-v1');

    // Verify on disk version is bumped to 2
    const fileContent = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { version: number; activeCapsuleId: string };
    assert.strictEqual(fileContent.version, 2);
    assert.strictEqual(fileContent.activeCapsuleId, 'capsule-v1');

    // Second load
    const manager2 = new WorkspaceCapsuleManager({ filePath: statePath, now: () => 500 });
    const records2 = manager2.list();

    // Records must be identical
    assert.deepStrictEqual(records2, records1);

    // Re-persist again and load third time to ensure idempotency
    manager2.switchTo('capsule-v1');
    const manager3 = new WorkspaceCapsuleManager({ filePath: statePath, now: () => 500 });
    const records3 = manager3.list();
    assert.deepStrictEqual(records3, records1);
  });

  it('setAffiliation refuses missing authority, missing project, missing workspace, and workspace belonging to another project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsules-refusal-'));
    const statePath = path.join(root, 'capsules.json');
    const projects = new ProjectRegistry();
    const projDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-proj1-'));
    const projDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-proj2-'));
    const wsDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws1-'));
    const wsDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws2-'));

    const project1 = projects.createProject('Project 1', projDir1);
    const project2 = projects.createProject('Project 2', projDir2);
    const workspace1 = projects.attachWorkspace(project1.id, wsDir1);
    const workspace2 = projects.attachWorkspace(project2.id, wsDir2);
    // 1. Missing authority
    const unauthenticatedManager = new WorkspaceCapsuleManager({ filePath: statePath });
    const capsuleNoAuth = unauthenticatedManager.create('Capsule No Auth', wsDir1);
    assert.throws(
      () => unauthenticatedManager.setAffiliation(capsuleNoAuth.id, { projectId: project1.id, workspaceId: workspace1.id }),
      /Affiliation authority is unavailable/,
    );

    // With authority
    const manager = new WorkspaceCapsuleManager({
      filePath: statePath,
      affiliationAuthority: { projectRegistry: projects },
    });
    const capsule = manager.create('Capsule', wsDir1);

    // 2. Missing project
    assert.throws(
      () => manager.setAffiliation(capsule.id, { projectId: 'project-99999999-9999-4999-9999-999999999999', workspaceId: workspace1.id }),
      /Project not found/,
    );

    // 3. Missing workspace
    assert.throws(
      () => manager.setAffiliation(capsule.id, { projectId: project1.id, workspaceId: 'workspace-99999999-9999-4999-9999-999999999999' }),
      /Workspace not found/,
    );

    // 4. Workspace belongs to another project
    assert.throws(
      () => manager.setAffiliation(capsule.id, { projectId: project1.id, workspaceId: workspace2.id }),
      /Workspace does not belong to Project/,
    );
  });

  it('resolveUniqueAffiliationByRoot returns the pair for a unique match, undefined for zero matches, and undefined for two pairs sharing one canonical root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsules-resolve-'));
    const statePath = path.join(root, 'capsules.json');
    const projects = new ProjectRegistry();
    const projDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-proj1-'));
    const projDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-proj2-'));
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-shared-'));
    const uniqueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-unique-'));
    const unmatchedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-unmatched-'));

    const project1 = projects.createProject('Project 1', projDir1);
    const project2 = projects.createProject('Project 2', projDir2);

    // Unique workspace attached only to project 1
    const uniqueWs = projects.attachWorkspace(project1.id, uniqueDir);

    // Shared root attached to both project 1 and project 2
    projects.attachWorkspace(project1.id, sharedDir);
    projects.attachWorkspace(project2.id, sharedDir);

    const manager = new WorkspaceCapsuleManager({
      filePath: statePath,
      affiliationAuthority: { projectRegistry: projects },
    });

    const uniqueCapsule = manager.create('Unique Capsule', uniqueDir);
    const zeroCapsule = manager.create('Zero Capsule', unmatchedDir);
    const ambiguousCapsule = manager.create('Ambiguous Capsule', sharedDir);

    // 1. Unique match returns the pair
    const match = resolveUniqueAffiliationByRoot(uniqueCapsule, projects);
    assert.deepStrictEqual(match, { projectId: project1.id, workspaceId: uniqueWs.id });

    // 2. Zero matches returns undefined
    const zeroMatch = resolveUniqueAffiliationByRoot(zeroCapsule, projects);
    assert.strictEqual(zeroMatch, undefined);

    // 3. Ambiguous matches (2+ pairs sharing root) returns undefined
    const ambiguousMatch = resolveUniqueAffiliationByRoot(ambiguousCapsule, projects);
    assert.strictEqual(ambiguousMatch, undefined);

    // 4. Capsule with explicit affiliation returns its stored ids without querying path matches
    const explicitCapsule = manager.create('Explicit Capsule', unmatchedDir);
    manager.setAffiliation(explicitCapsule.id, { projectId: project1.id, workspaceId: uniqueWs.id });
    const explicitLoaded = manager.get(explicitCapsule.id);
    const explicitMatch = resolveUniqueAffiliationByRoot(explicitLoaded, projects);
    assert.deepStrictEqual(explicitMatch, { projectId: project1.id, workspaceId: uniqueWs.id });
  });

  it('two capsules with different roots never cross-contaminate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsules-cross-'));
    const statePath = path.join(root, 'capsules.json');
    const projects = new ProjectRegistry();
    const projDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-proj1-'));
    const projDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-proj2-'));
    const root1 = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-root1-'));
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-root2-'));

    const project1 = projects.createProject('Project 1', projDir1);
    const project2 = projects.createProject('Project 2', projDir2);
    const ws1 = projects.attachWorkspace(project1.id, root1);
    const ws2 = projects.attachWorkspace(project2.id, root2);

    const manager = new WorkspaceCapsuleManager({
      filePath: statePath,
      affiliationAuthority: { projectRegistry: projects },
    });

    const capsule1 = manager.create('Capsule 1', root1);
    const capsule2 = manager.create('Capsule 2', root2);

    const match1 = resolveUniqueAffiliationByRoot(capsule1, projects);
    const match2 = resolveUniqueAffiliationByRoot(capsule2, projects);

    assert.deepStrictEqual(match1, { projectId: project1.id, workspaceId: ws1.id });
    assert.deepStrictEqual(match2, { projectId: project2.id, workspaceId: ws2.id });
    assert.notDeepStrictEqual(match1, match2);
  });
});

/** A capsule row as `findReusableCapsule` reads it: only the selection fields matter. */
function capsuleFixture(fields: Partial<WorkspaceCapsule> & Pick<WorkspaceCapsule, 'id' | 'workspacePath' | 'updatedAt'>): WorkspaceCapsule {
  return {
    name: fields.id,
    state: {
      browserTabs: [],
      terminalTabs: [],
      sidebarOpen: false,
      sidebarWidth: 380,
      appZoomFactor: 1,
      devicePresetId: 'responsive',
    },
    createdAt: fields.updatedAt,
    migrationMarker: 'legacy',
    ...fields,
  };
}

describe('findReusableCapsule', () => {
  it('adopts the unaffiliated capsule that spells the same root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-reuse-'));
    try {
      const capsule = capsuleFixture({ id: 'capsule-free', workspacePath: dir, updatedAt: 10 });
      assert.strictEqual(findReusableCapsule([capsule], dir, ''), capsule);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never hands an affiliated capsule to another project, whatever the path', () => {
    // An affiliated capsule is that project's durable record; re-pointing it would strand
    // the old project with no way back after the next boot.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-reuse-'));
    try {
      const taken = capsuleFixture({
        id: 'capsule-taken',
        workspacePath: dir,
        updatedAt: 10,
        projectId: 'project-00000000-0000-4000-8000-0000000000aa',
        workspaceId: 'workspace-00000000-0000-4000-8000-0000000000aa',
        migrationMarker: 'explicit',
      });
      assert.strictEqual(findReusableCapsule([taken], dir, ''), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches regardless of path letter case, the way workspace roots compare', () => {
    // Windows does not distinguish `E:\Work` from `e:\work`; a folder the user typed
    // differently must still find the capsule that already owns the directory.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-reuse-case-'));
    try {
      const dir = path.join(base, 'MixedCaseDir');
      fs.mkdirSync(dir);
      const capsule = capsuleFixture({ id: 'capsule-cased', workspacePath: dir, updatedAt: 10 });
      assert.strictEqual(findReusableCapsule([capsule], dir.toLowerCase(), ''), capsule);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('resolves a capsule stored under a junction spelling through the filesystem', () => {
    // A capsule created from a junction or 8.3 name spells the same directory differently;
    // matching by literal path alone would mint a second row for one workspace.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-reuse-target-'));
    const linkBase = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-reuse-link-'));
    const link = path.join(linkBase, 'junction');
    try {
      fs.symlinkSync(target, link, 'junction');
      const capsule = capsuleFixture({ id: 'capsule-junction', workspacePath: link, updatedAt: 10 });
      assert.strictEqual(
        findReusableCapsule([capsule], fs.realpathSync(target), ''),
        capsule,
        'the junction spelling must resolve to the folder the user picked',
      );
    } finally {
      fs.rmSync(linkBase, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('prefers the active capsule over a newer matching one', () => {
    // The user's working context survives being folded into a project, so activity beats
    // recency when several free capsules point at the same folder.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-reuse-'));
    try {
      const older = capsuleFixture({ id: 'capsule-active', workspacePath: dir, updatedAt: 10 });
      const newer = capsuleFixture({ id: 'capsule-newer', workspacePath: dir, updatedAt: 99 });
      assert.strictEqual(findReusableCapsule([older, newer], dir, 'capsule-active'), older);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the most recently touched capsule when none is active', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-reuse-'));
    try {
      const older = capsuleFixture({ id: 'capsule-older', workspacePath: dir, updatedAt: 10 });
      const newer = capsuleFixture({ id: 'capsule-newer', workspacePath: dir, updatedAt: 42 });
      assert.strictEqual(findReusableCapsule([older, newer], dir, ''), newer);
      assert.strictEqual(findReusableCapsule([newer, older], dir, ''), newer, 'order in the store must not decide the pick');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when nothing matches and survives a capsule whose path is gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-reuse-'));
    try {
      const elsewhere = capsuleFixture({ id: 'capsule-elsewhere', workspacePath: dir, updatedAt: 10 });
      const ghost = capsuleFixture({
        id: 'capsule-ghost',
        workspacePath: path.join(dir, 'deleted-long-ago'),
        updatedAt: 10,
      });
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-reuse-other-'));
      try {
        assert.strictEqual(findReusableCapsule([elsewhere], other, ''), null);
        assert.strictEqual(findReusableCapsule([], dir, ''), null);
        // A capsule whose directory vanished must not throw the realpath fallback.
        const miss = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-reuse-miss-'));
        try {
          assert.strictEqual(findReusableCapsule([ghost], miss, ''), null);
        } finally {
          fs.rmSync(miss, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findCapsuleByRoot', () => {
  it('adopts the affiliated capsule that records the folder the shell is being pointed at', () => {
    // The switcher only re-points the shell: it moves no affiliation. Adopting the row that
    // already owns the directory is what keeps a folder at one capsule per path.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-byroot-'));
    try {
      const owned = capsuleFixture({
        id: 'capsule-owned',
        workspacePath: dir,
        updatedAt: 10,
        projectId: 'project-00000000-0000-4000-8000-0000000000bb',
        workspaceId: 'workspace-00000000-0000-4000-8000-0000000000bb',
        migrationMarker: 'explicit',
      });
      assert.strictEqual(findCapsuleByRoot([owned], dir, ''), owned);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the free row when a folder already has both a free and an affiliated capsule', () => {
    // Duplicate rows for one path are what the switcher must stop adding to. The free row is
    // the one a folder open would adopt, so the shell joins that row instead of the project's.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-byroot-'));
    try {
      const owned = capsuleFixture({
        id: 'capsule-owned',
        workspacePath: dir,
        updatedAt: 99,
        projectId: 'project-00000000-0000-4000-8000-0000000000cc',
        workspaceId: 'workspace-00000000-0000-4000-8000-0000000000cc',
        migrationMarker: 'explicit',
      });
      const free = capsuleFixture({ id: 'capsule-free', workspacePath: dir, updatedAt: 10 });
      // Both orders, so neither the store's order nor recency alone decides the pick.
      assert.strictEqual(findCapsuleByRoot([owned, free], dir, ''), free);
      assert.strictEqual(findCapsuleByRoot([free, owned], dir, ''), free);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settles a burst of duplicate rows on the active one, then the newest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-byroot-'));
    try {
      const rows = [
        capsuleFixture({ id: 'capsule-first', workspacePath: dir, updatedAt: 10 }),
        capsuleFixture({ id: 'capsule-last', workspacePath: dir, updatedAt: 40 }),
        capsuleFixture({ id: 'capsule-middle', workspacePath: dir, updatedAt: 25 }),
      ];
      assert.strictEqual(findCapsuleByRoot(rows, dir, 'capsule-middle'), rows[2]);
      assert.strictEqual(findCapsuleByRoot(rows, dir, ''), rows[1]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a folder no capsule records, and ignores rows with no usable path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-byroot-'));
    try {
      const blank = capsuleFixture({ id: 'capsule-blank', workspacePath: '   ', updatedAt: 10 });
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-byroot-other-'));
      try {
        assert.strictEqual(findCapsuleByRoot([blank], dir, ''), null);
        assert.strictEqual(findCapsuleByRoot([], dir, ''), null);
        const elsewhere = capsuleFixture({ id: 'capsule-elsewhere', workspacePath: other, updatedAt: 10 });
        assert.strictEqual(findCapsuleByRoot([elsewhere], dir, ''), null);
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
