import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOwnerKey,
  resolveProjectContext,
  type ProjectContextPorts,
} from '../../src/main/project/project-context';
import type { WorkspaceCapsule } from '../../src/main/project/workspace-capsule';

const P1 = 'project-00000000-0000-4000-8000-000000000001';
const P2 = 'project-00000000-0000-4000-8000-000000000002';
const P3 = 'project-00000000-0000-4000-8000-000000000003';
const W1 = 'workspace-00000000-0000-4000-8000-000000000001';
const W2 = 'workspace-00000000-0000-4000-8000-000000000002';

function capsule(fields: Partial<WorkspaceCapsule> & { id: string }): WorkspaceCapsule {
  return { name: fields.id, workspacePath: '', ...fields } as unknown as WorkspaceCapsule;
}

interface Fixture {
  capsules?: WorkspaceCapsule[];
  projects?: Record<string, string>;
  workspaces?: Record<string, Array<{ id: string; rootPath: string; state: string }>>;
  terminalOwners?: Record<string, string>;
  terminalCapsules?: Record<string, string>;
  tabCapsules?: Record<string, string>;
}

function ports(f: Fixture): ProjectContextPorts {
  return {
    capsules: () => f.capsules ?? [],
    registry: {
      getProject(id) {
        const name = f.projects?.[id];
        if (name === undefined) throw new Error(`Project not found: ${id}`);
        return { name, state: 'open' };
      },
      listWorkspaces: (id) => f.workspaces?.[id] ?? [],
    },
    terminalOwnerKey: (id) => f.terminalOwners?.[id],
    terminalCapsuleId: (id) => f.terminalCapsules?.[id],
    tabCapsuleId: (id) => f.tabCapsules?.[id],
  };
}

describe('parseOwnerKey', () => {
  it('reads project, unassigned and agent spellings', () => {
    assert.deepEqual(parseOwnerKey(`project:${P1}`), { kind: 'project', projectId: P1 });
    assert.deepEqual(parseOwnerKey('unassigned'), { kind: 'unassigned' });
    assert.equal(parseOwnerKey('agent:tab-9').kind, 'agent');
  });

  it('treats a project prefix with no id as a corrupted claim, never as unassigned', () => {
    assert.deepEqual(parseOwnerKey('project:'), { kind: 'malformed' });
    assert.deepEqual(parseOwnerKey('project:   '), { kind: 'malformed' });
  });

  it('does not throw on non-string input', () => {
    assert.equal(parseOwnerKey(undefined).kind, 'other');
    assert.equal(parseOwnerKey(42).kind, 'other');
  });
});

describe('resolveProjectContext', () => {
  const good = capsule({ id: 'c1', projectId: P1, workspaceId: W1, name: 'Alpha', workspacePath: '/a' });

  it('terminal: the row own capsule wins over its owner key', () => {
    const ctx = resolveProjectContext(
      ports({ capsules: [good], terminalCapsules: { t1: 'c1' }, terminalOwners: { t1: `project:${P2}` } }),
      { kind: 'terminal', sessionId: 't1' },
    );
    assert.equal(ctx.kind, 'project');
    if (ctx.kind !== 'project') return;
    assert.equal(ctx.projectId, P1);
    assert.equal(ctx.source, 'capsule');
    assert.equal(ctx.claim, 'validated');
    assert.equal(ctx.workspaceId, W1);
    assert.equal(ctx.title, 'Alpha');
  });

  it('terminal: a stale capsule id falls back to the owner key', () => {
    const ctx = resolveProjectContext(
      ports({ terminalCapsules: { t1: 'gone' }, terminalOwners: { t1: `project:${P2}` }, projects: { [P2]: 'Beta' } }),
      { kind: 'terminal', sessionId: 't1' },
    );
    assert.equal(ctx.kind, 'project');
    if (ctx.kind !== 'project') return;
    assert.equal(ctx.projectId, P2);
    assert.equal(ctx.source, 'owner-key');
    assert.equal(ctx.title, 'Beta');
    assert.equal(ctx.claim, 'none');
  });

  it('terminal: an unknown session is unresolved, not unassigned', () => {
    assert.deepEqual(
      resolveProjectContext(ports({}), { kind: 'terminal', sessionId: 'nope' }),
      { kind: 'unresolved', reason: 'UNKNOWN_SUBJECT' },
    );
  });

  it('terminal: a malformed project stamp fails closed', () => {
    assert.deepEqual(
      resolveProjectContext(ports({ terminalOwners: { t1: 'project:' } }), { kind: 'terminal', sessionId: 't1' }),
      { kind: 'unresolved', reason: 'MALFORMED_OWNER_KEY' },
    );
  });

  it('owner key: only the sole attached workspace is claimed', () => {
    const one = resolveProjectContext(
      ports({ workspaces: { [P1]: [{ id: W1, rootPath: '/a', state: 'attached' }] } }),
      { kind: 'ownerKey', ownerKey: `project:${P1}` },
    );
    const two = resolveProjectContext(
      ports({
        workspaces: {
          [P1]: [
            { id: W1, rootPath: '/a', state: 'attached' },
            { id: W2, rootPath: '/b', state: 'attached' },
          ],
        },
      }),
      { kind: 'ownerKey', ownerKey: `project:${P1}` },
    );
    assert.equal(one.kind === 'project' ? one.workspaceId : 'not-project', W1);
    assert.equal(two.kind === 'project' ? two.workspaceId : 'not-project', undefined);
  });

  it('two capsules claiming one project report ambiguity and name no capsule', () => {
    const dup = capsule({ id: 'c2', projectId: P1, workspaceId: W2, workspacePath: '/b' });
    const ctx = resolveProjectContext(ports({ capsules: [good, dup] }), { kind: 'projectId', projectId: P1 });
    assert.equal(ctx.kind, 'project');
    if (ctx.kind !== 'project') return;
    assert.equal(ctx.claim, 'ambiguous');
    assert.equal(ctx.capsuleId, undefined);
  });

  it('a capsule with a project but no workspace is an invalid claim', () => {
    const bad = capsule({ id: 'c3', projectId: P3 });
    const ctx = resolveProjectContext(ports({ capsules: [bad] }), { kind: 'projectId', projectId: P3 });
    assert.equal(ctx.kind === 'project' ? ctx.claim : 'not-project', 'invalid');
  });

  it('tab: speaks only through its capsule; missing or stale capsule is refused', () => {
    assert.deepEqual(
      resolveProjectContext(ports({}), { kind: 'tab', tabId: 'x' }),
      { kind: 'unresolved', reason: 'UNKNOWN_SUBJECT' },
    );
    assert.deepEqual(
      resolveProjectContext(ports({ tabCapsules: { x: 'gone' } }), { kind: 'tab', tabId: 'x' }),
      { kind: 'unresolved', reason: 'STALE_CAPSULE' },
    );
    const ok = resolveProjectContext(ports({ capsules: [good], tabCapsules: { x: 'c1' } }), { kind: 'tab', tabId: 'x' });
    assert.equal(ok.kind === 'project' ? ok.projectId : 'not-project', P1);
  });

  it('unassigned and agent owner keys pass through', () => {
    assert.equal(resolveProjectContext(ports({}), { kind: 'ownerKey', ownerKey: 'unassigned' }).kind, 'unassigned');
    assert.equal(resolveProjectContext(ports({}), { kind: 'ownerKey', ownerKey: 'agent:t' }).kind, 'agent');
  });

  it('a blank project id is unresolved', () => {
    assert.equal(resolveProjectContext(ports({}), { kind: 'projectId', projectId: '  ' }).kind, 'unresolved');
  });
});
