import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HARAVAN_LOCAL_BINDING_FILE, SAPO_LOCAL_BINDING_FILE, findSyncDuplicate, syncIdentity } from '../../src/main/project/sync-identity';
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

describe('sapo sync identity', () => {
  const sapoFolder = (binding: unknown, haravan?: unknown): string => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-sapo-id-'));
    fs.writeFileSync(path.join(folder, SAPO_LOCAL_BINDING_FILE), typeof binding === 'string' ? binding : JSON.stringify(binding), 'utf8');
    if (haravan !== undefined) fs.writeFileSync(path.join(folder, HARAVAN_LOCAL_BINDING_FILE), JSON.stringify(haravan), 'utf8');
    return folder;
  };
  const luxSapo = { store_prefix: 'luxshoes', store_domain: 'luxshoes.mysapo.net', theme_id: 1234, theme_name: 'Lux', theme_role: 'main' };

  it('keys a folder bound by .sapo-cli_local.json as sapo:<store>:<theme>', () => {
    assert.deepEqual(syncIdentity(sapoFolder(luxSapo)), { kind: 'sapo', key: 'sapo:luxshoes:1234' });
  });

  it('names the same store from a prefix or from its domain, in any case and with a scheme', () => {
    const a = syncIdentity(sapoFolder(luxSapo));
    const b = syncIdentity(sapoFolder({ store_domain: 'https://LuxShoes.mysapo.net/admin', theme_id: '1234' }));
    const c = syncIdentity(sapoFolder({ store_prefix: 'LUXSHOES', theme_id: '1234' }));
    assert.equal(b.key, a.key);
    assert.equal(c.key, a.key);
  });

  it('two folders bound to the same Sapo theme are duplicates; another theme or store is not', () => {
    const target = syncIdentity(sapoFolder(luxSapo));
    const live = [
      { id: 'other-theme', label: 'o1', folder: sapoFolder({ ...luxSapo, theme_id: 99 }) },
      { id: 'other-store', label: 'o2', folder: sapoFolder({ ...luxSapo, store_prefix: 'else', store_domain: 'else.mysapo.net' }) },
      { id: 'same', label: 'o3', folder: sapoFolder(luxSapo) },
    ];
    assert.equal(findSyncDuplicate(target, live)?.id, 'same');
    assert.equal(findSyncDuplicate(target, live.slice(0, 2)), undefined);
  });

  it('a Haravan sibling and a Sapo sibling of one project never collide, even with equal theme ids', () => {
    const haravan = syncIdentity(folderWith(JSON.stringify({ org_id: '1000123', theme_id: '1234' })));
    const sapo = syncIdentity(sapoFolder(luxSapo));
    assert.notEqual(haravan.key, sapo.key);
    const live = [{ id: 'sapo-watcher', label: 's', folder: sapoFolder(luxSapo) }];
    assert.equal(findSyncDuplicate(haravan, live), undefined);
  });

  it('prefers the Sapo binding over the capsule brief', () => {
    assert.equal(syncIdentity(sapoFolder(luxSapo), { themeId: 'brief-theme' }).kind, 'sapo');
  });

  for (const [label, content] of [
    ['not JSON', '{store_prefix: x'],
    ['a JSON array', '[1]'],
    ['missing theme_id', JSON.stringify({ store_prefix: 'a' })],
    ['missing the store', JSON.stringify({ theme_id: 5 })],
    ['a store with a path separator', JSON.stringify({ store_prefix: '../a', theme_id: 5 })],
  ] as const) {
    it(`falls back to the brief when the Sapo binding is ${label}`, () => {
      assert.deepEqual(syncIdentity(sapoFolder(content), { themeId: 'abc_1' }), { kind: 'brief', key: 'brief:abc_1' });
    });
  }
});
