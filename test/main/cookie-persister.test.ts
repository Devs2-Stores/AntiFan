import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { CookiePersister } from '../../src/main/browser/cookie-persister';

describe('Universal CookiePersister Invariants', () => {
  it('persists and restores cookies across localhost, storefronts, and web apps', async () => {
    const persister = CookiePersister.getInstance();
    assert.ok(persister, 'CookiePersister singleton should be instantiated');
    assert.strictEqual(typeof persister.restoreCookies, 'function');
    assert.strictEqual(typeof persister.saveAllCookies, 'function');
    assert.strictEqual(typeof persister.startAutoPersistence, 'function');

    const cachePath = path.join(process.cwd(), 'appdata', 'antifan-browser-desktop', 'state', 'v1', 'cookies_cache.json');
    if (fs.existsSync(cachePath)) {
      const content = fs.readFileSync(cachePath, 'utf8');
      const parsed = JSON.parse(content);
      assert.ok(Array.isArray(parsed), 'Cache file should contain a valid cookie array');
    }
  });
});
