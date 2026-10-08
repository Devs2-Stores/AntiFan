/**
 * Lifecycle journal write contract.
 *
 * Runtime events (the 5-second heartbeat among them) must never block the main thread:
 * they are queued and appended off-thread in arrival order. Exit-path events are the
 * exception - nothing asynchronous is guaranteed to run once the process is leaving -
 * so a `sync` record flushes the queue and itself with blocking writes before returning.
 * The runtime dir is pinned to a scratch directory BEFORE the module is imported, because
 * the journal resolves its file once on first use.
 */
import { after, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-lifecycle-log-'));
process.env.ANTIFAN_RUNTIME_DIR = runtimeDir;

import {
  MAX_LOG_BYTES,
  getLifecycleLogPath,
  installExitInterceptor,
  lifecycleLogDrained,
  recordLifecycleEvent,
} from '../../src/main/diagnostics/main-lifecycle-log';

function readEvents(): string[] {
  const file = getLifecycleLogPath();
  assert.ok(file, 'journal path must resolve under the pinned runtime dir');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => String((JSON.parse(line) as { event: string }).event));
}

describe('lifecycle journal writes', () => {
  it('queues runtime events off the main thread and lands them in arrival order', async () => {
    recordLifecycleEvent('heartbeat', { n: 1 });
    recordLifecycleEvent('heartbeat', { n: 2 });
    recordLifecycleEvent('tab.opened');
    assert.deepEqual(readEvents(), [], 'a runtime record returns before any byte reaches disk');

    await lifecycleLogDrained();
    assert.deepEqual(readEvents(), ['heartbeat', 'heartbeat', 'tab.opened']);
  });

  it('a sync exit record flushes everything queued before it, then itself, before returning', () => {
    const before = readEvents().length;
    recordLifecycleEvent('shutdown.step.begin', { step: 'flush' });
    recordLifecycleEvent('shutdown.step.done', { step: 'flush' });
    recordLifecycleEvent('process.exit', { code: 0 }, { sync: true });

    const landed = readEvents().slice(before);
    assert.deepEqual(landed, ['shutdown.step.begin', 'shutdown.step.done', 'process.exit']);
  });

  it('the exit interceptor journals synchronously so the record survives the exit it wraps', async () => {
    await lifecycleLogDrained();
    const before = readEvents().length;
    const exits: number[] = [];
    const target = { exit: (code?: number) => { exits.push(code ?? 0); }, quit: () => undefined };
    const proc = { exit: (_code?: number) => undefined };
    installExitInterceptor(target, proc);

    recordLifecycleEvent('last.heartbeat');
    target.exit(3);

    assert.deepEqual(exits, [3], 'the wrapped exit still runs');
    assert.deepEqual(readEvents().slice(before), ['last.heartbeat', 'app.exit'], 'both rows are on disk when exit returns');
  });

  it('rotates main.log to main.log.1 when size exceeds MAX_LOG_BYTES during active async drain without losing lines or throwing EBUSY', async () => {
    await lifecycleLogDrained();

    const mainLog = getLifecycleLogPath();
    assert.ok(mainLog, 'main.log path must resolve');
    const mainLog1 = path.join(path.dirname(mainLog), 'main.log.1');

    // 55 records of ~41 KB payload each ≈ 2.3 MB total, safely exceeding MAX_LOG_BYTES (2 MB)
    const totalRecords = 55;
    const padding = 'x'.repeat(40 * 1024);

    for (let i = 0; i < totalRecords; i++) {
      recordLifecycleEvent('rotation.test', { seq: i, padding });
    }

    await lifecycleLogDrained();

    assert.ok(fs.existsSync(mainLog), 'main.log must exist');
    assert.ok(fs.existsSync(mainLog1), 'main.log.1 must exist after exceeding MAX_LOG_BYTES');

    const parseTestRecords = (filePath: string): Array<{ seq: number }> => {
      if (!fs.existsSync(filePath)) return [];
      return fs
        .readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; seq: number })
        .filter((rec) => rec.event === 'rotation.test');
    };

    const recordsOld = parseTestRecords(mainLog1);
    const recordsNew = parseTestRecords(mainLog);

    assert.ok(recordsOld.length > 0, 'main.log.1 must contain pre-rotation entries');
    assert.ok(recordsNew.length > 0, 'main.log must contain post-rotation entries');
    assert.strictEqual(
      recordsOld.length + recordsNew.length,
      totalRecords,
      'all queued records must be preserved across rotation with zero lost lines'
    );

    // Verify ordering and absence of inversion
    const allSeq = [...recordsOld.map((r) => r.seq), ...recordsNew.map((r) => r.seq)];
    for (let i = 0; i < totalRecords; i++) {
      assert.strictEqual(allSeq[i], i, `record at index ${i} must match seq ${i} without inversion`);
    }

    const lastOldSeq = recordsOld[recordsOld.length - 1]!.seq;
    const firstNewSeq = recordsNew[0]!.seq;
    assert.strictEqual(firstNewSeq, lastOldSeq + 1, 'post-rotation entries must immediately succeed pre-rotation entries');
  });

  after(async () => {
    await lifecycleLogDrained();
    try {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    } catch {}
  });
});
