import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSpaceTemplate, writeSpaceManifestExclusive, readSpaceManifest } from '../../src/main/project/space-manifest';

describe('buildSpaceTemplate', () => {
  it('produces a manifest the parser accepts, with unique ids and only http(s) tabs', () => {
    const m = buildSpaceTemplate(
      'proj',
      [{ label: 'Agent One', role: 'agent' }, { label: 'Agent One', role: 'sync' }, { label: '!!!' }],
      [{ url: 'https://a.test/' }, { url: 'https://a.test/' }, { url: 'file:///x' }],
    );
    assert.equal(new Set(m.terminals.map((t) => t.id)).size, 3);
    assert.equal(m.terminals[1]?.idlePolicy, 'never');
    assert.equal(m.tabs.length, 1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-tpl-'));
    assert.equal(writeSpaceManifestExclusive(dir, m), 'written');
    const read = readSpaceManifest(dir);
    assert.ok(read.found && read.parse.ok);
  });

  it('never overwrites an existing manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-tpl-'));
    assert.equal(writeSpaceManifestExclusive(dir, buildSpaceTemplate('p', [], [])), 'written');
    const file = path.join(dir, '.antifan', 'space.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(writeSpaceManifestExclusive(dir, buildSpaceTemplate('other', [{ label: 'x' }], [])), 'exists');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});
