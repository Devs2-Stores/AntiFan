import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(repoRoot, 'src/main/tools/browser-control-port.ts'), 'utf8');
const match = source.match(/const CAPTURE_TIMEOUT_PROBE_EXPRESSION = `([\s\S]*?)`;/);

async function runProbe(media, animations = [], svgs = [], raf = 'none') {
  assert.ok(match, 'CAPTURE_TIMEOUT_PROBE_EXPRESSION must exist in browser-control-port.ts');
  const document = {
    querySelectorAll(sel) {
      if (sel === 'video, audio') return media;
      if (sel === 'svg') return svgs;
      return [];
    },
    getAnimations: () => animations,
  };
  const sandbox = {
    document,
    Array,
    // The probe resolves its census through the page's own timer: fire it
    // immediately so the VM test observes the settled payload without waiting.
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
  };
  if (raf === 'fired') sandbox.requestAnimationFrame = (fn) => { fn(); return 0; };
  const result = vm.runInNewContext(match[1], sandbox);
  assert.ok(result && typeof result.then === 'function', 'the probe must return a promise the eval wrapper can await');
  return await result;
}

describe('CAPTURE_TIMEOUT_PROBE_EXPRESSION', () => {
  it('does not count a paused buffered video as playing', async () => {
    const result = await runProbe([{ paused: true, readyState: 4, tagName: 'VIDEO' }]);
    assert.equal(result.playing, 0);
    assert.equal(Object.keys(result.tags).length, 0);
  });

  it('counts an unpaused video as playing even before HAVE_FUTURE_DATA', async () => {
    const result = await runProbe([{ paused: false, readyState: 2, tagName: 'VIDEO' }]);
    assert.equal(result.playing, 1);
    assert.equal(result.tags.video, 1);
  });

  it('reports no frame when requestAnimationFrame never fires, and a frame when it does', async () => {
    const starved = await runProbe([{ paused: false, readyState: 2, tagName: 'VIDEO' }], [], [], 'none');
    assert.equal(starved.rafFired, false, 'a window presenter issuing no BeginFrames must be distinguishable from a settled page');
    const alive = await runProbe([{ paused: false, readyState: 2, tagName: 'VIDEO' }], [], [], 'fired');
    assert.equal(alive.rafFired, true);
  });
});
