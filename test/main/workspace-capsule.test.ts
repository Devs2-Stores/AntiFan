import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalFolderKey,
  findCapsuleByRoot,
  findReusableCapsule,
  WorkspaceCapsuleManager,
  resolveUniqueAffiliationByRoot,
  sanitizeCapsuleBrief,
  type WorkspaceCapsule,
} from '../../src/main/project/workspace-capsule';
import type { CapsuleBrief } from '../../src/shared/contracts.js';
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

  it('brief round-trips through persist and load', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsule-brief-rt-'));
    try {
      const statePath = path.join(root, 'capsules.json');
      const manager = new WorkspaceCapsuleManager({ filePath: statePath });
      const capsule = manager.create('Storefront WS', path.join(root, 'ws'));

      const brief: CapsuleBrief = {
        storefrontUrl: 'https://store.example.com/checkout',
        siteName: 'My Awesome Store',
        themeId: 'theme_12345-v2',
        rules: ['No breaking CSS changes', 'Preserve accessibility tokens'],
      };

      const result = manager.setBrief(capsule.id, brief);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.capsuleId, capsule.id);
      assert.deepStrictEqual(result.brief, brief);
      assert.deepStrictEqual(manager.get(capsule.id).brief, brief);
      assert.deepStrictEqual(manager.getBrief(capsule.id), {
        ok: true,
        capsuleId: capsule.id,
        brief,
      });

      const reloaded = new WorkspaceCapsuleManager({ filePath: statePath });
      assert.deepStrictEqual(reloaded.get(capsule.id).brief, brief);
      assert.deepStrictEqual(reloaded.getBrief(capsule.id), {
        ok: true,
        capsuleId: capsule.id,
        brief,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('setBrief(null) removes the field, bumps updatedAt, and persists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsule-brief-clear-'));
    try {
      const statePath = path.join(root, 'capsules.json');
      let clock = 1000;
      const manager = new WorkspaceCapsuleManager({ filePath: statePath, now: () => clock });
      const capsule = manager.create('WS', path.join(root, 'ws'));

      clock = 2000;
      manager.setBrief(capsule.id, { siteName: 'Initial Store' });
      assert.strictEqual(manager.get(capsule.id).updatedAt, 2000);
      assert.strictEqual(manager.get(capsule.id).brief?.siteName, 'Initial Store');

      clock = 3000;
      const clearResult = manager.setBrief(capsule.id, null);
      assert.strictEqual(clearResult.ok, true);
      assert.strictEqual(clearResult.capsuleId, capsule.id);
      assert.strictEqual(clearResult.brief, null);
      assert.strictEqual(manager.get(capsule.id).updatedAt, 3000);
      assert.strictEqual(manager.get(capsule.id).brief, undefined);
      assert.deepStrictEqual(manager.getBrief(capsule.id), {
        ok: true,
        capsuleId: capsule.id,
        brief: null,
      });

      const reloaded = new WorkspaceCapsuleManager({ filePath: statePath });
      assert.strictEqual(reloaded.get(capsule.id).brief, undefined);
      assert.deepStrictEqual(reloaded.getBrief(capsule.id), {
        ok: true,
        capsuleId: capsule.id,
        brief: null,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('setBrief and getBrief refuse unknown capsule with UNKNOWN_CAPSULE', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsule-brief-unknown-'));
    try {
      const statePath = path.join(root, 'capsules.json');
      const manager = new WorkspaceCapsuleManager({ filePath: statePath });

      const getRes = manager.getBrief('non-existent');
      assert.strictEqual(getRes.ok, false);
      if (!getRes.ok) {
        assert.strictEqual(getRes.reason, 'UNKNOWN_CAPSULE');
      }

      const setRes = manager.setBrief('non-existent', { siteName: 'Ghost' });
      assert.strictEqual(setRes.ok, false);
      if (!setRes.ok) {
        assert.strictEqual(setRes.reason, 'UNKNOWN_CAPSULE');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('enforces bounds on each field and refuses whole write on any invalid field', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsule-brief-bounds-'));
    try {
      const statePath = path.join(root, 'capsules.json');
      const manager = new WorkspaceCapsuleManager({ filePath: statePath });
      const capsule = manager.create('WS', path.join(root, 'ws'));

      const initialBrief: CapsuleBrief = { siteName: 'Original Site' };
      manager.setBrief(capsule.id, initialBrief);

      // (1) storefrontUrl bounds: over 300 chars
      const overlongUrl = 'https://example.com/' + 'a'.repeat(290);
      const resOverlong = manager.setBrief(capsule.id, { storefrontUrl: overlongUrl });
      assert.strictEqual(resOverlong.ok, false);
      if (!resOverlong.ok) assert.strictEqual(resOverlong.reason, 'INVALID_BRIEF');

      // (2) storefrontUrl http->javascript: URL swap
      const resJs = manager.setBrief(capsule.id, { storefrontUrl: 'javascript:alert(1)' });
      assert.strictEqual(resJs.ok, false);
      if (!resJs.ok) assert.strictEqual(resJs.reason, 'INVALID_BRIEF');

      // (3) storefrontUrl ftp scheme
      const resFtp = manager.setBrief(capsule.id, { storefrontUrl: 'ftp://ftp.example.com' });
      assert.strictEqual(resFtp.ok, false);
      if (!resFtp.ok) assert.strictEqual(resFtp.reason, 'INVALID_BRIEF');

      // (4) storefrontUrl non-string
      const resNumUrl = manager.setBrief(capsule.id, { storefrontUrl: 12345 } as unknown as CapsuleBrief);
      assert.strictEqual(resNumUrl.ok, false);
      if (!resNumUrl.ok) assert.strictEqual(resNumUrl.reason, 'INVALID_BRIEF');

      // (5) siteName bounds: over 80 chars
      const resLongSite = manager.setBrief(capsule.id, { siteName: 's'.repeat(81) });
      assert.strictEqual(resLongSite.ok, false);
      if (!resLongSite.ok) assert.strictEqual(resLongSite.reason, 'INVALID_BRIEF');

      // (6) siteName non-string
      const resBoolSite = manager.setBrief(capsule.id, { siteName: true } as unknown as CapsuleBrief);
      assert.strictEqual(resBoolSite.ok, false);
      if (!resBoolSite.ok) assert.strictEqual(resBoolSite.reason, 'INVALID_BRIEF');

      // (7) themeId bounds: over 64 chars
      const resLongTheme = manager.setBrief(capsule.id, { themeId: 't'.repeat(65) });
      assert.strictEqual(resLongTheme.ok, false);
      if (!resLongTheme.ok) assert.strictEqual(resLongTheme.reason, 'INVALID_BRIEF');

      // (8) themeId pattern: spaces, symbols, empty string
      const resSpaceTheme = manager.setBrief(capsule.id, { themeId: 'theme with spaces' });
      assert.strictEqual(resSpaceTheme.ok, false);
      if (!resSpaceTheme.ok) assert.strictEqual(resSpaceTheme.reason, 'INVALID_BRIEF');

      const resSymbolTheme = manager.setBrief(capsule.id, { themeId: 'theme@special!' });
      assert.strictEqual(resSymbolTheme.ok, false);
      if (!resSymbolTheme.ok) assert.strictEqual(resSymbolTheme.reason, 'INVALID_BRIEF');

      const resEmptyTheme = manager.setBrief(capsule.id, { themeId: '' });
      assert.strictEqual(resEmptyTheme.ok, false);
      if (!resEmptyTheme.ok) assert.strictEqual(resEmptyTheme.reason, 'INVALID_BRIEF');

      // (9) themeId non-string
      const resNumTheme = manager.setBrief(capsule.id, { themeId: 999 } as unknown as CapsuleBrief);
      assert.strictEqual(resNumTheme.ok, false);
      if (!resNumTheme.ok) assert.strictEqual(resNumTheme.reason, 'INVALID_BRIEF');

      // (10) rules bounds: >8 entries
      const resTooManyRules = manager.setBrief(capsule.id, { rules: Array(9).fill('rule') });
      assert.strictEqual(resTooManyRules.ok, false);
      if (!resTooManyRules.ok) assert.strictEqual(resTooManyRules.reason, 'INVALID_BRIEF');

      // (11) rules bounds: over-long rules entry (>200 chars)
      const resLongRule = manager.setBrief(capsule.id, { rules: ['r'.repeat(201)] });
      assert.strictEqual(resLongRule.ok, false);
      if (!resLongRule.ok) assert.strictEqual(resLongRule.reason, 'INVALID_BRIEF');

      // (12) rules non-string entry
      const resNonStrRule = manager.setBrief(capsule.id, { rules: ['valid rule', 123] } as unknown as CapsuleBrief);
      assert.strictEqual(resNonStrRule.ok, false);
      if (!resNonStrRule.ok) assert.strictEqual(resNonStrRule.reason, 'INVALID_BRIEF');

      // (13) rules non-array
      const resNotArrRules = manager.setBrief(capsule.id, { rules: 'rule-single' } as unknown as CapsuleBrief);
      assert.strictEqual(resNotArrRules.ok, false);
      if (!resNotArrRules.ok) assert.strictEqual(resNotArrRules.reason, 'INVALID_BRIEF');

      // (14) unknown keys refused
      const resUnknownKey = manager.setBrief(capsule.id, { unknownField: 'rogue' } as unknown as CapsuleBrief);
      assert.strictEqual(resUnknownKey.ok, false);
      if (!resUnknownKey.ok) assert.strictEqual(resUnknownKey.reason, 'INVALID_BRIEF');

      // (15) CRITICAL WRITE REFUSAL: one good field + one bad field refuses the WHOLE write
      const mixedPayload = { siteName: 'Attempted Update', storefrontUrl: 'ftp://unsupported-scheme.com' };
      const resMixed = manager.setBrief(capsule.id, mixedPayload);
      assert.strictEqual(resMixed.ok, false);
      if (!resMixed.ok) assert.strictEqual(resMixed.reason, 'INVALID_BRIEF');

      // Previous brief MUST remain completely untouched (write was refused, not partially applied)
      assert.deepStrictEqual(manager.get(capsule.id).brief, initialBrief);
      assert.strictEqual(manager.get(capsule.id).brief?.siteName, 'Original Site');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('load stays tolerant per field: drops bad fields or corrupt brief while capsule and good fields survive', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capsule-brief-tolerant-'));
    try {
      const statePath = path.join(root, 'capsules.json');
      const now = 5000;

      const fileData = {
        version: 2,
        activeCapsuleId: 'capsule-1',
        updatedAt: now,
        capsules: [
          {
            id: 'capsule-1',
            name: 'Capsule Tolerant Partial',
            workspacePath: path.resolve(root, 'ws1'),
            state: { browserTabs: [], terminalTabs: [], sidebarOpen: false, sidebarWidth: 380, appZoomFactor: 1, devicePresetId: 'responsive' },
            createdAt: now,
            updatedAt: now,
            brief: {
              storefrontUrl: 'https://example.com/' + 'x'.repeat(310),
              siteName: 'Surviving Site Name',
              rules: ['Surviving rule', 'r'.repeat(250)],
            },
          },
          {
            id: 'capsule-2',
            name: 'Capsule Bad Protocol',
            workspacePath: path.resolve(root, 'ws2'),
            state: { browserTabs: [], terminalTabs: [], sidebarOpen: false, sidebarWidth: 380, appZoomFactor: 1, devicePresetId: 'responsive' },
            createdAt: now,
            updatedAt: now,
            brief: {
              storefrontUrl: 'javascript:alert("exploit")',
            },
          },
          {
            id: 'capsule-3',
            name: 'Capsule Corrupt String',
            workspacePath: path.resolve(root, 'ws3'),
            state: { browserTabs: [], terminalTabs: [], sidebarOpen: false, sidebarWidth: 380, appZoomFactor: 1, devicePresetId: 'responsive' },
            createdAt: now,
            updatedAt: now,
            brief: 'malformed string instead of object',
          },
          {
            id: 'capsule-4',
            name: 'Capsule Fully Valid',
            workspacePath: path.resolve(root, 'ws4'),
            state: { browserTabs: [], terminalTabs: [], sidebarOpen: false, sidebarWidth: 380, appZoomFactor: 1, devicePresetId: 'responsive' },
            createdAt: now,
            updatedAt: now,
            brief: {
              storefrontUrl: 'https://myshop.com',
              siteName: 'My Shop',
              themeId: 'theme-42',
              rules: ['Do things right'],
            },
          },
        ],
      };

      fs.writeFileSync(statePath, JSON.stringify(fileData, null, 2), 'utf8');

      const manager = new WorkspaceCapsuleManager({ filePath: statePath });

      assert.strictEqual(manager.list().length, 4);

      const c1 = manager.get('capsule-1');
      assert.strictEqual(c1.name, 'Capsule Tolerant Partial');
      assert.strictEqual(c1.brief?.storefrontUrl, undefined);
      assert.strictEqual(c1.brief?.siteName, 'Surviving Site Name');
      assert.deepStrictEqual(c1.brief?.rules, ['Surviving rule']);

      const c2 = manager.get('capsule-2');
      assert.strictEqual(c2.name, 'Capsule Bad Protocol');
      assert.strictEqual(c2.brief, undefined);

      const c3 = manager.get('capsule-3');
      assert.strictEqual(c3.name, 'Capsule Corrupt String');
      assert.strictEqual(c3.brief, undefined);

      const c4 = manager.get('capsule-4');
      assert.strictEqual(c4.name, 'Capsule Fully Valid');
      assert.strictEqual(c4.brief?.storefrontUrl, 'https://myshop.com');
      assert.strictEqual(c4.brief?.siteName, 'My Shop');
      assert.strictEqual(c4.brief?.themeId, 'theme-42');
      assert.deepStrictEqual(c4.brief?.rules, ['Do things right']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

describe('sanitizeCapsuleBrief', () => {
  it('accepts valid briefs and normalizes fields', () => {
    const input = {
      storefrontUrl: '  https://store.example.com/collection  ',
      siteName: '  Clean Store  ',
      themeId: '  theme-123_prod  ',
      rules: ['  first rule  ', 'second rule'],
    };
    const res = sanitizeCapsuleBrief(input);
    assert.strictEqual(res.ok, true);
    if (res.ok) {
      assert.strictEqual(res.brief.storefrontUrl, 'https://store.example.com/collection');
      assert.strictEqual(res.brief.siteName, 'Clean Store');
      assert.strictEqual(res.brief.themeId, 'theme-123_prod');
      assert.deepStrictEqual(res.brief.rules, ['first rule', 'second rule']);
    }
  });

  it('refuses non-object or array input with INVALID_BRIEF', () => {
    assert.deepStrictEqual(sanitizeCapsuleBrief(null), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief(undefined), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief('string'), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief(123), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief([]), { ok: false, reason: 'INVALID_BRIEF' });
  });

  it('enforces storefrontUrl bounds and http/https protocol', () => {
    assert.strictEqual(sanitizeCapsuleBrief({ storefrontUrl: 'http://localhost:3000' }).ok, true);
    assert.strictEqual(sanitizeCapsuleBrief({ storefrontUrl: 'https://shop.com' }).ok, true);

    assert.deepStrictEqual(sanitizeCapsuleBrief({ storefrontUrl: 'javascript:alert(1)' }), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief({ storefrontUrl: 'ftp://ftp.example.com' }), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief({ storefrontUrl: 'file:///etc/passwd' }), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief({ storefrontUrl: 'https://example.com/' + 'a'.repeat(290) }), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief({ storefrontUrl: 42 }), { ok: false, reason: 'INVALID_BRIEF' });
  });

  it('enforces siteName bounds (≤80 chars, rejects non-string)', () => {
    assert.strictEqual(sanitizeCapsuleBrief({ siteName: 'a'.repeat(80) }).ok, true);
    assert.deepStrictEqual(sanitizeCapsuleBrief({ siteName: 'a'.repeat(81) }), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief({ siteName: {} }), { ok: false, reason: 'INVALID_BRIEF' });
  });

  it('enforces themeId bounds (≤64 chars, ^[0-9A-Za-z_-]+$, rejects spaces/specials/non-string)', () => {
    assert.strictEqual(sanitizeCapsuleBrief({ themeId: 'a'.repeat(64) }).ok, true);
    assert.deepStrictEqual(sanitizeCapsuleBrief({ themeId: 'a'.repeat(65) }), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief({ themeId: 'theme with spaces' }), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief({ themeId: 'theme$special' }), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief({ themeId: '' }), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief({ themeId: 10 }), { ok: false, reason: 'INVALID_BRIEF' });
  });

  it('enforces rules bounds (≤8 entries each ≤200 chars, rejects over-long, non-string, non-array)', () => {
    assert.strictEqual(sanitizeCapsuleBrief({ rules: Array(8).fill('ok rule') }).ok, true);
    assert.deepStrictEqual(sanitizeCapsuleBrief({ rules: Array(9).fill('too many') }), { ok: false, reason: 'INVALID_BRIEF' });
    assert.strictEqual(sanitizeCapsuleBrief({ rules: ['r'.repeat(200)] }).ok, true);
    assert.deepStrictEqual(sanitizeCapsuleBrief({ rules: ['r'.repeat(201)] }), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief({ rules: ['ok', 123] }), { ok: false, reason: 'INVALID_BRIEF' });
    assert.deepStrictEqual(sanitizeCapsuleBrief({ rules: 'not-array' }), { ok: false, reason: 'INVALID_BRIEF' });
  });

  it('refuses unknown keys with INVALID_BRIEF', () => {
    assert.deepStrictEqual(sanitizeCapsuleBrief({ siteName: 'Ok', unexpectedProperty: 123 }), { ok: false, reason: 'INVALID_BRIEF' });
  });
});

describe('canonicalFolderKey', () => {
  it('keys every spelling of one existing folder identically', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-key-')));
    const folder = path.join(root, 'Theme');
    fs.mkdirSync(folder);
    const key = canonicalFolderKey(folder);
    assert.equal(canonicalFolderKey(`${folder}${path.sep}`), key);
    assert.equal(canonicalFolderKey(path.join(folder, 'sub', '..')), key);
    if (process.platform === 'win32') {
      assert.equal(canonicalFolderKey(folder.toUpperCase()), key);
      assert.equal(canonicalFolderKey(folder.replace(/\\/g, '/')), key);
    }
  });

  it('keys two distinct folders differently', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-key-'));
    fs.mkdirSync(path.join(root, 'a'));
    fs.mkdirSync(path.join(root, 'b'));
    assert.notEqual(canonicalFolderKey(path.join(root, 'a')), canonicalFolderKey(path.join(root, 'b')));
  });

  it('falls back to the resolved spelling for a folder that does not exist instead of throwing', () => {
    const missing = path.join(os.tmpdir(), `antifan-missing-${process.pid}-${Date.now()}`, 'x');
    const expected = process.platform === 'win32' ? path.resolve(missing).toLowerCase() : path.resolve(missing);
    assert.equal(canonicalFolderKey(`${missing}${path.sep}`), expected);
  });

  it('lets findCapsuleByRoot match a capsule recorded through a junction', { skip: process.platform !== 'win32' }, () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-key-')));
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link, 'junction');
    const capsule = { id: 'c1', name: 'x', workspacePath: link, updatedAt: 1, state: {} } as unknown as WorkspaceCapsule;
    assert.equal(findCapsuleByRoot([capsule], real, '')?.id, 'c1');
  });
});
