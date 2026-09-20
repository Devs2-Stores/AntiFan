import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HistoryManager } from '../../src/main/browser/history-manager';

describe('HistoryManager (Intelligent Browsing History & Frecency Search)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-history-test-'));
  const prevConfigDir = process.env.ANTIFAN_CONFIG_DIR;

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
    const timings = HistoryManager as unknown as { PERSIST_QUIET_MS: number; PERSIST_CEILING_MS: number };
    const original = { quiet: timings.PERSIST_QUIET_MS, ceiling: timings.PERSIST_CEILING_MS };
    mgr.persistSync(); // cancel any timer an earlier case armed
    // Production is 3 s quiet / 30 s ceiling. The test drives the same rule on millisecond
    // timings: the assertion is about the coalescing contract, not about the clock.
    timings.PERSIST_QUIET_MS = 800;
    timings.PERSIST_CEILING_MS = 4000;
    try {
      mgr.clearHistory();
      const file = path.join(tempDir, 'browser-history.json');
      let mtime = fs.statSync(file).mtimeMs;
      const writes: number[] = [];
      const poll = setInterval(() => {
        const current = fs.statSync(file).mtimeMs;
        if (current !== mtime) {
          mtime = current;
          writes.push(Date.now());
        }
      }, 20);
      try {
        const startedAt = Date.now();
        for (let i = 0; i < 30; i++) {
          mgr.recordVisit(`https://example.com/churn-${i}`, `Churn ${i}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const elapsedMs = Date.now() - startedAt;
        // 3 s of churn at 10 Hz, against a 4 s ceiling: the quiet period is re-armed by every
        // mutation and never elapses, so the number of writes is bounded by the ceiling — one —
        // and not by the mutation rate, which is what the old 1 s timer per change produced
        // (~3 writes here, one per second, each a full-store synchronous rewrite).
        const ceilingBound = Math.max(1, Math.ceil(elapsedMs / timings.PERSIST_CEILING_MS));
        assert.ok(
          writes.length <= ceilingBound,
          `${writes.length} writes over ${elapsedMs} ms exceeds the ceiling's bound of ${ceilingBound}`,
        );
        const beforeQuiescence = writes.length;
        const deadline = Date.now() + 3000;
        while (writes.length === beforeQuiescence && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.strictEqual(writes.length, beforeQuiescence + 1, 'quiescence lands exactly one flush');
        const items = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(items.length, 30, 'a flush writes the whole store, not one batch of it');
        const flushedAt = fs.statSync(file).mtimeMs;
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.strictEqual(fs.statSync(file).mtimeMs, flushedAt, 'an idle store is not rewritten');
      } finally {
        clearInterval(poll);
      }
    } finally {
      timings.PERSIST_QUIET_MS = original.quiet;
      timings.PERSIST_CEILING_MS = original.ceiling;
      mgr.persistSync();
    }
  });
});
