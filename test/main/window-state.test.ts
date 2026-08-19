import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WindowStateManager } from '../../src/main/browser/window-state';

describe('AntiFan Window State Manager', () => {
  it('loads default bounds when state file does not exist', () => {
    const tmpDir = path.join(os.tmpdir(), `antifan-test-${Date.now()}`);
    const mgr = new WindowStateManager(tmpDir, 1400, 900);
    const state = mgr.getState();
    assert.strictEqual(state.width, 1400);
    assert.strictEqual(state.height, 900);
    assert.strictEqual(state.isMaximized, false);
  });

  it('loads saved state with multi-monitor coordinates and maximize flag', () => {
    const tmpDir = path.join(os.tmpdir(), `antifan-test-saved-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const savedData = {
      x: 1920,
      y: 100,
      width: 1600,
      height: 1000,
      isMaximized: true,
    };
    fs.writeFileSync(path.join(tmpDir, 'window-state.json'), JSON.stringify(savedData));

    const mgr = new WindowStateManager(tmpDir);
    const state = mgr.getState();
    assert.strictEqual(state.x, 1920);
    assert.strictEqual(state.y, 100);
    assert.strictEqual(state.width, 1600);
    assert.strictEqual(state.height, 1000);
    assert.strictEqual(state.isMaximized, true);
  });
});
