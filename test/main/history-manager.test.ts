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
});
