/**
 * Commit pressure watch: the alarm must come before Windows runs out of commit, measured against the
 * limit the pagefiles can still grow to, and must not flap while the charge hovers at the line.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  COMMIT_ALARM_HEADROOM_BYTES,
  COMMIT_CLEAR_HEADROOM_BYTES,
  INITIAL_COMMIT_PRESSURE,
  maxCommitBytes,
  parsePagingFiles,
  stepCommitPressure,
  type CommitPressureState,
} from '../../src/main/diagnostics/commit-pressure';

const GIB = 1024 ** 3;
const REG_HEADER = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\r\n';

describe('parsePagingFiles', () => {
  it('reads system-managed and fixed-size entries from reg query output', () => {
    const out = `${REG_HEADER}    PagingFiles    REG_MULTI_SZ    C:\\pagefile.sys 0 0\\0E:\\pagefile.sys 8192 24576\r\n\r\n`;
    assert.deepEqual(parsePagingFiles(out), [
      { drive: 'C', maxBytes: 'system' },
      { drive: 'E', maxBytes: 24576 * 1024 * 1024 },
    ]);
  });

  it('treats an entry without sizes and the automatic ?: placement as system-managed', () => {
    const out = `${REG_HEADER}    PagingFiles    REG_MULTI_SZ    ?:\\pagefile.sys\r\n`;
    assert.deepEqual(parsePagingFiles(out), [{ drive: '?', maxBytes: 'system' }]);
  });

  it('answers nothing for a machine without a pagefile', () => {
    assert.deepEqual(parsePagingFiles(`${REG_HEADER}    PagingFiles    REG_MULTI_SZ    \r\n`), []);
  });
});

describe('maxCommitBytes', () => {
  it('caps a system-managed pagefile at one eighth of its volume', () => {
    // 16 GB RAM, 259 GB C: -> 3 x RAM is 48 GB, the volume cap 32.4 GB wins.
    const ram = 16 * GIB;
    const max = maxCommitBytes(ram, [{ drive: 'C', maxBytes: 'system' }], () => 259 * GIB);
    assert.equal(max, ram + (259 * GIB) / 8);
  });

  it('adds fixed maxima as configured', () => {
    const max = maxCommitBytes(16 * GIB, [{ drive: 'E', maxBytes: 24 * GIB }], () => { throw new Error('not consulted'); });
    assert.equal(max, 40 * GIB);
  });
});

describe('stepCommitPressure', () => {
  const run = (headrooms: number[]) => {
    let state: CommitPressureState = INITIAL_COMMIT_PRESSURE;
    return headrooms.map((h) => {
      const step = stepCommitPressure(state, h);
      state = step.state;
      return step.transition;
    });
  };
  const low = COMMIT_ALARM_HEADROOM_BYTES - 1;
  const between = (COMMIT_ALARM_HEADROOM_BYTES + COMMIT_CLEAR_HEADROOM_BYTES) / 2;

  it('alarms once after two consecutive low samples, not on a single spike', () => {
    assert.deepEqual(run([low, between, low, low, low]), [null, null, null, 'alarm', null]);
  });

  it('stays alarmed between the two lines and clears only at the clear line', () => {
    assert.deepEqual(run([low, low, between, COMMIT_CLEAR_HEADROOM_BYTES - 1, COMMIT_CLEAR_HEADROOM_BYTES]),
      [null, 'alarm', null, null, 'clear']);
  });

  it('alarms again after a clear when pressure returns', () => {
    assert.deepEqual(run([low, low, COMMIT_CLEAR_HEADROOM_BYTES, low, low]), [null, 'alarm', 'clear', null, 'alarm']);
  });

  it('does not count a sample exactly at the alarm line as low', () => {
    assert.deepEqual(run([COMMIT_ALARM_HEADROOM_BYTES, COMMIT_ALARM_HEADROOM_BYTES]), [null, null]);
  });
});
