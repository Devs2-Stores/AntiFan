import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FullPageCaptureFileError, fullPageCaptureSlug, writeFullPageCapture } from '../../src/main/browser/full-page-capture-file';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

describe('writeFullPageCapture', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-full-page-capture-'));
  after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it('writes the decoded PNG under a stamped, URL-derived name in a created directory', () => {
    const dir = path.join(tempDir, 'nested', 'snapshots');
    const written = writeFullPageCapture({
      base64Png: PNG_BYTES.toString('base64'),
      dir,
      pageUrl: 'https://partners.haravan.com/themes/detail/1808?tab=1',
      now: new Date(2026, 9, 12, 9, 5, 7),
    });
    assert.strictEqual(written.fileName, 'fullpage_20261012-090507_partners.haravan.com-themes-detail-1808.png');
    assert.strictEqual(written.filePath, path.join(dir, written.fileName));
    assert.strictEqual(written.size, PNG_BYTES.length);
    assert.deepStrictEqual(fs.readFileSync(written.filePath), PNG_BYTES);
  });

  it('never overwrites an existing capture: a same-second collision takes the next suffix', () => {
    const input = { base64Png: PNG_BYTES.toString('base64'), dir: tempDir, pageUrl: 'https://a.test/', now: new Date(2026, 0, 1, 0, 0, 0) };
    const first = writeFullPageCapture(input);
    const second = writeFullPageCapture(input);
    const third = writeFullPageCapture(input);
    assert.strictEqual(first.fileName, 'fullpage_20260101-000000_a.test.png');
    assert.strictEqual(second.fileName, 'fullpage_20260101-000000_a.test-2.png');
    assert.strictEqual(third.fileName, 'fullpage_20260101-000000_a.test-3.png');
    assert.deepStrictEqual(fs.readFileSync(first.filePath), PNG_BYTES);
  });

  it('refuses bytes that are not a PNG and writes nothing', () => {
    const dir = path.join(tempDir, 'refused');
    assert.throws(
      () => writeFullPageCapture({ base64Png: Buffer.from('<html></html>').toString('base64'), dir }),
      (err: unknown) => err instanceof FullPageCaptureFileError && err.code === 'CAPTURE_NOT_PNG',
    );
    assert.strictEqual(fs.existsSync(dir), false);
  });
});

describe('fullPageCaptureSlug', () => {
  it('folds Vietnamese percent-encoded paths to ASCII and drops the query', () => {
    assert.strictEqual(
      fullPageCaptureSlug('https://s2-spa.myharavan.com/collections/s%E1%BA%A3n-ph%E1%BA%A9m-%C4%91%C3%B4ng-y?page=2'),
      's2-spa.myharavan.com-collections-san-pham-dong-y',
    );
  });

  it('falls back to "page" for missing or non-URL input', () => {
    assert.strictEqual(fullPageCaptureSlug(undefined), 'page');
    assert.strictEqual(fullPageCaptureSlug('about:blank'), 'blank');
    assert.strictEqual(fullPageCaptureSlug('///'), 'page');
  });
});
