/**
 * Pure capsule → profile partition migration unit tests (no Electron).
 *
 * Covers the failure accounting the wrapper cannot reach under `node --test`:
 * clean pass, per-cookie failure, per-partition read failure, enumeration
 * failure, flush failure, and the default-partition fallback. Also pins the
 * cookie-set details mapping (domain normalization / url derivation).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  buildCookieSetDetails,
  runCapsuleToProfileMigration,
  type CapsuleMigrationDeps,
  type CapsuleMigrationCookie,
} from '../../src/main/browser/capsule-partition-migration';

function makeDeps(overrides: Partial<CapsuleMigrationDeps> = {}): CapsuleMigrationDeps & { __writeTargets: string[] } {
  const writeTargets: string[] = [];
  const deps: CapsuleMigrationDeps = {
    listLegacyPartitionKeys: () => ['capsule-a', 'capsule-b'],
    readCookies: async (partition) => {
      if (partition === 'persist:capsule-a') {
        return [
          { domain: '.example.com', path: '/', secure: true, httpOnly: true, name: 'sid', value: 'x' },
          { domain: 'plain.test', path: '/sub', secure: false, httpOnly: false, name: 'theme', value: 'dark', sameSite: 'lax', expirationDate: 1234567890 },
        ];
      }
      return [];
    },
    writeCookie: async (target) => {
      writeTargets.push(target);
    },
    flushStore: async () => {},
  };
  return { ...deps, ...overrides, __writeTargets: writeTargets } as CapsuleMigrationDeps & { __writeTargets: string[] };
}

describe('runCapsuleToProfileMigration', () => {
  it('copies cookies from legacy to profile partitions and is marker-ready on clean pass', async () => {
    const deps = makeDeps();
    const res = await runCapsuleToProfileMigration(deps);
    assert.strictEqual(res.migrated, 2);
    assert.deepStrictEqual(res.legacyPartitions, ['persist:capsule-a']);
    assert.strictEqual(res.markerReady, true);
    assert.ok(deps.__writeTargets.every((t) => t === 'persist:profile-a'));
  });

  it('leaves the marker unset when a single cookie write fails (partial copy recorded)', async () => {
    const deps = makeDeps({
      writeCookie: async (target, c) => {
        if (c.name === 'theme') throw new Error('unimportable');
      },
    });
    const res = await runCapsuleToProfileMigration(deps);
    assert.strictEqual(res.migrated, 1);
    assert.strictEqual(res.markerReady, false);
  });

  it('leaves the marker unset when reading a partition fails', async () => {
    const deps = makeDeps({
      readCookies: async (partition) => {
        if (partition === 'persist:capsule-a') throw new Error('corrupt db');
        return [];
      },
    });
    const res = await runCapsuleToProfileMigration(deps);
    assert.strictEqual(res.markerReady, false);
    assert.strictEqual(res.migrated, 0);
  });

  it('leaves the marker unset when the partition enumeration itself fails', async () => {
    const deps = makeDeps({ listLegacyPartitionKeys: () => { throw new Error('readdir failed'); } });
    const res = await runCapsuleToProfileMigration(deps);
    assert.strictEqual(res.markerReady, false);
  });

  it('still attempts the default mapping when enumeration fails (layout fallback)', async () => {
    let readCalls: string[] = [];
    const deps = makeDeps({
      listLegacyPartitionKeys: () => { throw new Error('readdir failed'); },
      readCookies: async (partition) => {
        readCalls.push(partition);
        return [];
      },
    });
    const res = await runCapsuleToProfileMigration(deps);
    assert.deepStrictEqual(readCalls, ['persist:capsule-default']);
    assert.strictEqual(res.markerReady, false);
    assert.strictEqual(res.migrated, 0);
  });

  it('falls back to capsule-default when enumeration finds no keys', async () => {
    const deps = makeDeps({ listLegacyPartitionKeys: () => [] });
    const res = await runCapsuleToProfileMigration(deps);
    assert.strictEqual(res.migrated, 0);
    assert.strictEqual(res.markerReady, true);
  });

  it('leaves the marker unset when the flush fails', async () => {
    const deps = makeDeps({ flushStore: async () => { throw new Error('flush failed'); } });
    const res = await runCapsuleToProfileMigration(deps);
    assert.strictEqual(res.markerReady, false);
  });
});

describe('buildCookieSetDetails', () => {
  it('strips the leading dot from the url host but keeps it on the domain field', () => {
    const c: CapsuleMigrationCookie = { domain: '.example.com', path: '/app', secure: true, httpOnly: false, name: 'sid', value: 'x' };
    const d = buildCookieSetDetails(c);
    assert.strictEqual(d.url, 'https://example.com/app');
    assert.strictEqual(d.domain, '.example.com');
  });

  it('drops a non-dot domain (only dot-prefixed domains are re-attached) and uses http for non-secure cookies', () => {
    const c: CapsuleMigrationCookie = { domain: 'plain.test', path: '/', secure: false, httpOnly: false, name: 'theme', value: 'dark' };
    const d = buildCookieSetDetails(c);
    assert.strictEqual(d.url, 'http://plain.test/');
    assert.strictEqual(d.domain, undefined);
  });

  it('passes through expirationDate and sameSite when present', () => {
    const c: CapsuleMigrationCookie = { domain: 'a.b', path: '/p', secure: true, httpOnly: true, name: 'n', value: 'v', expirationDate: 42, sameSite: 'lax' };
    const d = buildCookieSetDetails(c);
    assert.strictEqual(d.expirationDate, 42);
    assert.strictEqual(d.sameSite, 'lax');
  });
});