/**
 * Legacy capsule → profile partition migration gate.
 *
 * The migration is marker-gated (review finding 5): once the done marker
 * exists, a fresh run returns immediately. With no marker, a clean pass with
 * nothing to copy still writes the marker (0 migrated = processed), while a
 * partial failure leaves it unset for retry — the failure path sets `failed`
 * on both partition-level and cookie-level errors.
 *
 * Runs against the test runner's own userData (an isolated Electron app data
 * dir), never the developer's AntiFan/Chrome data.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';

const MARKER_NAME = 'antifan-migration-capsule-to-profile.done';

async function withTempDataRoot(fn: (dataRoot: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afbmig-'));
  const dataRoot = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataRoot, 'config'), { recursive: true });
  const prevRoot = process.env.ANTIFAN_DATA_ROOT;
  process.env.ANTIFAN_DATA_ROOT = dataRoot;
  try {
    await fn(dataRoot);
  } finally {
    if (prevRoot === undefined) delete process.env.ANTIFAN_DATA_ROOT;
    else process.env.ANTIFAN_DATA_ROOT = prevRoot;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

describe('migrateLegacyCapsuleToProfile', () => {
  it('is marker-gated: with a done marker present it returns immediately (0 migrated)', async () => {
    await withTempDataRoot(async (dataRoot) => {
      fs.writeFileSync(path.join(dataRoot, 'config', MARKER_NAME), JSON.stringify({ version: 1, migrated: 3 }), 'utf8');
      const host = Object.create(NativeTabHost.prototype) as unknown as NativeTabHost;
      const res = await host.migrateLegacyCapsuleToProfile();
      assert.deepStrictEqual(res, { migrated: 0, legacyPartitions: [] });
    });
  });

  // The Electron-dependent branches (clean pass, per-cookie failure,
  // enumeration failure, flush failure, default fallback) are fully covered by
  // the dependency-injected pure function in
  // test/main/capsule-partition-migration-pure.test.ts (no Electron needed).
  // This file asserts the only Electron-free integration branch: the GATE.
});