import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { singleInstanceLockExitCode } from '../../src/main/browser/single-instance-lock';

describe('single-instance lock contention exit code', () => {
  it('continues normal second-instance handoff with a successful exit', () => {
    assert.equal(singleInstanceLockExitCode(false, false), 0);
  });

  it('fails an explicitly marked test lane on lock contention', () => {
    assert.equal(singleInstanceLockExitCode(false, true), 1);
  });

  it('does not request process exit after acquiring the lock', () => {
    assert.equal(singleInstanceLockExitCode(true, true), null);
  });
});
