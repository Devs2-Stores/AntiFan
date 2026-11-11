/**
 * A tabs-file write that fails must leave an attributable row in the lifecycle journal
 * (`tabhost.persistFailed`) instead of a console line that is discarded when the app is
 * launched from Explorer.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { lifecycleLogDrained } from '../../src/main/diagnostics/main-lifecycle-log';

const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-persist-failure-runtime-'));
process.env.ANTIFAN_RUNTIME_DIR = RUNTIME_DIR;

function persistFailedRows(): Array<Record<string, unknown>> {
  const logPath = path.join(RUNTIME_DIR, 'logs', 'main.log');
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"event":"tabhost.persistFailed"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('tabhost.persistFailed journal', () => {
  it('persistSync into an unwritable tabs path journals mode, path and error code', async () => {
    await lifecycleLogDrained();
    const before = persistFailedRows().length;

    // A regular file used as a directory component makes every write below it fail.
    const blocker = path.join(RUNTIME_DIR, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    const tabsPath = path.join(blocker, 'sub', 'tabs.json');

    const host: any = Object.create(NativeTabHost.prototype);
    host.isDisposed = false;
    host.persistTimer = null;
    host.parkedPersistData = { tabs: [] };
    host.getTabsStoragePath = () => tabsPath;
    host.normalizeSavedTabsFileForMerge = () => null;
    host.buildSavedTabsDocument = (_existing: unknown, data: unknown) => ({ version: 1, owners: {}, data });

    host.persistSync();

    await lifecycleLogDrained();
    const rows = persistFailedRows();
    assert.equal(rows.length, before + 1);
    const row = rows[rows.length - 1] as Record<string, unknown>;
    assert.equal(row.mode, 'sync');
    assert.equal(row.filePath, tabsPath);
    const error = row.error as { code?: unknown; message?: unknown };
    assert.equal(typeof error.code, 'string');
    assert.equal(typeof error.message, 'string');
  });
});
