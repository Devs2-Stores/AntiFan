import { describe, it, before, after, mock } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HistoryManager } from '../../src/main/browser/history-manager';

/** Every debounced flush a case launched, awaitable as real file I/O. */
interface FlushTracker {
  started: Promise<void>[];
  settled(): Promise<void[]>;
  restore(): void;
}

describe('HistoryManager (Intelligent Browsing History & Frecency Search)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-history-test-'));
  const prevConfigDir = process.env.ANTIFAN_CONFIG_DIR;
  const { PERSIST_QUIET_MS: quietMs, PERSIST_CEILING_MS: ceilingMs } = HistoryManager as unknown as {
    PERSIST_QUIET_MS: number;
    PERSIST_CEILING_MS: number;
  };
  /**
   * The persistence cases run the production quiet/ceiling timings on a virtual clock
   * (`setTimeout` and `Date`), so they assert exact flush boundaries instead of sleeping
   * through them. The flush itself is real file I/O: every flush the debounce launches is
   * collected here so a case can await the bytes it started before reading the store.
   */
  const trackFlushes = (mgr: HistoryManager): FlushTracker => {
    const inst = mgr as unknown as { persistAsync: () => Promise<void> };
    const persistAsync = inst.persistAsync;
    const started: Promise<void>[] = [];
    inst.persistAsync = function (this: HistoryManager): Promise<void> {
      const flush = persistAsync.call(this);
      started.push(flush);
      return flush;
    };
    return {
      started,
      settled: () => Promise.all(started),
      restore: () => {
        delete (inst as { persistAsync?: unknown }).persistAsync;
      },
    };
  };
  /** Cancels any real timer an earlier case armed, then hands the clock to the mock. */
  const useVirtualClock = (mgr: HistoryManager): FlushTracker => {
    mgr.persistSync();
    const flushes = trackFlushes(mgr);
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    return flushes;
  };
  const releaseVirtualClock = async (mgr: HistoryManager, flushes: FlushTracker): Promise<void> => {
    await flushes.settled().catch(() => {});
    mgr.persistSync();
    mock.timers.reset();
    flushes.restore();
  };

  before(() => {
    process.env.ANTIFAN_CONFIG_DIR = tempDir;
  });

  after(() => {
    if (prevConfigDir !== undefined) {
      process.env.ANTIFAN_CONFIG_DIR = prevConfigDir;
    } else {
      delete process.env.ANTIFAN_CONFIG_DIR;
    }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });
  it('records visits and updates visit count and timestamps', () => {
    const mgr = HistoryManager.getInstance();
    mgr.clearHistory();

    mgr.recordVisit('https://www.facebook.com/groups/haravan', 'Haravan Developer Community');
    mgr.recordVisit('https://www.facebook.com/groups/haravan', 'Haravan Developer Community');
    mgr.recordVisit('https://github.com/facebook/react', 'React - GitHub');
    mgr.recordVisit('https://www.youtube.com/watch?v=123', 'Hà Nhi Live Music');

    const history = mgr.getHistoryItems();
    assert.strictEqual(history.length, 3);

    const fbGroup = history.find(h => h.url === 'https://www.facebook.com/groups/haravan');
    assert.ok(fbGroup);
    assert.strictEqual(fbGroup.visitCount, 2);
    assert.strictEqual(fbGroup.domain, 'www.facebook.com');
  });

  it('updates title when page-title-updated arrives', () => {
    const mgr = HistoryManager.getInstance();
    mgr.recordVisit('https://news.ycombinator.com/', 'Untitled');
    mgr.updateTitle('https://news.ycombinator.com/', 'Hacker News');

    const history = mgr.getHistoryItems();
    const hn = history.find(h => h.url === 'https://news.ycombinator.com/');
    assert.ok(hn);
    assert.strictEqual(hn.title, 'Hacker News');
  });

  it('searches history with multi-term frecency ranking', () => {
    const mgr = HistoryManager.getInstance();
    mgr.clearHistory();

    mgr.recordVisit('https://www.facebook.com/marketplace', 'Facebook Marketplace');
    mgr.recordVisit('https://www.facebook.com/messages/t/12345', 'Trò chuyện Facebook Messenger');
    mgr.recordVisit('https://www.facebook.com/groups/antifan', 'AntiFan Community');
    mgr.recordVisit('https://developer.mozilla.org/en-US/', 'MDN Web Docs');

    // Search "faceb"
    const results = mgr.search('faceb', 5);
    assert.strictEqual(results.length, 3);
    assert.ok(results.every(r => r.url.includes('facebook.com') || r.title.includes('Facebook')));

    // Search multi-term "faceb group"
    const multiResults = mgr.search('faceb group', 5);
    assert.strictEqual(multiResults.length, 1);
    assert.strictEqual(multiResults[0]?.url, 'https://www.facebook.com/groups/antifan');
  });

  it('ignores internal and dangerous schemes from history', () => {
    const mgr = HistoryManager.getInstance();
    mgr.clearHistory();

    mgr.recordVisit('about:blank', 'Blank');
    mgr.recordVisit('devtools://devtools/bundled/inspector.html', 'DevTools');
    mgr.recordVisit('chrome://settings', 'Settings');
    mgr.recordVisit('javascript:void(0)', 'JS');

    const history = mgr.getHistoryItems();
    assert.strictEqual(history.length, 0);
  });

  it('coalesces visit churn into bounded writes instead of rewriting the store per change', async () => {
    // The regression this pins: each `recordVisit`/`updateTitle` armed a 1 s timer that rewrote
    // the entire store synchronously, so a page retitling itself drove a full 3.7 MB
    // stringify+writeFileSync roughly twice a second — 0.84 s of blocked main thread per minute on
    // the measured store, paid by every tab switch and RPC behind it.
    const mgr = HistoryManager.getInstance();
    const flushes = useVirtualClock(mgr);
    try {
      mgr.clearHistory();
      const file = path.join(tempDir, 'browser-history.json');
      const storedCount = (): number => JSON.parse(fs.readFileSync(file, 'utf8')).length;
      // 10 Hz churn that runs 5 s past the ceiling. Every mutation re-arms the quiet period,
      // which never elapses, so the only write during the churn is the one the ceiling forces —
      // not one per change (the old 1 s timer wrote ~35 times here), and not none either.
      const churn = (ceilingMs + 5_000) / 100;
      for (let i = 0; i < churn; i++) {
        mgr.recordVisit(`https://example.com/churn-${i}`, `Churn ${i}`);
        await flushes.settled();
        mock.timers.tick(100);
      }
      assert.strictEqual(flushes.started.length, 1, 'sustained churn is bounded by the ceiling to exactly one write');
      const atCeiling = ceilingMs / 100 + 1;
      assert.strictEqual(storedCount(), atCeiling, 'the ceiling write lands the whole store as of the ceiling');

      // The last mutation re-armed the quiet period 100 ms ago.
      mock.timers.tick(quietMs - 101);
      await flushes.settled();
      assert.strictEqual(flushes.started.length, 1, 'no flush before the quiet period elapses');
      mock.timers.tick(1);
      await flushes.settled();
      assert.strictEqual(flushes.started.length, 2, 'quiescence lands exactly one flush');
      assert.strictEqual(storedCount(), churn, 'a flush writes the whole store, not one batch of it');

      const flushedAt = fs.statSync(file).mtimeMs;
      mock.timers.tick(ceilingMs * 2);
      await flushes.settled();
      assert.strictEqual(flushes.started.length, 2, 'an idle store schedules no further write');
      assert.strictEqual(fs.statSync(file).mtimeMs, flushedAt, 'an idle store is not rewritten');
    } finally {
      await releaseVirtualClock(mgr, flushes);
    }
  });

  it('does not write to disk when title update is unchanged', async () => {
    const mgr = HistoryManager.getInstance();
    const flushes = useVirtualClock(mgr);
    try {
      mgr.clearHistory();
      const file = path.join(tempDir, 'browser-history.json');
      mgr.recordVisit('https://example.com/item', 'Sample Title');
      mock.timers.tick(quietMs);
      await flushes.settled();
      assert.strictEqual(flushes.started.length, 1, 'the visit flushes once the quiet period elapses');
      const initialContent = fs.readFileSync(file, 'utf8');
      assert.ok(initialContent.includes('Sample Title'), 'initial visit must flush to disk');
      const initialMtime = fs.statSync(file).mtimeMs;

      for (let i = 0; i < 5; i++) {
        mgr.updateTitle('https://example.com/item', 'Sample Title');
        mgr.updateTitle('https://example.com/item', '  Sample Title  ');
        mock.timers.tick(25);
      }
      mock.timers.tick(ceilingMs + quietMs);
      await flushes.settled();

      assert.strictEqual(flushes.started.length, 1, 'unchanged title updates must not trigger disk writes');
      assert.strictEqual(fs.statSync(file).mtimeMs, initialMtime, 'file mtime must not change');
      assert.strictEqual(fs.readFileSync(file, 'utf8'), initialContent, 'file content must remain unchanged');
    } finally {
      await releaseVirtualClock(mgr, flushes);
    }
  });

  it('debounces a subsequent mutation after persistSync instead of flushing immediately', async () => {
    const mgr = HistoryManager.getInstance();
    const flushes = useVirtualClock(mgr);
    try {
      mgr.clearHistory();
      const file = path.join(tempDir, 'browser-history.json');

      mgr.recordVisit('https://example.com/initial', 'Initial Visit');
      mock.timers.tick(quietMs);
      await flushes.settled();
      // Idle past the ceiling, so a ceiling window left armed by the earlier flush would
      // already be due when the next mutation arrives.
      mock.timers.tick(ceilingMs);

      mgr.persistSync();
      const syncMtime = fs.statSync(file).mtimeMs;
      const syncContent = fs.readFileSync(file, 'utf8');
      assert.ok(syncContent.includes('Initial Visit'));
      const flushesAtSync = flushes.started.length;

      mgr.recordVisit('https://example.com/after-sync', 'After Sync Visit');
      mock.timers.tick(quietMs - 1);
      await flushes.settled();
      assert.strictEqual(flushes.started.length, flushesAtSync, 'mutation after persistSync must debounce rather than flush immediately');
      assert.strictEqual(fs.statSync(file).mtimeMs, syncMtime, 'file mtime must not update before the quiet period elapses');
      assert.strictEqual(fs.readFileSync(file, 'utf8'), syncContent, 'file content must not be updated before quiet period elapses');

      mock.timers.tick(1);
      await flushes.settled();
      assert.strictEqual(flushes.started.length, flushesAtSync + 1, 'the quiet period lands exactly one flush');
      assert.ok(fs.readFileSync(file, 'utf8').includes('After Sync Visit'), 'file must include the debounced mutation');
    } finally {
      await releaseVirtualClock(mgr, flushes);
    }
  });
});
