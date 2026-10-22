/**
 * The terminal host owns every interactive PTY and defaults to ConPTY (winpty adds hundreds of
 * milliseconds of keypress→echo latency to full-repaint agent TUIs), while an explicit
 * ANTIFAN_USE_CONPTY from the GUI's environment, including '0' to force winpty, still wins.
 */
import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { daemonEnv } from '../../src/main/terminal-daemon/daemon-spawner';

const original = process.env.ANTIFAN_USE_CONPTY;

describe('daemon spawner: ConPTY default for the terminal host', () => {
  afterEach(() => {
    if (original === undefined) delete process.env.ANTIFAN_USE_CONPTY;
    else process.env.ANTIFAN_USE_CONPTY = original;
  });

  it('opts the host into ConPTY when the GUI environment does not choose', () => {
    delete process.env.ANTIFAN_USE_CONPTY;
    const env = daemonEnv('tok', 'v1', { ANTIFAN_DATA_ROOT: 'X:\\data' });
    assert.equal(env.ANTIFAN_USE_CONPTY, '1');
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(env.ANTIFAN_TERMINAL_HOST_TOKEN, 'tok');
    assert.equal(env.ANTIFAN_TERMINAL_HOST_VERSION, 'v1');
    assert.equal(env.ANTIFAN_DATA_ROOT, 'X:\\data');
  });

  it('keeps an explicit winpty override from the GUI environment', () => {
    process.env.ANTIFAN_USE_CONPTY = '0';
    assert.equal(daemonEnv('tok', 'v1', {}).ANTIFAN_USE_CONPTY, '0');
  });
});
