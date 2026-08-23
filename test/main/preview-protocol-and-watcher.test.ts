import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildPreviewUrl, parsePreviewUrl } from '../../src/main/server/preview-url-codec';
import { safeResolveAndOpenFile, MIME_MAP } from '../../src/main/server/safe-fs-resolver';
import { PreviewWatcherPool, PreviewChangeEvent } from '../../src/main/server/preview-watcher-pool';

describe('Preview Protocol & Watcher Suite', () => {
  const tmpDir = path.join(os.tmpdir(), `antifan-test-preview-${Date.now()}`);

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Hello World</body></html>', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body { background: #000; }', 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=forbidden', 'utf8');
    const subDir = path.join(tmpDir, 'assets');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'app.js'), 'console.log("ready");', 'utf8');
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('preview-url-codec', () => {
    it('builds canonical antifan-preview:// URLs correctly', () => {
      const url = buildPreviewUrl('cap-123', 'index.html');
      assert.strictEqual(url, 'antifan-preview://cap-123/index.html');

      const nestedUrl = buildPreviewUrl('CAP-ABC', 'assets/app.js');
      assert.strictEqual(nestedUrl, 'antifan-preview://cap-abc/assets/app.js');

      const windowsSepUrl = buildPreviewUrl('cap-123', 'assets\\app.js');
      assert.strictEqual(windowsSepUrl, 'antifan-preview://cap-123/assets/app.js');
    });

    it('rejects absolute paths, drive letters, and parent traversals in buildPreviewUrl', () => {
      assert.throws(() => buildPreviewUrl('cap-123', '/absolute/path.html'));
      assert.throws(() => buildPreviewUrl('cap-123', 'C:\\Windows\\win.ini'));
      assert.throws(() => buildPreviewUrl('cap-123', '../escape.html'));
      assert.throws(() => buildPreviewUrl('cap-123', 'sub/../../escape.html'));
      assert.throws(() => buildPreviewUrl('', 'index.html'));
    });

    it('parses valid antifan-preview:// URLs into capsuleId and relativePath', () => {
      const parsed = parsePreviewUrl('antifan-preview://cap-xyz/docs/readme.md');
      assert.strictEqual(parsed.capsuleId, 'cap-xyz');
      assert.strictEqual(parsed.relativePath, '/docs/readme.md');
    });

    it('rejects encoded traversal separators and null bytes in parsePreviewUrl', () => {
      assert.throws(() => parsePreviewUrl('antifan-preview://cap-xyz/sub%2fsecret.txt'));
      assert.throws(() => parsePreviewUrl('antifan-preview://cap-xyz/sub%5csecret.txt'));
      assert.throws(() => parsePreviewUrl('antifan-preview://cap-xyz/null%00byte.txt'));
    });
  });

  describe('safe-fs-resolver', () => {
    it('safely resolves files inside workspace root with correct MIME type', async () => {
      const canonicalRoot = fs.realpathSync.native(tmpDir);
      const res = await safeResolveAndOpenFile(canonicalRoot, 'index.html');
      assert.strictEqual(res.ok, true);
      if (res.ok) {
        assert.strictEqual(res.mimeType, 'text/html; charset=utf-8');
        assert.ok(res.size > 0);
        assert.strictEqual(res.canonicalPath, fs.realpathSync.native(path.join(tmpDir, 'index.html')));
        res.stream.destroy();
      }

      const cssRes = await safeResolveAndOpenFile(canonicalRoot, 'style.css');
      assert.strictEqual(cssRes.ok, true);
      if (cssRes.ok) {
        assert.strictEqual(cssRes.mimeType, 'text/css; charset=utf-8');
        cssRes.stream.destroy();
      }
    });
    it('blocks access to protected files like .env', async () => {
      const canonicalRoot = fs.realpathSync.native(tmpDir);
      const res = await safeResolveAndOpenFile(canonicalRoot, '.env');
      assert.strictEqual(res.ok, false);
      if (!res.ok) {
        assert.strictEqual(res.status, 404);
      }
    });

    it('returns 404 for non-existent files', async () => {
      const canonicalRoot = fs.realpathSync.native(tmpDir);
      const res = await safeResolveAndOpenFile(canonicalRoot, 'missing-file.html');
      assert.strictEqual(res.ok, false);
      if (!res.ok) {
        assert.strictEqual(res.status, 404);
      }
    });
  });

  describe('preview-watcher-pool', () => {
    it('manages watcher retention, refCount, and cleanup callbacks', () => {
      const pool = new PreviewWatcherPool();
      let eventsReceived: PreviewChangeEvent[] = [];
      const callback1 = (event: PreviewChangeEvent) => {
        eventsReceived.push(event);
      };

      const unsub1 = pool.retain('cap-test', tmpDir, callback1);
      assert.strictEqual(pool.getActiveWatcherCount(), 1);
      assert.strictEqual(pool.getRefCount('cap-test'), 1);

      // Retain second consumer on same capsule
      const callback2 = () => {};
      const unsub2 = pool.retain('cap-test', tmpDir, callback2);
      assert.strictEqual(pool.getActiveWatcherCount(), 1);
      assert.strictEqual(pool.getRefCount('cap-test'), 2);

      // Release first consumer
      unsub1();
      assert.strictEqual(pool.getActiveWatcherCount(), 1);
      assert.strictEqual(pool.getRefCount('cap-test'), 1);

      // Release second consumer -> watcher teardown
      unsub2();
      assert.strictEqual(pool.getActiveWatcherCount(), 0);
      assert.strictEqual(pool.getRefCount('cap-test'), 0);
    });
  });

  describe('NativeTabHost preview lifecycle & IPC integration', () => {
    const root = fs.existsSync(path.join(process.cwd(), 'src')) ? process.cwd() : path.resolve(__dirname, '..', '..');
    const nativeHostPath = path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts');
    const nativeSource = fs.existsSync(nativeHostPath) ? fs.readFileSync(nativeHostPath, 'utf8') : '';
    it('verifies antifan:preview:open IPC registration and handler signature', () => {
      assert.ok(nativeSource.includes("ipcMain.removeHandler('antifan:preview:open');"));
      assert.ok(nativeSource.includes("ipcMain.handle('antifan:preview:open'"));
      assert.ok(nativeSource.includes('this.createPreviewTab(filePath, capsuleId)'));
    });

    it('verifies createPreviewTab guards against out-of-root and malformed paths', () => {
      assert.ok(nativeSource.includes('public createPreviewTab(rawPathOrUri: string, targetCapsuleId?: string): string | null'));
      assert.ok(nativeSource.includes('buildPreviewUrl(matchedCapsule.id, relativePath)'));
      assert.ok(nativeSource.includes('catch (err)'));

      // Direct functional test: out-of-root relative path throws on buildPreviewUrl
      assert.throws(() => buildPreviewUrl('cap-abc', '../secret.txt'));
      assert.throws(() => buildPreviewUrl('cap-abc', 'C:\\Windows\\win.ini'));
      assert.throws(() => buildPreviewUrl('', 'index.html'));
    });

    it('verifies preview watcher retention on tab create and restore, and teardown on tab close', () => {
      // Audit source invariant
      assert.ok(nativeSource.includes('private tabPreviewUnsubscribers: Map<string, () => void> = new Map();'));
      assert.ok(nativeSource.includes('this.previewWatcherPool.retain(capsule.id, capsule.workspacePath'));
      assert.ok(nativeSource.includes('const unsub = this.tabPreviewUnsubscribers.get(tabId);'));

      // Functional multi-tab lifecycle simulation
      const pool = new PreviewWatcherPool();
      const tabUnsubscribers = new Map<string, () => void>();

      // 1. Tab 1 opens preview for cap-1
      const tab1Id = 'tab-preview-1';
      const unsub1 = pool.retain('cap-1', tmpDir, () => {});
      tabUnsubscribers.set(tab1Id, unsub1);
      assert.strictEqual(pool.getActiveWatcherCount(), 1);
      assert.strictEqual(pool.getRefCount('cap-1'), 1);

      // 2. Tab 2 restored for cap-1 (same capsule)
      const tab2Id = 'tab-preview-2';
      const unsub2 = pool.retain('cap-1', tmpDir, () => {});
      tabUnsubscribers.set(tab2Id, unsub2);
      assert.strictEqual(pool.getActiveWatcherCount(), 1);
      assert.strictEqual(pool.getRefCount('cap-1'), 2);

      // 3. Tab 1 closed -> unsubs and cleans map
      const u1 = tabUnsubscribers.get(tab1Id);
      if (u1) {
        u1();
        tabUnsubscribers.delete(tab1Id);
      }
      assert.strictEqual(pool.getActiveWatcherCount(), 1);
      assert.strictEqual(pool.getRefCount('cap-1'), 1);
      assert.strictEqual(tabUnsubscribers.has(tab1Id), false);

      // 4. Tab 2 closed -> unsubs and destroys watcher
      const u2 = tabUnsubscribers.get(tab2Id);
      if (u2) {
        u2();
        tabUnsubscribers.delete(tab2Id);
      }
      assert.strictEqual(pool.getActiveWatcherCount(), 0);
      assert.strictEqual(pool.getRefCount('cap-1'), 0);
      assert.strictEqual(tabUnsubscribers.size, 0);
    });
  });
});
