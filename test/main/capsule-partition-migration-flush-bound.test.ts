/**
 * Bounded-flush contract for the capsule → profile migration (no Electron).
 *
 * A session `flushStore` promise is a platform call that can answer with
 * NOTHING — a cookie SQLite database another process holds locked leaves it
 * pending forever, no resolution and no rejection. The migration runs inside
 * the startup chain, so awaiting that promise unbounded is a boot hang.
 * These rows pin the bounded contract: silence inside the bound is reported
 * as a failure (typed field + warning), never as a migrated partition.
 */
import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert';
import {
  runCapsuleToProfileMigration,
  type CapsuleMigrationDeps,
} from '../../src/main/browser/capsule-partition-migration';

const FLUSH_BOUND_MS = 60;

function makeDeps(overrides: Partial<CapsuleMigrationDeps> = {}): CapsuleMigrationDeps {
  return {
    listLegacyPartitionKeys: () => ['capsule-a'],
    readCookies: async (partition) =>
      partition === 'persist:capsule-a'
        ? [{ domain: '.example.com', path: '/', secure: true, httpOnly: true, name: 'sid', value: 'x' }]
        : [],
    writeCookie: async () => {},
    flushStore: async () => {},
    ...overrides,
  };
}

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  return { warnings, restore: () => { console.warn = original; } };
}

describe('runCapsuleToProfileMigration flush bound', () => {
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('reports a timed-out flush inside the bound instead of waiting forever', { timeout: 10_000 }, async () => {
    // A promise that never settles: the shape a locked cookie database takes.
    // The bound's guard timer is deliberately unref'd in production, so the test
    // pumps virtual time instead of letting the event loop drain to a dead answer.
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      const deps = makeDeps({ flushStore: () => new Promise<void>(() => {}) });
      const { warnings, restore } = captureWarnings();
      try {
        const pending = runCapsuleToProfileMigration(deps, FLUSH_BOUND_MS);
        await settle();
        mock.timers.tick(FLUSH_BOUND_MS);
        const res = await pending;
        // The migration itself must settle — the boot path is chained on this
        // promise, so reaching this line is the "startup continues" proof.
        assert.deepStrictEqual(res.flushTimedOutPartitions, ['persist:profile-a']);
        assert.strictEqual(res.markerReady, false);
        assert.strictEqual(res.migrated, 0);
        assert.deepStrictEqual(res.legacyPartitions, []);
        // The silent flush is reported, not swallowed: the log names the
        // partition that never answered.
        assert.ok(warnings.some((w) => w.includes('persist:profile-a')));
      } finally {
        restore();
      }
    } finally {
      mock.timers.reset();
    }
  });

  it('treats a flush that resolves only after the bound as timed out', { timeout: 10_000 }, async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      let flushSettled = false;
      const deps = makeDeps({
        flushStore: () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              flushSettled = true;
              resolve();
            }, FLUSH_BOUND_MS * 4);
          }),
      });
      const pending = runCapsuleToProfileMigration(deps, FLUSH_BOUND_MS);
      await settle();
      mock.timers.tick(FLUSH_BOUND_MS);
      const res = await pending;
      // Late answers do not retroactively become durable: the outcome must be
      // the typed timeout, not a success fabricated after the fact.
      assert.deepStrictEqual(res.flushTimedOutPartitions, ['persist:profile-a']);
      assert.strictEqual(res.markerReady, false);
      assert.strictEqual(res.migrated, 0);
      assert.strictEqual(flushSettled, false);
      // Give the late flush room to land; its settlement must stay observed.
      await settle();
      mock.timers.tick(FLUSH_BOUND_MS * 5);
      await settle();
      assert.strictEqual(flushSettled, true);
    } finally {
      mock.timers.reset();
    }
  });

  it('keeps a late flush rejection observed instead of unhandled', { timeout: 10_000 }, async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      const deps = makeDeps({
        flushStore: () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error('flush arrived late')), FLUSH_BOUND_MS * 2);
          }),
      });
      const pending = runCapsuleToProfileMigration(deps, FLUSH_BOUND_MS);
      await settle();
      mock.timers.tick(FLUSH_BOUND_MS);
      const res = await pending;
      assert.deepStrictEqual(res.flushTimedOutPartitions, ['persist:profile-a']);
      assert.strictEqual(res.markerReady, false);
      // node --test fails the run on any unhandled rejection; reaching the end
      // after the late rejection fires is the proof it stayed observed.
      await settle();
      mock.timers.tick(FLUSH_BOUND_MS * 4);
      await settle();
    } finally {
      mock.timers.reset();
    }
  });

  it('counts the partition as migrated when the flush resolves', { timeout: 10_000 }, async () => {
    const deps = makeDeps();
    const res = await runCapsuleToProfileMigration(deps, FLUSH_BOUND_MS);
    assert.strictEqual(res.migrated, 1);
    assert.deepStrictEqual(res.legacyPartitions, ['persist:capsule-a']);
    assert.strictEqual(res.markerReady, true);
    assert.deepStrictEqual(res.flushTimedOutPartitions, []);
  });

  it('keeps flush rejection on the existing failure path', { timeout: 10_000 }, async () => {
    const deps = makeDeps({ flushStore: async () => { throw new Error('flush failed'); } });
    const res = await runCapsuleToProfileMigration(deps, FLUSH_BOUND_MS);
    assert.strictEqual(res.markerReady, false);
    assert.strictEqual(res.migrated, 0);
    // A rejection is an answer, not silence: it is not a timeout.
    assert.deepStrictEqual(res.flushTimedOutPartitions, []);
  });
});
