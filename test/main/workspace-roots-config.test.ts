// AUTHORIZED_WORKSPACE_ROOTS are built-in defaults; the data root's workspace-roots.json adds roots
// without a code change. Every entry is validated and a bad one is dropped with a journal line.
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AUTHORIZED_WORKSPACE_ROOTS,
  WORKSPACE_ROOTS_FILE,
  loadConfiguredWorkspaceRoots,
  parseWorkspaceRootsConfig,
  resolveAuthorizedWorkspaceRoots,
  validateAuthorizedWorkspaceRoot,
  validateConfiguredWorkspaceRoot,
} from '../../src/main/browser/workspace-resolver';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

describe('workspace-roots.json', () => {
  let base: string;
  let dataRoot: string;
  let extra: string;
  let outside: string;
  let journal: Array<{ event: string; fields: Record<string, unknown> }>;
  const record = (event: string, fields: Record<string, unknown>): void => {
    journal.push({ event, fields });
  };
  const writeConfig = (content: unknown, bumpSeconds = 0): void => {
    const file = path.join(dataRoot, WORKSPACE_ROOTS_FILE);
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    const when = new Date(Date.now() + bumpSeconds * 1000);
    fs.utimesSync(file, when, when);
  };

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ws-roots-')));
    dataRoot = path.join(base, 'data');
    extra = path.join(base, 'extra-root');
    outside = path.join(base, 'outside');
    for (const dir of [dataRoot, extra, outside, path.join(extra, 'project')]) fs.mkdirSync(dir, { recursive: true });
    journal = [];
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('keeps the built-in roots when the file is absent', () => {
    assert.deepStrictEqual(resolveAuthorizedWorkspaceRoots({ dataRoot, journal: record }), AUTHORIZED_WORKSPACE_ROOTS);
    assert.deepStrictEqual(journal, []);
  });

  it('authorizes a root outside the built-ins once it is listed, and still refuses everything else', () => {
    const previousEnv = process.env.ANTIFAN_DATA_ROOT;
    process.env.ANTIFAN_DATA_ROOT = dataRoot;
    try {
      assert.throws(
        () => validateAuthorizedWorkspaceRoot(path.join(extra, 'project')),
        (err: unknown) => err instanceof CapabilityError && err.code === 'OUTSIDE_WORKSPACE'
      );
      writeConfig([extra]);
      const resolved = validateAuthorizedWorkspaceRoot(path.join(extra, 'project'));
      assert.strictEqual(path.normalize(resolved).toLowerCase(), path.normalize(path.join(extra, 'project')).toLowerCase());
      assert.throws(
        () => validateAuthorizedWorkspaceRoot(outside),
        (err: unknown) => err instanceof CapabilityError && err.code === 'OUTSIDE_WORKSPACE'
      );
    } finally {
      if (previousEnv === undefined) delete process.env.ANTIFAN_DATA_ROOT;
      else process.env.ANTIFAN_DATA_ROOT = previousEnv;
    }
  });

  it('merges configured roots after the built-ins and accepts the { roots } object form', () => {
    writeConfig({ roots: [extra] });
    const merged = resolveAuthorizedWorkspaceRoots({ dataRoot, journal: record });
    assert.deepStrictEqual(merged, [...AUTHORIZED_WORKSPACE_ROOTS, extra]);
  });

  it('ignores relative, "..", UNC, drive-root, missing, file and non-string entries and journals each one', () => {
    const file = path.join(base, 'a-file.txt');
    fs.writeFileSync(file, 'x');
    const traversal = `${extra}${path.sep}project${path.sep}..${path.sep}project`;
    const driveRoot = path.parse(os.tmpdir()).root;
    writeConfig([
      extra,
      'relative\\dir',
      traversal,
      '\\\\server\\share\\dir',
      driveRoot,
      path.join(base, 'missing'),
      file,
      42,
    ]);
    const loaded = loadConfiguredWorkspaceRoots({ dataRoot, journal: record });
    assert.deepStrictEqual(loaded.roots, [extra]);
    assert.strictEqual(loaded.rejected.length, 7);
    const reasons = loaded.rejected.map((r) => r.reason);
    assert.ok(reasons.includes('not an absolute path'));
    assert.ok(reasons.includes('contains a ".." segment'));
    assert.ok(reasons.includes('UNC and device paths are not allowed'));
    assert.ok(reasons.includes('a drive or filesystem root is not allowed'));
    assert.ok(reasons.includes('does not exist'));
    assert.ok(reasons.includes('not a directory'));
    assert.ok(reasons.includes('not a non-empty string'));
    assert.strictEqual(journal.filter((j) => j.event === 'workspaceRoots.entryIgnored').length, 7);
  });

  it('collapses duplicates, case-insensitively on Windows', () => {
    const variant = process.platform === 'win32' ? extra.toUpperCase() : extra;
    const parsed = parseWorkspaceRootsConfig(JSON.stringify([extra, variant, extra]));
    assert.deepStrictEqual(parsed.roots, [extra]);
    assert.deepStrictEqual(parsed.rejected, []);
  });

  it('journals an unreadable file and falls back to the built-ins', () => {
    writeConfig('{ not json');
    assert.deepStrictEqual(resolveAuthorizedWorkspaceRoots({ dataRoot, journal: record }), AUTHORIZED_WORKSPACE_ROOTS);
    assert.deepStrictEqual(journal.map((j) => j.event), ['workspaceRoots.unreadable']);

    journal = [];
    writeConfig({ roots: 'not-an-array' }, 5);
    assert.deepStrictEqual(resolveAuthorizedWorkspaceRoots({ dataRoot, journal: record }), AUTHORIZED_WORKSPACE_ROOTS);
    assert.deepStrictEqual(journal.map((j) => j.event), ['workspaceRoots.unreadable']);
  });

  it('re-reads the file only when its mtime changes', () => {
    writeConfig([path.join(base, 'missing')]);
    loadConfiguredWorkspaceRoots({ dataRoot, journal: record });
    loadConfiguredWorkspaceRoots({ dataRoot, journal: record });
    assert.strictEqual(journal.length, 1, 'an unchanged file is not parsed or journaled again');

    writeConfig([extra], 10);
    assert.deepStrictEqual(loadConfiguredWorkspaceRoots({ dataRoot, journal: record }).roots, [extra]);
    assert.strictEqual(journal.length, 1);
  });

  it('validates one entry at a time', () => {
    assert.deepStrictEqual(validateConfiguredWorkspaceRoot(extra), { ok: true, root: extra });
    assert.strictEqual(validateConfiguredWorkspaceRoot('').ok, false);
    assert.strictEqual(validateConfiguredWorkspaceRoot(undefined).ok, false);
  });
});
