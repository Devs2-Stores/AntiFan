import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(repoRoot, 'src/main/tools/browser-control-port.ts'), 'utf8');
const match = source.match(/const CAPTURE_TIMEOUT_PROBE_EXPRESSION = `([\s\S]*?)`;/);

function runProbe(media, animations = [], svgs = []) {
  assert.ok(match, 'CAPTURE_TIMEOUT_PROBE_EXPRESSION must exist in browser-control-port.ts');
  const document = {
    querySelectorAll(sel) {
      if (sel === 'video, audio') return media;
      if (sel === 'svg') return svgs;
      return [];
    },
    getAnimations: () => animations,
  };
  return vm.runInNewContext(match[1], { document, Array });
}

describe('CAPTURE_TIMEOUT_PROBE_EXPRESSION', () => {
  it('does not count a paused buffered video as playing', () => {
    const result = runProbe([{ paused: true, readyState: 4, tagName: 'VIDEO' }]);
    assert.equal(result.playing, 0);
    assert.equal(Object.keys(result.tags).length, 0);
  });

  it('counts an unpaused video as playing even before HAVE_FUTURE_DATA', () => {
    const result = runProbe([{ paused: false, readyState: 2, tagName: 'VIDEO' }]);
    assert.equal(result.playing, 1);
    assert.equal(result.tags.video, 1);
  });
});
