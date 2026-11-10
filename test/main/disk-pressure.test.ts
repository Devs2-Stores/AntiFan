/**
 * Disk pressure watch: the alarm must come while a volume still has room to act, must not flap
 * around the line, and must publish exactly the reading shape that processes outside Main read.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DISK_ALARM_FREE_BYTES,
  DISK_CLEAR_FREE_BYTES,
  INITIAL_DISK_PRESSURE,
  boundedDirSize,
  diskPressureStateBody,
  readFreeBytes,
  resolveVolumes,
  startDiskPressureWatch,
  stepDiskPressure,
  type DiskPressureState,
  type StatfsFn,
} from '../../src/main/diagnostics/disk-pressure';

const GIB = 1024 ** 3;

function run(samples: number[]): { state: DiskPressureState; transitions: Array<'alarm' | 'clear' | null> } {
  let state = INITIAL_DISK_PRESSURE;
  const transitions: Array<'alarm' | 'clear' | null> = [];
  for (const free of samples) {
    const step = stepDiskPressure(state, free);
    state = step.state;
    transitions.push(step.transition);
  }
  return { state, transitions };
}

describe('stepDiskPressure', () => {
  it('constants are 5 GiB alarm and 10 GiB clear', () => {
    assert.equal(DISK_ALARM_FREE_BYTES, 5 * GIB);
    assert.equal(DISK_CLEAR_FREE_BYTES, 10 * GIB);
  });

  it('does not alarm on one low sample', () => {
    const { state, transitions } = run([1 * GIB]);
    assert.equal(state.alarmed, false);
    assert.deepEqual(transitions, [null]);
  });

  it('forgets a lone dip: low, healthy, low does not alarm', () => {
    assert.equal(run([1 * GIB, 20 * GIB, 1 * GIB]).state.alarmed, false);
  });

  it('alarms on the second consecutive low sample, once', () => {
    const { state, transitions } = run([1 * GIB, 1 * GIB, 1 * GIB]);
    assert.equal(state.alarmed, true);
    assert.deepEqual(transitions, [null, 'alarm', null]);
  });

  it('stays raised between the alarm and clear lines and clears at 10 GiB', () => {
    const { state, transitions } = run([1 * GIB, 1 * GIB, 6 * GIB, 9.9 * GIB, 10 * GIB]);
    assert.deepEqual(transitions, [null, 'alarm', null, null, 'clear']);
    assert.equal(state.alarmed, false);
  });
});

describe('diskPressureStateBody', () => {
  it('matches the published shape exactly', () => {
    const body = diskPressureStateBody(1234, [
      { path: 'E:\\', freeBytes: 145 * 1024 * 1024, alarmed: true },
      { path: 'C:\\', freeBytes: 30 * GIB, alarmed: false },
    ]);
    assert.deepEqual(JSON.parse(body), {
      schema: 1,
      at: 1234,
      alarmed: true,
      volumes: [
        { path: 'E:\\', freeBytes: 145 * 1024 * 1024, floorBytes: 5 * GIB, clearBytes: 10 * GIB, alarmed: true },
        { path: 'C:\\', freeBytes: 30 * GIB, floorBytes: 5 * GIB, clearBytes: 10 * GIB, alarmed: false },
      ],
    });
  });

  it('is not alarmed when no volume is', () => {
    const parsed = JSON.parse(diskPressureStateBody(1, [{ path: 'C:\\', freeBytes: 50 * GIB, alarmed: false }]));
    assert.equal(parsed.alarmed, false);
  });
});

describe('readFreeBytes', () => {
  it('reads a positive number for the temp dir', async () => {
    const free = await readFreeBytes(os.tmpdir());
    assert.equal(typeof free, 'number');
    assert.ok((free as number) > 0);
  });

  it('resolves a path that does not exist through its nearest existing ancestor', async () => {
    const asked: string[] = [];
    const statfs: StatfsFn = async (dir) => {
      asked.push(dir);
      if (path.resolve(dir) !== path.resolve(os.tmpdir())) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return { bavail: 10, bsize: 4096 };
    };
    const nested = path.join(os.tmpdir(), 'not-yet', 'nested', 'dir');
    assert.equal(await readFreeBytes(nested, statfs), 40960);
    assert.deepEqual(asked.map((d) => path.resolve(d)), [
      path.resolve(nested),
      path.resolve(path.dirname(nested)),
      path.resolve(path.dirname(path.dirname(nested))),
      path.resolve(os.tmpdir()),
    ]);
  });

  it('returns null without throwing when the volume cannot be read', async () => {
    const denied: StatfsFn = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    assert.equal(await readFreeBytes(os.tmpdir(), denied), null);
    const gone: StatfsFn = async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
    assert.equal(await readFreeBytes(path.join(os.tmpdir(), 'x', 'y'), gone), null);
  });
});

describe('resolveVolumes', () => {
  it('yields one entry for two directories on one volume', async () => {
    const volumes = await resolveVolumes([os.tmpdir(), path.join(os.tmpdir(), 'child')]);
    assert.equal(volumes.length, 1);
    assert.equal(volumes[0]?.dir, os.tmpdir());
  });

  it('keeps directories of different volumes apart and skips one whose key cannot be read', async () => {
    const keyOf = async (dir: string): Promise<string> => {
      if (dir === 'bad') throw new Error('unreadable');
      return dir.startsWith('a') ? 'vol-a' : 'vol-b';
    };
    const volumes = await resolveVolumes(['a1', 'bad', 'b1', 'a2'], keyOf);
    assert.deepEqual(volumes.map((v) => v.dir), ['a1', 'b1']);
  });
});

describe('startDiskPressureWatch', () => {
  const keyOf = async (dir: string): Promise<string> => dir;
  const waitFor = async (cond: () => boolean): Promise<void> => {
    const until = Date.now() + 2000;
    while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.ok(cond(), 'condition not reached in time');
  };

  it('alarms once across many low samples, clears once after recovery, skips an unreadable volume, and stops', async () => {
    let free = 1 * GIB;
    let reads = 0;
    const alarms: number[] = [];
    const clears: number[] = [];
    let lastSample: Array<{ path: string; alarmed: boolean }> = [];
    const stop = startDiskPressureWatch({
      dirs: ['full', 'unplugged'],
      keyOf,
      intervalMs: 5,
      readFree: async (dir) => {
        if (dir === 'unplugged') throw new Error('drive gone');
        reads++;
        return free;
      },
      onAlarm: (v) => alarms.push(v.freeBytes),
      onClear: (v) => clears.push(v.freeBytes),
      onSample: (volumes) => { lastSample = volumes.map((v) => ({ path: v.path, alarmed: v.alarmed })); },
    });
    try {
      await waitFor(() => reads >= 8);
      assert.equal(alarms.length, 1);
      assert.equal(clears.length, 0);
      assert.equal(lastSample.length, 1);
      assert.equal(lastSample[0]?.alarmed, true);

      free = 20 * GIB;
      await waitFor(() => clears.length === 1);
      const readsAfterClear = reads;
      await waitFor(() => reads >= readsAfterClear + 5);
      assert.equal(alarms.length, 1);
      assert.equal(clears.length, 1);
      assert.equal(lastSample[0]?.alarmed, false);
    } finally {
      stop();
    }
    const readsAtStop = reads;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(reads, readsAtStop);
  });

  it('a volume whose read never settles does not stop the others from alarming or publishing', async () => {
    let samples = 0;
    const alarms: string[] = [];
    let last: string[] = [];
    const stop = startDiskPressureWatch({
      dirs: ['hung', 'low'],
      keyOf,
      intervalMs: 5,
      readTimeoutMs: 10,
      readFree: (dir) => (dir === 'hung' ? new Promise<number | null>(() => {}) : Promise.resolve(1 * GIB)),
      onAlarm: (v) => alarms.push(v.path),
      onClear: () => {},
      onSample: (volumes) => { samples++; last = volumes.map((v) => v.path); },
    });
    try {
      await waitFor(() => samples >= 3 && alarms.length === 1);
    } finally {
      stop();
    }
    // Labels are drive roots on Windows, so only counts identify the hung volume's absence.
    assert.equal(alarms.length, 1);
    assert.equal(last.length, 1);
  });

  it('does not overlap a sample that is still in flight', async () => {
    let active = 0;
    let maxActive = 0;
    let reads = 0;
    const stop = startDiskPressureWatch({
      dirs: ['v'],
      keyOf,
      intervalMs: 2,
      readFree: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        reads++;
        return 50 * GIB;
      },
      onAlarm: () => {},
      onClear: () => {},
    });
    try {
      await waitFor(() => reads >= 3);
    } finally {
      stop();
    }
    assert.equal(maxActive, 1);
  });
});

describe('boundedDirSize', () => {
  it('sums a tree and reports a capped walk as a lower bound', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-size-'));
    try {
      fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
      fs.writeFileSync(path.join(root, 'one.bin'), Buffer.alloc(100));
      fs.writeFileSync(path.join(root, 'a', 'two.bin'), Buffer.alloc(200));
      fs.writeFileSync(path.join(root, 'a', 'b', 'three.bin'), Buffer.alloc(300));

      assert.deepEqual(await boundedDirSize(root, { maxEntries: 1000, maxMs: 5000 }), { bytes: 600, capped: false });

      const capped = await boundedDirSize(root, { maxEntries: 2, maxMs: 5000 });
      assert.equal(capped.capped, true);
      assert.ok(capped.bytes <= 600);

      assert.deepEqual(await boundedDirSize(path.join(root, 'missing'), { maxEntries: 10, maxMs: 1000 }), { bytes: 0, capped: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
