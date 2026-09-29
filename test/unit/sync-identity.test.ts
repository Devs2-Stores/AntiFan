import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HARAVAN_LOCAL_BINDING_FILE, findSyncDuplicate, syncIdentity } from '../../src/main/project/sync-identity';
import { canonicalFolderKey } from '../../src/main/project/workspace-capsule';

function folderWith(binding?: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sync-id-'));
  if (binding !== undefined) fs.writeFileSync(path.join(folder, HARAVAN_LOCAL_BINDING_FILE), binding, 'utf8');
  return folder;
}

describe('syncIdentity', () => {
  it('keys two folders bound to the same Haravan org and theme identically', () => {
    const binding = JSON.stringify({ org_id: '1000123', theme_id: '1001234', theme_name: 'x', theme_org_id: '1' });
    const a = syncIdentity(folderWith(binding));
    const b = syncIdentity(folderWith(binding));
    assert.deepEqual(a, { kind: 'haravan', key: 'haravan:1000123:1001234' });
    assert.equal(a.key, b.key);
  });

  it('keys the same org with a different theme differently', () => {
    const a = syncIdentity(folderWith(JSON.stringify({ org_id: '1', theme_id: '2' })));
    const b = syncIdentity(folderWith(JSON.stringify({ org_id: '1', theme_id: '3' })));
    assert.notEqual(a.key, b.key);
  });

  it('prefers the Haravan binding over the capsule brief', () => {
    const id = syncIdentity(folderWith(JSON.stringify({ org_id: '1', theme_id: '2' })), { themeId: 'brief-theme' });
    assert.equal(id.kind, 'haravan');
  });

  for (const [label, content] of [
    ['not JSON', '{org_id: 1'],
    ['a JSON array', '[1,2]'],
    ['missing theme_id', JSON.stringify({ org_id: '1' })],
    ['an id with a path separator', JSON.stringify({ org_id: '1', theme_id: '../2' })],
    ['an empty id', JSON.stringify({ org_id: ' ', theme_id: '2' })],
  ] as const) {
    it(`falls back to the brief when the binding file is ${label}`, () => {
      assert.deepEqual(syncIdentity(folderWith(content), { themeId: 'abc_1' }), { kind: 'brief', key: 'brief:abc_1' });
    });
  }

  it('falls back to the canonical folder when no binding and no usable brief exist', () => {
    const folder = folderWith();
    const expected = { kind: 'folder', key: `folder:${canonicalFolderKey(folder)}` };
    assert.deepEqual(syncIdentity(folder), expected);
    assert.deepEqual(syncIdentity(folder, { themeId: 'has space' }), expected);
    assert.deepEqual(syncIdentity(`${folder}${path.sep}`, null), expected);
  });

  it('does not throw for a folder that does not exist', () => {
    const missing = path.join(os.tmpdir(), `antifan-sync-missing-${process.pid}-${Date.now()}`);
    assert.equal(syncIdentity(missing).kind, 'folder');
  });
});

describe('findSyncDuplicate', () => {
  it('finds the live watcher on the same theme from another folder, not the one on another theme', () => {
    const same = folderWith(JSON.stringify({ org_id: '1', theme_id: '2' }));
    const other = folderWith(JSON.stringify({ org_id: '1', theme_id: '3' }));
    const target = syncIdentity(folderWith(JSON.stringify({ org_id: '1', theme_id: '2' })));
    const live = [
      { id: 'terminal-1', label: 'Other · 1', folder: other },
      { id: 'terminal-2', label: 'Same · 1', folder: same },
    ];
    assert.equal(findSyncDuplicate(target, live)?.id, 'terminal-2');
    assert.equal(findSyncDuplicate(target, live, 'terminal-2'), undefined, 'a session never duplicates itself');
  });

  it('reports no duplicate for two unbound folders', () => {
    const target = syncIdentity(folderWith());
    assert.equal(findSyncDuplicate(target, [{ id: 't', label: 'x', folder: folderWith() }]), undefined);
  });
});
