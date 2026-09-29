import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseSpaceManifest,
  readSpaceManifest,
  resolveSpaceTabPath,
  spaceManifestPath,
} from '../../src/main/project/space-manifest';

const parse = (doc: unknown) => parseSpaceManifest(Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc)));
const errorPaths = (doc: unknown): string[] => {
  const result = parse(doc);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.errors.map((e) => e.path);
};

describe('parseSpaceManifest', () => {
  it('accepts the documented example and applies role defaults', () => {
    const result = parse({
      version: 1,
      name: 'Bagamuioto',
      terminals: [
        { id: 'agent', label: 'omp', command: 'omp', role: 'agent' },
        { id: 'sync', label: 'hrv watch', command: 'hrv theme watch', role: 'sync' },
        { id: 'plain' },
      ],
      tabs: [
        { url: 'https://trello.com/b/x', role: 'task', alias: 'Trello' },
        { path: './ref\\index.html', role: 'reference', alias: 'Ref' },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.manifest.terminals.map((t) => [t.id, t.role, t.idlePolicy, t.label]), [
      ['agent', 'agent', 'manual', 'omp'],
      ['sync', 'sync', 'never', 'hrv watch'],
      ['plain', 'shell', 'manual', 'plain'],
    ]);
    assert.deepEqual(result.manifest.tabs[1], { kind: 'path', path: 'ref/index.html', role: 'reference', alias: 'Ref' });
    assert.match(result.hash, /^[0-9a-f]{64}$/);
  });

  it('changes the hash when any byte of the file changes', () => {
    const a = parse({ version: 1, terminals: [{ id: 'a', command: 'omp' }] });
    const b = parse({ version: 1, terminals: [{ id: 'a', command: 'omp ' }] });
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.notEqual(a.hash, b.hash);
  });

  it('reports every invalid field by path instead of stopping at the first', () => {
    assert.deepEqual(errorPaths({
      version: 2,
      terminals: [{ id: 'bad id!' }, { id: 'x', role: 'root' }, { id: 'x' }],
      tabs: [{ url: 'javascript:alert(1)' }],
    }), ['version', 'terminals[0].id', 'terminals[1].role', 'terminals[2].id', 'tabs[0].url']);
  });

  it('refuses a command that would submit more than one line', () => {
    assert.deepEqual(errorPaths({ version: 1, terminals: [{ id: 'a', command: 'omp\r\nrm -rf x' }] }), ['terminals[0].command']);
  });

  it('refuses a sync terminal that could be slept', () => {
    assert.deepEqual(errorPaths({ version: 1, terminals: [{ id: 's', role: 'sync', idlePolicy: 'manual' }] }), ['terminals[0].idlePolicy']);
  });

  for (const url of ['file:///C:/x.html', 'antifan://settings', 'antifan-preview://c/x', 'data:text/html,x', 'about:blank']) {
    it(`refuses the non-web tab url ${url}`, () => {
      assert.deepEqual(errorPaths({ version: 1, tabs: [{ url }] }), ['tabs[0].url']);
    });
  }

  for (const p of ['../secret.html', 'a/../../x', 'C:\\Windows\\win.ini', 'c:x', '\\\\server\\share\\x', '/etc/passwd', '\\\\?\\C:\\x', '.', '']) {
    it(`refuses the escaping tab path ${JSON.stringify(p)}`, () => {
      assert.deepEqual(errorPaths({ version: 1, tabs: [{ path: p }] }), ['tabs[0].path']);
    });
  }

  it('refuses a tab with both or neither of url and path', () => {
    assert.deepEqual(errorPaths({ version: 1, tabs: [{ url: 'https://a.b', path: 'x' }, { alias: 'y' }] }), ['tabs[0]', 'tabs[1]']);
  });

  it('refuses non-object documents and broken JSON without throwing', () => {
    assert.deepEqual(errorPaths('[]'), ['']);
    assert.deepEqual(errorPaths('{"version":1,'), ['']);
    assert.deepEqual(errorPaths('null'), ['']);
  });

  it('accepts a UTF-8 BOM', () => {
    assert.equal(parseSpaceManifest(Buffer.from('\uFEFF{"version":1}', 'utf8')).ok, true);
  });
});

describe('readSpaceManifest', () => {
  it('reports absence distinctly from an invalid file', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-space-'));
    assert.deepEqual(readSpaceManifest(folder), { found: false });
    fs.mkdirSync(path.dirname(spaceManifestPath(folder)));
    fs.writeFileSync(spaceManifestPath(folder), '{');
    const read = readSpaceManifest(folder);
    assert.equal(read.found, true);
    assert.equal(read.found && read.parse.ok, false);
  });
});

describe('resolveSpaceTabPath', () => {
  it('contains existing and not-yet-existing files inside the folder', () => {
    const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-space-')));
    fs.writeFileSync(path.join(folder, 'a.html'), 'x');
    assert.equal(resolveSpaceTabPath(folder, 'a.html'), path.join(folder, 'a.html'));
    assert.equal(resolveSpaceTabPath(folder, 'later/b.html'), path.join(folder, 'later', 'b.html'));
    assert.equal(resolveSpaceTabPath(folder, '..foo.html'), path.join(folder, '..foo.html'));
  });

  it('refuses a link inside the folder that points outside it', { skip: process.platform !== 'win32' }, () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-space-')));
    const folder = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(folder);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'x.html'), 'x');
    fs.symlinkSync(outside, path.join(folder, 'escape'), 'junction');
    assert.equal(resolveSpaceTabPath(folder, 'escape/not-yet.html'), undefined);
    assert.equal(resolveSpaceTabPath(folder, 'escape/x.html'), undefined);
  });
});
