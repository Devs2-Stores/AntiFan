import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWorkspaceFromUrl, hostMatchesProject } from '../../src/main/browser/workspace-resolver';

function makeTempRoots(): { root: string; roots: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-resolver-'));
  const customizes = path.join(root, 'customizes');
  const themes = path.join(root, 'themes');
  const apps = path.join(root, 'apps');
  const mk = (p: string) => fs.mkdirSync(p, { recursive: true });
  mk(path.join(customizes, 'Seahorse2'));
  mk(path.join(customizes, 'Iamhome'));
  mk(path.join(customizes, 'Mnbakery'));
  mk(path.join(customizes, 'CuddlePet'));
  mk(path.join(themes, 'F1GENZ'));
  mk(path.join(apps, 'antifan-browser-desktop'));
  return { root, roots: [customizes, themes, apps] };
}

describe('WorkspaceResolver URL classification', () => {
  it('matches storefront host to project dir with exact name', () => {
    const { roots } = makeTempRoots();
    const ws = resolveWorkspaceFromUrl('https://www.iamhome.vn/pages/shop-by-space', roots);
    assert.ok(ws, 'should resolve iamhome.vn');
    assert.match(ws!, /Iamhome$/);
  });

  it('matches host to project with numeric suffix (Seahorse2 <- seahorse.com.vn)', () => {
    const { roots } = makeTempRoots();
    const ws = resolveWorkspaceFromUrl('https://www.seahorse.com.vn/pages/gallery', roots);
    assert.ok(ws, 'should resolve seahorse.com.vn');
    assert.match(ws!, /Seahorse2$/);
  });

  it('matches Haravan storefront to dashed project name', () => {
    const { roots } = makeTempRoots();
    const ws = resolveWorkspaceFromUrl('https://m-n-bakery.myharavan.com/pages/about', roots);
    assert.ok(ws, 'should resolve m-n-bakery.myharavan.com');
    assert.match(ws!, /Mnbakery$/);
  });

  it('resolves exact over suffix regardless of directory enumeration order', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-resolver-order-'));
    const customizes = path.join(root, 'customizes');
    fs.mkdirSync(path.join(customizes, 'Seahorse2'), { recursive: true });
    fs.mkdirSync(path.join(customizes, 'Seahorse'), { recursive: true });
    const dirs = fs.readdirSync(customizes, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    assert.strictEqual(dirs.length, 2, 'both dirs must exist');
    const ws = resolveWorkspaceFromUrl('https://www.seahorse.com.vn/', [customizes]);
    assert.ok(ws, 'should resolve');
    assert.match(ws!, /Seahorse$/);
  });

  it('returns null for unknown host and non-web URLs', () => {
    const { roots } = makeTempRoots();
    assert.strictEqual(resolveWorkspaceFromUrl('https://google.com', roots), null);
    assert.strictEqual(resolveWorkspaceFromUrl('https://notiamhome.vn', roots), null);
    assert.strictEqual(resolveWorkspaceFromUrl('file:///E:/Work/customizes/Rosemine/docs/preview-spec.html', roots), null);
    assert.strictEqual(resolveWorkspaceFromUrl('', roots), null);
    assert.strictEqual(resolveWorkspaceFromUrl(undefined, roots), null);
  });

  it('hostMatchesProject handles dotted/dashed/numeric project names', () => {
    assert.ok(hostMatchesProject('www.seahorse.com.vn', 'Seahorse2'));
    assert.ok(hostMatchesProject('iamhome.vn', 'Iamhome'));
    assert.ok(hostMatchesProject('m-n-bakery.myharavan.com', 'Mnbakery'));
    assert.ok(!hostMatchesProject('iamhome.vn', 'Seahorse2'));
    assert.ok(!hostMatchesProject('seahorse.com.vn', 'Iamhome'));
  });
});