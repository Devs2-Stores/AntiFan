import assert from 'node:assert';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneOldCrashDumps } from '../../src/main/diagnostics/crash-dump-retention';

/**
 * Retention runs on every launch, before the window exists, so its contract is "the newest
 * dumps survive and startup never fails here". Each case writes real files: the rule is
 * about what is left on disk, and a mocked fs would only restate the implementation.
 */
describe('Crash dump retention', () => {
  const tempDirs: string[] = [];
  const makeTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-dumps-'));
    tempDirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Writes `name` with an explicit mtime so "newest" is not a race between write calls. */
  const writeDump = (dir: string, name: string, mtimeMs: number): string => {
    const fullPath = path.join(dir, name);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, 'dump');
    const seconds = mtimeMs / 1000;
    fs.utimesSync(fullPath, seconds, seconds);
    return fullPath;
  };

  it('keeps the newest dumps and deletes the older ones', () => {
    const dir = makeTempDir();
    const base = Date.UTC(2026, 8, 16, 10, 0, 0);
    const oldest = writeDump(dir, 'crash-1.dmp', base);
    const second = writeDump(dir, 'crash-2.dmp', base + 1000);
    const third = writeDump(dir, 'crash-3.dmp', base + 2000);
    const fourth = writeDump(dir, 'crash-4.dmp', base + 3000);
    const newest = writeDump(dir, 'crash-5.dmp', base + 4000);

    const unlinked = pruneOldCrashDumps(dir, 3);

    assert.deepStrictEqual(unlinked.sort(), [oldest, second].sort(), 'The two oldest dumps are the ones removed');
    for (const survivor of [third, fourth, newest]) {
      assert.ok(fs.existsSync(survivor), `Retained dump ${path.basename(survivor)} must still exist`);
    }
    for (const removed of [oldest, second]) {
      assert.ok(!fs.existsSync(removed), `Pruned dump ${path.basename(removed)} must be gone`);
    }
  });

  it('leaves dumps alone when the count is already within the retention bound', () => {
    const dir = makeTempDir();
    const base = Date.UTC(2026, 8, 16, 10, 0, 0);
    const dumps = [0, 1, 2].map((i) => writeDump(dir, `crash-${i}.dmp`, base + i * 1000));

    assert.deepStrictEqual(pruneOldCrashDumps(dir, 3), []);

    for (const dump of dumps) {
      assert.ok(fs.existsSync(dump), 'A dump within the bound must not be removed');
    }
  });

  it('prunes dumps in nested report directories and never touches other files', () => {
    const dir = makeTempDir();
    const base = Date.UTC(2026, 8, 16, 10, 0, 0);
    const notes = path.join(dir, 'notes.txt');
    fs.writeFileSync(notes, 'not a dump');
    const oldest = writeDump(dir, 'reports/crash-a.dmp', base);
    const second = writeDump(dir, 'reports/crash-b.dmp', base + 1000);
    const third = writeDump(dir, 'reports/nested/crash-c.dmp', base + 2000);
    const newest = writeDump(dir, 'reports/nested/crash-d.dmp', base + 3000);

    const unlinked = pruneOldCrashDumps(dir, 2);

    assert.deepStrictEqual(unlinked.sort(), [oldest, second].sort(), 'The two oldest dumps are the ones removed');
    for (const removed of [oldest, second]) {
      assert.ok(!fs.existsSync(removed), `Pruned dump ${path.basename(removed)} must be gone`);
    }
    for (const survivor of [third, newest]) {
      assert.ok(fs.existsSync(survivor), `Retained dump ${path.basename(survivor)} must still exist`);
    }
    assert.ok(fs.existsSync(notes), 'A non-dump file must never be removed');
  });

  it('reports nothing to prune when the dump directory does not exist', () => {
    const missing = path.join(os.tmpdir(), 'antifan-dumps-missing', String(Date.now()));
    assert.deepStrictEqual(pruneOldCrashDumps(missing, 3), []);
  });
});
